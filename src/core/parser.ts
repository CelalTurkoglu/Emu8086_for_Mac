import {
  type BaseRegister,
  type DataSize,
  DEFAULT_EMU8086_CONFIG,
  type IInitialSegmentConfig,
  type IImmediateOperand,
  type ILabelOperand,
  type IMemoryOperand,
  type IndexRegister,
  type IParsedInstruction,
  type IRegisterOperand,
  MODEL_SMALL_EMU8086_CONFIG,
  type Operand,
  type RegisterName,
  type SegmentRegister,
} from './types';
import { isRegister8 } from './registers';

export interface IDataSegmentItem {
  name?: string;
  offset: number;
  size: DataSize | 32;
  bytes: number[];
  /** Optional deferred label references (e.g., TABLE DW ONE, TWO) */
  labelRefs?: Array<{ byteOffset: number; label: string }>;
  /** True if defined inline inside code under ORG 100h (placed after instructions) */
  inCodeSegment?: boolean;
  line: number;
}

export interface ISymbolInfo {
  name: string;
  kind: 'code' | 'data' | 'equ' | 'segment';
  /** Instruction index (for code), DS offset (for data), constant value (for equ), or segment value */
  value: number;
  /** Offset in CS (for code labels) or DS (for data symbols) */
  offset: number;
  /** Byte width for .data variables (8 for DB, 16 for DW) */
  dataSize?: DataSize;
  /** True if data symbol was defined inline inside code segment (COM style) */
  inCodeSegment?: boolean;
  line: number;
}

export interface IParseError {
  line: number;
  code: string;
  messageTr: string;
  messageEn: string;
  rawLine?: string;
}

export interface IParseWarning {
  line: number;
  code: string;
  messageTr: string;
  messageEn: string;
  rawLine?: string;
}

export interface IAssembleOptions {
  /**
   * When true, enforces strict real emu8086 / MASM rules at compile time:
   * - Requires explicit BYTE PTR / WORD PTR on ambiguous memory operands
   * - Rejects immediate value overflows (e.g. MOV AL, 300) at compile time
   * - Rejects symbol size mismatches (e.g. MOV BX, BYTE_VAR) at compile time
   * - Rejects illegal register/segment/memory combinations at compile time
   */
  strictMode?: boolean;
}

export interface IAssembledProgram {
  /** Original source code that was compiled */
  sourceCode: string;
  instructions: IParsedInstruction[];
  symbols: Record<string, ISymbolInfo>;
  /** Maps uppercase code label -> instruction array index */
  labelToIndex: Record<string, number>;
  /** Maps code segment offset -> instruction array index */
  offsetToIndex: Record<number, number>;
  /** Data bytes to preload into DS:0000+ */
  dataBytes: Uint8Array;
  /** Inline code-segment data items (for ORG 100h COM programs) */
  inlineCodeData: Array<{ offset: number; bytes: Uint8Array }>;
  /** Initial segment/pointer configuration derived from directives (ORG / .model) */
  initialConfig: IInitialSegmentConfig;
  /** Entry instruction index (from `end <label>` or `main proc` or 0) */
  entryIndex: number;
  errors: IParseError[];
  warnings: IParseWarning[];
}

const ALL_REGISTERS = new Set<string>([
  'AX',
  'BX',
  'CX',
  'DX',
  'AH',
  'AL',
  'BH',
  'BL',
  'CH',
  'CL',
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
]);

const SEGMENT_SET = new Set<string>(['CS', 'DS', 'SS', 'ES']);
const BASE_SET = new Set<string>(['BX', 'BP']);
const INDEX_SET = new Set<string>(['SI', 'DI']);

const PREFIX_SET = new Set<string>(['REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ']);

const JUMP_CALL_MNEMONICS = new Set<string>([
  'JMP',
  'JZ',
  'JE',
  'JNZ',
  'JNE',
  'JC',
  'JB',
  'JNAE',
  'JNC',
  'JAE',
  'JNB',
  'JA',
  'JNBE',
  'JBE',
  'JNA',
  'JG',
  'JNLE',
  'JGE',
  'JNL',
  'JL',
  'JNGE',
  'JLE',
  'JNG',
  'JO',
  'JNO',
  'JS',
  'JNS',
  'JP',
  'JPE',
  'JNP',
  'JPO',
  'JCXZ',
  'LOOP',
  'LOOPE',
  'LOOPZ',
  'LOOPNE',
  'LOOPNZ',
  'CALL',
]);

const SUPPORTED_MNEMONICS = new Set<string>([
  'MOV',
  'XCHG',
  'LEA',
  'LDS',
  'LES',
  'XLAT',
  'XLATB',
  'ADD',
  'ADC',
  'SUB',
  'SBB',
  'INC',
  'DEC',
  'NEG',
  'CMP',
  'MUL',
  'IMUL',
  'DIV',
  'IDIV',
  'CBW',
  'CWD',
  'DAA',
  'DAS',
  'AAA',
  'AAS',
  'AAM',
  'AAD',
  'AND',
  'OR',
  'XOR',
  'TEST',
  'NOT',
  'SHL',
  'SAL',
  'SHR',
  'SAR',
  'ROL',
  'ROR',
  'RCL',
  'RCR',
  'CLC',
  'STC',
  'CMC',
  'CLD',
  'STD',
  'CLI',
  'STI',
  'LAHF',
  'SAHF',
  'PUSH',
  'POP',
  'PUSHF',
  'POPF',
  'PUSHA',
  'POPA',
  'RET',
  'RETN',
  'RETF',
  'IRET',
  'INTO',
  'NOP',
  'HLT',
  'INT',
  'SCASB',
  'SCASW',
  'CMPSB',
  'CMPSW',
  'MOVSB',
  'MOVSW',
  'STOSB',
  'STOSW',
  'LODSB',
  'LODSW',
  ...JUMP_CALL_MNEMONICS,
]);

/**
 * Strips comments (starting with ';') while preserving semicolons inside single/double quotes.
 */
export function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" || ch === '’' || ch === '‘') {
      if (!inDouble) inSingle = !inSingle;
    } else if (ch === '"') {
      if (!inSingle) inDouble = !inDouble;
    } else if (ch === ';' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Splits a comma-separated operand or data list while respecting quotes and parentheses.
 */
function splitCommaList(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "'" || ch === '’' || ch === '‘') && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === '(' && !inSingle && !inDouble) {
      parenDepth++;
      current += ch;
    } else if (ch === ')' && !inSingle && !inDouble) {
      parenDepth = Math.max(0, parenDepth - 1);
      current += ch;
    } else if (ch === ',' && !inSingle && !inDouble && parenDepth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * Checks if a string is enclosed in matching quotes ('...' or "..." or smart quotes)
 * with no unescaped inner quotes breaking the literal.
 */
function matchQuotedString(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const isSingle =
    (first === "'" || first === '‘' || first === '’') &&
    (last === "'" || last === '‘' || last === '’');
  const isDouble = first === '"' && last === '"';
  if (!isSingle && !isDouble) return null;
  return trimmed.slice(1, -1);
}

/**
 * Parses an 8086 numeric or character literal:
 * - Hex: 0F5H, 5000h, 0x1234, -04H
 * - Binary: 10110101b, 00001001B
 * - Octal: 17o, 17q
 * - Decimal: 5, 200, +127, -128, -48
 * - Character: 'A', '8', ’1’, 'AB' (16-bit two-char constant)
 */
export function parseLiteral(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Single or two-character literal: 'A' or 'AB'
  const quoted = matchQuotedString(trimmed);
  if (quoted !== null) {
    if (quoted.length === 1) {
      return quoted.charCodeAt(0);
    }
    if (quoted.length === 2) {
      return ((quoted.charCodeAt(0) & 0xff) << 8) | (quoted.charCodeAt(1) & 0xff);
    }
    return null;
  }

  let sign = 1;
  let body = trimmed;
  if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1).trim();
  } else if (body.startsWith('+')) {
    body = body.slice(1).trim();
  }

  const upper = body.toUpperCase();

  // 0x... hexadecimal
  if (/^0X[0-9A-F]+$/.test(upper)) {
    return sign * parseInt(upper.slice(2), 16);
  }

  // ...H hexadecimal (MASM/emu8086 standard: starts with digit)
  if (/^[0-9][0-9A-F]*H$/.test(upper)) {
    return sign * parseInt(upper.slice(0, -1), 16);
  }

  // ...B binary
  if (/^[01]+B$/.test(upper)) {
    return sign * parseInt(upper.slice(0, -1), 2);
  }

  // ...O or ...Q octal
  if (/^[0-7]+[OQ]$/.test(upper)) {
    return sign * parseInt(upper.slice(0, -1), 8);
  }

  // Optional trailing D decimal
  if (/^[0-9]+D?$/.test(upper)) {
    const digits = upper.endsWith('D') ? upper.slice(0, -1) : upper;
    return sign * parseInt(digits, 10);
  }

  return null;
}

/**
 * Evaluates a constant assembly expression supporting:
 * - Numeric & character literals ('0', 0F5H, 1010B, 25)
 * - Current location counter `$` (e.g. `LEN EQU $ - MSG`, `JMP $`)
 * - EQU constants and symbol offsets (in difference expressions like `$ - MSG` or `LEN - 1`)
 * - Binary `+`, `-`, `*`, `/` operators
 */
export function evaluateConstExpr(
  rawExpr: string,
  symbols: Record<string, ISymbolInfo>,
  currentLocation?: number
): number | null {
  const trimmed = rawExpr.trim();
  if (!trimmed) return null;

  // Fast path: direct literal
  const direct = parseLiteral(trimmed);
  if (direct !== null) return direct;

  // Fast path: single symbol or '$'
  if (trimmed === '$') {
    return currentLocation ?? null;
  }
  const upperSingle = trimmed.toUpperCase();
  const singleSym = symbols[upperSingle];
  if (singleSym) {
    if (singleSym.kind === 'equ' || singleSym.kind === 'segment') {
      return singleSym.value;
    }
    if (singleSym.kind === 'data' || singleSym.kind === 'code') {
      return singleSym.offset;
    }
  }

  // Reject if expression contains brackets or registers
  if (trimmed.includes('[') || trimmed.includes(']')) return null;

  // Tokenize arithmetic expression while respecting character literals like '0' + 5 or '+'
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '‘' || ch === '’') {
      const quote = ch;
      let lit = ch;
      i++;
      while (i < trimmed.length) {
        const c = trimmed[i];
        lit += c;
        i++;
        if (
          c === quote ||
          ((quote === '‘' || quote === '’' || quote === "'") &&
            (c === '‘' || c === '’' || c === "'"))
        ) {
          break;
        }
      }
      tokens.push(lit);
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
      continue;
    }
    let word = '';
    while (
      i < trimmed.length &&
      !/[\s+\-*/()'‘’"]/.test(trimmed[i])
    ) {
      word += trimmed[i];
      i++;
    }
    tokens.push(word);
  }

  if (tokens.length === 0) return null;

  let pos = 0;

  const parsePrimary = (): number | null => {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];

    if (tok === '+') {
      pos++;
      return parsePrimary();
    }
    if (tok === '-') {
      pos++;
      const val = parsePrimary();
      return val === null ? null : -val;
    }
    if (tok === '(') {
      pos++;
      const val = parseAddSub();
      if (val === null || tokens[pos] !== ')') return null;
      pos++;
      return val;
    }

    pos++;
    if (tok === '$') {
      return currentLocation ?? null;
    }
    const lit = parseLiteral(tok);
    if (lit !== null) return lit;

    const upper = tok.toUpperCase();
    if (ALL_REGISTERS.has(upper)) return null;
    const sym = symbols[upper];
    if (sym) {
      if (sym.kind === 'equ' || sym.kind === 'segment') return sym.value;
      return sym.offset;
    }
    return null;
  };

  const parseMulDiv = (): number | null => {
    let left = parsePrimary();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parsePrimary();
      if (right === null) return null;
      if (op === '*') {
        left = left * right;
      } else {
        if (right === 0) return null;
        left = Math.trunc(left / right);
      }
    }
    return left;
  };

  const parseAddSub = (): number | null => {
    let left = parseMulDiv();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseMulDiv();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const result = parseAddSub();
  if (result === null || pos !== tokens.length) return null;
  return result;
}

/**
 * Computes realistic Intel 8086 machine instruction byte length
 * (opcode + ModR/M + disp8/16 + imm8/16 + segment/REP prefixes).
 */
export function computeInstructionByteLength(
  mnemonic: string,
  operands: Operand[],
  prefix?: string
): number {
  const prefixBytes = prefix ? 1 : 0;

  const modrmByteLength = (mem: IMemoryOperand): number => {
    const segPrefix = mem.segmentOverride ? 1 : 0;
    // Direct memory [disp16]
    if (!mem.base && !mem.index) {
      return segPrefix + 4; // opcode + ModR/M(mod=00,r/m=110) + disp16
    }
    // [BP] with disp=0 uses mod=01 + disp8=00 on 8086
    if (mem.base === 'BP' && !mem.index && mem.displacement === 0 && !mem.symbol) {
      return segPrefix + 3;
    }
    if (mem.displacement === 0 && !mem.symbol) {
      return segPrefix + 2; // opcode + ModR/M(mod=00)
    }
    if (
      !mem.symbol &&
      mem.displacement >= -128 &&
      mem.displacement <= 127
    ) {
      return segPrefix + 3; // opcode + ModR/M(mod=01) + disp8
    }
    return segPrefix + 4; // opcode + ModR/M(mod=10) + disp16
  };

  if (operands.length === 0) {
    if (mnemonic === 'AAM' || mnemonic === 'AAD') {
      return prefixBytes + 2;
    }
    return prefixBytes + 1;
  }

  if (operands.length === 1) {
    const op = operands[0];

    if (mnemonic === 'INT') {
      if (op.kind === 'immediate' && op.value === 3) return prefixBytes + 1;
      return prefixBytes + 2;
    }

    if (mnemonic === 'RET' || mnemonic === 'RETN' || mnemonic === 'RETF') {
      return prefixBytes + 3; // RET imm16
    }

    if (JUMP_CALL_MNEMONICS.has(mnemonic)) {
      if (op.kind === 'memory') {
        return prefixBytes + modrmByteLength(op);
      }
      if (op.kind === 'register') {
        return prefixBytes + 2; // FF E0 / FF D0
      }
      return prefixBytes + (mnemonic === 'CALL' ? 3 : 2);
    }

    if (
      (mnemonic === 'INC' ||
        mnemonic === 'DEC' ||
        mnemonic === 'PUSH' ||
        mnemonic === 'POP') &&
      op.kind === 'register' &&
      op.size === 16
    ) {
      return prefixBytes + 1;
    }

    if (mnemonic === 'PUSH' && op.kind === 'immediate') {
      return prefixBytes + (op.value >= -128 && op.value <= 127 ? 2 : 3);
    }

    if (op.kind === 'register') {
      return prefixBytes + 2; // FE/FF/F6/F7 ModR/M
    }
    if (op.kind === 'memory') {
      return prefixBytes + modrmByteLength(op);
    }
    return prefixBytes + 2;
  }

  const [dst, src] = operands;

  // XCHG AX, reg16 is 1 byte (90..97)
  if (
    mnemonic === 'XCHG' &&
    dst.kind === 'register' &&
    src.kind === 'register' &&
    dst.size === 16 &&
    (dst.register === 'AX' || src.register === 'AX') &&
    !SEGMENT_SET.has(dst.register) &&
    !SEGMENT_SET.has(src.register)
  ) {
    return prefixBytes + 1;
  }

  // Shift / Rotate instructions
  if (
    mnemonic === 'SHL' ||
    mnemonic === 'SAL' ||
    mnemonic === 'SHR' ||
    mnemonic === 'SAR' ||
    mnemonic === 'ROL' ||
    mnemonic === 'ROR' ||
    mnemonic === 'RCL' ||
    mnemonic === 'RCR'
  ) {
    const extraImm =
      src.kind === 'immediate' && (src.value & 0xff) !== 1 ? 1 : 0;
    if (dst.kind === 'register') {
      return prefixBytes + 2 + extraImm;
    }
    if (dst.kind === 'memory') {
      return prefixBytes + modrmByteLength(dst) + extraImm;
    }
    return prefixBytes + 2;
  }

  // MOV reg, imm -> 2 bytes (8-bit) or 3 bytes (16-bit)
  if (mnemonic === 'MOV' && dst.kind === 'register' && src.kind === 'immediate') {
    return prefixBytes + (dst.size === 8 ? 2 : 3);
  }

  // MOV AL/AX, [disp16] or MOV [disp16], AL/AX -> 3 bytes (A0..A3)
  if (mnemonic === 'MOV') {
    if (
      dst.kind === 'register' &&
      (dst.register === 'AL' || dst.register === 'AX') &&
      src.kind === 'memory' &&
      !src.base &&
      !src.index
    ) {
      return prefixBytes + (src.segmentOverride ? 4 : 3);
    }
    if (
      src.kind === 'register' &&
      (src.register === 'AL' || src.register === 'AX') &&
      dst.kind === 'memory' &&
      !dst.base &&
      !dst.index
    ) {
      return prefixBytes + (dst.segmentOverride ? 4 : 3);
    }
  }

  // Reg, Reg
  if (dst.kind === 'register' && src.kind === 'register') {
    return prefixBytes + 2;
  }

  // Reg, Imm (ADD, ADC, SUB, SBB, CMP, AND, OR, XOR, TEST)
  if (dst.kind === 'register' && src.kind === 'immediate') {
    if (dst.register === 'AL') return prefixBytes + 2;
    if (dst.register === 'AX') {
      if (
        mnemonic !== 'AND' &&
        mnemonic !== 'OR' &&
        mnemonic !== 'XOR' &&
        mnemonic !== 'TEST' &&
        !src.fromSymbol &&
        src.value >= -128 &&
        src.value <= 127
      ) {
        return prefixBytes + 3; // 83 C0 imm8
      }
      return prefixBytes + 3; // 05/2D/3D/25/0D/35/A9 imm16
    }
    if (dst.size === 8) return prefixBytes + 3; // 80 ModR/M imm8
    if (
      mnemonic !== 'AND' &&
      mnemonic !== 'OR' &&
      mnemonic !== 'XOR' &&
      mnemonic !== 'TEST' &&
      !src.fromSymbol &&
      src.value >= -128 &&
      src.value <= 127
    ) {
      return prefixBytes + 3; // 83 ModR/M imm8 (sign-extended)
    }
    return prefixBytes + 4; // 81 ModR/M imm16
  }

  // Reg, Mem or Mem, Reg
  if (dst.kind === 'memory' && src.kind === 'register') {
    return prefixBytes + modrmByteLength(dst);
  }
  if (dst.kind === 'register' && src.kind === 'memory') {
    return prefixBytes + modrmByteLength(src);
  }

  // Mem, Imm
  if (dst.kind === 'memory' && src.kind === 'immediate') {
    const is16 = dst.sizeHint === 16 || src.value > 0xff || src.value < -128;
    const baseLen = modrmByteLength(dst);
    if (
      is16 &&
      mnemonic !== 'MOV' &&
      mnemonic !== 'AND' &&
      mnemonic !== 'OR' &&
      mnemonic !== 'XOR' &&
      mnemonic !== 'TEST' &&
      !src.fromSymbol &&
      src.value >= -128 &&
      src.value <= 127
    ) {
      return prefixBytes + baseLen + 1;
    }
    return prefixBytes + baseLen + (is16 ? 2 : 1);
  }

  return prefixBytes + 3;
}

/**
 * Parses a memory operand like:
 *   [0058H], [0053H], [BX], [BX+DI], [BX][DI], [BX]+2, [BX]+[SI], [BX+1000H],
 *   DS:[1234H], DS:BYTE PTR [BX], BYTE PTR DS:[5000H], WORD PTR [DI],
 *   b.[05000h], w.[5000H], ARRAY[SI+2], DATA1+2
 */
function parseMemoryOperand(
  rawText: string,
  symbols: Record<string, ISymbolInfo>,
  line: number,
  errors: IParseError[]
): IMemoryOperand | null {
  let text = rawText.trim();
  let sizeHint: DataSize | undefined;
  let explicitSize = false;
  let segmentOverride: SegmentRegister | undefined;

  // Strip size prefix and segment override in either order (BYTE PTR DS:[BX] or DS:BYTE PTR [BX])
  for (let pass = 0; pass < 2; pass++) {
    const ptrMatch = text.match(/^(BYTE|WORD)\s+PTR\s+(.+)$/i);
    if (ptrMatch && !explicitSize) {
      sizeHint = ptrMatch[1].toUpperCase() === 'BYTE' ? 8 : 16;
      explicitSize = true;
      text = ptrMatch[2].trim();
      continue;
    }
    const shortPtrMatch = text.match(/^([BW])\.\s*(.+)$/i);
    if (shortPtrMatch && !explicitSize) {
      sizeHint = shortPtrMatch[1].toUpperCase() === 'B' ? 8 : 16;
      explicitSize = true;
      text = shortPtrMatch[2].trim();
      continue;
    }
    const segMatch = text.match(/^(CS|DS|SS|ES)\s*:\s*(.+)$/i);
    if (segMatch && !segmentOverride) {
      segmentOverride = segMatch[1].toUpperCase() as SegmentRegister;
      text = segMatch[2].trim();
      continue;
    }
  }

  let symbol: string | undefined;
  let displacement = 0;

  const bracketIdx = text.indexOf('[');
  if (bracketIdx === -1) {
    // Unbracketed expression: e.g. DATA1 or DATA1 + 2 or WORD PTR DATA1 + 4
    const matchSymExpr = text.match(
      /^([A-Za-z_@?$][A-Za-z0-9_@?$]*)(?:\s*([+-].+))?$/
    );
    if (matchSymExpr) {
      const upperSym = matchSymExpr[1].toUpperCase();
      const sym = symbols[upperSym];
      if (sym && sym.kind === 'data') {
        let extraDisp = 0;
        if (matchSymExpr[2]) {
          const evalTail = evaluateConstExpr(matchSymExpr[2], symbols);
          if (evalTail === null) return null;
          extraDisp = evalTail;
        }
        return {
          kind: 'memory',
          segmentOverride:
            segmentOverride ?? (sym.inCodeSegment ? 'CS' : undefined),
          displacement: (sym.offset + extraDisp) & 0xffff,
          symbol: upperSym,
          explicitSize,
          sizeHint: sizeHint ?? sym.dataSize,
        };
      }
    }
    return null;
  }

  // Check for unclosed '[' or stray ']'
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    if (depth < 0) {
      errors.push({
        line,
        code: 'INVALID_MEMORY_EXPR',
        messageTr: `Satır ${line}: Geçersiz bellek adres ifadesi '${rawText}'.`,
        messageEn: `Line ${line}: Invalid memory address expression '${rawText}'.`,
        rawLine: rawText,
      });
      return null;
    }
  }
  if (depth !== 0) {
    errors.push({
      line,
      code: 'UNCLOSED_BRACKET',
      messageTr: `Satır ${line}: Bellek adresinde kapanmamış köşeli parantez '['.`,
      messageEn: `Line ${line}: Unclosed bracket '[' in memory operand.`,
      rawLine: rawText,
    });
    return null;
  }

  // Normalize MASM bracket expressions like `ARRAY[SI+2]`, `[BX][DI]`, `[BX]+2`, `[BX]+[SI]`
  // into a single unified sum of terms: e.g. `ARRAY + SI + 2`, `BX + DI`, `BX + 2`, `BX + SI`
  let normalized = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') {
      const prev = normalized.trimEnd();
      if (prev.length > 0 && !prev.endsWith('+') && !prev.endsWith('-')) {
        normalized += '+';
      }
    } else if (ch === ']') {
      // look ahead for non-operator
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (
        j < text.length &&
        text[j] !== '+' &&
        text[j] !== '-' &&
        text[j] !== '['
      ) {
        normalized += '+';
      }
    } else {
      normalized += ch;
    }
  }

  // Tokenize normalized expression into signed terms: e.g. BX + SI - 4 + 0100H
  const terms: Array<{ sign: number; token: string }> = [];
  let cur = '';
  let curSign = 1;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '+' || ch === '-') {
      if (cur.trim()) {
        terms.push({ sign: curSign, token: cur.trim() });
        curSign = ch === '+' ? 1 : -1;
        cur = '';
      } else {
        curSign = ch === '-' ? -curSign : curSign;
      }
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    terms.push({ sign: curSign, token: cur.trim() });
  }

  if (terms.length === 0) {
    errors.push({
      line,
      code: 'INVALID_MEMORY_EXPR',
      messageTr: `Satır ${line}: Geçersiz bellek adres ifadesi '${rawText}'.`,
      messageEn: `Line ${line}: Invalid memory address expression '${rawText}'.`,
      rawLine: rawText,
    });
    return null;
  }

  let base: BaseRegister | undefined;
  let index: IndexRegister | undefined;

  for (const term of terms) {
    const upper = term.token.toUpperCase();

    if (BASE_SET.has(upper)) {
      if (term.sign < 0) {
        errors.push({
          line,
          code: 'INVALID_REGISTER_SIGN',
          messageTr: `Satır ${line}: Bellek adresinde yazmaç çıkarılamaz ('-${upper}').`,
          messageEn: `Line ${line}: Cannot subtract register in memory operand ('-${upper}').`,
          rawLine: rawText,
        });
        return null;
      }
      if (base) {
        errors.push({
          line,
          code: 'DUPLICATE_BASE_REGISTER',
          messageTr: `Satır ${line}: 8086 adreslemesinde aynı anda iki taban yazmacı (${base} ve ${upper}) kullanılamaz.`,
          messageEn: `Line ${line}: Cannot combine two base registers (${base} and ${upper}) in 8086 addressing.`,
          rawLine: rawText,
        });
        return null;
      }
      base = upper as BaseRegister;
      continue;
    }

    if (INDEX_SET.has(upper)) {
      if (term.sign < 0) {
        errors.push({
          line,
          code: 'INVALID_REGISTER_SIGN',
          messageTr: `Satır ${line}: Bellek adresinde yazmaç çıkarılamaz ('-${upper}').`,
          messageEn: `Line ${line}: Cannot subtract register in memory operand ('-${upper}').`,
          rawLine: rawText,
        });
        return null;
      }
      if (index) {
        errors.push({
          line,
          code: 'DUPLICATE_INDEX_REGISTER',
          messageTr: `Satır ${line}: 8086 adreslemesinde aynı anda iki indis yazmacı (${index} ve ${upper}) kullanılamaz.`,
          messageEn: `Line ${line}: Cannot combine two index registers (${index} and ${upper}) in 8086 addressing.`,
          rawLine: rawText,
        });
        return null;
      }
      index = upper as IndexRegister;
      continue;
    }

    if (ALL_REGISTERS.has(upper)) {
      errors.push({
        line,
        code: 'INVALID_ADDRESSING_REGISTER',
        messageTr: `Satır ${line}: '${upper}' yazmacı 8086 bellek adreslemesinde kullanılamaz (yalnızca BX, BP, SI, DI geçerlidir).`,
        messageEn: `Line ${line}: Register '${upper}' is not valid for 8086 memory addressing (only BX, BP, SI, DI are allowed).`,
        rawLine: rawText,
      });
      return null;
    }

    const sym = symbols[upper];
    if (sym && (sym.kind === 'data' || sym.kind === 'equ')) {
      displacement += term.sign * (sym.kind === 'data' ? sym.offset : sym.value);
      if (sym.kind === 'data' && !symbol) {
        symbol = upper;
        if (!sizeHint && sym.dataSize) sizeHint = sym.dataSize;
        if (!segmentOverride && sym.inCodeSegment) segmentOverride = 'CS';
      }
      continue;
    }

    const lit = evaluateConstExpr(term.token, symbols);
    if (lit !== null) {
      displacement += term.sign * lit;
      continue;
    }

    errors.push({
      line,
      code: 'UNKNOWN_SYMBOL',
      messageTr: `Satır ${line}: Bellek adresinde tanınmayan ifade veya sembol '${term.token}'.`,
      messageEn: `Line ${line}: Unrecognized term or undefined symbol '${term.token}' in memory operand.`,
      rawLine: rawText,
    });
    return null;
  }

  return {
    kind: 'memory',
    segmentOverride,
    base,
    index,
    displacement,
    symbol,
    explicitSize,
    sizeHint,
  };
}

/**
 * Parses a single instruction operand in Pass 2 (after symbols & labels are collected).
 */
function parseOperand(
  rawText: string,
  mnemonic: string,
  symbols: Record<string, ISymbolInfo>,
  dataSegment: number,
  codeSegment: number,
  currentInstOffset: number,
  line: number,
  errors: IParseError[]
): Operand | null {
  let text = rawText.trim();
  if (!text) return null;

  // Strip optional jump distance qualifiers: JMP SHORT NEXT / JMP NEAR NEXT
  if (JUMP_CALL_MNEMONICS.has(mnemonic)) {
    text = text.replace(/^(SHORT|NEAR\s+PTR|NEAR|FAR\s+PTR|FAR)\s+/i, '').trim();
  }

  const upper = text.toUpperCase();

  // 1. Special @DATA / @CODE symbols (e.g. MOV AX, @DATA)
  if (upper === '@DATA') {
    return { kind: 'immediate', value: dataSegment, raw: text, fromSymbol: true };
  }
  if (upper === '@CODE') {
    return { kind: 'immediate', value: codeSegment, raw: text, fromSymbol: true };
  }

  // 2. SEG <symbol> operator (e.g. MOV AX, SEG DATA1)
  const segOpMatch = text.match(/^SEG\s+([A-Za-z_@?$][A-Za-z0-9_@?$]*)$/i);
  if (segOpMatch) {
    const symName = segOpMatch[1].toUpperCase();
    const sym = symbols[symName];
    if (!sym) {
      errors.push({
        line,
        code: 'UNKNOWN_SEG_SYMBOL',
        messageTr: `Satır ${line}: SEG için tanımlanmamış sembol '${segOpMatch[1]}'.`,
        messageEn: `Line ${line}: Undefined symbol '${segOpMatch[1]}' in SEG expression.`,
        rawLine: rawText,
      });
      return null;
    }
    const segVal =
      sym.kind === 'segment'
        ? sym.value
        : sym.kind === 'code' || sym.inCodeSegment
          ? codeSegment
          : dataSegment;
    return { kind: 'immediate', value: segVal, raw: text, fromSymbol: true };
  }

  // 3. OFFSET <symbol> [+ expr] directive (e.g. MOV DI, OFFSET DATA1 or OFFSET DATA1 + 2)
  const offsetMatch = text.match(
    /^OFFSET\s+([A-Za-z_@?$][A-Za-z0-9_@?$]*)(?:\s*([+-].+))?$/i
  );
  if (offsetMatch) {
    const symName = offsetMatch[1].toUpperCase();
    const sym = symbols[symName];
    if (!sym) {
      errors.push({
        line,
        code: 'UNKNOWN_OFFSET_SYMBOL',
        messageTr: `Satır ${line}: OFFSET için tanımlanmamış sembol '${offsetMatch[1]}'.`,
        messageEn: `Line ${line}: Undefined symbol '${offsetMatch[1]}' in OFFSET expression.`,
        rawLine: rawText,
      });
      return null;
    }
    let extra = 0;
    if (offsetMatch[2]) {
      const tailVal = evaluateConstExpr(offsetMatch[2], symbols, currentInstOffset);
      if (tailVal === null) {
        errors.push({
          line,
          code: 'INVALID_OPERAND',
          messageTr: `Satır ${line}: Geçersiz OFFSET ifadesi '${text}'.`,
          messageEn: `Line ${line}: Invalid OFFSET expression '${text}'.`,
          rawLine: rawText,
        });
        return null;
      }
      extra = tailVal;
    }
    return {
      kind: 'immediate',
      value: (sym.offset + extra) & 0xffff,
      raw: text,
      fromSymbol: true,
      codeLabelRef: sym.kind === 'code' && extra === 0 ? symName : undefined,
    };
  }

  // 4. Register operand
  if (ALL_REGISTERS.has(upper)) {
    const reg = upper as RegisterName;
    const op: IRegisterOperand = {
      kind: 'register',
      register: reg,
      size: isRegister8(reg) ? 8 : 16,
    };
    return op;
  }

  // 5. Jump / Call target operand (unless it's a memory operand like JMP [SI] or JMP TABLE[BX])
  if (
    JUMP_CALL_MNEMONICS.has(mnemonic) &&
    !text.includes('[') &&
    !/^(BYTE|WORD)\s+PTR\b/i.test(text) &&
    !/^[BW]\./i.test(text)
  ) {
    if (text === '$') {
      return { kind: 'immediate', value: currentInstOffset, raw: text };
    }
    const sym = symbols[upper];
    if (sym && sym.kind === 'code') {
      const labelOp: ILabelOperand = { kind: 'label', name: upper };
      return labelOp;
    }
    if (sym && sym.kind === 'data') {
      return {
        kind: 'memory',
        segmentOverride: sym.inCodeSegment ? 'CS' : undefined,
        displacement: sym.offset,
        symbol: upper,
        sizeHint: sym.dataSize,
      };
    }
    const lit = evaluateConstExpr(text, symbols, currentInstOffset);
    if (lit !== null) {
      return { kind: 'immediate', value: lit, raw: text };
    }
    errors.push({
      line,
      code: 'UNKNOWN_LABEL',
      messageTr: `Satır ${line}: Tanımlanmamış etiket '${text}'.`,
      messageEn: `Line ${line}: Undefined jump/call label '${text}'.`,
      rawLine: rawText,
    });
    return null;
  }

  // 6. Memory operand (bracketed, PTR, segment override, or DATA1+2)
  if (
    text.includes('[') ||
    /^(BYTE|WORD)\s+PTR\b/i.test(text) ||
    /^[BW]\./i.test(text) ||
    /^(CS|DS|SS|ES)\s*:/i.test(text)
  ) {
    return parseMemoryOperand(text, symbols, line, errors);
  }

  // 7. Direct known symbol (.data variable -> direct memory, EQU/segment -> immediate)
  const sym = symbols[upper];
  if (sym) {
    if (sym.kind === 'equ' || sym.kind === 'segment') {
      return {
        kind: 'immediate',
        value: sym.value,
        raw: text,
        fromSymbol: sym.kind === 'segment',
      };
    }
    if (sym.kind === 'data') {
      return {
        kind: 'memory',
        segmentOverride: sym.inCodeSegment ? 'CS' : undefined,
        displacement: sym.offset,
        symbol: upper,
        sizeHint: sym.dataSize,
      };
    }
    if (sym.kind === 'code') {
      return {
        kind: 'immediate',
        value: sym.offset,
        raw: text,
        fromSymbol: true,
        codeLabelRef: upper,
      };
    }
  }

  // 8. Unbracketed data symbol + constant offset (e.g. MOV AL, DATA1 + 2)
  const memPlus = parseMemoryOperand(text, symbols, line, []);
  if (memPlus) {
    return memPlus;
  }

  // 9. Numeric, character, or arithmetic constant expression (e.g. '0' + 5, LEN - 1)
  const exprVal = evaluateConstExpr(text, symbols, currentInstOffset);
  if (exprVal !== null) {
    const immOp: IImmediateOperand = {
      kind: 'immediate',
      value: exprVal,
      raw: text,
    };
    return immOp;
  }

  errors.push({
    line,
    code: 'INVALID_OPERAND',
    messageTr: `Satır ${line}: Geçersiz veya tanımlanmamış operand '${text}'.`,
    messageEn: `Line ${line}: Invalid or undefined operand '${text}'.`,
    rawLine: rawText,
  });
  return null;
}

/**
 * Parses a DB / DW / DD data definition item list into raw bytes.
 */
function parseDataDefinition(
  directive: 'DB' | 'DW' | 'DD',
  operandText: string,
  baseOffset: number,
  symbols: Record<string, ISymbolInfo>,
  line: number,
  errors: IParseError[]
): { bytes: number[]; labelRefs: Array<{ byteOffset: number; label: string }> } {
  const bytes: number[] = [];
  const labelRefs: Array<{ byteOffset: number; label: string }> = [];

  const pushValue = (val: number) => {
    if (directive === 'DB') {
      bytes.push(val & 0xff);
    } else if (directive === 'DW') {
      bytes.push(val & 0xff, (val >> 8) & 0xff);
    } else {
      bytes.push(
        val & 0xff,
        (val >> 8) & 0xff,
        (val >> 16) & 0xff,
        (val >>> 24) & 0xff
      );
    }
  };

  const processItems = (text: string): boolean => {
    const items = splitCommaList(text);
    for (const item of items) {
      // Check DUP syntax: e.g. 5 DUP(0), LEN DUP(?), 3 DUP(1, 2), or nested DUP
      const dupMatch = item.match(/^(.+?)\s+DUP\s*\((.+)\)$/i);
      if (dupMatch) {
        const count = evaluateConstExpr(
          dupMatch[1].trim(),
          symbols,
          baseOffset + bytes.length
        );
        if (count === null || count < 0 || count > 65535) {
          errors.push({
            line,
            code: 'INVALID_DUP',
            messageTr: `Satır ${line}: Geçersiz DUP tekrar sayısı '${dupMatch[1].trim()}'.`,
            messageEn: `Line ${line}: Invalid DUP count '${dupMatch[1].trim()}'.`,
            rawLine: item,
          });
          continue;
        }
        const inner = dupMatch[2].trim();
        const snapshotLen = bytes.length;
        const tempErrors: IParseError[] = [];
        // Try parsing inner items once to verify validity
        for (let r = 0; r < count; r++) {
          const beforeErr = errors.length;
          processItems(inner);
          if (errors.length > beforeErr) {
            break;
          }
        }
        if (count === 0) {
          // Validate inner even when count is 0
          const savedLen = bytes.length;
          processItems(inner);
          bytes.length = savedLen;
        }
        void snapshotLen;
        void tempErrors;
        continue;
      }

      // String literal (for DB): 'ABCDEFGH' or "Hello" (must have matching quotes!)
      if (directive === 'DB') {
        const strContent = matchQuotedString(item);
        if (strContent !== null) {
          if (strContent.length === 0) {
            continue;
          }
          for (let i = 0; i < strContent.length; i++) {
            bytes.push(strContent.charCodeAt(i) & 0xff);
          }
          continue;
        }
      }

      // Uninitialized '?'
      if (item === '?') {
        pushValue(0);
        continue;
      }

      // Numeric / char literal / EQU / constant expression
      const val = evaluateConstExpr(item, symbols, baseOffset + bytes.length);
      if (val !== null) {
        pushValue(val);
        continue;
      }

      // Deferred label reference inside DW (e.g. TABLE DW ONE, TWO, THREE)
      if (directive === 'DW' && /^[A-Za-z_@?$][A-Za-z0-9_@?$]*$/.test(item)) {
        labelRefs.push({
          byteOffset: baseOffset + bytes.length,
          label: item.toUpperCase(),
        });
        pushValue(0); // Backpatched in Pass 2
        continue;
      }

      errors.push({
        line,
        code: 'INVALID_DATA_ITEM',
        messageTr: `Satır ${line}: Geçersiz veri tanımı '${item}'.`,
        messageEn: `Line ${line}: Invalid data item '${item}'.`,
        rawLine: item,
      });
      return false;
    }
    return true;
  };

  processItems(operandText);
  return { bytes, labelRefs };
}

/**
 * Generates deterministic representative machine bytes for an instruction
 * so inspecting CS:IP in the 1MB Memory Viewer shows realistic code bytes.
 */
export function encodeRepresentativeBytes(inst: IParsedInstruction): Uint8Array {
  const len = Math.max(1, inst.byteLength);
  const out = new Uint8Array(len);
  const m = inst.mnemonic;

  const baseOpcode: Record<string, number> = {
    NOP: 0x90,
    HLT: 0xf4,
    RET: 0xc3,
    RETN: 0xc3,
    RETF: 0xcb,
    IRET: 0xcf,
    CBW: 0x98,
    CWD: 0x99,
    DAA: 0x27,
    DAS: 0x2f,
    AAA: 0x37,
    AAS: 0x3f,
    AAM: 0xd4,
    AAD: 0xd5,
    CLC: 0xf8,
    STC: 0xf9,
    CMC: 0xf5,
    CLD: 0xfc,
    STD: 0xfd,
    CLI: 0xfa,
    STI: 0xfb,
    LAHF: 0x9f,
    SAHF: 0x9e,
    XLAT: 0xd7,
    XLATB: 0xd7,
    PUSHF: 0x9c,
    POPF: 0x9d,
    PUSHA: 0x60,
    POPA: 0x61,
    INTO: 0xce,
    MOVSB: 0xa4,
    MOVSW: 0xa5,
    CMPSB: 0xa6,
    CMPSW: 0xa7,
    STOSB: 0xaa,
    STOSW: 0xab,
    LODSB: 0xac,
    LODSW: 0xad,
    SCASB: 0xae,
    SCASW: 0xaf,
    MOV: 0x89,
    XCHG: 0x87,
    LEA: 0x8d,
    LDS: 0xc5,
    LES: 0xc4,
    ADD: 0x01,
    ADC: 0x11,
    SUB: 0x29,
    SBB: 0x19,
    CMP: 0x39,
    AND: 0x21,
    OR: 0x09,
    XOR: 0x31,
    TEST: 0x85,
    INC: 0x40,
    DEC: 0x48,
    NEG: 0xf7,
    NOT: 0xf7,
    MUL: 0xf7,
    IMUL: 0xf7,
    DIV: 0xf7,
    IDIV: 0xf7,
    PUSH: 0x50,
    POP: 0x58,
    JMP: 0xeb,
    CALL: 0xe8,
    INT: 0xcd,
    LOOP: 0xe2,
    LOOPE: 0xe1,
    LOOPZ: 0xe1,
    LOOPNE: 0xe0,
    LOOPNZ: 0xe0,
    JCXZ: 0xe3,
    JZ: 0x74,
    JE: 0x74,
    JNZ: 0x75,
    JNE: 0x75,
    JC: 0x72,
    JB: 0x72,
    JNAE: 0x72,
    JNC: 0x73,
    JAE: 0x73,
    JNB: 0x73,
    JA: 0x77,
    JNBE: 0x77,
    JBE: 0x76,
    JNA: 0x76,
    JG: 0x7f,
    JNLE: 0x7f,
    JGE: 0x7d,
    JNL: 0x7d,
    JL: 0x7c,
    JNGE: 0x7c,
    JLE: 0x7e,
    JNG: 0x7e,
    JO: 0x70,
    JNO: 0x71,
    JS: 0x78,
    JNS: 0x79,
    JP: 0x7a,
    JPE: 0x7a,
    JNP: 0x7b,
    JPO: 0x7b,
  };

  let idx = 0;
  if (inst.prefix) {
    out[idx++] =
      inst.prefix === 'REPNE' || inst.prefix === 'REPNZ' ? 0xf2 : 0xf3;
  }
  if (idx < len) {
    out[idx++] = baseOpcode[m] ?? 0x90;
  }
  for (const op of inst.operands) {
    if (idx >= len) break;
    if (op.kind === 'immediate') {
      out[idx++] = op.value & 0xff;
      if (idx < len) out[idx++] = (op.value >> 8) & 0xff;
    } else if (op.kind === 'memory') {
      out[idx++] = op.displacement & 0xff;
      if (idx < len) out[idx++] = (op.displacement >> 8) & 0xff;
    } else if (op.kind === 'register') {
      out[idx++] = 0xc0;
    }
  }
  while (idx < len) {
    out[idx++] = 0x00;
  }
  return out;
}

/**
 * Pass 3 Static Validator: inspects all parsed instructions to emit helpful
 * real-emu8086 compatibility warnings (and promotes them to compile errors when strictMode=true).
 */
function runStaticValidation(
  instructions: IParsedInstruction[],
  strictMode: boolean,
  errors: IParseError[],
  warnings: IParseWarning[]
): void {
  const report = (
    diag: IParseWarning,
    alwaysError: boolean = false
  ): void => {
    if (alwaysError || strictMode) {
      errors.push(diag);
    } else {
      warnings.push(diag);
    }
  };

  const zeroOpMnemonics = new Set<string>([
    'CBW',
    'CWD',
    'DAA',
    'DAS',
    'AAA',
    'AAS',
    'AAM',
    'AAD',
    'CLC',
    'STC',
    'CMC',
    'CLD',
    'STD',
    'CLI',
    'STI',
    'LAHF',
    'SAHF',
    'XLAT',
    'XLATB',
    'PUSHF',
    'POPF',
    'PUSHA',
    'POPA',
    'IRET',
    'INTO',
    'NOP',
    'HLT',
    'SCASB',
    'SCASW',
    'CMPSB',
    'CMPSW',
    'MOVSB',
    'MOVSW',
    'STOSB',
    'STOSW',
    'LODSB',
    'LODSW',
  ]);

  const unaryMnemonics = new Set<string>([
    'INC',
    'DEC',
    'NEG',
    'NOT',
    'MUL',
    'IMUL',
    'DIV',
    'IDIV',
    'PUSH',
    'POP',
    'INT',
    ...JUMP_CALL_MNEMONICS,
  ]);

  const binaryMnemonics = new Set<string>([
    'MOV',
    'XCHG',
    'LEA',
    'LDS',
    'LES',
    'ADD',
    'ADC',
    'SUB',
    'SBB',
    'CMP',
    'AND',
    'OR',
    'XOR',
    'TEST',
    'SHL',
    'SAL',
    'SHR',
    'SAR',
    'ROL',
    'ROR',
    'RCL',
    'RCR',
  ]);

  for (const inst of instructions) {
    const m = inst.mnemonic;
    const ops = inst.operands;

    // 1. Direct use of IP register as an operand is illegal on 8086
    for (const op of ops) {
      if (op.kind === 'register' && op.register === 'IP') {
        report(
          {
            line: inst.line,
            code: 'ILLEGAL_IP_OPERAND',
            messageTr: `Satır ${inst.line}: 'IP' (Komut İşaretçisi) doğrudan operand olarak kullanılamaz; akışı değiştirmek için JMP, CALL veya RET kullanın.`,
            messageEn: `Line ${inst.line}: 'IP' (Instruction Pointer) cannot be used directly as an operand; use JMP, CALL, or RET.`,
            rawLine: inst.source,
          },
          true
        );
      }
    }

    // 2. Operand count checks
    if (zeroOpMnemonics.has(m) && ops.length !== 0) {
      report({
        line: inst.line,
        code: 'OPERAND_COUNT',
        messageTr: `Satır ${inst.line}: '${m}' komutu operand almaz (${ops.length} verildi).`,
        messageEn: `Line ${inst.line}: Instruction '${m}' takes 0 operands (got ${ops.length}).`,
        rawLine: inst.source,
      });
      continue;
    }

    if (
      (m === 'RET' || m === 'RETN' || m === 'RETF') &&
      ops.length > 1
    ) {
      report({
        line: inst.line,
        code: 'OPERAND_COUNT',
        messageTr: `Satır ${inst.line}: '${m}' komutu en fazla 1 operand alabilir.`,
        messageEn: `Line ${inst.line}: Instruction '${m}' accepts at most 1 operand.`,
        rawLine: inst.source,
      });
      continue;
    }

    if (unaryMnemonics.has(m) && ops.length !== 1) {
      report({
        line: inst.line,
        code: 'OPERAND_COUNT',
        messageTr: `Satır ${inst.line}: '${m}' komutu 1 operand bekler (${ops.length} verildi).`,
        messageEn: `Line ${inst.line}: Instruction '${m}' expects 1 operand (got ${ops.length}).`,
        rawLine: inst.source,
      });
      continue;
    }

    if (binaryMnemonics.has(m) && ops.length !== 2) {
      report({
        line: inst.line,
        code: 'OPERAND_COUNT',
        messageTr: `Satır ${inst.line}: '${m}' komutu 2 operand bekler (${ops.length} verildi).`,
        messageEn: `Line ${inst.line}: Instruction '${m}' expects 2 operands (got ${ops.length}).`,
        rawLine: inst.source,
      });
      continue;
    }

    // 3. Unary instruction rules
    if (ops.length === 1) {
      const [op] = ops;
      if (
        (m === 'INC' ||
          m === 'DEC' ||
          m === 'NEG' ||
          m === 'NOT' ||
          m === 'MUL' ||
          m === 'IMUL' ||
          m === 'DIV' ||
          m === 'IDIV') &&
        op.kind === 'memory' &&
        !op.explicitSize &&
        !op.symbol
      ) {
        report({
          line: inst.line,
          code: 'AMBIGUOUS_MEMORY_SIZE',
          messageTr: `Satır ${inst.line}: '${m} ${inst.source.split(/\s+/).slice(1).join(' ')}' komutunda bellek boyutu belirtilmemiş. Gerçek emu8086'da derleme hatası almamak için 'BYTE PTR' veya 'WORD PTR' ekleyin.`,
          messageEn: `Line ${inst.line}: Memory operand size is not specified for '${m}'. Add 'BYTE PTR' or 'WORD PTR' for real emu8086 compatibility.`,
          rawLine: inst.source,
        });
      }

      if (m === 'POP' && op.kind === 'register' && op.register === 'CS') {
        report({
          line: inst.line,
          code: 'ILLEGAL_POP_CS',
          messageTr: `Satır ${inst.line}: 'POP CS' komutu Intel 8086 mimarisinde geçersizdir.`,
          messageEn: `Line ${inst.line}: 'POP CS' is illegal in Intel 8086.`,
          rawLine: inst.source,
        });
      }

      if (
        (m === 'PUSH' || m === 'POP') &&
        op.kind === 'register' &&
        op.size === 8
      ) {
        report({
          line: inst.line,
          code: 'WORD_OPERAND_REQUIRED',
          messageTr: `Satır ${inst.line}: '${m}' komutu 16-bit operand gerektirir ('${op.register}' 8-bit).`,
          messageEn: `Line ${inst.line}: '${m}' requires a 16-bit operand ('${op.register}' is 8-bit).`,
          rawLine: inst.source,
        });
      }
    }

    // 4. Binary instruction rules
    if (ops.length === 2) {
      const [dst, src] = ops;

      // Memory-to-memory check
      if (dst.kind === 'memory' && src.kind === 'memory') {
        report({
          line: inst.line,
          code: 'MEMORY_TO_MEMORY',
          messageTr: `Satır ${inst.line}: Intel 8086 bellekten belleğe doğrudan '${m}' işlemini desteklemez; önce bir yazmaca (örn. AX/AL) aktarın.`,
          messageEn: `Line ${inst.line}: Intel 8086 does not allow direct memory-to-memory '${m}'; move through a register (e.g. AX/AL) first.`,
          rawLine: inst.source,
        });
      }

      // Immediate as destination (including CMP 5, AL and TEST 5, AL)
      if (dst.kind === 'immediate' || dst.kind === 'label') {
        report({
          line: inst.line,
          code: 'INVALID_DESTINATION',
          messageTr: `Satır ${inst.line}: '${m}' komutunda birinci (hedef) operand sabit sayı veya etiket olamaz.`,
          messageEn: `Line ${inst.line}: First (destination) operand of '${m}' cannot be an immediate value or label.`,
          rawLine: inst.source,
        });
      }

      // Register size mismatch
      if (dst.kind === 'register' && src.kind === 'register' && m !== 'SHL' && m !== 'SAL' && m !== 'SHR' && m !== 'SAR' && m !== 'ROL' && m !== 'ROR' && m !== 'RCL' && m !== 'RCR') {
        if (dst.size !== src.size) {
          report({
            line: inst.line,
            code: 'OPERAND_SIZE_MISMATCH',
            messageTr: `Satır ${inst.line}: Yazmaç boyutları uyuşmuyor: ${dst.register} (${dst.size}-bit) ve ${src.register} (${src.size}-bit).`,
            messageEn: `Line ${inst.line}: Register size mismatch: ${dst.register} (${dst.size}-bit) and ${src.register} (${src.size}-bit).`,
            rawLine: inst.source,
          });
        }
      }

      // Symbol dataSize vs Register size mismatch (e.g. MOV BX, BYTE_VAR without PTR)
      if (
        m !== 'LEA' &&
        m !== 'LDS' &&
        m !== 'LES' &&
        dst.kind === 'register' &&
        src.kind === 'memory' &&
        !src.explicitSize &&
        src.symbol &&
        src.sizeHint &&
        dst.size !== src.sizeHint
      ) {
        report({
          line: inst.line,
          code: 'SYMBOL_SIZE_MISMATCH',
          messageTr: `Satır ${inst.line}: '${src.symbol}' değişkeni ${src.sizeHint}-bit tanımlanmış ancak '${dst.register}' ${dst.size}-bit. Gerçek emu8086 uyumu için '${dst.size === 16 ? 'WORD' : 'BYTE'} PTR' kullanın.`,
          messageEn: `Line ${inst.line}: Variable '${src.symbol}' is ${src.sizeHint}-bit but '${dst.register}' is ${dst.size}-bit. Use '${dst.size === 16 ? 'WORD' : 'BYTE'} PTR' for real emu8086 compatibility.`,
          rawLine: inst.source,
        });
      }
      if (
        dst.kind === 'memory' &&
        !dst.explicitSize &&
        dst.symbol &&
        dst.sizeHint &&
        src.kind === 'register' &&
        src.size !== dst.sizeHint
      ) {
        report({
          line: inst.line,
          code: 'SYMBOL_SIZE_MISMATCH',
          messageTr: `Satır ${inst.line}: '${dst.symbol}' değişkeni ${dst.sizeHint}-bit tanımlanmış ancak '${src.register}' ${src.size}-bit. Gerçek emu8086 uyumu için '${src.size === 16 ? 'WORD' : 'BYTE'} PTR' kullanın.`,
          messageEn: `Line ${inst.line}: Variable '${dst.symbol}' is ${dst.sizeHint}-bit but '${src.register}' is ${src.size}-bit. Use '${src.size === 16 ? 'WORD' : 'BYTE'} PTR' for real emu8086 compatibility.`,
          rawLine: inst.source,
        });
      }

      // Ambiguous memory + immediate without BYTE PTR / WORD PTR (e.g. MOV [0058H], 04H)
      if (
        dst.kind === 'memory' &&
        !dst.explicitSize &&
        !dst.symbol &&
        src.kind === 'immediate' &&
        m !== 'SHL' &&
        m !== 'SAL' &&
        m !== 'SHR' &&
        m !== 'SAR' &&
        m !== 'ROL' &&
        m !== 'ROR' &&
        m !== 'RCL' &&
        m !== 'RCR'
      ) {
        report({
          line: inst.line,
          code: 'AMBIGUOUS_MEMORY_SIZE',
          messageTr: `Satır ${inst.line}: Bellek hedefinde boyut belirtilmemiş. Gerçek emu8086 derleyicisi 'BYTE PTR' (veya 'b.') ya da 'WORD PTR' (veya 'w.') zorunlu tutar.`,
          messageEn: `Line ${inst.line}: Memory destination has no explicit size. Real emu8086 requires 'BYTE PTR' ('b.') or 'WORD PTR' ('w.').`,
          rawLine: inst.source,
        });
      }

      // Immediate range check (8-bit: -128..255, 16-bit: -32768..65535)
      if (
        src.kind === 'immediate' &&
        m !== 'SHL' &&
        m !== 'SAL' &&
        m !== 'SHR' &&
        m !== 'SAR' &&
        m !== 'ROL' &&
        m !== 'ROR' &&
        m !== 'RCL' &&
        m !== 'RCR'
      ) {
        const targetSize: DataSize | null =
          dst.kind === 'register'
            ? dst.size
            : dst.kind === 'memory' && dst.sizeHint
              ? dst.sizeHint
              : null;
        if (targetSize === 8 && (src.value < -128 || src.value > 0xff)) {
          report({
            line: inst.line,
            code: 'IMMEDIATE_OVERFLOW',
            messageTr: `Satır ${inst.line}: Sabit değer (${src.raw ?? src.value}) 8-bit hedefe sığmıyor (geçerli aralık: -128..255 / 00H..FFH).`,
            messageEn: `Line ${inst.line}: Immediate value (${src.raw ?? src.value}) does not fit in 8-bit destination (valid range: -128..255 / 00H..FFH).`,
            rawLine: inst.source,
          });
        } else if (
          targetSize === 16 &&
          (src.value < -32768 || src.value > 0xffff)
        ) {
          report({
            line: inst.line,
            code: 'IMMEDIATE_OVERFLOW',
            messageTr: `Satır ${inst.line}: Sabit değer (${src.raw ?? src.value}) 16-bit hedefe sığmıyor (geçerli aralık: -32768..65535 / 0000H..FFFFH).`,
            messageEn: `Line ${inst.line}: Immediate value (${src.raw ?? src.value}) does not fit in 16-bit destination (valid range: -32768..65535 / 0000H..FFFFH).`,
            rawLine: inst.source,
          });
        }
      }

      // MOV segment register restrictions
      if (m === 'MOV') {
        if (dst.kind === 'register' && dst.register === 'CS') {
          report({
            line: inst.line,
            code: 'ILLEGAL_CS_MOV',
            messageTr: `Satır ${inst.line}: CS yazmacına MOV ile doğrudan değer atanamaz.`,
            messageEn: `Line ${inst.line}: Cannot move directly into the CS register.`,
            rawLine: inst.source,
          });
        }
        if (
          dst.kind === 'register' &&
          SEGMENT_SET.has(dst.register) &&
          src.kind === 'immediate'
        ) {
          report({
            line: inst.line,
            code: 'ILLEGAL_SEG_IMM',
            messageTr: `Satır ${inst.line}: Segment yazmacına (${dst.register}) doğrudan sabit sayı yüklenemez; önce AX gibi bir genel yazmaca aktarın.`,
            messageEn: `Line ${inst.line}: Cannot load an immediate value directly into segment register ${dst.register}; move via AX first.`,
            rawLine: inst.source,
          });
        }
        if (
          dst.kind === 'register' &&
          SEGMENT_SET.has(dst.register) &&
          src.kind === 'register' &&
          SEGMENT_SET.has(src.register)
        ) {
          report({
            line: inst.line,
            code: 'ILLEGAL_SEG_TO_SEG',
            messageTr: `Satır ${inst.line}: Bir segment yazmacından başka bir segment yazmacına doğrudan MOV yapılamaz.`,
            messageEn: `Line ${inst.line}: Cannot MOV directly from one segment register to another.`,
            rawLine: inst.source,
          });
        }
      }
    }
  }
}

interface IRawInstructionLine {
  line: number;
  source: string;
  prefix?: string;
  mnemonic: string;
  operandText: string;
  offset: number;
  explicitOrgBefore?: number;
}

/**
 * Multi-Pass 8086 Assembly Parser / Assembler.
 *
 * Pass 1: Processes directives (.model, ORG, .data, .code, SEGMENT/ENDS/ASSUME, proc/endp, end, EQU, DB/DW/DD),
 *         collects all code labels and data symbols.
 * Pass 2: Parses every instruction's operands, computes exact 8086 instruction byte lengths,
 *         recalculates exact code/data offsets, and backpatches forward references.
 * Pass 3: Runs static validation for real-emu8086 compatibility warnings & strict-mode checks.
 */
export function assemble(
  sourceCode: string,
  options?: IAssembleOptions
): IAssembledProgram {
  const strictMode = Boolean(options?.strictMode);
  const lines = sourceCode.split(/\r?\n/);
  const errors: IParseError[] = [];
  const warnings: IParseWarning[] = [];
  const symbols: Record<string, ISymbolInfo> = {};
  const labelToIndex: Record<string, number> = {};
  const offsetToIndex: Record<number, number> = {};
  const dataItems: IDataSegmentItem[] = [];
  const rawInstructions: IRawInstructionLine[] = [];

  let section: 'code' | 'data' | 'stack' = 'code';
  let hasModelDirective = false;
  let hasDataSection = false;
  let explicitOrg: number | null = null;
  let pendingOrgForNextInst: number | undefined;
  let customStackSize: number | null = null;
  let dataCursor = 0;
  let inlineCodeDataCursor = 0;
  let pendingDataLabel: { name: string; line: number } | null = null;
  let lastCodeLabelOnPrevLine: { name: string; line: number; instIndex: number } | null =
    null;
  let entryLabel: string | null = null;
  let entryLabelLine = 1;
  let firstProcLabel: string | null = null;
  let endReached = false;

  const registerSymbolCheckDuplicate = (
    name: string,
    info: ISymbolInfo
  ): boolean => {
    const existing = symbols[name];
    if (existing) {
      errors.push({
        line: info.line,
        code: 'DUPLICATE_SYMBOL',
        messageTr: `Satır ${info.line}: '${name}' sembolü veya etiketi zaten satır ${existing.line}'de tanımlanmış.`,
        messageEn: `Line ${info.line}: Symbol or label '${name}' is already defined on line ${existing.line}.`,
      });
      return false;
    }
    symbols[name] = info;
    return true;
  };

  // -------------------------------------------------------------------------
  // PASS 1: Directives, Data Allocations, Labels, Raw Instruction Collection
  // -------------------------------------------------------------------------
  for (let i = 0; i < lines.length; i++) {
    if (endReached) break;
    const lineNum = i + 1;
    const originalLine = lines[i];
    const clean = stripComment(originalLine).trim();
    if (!clean) continue;

    // 1. Dot directives: .model, .stack, .data, .code, .exit, .startup
    if (clean.startsWith('.')) {
      const parts = clean.split(/\s+/);
      const dir = parts[0].toUpperCase();
      if (dir === '.MODEL') {
        hasModelDirective = true;
        continue;
      }
      if (dir === '.STACK') {
        if (parts[1]) {
          const stackVal = parseLiteral(parts[1]);
          if (stackVal !== null && stackVal > 0 && stackVal <= 0xffff) {
            customStackSize = stackVal;
          }
        }
        continue;
      }
      if (dir === '.DATA') {
        section = 'data';
        hasDataSection = true;
        pendingDataLabel = null;
        continue;
      }
      if (dir === '.CODE') {
        section = 'code';
        pendingDataLabel = null;
        continue;
      }
      if (dir === '.STARTUP') {
        continue;
      }
      if (dir === '.EXIT') {
        rawInstructions.push({
          line: lineNum,
          source: originalLine.trim(),
          mnemonic: 'HLT',
          operandText: '',
          offset: 0,
          explicitOrgBefore: pendingOrgForNextInst,
        });
        pendingOrgForNextInst = undefined;
        lastCodeLabelOnPrevLine = null;
        continue;
      }
    }

    // 1b. Classic MASM/TASM SEGMENT / ENDS / ASSUME directives
    const segOpenMatch = clean.match(
      /^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s+SEGMENT(?:\s+.*)?$/i
    );
    if (segOpenMatch) {
      hasModelDirective = true;
      const segName = segOpenMatch[1].toUpperCase();
      const upperLine = clean.toUpperCase();
      if (segName.includes('STACK') || upperLine.includes("'STACK'")) {
        section = 'stack';
      } else if (
        segName.includes('DATA') ||
        segName === 'DSEG' ||
        upperLine.includes("'DATA'")
      ) {
        section = 'data';
        hasDataSection = true;
        symbols[segName] = {
          name: segName,
          kind: 'segment',
          value: MODEL_SMALL_EMU8086_CONFIG.DS,
          offset: MODEL_SMALL_EMU8086_CONFIG.DS,
          line: lineNum,
        };
      } else {
        section = 'code';
        symbols[segName] = {
          name: segName,
          kind: 'segment',
          value: MODEL_SMALL_EMU8086_CONFIG.CS,
          offset: MODEL_SMALL_EMU8086_CONFIG.CS,
          line: lineNum,
        };
      }
      pendingDataLabel = null;
      continue;
    }

    if (/^(?:[A-Za-z_@?$][A-Za-z0-9_@?$]*\s+)?ENDS$/i.test(clean)) {
      pendingDataLabel = null;
      continue;
    }

    if (/^ASSUME\s+/i.test(clean)) {
      continue;
    }

    // 2. ORG directive (e.g., ORG 100h)
    const orgMatch = clean.match(/^ORG\s+(.+)$/i);
    if (orgMatch) {
      const orgVal = evaluateConstExpr(orgMatch[1], symbols);
      if (orgVal === null || orgVal < 0 || orgVal > 0xffff) {
        errors.push({
          line: lineNum,
          code: 'INVALID_ORG',
          messageTr: `Satır ${lineNum}: Geçersiz ORG adresi '${orgMatch[1]}'.`,
          messageEn: `Line ${lineNum}: Invalid ORG address '${orgMatch[1]}'.`,
          rawLine: originalLine,
        });
      } else {
        if (explicitOrg === null && rawInstructions.length === 0) {
          explicitOrg = orgVal;
        }
        if (section === 'data') {
          dataCursor = orgVal;
        } else {
          pendingOrgForNextInst = orgVal;
        }
      }
      continue;
    }

    // 3. EQU constant definition: NAME EQU VALUE (supports expressions like LEN EQU $ - MSG)
    const equMatch = clean.match(/^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const name = equMatch[1].toUpperCase();
      const curLoc =
        section === 'data' ? dataCursor : inlineCodeDataCursor;
      const val = evaluateConstExpr(equMatch[2], symbols, curLoc);
      if (val === null) {
        errors.push({
          line: lineNum,
          code: 'INVALID_EQU',
          messageTr: `Satır ${lineNum}: Geçersiz EQU sabit değeri '${equMatch[2]}'.`,
          messageEn: `Line ${lineNum}: Invalid EQU constant value '${equMatch[2]}'.`,
          rawLine: originalLine,
        });
      } else {
        registerSymbolCheckDuplicate(name, {
          name,
          kind: 'equ',
          value: val,
          offset: val,
          line: lineNum,
        });
      }
      continue;
    }

    // 4. PROC / ENDP directives: `main proc`, `main endp`, or standalone `endp`
    const procMatch = clean.match(
      /^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s+PROC(?:\s+(?:NEAR|FAR))?$/i
    );
    if (procMatch) {
      const procName = procMatch[1].toUpperCase();
      section = 'code';
      const idx = rawInstructions.length;
      if (!firstProcLabel) firstProcLabel = procName;
      if (
        registerSymbolCheckDuplicate(procName, {
          name: procName,
          kind: 'code',
          value: idx,
          offset: 0,
          line: lineNum,
        })
      ) {
        labelToIndex[procName] = idx;
      }
      lastCodeLabelOnPrevLine = null;
      continue;
    }

    if (/^(?:[A-Za-z_@?$][A-Za-z0-9_@?$]*\s+)?ENDP$/i.test(clean)) {
      continue;
    }

    // 5. END directive: `end`, `end main`
    const endMatch = clean.match(/^END(?:\s+([A-Za-z_@?$][A-Za-z0-9_@?$]*))?$/i);
    if (endMatch) {
      if (endMatch[1]) {
        entryLabel = endMatch[1].toUpperCase();
        entryLabelLine = lineNum;
      }
      endReached = true;
      continue;
    }

    // 6. Data definition with optional label: `DATA1 DB 'ABCDEFGH'`, `TABLE: DW ONE`, `DW TWO`
    const dataMatch = clean.match(
      /^(?:([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s*:?\s+)?(DB|DW|DD)\s+(.+)$/i
    );
    if (dataMatch) {
      if (section === 'stack') {
        const { bytes } = parseDataDefinition(
          dataMatch[2].toUpperCase() as 'DB' | 'DW' | 'DD',
          dataMatch[3].trim(),
          0,
          symbols,
          lineNum,
          errors
        );
        if (bytes.length > 0) {
          customStackSize = (customStackSize ?? 0) + bytes.length;
        }
        continue;
      }

      let varName = dataMatch[1]?.toUpperCase();
      let varLine = lineNum;
      const directive = dataMatch[2].toUpperCase() as 'DB' | 'DW' | 'DD';
      const operandText = dataMatch[3].trim();

      // Check if a standalone label on the previous line belongs to this DB/DW/DD
      if (!varName && pendingDataLabel) {
        varName = pendingDataLabel.name;
        varLine = pendingDataLabel.line;
        pendingDataLabel = null;
      } else if (
        !varName &&
        section === 'code' &&
        lastCodeLabelOnPrevLine &&
        lastCodeLabelOnPrevLine.instIndex === rawInstructions.length
      ) {
        // Standalone label in .code immediately followed by DB/DW/DD!
        varName = lastCodeLabelOnPrevLine.name;
        varLine = lastCodeLabelOnPrevLine.line;
        delete labelToIndex[varName];
        delete symbols[varName];
        lastCodeLabelOnPrevLine = null;
      }

      const isInlineCodeData = section === 'code' && !hasDataSection;
      const currentBaseOffset = isInlineCodeData
        ? inlineCodeDataCursor
        : dataCursor;

      const { bytes, labelRefs } = parseDataDefinition(
        directive,
        operandText,
        currentBaseOffset,
        symbols,
        lineNum,
        errors
      );

      if (varName) {
        registerSymbolCheckDuplicate(varName, {
          name: varName,
          kind: 'data',
          value: currentBaseOffset,
          offset: currentBaseOffset,
          dataSize: directive === 'DB' ? 8 : 16,
          inCodeSegment: isInlineCodeData,
          line: varLine,
        });
      }

      dataItems.push({
        name: varName,
        offset: currentBaseOffset,
        size: directive === 'DB' ? 8 : directive === 'DW' ? 16 : 32,
        bytes,
        labelRefs,
        inCodeSegment: isInlineCodeData,
        line: lineNum,
      });

      if (isInlineCodeData) {
        inlineCodeDataCursor += bytes.length;
      } else {
        dataCursor += bytes.length;
      }
      continue;
    }

    // Check standalone label inside .data section (e.g. `MSG:` followed by `DB 'Hello$'`)
    if (section === 'data') {
      const dataLabelOnly = clean.match(/^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s*:$/);
      if (dataLabelOnly) {
        pendingDataLabel = {
          name: dataLabelOnly[1].toUpperCase(),
          line: lineNum,
        };
        continue;
      }
      errors.push({
        line: lineNum,
        code: 'INVALID_DATA_LINE',
        messageTr: `Satır ${lineNum}: .data bölümünde geçersiz tanım '${clean}'.`,
        messageEn: `Line ${lineNum}: Invalid statement in .data section: '${clean}'.`,
        rawLine: originalLine,
      });
      continue;
    }

    // 7. Code label (standalone or inline with instruction): `CPE303:`, `ADD_LP: ADD AL, [BX]`
    let remaining = clean;
    let lastDefinedLabelThisLine: string | null = null;
    while (true) {
      const labelMatch = remaining.match(
        /^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s*:(.*)$/
      );
      if (!labelMatch) break;
      const potentialLabel = labelMatch[1].toUpperCase();
      // Do not treat segment override like `DS:[1234H]` as a label!
      if (SEGMENT_SET.has(potentialLabel)) break;

      const idx = rawInstructions.length;
      if (
        registerSymbolCheckDuplicate(potentialLabel, {
          name: potentialLabel,
          kind: 'code',
          value: idx,
          offset: 0,
          line: lineNum,
        })
      ) {
        labelToIndex[potentialLabel] = idx;
        lastDefinedLabelThisLine = potentialLabel;
      }
      remaining = labelMatch[2].trim();
      if (!remaining) break;
    }

    if (!remaining) {
      if (lastDefinedLabelThisLine) {
        lastCodeLabelOnPrevLine = {
          name: lastDefinedLabelThisLine,
          line: lineNum,
          instIndex: rawInstructions.length,
        };
      }
      continue;
    }

    lastCodeLabelOnPrevLine = null;

    // Inline data after colon label: e.g. `MSG: DB 'Hello$'` (already handled above unless two labels)
    const inlineDataAfterLabel = remaining.match(/^(DB|DW|DD)\s+(.+)$/i);
    if (inlineDataAfterLabel && lastDefinedLabelThisLine) {
      const varName = lastDefinedLabelThisLine;
      delete labelToIndex[varName];
      delete symbols[varName];
      const directive = inlineDataAfterLabel[1].toUpperCase() as 'DB' | 'DW' | 'DD';
      const isInlineCodeData = section === 'code' && !hasDataSection;
      const currentBaseOffset = isInlineCodeData
        ? inlineCodeDataCursor
        : dataCursor;
      const { bytes, labelRefs } = parseDataDefinition(
        directive,
        inlineDataAfterLabel[2].trim(),
        currentBaseOffset,
        symbols,
        lineNum,
        errors
      );
      registerSymbolCheckDuplicate(varName, {
        name: varName,
        kind: 'data',
        value: currentBaseOffset,
        offset: currentBaseOffset,
        dataSize: directive === 'DB' ? 8 : 16,
        inCodeSegment: isInlineCodeData,
        line: lineNum,
      });
      dataItems.push({
        name: varName,
        offset: currentBaseOffset,
        size: directive === 'DB' ? 8 : directive === 'DW' ? 16 : 32,
        bytes,
        labelRefs,
        inCodeSegment: isInlineCodeData,
        line: lineNum,
      });
      if (isInlineCodeData) {
        inlineCodeDataCursor += bytes.length;
      } else {
        dataCursor += bytes.length;
      }
      continue;
    }

    // 8. Instruction line (optional REP/REPE/REPNE prefix + mnemonic + operands)
    const tokenMatch = remaining.match(/^([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/);
    if (!tokenMatch) {
      errors.push({
        line: lineNum,
        code: 'SYNTAX_ERROR',
        messageTr: `Satır ${lineNum}: Sözdizimi hatası '${remaining}'.`,
        messageEn: `Line ${lineNum}: Syntax error '${remaining}'.`,
        rawLine: originalLine,
      });
      continue;
    }

    let firstWord = tokenMatch[1].toUpperCase();
    let rest = (tokenMatch[2] ?? '').trim();
    let prefix: string | undefined;

    if (PREFIX_SET.has(firstWord)) {
      prefix = firstWord;
      const nextMatch = rest.match(/^([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/);
      if (!nextMatch) {
        errors.push({
          line: lineNum,
          code: 'MISSING_PREFIX_INSTRUCTION',
          messageTr: `Satır ${lineNum}: '${prefix}' önekini takip eden bir komut bekleniyor (örn. SCASB, CMPSB).`,
          messageEn: `Line ${lineNum}: Expected instruction after prefix '${prefix}' (e.g., SCASB, CMPSB).`,
          rawLine: originalLine,
        });
        continue;
      }
      firstWord = nextMatch[1].toUpperCase();
      rest = (nextMatch[2] ?? '').trim();
    }

    if (!SUPPORTED_MNEMONICS.has(firstWord)) {
      errors.push({
        line: lineNum,
        code: 'UNKNOWN_INSTRUCTION',
        messageTr: `Satır ${lineNum}: Bilinmeyen veya desteklenmeyen komut '${firstWord}'.`,
        messageEn: `Line ${lineNum}: Unknown or unsupported instruction '${firstWord}'.`,
        rawLine: originalLine,
      });
      continue;
    }

    rawInstructions.push({
      line: lineNum,
      source: originalLine.trim(),
      prefix,
      mnemonic: firstWord,
      operandText: rest,
      offset: 0,
      explicitOrgBefore: pendingOrgForNextInst,
    });
    pendingOrgForNextInst = undefined;
  }

  // Determine initial emu8086 segment configuration
  const initialConfig: IInitialSegmentConfig =
    explicitOrg !== null
      ? { ...DEFAULT_EMU8086_CONFIG, IP: explicitOrg }
      : hasModelDirective
        ? { ...MODEL_SMALL_EMU8086_CONFIG }
        : { ...DEFAULT_EMU8086_CONFIG };

  if (customStackSize !== null && customStackSize > 0) {
    initialConfig.SP = customStackSize & 0xffff;
  }

  // Initial preliminary code offsets (will be refined to exact byte lengths after operand parsing)
  let prelimOffset = initialConfig.IP;
  for (let idx = 0; idx < rawInstructions.length; idx++) {
    if (rawInstructions[idx].explicitOrgBefore !== undefined) {
      prelimOffset = rawInstructions[idx].explicitOrgBefore!;
    }
    rawInstructions[idx].offset = prelimOffset;
    const opCount = rawInstructions[idx].operandText
      ? splitCommaList(rawInstructions[idx].operandText).length
      : 0;
    const stride = opCount === 0 ? 1 : opCount === 1 ? 2 : 3;
    prelimOffset = (prelimOffset + stride) & 0xffff;
  }

  // Place inline code-segment data items right after preliminary code end so Pass 2 symbols exist
  const prelimCodeEnd = prelimOffset;
  for (const item of dataItems) {
    if (item.inCodeSegment && item.name && symbols[item.name]) {
      symbols[item.name].offset = (prelimCodeEnd + item.offset) & 0xffff;
      symbols[item.name].value = symbols[item.name].offset;
    }
  }

  for (const sym of Object.values(symbols)) {
    if (sym.kind === 'code') {
      const targetInst = rawInstructions[sym.value];
      sym.offset = targetInst ? targetInst.offset : prelimOffset;
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2: Parse Instruction Operands & Recalculate Exact 8086 Byte Offsets
  // -------------------------------------------------------------------------
  const instructions: IParsedInstruction[] = [];
  for (const raw of rawInstructions) {
    const rawOperands = raw.operandText ? splitCommaList(raw.operandText) : [];
    const parsedOperands: Operand[] = [];
    for (const rawOp of rawOperands) {
      const op = parseOperand(
        rawOp,
        raw.mnemonic,
        symbols,
        initialConfig.DS,
        initialConfig.CS,
        raw.offset,
        raw.line,
        errors
      );
      if (op) parsedOperands.push(op);
    }

    const byteLength = computeInstructionByteLength(
      raw.mnemonic,
      parsedOperands,
      raw.prefix
    );
    instructions.push({
      line: raw.line,
      source: raw.source,
      prefix: raw.prefix,
      mnemonic: raw.mnemonic,
      operands: parsedOperands,
      offset: raw.offset,
      byteLength,
    });
  }

  // Recalculate exact sequential offsets using real 8086 instruction byte lengths
  let exactCodeOffset = initialConfig.IP;
  for (let idx = 0; idx < instructions.length; idx++) {
    if (rawInstructions[idx].explicitOrgBefore !== undefined) {
      exactCodeOffset = rawInstructions[idx].explicitOrgBefore!;
    }
    instructions[idx].offset = exactCodeOffset;
    offsetToIndex[exactCodeOffset] = idx;
    exactCodeOffset = (exactCodeOffset + instructions[idx].byteLength) & 0xffff;
  }

  // Update code label offsets to exact offsets
  for (const sym of Object.values(symbols)) {
    if (sym.kind === 'code') {
      const targetInst = instructions[sym.value];
      sym.offset = targetInst ? targetInst.offset : exactCodeOffset;
    }
  }

  // Update inline code-segment data offsets (placed right after code in ORG 100h programs)
  const exactInlineDataBase = Math.max(initialConfig.IP, exactCodeOffset);
  for (const item of dataItems) {
    if (item.inCodeSegment) {
      const finalOff = (exactInlineDataBase + item.offset) & 0xffff;
      if (item.name && symbols[item.name]) {
        symbols[item.name].offset = finalOff;
        symbols[item.name].value = finalOff;
      }
    }
  }

  // Backpatch operands that referenced code label offsets or inline code-segment data symbols
  for (const inst of instructions) {
    for (const op of inst.operands) {
      if (op.kind === 'immediate' && op.codeLabelRef && symbols[op.codeLabelRef]) {
        op.value = symbols[op.codeLabelRef].offset;
      } else if (op.kind === 'immediate' && op.fromSymbol && op.raw) {
        const offMatch = op.raw.match(
          /^OFFSET\s+([A-Za-z_@?$][A-Za-z0-9_@?$]*)(?:\s*([+-].+))?$/i
        );
        if (offMatch) {
          const sym = symbols[offMatch[1].toUpperCase()];
          if (sym) {
            const extra = offMatch[2]
              ? evaluateConstExpr(offMatch[2], symbols, inst.offset) ?? 0
              : 0;
            op.value = (sym.offset + extra) & 0xffff;
          }
        }
      } else if (
        op.kind === 'memory' &&
        op.symbol &&
        symbols[op.symbol]?.inCodeSegment
      ) {
        const sym = symbols[op.symbol];
        // Re-anchor displacement to final inline code data offset
        const oldBase = (prelimCodeEnd + (sym.offset - exactInlineDataBase)) & 0xffff;
        const delta = op.displacement - oldBase;
        op.displacement = (sym.offset + delta) & 0xffff;
      }
    }
  }

  // Assemble flat dataBytes buffer (for .data segment) & inlineCodeData (for ORG 100h inline data)
  const dataBytes = new Uint8Array(dataCursor);
  const inlineCodeData: Array<{ offset: number; bytes: Uint8Array }> = [];

  for (const item of dataItems) {
    if (item.inCodeSegment) {
      const buf = new Uint8Array(item.bytes.length);
      for (let j = 0; j < item.bytes.length; j++) {
        buf[j] = item.bytes[j];
      }
      if (item.labelRefs) {
        for (const ref of item.labelRefs) {
          const target = symbols[ref.label];
          const localOff = ref.byteOffset - item.offset;
          if (!target) {
            errors.push({
              line: item.line,
              code: 'UNKNOWN_DATA_LABEL',
              messageTr: `Satır ${item.line}: Veri tablosunda tanımlanmamış etiket '${ref.label}'.`,
              messageEn: `Line ${item.line}: Undefined label '${ref.label}' in data table.`,
            });
          } else {
            buf[localOff] = target.offset & 0xff;
            buf[localOff + 1] = (target.offset >> 8) & 0xff;
          }
        }
      }
      inlineCodeData.push({
        offset: (exactInlineDataBase + item.offset) & 0xffff,
        bytes: buf,
      });
      continue;
    }

    for (let j = 0; j < item.bytes.length; j++) {
      dataBytes[item.offset + j] = item.bytes[j];
    }
    if (item.labelRefs) {
      for (const ref of item.labelRefs) {
        const target = symbols[ref.label];
        if (!target) {
          errors.push({
            line: item.line,
            code: 'UNKNOWN_DATA_LABEL',
            messageTr: `Satır ${item.line}: Veri tablosunda tanımlanmamış etiket '${ref.label}'.`,
            messageEn: `Line ${item.line}: Undefined label '${ref.label}' in data table.`,
          });
        } else {
          dataBytes[ref.byteOffset] = target.offset & 0xff;
          dataBytes[ref.byteOffset + 1] = (target.offset >> 8) & 0xff;
        }
      }
    }
  }

  // Determine entry index:
  // - If `END <label>` was given, validate that `<label>` exists and start there.
  // - Else if `ORG` was NOT explicitly set (EXE / .model small), start at `firstProcLabel` if present.
  // - Under `ORG 100h` (COM style) without `END <label>`, ALWAYS start at instruction 0!
  let entryIndex = 0;
  if (entryLabel) {
    if (labelToIndex[entryLabel] !== undefined) {
      entryIndex = labelToIndex[entryLabel];
    } else {
      errors.push({
        line: entryLabelLine,
        code: 'UNKNOWN_ENTRY_LABEL',
        messageTr: `Satır ${entryLabelLine}: END yönergesinde belirtilen başlangıç etiketi '${entryLabel}' bulunamadı.`,
        messageEn: `Line ${entryLabelLine}: Entry label '${entryLabel}' specified in END directive was not found.`,
      });
    }
  } else if (
    explicitOrg === null &&
    firstProcLabel &&
    labelToIndex[firstProcLabel] !== undefined
  ) {
    entryIndex = labelToIndex[firstProcLabel];
  }

  if (instructions[entryIndex]) {
    initialConfig.IP = instructions[entryIndex].offset;
  }

  // -------------------------------------------------------------------------
  // PASS 3: Static Validation & Real-emu8086 Compatibility Diagnostics
  // -------------------------------------------------------------------------
  if (errors.length === 0) {
    runStaticValidation(instructions, strictMode, errors, warnings);
  }

  return {
    sourceCode,
    instructions,
    symbols,
    labelToIndex,
    offsetToIndex,
    dataBytes,
    inlineCodeData,
    initialConfig,
    entryIndex,
    errors,
    warnings,
  };
}
