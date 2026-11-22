/**
 * Core Intel 8086 Architecture Type Definitions
 *
 * Tailored for educational microprocessors coursework (CPE303 / CPE323 / CME321)
 * matching emu8086 behavior and Intel 8086 real-mode specifications.
 */

// ---------------------------------------------------------------------------
// Register Identifiers
// ---------------------------------------------------------------------------

/** 16-bit General Purpose Registers */
export type GeneralPurposeRegister16 = 'AX' | 'BX' | 'CX' | 'DX';

/** 8-bit High/Low Halves of General Purpose Registers */
export type GeneralPurposeRegister8 =
  | 'AH'
  | 'AL'
  | 'BH'
  | 'BL'
  | 'CH'
  | 'CL'
  | 'DH'
  | 'DL';

/** 16-bit Pointer and Index Registers */
export type PointerIndexRegister = 'SP' | 'BP' | 'SI' | 'DI' | 'IP';

/** 16-bit Segment Registers */
export type SegmentRegister = 'CS' | 'DS' | 'SS' | 'ES';

/** All 16-bit Registers */
export type Register16 =
  | GeneralPurposeRegister16
  | PointerIndexRegister
  | SegmentRegister;

/** All 8-bit Registers */
export type Register8 = GeneralPurposeRegister8;

/** Union of all addressable 8086 registers */
export type RegisterName = Register16 | Register8;

/** Supported operand data widths in Intel 8086 */
export type DataSize = 8 | 16;

export const GP_REGISTERS_16: readonly GeneralPurposeRegister16[] = [
  'AX',
  'BX',
  'CX',
  'DX',
] as const;

export const GP_REGISTERS_8: readonly GeneralPurposeRegister8[] = [
  'AH',
  'AL',
  'BH',
  'BL',
  'CH',
  'CL',
  'DH',
  'DL',
] as const;

export const POINTER_INDEX_REGISTERS: readonly PointerIndexRegister[] = [
  'SP',
  'BP',
  'SI',
  'DI',
  'IP',
] as const;

export const SEGMENT_REGISTERS: readonly SegmentRegister[] = [
  'CS',
  'DS',
  'SS',
  'ES',
] as const;

// ---------------------------------------------------------------------------
// Flags Register (16-bit 8086 FLAGS)
// ---------------------------------------------------------------------------

/**
 * Distinct boolean states for the Intel 8086 Status & Control Flags.
 *
 * Bit layout in 16-bit FLAGS register:
 *  Bit 0  : CF (Carry Flag)
 *  Bit 2  : PF (Parity Flag - lowest 8 bits only)
 *  Bit 4  : AF (Auxiliary Carry Flag - bit 3 <-> bit 4)
 *  Bit 6  : ZF (Zero Flag)
 *  Bit 7  : SF (Sign Flag)
 *  Bit 8  : TF (Trap Flag)
 *  Bit 9  : IF (Interrupt Enable Flag)
 *  Bit 10 : DF (Direction Flag)
 *  Bit 11 : OF (Overflow Flag)
 */
export interface IFlags {
  /** Carry Flag (C) — bit 0: unsigned carry/borrow out of MSB */
  CF: boolean;
  /** Parity Flag (P) — bit 2: true if lowest 8 bits contain an even number of 1-bits */
  PF: boolean;
  /** Auxiliary Carry Flag (A) — bit 4: carry/borrow between bit 3 and bit 4 (nibble) */
  AF: boolean;
  /** Zero Flag (Z) — bit 6: true if result is zero */
  ZF: boolean;
  /** Sign Flag (S) — bit 7: copies MSB of result (bit 7 for 8-bit, bit 15 for 16-bit) */
  SF: boolean;
  /** Overflow Flag (O) — bit 11: signed arithmetic overflow */
  OF: boolean;
  /** Trap Flag (T) — bit 8: single-step interrupt mode */
  TF: boolean;
  /** Interrupt Enable Flag (I) — bit 9: enables maskable interrupts */
  IF: boolean;
  /** Direction Flag (D) — bit 10: string auto-increment (false) / auto-decrement (true) */
  DF: boolean;
}

export type StatusFlagName = 'CF' | 'PF' | 'AF' | 'ZF' | 'SF' | 'OF';
export type ControlFlagName = 'TF' | 'IF' | 'DF';
export type FlagName = keyof IFlags;

export const FLAG_BIT_POSITIONS: Readonly<Record<FlagName, number>> = {
  CF: 0,
  PF: 2,
  AF: 4,
  ZF: 6,
  SF: 7,
  TF: 8,
  IF: 9,
  DF: 10,
  OF: 11,
} as const;

// ---------------------------------------------------------------------------
// Register File Interfaces & Snapshots
// ---------------------------------------------------------------------------

/** Serializable immutable snapshot of all registers and flags (ideal for React UI & Step Back) */
export interface IRegisterState {
  AX: number;
  BX: number;
  CX: number;
  DX: number;
  AH: number;
  AL: number;
  BH: number;
  BL: number;
  CH: number;
  CL: number;
  DH: number;
  DL: number;
  SP: number;
  BP: number;
  SI: number;
  DI: number;
  IP: number;
  CS: number;
  DS: number;
  SS: number;
  ES: number;
  FLAGS: IFlags;
  FLAGS_RAW: number;
}

/** Configuration for initial segment & pointer values (emu8086 defaults) */
export interface IInitialSegmentConfig {
  CS: number;
  DS: number;
  SS: number;
  ES: number;
  IP: number;
  SP: number;
}

/** Standard emu8086 COM / ORG 100h initial register layout */
export const DEFAULT_EMU8086_CONFIG: Readonly<IInitialSegmentConfig> = {
  CS: 0x0700,
  DS: 0x0700,
  SS: 0x0700,
  ES: 0x0700,
  IP: 0x0100,
  SP: 0xfffe,
} as const;

/** Standard emu8086 .model small (EXE-style) layout seen in course slides */
export const MODEL_SMALL_EMU8086_CONFIG: Readonly<IInitialSegmentConfig> = {
  CS: 0x0710,
  DS: 0x0700,
  SS: 0x0700,
  ES: 0x0700,
  IP: 0x0000,
  SP: 0xfffe,
} as const;

/** Behavioral contract for the 8086 Register File */
export interface IRegisters {
  AX: number;
  BX: number;
  CX: number;
  DX: number;
  AH: number;
  AL: number;
  BH: number;
  BL: number;
  CH: number;
  CL: number;
  DH: number;
  DL: number;
  SP: number;
  BP: number;
  SI: number;
  DI: number;
  IP: number;
  CS: number;
  DS: number;
  SS: number;
  ES: number;
  readonly flags: IFlags;

  get8(reg: Register8): number;
  set8(reg: Register8, value: number): void;
  get16(reg: Register16): number;
  set16(reg: Register16, value: number): void;
  get(reg: RegisterName): number;
  set(reg: RegisterName, value: number): void;
  getBitWidth(reg: RegisterName): DataSize;

  getFlag(flag: FlagName): boolean;
  setFlag(flag: FlagName, value: boolean): void;
  getFlagsWord(): number;
  setFlagsWord(word: number): void;

  reset(config?: Partial<IInitialSegmentConfig>): void;
  getSnapshot(): IRegisterState;
  restoreSnapshot(snapshot: IRegisterState): void;
}

// ---------------------------------------------------------------------------
// Memory Interface (1MB Real-Mode Flat Memory)
// ---------------------------------------------------------------------------

/** 1MB (1,048,576 bytes = 2^20) Intel 8086 address space */
export const MEMORY_SIZE = 0x100000;

/** 20-bit physical address mask (0x00000 - 0xFFFFF) */
export const PHYSICAL_ADDRESS_MASK = 0xfffff;

/** Logical segment:offset pair */
export interface ILogicalAddress {
  segment: number;
  offset: number;
}

/** Behavioral contract for 1MB 8086 Flat Memory */
export interface IMemory {
  readonly size: number;
  readonly raw: Uint8Array;

  /** Read a single 8-bit byte at a 20-bit physical address */
  readByte(physicalAddress: number): number;
  /** Write a single 8-bit byte at a 20-bit physical address */
  writeByte(physicalAddress: number, value: number): void;

  /** Read a 16-bit word in Intel Little-Endian order (low byte at addr, high byte at addr+1) */
  readWord(physicalAddress: number): number;
  /** Write a 16-bit word in Intel Little-Endian order (low byte at addr, high byte at addr+1) */
  writeWord(physicalAddress: number, value: number): void;

  /** Segment:Offset addressed byte read */
  readByteSegOff(segment: number, offset: number): number;
  /** Segment:Offset addressed byte write */
  writeByteSegOff(segment: number, offset: number, value: number): void;

  /** Segment:Offset addressed 16-bit Little-Endian word read */
  readWordSegOff(segment: number, offset: number): number;
  /** Segment:Offset addressed 16-bit Little-Endian word write */
  writeWordSegOff(segment: number, offset: number, value: number): void;

  /** Read a contiguous slice of memory (for Memory Viewer hex grid) */
  readBlock(physicalAddress: number, length: number): Uint8Array;
  /** Write an array of bytes starting at physicalAddress */
  writeBlock(physicalAddress: number, data: Uint8Array | readonly number[]): void;

  /** Zero-fill the entire 1MB memory */
  clear(): void;
  /** Create an isolated copy of memory for state snapshots */
  createSnapshot(): Uint8Array;
  /** Restore memory contents from a snapshot */
  restoreSnapshot(data: Uint8Array): void;
}

// ---------------------------------------------------------------------------
// CPU Interface & Execution State
// ---------------------------------------------------------------------------

/** Complete CPU execution state snapshot */
export interface ICPUSnapshot {
  registers: IRegisterState;
  halted: boolean;
  cycleCount: number;
  instructionIndex: number;
  lastError: string | null;
}

/** Behavioral contract for the Intel 8086 CPU model */
export interface ICPU {
  readonly registers: IRegisters;
  readonly memory: IMemory;
  halted: boolean;
  cycleCount: number;
  instructionIndex: number;
  lastError: string | null;

  /** Current instruction physical address: (CS << 4) + IP */
  getInstructionPhysicalAddress(): number;

  /** Default segment register for indirect/indexed addressing (BP -> SS, otherwise DS) */
  getDefaultSegment(baseRegister?: 'BX' | 'BP' | 'SI' | 'DI'): SegmentRegister;

  /** Push a 16-bit word onto the stack (SS:SP, decrements SP by 2) */
  push16(value: number): void;

  /** Pop a 16-bit word from the stack (SS:SP, increments SP by 2) */
  pop16(): number;

  /** Reset registers, flags, memory, and execution counters */
  reset(config?: Partial<IInitialSegmentConfig>, clearMemory?: boolean): void;

  /** Capture lightweight CPU state snapshot (registers + status) */
  getSnapshot(): ICPUSnapshot;

  /** Restore CPU state snapshot */
  restoreSnapshot(snapshot: ICPUSnapshot): void;
}

// ---------------------------------------------------------------------------
// Forward-Looking Operand & Instruction AST Types (for Steps 2 & 3)
// ---------------------------------------------------------------------------

export type BaseRegister = 'BX' | 'BP';
export type IndexRegister = 'SI' | 'DI';

export interface IRegisterOperand {
  kind: 'register';
  register: RegisterName;
  size: DataSize;
}

export interface IImmediateOperand {
  kind: 'immediate';
  value: number;
  /** Raw source representation (e.g. "0F5H", "'A'", "10110101b") */
  raw?: string;
}

export interface IMemoryOperand {
  kind: 'memory';
  /** Optional explicit segment override (e.g., DS:[1234H], ES:[DI]) */
  segmentOverride?: SegmentRegister;
  /** Optional base register (BX or BP) */
  base?: BaseRegister;
  /** Optional index register (SI or DI) */
  index?: IndexRegister;
  /** Numeric displacement / direct offset (e.g., 0x0058 in [0058H] or 0x1000 in [BX+1000H]) */
  displacement: number;
  /** Symbolic label name if referencing a .data variable (e.g., ARRAY[SI]) */
  symbol?: string;
  /** Explicit size override (BYTE PTR / b. / WORD PTR / w.) */
  sizeHint?: DataSize;
}

export interface ILabelOperand {
  kind: 'label';
  name: string;
}

export type Operand =
  | IRegisterOperand
  | IImmediateOperand
  | IMemoryOperand
  | ILabelOperand;

export interface IParsedInstruction {
  /** 1-based line number in the editor source */
  line: number;
  /** Original source text of the line */
  source: string;
  /** Normalized uppercase mnemonic (e.g. "MOV", "ADD", "JNZ") */
  mnemonic: string;
  /** Optional prefix (e.g. "REP", "REPE", "REPNE") */
  prefix?: string;
  /** Parsed operands */
  operands: Operand[];
  /** Simulated offset within code segment */
  offset: number;
  /** Estimated instruction byte length for realistic IP advancement */
  byteLength: number;
}
