import { calculatePhysicalAddress, Memory } from './memory';
import { RegisterFile } from './registers';
import {
  type ICPU,
  type ICPUSnapshot,
  type IInitialSegmentConfig,
  type SegmentRegister,
} from './types';

/**
 * Core Intel 8086 CPU Model
 *
 * Encapsulates the 16-bit RegisterFile, 1MB Flat Memory, stack operations,
 * and execution state tracking. ALU and instruction execution will hook into
 * this model in Step 2.
 */
export class CPU implements ICPU {
  public readonly registers: RegisterFile;
  public readonly memory: Memory;
  public halted: boolean = false;
  public cycleCount: number = 0;
  public instructionIndex: number = 0;
  public lastError: string | null = null;

  constructor(config?: Partial<IInitialSegmentConfig>) {
    this.registers = new RegisterFile(config);
    this.memory = new Memory();
  }

  /**
   * Computes physical address of the next instruction: (CS << 4) + IP
   */
  public getInstructionPhysicalAddress(): number {
    return calculatePhysicalAddress(this.registers.CS, this.registers.IP);
  }

  /**
   * Returns the Intel 8086 default segment register for a memory operand.
   * Per 8086 architecture (and KBU Addressing Modes slides):
   * - BP defaults to Stack Segment (SS)
   * - BX, SI, DI, and direct addressing default to Data Segment (DS)
   */
  public getDefaultSegment(
    baseRegister?: 'BX' | 'BP' | 'SI' | 'DI'
  ): SegmentRegister {
    return baseRegister === 'BP' ? 'SS' : 'DS';
  }

  /**
   * Pushes a 16-bit word onto the stack (LIFO):
   *   1. SP = (SP - 2) & 0xFFFF  (cyclic 64KB stack segment wraparound)
   *   2. Write 16-bit Little-Endian word to SS:SP
   */
  public push16(value: number): void {
    this.registers.SP = (this.registers.SP - 2) & 0xffff;
    this.memory.writeWordSegOff(this.registers.SS, this.registers.SP, value & 0xffff);
  }

  /**
   * Pops a 16-bit word from the stack (LIFO):
   *   1. Read 16-bit Little-Endian word from SS:SP
   *   2. SP = (SP + 2) & 0xFFFF
   */
  public pop16(): number {
    const value = this.memory.readWordSegOff(this.registers.SS, this.registers.SP);
    this.registers.SP = (this.registers.SP + 2) & 0xffff;
    return value;
  }

  /**
   * Resets CPU state to initial emu8086 defaults.
   */
  public reset(
    config?: Partial<IInitialSegmentConfig>,
    clearMemory: boolean = true
  ): void {
    this.registers.reset(config);
    if (clearMemory) {
      this.memory.clear();
    }
    this.halted = false;
    this.cycleCount = 0;
    this.instructionIndex = 0;
    this.lastError = null;
  }

  public getSnapshot(): ICPUSnapshot {
    return {
      registers: this.registers.getSnapshot(),
      halted: this.halted,
      cycleCount: this.cycleCount,
      instructionIndex: this.instructionIndex,
      lastError: this.lastError,
    };
  }

  public restoreSnapshot(snapshot: ICPUSnapshot): void {
    this.registers.restoreSnapshot(snapshot.registers);
    this.halted = snapshot.halted;
    this.cycleCount = snapshot.cycleCount;
    this.instructionIndex = snapshot.instructionIndex;
    this.lastError = snapshot.lastError;
  }
}
