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
  line: number;
}

export interface ISymbolInfo {
  name: string;
  kind: 'code' | 'data' | 'equ';
  /** Instruction index (for code), DS offset (for data), or constant value (for equ) */
  value: number;
  /** Offset in CS (for code labels) or DS (for data symbols) */
  offset: number;
  /** Byte width for .data variables (8 for DB, 16 for DW) */
  dataSize?: DataSize;
  line: number;
}

export interface IParseError {
  line: number;
  code: string;
  messageTr: string;
  messageEn: string;
  rawLine?: string;
}

export interface IAssembledProgram {
  instructions: IParsedInstruction[];
  symbols: Record<string, ISymbolInfo>;
  /** Maps uppercase code label -> instruction array index */
  labelToIndex: Record<string, number>;
  /** Maps code segment offset -> instruction array index */
  offsetToIndex: Record<number, number>;
  /** Data bytes to preload into DS:0000+ */
  dataBytes: Uint8Array;
  /** Initial segment/pointer configuration derived from directives (ORG / .model) */
  initialConfig: IInitialSegmentConfig;
  /** Entry instruction index (from `end <label>` or `main proc` or 0) */
  entryIndex: number;
  errors: IParseError[];
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
  'PUSH',
  'POP',
  'PUSHF',
  'POPF',
  'RET',
  'NOP',
  'HLT',
  'INT',
  'SCASB',
  'CMPSB',
  'MOVSB',
  'STOSB',
  'LODSB',
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
 * Parses an 8086 numeric or character literal:
 * - Hex: 0F5H, 5000h, 0x1234, -04H
 * - Binary: 10110101b, 00001001B
 * - Octal: 17o, 17q
 * - Decimal: 5, 200, +127, -128, -48
 * - Character: 'A', '8', ’1’
 */
export function parseLiteral(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Single character literal: 'A' or ’A’ or "A"
  const charMatch = trimmed.match(/^['‘’"](.)['‘’"]$/);
  if (charMatch) {
    return charMatch[1].charCodeAt(0);
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

  // ...H hexadecimal (MASM/emu8086 standard: starts with digit or hex digit)
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
 * Estimates realistic 8086 instruction byte size so IP progresses like emu8086.
 */
function estimateByteLength(mnemonic: string, operands: Operand[]): number {
  if (operands.length === 0) return 1;
  if (JUMP_CALL_MNEMONICS.has(mnemonic)) {
    return mnemonic === 'CALL' ? 3 : 2;
  }
  if (operands.length === 1) {
    const op = operands[0];
    if (op.kind === 'register') return 1;
    if (op.kind === 'memory') return op.displacement !== 0 ? 4 : 2;
    return 2;
  }
  const [dst, src] = operands;
  if (dst.kind === 'register' && src.kind === 'immediate') {
    return dst.size === 8 ? 2 : 3;
  }
  if (dst.kind === 'register' && src.kind === 'register') {
    return 2;
  }
  if (dst.kind === 'memory' && src.kind === 'immediate') {
    const is16 = dst.sizeHint === 16 || src.value > 0xff || src.value < -128;
    return is16 ? 6 : 5;
  }
  return 3;
}

/**
 * Parses a memory operand like:
 *   [0058H], [0053H], [BX], [BX+DI], [BX][DI], [BX+1000H], [BX+SI+0100H],
 *   DS:[1234H], BYTE PTR [5000H], WORD PTR [DI], b.[05000h], w.[5000H], ARRAY[SI+2]
 */
function parseMemoryOperand(
  rawText: string,
  symbols: Record<string, ISymbolInfo>,
  line: number,
  errors: IParseError[]
): IMemoryOperand | null {
  let text = rawText.trim();
  let sizeHint: DataSize | undefined;
  let segmentOverride: SegmentRegister | undefined;

  // 1. Check size prefix: BYTE PTR / WORD PTR / b. / w.
  const ptrMatch = text.match(/^(BYTE|WORD)\s+PTR\s+(.+)$/i);
  if (ptrMatch) {
    sizeHint = ptrMatch[1].toUpperCase() === 'BYTE' ? 8 : 16;
    text = ptrMatch[2].trim();
  } else {
    const shortPtrMatch = text.match(/^([BW])\.\s*(.+)$/i);
    if (shortPtrMatch) {
      sizeHint = shortPtrMatch[1].toUpperCase() === 'B' ? 8 : 16;
      text = shortPtrMatch[2].trim();
    }
  }

  // 2. Check segment override: DS:[...], ES:[...], SS:[...], CS:[...]
  const segMatch = text.match(/^(CS|DS|SS|ES)\s*:\s*(.+)$/i);
  if (segMatch) {
    segmentOverride = segMatch[1].toUpperCase() as SegmentRegister;
    text = segMatch[2].trim();
  }

  // 3. Check optional symbol prefix before brackets: ARRAY[SI+2] or ARRAY[BX+SI]
  let symbol: string | undefined;
  let displacement = 0;
  let innerExpr = '';

  const bracketIdx = text.indexOf('[');
  if (bracketIdx === -1) {
    // Not a bracketed expression -> could be a direct symbolic variable (e.g. DATA1)
    const upperSym = text.toUpperCase();
    const sym = symbols[upperSym];
    if (sym && sym.kind === 'data') {
      return {
        kind: 'memory',
        segmentOverride,
        displacement: sym.offset,
        symbol: upperSym,
        sizeHint: sizeHint ?? sym.dataSize,
      };
    }
    return null;
  }

  if (bracketIdx > 0) {
    const prefixSym = text.slice(0, bracketIdx).trim().replace(/\+$/, '').trim();
    if (prefixSym) {
      const litPrefix = parseLiteral(prefixSym);
      if (litPrefix !== null) {
        displacement += litPrefix;
      } else {
        const upperSym = prefixSym.toUpperCase();
        const sym = symbols[upperSym];
        if (sym && sym.kind === 'data') {
          symbol = upperSym;
          displacement += sym.offset;
          if (!sizeHint && sym.dataSize) sizeHint = sym.dataSize;
        } else if (sym && sym.kind === 'equ') {
          displacement += sym.value;
        } else {
          errors.push({
            line,
            code: 'UNKNOWN_SYMBOL',
            messageTr: `Satır ${line}: Tanımlanmamış bellek sembolü '${prefixSym}'.`,
            messageEn: `Line ${line}: Undefined memory symbol '${prefixSym}'.`,
            rawLine: rawText,
          });
          return null;
        }
      }
    }
  }

  // Convert Intel double-bracket syntax `[BX][DI]` -> `BX+DI`
  const bracketPart = text.slice(bracketIdx).trim();
  if (!bracketPart.endsWith(']')) {
    errors.push({
      line,
      code: 'UNCLOSED_BRACKET',
      messageTr: `Satır ${line}: Bellek adresinde kapanmamış köşeli parantez '['.`,
      messageEn: `Line ${line}: Unclosed bracket '[' in memory operand.`,
      rawLine: rawText,
    });
    return null;
  }

  // Extract all [...] groups and join them with '+'
  const groups: string[] = [];
  const groupRegex = /\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = groupRegex.exec(bracketPart)) !== null) {
    groups.push(match[1].trim());
  }
  const leftover = bracketPart.replace(/\[[^\]]+\]/g, '').trim();
  if (groups.length === 0 || leftover.length > 0) {
    errors.push({
      line,
      code: 'INVALID_MEMORY_EXPR',
      messageTr: `Satır ${line}: Geçersiz bellek adres ifadesi '${rawText}'.`,
      messageEn: `Line ${line}: Invalid memory address expression '${rawText}'.`,
      rawLine: rawText,
    });
    return null;
  }

  innerExpr = groups.join('+');

  // Tokenize inner expression into signed terms: e.g. BX + SI - 4 + 0100H
  const terms: Array<{ sign: number; token: string }> = [];
  let cur = '';
  let curSign = 1;
  for (let i = 0; i < innerExpr.length; i++) {
    const ch = innerExpr[i];
    if (ch === '+' || ch === '-') {
      if (cur.trim()) {
        terms.push({ sign: curSign, token: cur.trim() });
      }
      curSign = ch === '+' ? 1 : -1;
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    terms.push({ sign: curSign, token: cur.trim() });
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

    const lit = parseLiteral(term.token);
    if (lit !== null) {
      displacement += term.sign * lit;
      continue;
    }

    const sym = symbols[upper];
    if (sym && (sym.kind === 'data' || sym.kind === 'equ')) {
      displacement += term.sign * (sym.kind === 'data' ? sym.offset : sym.value);
      if (sym.kind === 'data' && !symbol) {
        symbol = upper;
        if (!sizeHint && sym.dataSize) sizeHint = sym.dataSize;
      }
      continue;
    }

    errors.push({
      line,
      code: 'INVALID_MEMORY_TERM',
      messageTr: `Satır ${line}: Bellek adresinde tanınmayan ifade '${term.token}'.`,
      messageEn: `Line ${line}: Unrecognized term '${term.token}' in memory operand.`,
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

  // 1. Special @DATA symbol (e.g. MOV AX, @DATA)
  if (upper === '@DATA') {
    return { kind: 'immediate', value: dataSegment, raw: text };
  }

  // 2. OFFSET <symbol> directive (e.g. MOV DI, OFFSET DATA1)
  const offsetMatch = text.match(/^OFFSET\s+([A-Za-z_@?$][A-Za-z0-9_@?$]*)$/i);
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
    return { kind: 'immediate', value: sym.offset, raw: text };
  }

  // 3. Register operand
  if (ALL_REGISTERS.has(upper)) {
    const reg = upper as RegisterName;
    const op: IRegisterOperand = {
      kind: 'register',
      register: reg,
      size: isRegister8(reg) ? 8 : 16,
    };
    return op;
  }

  // 4. Jump / Call label operand (unless it's a memory operand like JMP [SI])
  if (JUMP_CALL_MNEMONICS.has(mnemonic) && !text.includes('[')) {
    const sym = symbols[upper];
    if (sym && sym.kind === 'code') {
      const labelOp: ILabelOperand = { kind: 'label', name: upper };
      return labelOp;
    }
    const lit = parseLiteral(text);
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

  // 5. Memory operand (bracketed, PTR, segment override, or .data variable name)
  if (
    text.includes('[') ||
    /^(BYTE|WORD)\s+PTR\b/i.test(text) ||
    /^[BW]\./i.test(text) ||
    /^(CS|DS|SS|ES)\s*:/i.test(text)
  ) {
    return parseMemoryOperand(text, symbols, line, errors);
  }

  // 6. Numeric or character literal
  const lit = parseLiteral(text);
  if (lit !== null) {
    const immOp: IImmediateOperand = { kind: 'immediate', value: lit, raw: text };
    return immOp;
  }

  // 7. Known symbol (.data variable -> direct memory, EQU -> immediate)
  const sym = symbols[upper];
  if (sym) {
    if (sym.kind === 'equ') {
      return { kind: 'immediate', value: sym.value, raw: text };
    }
    if (sym.kind === 'data') {
      return {
        kind: 'memory',
        displacement: sym.offset,
        symbol: upper,
        sizeHint: sym.dataSize,
      };
    }
    if (sym.kind === 'code') {
      return { kind: 'immediate', value: sym.offset, raw: text };
    }
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
  line: number,
  errors: IParseError[]
): { bytes: number[]; labelRefs: Array<{ byteOffset: number; label: string }> } {
  const bytes: number[] = [];
  const labelRefs: Array<{ byteOffset: number; label: string }> = [];
  const items = splitCommaList(operandText);

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

  for (const item of items) {
    // Check DUP syntax: e.g. 5 DUP(0) or 10 DUP(?)
    const dupMatch = item.match(/^([0-9A-Fa-fHhBb]+)\s+DUP\s*\((.+)\)$/i);
    if (dupMatch) {
      const count = parseLiteral(dupMatch[1]);
      if (count === null || count < 0 || count > 65535) {
        errors.push({
          line,
          code: 'INVALID_DUP',
          messageTr: `Satır ${line}: Geçersiz DUP tekrar sayısı '${dupMatch[1]}'.`,
          messageEn: `Line ${line}: Invalid DUP count '${dupMatch[1]}'.`,
          rawLine: item,
        });
        continue;
      }
      const inner = dupMatch[2].trim();
      const val = inner === '?' ? 0 : parseLiteral(inner);
      if (val === null) {
        errors.push({
          line,
          code: 'INVALID_DUP_VALUE',
          messageTr: `Satır ${line}: Geçersiz DUP değeri '${inner}'.`,
          messageEn: `Line ${line}: Invalid DUP value '${inner}'.`,
          rawLine: item,
        });
        continue;
      }
      for (let i = 0; i < count; i++) {
        pushValue(val);
      }
      continue;
    }

    // String literal (for DB): 'ABCDEFGH' or "Hello"
    const strMatch = item.match(/^(['‘’"])(.*)(['‘’"])$/);
    if (strMatch && directive === 'DB') {
      const content = strMatch[2];
      for (let i = 0; i < content.length; i++) {
        bytes.push(content.charCodeAt(i) & 0xff);
      }
      continue;
    }

    // Uninitialized '?'
    if (item === '?') {
      pushValue(0);
      continue;
    }

    // Numeric / single char literal
    const lit = parseLiteral(item);
    if (lit !== null) {
      pushValue(lit);
      continue;
    }

    // Label reference inside DW (e.g. TABLE DW ONE, TWO, THREE)
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
  }

  return { bytes, labelRefs };
}

interface IRawInstructionLine {
  line: number;
  source: string;
  prefix?: string;
  mnemonic: string;
  operandText: string;
  offset: number;
}

/**
 * Two-Pass 8086 Assembly Parser / Assembler.
 *
 * Pass 1: Processes directives (.model, ORG, .data, .code, proc/endp, end, EQU, DB/DW/DD),
 *         collects all code labels and data symbols, and computes offsets.
 * Pass 2: Parses every instruction's operands, resolves labels/symbols/OFFSET/@DATA,
 *         and backpatches forward references in `.data`.
 */
export function assemble(sourceCode: string): IAssembledProgram {
  const lines = sourceCode.split(/\r?\n/);
  const errors: IParseError[] = [];
  const symbols: Record<string, ISymbolInfo> = {};
  const labelToIndex: Record<string, number> = {};
  const offsetToIndex: Record<number, number> = {};
  const dataItems: IDataSegmentItem[] = [];
  const rawInstructions: IRawInstructionLine[] = [];

  let section: 'code' | 'data' = 'code';
  let hasModelDirective = false;
  let explicitOrg: number | null = null;
  let dataCursor = 0;
  let entryLabel: string | null = null;
  let firstProcLabel: string | null = null;
  let endReached = false;

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
        continue;
      }
      if (dir === '.DATA') {
        section = 'data';
        continue;
      }
      if (dir === '.CODE') {
        section = 'code';
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
        });
        continue;
      }
    }

    // 2. ORG directive (e.g., ORG 100h)
    const orgMatch = clean.match(/^ORG\s+(.+)$/i);
    if (orgMatch) {
      const orgVal = parseLiteral(orgMatch[1]);
      if (orgVal === null || orgVal < 0 || orgVal > 0xffff) {
        errors.push({
          line: lineNum,
          code: 'INVALID_ORG',
          messageTr: `Satır ${lineNum}: Geçersiz ORG adresi '${orgMatch[1]}'.`,
          messageEn: `Line ${lineNum}: Invalid ORG address '${orgMatch[1]}'.`,
          rawLine: originalLine,
        });
      } else {
        explicitOrg = orgVal;
      }
      continue;
    }

    // 3. EQU constant definition: NAME EQU VALUE
    const equMatch = clean.match(/^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const name = equMatch[1].toUpperCase();
      const val = parseLiteral(equMatch[2]);
      if (val === null) {
        errors.push({
          line: lineNum,
          code: 'INVALID_EQU',
          messageTr: `Satır ${lineNum}: Geçersiz EQU sabit değeri '${equMatch[2]}'.`,
          messageEn: `Line ${lineNum}: Invalid EQU constant value '${equMatch[2]}'.`,
          rawLine: originalLine,
        });
      } else {
        symbols[name] = {
          name,
          kind: 'equ',
          value: val,
          offset: val,
          line: lineNum,
        };
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
      labelToIndex[procName] = idx;
      symbols[procName] = {
        name: procName,
        kind: 'code',
        value: idx,
        offset: 0, // Backfilled after offsets calculated
        line: lineNum,
      };
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
      }
      endReached = true;
      continue;
    }

    // 6. Data definition with optional label: `DATA1 DB 'ABCDEFGH'`, `TABLE: DW ONE`, `DW TWO`
    const dataMatch = clean.match(
      /^(?:([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s*:?\s+)?(DB|DW|DD)\s+(.+)$/i
    );
    if (dataMatch) {
      const varName = dataMatch[1]?.toUpperCase();
      const directive = dataMatch[2].toUpperCase() as 'DB' | 'DW' | 'DD';
      const operandText = dataMatch[3].trim();

      const { bytes, labelRefs } = parseDataDefinition(
        directive,
        operandText,
        dataCursor,
        lineNum,
        errors
      );

      if (varName) {
        symbols[varName] = {
          name: varName,
          kind: 'data',
          value: dataCursor,
          offset: dataCursor,
          dataSize: directive === 'DB' ? 8 : 16,
          line: lineNum,
        };
      }

      dataItems.push({
        name: varName,
        offset: dataCursor,
        size: directive === 'DB' ? 8 : directive === 'DW' ? 16 : 32,
        bytes,
        labelRefs,
        line: lineNum,
      });
      dataCursor += bytes.length;
      continue;
    }

    // If inside .data section and not a recognized data definition, report error
    if (section === 'data') {
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
    while (true) {
      const labelMatch = remaining.match(
        /^([A-Za-z_@?$][A-Za-z0-9_@?$]*)\s*:(.*)$/
      );
      if (!labelMatch) break;
      const potentialLabel = labelMatch[1].toUpperCase();
      // Do not treat segment override like `DS:[1234H]` as a label!
      if (SEGMENT_SET.has(potentialLabel)) break;

      const idx = rawInstructions.length;
      labelToIndex[potentialLabel] = idx;
      symbols[potentialLabel] = {
        name: potentialLabel,
        kind: 'code',
        value: idx,
        offset: 0,
        line: lineNum,
      };
      remaining = labelMatch[2].trim();
      if (!remaining) break;
    }

    if (!remaining) continue;

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
    });
  }

  // Determine initial emu8086 segment configuration
  const initialConfig: IInitialSegmentConfig =
    explicitOrg !== null
      ? { ...DEFAULT_EMU8086_CONFIG, IP: explicitOrg }
      : hasModelDirective
      ? { ...MODEL_SMALL_EMU8086_CONFIG }
      : { ...DEFAULT_EMU8086_CONFIG };

  // Pre-compute approximate offsets for code labels before Pass 2 (updated accurately during Pass 2)
  let codeOffset = initialConfig.IP;
  for (let idx = 0; idx < rawInstructions.length; idx++) {
    rawInstructions[idx].offset = codeOffset;
    offsetToIndex[codeOffset] = idx;
    // Rough pre-pass stride (refined once operands parsed, kept deterministic)
    const opCount = rawInstructions[idx].operandText
      ? splitCommaList(rawInstructions[idx].operandText).length
      : 0;
    const stride = opCount === 0 ? 1 : opCount === 1 ? 2 : 3;
    codeOffset = (codeOffset + stride) & 0xffff;
  }

  // Update code label offsets
  for (const sym of Object.values(symbols)) {
    if (sym.kind === 'code') {
      const targetInst = rawInstructions[sym.value];
      sym.offset = targetInst ? targetInst.offset : codeOffset;
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2: Parse Instruction Operands & Backpatch Data Label References
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
        raw.line,
        errors
      );
      if (op) parsedOperands.push(op);
    }

    const byteLength = estimateByteLength(raw.mnemonic, parsedOperands);
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

  // Assemble flat dataBytes buffer & backpatch DW label refs
  const dataBytes = new Uint8Array(dataCursor);
  for (const item of dataItems) {
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

  // Determine entry index
  let entryIndex = 0;
  if (entryLabel && labelToIndex[entryLabel] !== undefined) {
    entryIndex = labelToIndex[entryLabel];
  } else if (firstProcLabel && labelToIndex[firstProcLabel] !== undefined) {
    entryIndex = labelToIndex[firstProcLabel];
  }

  if (instructions[entryIndex]) {
    initialConfig.IP = instructions[entryIndex].offset;
  }

  return {
    instructions,
    symbols,
    labelToIndex,
    offsetToIndex,
    dataBytes,
    initialConfig,
    entryIndex,
    errors,
  };
}
