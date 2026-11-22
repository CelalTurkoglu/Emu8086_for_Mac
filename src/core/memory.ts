import {
  type ILogicalAddress,
  type IMemory,
  MEMORY_SIZE,
  PHYSICAL_ADDRESS_MASK,
} from './types';

/**
 * Computes the 20-bit physical address from an Intel 8086 Segment:Offset pair.
 * Formula: ((Segment << 4) + Offset) & 0xFFFFF
 *
 * Example (from KBU course slides):
 *   Segment = 2500H, Offset = 95F3H -> 25000H + 95F3H = 2E5F3H
 *   Segment = 1512H, Offset = 3518H -> 15120H + 3518H = 18638H
 */
export function calculatePhysicalAddress(
  segment: number,
  offset: number
): number {
  const seg16 = segment & 0xffff;
  const off16 = offset & 0xffff;
  return ((seg16 << 4) + off16) & PHYSICAL_ADDRESS_MASK;
}

/**
 * Formats an unsigned integer as an uppercase zero-padded hexadecimal string.
 */
export function formatHex(value: number, digits: number): string {
  const mask = digits >= 8 ? 0xffffffff : (1 << (digits * 4)) - 1;
  return ((value >>> 0) & mask).toString(16).toUpperCase().padStart(digits, '0');
}

/**
 * Parses a logical "SEG:OFF" (e.g. "0700:0000") or physical hex address (e.g. "07000" or "07000H").
 * Returns null if the input is invalid.
 */
export function parseAddressInput(
  input: string
): { physicalAddress: number; logical?: ILogicalAddress } | null {
  const cleaned = input.trim().toUpperCase();
  if (!cleaned) return null;

  if (cleaned.includes(':')) {
    const parts = cleaned.split(':');
    if (parts.length !== 2) return null;
    const segStr = parts[0].replace(/^0X/, '').replace(/H$/, '');
    const offStr = parts[1].replace(/^0X/, '').replace(/H$/, '');
    if (!/^[0-9A-F]{1,4}$/.test(segStr) || !/^[0-9A-F]{1,4}$/.test(offStr)) {
      return null;
    }
    const segment = parseInt(segStr, 16);
    const offset = parseInt(offStr, 16);
    return {
      physicalAddress: calculatePhysicalAddress(segment, offset),
      logical: { segment, offset },
    };
  }

  const physStr = cleaned.replace(/^0X/, '').replace(/H$/, '');
  if (!/^[0-9A-F]{1,5}$/.test(physStr)) return null;
  const physicalAddress = parseInt(physStr, 16) & PHYSICAL_ADDRESS_MASK;
  return { physicalAddress };
}

/**
 * 1MB (0x100000 bytes) Flat Memory implementation for Intel 8086 Real Mode.
 * Uses Intel Little-Endian byte ordering for 16-bit word operations.
 */
export class Memory implements IMemory {
  public readonly size: number = MEMORY_SIZE;
  private readonly buffer: Uint8Array;

  constructor() {
    this.buffer = new Uint8Array(MEMORY_SIZE);
  }

  public get raw(): Uint8Array {
    return this.buffer;
  }

  public readByte(physicalAddress: number): number {
    return this.buffer[physicalAddress & PHYSICAL_ADDRESS_MASK];
  }

  public writeByte(physicalAddress: number, value: number): void {
    this.buffer[physicalAddress & PHYSICAL_ADDRESS_MASK] = value & 0xff;
  }

  /**
   * Intel Little-Endian 16-bit word read:
   *   Low byte  <- memory[physicalAddress]
   *   High byte <- memory[physicalAddress + 1]
   */
  public readWord(physicalAddress: number): number {
    const low = this.readByte(physicalAddress);
    const high = this.readByte(physicalAddress + 1);
    return ((high << 8) | low) & 0xffff;
  }

  /**
   * Intel Little-Endian 16-bit word write:
   *   memory[physicalAddress]     <- value & 0xFF (low-order byte)
   *   memory[physicalAddress + 1] <- (value >> 8) & 0xFF (high-order byte)
   */
  public writeWord(physicalAddress: number, value: number): void {
    this.writeByte(physicalAddress, value & 0xff);
    this.writeByte(physicalAddress + 1, (value >> 8) & 0xff);
  }

  public readByteSegOff(segment: number, offset: number): number {
    return this.readByte(calculatePhysicalAddress(segment, offset));
  }

  public writeByteSegOff(segment: number, offset: number, value: number): void {
    this.writeByte(calculatePhysicalAddress(segment, offset), value);
  }

  /**
   * Segment:Offset Little-Endian 16-bit read.
   * Respects 64KB segment offset wrapping (offset 0xFFFF wraps next byte to 0x0000 in same segment).
   */
  public readWordSegOff(segment: number, offset: number): number {
    const low = this.readByteSegOff(segment, offset);
    const high = this.readByteSegOff(segment, (offset + 1) & 0xffff);
    return ((high << 8) | low) & 0xffff;
  }

  /**
   * Segment:Offset Little-Endian 16-bit write.
   * Respects 64KB segment offset wrapping.
   */
  public writeWordSegOff(segment: number, offset: number, value: number): void {
    this.writeByteSegOff(segment, offset, value & 0xff);
    this.writeByteSegOff(segment, (offset + 1) & 0xffff, (value >> 8) & 0xff);
  }

  public readBlock(physicalAddress: number, length: number): Uint8Array {
    const safeLength = Math.max(0, Math.floor(length));
    const result = new Uint8Array(safeLength);
    for (let i = 0; i < safeLength; i++) {
      result[i] = this.buffer[(physicalAddress + i) & PHYSICAL_ADDRESS_MASK];
    }
    return result;
  }

  public writeBlock(
    physicalAddress: number,
    data: Uint8Array | readonly number[]
  ): void {
    for (let i = 0; i < data.length; i++) {
      this.buffer[(physicalAddress + i) & PHYSICAL_ADDRESS_MASK] = data[i] & 0xff;
    }
  }

  public clear(): void {
    this.buffer.fill(0);
  }

  public createSnapshot(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  public restoreSnapshot(data: Uint8Array): void {
    if (data.length !== MEMORY_SIZE) {
      throw new Error(
        `Invalid memory snapshot size: expected ${MEMORY_SIZE} bytes, got ${data.length}`
      );
    }
    this.buffer.set(data);
  }
}
