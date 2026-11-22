import { describe, expect, it } from 'vitest';
import {
  calculatePhysicalAddress,
  CPU,
  DEFAULT_EMU8086_CONFIG,
  Memory,
  MEMORY_SIZE,
  MODEL_SMALL_EMU8086_CONFIG,
  parseAddressInput,
  RegisterFile,
} from '../src/core';

describe('Step 1 — Core Intel 8086 Memory Model', () => {
  it('allocates exactly 1MB (0x100000 bytes) flat memory', () => {
    const mem = new Memory();
    expect(mem.size).toBe(0x100000);
    expect(mem.raw).toBeInstanceOf(Uint8Array);
    expect(mem.raw.length).toBe(MEMORY_SIZE);
  });

  it('computes 20-bit physical addresses matching KBU course slides', () => {
    // Slide examples: 2500:95F3 -> 2E5F3H, 24F6:634A -> 2B2AAH, 1512:3518 -> 18638H
    expect(calculatePhysicalAddress(0x2500, 0x95f3)).toBe(0x2e5f3);
    expect(calculatePhysicalAddress(0x24f6, 0x634a)).toBe(0x2b2aa);
    expect(calculatePhysicalAddress(0x1512, 0x3518)).toBe(0x18638);
    // 0700:0000 -> 07000H, 0700:0100 -> 07100H
    expect(calculatePhysicalAddress(0x0700, 0x0000)).toBe(0x07000);
    expect(calculatePhysicalAddress(0x0700, 0x0100)).toBe(0x07100);
    // 20-bit wraparound at 1MB boundary: FFFF:0010 -> 0x00000
    expect(calculatePhysicalAddress(0xffff, 0x0010)).toBe(0x00000);
  });

  it('reads and writes 16-bit words in Intel Little-Endian order', () => {
    const mem = new Memory();
    // Course slide Figure 1-15: word 1234H at 3000H -> 3000H=34H (low), 3001H=12H (high)
    mem.writeWord(0x03000, 0x1234);
    expect(mem.readByte(0x03000)).toBe(0x34);
    expect(mem.readByte(0x03001)).toBe(0x12);
    expect(mem.readWord(0x03000)).toBe(0x1234);

    // Course slide p.30: DS=1120H, SI=2498H, AX=17FEH -> 13698H=FEH, 13699H=17H
    mem.writeWordSegOff(0x1120, 0x2498, 0x17fe);
    expect(mem.readByte(0x13698)).toBe(0xfe);
    expect(mem.readByte(0x13699)).toBe(0x17);
    expect(mem.readWordSegOff(0x1120, 0x2498)).toBe(0x17fe);
  });

  it('parses logical (SEG:OFF) and physical hex address inputs', () => {
    expect(parseAddressInput('0700:0000')).toEqual({
      physicalAddress: 0x07000,
      logical: { segment: 0x0700, offset: 0x0000 },
    });
    expect(parseAddressInput('1512:3518')).toEqual({
      physicalAddress: 0x18638,
      logical: { segment: 0x1512, offset: 0x3518 },
    });
    expect(parseAddressInput('2E5F3H')).toEqual({
      physicalAddress: 0x2e5f3,
    });
    expect(parseAddressInput('INVALID')).toBeNull();
  });
});

describe('Step 1 — Core Intel 8086 Registers & Flags', () => {
  it('supports independent 8-bit High/Low writes on AX, BX, CX, DX', () => {
    const regs = new RegisterFile();

    regs.AX = 0x1010;
    expect(regs.AH).toBe(0x10);
    expect(regs.AL).toBe(0x10);

    // Modify AL only -> AH remains 0x10
    regs.AL = 0xf5;
    expect(regs.AH).toBe(0x10);
    expect(regs.AL).toBe(0xf5);
    expect(regs.AX).toBe(0x10f5);

    // Modify BH only -> BL remains intact (matches slide: BX=2020H, MOV BH,38H -> BX=3820H)
    regs.BX = 0x2020;
    regs.BH = 0x38;
    expect(regs.BH).toBe(0x38);
    expect(regs.BL).toBe(0x20);
    expect(regs.BX).toBe(0x3820);

    // Dynamic get/set accessors
    regs.set('CH', 0x22);
    regs.set('CL', 0x10);
    expect(regs.get('CX')).toBe(0x2210);
    expect(regs.getBitWidth('CH')).toBe(8);
    expect(regs.getBitWidth('CX')).toBe(16);

    // Masking overflow bits cleanly
    regs.DL = 0x1ab;
    expect(regs.DL).toBe(0xab);
    expect(regs.DH).toBe(0x00);
  });

  it('initializes segment and pointer registers to emu8086 defaults', () => {
    const regs = new RegisterFile();
    expect(regs.CS).toBe(DEFAULT_EMU8086_CONFIG.CS);
    expect(regs.DS).toBe(DEFAULT_EMU8086_CONFIG.DS);
    expect(regs.SS).toBe(DEFAULT_EMU8086_CONFIG.SS);
    expect(regs.ES).toBe(DEFAULT_EMU8086_CONFIG.ES);
    expect(regs.IP).toBe(DEFAULT_EMU8086_CONFIG.IP);
    expect(regs.SP).toBe(DEFAULT_EMU8086_CONFIG.SP);

    regs.reset(MODEL_SMALL_EMU8086_CONFIG);
    expect(regs.CS).toBe(0x0710);
    expect(regs.IP).toBe(0x0000);
  });

  it('tracks individual Status/Control flags and packs/unpacks 16-bit FLAGS accurately', () => {
    const regs = new RegisterFile();

    // Default: status flags false, IF true
    expect(regs.flags.CF).toBe(false);
    expect(regs.flags.PF).toBe(false);
    expect(regs.flags.AF).toBe(false);
    expect(regs.flags.ZF).toBe(false);
    expect(regs.flags.SF).toBe(false);
    expect(regs.flags.OF).toBe(false);
    expect(regs.flags.IF).toBe(true);

    regs.setFlag('CF', true); // bit 0 -> 0x0001
    regs.setFlag('PF', true); // bit 2 -> 0x0004
    regs.setFlag('AF', true); // bit 4 -> 0x0010
    regs.setFlag('ZF', true); // bit 6 -> 0x0040
    regs.setFlag('SF', true); // bit 7 -> 0x0080
    regs.setFlag('OF', true); // bit 11 -> 0x0800
    // Plus reserved bit 1 (0x0002) + IF bit 9 (0x0200)
    expect(regs.getFlagsWord()).toBe(0x0ad7);

    const regs2 = new RegisterFile();
    regs2.setFlagsWord(0x0ad7);
    expect(regs2.flags.CF).toBe(true);
    expect(regs2.flags.PF).toBe(true);
    expect(regs2.flags.AF).toBe(true);
    expect(regs2.flags.ZF).toBe(true);
    expect(regs2.flags.SF).toBe(true);
    expect(regs2.flags.OF).toBe(true);
    expect(regs2.flags.IF).toBe(true);
    expect(regs2.flags.DF).toBe(false);
    expect(regs2.flags.TF).toBe(false);
  });
});

describe('Step 1 — Core Intel 8086 CPU Model', () => {
  it('handles 16-bit stack push/pop with cyclic wraparound and Little-Endian storage', () => {
    const cpu = new CPU();
    // Match slide Figure 4-16: SS=1000H, SP=0000H, PUSH 0xA037 -> SP=FFFEH, [1FFFEH]=37H, [1FFFFH]=A0H
    cpu.registers.SS = 0x1000;
    cpu.registers.SP = 0x0000;

    cpu.push16(0xa037);
    expect(cpu.registers.SP).toBe(0xfffe);
    expect(cpu.memory.readByte(0x1fffe)).toBe(0x37);
    expect(cpu.memory.readByte(0x1ffff)).toBe(0xa0);

    const popped = cpu.pop16();
    expect(popped).toBe(0xa037);
    expect(cpu.registers.SP).toBe(0x0000);
  });

  it('selects correct default segment register for base/index registers', () => {
    const cpu = new CPU();
    expect(cpu.getDefaultSegment('BP')).toBe('SS');
    expect(cpu.getDefaultSegment('BX')).toBe('DS');
    expect(cpu.getDefaultSegment('SI')).toBe('DS');
    expect(cpu.getDefaultSegment('DI')).toBe('DS');
    expect(cpu.getDefaultSegment()).toBe('DS');
  });

  it('captures and restores CPU state snapshots cleanly', () => {
    const cpu = new CPU();
    cpu.registers.AX = 0x3030;
    cpu.registers.setFlag('PF', true);
    cpu.cycleCount = 4;

    const snap = cpu.getSnapshot();
    cpu.reset();
    expect(cpu.registers.AX).toBe(0x0000);
    expect(cpu.cycleCount).toBe(0);

    cpu.restoreSnapshot(snap);
    expect(cpu.registers.AX).toBe(0x3030);
    expect(cpu.registers.flags.PF).toBe(true);
    expect(cpu.cycleCount).toBe(4);
  });
});
