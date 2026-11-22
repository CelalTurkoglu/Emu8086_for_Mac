import {
  aluAdd,
  aluDaa,
  aluDas,
  aluDec,
  aluDiv,
  aluIdiv,
  aluImul,
  aluInc,
  aluLogic,
  aluMul,
  aluNeg,
  aluRotate,
  aluShift,
  aluSub,
  computeParityFlag,
  computeSignFlag,
  computeZeroFlag,
  getBitMask,
} from './alu';
import { CPU } from './cpu';
import { calculatePhysicalAddress, formatHex } from './memory';
import {
  assemble,
  encodeRepresentativeBytes,
  stripComment,
  type IAssembleOptions,
  type IAssembledProgram,
  type IParseError,
  type IParseWarning,
} from './parser';
import {
  type DataSize,
  type FlagName,
  type ICPUSnapshot,
  type IFlags,
  type IMemoryOperand,
  type IParsedInstruction,
  type IRegisterState,
  type Operand,
  type RegisterName,
  type SegmentRegister,
} from './types';

export interface IRuntimeError {
  line: number;
  code: string;
  messageTr: string;
  messageEn: string;
}

export interface IRuntimeWarning {
  line: number;
  code: string;
  messageTr: string;
  messageEn: string;
}

export interface IPendingInputRequest {
  kind: 'char' | 'line';
  interrupt: 'INT21_01' | 'INT21_07' | 'INT21_08' | 'INT21_0A' | 'INT16_00';
  echo: boolean;
  maxLength?: number;
  line: number;
}

export interface ITraceMemoryWrite {
  segmentReg: SegmentRegister;
  segment: number;
  offset: number;
  physicalAddress: number;
  size: DataSize;
  value: number;
  /** Optional count if this entry summarizes a bulk REP write (e.g. REP STOSB) */
  repeatCount?: number;
}

export interface ITraceEntry {
  /** 0 for Initial State, 1..N for each executed instruction (including loop iterations) */
  step: number;
  isInitial: boolean;
  line: number | null;
  cs: number;
  ip: number;
  instruction: string;
  /** 1-based execution count of this line (shows loop iterations cleanly) */
  lineHitCount: number;
  registers: IRegisterState;
  changedRegisters: RegisterName[];
  changedFlags: FlagName[];
  memoryWrites: ITraceMemoryWrite[];
}

export interface IStepResult {
  executed: boolean;
  halted: boolean;
  executedLine: number | null;
  nextLine: number | null;
  changedRegisters: RegisterName[];
  changedFlags: FlagName[];
  writtenAddresses: number[];
  consoleOutput: string;
  error: IRuntimeError | null;
  warning?: IRuntimeWarning | null;
  waitingForInput?: IPendingInputRequest | null;
}

interface IMemoryUndoEntry {
  address: number;
  previousValue: number;
}

interface IHistoryFrame {
  snapshot: ICPUSnapshot;
  callDepth: number;
  consoleOutput: string;
  memoryUndo: IMemoryUndoEntry[];
  tracePushed: boolean;
  traceLine: number | null;
}

const SEGMENT_REGS = new Set<string>(['CS', 'DS', 'SS', 'ES']);
const MAX_HISTORY_FRAMES = 2000;
const MAX_TRACE_ENTRIES = 5000;
const MAX_TRACE_MEM_WRITES_PER_STEP = 16;

/**
 * Runtime execution error carrying both Turkish and English messages.
 */
class ExecutionError extends Error {
  public readonly code: string;
  public readonly messageTr: string;
  public readonly messageEn: string;

  constructor(code: string, messageTr: string, messageEn: string) {
    super(messageEn);
    this.code = code;
    this.messageTr = messageTr;
    this.messageEn = messageEn;
  }
}

/**
 * Internal control signal thrown when an INT instruction needs user keyboard input.
 */
class WaitForInputSignal {
  public readonly request: IPendingInputRequest;
  constructor(request: IPendingInputRequest) {
    this.request = request;
  }
}

/**
 * Intel 8086 Execution Engine & Step Debugger
 *
 * Bridges the assembled program AST with the CPU, RegisterFile, Memory, and ALU.
 * Supports Compile/Load, Single Step, Step Back (undo), Run, Interactive Input, and Reset.
 */
export class EmulatorEngine {
  public readonly cpu: CPU;
  public program: IAssembledProgram | null = null;
  public strictMode: boolean = false;
  public consoleOutput: string = '';
  public lastRuntimeError: IRuntimeError | null = null;
  public lastRuntimeWarning: IRuntimeWarning | null = null;
  public pendingInput: IPendingInputRequest | null = null;

  public traceEnabled: boolean = false;
  public traceLog: ITraceEntry[] = [];
  public traceTruncated: boolean = false;

  private recordedStepCount: number = 0;
  private callDepth: number = 0;
  private history: IHistoryFrame[] = [];
  private currentUndoBuffer: IMemoryUndoEntry[] = [];
  private currentWrittenSet: Set<number> = new Set();
  private currentMemoryWrites: ITraceMemoryWrite[] = [];
  private currentWrittenSegmentRegs: Set<RegisterName> = new Set();
  private wordWrittenAddresses: Set<number> = new Set();
  private lineHitCounts: Map<number, number> = new Map();
  private inputQueue: string[] = [];

  constructor() {
    this.cpu = new CPU();
  }

  public get canStepBack(): boolean {
    return this.history.length > 0;
  }

  public get nextInstruction(): IParsedInstruction | null {
    if (!this.program || this.cpu.halted) return null;
    return this.program.instructions[this.cpu.instructionIndex] ?? null;
  }

  /**
   * Queues keyboard input (character or line) for INT 21H / INT 16H and clears pendingInput.
   */
  public provideInput(value: string): void {
    this.inputQueue.push(value);
    this.pendingInput = null;
  }

  /**
   * Enables or disables step-by-step execution trace recording (for homework Word reports).
   * When turned on with an empty log, records the current CPU state as Step 0 (Initial).
   */
  public setTraceEnabled(enabled: boolean): void {
    this.traceEnabled = enabled;
    if (enabled && this.traceLog.length === 0 && this.program) {
      this.recordInitialTraceSnapshot();
    }
  }

  /**
   * Clears the recorded trace log. If tracing is active, seeds a fresh Step 0 snapshot.
   */
  public clearTrace(): void {
    this.traceLog = [];
    this.recordedStepCount = 0;
    this.traceTruncated = false;
    this.lineHitCounts.clear();
    if (this.traceEnabled && this.program) {
      this.recordInitialTraceSnapshot();
    }
  }

  private recordInitialTraceSnapshot(): void {
    const snap = this.cpu.getSnapshot();
    this.traceLog = [
      {
        step: 0,
        isInitial: true,
        line: null,
        cs: snap.registers.CS,
        ip: snap.registers.IP,
        instruction: '',
        lineHitCount: 0,
        registers: snap.registers,
        changedRegisters: [],
        changedFlags: [],
        memoryWrites: [],
      },
    ];
    this.recordedStepCount = 0;
    this.traceTruncated = false;
    this.lineHitCounts.clear();
  }

  /**
   * Compiles assembly source and loads code/data into the 8086 CPU & 1MB RAM.
   */
  public load(
    sourceCode: string,
    options?: IAssembleOptions
  ): {
    ok: boolean;
    program: IAssembledProgram;
    errors: IParseError[];
    warnings: IParseWarning[];
  } {
    const effectiveStrict = options?.strictMode ?? this.strictMode;
    const assembled = assemble(sourceCode, { strictMode: effectiveStrict });
    if (assembled.errors.length > 0) {
      return {
        ok: false,
        program: assembled,
        errors: assembled.errors,
        warnings: assembled.warnings,
      };
    }

    this.program = assembled;
    this.resetLoadedProgram();
    return {
      ok: true,
      program: assembled,
      errors: [],
      warnings: assembled.warnings,
    };
  }

  /**
   * Resets CPU, memory, and execution state back to the beginning of the loaded program
   * (or clean defaults if no program is loaded).
   */
  public resetLoadedProgram(): void {
    this.history = [];
    this.consoleOutput = '';
    this.callDepth = 0;
    this.lastRuntimeError = null;
    this.lastRuntimeWarning = null;
    this.pendingInput = null;
    this.inputQueue = [];
    this.wordWrittenAddresses.clear();

    if (!this.program) {
      this.cpu.reset();
      return;
    }

    this.cpu.reset(this.program.initialConfig, true);

    // 1. Preload representative instruction bytes into CS:offset so CS:IP is visible in Memory Viewer
    for (const inst of this.program.instructions) {
      const codePhys = calculatePhysicalAddress(
        this.cpu.registers.CS,
        inst.offset
      );
      this.cpu.memory.writeBlock(codePhys, encodeRepresentativeBytes(inst));
    }

    // 2. Preload .data bytes into DS:0000
    if (this.program.dataBytes.length > 0) {
      const dsPhys = calculatePhysicalAddress(this.cpu.registers.DS, 0);
      this.cpu.memory.writeBlock(dsPhys, this.program.dataBytes);
    }

    // 3. Preload inline code-segment data items (for ORG 100h COM programs)
    for (const item of this.program.inlineCodeData) {
      const phys = calculatePhysicalAddress(this.cpu.registers.CS, item.offset);
      this.cpu.memory.writeBlock(phys, item.bytes);
    }

    // 4. Seed 16-bit DW symbol addresses into wordWrittenAddresses
    for (const sym of Object.values(this.program.symbols)) {
      if (sym.kind === 'data' && sym.dataSize === 16) {
        const seg = sym.inCodeSegment
          ? this.cpu.registers.CS
          : this.cpu.registers.DS;
        this.wordWrittenAddresses.add(
          calculatePhysicalAddress(seg, sym.offset)
        );
      }
    }

    this.cpu.instructionIndex = this.program.entryIndex;
    const entryInst = this.program.instructions[this.program.entryIndex];
    this.cpu.registers.IP = entryInst
      ? entryInst.offset
      : this.program.initialConfig.IP;

    if (this.program.instructions.length === 0) {
      this.cpu.halted = true;
    }

    this.traceLog = [];
    this.recordedStepCount = 0;
    this.traceTruncated = false;
    this.lineHitCounts.clear();
    if (this.traceEnabled) {
      this.recordInitialTraceSnapshot();
    }
  }

  /**
   * Undoes the last executed instruction (Step Back).
   */
  public stepBack(): IStepResult | null {
    this.pendingInput = null;
    const frame = this.history.pop();
    if (!frame) return null;

    // Replay memory writes in reverse order
    for (let i = frame.memoryUndo.length - 1; i >= 0; i--) {
      const entry = frame.memoryUndo[i];
      this.cpu.memory.writeByte(entry.address, entry.previousValue);
    }

    this.cpu.restoreSnapshot(frame.snapshot);
    this.callDepth = frame.callDepth;
    this.consoleOutput = frame.consoleOutput;
    this.lastRuntimeError = null;
    this.lastRuntimeWarning = null;

    if (frame.tracePushed && this.traceLog.length > 0) {
      const popped = this.traceLog[this.traceLog.length - 1];
      if (!popped.isInitial) {
        this.traceLog.pop();
        this.recordedStepCount = Math.max(0, this.recordedStepCount - 1);
        if (this.recordedStepCount < MAX_TRACE_ENTRIES) {
          this.traceTruncated = false;
        }
        if (frame.traceLine !== null) {
          const prevCount = this.lineHitCounts.get(frame.traceLine) ?? 1;
          if (prevCount <= 1) {
            this.lineHitCounts.delete(frame.traceLine);
          } else {
            this.lineHitCounts.set(frame.traceLine, prevCount - 1);
          }
        }
      }
    }

    const next = this.nextInstruction;
    return {
      executed: true,
      halted: this.cpu.halted,
      executedLine: null,
      nextLine: next ? next.line : null,
      changedRegisters: [],
      changedFlags: [],
      writtenAddresses: frame.memoryUndo.map((m) => m.address),
      consoleOutput: this.consoleOutput,
      error: null,
      warning: null,
      waitingForInput: null,
    };
  }

  /**
   * Executes a single instruction at CS:IP (Single Step / Step Into).
   */
  public step(): IStepResult {
    if (!this.program) {
      return {
        executed: false,
        halted: true,
        executedLine: null,
        nextLine: null,
        changedRegisters: [],
        changedFlags: [],
        writtenAddresses: [],
        consoleOutput: this.consoleOutput,
        error: null,
      };
    }

    if (this.cpu.halted) {
      return {
        executed: false,
        halted: true,
        executedLine: null,
        nextLine: null,
        changedRegisters: [],
        changedFlags: [],
        writtenAddresses: [],
        consoleOutput: this.consoleOutput,
        error: this.lastRuntimeError,
      };
    }

    const inst = this.program.instructions[this.cpu.instructionIndex];
    if (!inst) {
      this.cpu.halted = true;
      return {
        executed: false,
        halted: true,
        executedLine: null,
        nextLine: null,
        changedRegisters: [],
        changedFlags: [],
        writtenAddresses: [],
        consoleOutput: this.consoleOutput,
        error: null,
      };
    }

    // Save pre-step state for Step Back and diff highlighting
    const beforeSnapshot = this.cpu.getSnapshot();
    const beforeCallDepth = this.callDepth;
    const beforeConsole = this.consoleOutput;
    this.currentUndoBuffer = [];
    this.currentWrittenSet = new Set();
    this.currentMemoryWrites = [];
    this.currentWrittenSegmentRegs = new Set();
    this.lastRuntimeWarning = null;
    this.pendingInput = null;

    try {
      const jumped = this.executeInstruction(inst);
      this.cpu.cycleCount += 1;

      if (!jumped && !this.cpu.halted) {
        this.cpu.instructionIndex += 1;
        const nextInst = this.program.instructions[this.cpu.instructionIndex];
        if (nextInst) {
          this.cpu.registers.IP = nextInst.offset;
        } else {
          this.cpu.registers.IP = (inst.offset + inst.byteLength) & 0xffff;
          this.cpu.halted = true;
        }
      }

      const afterSnapshot = this.cpu.getSnapshot();
      const { changedRegisters, changedFlags } = this.diffSnapshots(
        beforeSnapshot,
        afterSnapshot
      );

      // Record execution trace entry when Trace mode is active (O(1) step counter)
      let tracePushed = false;
      if (this.traceEnabled) {
        if (this.traceLog.length === 0) {
          this.traceLog.push({
            step: 0,
            isInitial: true,
            line: null,
            cs: beforeSnapshot.registers.CS,
            ip: beforeSnapshot.registers.IP,
            instruction: '',
            lineHitCount: 0,
            registers: beforeSnapshot.registers,
            changedRegisters: [],
            changedFlags: [],
            memoryWrites: [],
          });
          this.recordedStepCount = 0;
        }

        if (this.recordedStepCount < MAX_TRACE_ENTRIES) {
          const hitCount = (this.lineHitCounts.get(inst.line) ?? 0) + 1;
          this.lineHitCounts.set(inst.line, hitCount);
          this.recordedStepCount += 1;

          const cleanInst = stripComment(inst.source).trim();
          this.traceLog.push({
            step: this.recordedStepCount,
            isInitial: false,
            line: inst.line,
            cs: beforeSnapshot.registers.CS,
            ip: inst.offset,
            instruction: cleanInst,
            lineHitCount: hitCount,
            registers: afterSnapshot.registers,
            changedRegisters: [...changedRegisters],
            changedFlags: [...changedFlags],
            memoryWrites: [...this.currentMemoryWrites],
          });
          tracePushed = true;
        } else {
          this.traceTruncated = true;
        }
      }

      // Push undo frame (amortized O(1) trimming when way over capacity)
      this.history.push({
        snapshot: beforeSnapshot,
        callDepth: beforeCallDepth,
        consoleOutput: beforeConsole,
        memoryUndo: this.currentUndoBuffer,
        tracePushed,
        traceLine: tracePushed ? inst.line : null,
      });
      if (this.history.length > MAX_HISTORY_FRAMES + 250) {
        this.history.splice(0, this.history.length - MAX_HISTORY_FRAMES);
      }

      const nextInst = this.nextInstruction;
      return {
        executed: true,
        halted: this.cpu.halted,
        executedLine: inst.line,
        nextLine: nextInst ? nextInst.line : null,
        changedRegisters,
        changedFlags,
        writtenAddresses: Array.from(this.currentWrittenSet),
        consoleOutput: this.consoleOutput,
        error: null,
        warning: this.lastRuntimeWarning,
        waitingForInput: null,
      };
    } catch (err) {
      // Roll back partial writes
      for (let i = this.currentUndoBuffer.length - 1; i >= 0; i--) {
        const entry = this.currentUndoBuffer[i];
        this.cpu.memory.writeByte(entry.address, entry.previousValue);
      }
      this.cpu.restoreSnapshot(beforeSnapshot);
      this.callDepth = beforeCallDepth;
      this.consoleOutput = beforeConsole;

      // Handle interactive keyboard input pause (INT 21H AH=01H/07H/08H/0AH, INT 16H AH=00H)
      if (err instanceof WaitForInputSignal) {
        this.pendingInput = err.request;
        return {
          executed: false,
          halted: false,
          executedLine: null,
          nextLine: inst.line,
          changedRegisters: [],
          changedFlags: [],
          writtenAddresses: [],
          consoleOutput: this.consoleOutput,
          error: null,
          warning: null,
          waitingForInput: err.request,
        };
      }

      this.cpu.halted = true;

      const runtimeErr: IRuntimeError =
        err instanceof ExecutionError
          ? {
              line: inst.line,
              code: err.code,
              messageTr: `Satır ${inst.line}: ${err.messageTr}`,
              messageEn: `Line ${inst.line}: ${err.messageEn}`,
            }
          : {
              line: inst.line,
              code: 'RUNTIME_ERROR',
              messageTr: `Satır ${inst.line}: Çalışma zamanı hatası (${String(err)})`,
              messageEn: `Line ${inst.line}: Runtime error (${String(err)})`,
            };

      this.lastRuntimeError = runtimeErr;
      this.cpu.lastError = runtimeErr.messageEn;

      return {
        executed: false,
        halted: true,
        executedLine: inst.line,
        nextLine: null,
        changedRegisters: [],
        changedFlags: [],
        writtenAddresses: [],
        consoleOutput: this.consoleOutput,
        error: runtimeErr,
      };
    }
  }

  /**
   * Runs the program continuously until halted, waiting for input, error, or maxSteps limit reached.
   */
  public run(maxSteps: number = 50000): IStepResult {
    let steps = 0;
    let lastResult: IStepResult = {
      executed: false,
      halted: this.cpu.halted,
      executedLine: null,
      nextLine: this.nextInstruction?.line ?? null,
      changedRegisters: [],
      changedFlags: [],
      writtenAddresses: [],
      consoleOutput: this.consoleOutput,
      error: null,
    };

    const allChangedRegs = new Set<RegisterName>();
    const allChangedFlags = new Set<FlagName>();
    const allWrittenAddrs = new Set<number>();

    while (!this.cpu.halted && steps < maxSteps) {
      lastResult = this.step();
      if (lastResult.waitingForInput) {
        return {
          ...lastResult,
          changedRegisters: Array.from(allChangedRegs),
          changedFlags: Array.from(allChangedFlags),
          writtenAddresses: Array.from(allWrittenAddrs),
        };
      }
      steps++;
      lastResult.changedRegisters.forEach((r) => allChangedRegs.add(r));
      lastResult.changedFlags.forEach((f) => allChangedFlags.add(f));
      lastResult.writtenAddresses.forEach((a) => allWrittenAddrs.add(a));
      if (lastResult.error) {
        return lastResult;
      }
    }

    if (!this.cpu.halted && steps >= maxSteps) {
      const next = this.nextInstruction;
      const guardErr: IRuntimeError = {
        line: next?.line ?? 0,
        code: 'INFINITE_LOOP_GUARD',
        messageTr: `Sonsuz döngü koruması: ${maxSteps} adımdan sonra yürütme durduruldu.`,
        messageEn: `Infinite loop guard: execution paused after ${maxSteps} steps.`,
      };
      this.lastRuntimeError = guardErr;
      return {
        ...lastResult,
        changedRegisters: Array.from(allChangedRegs),
        changedFlags: Array.from(allChangedFlags),
        writtenAddresses: Array.from(allWrittenAddrs),
        error: guardErr,
      };
    }

    return {
      ...lastResult,
      changedRegisters: Array.from(allChangedRegs),
      changedFlags: Array.from(allChangedFlags),
      writtenAddresses: Array.from(allWrittenAddrs),
    };
  }

  // -------------------------------------------------------------------------
  // Tracked Memory Access Helpers
  // -------------------------------------------------------------------------

  private recordTraceMemoryWrite(write: ITraceMemoryWrite): void {
    if (this.currentMemoryWrites.length < MAX_TRACE_MEM_WRITES_PER_STEP) {
      this.currentMemoryWrites.push(write);
    } else {
      const last =
        this.currentMemoryWrites[this.currentMemoryWrites.length - 1];
      last.repeatCount = (last.repeatCount ?? 1) + 1;
    }
  }

  private writeByteTracked(physAddr: number, value: number): void {
    const addr = physAddr & 0xfffff;
    const prev = this.cpu.memory.readByte(addr);
    this.currentUndoBuffer.push({ address: addr, previousValue: prev });
    this.cpu.memory.writeByte(addr, value);
    this.currentWrittenSet.add(addr);
  }

  private writeWordSegOffTracked(
    segment: number,
    offset: number,
    value: number
  ): void {
    const lowPhys = calculatePhysicalAddress(segment, offset);
    const highPhys = calculatePhysicalAddress(segment, (offset + 1) & 0xffff);
    this.writeByteTracked(lowPhys, value & 0xff);
    this.writeByteTracked(highPhys, (value >> 8) & 0xff);
  }

  private push16Tracked(value: number): void {
    this.cpu.registers.SP = (this.cpu.registers.SP - 2) & 0xffff;
    const seg = this.cpu.registers.SS;
    const off = this.cpu.registers.SP;
    this.writeWordSegOffTracked(seg, off, value);
    this.recordTraceMemoryWrite({
      segmentReg: 'SS',
      segment: seg,
      offset: off,
      physicalAddress: calculatePhysicalAddress(seg, off),
      size: 16,
      value: value & 0xffff,
    });
  }

  private pop16Tracked(): number {
    const val = this.cpu.memory.readWordSegOff(
      this.cpu.registers.SS,
      this.cpu.registers.SP
    );
    this.cpu.registers.SP = (this.cpu.registers.SP + 2) & 0xffff;
    return val;
  }

  // -------------------------------------------------------------------------
  // Effective Address & Operand Read/Write Resolution
  // -------------------------------------------------------------------------

  private resolveMemoryAddress(op: IMemoryOperand): {
    segmentReg: SegmentRegister;
    segmentVal: number;
    offset: number;
    physicalAddress: number;
  } {
    const regs = this.cpu.registers;
    const segmentReg: SegmentRegister =
      op.segmentOverride ?? this.cpu.getDefaultSegment(op.base);
    const segmentVal = regs.get16(segmentReg);

    let offset = op.displacement;
    if (op.base) offset += regs.get16(op.base);
    if (op.index) offset += regs.get16(op.index);
    offset &= 0xffff;

    return {
      segmentReg,
      segmentVal,
      offset,
      physicalAddress: calculatePhysicalAddress(segmentVal, offset),
    };
  }

  private assertNotIpReg(op: Operand): void {
    if (op.kind === 'register' && op.register === 'IP') {
      throw new ExecutionError(
        'ILLEGAL_IP_OPERAND',
        "'IP' (Komut İşaretçisi) doğrudan operand olarak kullanılamaz; JMP, CALL veya RET kullanın.",
        "'IP' (Instruction Pointer) cannot be accessed directly as an operand; use JMP, CALL, or RET."
      );
    }
  }

  private resolveBinarySize(dst: Operand, src: Operand): DataSize {
    this.assertNotIpReg(dst);
    this.assertNotIpReg(src);

    if (dst.kind === 'register' && src.kind === 'register') {
      if (dst.size !== src.size) {
        throw new ExecutionError(
          'OPERAND_SIZE_MISMATCH',
          `Yazmaç boyutları uyuşmuyor: ${dst.register} (${dst.size}-bit) ve ${src.register} (${src.size}-bit).`,
          `Register size mismatch: ${dst.register} (${dst.size}-bit) and ${src.register} (${src.size}-bit).`
        );
      }
      return dst.size;
    }

    if (dst.kind === 'memory' && src.kind === 'memory') {
      throw new ExecutionError(
        'MEMORY_TO_MEMORY',
        'Intel 8086 bellekten belleğe doğrudan işlemi desteklemez.',
        'Intel 8086 does not allow direct memory-to-memory operations.'
      );
    }

    if (dst.kind === 'register') return dst.size;
    if (src.kind === 'register') return src.size;

    // Memory + Immediate (e.g. MOV [0058H], 04H vs MOV [5000H], 1010H)
    if (dst.kind === 'memory') {
      if (dst.sizeHint) return dst.sizeHint;
      if (src.kind === 'immediate') {
        return src.value > 0xff || src.value < -128 ? 16 : 8;
      }
      return 8;
    }

    return 16;
  }

  private resolveUnarySize(op: Operand, forceWord: boolean = false): DataSize {
    this.assertNotIpReg(op);
    if (forceWord) {
      if (op.kind === 'register' && op.size !== 16) {
        throw new ExecutionError(
          'WORD_OPERAND_REQUIRED',
          `Bu komut 16-bit operand gerektirir ('${op.register}' 8-bit).`,
          `This instruction requires a 16-bit operand ('${op.register}' is 8-bit).`
        );
      }
      return 16;
    }
    if (op.kind === 'register') return op.size;
    if (op.kind === 'memory') {
      if (op.sizeHint) return op.sizeHint;
      const addr = this.resolveMemoryAddress(op);
      if (this.wordWrittenAddresses.has(addr.physicalAddress)) {
        return 16;
      }
      return 8;
    }
    throw new ExecutionError(
      'INVALID_UNARY_OPERAND',
      'Bu komut sabit (immediate) operand ile kullanılamaz.',
      'This instruction cannot take an immediate operand.'
    );
  }

  private readOperand(op: Operand, size: DataSize): number {
    this.assertNotIpReg(op);
    if (op.kind === 'immediate') {
      return op.value & getBitMask(size);
    }
    if (op.kind === 'register') {
      return this.cpu.registers.get(op.register) & getBitMask(size);
    }
    if (op.kind === 'memory') {
      const addr = this.resolveMemoryAddress(op);
      return size === 8
        ? this.cpu.memory.readByteSegOff(addr.segmentVal, addr.offset)
        : this.cpu.memory.readWordSegOff(addr.segmentVal, addr.offset);
    }
    throw new ExecutionError(
      'UNEXPECTED_LABEL',
      `Etiket '${op.name}' veri operandı olarak okunamaz.`,
      `Label '${op.name}' cannot be read as a data operand.`
    );
  }

  private writeOperand(op: Operand, value: number, size: DataSize): void {
    this.assertNotIpReg(op);
    if (op.kind === 'immediate' || op.kind === 'label') {
      throw new ExecutionError(
        'INVALID_DESTINATION',
        'Hedef operand sabit değer veya etiket olamaz.',
        'Destination operand cannot be an immediate value or label.'
      );
    }
    if (op.kind === 'register') {
      this.cpu.registers.set(op.register, value & getBitMask(size));
      if (SEGMENT_REGS.has(op.register)) {
        this.currentWrittenSegmentRegs.add(op.register);
      }
      return;
    }
    const addr = this.resolveMemoryAddress(op);
    if (size === 8) {
      const byteVal = value & 0xff;
      this.writeByteTracked(addr.physicalAddress, byteVal);
      this.wordWrittenAddresses.delete(addr.physicalAddress);
      this.recordTraceMemoryWrite({
        segmentReg: addr.segmentReg,
        segment: addr.segmentVal,
        offset: addr.offset,
        physicalAddress: addr.physicalAddress,
        size: 8,
        value: byteVal,
      });
    } else {
      const wordVal = value & 0xffff;
      this.writeWordSegOffTracked(addr.segmentVal, addr.offset, wordVal);
      this.wordWrittenAddresses.add(addr.physicalAddress);
      this.recordTraceMemoryWrite({
        segmentReg: addr.segmentReg,
        segment: addr.segmentVal,
        offset: addr.offset,
        physicalAddress: addr.physicalAddress,
        size: 16,
        value: wordVal,
      });
    }
  }

  private applyFlags(nextFlags: IFlags): void {
    const f = this.cpu.registers.flags;
    f.CF = nextFlags.CF;
    f.PF = nextFlags.PF;
    f.AF = nextFlags.AF;
    f.ZF = nextFlags.ZF;
    f.SF = nextFlags.SF;
    f.OF = nextFlags.OF;
    f.TF = nextFlags.TF;
    f.IF = nextFlags.IF;
    f.DF = nextFlags.DF;
  }

  private assertOperandCount(inst: IParsedInstruction, expected: number): void {
    if (inst.operands.length !== expected) {
      throw new ExecutionError(
        'OPERAND_COUNT',
        `'${inst.mnemonic}' komutu ${expected} operand bekler (${inst.operands.length} verildi).`,
        `Instruction '${inst.mnemonic}' expects ${expected} operand(s) (got ${inst.operands.length}).`
      );
    }
  }

  private assertNotSegmentReg(op: Operand, mnemonic: string): void {
    if (op.kind === 'register' && SEGMENT_REGS.has(op.register)) {
      throw new ExecutionError(
        'ILLEGAL_SEGMENT_OP',
        `Segment yazmacı '${op.register}' ile '${mnemonic}' komutu kullanılamaz.`,
        `Segment register '${op.register}' cannot be used with '${mnemonic}'.`
      );
    }
  }

  private jumpToOperand(target: Operand): boolean {
    this.assertNotIpReg(target);
    if (!this.program) return false;
    let targetIndex: number | undefined;

    if (target.kind === 'label') {
      targetIndex = this.program.labelToIndex[target.name];
    } else if (target.kind === 'register') {
      const targetOffset = this.cpu.registers.get(target.register);
      targetIndex = this.program.offsetToIndex[targetOffset];
    } else if (target.kind === 'immediate') {
      targetIndex = this.program.offsetToIndex[target.value & 0xffff];
    } else if (target.kind === 'memory') {
      // Indirect memory jump/call: e.g. JMP [SI], JMP TABLE[BX], CALL [BX]
      const addr = this.resolveMemoryAddress(target);
      const targetOffset = this.cpu.memory.readWordSegOff(
        addr.segmentVal,
        addr.offset
      );
      targetIndex = this.program.offsetToIndex[targetOffset];
    }

    if (targetIndex === undefined) {
      throw new ExecutionError(
        'INVALID_JUMP_TARGET',
        'Atlama hedef adresi geçerli bir komuta karşılık gelmiyor.',
        'Jump target address does not correspond to a valid instruction.'
      );
    }

    this.cpu.instructionIndex = targetIndex;
    const targetInst = this.program.instructions[targetIndex];
    if (targetInst) {
      this.cpu.registers.IP = targetInst.offset;
    } else {
      // Jumped to a trailing label at end of program (e.g. QUIT:)
      this.cpu.halted = true;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Main Instruction Dispatcher
  // -------------------------------------------------------------------------

  /**
   * Executes a single parsed instruction.
   * Returns `true` if IP / instructionIndex was explicitly altered by a branch/call/ret.
   */
  private executeInstruction(inst: IParsedInstruction): boolean {
    const m = inst.mnemonic;
    const regs = this.cpu.registers;

    switch (m) {
      // ---------------- Data Transfer ----------------
      case 'MOV': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;

        // Intel 8086 rules taught in class slides:
        // 1. Cannot MOV directly into CS
        if (dst.kind === 'register' && dst.register === 'CS') {
          throw new ExecutionError(
            'ILLEGAL_CS_MOV',
            'CS yazmacına MOV ile doğrudan değer atanamaz.',
            'Cannot move directly into the CS register.'
          );
        }
        // 2. Cannot MOV immediate directly into a segment register (e.g. MOV DS, 0123H -> illegal!)
        if (
          dst.kind === 'register' &&
          SEGMENT_REGS.has(dst.register) &&
          src.kind === 'immediate'
        ) {
          throw new ExecutionError(
            'ILLEGAL_SEG_IMM',
            `Segment yazmacına (${dst.register}) doğrudan sabit sayı yüklenemez; önce AX gibi bir genel yazmaca aktarın.`,
            `Cannot load an immediate value directly into segment register ${dst.register}; move via AX first.`
          );
        }
        // 3. Cannot MOV segment-to-segment directly
        if (
          dst.kind === 'register' &&
          SEGMENT_REGS.has(dst.register) &&
          src.kind === 'register' &&
          SEGMENT_REGS.has(src.register)
        ) {
          throw new ExecutionError(
            'ILLEGAL_SEG_TO_SEG',
            'Bir segment yazmacından başka bir segment yazmacına doğrudan MOV yapılamaz.',
            'Cannot MOV directly from one segment register to another.'
          );
        }

        const size = this.resolveBinarySize(dst, src);
        const value = this.readOperand(src, size);
        this.writeOperand(dst, value, size);
        // MOV never modifies flags!
        return false;
      }

      case 'XCHG': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        this.assertNotSegmentReg(src, m);
        if (dst.kind === 'immediate' || src.kind === 'immediate') {
          throw new ExecutionError(
            'INVALID_XCHG',
            'XCHG komutu sabit değer ile kullanılamaz.',
            'XCHG cannot be used with immediate operands.'
          );
        }
        const size = this.resolveBinarySize(dst, src);
        const a = this.readOperand(dst, size);
        const b = this.readOperand(src, size);
        this.writeOperand(dst, b, size);
        this.writeOperand(src, a, size);
        return false;
      }

      case 'LEA': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotIpReg(dst);
        if (
          dst.kind !== 'register' ||
          dst.size !== 16 ||
          SEGMENT_REGS.has(dst.register)
        ) {
          throw new ExecutionError(
            'INVALID_LEA_DEST',
            'LEA hedefi 16-bit genel/indis yazmacı olmalıdır.',
            'LEA destination must be a 16-bit general or index register.'
          );
        }
        if (src.kind !== 'memory') {
          throw new ExecutionError(
            'INVALID_LEA_SRC',
            'LEA kaynağı bir bellek operandı olmalıdır.',
            'LEA source must be a memory operand.'
          );
        }
        const addr = this.resolveMemoryAddress(src);
        regs.set(dst.register, addr.offset);
        return false;
      }

      case 'LDS':
      case 'LES': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotIpReg(dst);
        if (
          dst.kind !== 'register' ||
          dst.size !== 16 ||
          SEGMENT_REGS.has(dst.register)
        ) {
          throw new ExecutionError(
            'INVALID_POINTER_DEST',
            `${m} hedefi 16-bit genel/indis yazmacı olmalıdır.`,
            `${m} destination must be a 16-bit general or index register.`
          );
        }
        if (src.kind !== 'memory') {
          throw new ExecutionError(
            'INVALID_POINTER_SRC',
            `${m} kaynağı 32-bit bellek operandı olmalıdır.`,
            `${m} source must be a 32-bit memory operand.`
          );
        }
        const addr = this.resolveMemoryAddress(src);
        const newOffset = this.cpu.memory.readWordSegOff(
          addr.segmentVal,
          addr.offset
        );
        const newSegment = this.cpu.memory.readWordSegOff(
          addr.segmentVal,
          (addr.offset + 2) & 0xffff
        );
        regs.set(dst.register, newOffset);
        if (m === 'LDS') {
          regs.DS = newSegment;
          this.currentWrittenSegmentRegs.add('DS');
        } else {
          regs.ES = newSegment;
          this.currentWrittenSegmentRegs.add('ES');
        }
        return false;
      }

      case 'XLAT':
      case 'XLATB': {
        this.assertOperandCount(inst, 0);
        const tableOffset = (regs.BX + regs.AL) & 0xffff;
        regs.AL = this.cpu.memory.readByteSegOff(regs.DS, tableOffset);
        return false;
      }

      // ---------------- Arithmetic ----------------
      case 'ADD':
      case 'ADC': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        this.assertNotSegmentReg(src, m);
        const size = this.resolveBinarySize(dst, src);
        const a = this.readOperand(dst, size);
        const b = this.readOperand(src, size);
        const res = aluAdd(a, b, size, regs.flags, m === 'ADC');
        this.writeOperand(dst, res.result, size);
        this.applyFlags(res.flags);
        return false;
      }

      case 'SUB':
      case 'SBB': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        this.assertNotSegmentReg(src, m);
        const size = this.resolveBinarySize(dst, src);
        const a = this.readOperand(dst, size);
        const b = this.readOperand(src, size);
        const res = aluSub(a, b, size, regs.flags, m === 'SBB');
        this.writeOperand(dst, res.result, size);
        this.applyFlags(res.flags);
        return false;
      }

      case 'CMP': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        this.assertNotSegmentReg(src, m);
        if (dst.kind === 'immediate' || dst.kind === 'label') {
          throw new ExecutionError(
            'INVALID_DESTINATION',
            'CMP komutunda birinci operand sabit değer veya etiket olamaz.',
            'First operand of CMP cannot be an immediate value or label.'
          );
        }
        const size = this.resolveBinarySize(dst, src);
        const a = this.readOperand(dst, size);
        const b = this.readOperand(src, size);
        const res = aluSub(a, b, size, regs.flags, false);
        // CMP only updates flags, destination is NOT modified!
        this.applyFlags(res.flags);
        return false;
      }

      case 'INC':
      case 'DEC': {
        this.assertOperandCount(inst, 1);
        const [dst] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        const size = this.resolveUnarySize(dst);
        const a = this.readOperand(dst, size);
        const res =
          m === 'INC'
            ? aluInc(a, size, regs.flags)
            : aluDec(a, size, regs.flags);
        this.writeOperand(dst, res.result, size);
        this.applyFlags(res.flags);
        return false;
      }

      case 'NEG': {
        this.assertOperandCount(inst, 1);
        const [dst] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        const size = this.resolveUnarySize(dst);
        const a = this.readOperand(dst, size);
        const res = aluNeg(a, size, regs.flags);
        this.writeOperand(dst, res.result, size);
        this.applyFlags(res.flags);
        return false;
      }

      case 'MUL':
      case 'IMUL': {
        this.assertOperandCount(inst, 1);
        const [src] = inst.operands;
        this.assertNotSegmentReg(src, m);
        if (src.kind === 'immediate') {
          throw new ExecutionError(
            'ILLEGAL_MUL_IMM',
            `${m} komutu doğrudan sabit sayı ile kullanılamaz; yazmaç veya bellek kullanın.`,
            `${m} does not accept an immediate operand; use a register or memory location.`
          );
        }
        const size = this.resolveUnarySize(src);
        const multiplier = this.readOperand(src, size);
        const acc = size === 8 ? regs.AL : regs.AX;
        const res =
          m === 'MUL'
            ? aluMul(acc, multiplier, size, regs.flags)
            : aluImul(acc, multiplier, size, regs.flags);

        if (size === 8) {
          regs.AX = res.full;
        } else {
          regs.AX = res.low;
          regs.DX = res.high;
        }
        this.applyFlags(res.flags);
        return false;
      }

      case 'DIV':
      case 'IDIV': {
        this.assertOperandCount(inst, 1);
        const [src] = inst.operands;
        this.assertNotSegmentReg(src, m);
        if (src.kind === 'immediate') {
          throw new ExecutionError(
            'ILLEGAL_DIV_IMM',
            `${m} komutu doğrudan sabit sayı ile kullanılamaz; yazmaç veya bellek kullanın.`,
            `${m} does not accept an immediate operand; use a register or memory location.`
          );
        }
        const size = this.resolveUnarySize(src);
        const divisor = this.readOperand(src, size);
        try {
          if (size === 8) {
            const res =
              m === 'DIV'
                ? aluDiv(regs.AL, regs.AH, divisor, 8)
                : aluIdiv(regs.AL, regs.AH, divisor, 8);
            regs.AL = res.quotient;
            regs.AH = res.remainder;
          } else {
            const res =
              m === 'DIV'
                ? aluDiv(regs.AX, regs.DX, divisor, 16)
                : aluIdiv(regs.AX, regs.DX, divisor, 16);
            regs.AX = res.quotient;
            regs.DX = res.remainder;
          }
        } catch (divErr) {
          const code =
            divErr instanceof Error ? divErr.message : 'DIVIDE_ERROR';
          if (code === 'DIVIDE_BY_ZERO') {
            throw new ExecutionError(
              'DIVIDE_BY_ZERO',
              'Sıfıra bölme hatası (INT 0)!',
              'Division by zero error (INT 0)!'
            );
          }
          throw new ExecutionError(
            'DIVIDE_OVERFLOW',
            'Bölme taşması (Divide Overflow - INT 0): Bölüm hedef yazmaca sığmıyor.',
            'Divide overflow error (INT 0): Quotient does not fit in destination register.'
          );
        }
        return false;
      }

      case 'CBW': {
        this.assertOperandCount(inst, 0);
        regs.AH = (regs.AL & 0x80) !== 0 ? 0xff : 0x00;
        return false;
      }

      case 'CWD': {
        this.assertOperandCount(inst, 0);
        regs.DX = (regs.AX & 0x8000) !== 0 ? 0xffff : 0x0000;
        return false;
      }

      case 'DAA': {
        this.assertOperandCount(inst, 0);
        const res = aluDaa(regs.AL, regs.flags);
        regs.AL = res.result;
        this.applyFlags(res.flags);
        return false;
      }

      case 'DAS': {
        this.assertOperandCount(inst, 0);
        const res = aluDas(regs.AL, regs.flags);
        regs.AL = res.result;
        this.applyFlags(res.flags);
        return false;
      }

      case 'AAA': {
        this.assertOperandCount(inst, 0);
        if ((regs.AL & 0x0f) > 9 || regs.flags.AF) {
          regs.AL = (regs.AL + 6) & 0xff;
          regs.AH = (regs.AH + 1) & 0xff;
          regs.setFlag('AF', true);
          regs.setFlag('CF', true);
        } else {
          regs.setFlag('AF', false);
          regs.setFlag('CF', false);
        }
        regs.AL = regs.AL & 0x0f;
        return false;
      }

      case 'AAS': {
        this.assertOperandCount(inst, 0);
        if ((regs.AL & 0x0f) > 9 || regs.flags.AF) {
          regs.AL = (regs.AL - 6) & 0xff;
          regs.AH = (regs.AH - 1) & 0xff;
          regs.setFlag('AF', true);
          regs.setFlag('CF', true);
        } else {
          regs.setFlag('AF', false);
          regs.setFlag('CF', false);
        }
        regs.AL = regs.AL & 0x0f;
        return false;
      }

      case 'AAM': {
        this.assertOperandCount(inst, 0);
        const al = regs.AL;
        regs.AH = Math.floor(al / 10) & 0xff;
        regs.AL = al % 10;
        regs.setFlag('SF', computeSignFlag(regs.AL, 8));
        regs.setFlag('ZF', computeZeroFlag(regs.AL, 8));
        regs.setFlag('PF', computeParityFlag(regs.AL));
        return false;
      }

      case 'AAD': {
        this.assertOperandCount(inst, 0);
        const al = (regs.AH * 10 + regs.AL) & 0xff;
        regs.AL = al;
        regs.AH = 0;
        regs.setFlag('SF', computeSignFlag(al, 8));
        regs.setFlag('ZF', computeZeroFlag(al, 8));
        regs.setFlag('PF', computeParityFlag(al));
        return false;
      }

      // ---------------- Logic, Shift & Rotate ----------------
      case 'AND':
      case 'OR':
      case 'XOR': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        this.assertNotSegmentReg(src, m);
        const size = this.resolveBinarySize(dst, src);
        const a = this.readOperand(dst, size);
        const b = this.readOperand(src, size);
        const res = aluLogic(m, a, b, size, regs.flags);
        this.writeOperand(dst, res.result, size);
        this.applyFlags(res.flags);
        return false;
      }

      case 'TEST': {
        this.assertOperandCount(inst, 2);
        const [dst, src] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        this.assertNotSegmentReg(src, m);
        if (dst.kind === 'immediate' || dst.kind === 'label') {
          throw new ExecutionError(
            'INVALID_DESTINATION',
            'TEST komutunda birinci operand sabit değer veya etiket olamaz.',
            'First operand of TEST cannot be an immediate value or label.'
          );
        }
        const size = this.resolveBinarySize(dst, src);
        const a = this.readOperand(dst, size);
        const b = this.readOperand(src, size);
        const res = aluLogic('AND', a, b, size, regs.flags);
        // TEST only updates flags, discards result
        this.applyFlags(res.flags);
        return false;
      }

      case 'NOT': {
        this.assertOperandCount(inst, 1);
        const [dst] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        const size = this.resolveUnarySize(dst);
        const a = this.readOperand(dst, size);
        this.writeOperand(dst, ~a & getBitMask(size), size);
        // NOT affects NO flags!
        return false;
      }

      case 'SHL':
      case 'SAL':
      case 'SHR':
      case 'SAR':
      case 'ROL':
      case 'ROR':
      case 'RCL':
      case 'RCR': {
        this.assertOperandCount(inst, 2);
        const [dst, countOp] = inst.operands;
        this.assertNotSegmentReg(dst, m);
        const size = this.resolveUnarySize(dst);
        let count: number;
        if (countOp.kind === 'immediate') {
          count = countOp.value & 0xff;
        } else if (countOp.kind === 'register' && countOp.register === 'CL') {
          count = regs.CL;
        } else {
          throw new ExecutionError(
            'INVALID_SHIFT_COUNT',
            `${m} sayacı yalnızca sabit bir sayı veya CL yazmacı olabilir.`,
            `${m} count must be an immediate value or the CL register.`
          );
        }
        const a = this.readOperand(dst, size);
        const res =
          m === 'SHL' || m === 'SAL' || m === 'SHR' || m === 'SAR'
            ? aluShift(m, a, count, size, regs.flags)
            : aluRotate(m, a, count, size, regs.flags);
        this.writeOperand(dst, res.result, size);
        this.applyFlags(res.flags);
        return false;
      }

      // ---------------- Flag Control ----------------
      case 'CLC':
        this.assertOperandCount(inst, 0);
        regs.setFlag('CF', false);
        return false;
      case 'STC':
        this.assertOperandCount(inst, 0);
        regs.setFlag('CF', true);
        return false;
      case 'CMC':
        this.assertOperandCount(inst, 0);
        regs.setFlag('CF', !regs.flags.CF);
        return false;
      case 'CLD':
        this.assertOperandCount(inst, 0);
        regs.setFlag('DF', false);
        return false;
      case 'STD':
        this.assertOperandCount(inst, 0);
        regs.setFlag('DF', true);
        return false;
      case 'CLI':
        this.assertOperandCount(inst, 0);
        regs.setFlag('IF', false);
        return false;
      case 'STI':
        this.assertOperandCount(inst, 0);
        regs.setFlag('IF', true);
        return false;
      case 'LAHF': {
        this.assertOperandCount(inst, 0);
        regs.AH = regs.getFlagsWord() & 0xff;
        return false;
      }
      case 'SAHF': {
        this.assertOperandCount(inst, 0);
        const ah = regs.AH;
        regs.setFlag('CF', (ah & 0x01) !== 0);
        regs.setFlag('PF', (ah & 0x04) !== 0);
        regs.setFlag('AF', (ah & 0x10) !== 0);
        regs.setFlag('ZF', (ah & 0x40) !== 0);
        regs.setFlag('SF', (ah & 0x80) !== 0);
        return false;
      }

      // ---------------- Stack Operations ----------------
      case 'PUSH': {
        this.assertOperandCount(inst, 1);
        const [src] = inst.operands;
        this.assertNotIpReg(src);
        const val =
          src.kind === 'immediate'
            ? src.value & 0xffff
            : this.readOperand(src, this.resolveUnarySize(src, true));
        this.push16Tracked(val);
        return false;
      }

      case 'POP': {
        this.assertOperandCount(inst, 1);
        const [dst] = inst.operands;
        this.assertNotIpReg(dst);
        if (dst.kind === 'register' && dst.register === 'CS') {
          throw new ExecutionError(
            'ILLEGAL_POP_CS',
            'POP CS komutu Intel 8086 mimarisinde geçersizdir.',
            'POP CS is illegal in Intel 8086.'
          );
        }
        const size = this.resolveUnarySize(dst, true);
        const val = this.pop16Tracked();
        this.writeOperand(dst, val, size);
        return false;
      }

      case 'PUSHF': {
        this.assertOperandCount(inst, 0);
        this.push16Tracked(regs.getFlagsWord());
        return false;
      }

      case 'POPF': {
        this.assertOperandCount(inst, 0);
        regs.setFlagsWord(this.pop16Tracked());
        return false;
      }

      case 'PUSHA': {
        this.assertOperandCount(inst, 0);
        const tempSP = regs.SP;
        this.push16Tracked(regs.AX);
        this.push16Tracked(regs.CX);
        this.push16Tracked(regs.DX);
        this.push16Tracked(regs.BX);
        this.push16Tracked(tempSP);
        this.push16Tracked(regs.BP);
        this.push16Tracked(regs.SI);
        this.push16Tracked(regs.DI);
        return false;
      }

      case 'POPA': {
        this.assertOperandCount(inst, 0);
        regs.DI = this.pop16Tracked();
        regs.SI = this.pop16Tracked();
        regs.BP = this.pop16Tracked();
        this.pop16Tracked(); // Skip saved SP slot
        regs.BX = this.pop16Tracked();
        regs.DX = this.pop16Tracked();
        regs.CX = this.pop16Tracked();
        regs.AX = this.pop16Tracked();
        return false;
      }

      // ---------------- Program Flow & Jumps ----------------
      case 'JMP': {
        this.assertOperandCount(inst, 1);
        return this.jumpToOperand(inst.operands[0]);
      }

      case 'JZ':
      case 'JE':
        this.assertOperandCount(inst, 1);
        return regs.flags.ZF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JNZ':
      case 'JNE':
        this.assertOperandCount(inst, 1);
        return !regs.flags.ZF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JC':
      case 'JB':
      case 'JNAE':
        this.assertOperandCount(inst, 1);
        return regs.flags.CF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JNC':
      case 'JAE':
      case 'JNB':
        this.assertOperandCount(inst, 1);
        return !regs.flags.CF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JA':
      case 'JNBE':
        this.assertOperandCount(inst, 1);
        return !regs.flags.CF && !regs.flags.ZF
          ? this.jumpToOperand(inst.operands[0])
          : false;

      case 'JBE':
      case 'JNA':
        this.assertOperandCount(inst, 1);
        return regs.flags.CF || regs.flags.ZF
          ? this.jumpToOperand(inst.operands[0])
          : false;

      case 'JG':
      case 'JNLE':
        this.assertOperandCount(inst, 1);
        return !regs.flags.ZF && regs.flags.SF === regs.flags.OF
          ? this.jumpToOperand(inst.operands[0])
          : false;

      case 'JGE':
      case 'JNL':
        this.assertOperandCount(inst, 1);
        return regs.flags.SF === regs.flags.OF
          ? this.jumpToOperand(inst.operands[0])
          : false;

      case 'JL':
      case 'JNGE':
        this.assertOperandCount(inst, 1);
        return regs.flags.SF !== regs.flags.OF
          ? this.jumpToOperand(inst.operands[0])
          : false;

      case 'JLE':
      case 'JNG':
        this.assertOperandCount(inst, 1);
        return regs.flags.ZF || regs.flags.SF !== regs.flags.OF
          ? this.jumpToOperand(inst.operands[0])
          : false;

      case 'JO':
        this.assertOperandCount(inst, 1);
        return regs.flags.OF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JNO':
        this.assertOperandCount(inst, 1);
        return !regs.flags.OF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JS':
        this.assertOperandCount(inst, 1);
        return regs.flags.SF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JNS':
        this.assertOperandCount(inst, 1);
        return !regs.flags.SF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JP':
      case 'JPE':
        this.assertOperandCount(inst, 1);
        return regs.flags.PF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JNP':
      case 'JPO':
        this.assertOperandCount(inst, 1);
        return !regs.flags.PF ? this.jumpToOperand(inst.operands[0]) : false;

      case 'JCXZ':
        this.assertOperandCount(inst, 1);
        return regs.CX === 0 ? this.jumpToOperand(inst.operands[0]) : false;

      case 'LOOP': {
        this.assertOperandCount(inst, 1);
        regs.CX = (regs.CX - 1) & 0xffff;
        // LOOP does NOT modify flags!
        return regs.CX !== 0 ? this.jumpToOperand(inst.operands[0]) : false;
      }

      case 'LOOPE':
      case 'LOOPZ': {
        this.assertOperandCount(inst, 1);
        regs.CX = (regs.CX - 1) & 0xffff;
        return regs.CX !== 0 && regs.flags.ZF
          ? this.jumpToOperand(inst.operands[0])
          : false;
      }

      case 'LOOPNE':
      case 'LOOPNZ': {
        this.assertOperandCount(inst, 1);
        regs.CX = (regs.CX - 1) & 0xffff;
        return regs.CX !== 0 && !regs.flags.ZF
          ? this.jumpToOperand(inst.operands[0])
          : false;
      }

      case 'CALL': {
        this.assertOperandCount(inst, 1);
        if (!this.program) return false;
        const nextInst =
          this.program.instructions[this.cpu.instructionIndex + 1];
        const returnOffset = nextInst
          ? nextInst.offset
          : (inst.offset + inst.byteLength) & 0xffff;
        this.push16Tracked(returnOffset);
        this.callDepth += 1;
        return this.jumpToOperand(inst.operands[0]);
      }

      case 'RET':
      case 'RETN':
      case 'RETF': {
        const popExtra =
          inst.operands.length === 1 && inst.operands[0].kind === 'immediate'
            ? inst.operands[0].value & 0xffff
            : 0;

        if (this.callDepth > 0 && this.program) {
          const returnOffset = this.pop16Tracked();
          if (popExtra > 0) {
            regs.SP = (regs.SP + popExtra) & 0xffff;
          }
          this.callDepth -= 1;
          const targetIdx = this.program.offsetToIndex[returnOffset];
          if (targetIdx !== undefined) {
            this.cpu.instructionIndex = targetIdx;
            regs.IP = returnOffset;
            return true;
          }
          const endOffset =
            this.program.instructions.length > 0
              ? (this.program.instructions[this.program.instructions.length - 1]
                  .offset +
                  this.program.instructions[
                    this.program.instructions.length - 1
                  ].byteLength) &
                0xffff
              : 0;
          if (returnOffset === endOffset) {
            this.cpu.halted = true;
            return true;
          }
          throw new ExecutionError(
            'STACK_CORRUPTED_RETURN',
            `Yığından (Stack) çekilen dönüş adresi (${formatHex(returnOffset, 4)}H) geçerli bir komuta karşılık gelmiyor. Alt program içinde PUSH edilen bir değerin POP edilmediğini kontrol edin.`,
            `Return address popped from stack (${formatHex(returnOffset, 4)}H) does not point to a valid instruction. Check for unmatched PUSH/POP inside the procedure.`
          );
        }

        // Top-level RET (emu8086 DOS return, e.g., `quit: ret`) -> halt cleanly
        this.cpu.halted = true;
        return true;
      }

      case 'IRET': {
        this.assertOperandCount(inst, 0);
        if (this.callDepth > 0 && this.program) {
          const returnOffset = this.pop16Tracked();
          regs.CS = this.pop16Tracked();
          regs.setFlagsWord(this.pop16Tracked());
          this.callDepth -= 1;
          const targetIdx = this.program.offsetToIndex[returnOffset];
          if (targetIdx !== undefined) {
            this.cpu.instructionIndex = targetIdx;
            regs.IP = returnOffset;
            return true;
          }
        }
        this.cpu.halted = true;
        return true;
      }

      case 'INTO': {
        this.assertOperandCount(inst, 0);
        if (regs.flags.OF) {
          throw new ExecutionError(
            'INTO_OVERFLOW',
            'INTO taşma kesmesi tetiklendi (OF = 1, INT 4).',
            'INTO overflow interrupt triggered (OF = 1, INT 4).'
          );
        }
        return false;
      }

      // ---------------- String Operations (8-bit & 16-bit) ----------------
      case 'SCASB':
      case 'SCASW':
      case 'CMPSB':
      case 'CMPSW':
      case 'MOVSB':
      case 'MOVSW':
      case 'STOSB':
      case 'STOSW':
      case 'LODSB':
      case 'LODSW': {
        this.executeStringOp(m, inst.prefix);
        return false;
      }

      // ---------------- Misc / System ----------------
      case 'NOP':
        return false;

      case 'HLT':
        this.cpu.halted = true;
        return true;

      case 'INT': {
        this.assertOperandCount(inst, 1);
        const vec = this.readOperand(inst.operands[0], 8);
        return this.executeInterrupt(vec, inst.line);
      }

      default:
        throw new ExecutionError(
          'UNSUPPORTED_INSTRUCTION',
          `'${m}' komutu henüz desteklenmiyor.`,
          `Instruction '${m}' is not supported yet.`
        );
    }
  }

  private executeInterrupt(vec: number, line: number): boolean {
    const regs = this.cpu.registers;

    // INT 03H: Breakpoint
    if (vec === 0x03) {
      return false;
    }

    // INT 20H: DOS Program Terminate
    if (vec === 0x20) {
      this.cpu.halted = true;
      return true;
    }

    // INT 10H: BIOS Video Services
    if (vec === 0x10) {
      const fn = regs.AH;
      if (fn === 0x0e) {
        // Teletype output: write AL character to console
        this.consoleOutput += String.fromCharCode(regs.AL);
        return false;
      }
      if (fn === 0x00) {
        // Set video mode / clear screen
        this.consoleOutput = '';
        return false;
      }
      if (fn === 0x02 || fn === 0x01 || fn === 0x03) {
        // Cursor positioning / query -> safe no-op
        return false;
      }
      this.lastRuntimeWarning = {
        line,
        code: 'UNSUPPORTED_INT_FN',
        messageTr: `Bilgi: INT 10H (AH=${formatHex(fn, 2)}H) grafik/ekran fonksiyonu bu emülatörde atlandı (INT 10H için AH=0EH karakter yazdırma ve AH=00H ekran temizleme desteklenir).`,
        messageEn: `Note: INT 10H (AH=${formatHex(fn, 2)}H) video service was skipped (AH=0EH teletype print and AH=00H clear screen are supported).`,
      };
      return false;
    }

    // INT 16H: BIOS Keyboard Services
    if (vec === 0x16) {
      const fn = regs.AH;
      if (fn === 0x00 || fn === 0x10) {
        // Wait for keystroke and read character -> AL = ASCII, AH = scan code
        if (this.inputQueue.length === 0) {
          throw new WaitForInputSignal({
            kind: 'char',
            interrupt: 'INT16_00',
            echo: false,
            line,
          });
        }
        const chunk = this.inputQueue.shift()!;
        const ch = chunk.length > 0 ? chunk.charCodeAt(0) & 0xff : 0x0d;
        regs.AL = ch;
        regs.AH = ch === 0x0d ? 0x1c : 0x1e;
        return false;
      }
      if (fn === 0x01 || fn === 0x11) {
        // Check keystroke status: ZF=0 if key ready, ZF=1 if empty
        if (this.inputQueue.length > 0 && this.inputQueue[0].length > 0) {
          regs.setFlag('ZF', false);
          regs.AL = this.inputQueue[0].charCodeAt(0) & 0xff;
          regs.AH = 0x1e;
        } else {
          regs.setFlag('ZF', true);
        }
        return false;
      }
      this.lastRuntimeWarning = {
        line,
        code: 'UNSUPPORTED_INT_FN',
        messageTr: `Bilgi: INT 16H (AH=${formatHex(fn, 2)}H) klavye fonksiyonu atlandı (AH=00H tuş okuma desteklenir).`,
        messageEn: `Note: INT 16H (AH=${formatHex(fn, 2)}H) keyboard function was skipped (AH=00H wait for key is supported).`,
      };
      return false;
    }

    // INT 21H: DOS Services
    if (vec === 0x21) {
      const fn = regs.AH;
      if (fn === 0x4c || fn === 0x00) {
        this.cpu.halted = true;
        return true;
      }
      if (fn === 0x01 || fn === 0x07 || fn === 0x08) {
        const echo = fn === 0x01;
        if (this.inputQueue.length === 0) {
          throw new WaitForInputSignal({
            kind: 'char',
            interrupt:
              fn === 0x01
                ? 'INT21_01'
                : fn === 0x07
                  ? 'INT21_07'
                  : 'INT21_08',
            echo,
            line,
          });
        }
        const chunk = this.inputQueue.shift()!;
        const chCode = chunk.length > 0 ? chunk.charCodeAt(0) & 0xff : 0x0d;
        regs.AL = chCode;
        if (echo) {
          this.consoleOutput += String.fromCharCode(chCode);
        }
        return false;
      }
      if (fn === 0x02) {
        const ch = regs.DL & 0xff;
        this.consoleOutput += String.fromCharCode(ch);
        regs.AL = ch; // Real DOS / emu8086 sets AL = DL
        return false;
      }
      if (fn === 0x06) {
        if (regs.DL !== 0xff) {
          const ch = regs.DL & 0xff;
          this.consoleOutput += String.fromCharCode(ch);
          regs.AL = ch;
        } else if (this.inputQueue.length > 0 && this.inputQueue[0].length > 0) {
          const chunk = this.inputQueue.shift()!;
          regs.AL = chunk.charCodeAt(0) & 0xff;
          regs.setFlag('ZF', false);
        } else {
          regs.AL = 0;
          regs.setFlag('ZF', true);
        }
        return false;
      }
      if (fn === 0x09) {
        let off = regs.DX;
        for (let guard = 0; guard < 4096; guard++) {
          const ch = this.cpu.memory.readByteSegOff(regs.DS, off);
          if (ch === 0x24) break; // '$'
          this.consoleOutput += String.fromCharCode(ch);
          off = (off + 1) & 0xffff;
        }
        regs.AL = 0x24; // Real DOS / emu8086 sets AL = 24H ('$')
        return false;
      }
      if (fn === 0x0a) {
        // Buffered keyboard input at DS:DX ([DX] = max chars, [DX+1] = actual chars, [DX+2..] = chars + 0Dh)
        const bufOff = regs.DX;
        const rawMax = this.cpu.memory.readByteSegOff(regs.DS, bufOff);
        const maxChars = rawMax > 0 ? Math.min(rawMax, 254) : 32;
        if (this.inputQueue.length === 0) {
          throw new WaitForInputSignal({
            kind: 'line',
            interrupt: 'INT21_0A',
            echo: true,
            maxLength: maxChars,
            line,
          });
        }
        const rawLine = this.inputQueue.shift()!.replace(/\r?\n$/, '');
        const sliced = rawLine.slice(0, Math.max(1, maxChars - 1));
        const lenPhys = calculatePhysicalAddress(
          regs.DS,
          (bufOff + 1) & 0xffff
        );
        this.writeByteTracked(lenPhys, sliced.length);
        this.recordTraceMemoryWrite({
          segmentReg: 'DS',
          segment: regs.DS,
          offset: (bufOff + 1) & 0xffff,
          physicalAddress: lenPhys,
          size: 8,
          value: sliced.length,
        });
        for (let i = 0; i < sliced.length; i++) {
          const cOff = (bufOff + 2 + i) & 0xffff;
          const cPhys = calculatePhysicalAddress(regs.DS, cOff);
          const cVal = sliced.charCodeAt(i) & 0xff;
          this.writeByteTracked(cPhys, cVal);
          this.recordTraceMemoryWrite({
            segmentReg: 'DS',
            segment: regs.DS,
            offset: cOff,
            physicalAddress: cPhys,
            size: 8,
            value: cVal,
          });
        }
        const crOff = (bufOff + 2 + sliced.length) & 0xffff;
        const crPhys = calculatePhysicalAddress(regs.DS, crOff);
        this.writeByteTracked(crPhys, 0x0d);
        this.consoleOutput += `${sliced}\n`;
        return false;
      }
      if (fn === 0x2a) {
        // Get system date
        const now = new Date();
        regs.CX = now.getFullYear();
        regs.DH = now.getMonth() + 1;
        regs.DL = now.getDate();
        regs.AL = now.getDay();
        return false;
      }
      if (fn === 0x2c) {
        // Get system time
        const now = new Date();
        regs.CH = now.getHours();
        regs.CL = now.getMinutes();
        regs.DH = now.getSeconds();
        regs.DL = Math.floor(now.getMilliseconds() / 10);
        return false;
      }

      this.lastRuntimeWarning = {
        line,
        code: 'UNSUPPORTED_INT_FN',
        messageTr: `Bilgi: INT 21H (AH=${formatHex(fn, 2)}H) alt fonksiyonu desteklenmiyor ve atlandı (Desteklenenler: 00H, 01H, 02H, 06H, 07H, 08H, 09H, 0AH, 2AH, 2CH, 4CH).`,
        messageEn: `Note: INT 21H (AH=${formatHex(fn, 2)}H) subfunction is not supported and was skipped (Supported: 00H, 01H, 02H, 06H, 07H, 08H, 09H, 0AH, 2AH, 2CH, 4CH).`,
      };
      return false;
    }

    this.lastRuntimeWarning = {
      line,
      code: 'UNSUPPORTED_INTERRUPT',
      messageTr: `Bilgi: INT ${formatHex(vec, 2)}H kesmesi bu emülatörde desteklenmiyor ve atlandı (Desteklenenler: INT 10H, INT 16H, INT 20H, INT 21H).`,
      messageEn: `Note: INT ${formatHex(vec, 2)}H interrupt is not supported and was skipped (Supported: INT 10H, INT 16H, INT 20H, INT 21H).`,
    };
    return false;
  }

  private executeStringOp(mnemonic: string, prefix?: string): void {
    const regs = this.cpu.registers;
    const isWord = mnemonic.endsWith('W');
    const stepDelta = regs.flags.DF ? (isWord ? -2 : -1) : isWord ? 2 : 1;

    const runOnce = () => {
      if (mnemonic === 'SCASB') {
        const memByte = this.cpu.memory.readByteSegOff(regs.ES, regs.DI);
        const res = aluSub(regs.AL, memByte, 8, regs.flags, false);
        this.applyFlags(res.flags);
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'SCASW') {
        const memWord = this.cpu.memory.readWordSegOff(regs.ES, regs.DI);
        const res = aluSub(regs.AX, memWord, 16, regs.flags, false);
        this.applyFlags(res.flags);
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'CMPSB') {
        const srcByte = this.cpu.memory.readByteSegOff(regs.DS, regs.SI);
        const dstByte = this.cpu.memory.readByteSegOff(regs.ES, regs.DI);
        const res = aluSub(srcByte, dstByte, 8, regs.flags, false);
        this.applyFlags(res.flags);
        regs.SI = (regs.SI + stepDelta) & 0xffff;
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'CMPSW') {
        const srcWord = this.cpu.memory.readWordSegOff(regs.DS, regs.SI);
        const dstWord = this.cpu.memory.readWordSegOff(regs.ES, regs.DI);
        const res = aluSub(srcWord, dstWord, 16, regs.flags, false);
        this.applyFlags(res.flags);
        regs.SI = (regs.SI + stepDelta) & 0xffff;
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'MOVSB') {
        const srcByte = this.cpu.memory.readByteSegOff(regs.DS, regs.SI);
        const dstPhys = calculatePhysicalAddress(regs.ES, regs.DI);
        this.writeByteTracked(dstPhys, srcByte);
        this.recordTraceMemoryWrite({
          segmentReg: 'ES',
          segment: regs.ES,
          offset: regs.DI,
          physicalAddress: dstPhys,
          size: 8,
          value: srcByte,
        });
        regs.SI = (regs.SI + stepDelta) & 0xffff;
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'MOVSW') {
        const srcWord = this.cpu.memory.readWordSegOff(regs.DS, regs.SI);
        const dstPhys = calculatePhysicalAddress(regs.ES, regs.DI);
        this.writeWordSegOffTracked(regs.ES, regs.DI, srcWord);
        this.wordWrittenAddresses.add(dstPhys);
        this.recordTraceMemoryWrite({
          segmentReg: 'ES',
          segment: regs.ES,
          offset: regs.DI,
          physicalAddress: dstPhys,
          size: 16,
          value: srcWord,
        });
        regs.SI = (regs.SI + stepDelta) & 0xffff;
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'STOSB') {
        const dstPhys = calculatePhysicalAddress(regs.ES, regs.DI);
        this.writeByteTracked(dstPhys, regs.AL);
        this.recordTraceMemoryWrite({
          segmentReg: 'ES',
          segment: regs.ES,
          offset: regs.DI,
          physicalAddress: dstPhys,
          size: 8,
          value: regs.AL,
        });
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'STOSW') {
        const dstPhys = calculatePhysicalAddress(regs.ES, regs.DI);
        this.writeWordSegOffTracked(regs.ES, regs.DI, regs.AX);
        this.wordWrittenAddresses.add(dstPhys);
        this.recordTraceMemoryWrite({
          segmentReg: 'ES',
          segment: regs.ES,
          offset: regs.DI,
          physicalAddress: dstPhys,
          size: 16,
          value: regs.AX,
        });
        regs.DI = (regs.DI + stepDelta) & 0xffff;
      } else if (mnemonic === 'LODSB') {
        regs.AL = this.cpu.memory.readByteSegOff(regs.DS, regs.SI);
        regs.SI = (regs.SI + stepDelta) & 0xffff;
      } else if (mnemonic === 'LODSW') {
        regs.AX = this.cpu.memory.readWordSegOff(regs.DS, regs.SI);
        regs.SI = (regs.SI + stepDelta) & 0xffff;
      }
    };

    if (!prefix) {
      runOnce();
      return;
    }

    const isCompareOrScan =
      mnemonic === 'SCASB' ||
      mnemonic === 'SCASW' ||
      mnemonic === 'CMPSB' ||
      mnemonic === 'CMPSW';

    while (regs.CX !== 0) {
      runOnce();
      regs.CX = (regs.CX - 1) & 0xffff;
      if (isCompareOrScan) {
        // On Intel 8086, REP (0xF3) and REPE/REPZ (0xF3) are the exact same prefix!
        if (
          (prefix === 'REP' || prefix === 'REPE' || prefix === 'REPZ') &&
          !regs.flags.ZF
        ) {
          break;
        }
        if ((prefix === 'REPNE' || prefix === 'REPNZ') && regs.flags.ZF) {
          break;
        }
      }
    }
  }

  private diffSnapshots(
    before: ICPUSnapshot,
    after: ICPUSnapshot
  ): { changedRegisters: RegisterName[]; changedFlags: FlagName[] } {
    const changedRegisters: RegisterName[] = [];
    const regKeys: RegisterName[] = [
      'AX',
      'AH',
      'AL',
      'BX',
      'BH',
      'BL',
      'CX',
      'CH',
      'CL',
      'DX',
      'DH',
      'DL',
      'SP',
      'BP',
      'SI',
      'DI',
      'IP',
      'CS',
      'DS',
      'SS',
      'ES',
    ];
    for (const key of regKeys) {
      if (
        before.registers[key] !== after.registers[key] ||
        this.currentWrittenSegmentRegs.has(key)
      ) {
        changedRegisters.push(key);
      }
    }

    const changedFlags: FlagName[] = [];
    const flagKeys: FlagName[] = [
      'CF',
      'PF',
      'AF',
      'ZF',
      'SF',
      'OF',
      'TF',
      'IF',
      'DF',
    ];
    for (const key of flagKeys) {
      if (before.registers.FLAGS[key] !== after.registers.FLAGS[key]) {
        changedFlags.push(key);
      }
    }

    return { changedRegisters, changedFlags };
  }
}
