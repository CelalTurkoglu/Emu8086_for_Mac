import { describe, expect, it } from 'vitest';
import {
  aluAdd,
  aluDec,
  aluInc,
  aluMul,
  aluSub,
  computeParityFlag,
  createDefaultFlags,
  EmulatorEngine,
  generateTraceDocx,
} from '../src/core';
import { COURSE_EXAMPLES } from '../src/data/examples';

describe('Step 2 — ALU & Strict Intel 8086 Flag Logic (KBU Cross Flag-Register Check)', () => {
  it('computes Parity Flag (PF) strictly on the lowest 8 bits', () => {
    expect(computeParityFlag(0x3030)).toBe(true); // low byte 30H = 00110000 (2 ones -> even)
    expect(computeParityFlag(0x3031)).toBe(false); // low byte 31H = 00110001 (3 ones -> odd)
    expect(computeParityFlag(0x0000)).toBe(true); // 0 ones -> even
    expect(computeParityFlag(0x0067)).toBe(false); // 67H = 01100111 (5 ones -> odd)
    expect(computeParityFlag(0x00de)).toBe(true); // DEH = 11011110 (6 ones -> even)
    // High byte has odd ones (0x01), low byte has even ones (0x00) -> PF must be true!
    expect(computeParityFlag(0x0100)).toBe(true);
  });

  it('matches Slide p.11-12: ADD AX, 2020H (1010H + 2020H = 3030H)', () => {
    const res = aluAdd(0x1010, 0x2020, 16, createDefaultFlags());
    expect(res.result).toBe(0x3030);
    expect(res.flags.OF).toBe(false);
    expect(res.flags.SF).toBe(false);
    expect(res.flags.ZF).toBe(false);
    expect(res.flags.AF).toBe(false);
    expect(res.flags.PF).toBe(true);
    expect(res.flags.CF).toBe(false);
  });

  it('matches Slide p.13-14: ADD AL, 0BH (0F5H + 0BH = 00H, C=1 Z=1 A=1 P=1 S=0 O=0)', () => {
    const res = aluAdd(0xf5, 0x0b, 8, createDefaultFlags());
    expect(res.result).toBe(0x00);
    expect(res.flags.OF).toBe(false);
    expect(res.flags.SF).toBe(false);
    expect(res.flags.ZF).toBe(true);
    expect(res.flags.AF).toBe(true);
    expect(res.flags.PF).toBe(true);
    expect(res.flags.CF).toBe(true);
  });

  it('matches Slide p.15-16: ADD BH, 2FH (38H + 2FH = 67H, A=1 P=0 C=0)', () => {
    const res = aluAdd(0x38, 0x2f, 8, createDefaultFlags());
    expect(res.result).toBe(0x67);
    expect(res.flags.OF).toBe(false);
    expect(res.flags.SF).toBe(false);
    expect(res.flags.ZF).toBe(false);
    expect(res.flags.AF).toBe(true);
    expect(res.flags.PF).toBe(false);
    expect(res.flags.CF).toBe(false);
  });

  it('matches Slide p.34-35: SUB CH, 44H (22H - 44H = DEH, O=0 S=1 Z=0 A=1 P=1 C=1)', () => {
    const res = aluSub(0x22, 0x44, 8, createDefaultFlags());
    expect(res.result).toBe(0xde);
    expect(res.flags.OF).toBe(false);
    expect(res.flags.SF).toBe(true);
    expect(res.flags.ZF).toBe(false);
    expect(res.flags.AF).toBe(true);
    expect(res.flags.PF).toBe(true);
    expect(res.flags.CF).toBe(true);
  });

  it('matches Slide p.38: DEC preserves CF while setting AF and PF properly', () => {
    const initial = { ...createDefaultFlags(), CF: true };
    const res = aluDec(0x10, 8, initial);
    expect(res.result).toBe(0x0f);
    expect(res.flags.CF).toBe(true); // DEC MUST NOT alter CF!
    expect(res.flags.AF).toBe(true); // borrow from bit 4 to bit 3
    expect(res.flags.PF).toBe(true); // 0FH = 00001111 (4 ones)
    expect(res.flags.ZF).toBe(false);
    expect(res.flags.SF).toBe(false);
    expect(res.flags.OF).toBe(false);

    const incRes = aluInc(0x7f, 8, initial);
    expect(incRes.result).toBe(0x80);
    expect(incRes.flags.CF).toBe(true); // INC MUST NOT alter CF!
    expect(incRes.flags.OF).toBe(true); // +127 + 1 signed overflow
    expect(incRes.flags.SF).toBe(true);
    expect(incRes.flags.AF).toBe(true);
  });

  it('matches Slides p.55 & p.63: 8-bit and 16-bit MUL with CF/OF', () => {
    const m8 = aluMul(0xff, 0xff, 8, createDefaultFlags());
    expect(m8.full).toBe(0xfe01);
    expect(m8.flags.CF).toBe(true);
    expect(m8.flags.OF).toBe(true);

    const m8Small = aluMul(0x02, 0x05, 8, createDefaultFlags());
    expect(m8Small.full).toBe(0x000a);
    expect(m8Small.flags.CF).toBe(false);
    expect(m8Small.flags.OF).toBe(false);

    const m16 = aluMul(0x2000, 0x0050, 16, createDefaultFlags());
    expect(m16.high).toBe(0x000a); // DX
    expect(m16.low).toBe(0x0000); // AX
    expect(m16.flags.CF).toBe(true);
    expect(m16.flags.OF).toBe(true);
  });

  it('matches Slide p.36 (Program Control): CMP +127 vs -128 sets OF=1, SF=1, CF=1', () => {
    const cmp = aluSub(0x7f, 0x80, 8, createDefaultFlags());
    expect(cmp.flags.CF).toBe(true);
    expect(cmp.flags.ZF).toBe(false);
    expect(cmp.flags.SF).toBe(true);
    expect(cmp.flags.OF).toBe(true);
    expect(cmp.flags.PF).toBe(true);
    expect(cmp.flags.AF).toBe(false);
  });
});

describe('Step 3 — Parser & End-to-End Execution Engine', () => {
  it('supports .model small, .data, .code, main proc, endp, end main and direct memory [0058H] & [0053H]', () => {
    const code = `
      .model small
      .data
      .code
      main proc
        MOV [0058H], 04H
        MOV [0053H], 06H
        MOV AL, [0058H]
        ADD AL, [0053H]
        MOV BX, 0050H
        MOV DI, 0008H
        ADD AL, [BX+DI]
        RET
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    expect(loaded.errors).toHaveLength(0);

    const runRes = engine.run();
    expect(runRes.error).toBeNull();
    expect(runRes.halted).toBe(true);
    // [0058H]=04H, [0053H]=06H, AL = 04H + 06H + [0058H]=04H => 0EH (14)
    expect(engine.cpu.registers.AL).toBe(0x0e);
    expect(engine.cpu.memory.readByteSegOff(engine.cpu.registers.DS, 0x0058)).toBe(0x04);
    expect(engine.cpu.memory.readByteSegOff(engine.cpu.registers.DS, 0x0053)).toBe(0x06);
  });

  it('executes ORG 100h loop with labels CPE303: / QUIT:, DEC, CMP, JNZ, JZ and Step Back', () => {
    const code = `
      ORG 100h
      MOV CX, 5
      MOV AX, 0
      CPE303:
        ADD AX, CX
        DEC CX
        JNZ CPE303
      CMP AX, 15
      JZ QUIT
      MOV BX, 0FFFFH
      QUIT:
        RET
    `;
    const engine = new EmulatorEngine();
    const loaded = engine.load(code);
    expect(loaded.ok).toBe(true);
    expect(engine.cpu.registers.IP).toBe(0x0100);

    // Single-step first two instructions
    const s1 = engine.step();
    expect(s1.changedRegisters).toContain('CX');
    expect(engine.cpu.registers.CX).toBe(5);

    const s2 = engine.step();
    expect(s2.executed).toBe(true);

    // Test Step Back restores CX to 5 -> 0
    engine.stepBack();
    engine.stepBack();
    expect(engine.cpu.registers.CX).toBe(0);

    // Now run to completion: 5 + 4 + 3 + 2 + 1 = 15 (000FH)
    const final = engine.run();
    expect(final.error).toBeNull();
    expect(final.halted).toBe(true);
    expect(engine.cpu.registers.AX).toBe(15);
    expect(engine.cpu.registers.CX).toBe(0);
    expect(engine.cpu.registers.BX).toBe(0); // skipped MOV BX, 0FFFFH because JZ QUIT taken
    expect(engine.cpu.registers.flags.ZF).toBe(true);
  });

  it('executes KBU Slide p.23/38 memory word MOV [5000H], 1010H and INC/DEC [5000H]', () => {
    const code = `
      .model small
      .data
      .code
      main proc
        mov [5000H], 1010H
        inc [5000H]
        mov ax, [5000H]
        dec [5000H]
        mov bx, [5000H]
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(code).ok).toBe(true);
    const res = engine.run();
    expect(res.error).toBeNull();
    expect(engine.cpu.registers.AX).toBe(0x1011);
    expect(engine.cpu.registers.BX).toBe(0x1010);
  });

  it('executes KBU Slide p.60 SCASB string search and p.78/80 DIV & IDIV', () => {
    const scasCode = `
      .model small
      .data
        DATA1 DB 'ABCDEFGH'
      .code
      main proc
        mov ax, @DATA
        mov ds, ax
        mov es, ax
        mov di, OFFSET DATA1
        mov al, 'F'
        mov cx, 08
        cld
        repne scasb
        jnz quit
        dec di
      quit: ret
      endp
      end main
    `;
    const engine = new EmulatorEngine();
    expect(engine.load(scasCode).ok).toBe(true);
    // Step through until REPNE SCASB completes (8 instructions: mov ax..repne scasb)
    for (let i = 0; i < 8; i++) {
      expect(engine.step().error).toBeNull();
    }
    // Right after REPNE SCASB finds 'F' (6th char): ZF=true, DI=6, CX=2
    expect(engine.cpu.registers.flags.ZF).toBe(true);
    expect(engine.cpu.registers.DI).toBe(6);
    expect(engine.cpu.registers.CX).toBe(2);

    // Finish remaining instructions (jnz quit not taken -> dec di -> ret)
    expect(engine.run().error).toBeNull();
    // 'F' is at index 5 in 'ABCDEFGH'; DEC DI sets DI=5 and updates ZF=false (5 != 0)
    expect(engine.cpu.registers.DI).toBe(5);
    expect(engine.cpu.registers.flags.ZF).toBe(false);
    expect(engine.cpu.memory.readByteSegOff(engine.cpu.registers.ES, 5)).toBe('F'.charCodeAt(0));

    const divCode = `
      .model small
      .code
      main proc
        mov al, -48
        cbw
        mov bl, 05H
        idiv bl
      endp
      end main
    `;
    expect(engine.load(divCode).ok).toBe(true);
    expect(engine.run().error).toBeNull();
    // Slide p.80: AX = FDF7H (AH = -3 = FDH, AL = -9 = F7H)
    expect(engine.cpu.registers.AX).toBe(0xfdf7);
  });

  it('rejects illegal 8086 operations taught in class (e.g. MOV DS, 0123H and DIV by 0)', () => {
    const engine = new EmulatorEngine();
    expect(engine.load('MOV DS, 0123H').ok).toBe(true);
    const res1 = engine.step();
    expect(res1.error?.code).toBe('ILLEGAL_SEG_IMM');

    expect(engine.load('MOV AX, 10\nMOV BL, 0\nDIV BL').ok).toBe(true);
    const res2 = engine.run();
    expect(res2.error?.code).toBe('DIVIDE_BY_ZERO');
  });

  it('compiles and executes all 6 built-in KBU course examples cleanly', () => {
    const engine = new EmulatorEngine();

    for (const ex of COURSE_EXAMPLES) {
      const loaded = engine.load(ex.code);
      expect(loaded.ok, `Example "${ex.id}" failed to compile`).toBe(true);
      const res = engine.run();
      expect(res.error, `Example "${ex.id}" had runtime error`).toBeNull();
      expect(res.halted, `Example "${ex.id}" did not halt`).toBe(true);

      if (ex.id === 'memory-addressing') {
        expect(engine.cpu.registers.AL).toBe(0x16);
        expect(engine.cpu.registers.DX).toBe(0x1234);
        expect(engine.cpu.memory.readByteSegOff(0x0700, 0x005a)).toBe(0x16);
        expect(engine.cpu.memory.readByteSegOff(0x0700, 0x005c)).toBe(0x34);
        expect(engine.cpu.memory.readByteSegOff(0x0700, 0x005d)).toBe(0x12);
      } else if (ex.id === 'cpe303-loop') {
        expect(engine.cpu.registers.AX).toBe(0x000f);
        expect(engine.cpu.registers.CX).toBe(0x0000);
        expect(engine.cpu.memory.readWordSegOff(0x0700, 0x0050)).toBe(0x000f);
      } else if (ex.id === 'flags-check') {
        expect(engine.cpu.registers.CH).toBe(0xde);
        expect(engine.cpu.registers.flags.CF).toBe(true);
        expect(engine.cpu.registers.flags.SF).toBe(true);
        expect(engine.cpu.registers.flags.PF).toBe(true);
      } else if (ex.id === 'mul-div') {
        // -25 / 4 => AL = -6 (FAH), AH = -1 (FFH) => AX = FFFAH
        expect(engine.cpu.registers.AL).toBe(0xfa);
        expect(engine.cpu.registers.AH).toBe(0xff);
      } else if (ex.id === 'data-scasb') {
        expect(engine.consoleOutput).toBe('EMU8086 Mac Hazir!');
        expect(engine.cpu.registers.BL).toBe('D'.charCodeAt(0));
      } else if (ex.id === 'stack-procedure') {
        expect(engine.cpu.registers.AX).toBe(0x6666);
        expect(engine.cpu.registers.DX).toBe(0x2222);
        expect(engine.cpu.registers.CX).toBe(0x1111);
      }
    }
  });

  it('records step-by-step execution trace including loop iterations, stepBack undo, and exports valid .docx', async () => {
    const loopExample = COURSE_EXAMPLES.find((ex) => ex.id === 'cpe303-loop')!;
    const engine = new EmulatorEngine();
    engine.setTraceEnabled(true);
    expect(engine.load(loopExample.code).ok).toBe(true);

    // Step 0 (Initial State) seeded right after load
    expect(engine.traceLog).toHaveLength(1);
    expect(engine.traceLog[0].isInitial).toBe(true);

    // Single step and undo via stepBack must keep traceLog in sync
    engine.step();
    expect(engine.traceLog).toHaveLength(2);
    expect(engine.traceLog[1].instruction).toBe('MOV CX, 0005H');
    engine.stepBack();
    expect(engine.traceLog).toHaveLength(1);

    // Run full loop program: 2 setup + 5*4 loop body + JZ + MOV [0050H], AX + RET = 25 steps + 1 initial = 26 rows
    const runRes = engine.run();
    expect(runRes.error).toBeNull();
    expect(engine.traceLog).toHaveLength(26);

    // Verify all 5 loop iterations of ADD AX, CX were recorded with lineHitCount 1..5
    const addSteps = engine.traceLog.filter((e) => e.instruction === 'ADD AX, CX');
    expect(addSteps).toHaveLength(5);
    expect(addSteps.map((e) => e.lineHitCount)).toEqual([1, 2, 3, 4, 5]);
    expect(addSteps.map((e) => e.registers.AX)).toEqual([5, 9, 12, 14, 15]);

    // Verify memory write recorded on MOV [0050H], AX
    const memWriteStep = engine.traceLog.find((e) => e.instruction === 'MOV [0050H], AX');
    expect(memWriteStep?.memoryWrites).toHaveLength(1);
    expect(memWriteStep?.memoryWrites[0].offset).toBe(0x0050);
    expect(memWriteStep?.memoryWrites[0].value).toBe(0x000f);

    // Generate valid Word (.docx) binary (ZIP magic header 'PK\x03\x04')
    const docxBytes = await generateTraceDocx({
      programName: 'cpe303_loop.asm',
      sourceCode: loopExample.code,
      traceLog: engine.traceLog,
      locale: 'tr',
    });
    expect(docxBytes.byteLength).toBeGreaterThan(2000);
    expect(docxBytes[0]).toBe(0x50); // 'P'
    expect(docxBytes[1]).toBe(0x4b); // 'K'
  });
});
