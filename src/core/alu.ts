import { type DataSize, type IFlags } from './types';

/**
 * Pure Intel 8086 ALU & Flag Computation Module
 *
 * Strictly implements Intel 8086 hardware flag semantics (OF, SF, ZF, AF, PF, CF),
 * matching the "Cross Flag-Register Check" specifications in CPE303/CPE323/CME321.
 */

export interface IALUResult {
  /** Masked unsigned result (8-bit: 0x00..0xFF, 16-bit: 0x0000..0xFFFF) */
  result: number;
  /** Updated flags snapshot (only relevant flags modified, unaffected flags preserved) */
  flags: IFlags;
}

export interface IMulResult {
  /** Low part (AL for 8-bit -> full AX; AX for 16-bit) */
  low: number;
  /** High part (AH for 8-bit; DX for 16-bit) */
  high: number;
  /** Full 16-bit (for 8-bit mul) or 32-bit (for 16-bit mul) unsigned value */
  full: number;
  flags: IFlags;
}

export interface IDivResult {
  quotient: number;
  remainder: number;
}

export function getBitMask(size: DataSize): number {
  return size === 8 ? 0xff : 0xffff;
}

export function getSignBit(size: DataSize): number {
  return size === 8 ? 0x80 : 0x8000;
}

export function toSigned(value: number, size: DataSize): number {
  const mask = getBitMask(size);
  const signBit = getSignBit(size);
  const masked = value & mask;
  return (masked & signBit) !== 0 ? masked - (mask + 1) : masked;
}

export function getSignedBounds(size: DataSize): { min: number; max: number } {
  return size === 8
    ? { min: -128, max: 127 }
    : { min: -32768, max: 32767 };
}

/**
 * Intel 8086 Parity Flag (PF):
 * ALWAYS inspects ONLY the lowest 8 bits (bits 0..7) of the result,
 * even for 16-bit operations!
 * Returns true (PF = 1) for EVEN parity (even number of 1-bits), false (PF = 0) for ODD parity.
 */
export function computeParityFlag(value: number): boolean {
  let byte = value & 0xff;
  let ones = 0;
  while (byte !== 0) {
    ones += byte & 1;
    byte >>= 1;
  }
  return (ones & 1) === 0;
}

/**
 * Zero Flag (ZF): true if masked result equals 0.
 */
export function computeZeroFlag(result: number, size: DataSize): boolean {
  return (result & getBitMask(size)) === 0;
}

/**
 * Sign Flag (SF): copies MSB of masked result (bit 7 for 8-bit, bit 15 for 16-bit).
 */
export function computeSignFlag(result: number, size: DataSize): boolean {
  return (result & getSignBit(size)) !== 0;
}

/**
 * ADD / ADC: dest + src (+ CF if withCarry)
 * Updates: OF, SF, ZF, AF, PF, CF
 */
export function aluAdd(
  dest: number,
  src: number,
  size: DataSize,
  currentFlags: IFlags,
  withCarry: boolean = false
): IALUResult {
  const mask = getBitMask(size);
  const a = dest & mask;
  const b = src & mask;
  const carryIn = withCarry && currentFlags.CF ? 1 : 0;

  const full = a + b + carryIn;
  const result = full & mask;

  const { min, max } = getSignedBounds(size);
  const signedSum = toSigned(a, size) + toSigned(b, size) + carryIn;

  return {
    result,
    flags: {
      ...currentFlags,
      CF: full > mask,
      AF: (a & 0x0f) + (b & 0x0f) + carryIn > 0x0f,
      ZF: computeZeroFlag(result, size),
      SF: computeSignFlag(result, size),
      PF: computeParityFlag(result),
      OF: signedSum < min || signedSum > max,
    },
  };
}

/**
 * SUB / SBB / CMP: dest - src (- CF if withBorrow)
 * Updates: OF, SF, ZF, AF, PF, CF
 * (For CMP, caller uses flags and discards result.)
 */
export function aluSub(
  dest: number,
  src: number,
  size: DataSize,
  currentFlags: IFlags,
  withBorrow: boolean = false
): IALUResult {
  const mask = getBitMask(size);
  const a = dest & mask;
  const b = src & mask;
  const borrowIn = withBorrow && currentFlags.CF ? 1 : 0;

  const full = a - b - borrowIn;
  const result = full & mask;

  const { min, max } = getSignedBounds(size);
  const signedDiff = toSigned(a, size) - toSigned(b, size) - borrowIn;

  return {
    result,
    flags: {
      ...currentFlags,
      CF: full < 0,
      AF: (a & 0x0f) - (b & 0x0f) - borrowIn < 0,
      ZF: computeZeroFlag(result, size),
      SF: computeSignFlag(result, size),
      PF: computeParityFlag(result),
      OF: signedDiff < min || signedDiff > max,
    },
  };
}

/**
 * INC: operand + 1
 * CRITICAL Intel 8086 spec: Updates OF, SF, ZF, AF, PF — DOES NOT MODIFY CF!
 */
export function aluInc(
  value: number,
  size: DataSize,
  currentFlags: IFlags
): IALUResult {
  const added = aluAdd(value, 1, size, currentFlags, false);
  return {
    result: added.result,
    flags: {
      ...added.flags,
      CF: currentFlags.CF, // Preserve CF!
    },
  };
}

/**
 * DEC: operand - 1
 * CRITICAL Intel 8086 spec: Updates OF, SF, ZF, AF, PF — DOES NOT MODIFY CF!
 */
export function aluDec(
  value: number,
  size: DataSize,
  currentFlags: IFlags
): IALUResult {
  const subtracted = aluSub(value, 1, size, currentFlags, false);
  return {
    result: subtracted.result,
    flags: {
      ...subtracted.flags,
      CF: currentFlags.CF, // Preserve CF!
    },
  };
}

/**
 * NEG: 0 - operand (Two's complement negation)
 * Updates: CF (= operand !== 0), OF, SF, ZF, AF, PF
 */
export function aluNeg(
  value: number,
  size: DataSize,
  currentFlags: IFlags
): IALUResult {
  const mask = getBitMask(size);
  const a = value & mask;
  const subtracted = aluSub(0, a, size, currentFlags, false);
  return {
    result: subtracted.result,
    flags: {
      ...subtracted.flags,
      CF: a !== 0,
    },
  };
}

/**
 * MUL: Unsigned multiplication
 * - 8-bit:  AX = AL * src;  CF = OF = (AH !== 0)
 * - 16-bit: DX:AX = AX * src; CF = OF = (DX !== 0)
 */
export function aluMul(
  accumulator: number,
  multiplier: number,
  size: DataSize,
  currentFlags: IFlags
): IMulResult {
  const mask = getBitMask(size);
  const a = accumulator & mask;
  const b = multiplier & mask;
  const product = a * b;

  if (size === 8) {
    const low = product & 0xff;
    const high = (product >> 8) & 0xff;
    const overflow = high !== 0;
    return {
      low,
      high,
      full: product & 0xffff,
      flags: {
        ...currentFlags,
        CF: overflow,
        OF: overflow,
      },
    };
  }

  const low = product & 0xffff;
  const high = (product >>> 16) & 0xffff;
  const overflow = high !== 0;
  return {
    low,
    high,
    full: product >>> 0,
    flags: {
      ...currentFlags,
      CF: overflow,
      OF: overflow,
    },
  };
}

/**
 * IMUL: Signed multiplication (two's complement)
 * - 8-bit:  AX = signed(AL) * signed(src); CF = OF = (product < -128 || product > 127)
 * - 16-bit: DX:AX = signed(AX) * signed(src); CF = OF = (product < -32768 || product > 32767)
 */
export function aluImul(
  accumulator: number,
  multiplier: number,
  size: DataSize,
  currentFlags: IFlags
): IMulResult {
  const a = toSigned(accumulator, size);
  const b = toSigned(multiplier, size);
  const product = a * b;
  const { min, max } = getSignedBounds(size);
  const overflow = product < min || product > max;

  if (size === 8) {
    const u16 = product & 0xffff;
    return {
      low: u16 & 0xff,
      high: (u16 >> 8) & 0xff,
      full: u16,
      flags: {
        ...currentFlags,
        CF: overflow,
        OF: overflow,
      },
    };
  }

  const u32 = product >>> 0;
  return {
    low: u32 & 0xffff,
    high: (u32 >>> 16) & 0xffff,
    full: u32,
    flags: {
      ...currentFlags,
      CF: overflow,
      OF: overflow,
    },
  };
}

/**
 * DIV: Unsigned division
 * - 8-bit:  AX / src -> quotient in AL, remainder in AH
 * - 16-bit: DX:AX / src -> quotient in AX, remainder in DX
 * Throws 'DIVIDE_BY_ZERO' or 'DIVIDE_OVERFLOW' on hardware INT 0 condition.
 */
export function aluDiv(
  dividendLow: number,
  dividendHigh: number,
  divisor: number,
  size: DataSize
): IDivResult {
  const mask = getBitMask(size);
  const div = divisor & mask;
  if (div === 0) {
    throw new Error('DIVIDE_BY_ZERO');
  }

  const dividend =
    size === 8
      ? ((dividendHigh & 0xff) << 8) | (dividendLow & 0xff)
      : (dividendHigh & 0xffff) * 0x10000 + (dividendLow & 0xffff);

  const quotient = Math.floor(dividend / div);
  const remainder = dividend % div;

  if (quotient > mask) {
    throw new Error('DIVIDE_OVERFLOW');
  }

  return {
    quotient: quotient & mask,
    remainder: remainder & mask,
  };
}

/**
 * IDIV: Signed division (truncates toward zero, remainder has sign of dividend)
 * - 8-bit:  signed(AX) / signed(src) -> AL = quotient, AH = remainder
 * - 16-bit: signed(DX:AX) / signed(src) -> AX = quotient, DX = remainder
 */
export function aluIdiv(
  dividendLow: number,
  dividendHigh: number,
  divisor: number,
  size: DataSize
): IDivResult {
  const mask = getBitMask(size);
  const div = toSigned(divisor, size);
  if (div === 0) {
    throw new Error('DIVIDE_BY_ZERO');
  }

  let signedDividend: number;
  if (size === 8) {
    const raw16 = ((dividendHigh & 0xff) << 8) | (dividendLow & 0xff);
    signedDividend = toSigned(raw16, 16);
  } else {
    const raw32 = ((dividendHigh & 0xffff) << 16) | (dividendLow & 0xffff);
    // Bitwise OR yields signed 32-bit integer in JavaScript
    signedDividend = raw32;
  }

  const quotient = Math.trunc(signedDividend / div);
  const remainder = signedDividend - quotient * div;
  const { min, max } = getSignedBounds(size);

  if (quotient < min || quotient > max) {
    throw new Error('DIVIDE_OVERFLOW');
  }

  return {
    quotient: quotient & mask,
    remainder: remainder & mask,
  };
}

/**
 * Bitwise Logic Operations: AND, OR, XOR, TEST
 * Always clears CF = 0, OF = 0, AF = 0; updates SF, ZF, PF according to result.
 */
export function aluLogic(
  op: 'AND' | 'OR' | 'XOR',
  dest: number,
  src: number,
  size: DataSize,
  currentFlags: IFlags
): IALUResult {
  const mask = getBitMask(size);
  const a = dest & mask;
  const b = src & mask;

  let result: number;
  if (op === 'AND') result = (a & b) & mask;
  else if (op === 'OR') result = (a | b) & mask;
  else result = (a ^ b) & mask;

  return {
    result,
    flags: {
      ...currentFlags,
      CF: false,
      OF: false,
      AF: false,
      ZF: computeZeroFlag(result, size),
      SF: computeSignFlag(result, size),
      PF: computeParityFlag(result),
    },
  };
}

/**
 * Shift instructions: SHL, SAL, SHR, SAR
 * True Intel 8086 behavior: uses full 8-bit shift count (0..255), NOT 286+ 5-bit mask!
 * Updates CF (last shifted-out bit), OF (updated on each 1-bit micro-step), SF, ZF, PF.
 * If count === 0, no flags change.
 */
export function aluShift(
  op: 'SHL' | 'SAL' | 'SHR' | 'SAR',
  dest: number,
  count: number,
  size: DataSize,
  currentFlags: IFlags
): IALUResult {
  const mask = getBitMask(size);
  const signBit = getSignBit(size);
  let value = dest & mask;
  const shifts = count & 0xff;

  if (shifts === 0) {
    return { result: value, flags: { ...currentFlags } };
  }

  let cf = currentFlags.CF;
  let of = currentFlags.OF;

  for (let i = 0; i < shifts; i++) {
    if (op === 'SHL' || op === 'SAL') {
      cf = (value & signBit) !== 0;
      value = (value << 1) & mask;
      of = ((value & signBit) !== 0) !== cf;
    } else if (op === 'SHR') {
      of = (value & signBit) !== 0;
      cf = (value & 1) !== 0;
      value = (value >>> 1) & mask;
    } else {
      // SAR: preserve sign bit
      const msb = value & signBit;
      cf = (value & 1) !== 0;
      value = ((value >>> 1) | msb) & mask;
      of = false;
    }
  }

  return {
    result: value,
    flags: {
      ...currentFlags,
      CF: cf,
      OF: of,
      ZF: computeZeroFlag(value, size),
      SF: computeSignFlag(value, size),
      PF: computeParityFlag(value),
    },
  };
}

/**
 * Rotate instructions: ROL, ROR, RCL, RCR
 * True Intel 8086 behavior: uses full 8-bit count (0..255).
 * Updates ONLY CF and OF. Does NOT affect SF, ZF, AF, PF!
 */
export function aluRotate(
  op: 'ROL' | 'ROR' | 'RCL' | 'RCR',
  dest: number,
  count: number,
  size: DataSize,
  currentFlags: IFlags
): IALUResult {
  const mask = getBitMask(size);
  const signBit = getSignBit(size);
  let value = dest & mask;
  const shifts = count & 0xff;

  if (shifts === 0) {
    return { result: value, flags: { ...currentFlags } };
  }

  let cf = currentFlags.CF;
  let of = currentFlags.OF;

  for (let i = 0; i < shifts; i++) {
    if (op === 'ROL') {
      const msb = (value & signBit) !== 0 ? 1 : 0;
      cf = msb === 1;
      value = ((value << 1) | msb) & mask;
      of = ((value & signBit) !== 0) !== cf;
    } else if (op === 'ROR') {
      const lsb = value & 1;
      cf = lsb === 1;
      value = ((value >>> 1) | (lsb ? signBit : 0)) & mask;
      const msb = (value & signBit) !== 0;
      const nextMsb = (value & (signBit >>> 1)) !== 0;
      of = msb !== nextMsb;
    } else if (op === 'RCL') {
      const msb = (value & signBit) !== 0;
      const prevCf = cf ? 1 : 0;
      cf = msb;
      value = ((value << 1) | prevCf) & mask;
      of = ((value & signBit) !== 0) !== cf;
    } else {
      // RCR
      of = ((value & signBit) !== 0) !== cf;
      const lsb = (value & 1) !== 0;
      const prevCfBit = cf ? signBit : 0;
      cf = lsb;
      value = ((value >>> 1) | prevCfBit) & mask;
    }
  }

  return {
    result: value,
    flags: {
      ...currentFlags,
      CF: cf,
      OF: of,
    },
  };
}

/**
 * DAA (Decimal Adjust AL after Addition)
 */
export function aluDaa(al: number, currentFlags: IFlags): IALUResult {
  const oldAl = al & 0xff;
  const oldCf = currentFlags.CF;
  let result = oldAl;
  let af = false;
  let cf = oldCf;

  if ((oldAl & 0x0f) > 9 || currentFlags.AF) {
    result = result + 6;
    cf = oldCf || result > 0xff;
    result &= 0xff;
    af = true;
  }

  if (oldAl > 0x99 || oldCf) {
    result = (result + 0x60) & 0xff;
    cf = true;
  } else {
    cf = false;
  }

  return {
    result,
    flags: {
      ...currentFlags,
      CF: cf,
      AF: af,
      ZF: computeZeroFlag(result, 8),
      SF: computeSignFlag(result, 8),
      PF: computeParityFlag(result),
    },
  };
}

/**
 * DAS (Decimal Adjust AL after Subtraction)
 */
export function aluDas(al: number, currentFlags: IFlags): IALUResult {
  const oldAl = al & 0xff;
  const oldCf = currentFlags.CF;
  let result = oldAl;
  let af = false;
  let cf = false;

  if ((oldAl & 0x0f) > 9 || currentFlags.AF) {
    const temp = result - 6;
    cf = oldCf || temp < 0;
    result = temp & 0xff;
    af = true;
  }

  if (oldAl > 0x99 || oldCf) {
    result = (result - 0x60) & 0xff;
    cf = true;
  }

  return {
    result,
    flags: {
      ...currentFlags,
      CF: cf,
      AF: af,
      ZF: computeZeroFlag(result, 8),
      SF: computeSignFlag(result, 8),
      PF: computeParityFlag(result),
    },
  };
}
