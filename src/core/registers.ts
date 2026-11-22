import {
  type DataSize,
  DEFAULT_EMU8086_CONFIG,
  FLAG_BIT_POSITIONS,
  type FlagName,
  type IFlags,
  type IInitialSegmentConfig,
  type IRegisters,
  type IRegisterState,
  type Register16,
  type Register8,
  type RegisterName,
} from './types';

const REG8_SET = new Set<string>(['AH', 'AL', 'BH', 'BL', 'CH', 'CL', 'DH', 'DL']);

/**
 * Checks whether a register name refers to an 8-bit register half.
 */
export function isRegister8(reg: RegisterName): reg is Register8 {
  return REG8_SET.has(reg);
}

/**
 * Creates a fresh default 8086 Flags state.
 * Matches emu8086 initial state (all status flags 0, IF = 1).
 */
export function createDefaultFlags(): IFlags {
  return {
    CF: false,
    PF: false,
    AF: false,
    ZF: false,
    SF: false,
    OF: false,
    TF: false,
    IF: true,
    DF: false,
  };
}

/**
 * Intel 8086 Register File implementation.
 *
 * General-purpose 16-bit registers (AX, BX, CX, DX) are stored as masked 16-bit values
 * in a Uint16Array, while their 8-bit High/Low halves (AH/AL, BH/BL, CH/CL, DH/DL)
 * read/write directly into the upper/lower byte via endianness-independent bit masking.
 */
export class RegisterFile implements IRegisters {
  // Backing storage: [0]=AX, [1]=BX, [2]=CX, [3]=DX, [4]=SP, [5]=BP, [6]=SI, [7]=DI,
  //                  [8]=IP, [9]=CS, [10]=DS, [11]=SS, [12]=ES
  private readonly regs16 = new Uint16Array(13);
  private _flags: IFlags = createDefaultFlags();

  constructor(config?: Partial<IInitialSegmentConfig>) {
    this.reset(config);
  }

  // -------------------------------------------------------------------------
  // General Purpose 16-bit Registers (AX, BX, CX, DX)
  // -------------------------------------------------------------------------

  public get AX(): number {
    return this.regs16[0];
  }
  public set AX(value: number) {
    this.regs16[0] = value & 0xffff;
  }

  public get BX(): number {
    return this.regs16[1];
  }
  public set BX(value: number) {
    this.regs16[1] = value & 0xffff;
  }

  public get CX(): number {
    return this.regs16[2];
  }
  public set CX(value: number) {
    this.regs16[2] = value & 0xffff;
  }

  public get DX(): number {
    return this.regs16[3];
  }
  public set DX(value: number) {
    this.regs16[3] = value & 0xffff;
  }

  // -------------------------------------------------------------------------
  // Independent 8-bit High/Low Halves (AH/AL, BH/BL, CH/CL, DH/DL)
  // -------------------------------------------------------------------------

  public get AH(): number {
    return (this.regs16[0] >> 8) & 0xff;
  }
  public set AH(value: number) {
    this.regs16[0] = (this.regs16[0] & 0x00ff) | ((value & 0xff) << 8);
  }

  public get AL(): number {
    return this.regs16[0] & 0xff;
  }
  public set AL(value: number) {
    this.regs16[0] = (this.regs16[0] & 0xff00) | (value & 0xff);
  }

  public get BH(): number {
    return (this.regs16[1] >> 8) & 0xff;
  }
  public set BH(value: number) {
    this.regs16[1] = (this.regs16[1] & 0x00ff) | ((value & 0xff) << 8);
  }

  public get BL(): number {
    return this.regs16[1] & 0xff;
  }
  public set BL(value: number) {
    this.regs16[1] = (this.regs16[1] & 0xff00) | (value & 0xff);
  }

  public get CH(): number {
    return (this.regs16[2] >> 8) & 0xff;
  }
  public set CH(value: number) {
    this.regs16[2] = (this.regs16[2] & 0x00ff) | ((value & 0xff) << 8);
  }

  public get CL(): number {
    return this.regs16[2] & 0xff;
  }
  public set CL(value: number) {
    this.regs16[2] = (this.regs16[2] & 0xff00) | (value & 0xff);
  }

  public get DH(): number {
    return (this.regs16[3] >> 8) & 0xff;
  }
  public set DH(value: number) {
    this.regs16[3] = (this.regs16[3] & 0x00ff) | ((value & 0xff) << 8);
  }

  public get DL(): number {
    return this.regs16[3] & 0xff;
  }
  public set DL(value: number) {
    this.regs16[3] = (this.regs16[3] & 0xff00) | (value & 0xff);
  }

  // -------------------------------------------------------------------------
  // Pointer & Index Registers (SP, BP, SI, DI, IP)
  // -------------------------------------------------------------------------

  public get SP(): number {
    return this.regs16[4];
  }
  public set SP(value: number) {
    this.regs16[4] = value & 0xffff;
  }

  public get BP(): number {
    return this.regs16[5];
  }
  public set BP(value: number) {
    this.regs16[5] = value & 0xffff;
  }

  public get SI(): number {
    return this.regs16[6];
  }
  public set SI(value: number) {
    this.regs16[6] = value & 0xffff;
  }

  public get DI(): number {
    return this.regs16[7];
  }
  public set DI(value: number) {
    this.regs16[7] = value & 0xffff;
  }

  public get IP(): number {
    return this.regs16[8];
  }
  public set IP(value: number) {
    this.regs16[8] = value & 0xffff;
  }

  // -------------------------------------------------------------------------
  // Segment Registers (CS, DS, SS, ES)
  // -------------------------------------------------------------------------

  public get CS(): number {
    return this.regs16[9];
  }
  public set CS(value: number) {
    this.regs16[9] = value & 0xffff;
  }

  public get DS(): number {
    return this.regs16[10];
  }
  public set DS(value: number) {
    this.regs16[10] = value & 0xffff;
  }

  public get SS(): number {
    return this.regs16[11];
  }
  public set SS(value: number) {
    this.regs16[11] = value & 0xffff;
  }

  public get ES(): number {
    return this.regs16[12];
  }
  public set ES(value: number) {
    this.regs16[12] = value & 0xffff;
  }

  // -------------------------------------------------------------------------
  // Generic Dynamic Accessors
  // -------------------------------------------------------------------------

  public get8(reg: Register8): number {
    return this[reg];
  }

  public set8(reg: Register8, value: number): void {
    this[reg] = value & 0xff;
  }

  public get16(reg: Register16): number {
    return this[reg];
  }

  public set16(reg: Register16, value: number): void {
    this[reg] = value & 0xffff;
  }

  public get(reg: RegisterName): number {
    return isRegister8(reg) ? this.get8(reg) : this.get16(reg);
  }

  public set(reg: RegisterName, value: number): void {
    if (isRegister8(reg)) {
      this.set8(reg, value);
    } else {
      this.set16(reg, value);
    }
  }

  public getBitWidth(reg: RegisterName): DataSize {
    return isRegister8(reg) ? 8 : 16;
  }

  // -------------------------------------------------------------------------
  // Flags Register Accessors & 16-bit Packing/Unpacking
  // -------------------------------------------------------------------------

  public get flags(): IFlags {
    return this._flags;
  }

  public getFlag(flag: FlagName): boolean {
    return this._flags[flag];
  }

  public setFlag(flag: FlagName, value: boolean): void {
    this._flags[flag] = Boolean(value);
  }

  /**
   * Packs distinct boolean flags into the standard 16-bit Intel 8086 FLAGS word.
   * Bit 1 is always set to 1 (reserved) per x86 architecture specification.
   */
  public getFlagsWord(): number {
    let word = 0x0002; // Bit 1 is always 1 on Intel x86
    for (const key of Object.keys(FLAG_BIT_POSITIONS) as FlagName[]) {
      if (this._flags[key]) {
        word |= 1 << FLAG_BIT_POSITIONS[key];
      }
    }
    return word & 0xffff;
  }

  /**
   * Unpacks a 16-bit FLAGS word (e.g. from POPF) into individual boolean flags.
   */
  public setFlagsWord(word: number): void {
    const masked = word & 0xffff;
    for (const key of Object.keys(FLAG_BIT_POSITIONS) as FlagName[]) {
      this._flags[key] = ((masked >> FLAG_BIT_POSITIONS[key]) & 1) === 1;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle & Snapshots
  // -------------------------------------------------------------------------

  public reset(config?: Partial<IInitialSegmentConfig>): void {
    const merged: IInitialSegmentConfig = {
      ...DEFAULT_EMU8086_CONFIG,
      ...config,
    };
    this.regs16.fill(0);
    this.CS = merged.CS;
    this.DS = merged.DS;
    this.SS = merged.SS;
    this.ES = merged.ES;
    this.IP = merged.IP;
    this.SP = merged.SP;
    this._flags = createDefaultFlags();
  }

  public getSnapshot(): IRegisterState {
    return {
      AX: this.AX,
      BX: this.BX,
      CX: this.CX,
      DX: this.DX,
      AH: this.AH,
      AL: this.AL,
      BH: this.BH,
      BL: this.BL,
      CH: this.CH,
      CL: this.CL,
      DH: this.DH,
      DL: this.DL,
      SP: this.SP,
      BP: this.BP,
      SI: this.SI,
      DI: this.DI,
      IP: this.IP,
      CS: this.CS,
      DS: this.DS,
      SS: this.SS,
      ES: this.ES,
      FLAGS: { ...this._flags },
      FLAGS_RAW: this.getFlagsWord(),
    };
  }

  public restoreSnapshot(snapshot: IRegisterState): void {
    this.AX = snapshot.AX;
    this.BX = snapshot.BX;
    this.CX = snapshot.CX;
    this.DX = snapshot.DX;
    this.SP = snapshot.SP;
    this.BP = snapshot.BP;
    this.SI = snapshot.SI;
    this.DI = snapshot.DI;
    this.IP = snapshot.IP;
    this.CS = snapshot.CS;
    this.DS = snapshot.DS;
    this.SS = snapshot.SS;
    this.ES = snapshot.ES;
    this._flags = { ...snapshot.FLAGS };
  }
}
