import { describe, expect, it } from 'vitest';
import {
  assemble,
  EmulatorEngine,
  formatTraceMemoryAndSegments,
  generateTraceDocx,
} from '../src/core';
import { COURSE_EXAMPLES } from '../src/data/examples';
import {
  decodeCodeFromShareHash,
  encodeCodeToShareHash,
} from '../src/platform';
import {
  canDirectSaveAsmPath,
  canOpenSavedDocxPath,
  canRevealSavedPath,
  isAllowedDevServerUrl,
  isAllowedExternalUrl,
  isAllowedNavigationUrl,
  isTrustedIpcSenderUrl,
  normalizeLocalPath,
} from '../electron/security';
import path from 'path';

describe('Phase 1 — Electron & Platform Security Guards', () => {
  it('blocks unauthorized direct file writes in canDirectSaveAsmPath', () => {
    const allowed = new Set<string>([path.resolve('/Users/test/work/prog.asm')]);
    expect(canDirectSaveAsmPath('/Users/test/work/prog.asm', allowed)).toBe(
      path.resolve('/Users/test/work/prog.asm')
    );
    // Arbitrary path not previously opened/saved via dialog MUST be rejected
    expect(canDirectSaveAsmPath('/Users/test/.zshrc', allowed)).toBeNull();
    expect(canDirectSaveAsmPath('/Users/test/work/prog.asm\0.sh', allowed)).toBeNull();
    expect(canDirectSaveAsmPath('', allowed)).toBeNull();
  });

  it('strictly restricts shell.openPath to session-authorized .docx files only', () => {
    const allowedDocx = new Set<string>([
      path.resolve('/Users/test/report.docx'),
      path.resolve('/Users/test/evil.command'),
    ]);
    expect(
      canOpenSavedDocxPath('/Users/test/report.docx', allowedDocx)
    ).toBe(path.resolve('/Users/test/report.docx'));
    // Even if somehow added to set, non-.docx extension must be rejected
    expect(
      canOpenSavedDocxPath('/Users/test/evil.command', allowedDocx)
    ).toBeNull();
    expect(
      canOpenSavedDocxPath('/Users/test/other.docx', allowedDocx)
    ).toBeNull();
  });

  it('validates revealInFinder against authorized ASM and DOCX paths', () => {
    const asmSet = new Set([path.resolve('/tmp/a.asm')]);
    const docxSet = new Set([path.resolve('/tmp/b.docx')]);
    expect(canRevealSavedPath('/tmp/a.asm', asmSet, docxSet)).toBe(
      path.resolve('/tmp/a.asm')
    );
    expect(canRevealSavedPath('/tmp/b.docx', asmSet, docxSet)).toBe(
      path.resolve('/tmp/b.docx')
    );
    expect(canRevealSavedPath('/etc/passwd', asmSet, docxSet)).toBeNull();
  });

  it('rejects ELECTRON_START_URL in packaged builds and non-local URLs in dev', () => {
    expect(isAllowedDevServerUrl('http://localhost:5173', false)).toBe(true);
    expect(isAllowedDevServerUrl('http://127.0.0.1:5173/', false)).toBe(true);
    expect(isAllowedDevServerUrl('http://localhost:5173', true)).toBe(false);
    expect(isAllowedDevServerUrl('https://evil.example.com', false)).toBe(false);
    expect(isAllowedDevServerUrl('file:///etc/passwd', false)).toBe(false);
  });

  it('validates IPC sender frame and blocks arbitrary navigation URLs', () => {
    const distIndex = path.resolve('/Applications/EMU8086.app/dist/index.html');
    const validFileUrl = `file://${distIndex}`;

    expect(isTrustedIpcSenderUrl(validFileUrl, true, distIndex)).toBe(true);
    expect(
      isTrustedIpcSenderUrl('file:///Users/victim/Downloads/evil.html', true, distIndex)
    ).toBe(false);
    expect(
      isAllowedNavigationUrl('file:///Users/victim/Downloads/drop.html', true, distIndex)
    ).toBe(false);
    expect(
      isAllowedNavigationUrl('https://attacker.invalid', false, distIndex)
    ).toBe(false);
  });

  it('enforces external URL allowlist and NUL byte path rejection', () => {
    expect(
      isAllowedExternalUrl('https://github.com/CelalTurkoglu/Emu8086_for_Mac')
    ).toBe(true);
    expect(isAllowedExternalUrl('https://evil.example.com')).toBe(false);
    expect(normalizeLocalPath('/tmp/safe.asm\0.sh')).toBeNull();
  });

  it('encodes and decodes URL share links cleanly with Turkish UTF-8 characters', () => {
    const sample = `; Türkçe Açıklama — ğüşiöçİĞÜŞÖÇ\nORG 100h\nMOV AX, 1234H\nRET`;
    const hash = encodeCodeToShareHash(sample);
    expect(hash.startsWith('#code=')).toBe(true);
    expect(decodeCodeFromShareHash(hash)).toBe(sample);
    expect(decodeCodeFromShareHash('#invalid=123')).toBeNull();
  });
});

describe('Phase 2 — Core 8086 Bug Fixes & Strict emu8086 Compatibility', () => {
  it('executes indirect memory JMP and CALL via DW jump table (JMP TABLE[BX], CALL [SI])', () => {
    const code = `
      .model small
      .data
        TABLE DW SUB_ONE, SUB_TWO
      .code
      main proc
        MOV AX, 0
        MOV BX, 2
        CALL TABLE[BX]
        MOV SI, OFFSET TABLE
        JMP [SI]
      SUB_ONE:
        ADD AX, 10H
        RET
      SUB_TWO:
        ADD AX, 20H
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    const res = engine.run();
    expect(res.error).toBeNull();
    expect(res.halted).toBe(true);
    // CALL TABLE[2] runs SUB_TWO (AX=20H) and returns, then JMP [SI] jumps to SUB_ONE (AX=30H) and top-level RET halts!
    expect(engine.cpu.registers.AX).toBe(0x30);
  });

  it('handles 16-bit carry on INC [5000H] (10FFH -> 1100H) without silent 8-bit corruption', () => {
    const code = `
      .model small
      .code
      main proc
        MOV [5000H], 10FFH
        INC [5000H]
        MOV AX, [5000H]
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    // Should emit AMBIGUOUS_MEMORY_SIZE warning in flexible mode
    expect(
      loaded.warnings.some((w) => w.code === 'AMBIGUOUS_MEMORY_SIZE')
    ).toBe(true);

    const res = engine.run();
    expect(res.error).toBeNull();
    expect(engine.cpu.registers.AX).toBe(0x1100);
    expect(engine.cpu.registers.flags.ZF).toBe(false);

    // In strictMode, ambiguous MOV [5000H], 10FFH and INC [5000H] must be compile-time errors
    const strictLoaded = engine.load(code, { strictMode: true });
    expect(strictLoaded.ok).toBe(false);
    expect(
      strictLoaded.errors.some((e) => e.code === 'AMBIGUOUS_MEMORY_SIZE')
    ).toBe(true);
  });

  it('starts ORG 100h at first instruction even when helper PROC is defined before main label', () => {
    const code = `
      ORG 100h
        JMP START
      HELPER proc
        ADD AX, 100H
        RET
      HELPER endp
      START:
        MOV AX, 5
        CALL HELPER
        RET
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);
    expect(engine.cpu.registers.IP).toBe(0x0100);
    const res = engine.run();
    expect(res.error).toBeNull();
    expect(engine.cpu.registers.AX).toBe(0x0105);
  });

  it('places ORG 100h inline DB/DW data after code and supports multi-line label:\n DB ...', () => {
    const code = `
      ORG 100h
        MOV WORD PTR [0000H], 9999H
        MOV DX, OFFSET MSG
        MOV AH, 09H
        INT 21H
        RET
      MSG:
        DB 'Selam$'
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    expect(loaded.program.symbols['MSG'].offset).toBeGreaterThan(0x0100);

    const res = engine.run();
    expect(res.error).toBeNull();
    // Writing to [0000H] must NOT corrupt MSG!
    expect(engine.consoleOutput).toBe('Selam');
  });

  it('computes accurate 8086 instruction byte lengths and preloads code bytes into CS:IP RAM', () => {
    const code = `
      ORG 100h
      MOV CX, 5
      ADD AX, CX
      DEC CX
      RET
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    // MOV CX, 5 (3B @ 0100) -> ADD AX, CX (2B @ 0103) -> DEC CX (1B @ 0105) -> RET (1B @ 0106)
    expect(loaded.program.instructions.map((i) => i.offset)).toEqual([
      0x0100, 0x0103, 0x0105, 0x0106,
    ]);
    // CS:0100H in RAM should contain non-zero instruction bytes
    expect(engine.cpu.memory.readByteSegOff(0x0700, 0x0100)).not.toBe(0);
  });

  it('treats REP SCASB identically to REPE SCASB (stops when ZF=0)', () => {
    const code = `
      .model small
      .data
        ARR DB 'A', 'A', 'B', 'A'
      .code
      main proc
        MOV AX, @DATA
        MOV DS, AX
        MOV ES, AX
        CLD
        MOV DI, OFFSET ARR
        MOV CX, 4
        MOV AL, 'A'
        REP SCASB
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);
    expect(engine.run().error).toBeNull();
    // Stops at 3rd char ('B'): CX decremented 3 times (4 -> 1), ZF=0
    expect(engine.cpu.registers.CX).toBe(1);
    expect(engine.cpu.registers.flags.ZF).toBe(false);
  });

  it('uses full 8-bit shift count on Intel 8086 (CL=32 shifts out all bits instead of masking to 0)', () => {
    const code = `
      ORG 100h
      MOV AX, 0FFFFH
      MOV CL, 32
      SHL AX, CL
      RET
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);
    expect(engine.run().error).toBeNull();
    expect(engine.cpu.registers.AX).toBe(0x0000);
    expect(engine.cpu.registers.flags.ZF).toBe(true);
  });

  it('rejects illegal IP operand, CMP immediate destination, duplicate labels, and stack corruption on RET', () => {
    const engine = new EmulatorEngine();

    // 1. Direct IP access is always a compile error
    expect(engine.load('MOV IP, 0100H').ok).toBe(false);
    expect(engine.load('MOV IP, 0100H').errors[0].code).toBe(
      'ILLEGAL_IP_OPERAND'
    );

    // 2. Duplicate label
    expect(engine.load('L1:\nNOP\nL1:\nRET').ok).toBe(false);
    expect(engine.load('L1:\nNOP\nL1:\nRET').errors[0].code).toBe(
      'DUPLICATE_SYMBOL'
    );

    // 3. Unknown END entry label
    expect(engine.load('NOP\nEND NO_SUCH_LABEL').ok).toBe(false);
    expect(engine.load('NOP\nEND NO_SUCH_LABEL').errors[0].code).toBe(
      'UNKNOWN_ENTRY_LABEL'
    );

    // 4. CMP 5, AL rejected at runtime (and at compile time in strictMode)
    expect(assemble('CMP 5, AL', { strictMode: true }).errors[0].code).toBe(
      'INVALID_DESTINATION'
    );
    engine.load('CMP 5, AL');
    expect(engine.step().error?.code).toBe('INVALID_DESTINATION');

    // 5. Immediate overflow (MOV AL, 300) rejected in strictMode, warned in flex mode
    const flexOverflow = assemble('MOV AL, 300', { strictMode: false });
    expect(flexOverflow.warnings[0].code).toBe('IMMEDIATE_OVERFLOW');
    const strictOverflow = assemble('MOV AL, 300', { strictMode: true });
    expect(strictOverflow.errors[0].code).toBe('IMMEDIATE_OVERFLOW');

    // 6. Unmatched PUSH inside CALL procedure triggers STACK_CORRUPTED_RETURN on RET
    const badStackCode = `
      ORG 100h
      CALL BAD_SUB
      RET
      BAD_SUB proc
        PUSH 1234H
        RET
      BAD_SUB endp
    `;
    expect(engine.load(badStackCode).ok).toBe(true);
    const badRes = engine.run();
    expect(badRes.error?.code).toBe('STACK_CORRUPTED_RETURN');
  });

  it('preserves semicolon character literal MOV AL, ";" in traceLog without truncating', () => {
    const engine = new EmulatorEngine();
    engine.setTraceEnabled(true);
    expect(engine.load("ORG 100h\nMOV AL, ';' ; comment\nRET").ok).toBe(true);
    engine.run();
    expect(engine.cpu.registers.AL).toBe(';'.charCodeAt(0));
    expect(engine.traceLog[1].instruction).toBe("MOV AL, ';'");
  });
});

describe('Phase 3 — New 8086 Instructions, Classic Segments & Interactive Interrupts', () => {
  it('executes 16-bit string operations MOVSW, STOSW, LODSW, SCASW, CMPSW', () => {
    const code = `
      .model small
      .data
        SRC DW 1111H, 2222H, 3333H
        DST DW 3 DUP(0)
      .code
      main proc
        MOV AX, @DATA
        MOV DS, AX
        MOV ES, AX
        CLD

        ; Copy 3 words from SRC to DST via REP MOVSW
        MOV SI, OFFSET SRC
        MOV DI, OFFSET DST
        MOV CX, 3
        REP MOVSW

        ; Compare SRC and DST via REPE CMPSW -> ZF=1
        MOV SI, OFFSET SRC
        MOV DI, OFFSET DST
        MOV CX, 3
        REPE CMPSW

        ; Scan DST for 2222H via REPNE SCASW
        MOV DI, OFFSET DST
        MOV AX, 2222H
        MOV CX, 3
        REPNE SCASW

        ; Load 3rd word (3333H) via LODSW
        MOV SI, DI
        LODSW
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);
    expect(engine.run().error).toBeNull();
    expect(engine.cpu.registers.AX).toBe(0x3333);
    expect(engine.cpu.registers.flags.ZF).toBe(true);
  });

  it('executes CLI, STI, LAHF, SAHF, XLAT, LDS, LES, PUSHA, POPA', () => {
    const code = `
      .model small
      .data
        LUT DB 10H, 20H, 30H, 40H
        PTR32 DD 08001234H
      .code
      main proc
        MOV AX, @DATA
        MOV DS, AX

        CLI
        STI

        ; XLAT lookup: AL=2 -> LUT[2] = 30H
        MOV BX, OFFSET LUT
        MOV AL, 2
        XLAT

        ; PUSHA / POPA round-trip
        MOV CX, 7777H
        PUSHA
        MOV CX, 0000H
        POPA

        ; LAHF / SAHF
        STC
        LAHF
        CLC
        SAHF

        ; LES loads DI=1234H, ES=0800H
        LES DI, PTR32
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);
    expect(engine.run().error).toBeNull();
    expect(engine.cpu.registers.AL).toBe(0x30);
    expect(engine.cpu.registers.CX).toBe(0x7777);
    expect(engine.cpu.registers.flags.IF).toBe(true);
    expect(engine.cpu.registers.flags.CF).toBe(true);
    expect(engine.cpu.registers.DI).toBe(0x1234);
    expect(engine.cpu.registers.ES).toBe(0x0800);
  });

  it('supports classic MASM DATA SEGMENT / CODE SEGMENT / ASSUME, $ location counter, and arithmetic expressions', () => {
    const code = `
      DATA SEGMENT
        MSG DB 'MERHABA'
        LEN EQU $ - MSG
        BUF DB LEN DUP('0' + 1)
      DATA ENDS

      CODE SEGMENT
        ASSUME CS:CODE, DS:DATA
      START:
        MOV AX, DATA
        MOV DS, AX
        MOV CX, LEN
        MOV AL, BUF + 2
        MOV BX, [BX]+4
        MOV AH, 4CH
        INT 21H
      CODE ENDS
      END START
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    expect(engine.run().error).toBeNull();
    expect(engine.cpu.registers.CX).toBe(7);
    expect(engine.cpu.registers.AL).toBe('1'.charCodeAt(0));
    // Little-Endian 16-bit read at offset 4 ('A' at [4], 'B' at [5]) -> low='A', high='B'
    expect(engine.cpu.registers.BX).toBe(
      (('B'.charCodeAt(0) << 8) | 'A'.charCodeAt(0))
    );
  });

  it('supports interactive keyboard input for INT 21H (AH=01H, 0AH) and INT 10H (AH=0EH)', () => {
    const code = `
      .model small
      .data
        INBUF DB 10, 0, 10 DUP(0)
      .code
      main proc
        MOV AX, @DATA
        MOV DS, AX

        ; 1) INT 21H AH=01H: read single char with echo
        MOV AH, 01H
        INT 21H
        MOV BL, AL

        ; 2) INT 10H AH=0EH: teletype output ':'
        MOV AH, 0EH
        MOV AL, ':'
        INT 10H

        ; 3) INT 21H AH=0AH: buffered string input
        MOV DX, OFFSET INBUF
        MOV AH, 0AH
        INT 21H

        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);

    // Run until first input pause (INT 21H AH=01H)
    const r1 = engine.run();
    expect(r1.waitingForInput?.interrupt).toBe('INT21_01');
    expect(r1.halted).toBe(false);

    // Provide char 'K' and continue until second input pause (INT 21H AH=0AH)
    engine.provideInput('K');
    const r2 = engine.run();
    expect(engine.cpu.registers.BL).toBe('K'.charCodeAt(0));
    expect(engine.consoleOutput).toBe('K:');
    expect(r2.waitingForInput?.interrupt).toBe('INT21_0A');

    // Provide line '8086' and finish
    engine.provideInput('8086');
    const r3 = engine.run();
    expect(r3.error).toBeNull();
    expect(r3.halted).toBe(true);
    expect(engine.consoleOutput).toBe('K:8086\n');
    // INBUF[1] = actual length (4), INBUF[2..5] = '8','0','8','6'
    expect(engine.cpu.memory.readByteSegOff(0x0700, 1)).toBe(4);
    expect(engine.cpu.memory.readByteSegOff(0x0700, 2)).toBe('8'.charCodeAt(0));
  });

  it('formats segment changes and bulk REP memory writes cleanly for Trace & Word export', async () => {
    const code = `
      .model small
      .code
      main proc
        MOV AX, 0700H
        MOV DS, AX
        MOV ES, AX
        MOV DI, 0100H
        MOV CX, 30
        MOV AL, 0AAH
        CLD
        REP STOSB
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    engine.setTraceEnabled(true);
    expect(engine.load(code).ok).toBe(true);
    expect(engine.run().error).toBeNull();

    // Step 2 is MOV DS, AX -> should format DS=0700H
    const dsStep = engine.traceLog.find((e) => e.instruction === 'MOV DS, AX')!;
    expect(
      formatTraceMemoryAndSegments(
        dsStep.memoryWrites,
        dsStep.changedRegisters,
        dsStep.registers
      )
    ).toContain('DS=0700H');

    // REP STOSB step should cap memoryWrites at 16 and include repeatCount on the last entry
    const stosbStep = engine.traceLog.find((e) =>
      e.instruction.includes('REP STOSB')
    )!;
    expect(stosbStep.memoryWrites.length).toBe(16);
    expect(stosbStep.memoryWrites[15].repeatCount).toBe(15);

    const bytes = await generateTraceDocx({
      programName: 'seg_trace.asm',
      sourceCode: engine.program!.sourceCode,
      traceLog: engine.traceLog,
      locale: 'tr',
    });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('compiles all 6 built-in course examples with 0 errors and 0 warnings in Strict emu8086 Mode', () => {
    for (const ex of COURSE_EXAMPLES) {
      const res = assemble(ex.code, { strictMode: true });
      expect(res.errors, `Example ${ex.id} had strict errors`).toHaveLength(0);
      expect(res.warnings, `Example ${ex.id} had strict warnings`).toHaveLength(0);
    }
  });
});
