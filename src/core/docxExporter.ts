import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { formatHex } from './memory';
import { type ITraceEntry, type ITraceMemoryWrite } from './executor';
import { type FlagName, type RegisterName, type SegmentRegister } from './types';

export interface IDocxExportOptions {
  programName: string;
  sourceCode: string;
  traceLog: readonly ITraceEntry[];
  truncated?: boolean;
  locale: 'tr' | 'en';
  generatedAt?: Date;
}

const FONT_SANS = 'Calibri';
const FONT_MONO = 'Consolas';

const COLOR_TEXT = '18181B';
const COLOR_MUTED = '6B7280';
const COLOR_BORDER = 'D1D5DB';
const COLOR_HEADER_BG = 'F3F4F6';
const COLOR_ZEBRA_BG = 'FAFAFA';
const COLOR_REG_CHANGED_BG = 'EBF3FE';
const COLOR_REG_CHANGED_TEXT = '1D4ED8';
const COLOR_FLAG_CHANGED_BG = 'FEF3C7';
const COLOR_FLAG_CHANGED_TEXT = '92400E';
const COLOR_INITIAL_BG = 'F4F4F5';

const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
};

const CELL_MARGINS = {
  top: 60,
  bottom: 60,
  left: 80,
  right: 80,
};

const TRACKED_SEGMENTS: SegmentRegister[] = ['DS', 'ES', 'SS', 'CS'];

export function formatTraceMemoryAndSegments(
  writes: readonly ITraceMemoryWrite[],
  changedRegisters: readonly RegisterName[],
  registers: ITraceEntry['registers']
): string {
  const parts: string[] = [];

  for (const seg of TRACKED_SEGMENTS) {
    if (changedRegisters.includes(seg)) {
      parts.push(`${seg}=${formatHex(registers[seg], 4)}H`);
    }
  }

  for (const w of writes) {
    const valStr =
      w.size === 8 ? `${formatHex(w.value, 2)}H` : `${formatHex(w.value, 4)}H`;
    const repeatSuffix =
      w.repeatCount && w.repeatCount > 1 ? ` (×${w.repeatCount})` : '';
    parts.push(
      `${w.segmentReg}:[${formatHex(w.offset, 4)}H]=${valStr}${repeatSuffix}`
    );
  }

  return parts.length === 0 ? '—' : parts.join(', ');
}

function formatInstructionLabel(entry: ITraceEntry, locale: 'tr' | 'en'): string {
  if (entry.isInitial) {
    return locale === 'tr' ? 'Başlangıç Durumu' : 'Initial State';
  }
  if (entry.lineHitCount > 1) {
    return `${entry.instruction}  (#${entry.lineHitCount})`;
  }
  return entry.instruction;
}

function makeHeaderCell(
  text: string,
  widthPct: number,
  align: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.CENTER
): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_HEADER_BG },
    verticalAlign: VerticalAlign.CENTER,
    margins: CELL_MARGINS,
    children: [
      new Paragraph({
        alignment: align,
        children: [
          new TextRun({
            text,
            bold: true,
            font: FONT_SANS,
            size: 18, // 9pt
            color: COLOR_TEXT,
          }),
        ],
      }),
    ],
  });
}

function makeDataCell(
  text: string,
  opts: {
    widthPct: number;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    mono?: boolean;
    bold?: boolean;
    color?: string;
    fill?: string;
  }
): TableCell {
  return new TableCell({
    width: { size: opts.widthPct, type: WidthType.PERCENTAGE },
    shading: opts.fill
      ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill }
      : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: CELL_MARGINS,
    children: [
      new Paragraph({
        alignment: opts.align ?? AlignmentType.CENTER,
        children: [
          new TextRun({
            text,
            bold: opts.bold ?? false,
            font: opts.mono ? FONT_MONO : FONT_SANS,
            size: 17, // 8.5pt
            color: opts.color ?? COLOR_TEXT,
          }),
        ],
      }),
    ],
  });
}

function buildRegistersTable(
  traceLog: readonly ITraceEntry[],
  locale: 'tr' | 'en'
): Table {
  const isTr = locale === 'tr';

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      makeHeaderCell('#', 4),
      makeHeaderCell('CS:IP', 9),
      makeHeaderCell(isTr ? 'Komut' : 'Instruction', 21, AlignmentType.LEFT),
      makeHeaderCell('AX', 6),
      makeHeaderCell('BX', 6),
      makeHeaderCell('CX', 6),
      makeHeaderCell('DX', 6),
      makeHeaderCell('SI', 6),
      makeHeaderCell('DI', 6),
      makeHeaderCell('BP', 6),
      makeHeaderCell('SP', 6),
      makeHeaderCell(
        isTr ? 'Bellek / Segment Değişikliği' : 'Memory / Segment Writes',
        18,
        AlignmentType.LEFT
      ),
    ],
  });

  const regCols: Array<{ key: RegisterName; width: number }> = [
    { key: 'AX', width: 6 },
    { key: 'BX', width: 6 },
    { key: 'CX', width: 6 },
    { key: 'DX', width: 6 },
    { key: 'SI', width: 6 },
    { key: 'DI', width: 6 },
    { key: 'BP', width: 6 },
    { key: 'SP', width: 6 },
  ];

  const bodyRows = traceLog.map((entry, idx) => {
    const changedSet = new Set<RegisterName>(entry.changedRegisters);
    const rowBaseFill = entry.isInitial
      ? COLOR_INITIAL_BG
      : idx % 2 === 0
        ? COLOR_ZEBRA_BG
        : undefined;

    const memText = formatTraceMemoryAndSegments(
      entry.memoryWrites,
      entry.changedRegisters,
      entry.registers
    );
    const hasMemOrSegWrite = memText !== '—';

    return new TableRow({
      cantSplit: true,
      children: [
        makeDataCell(String(entry.step), {
          widthPct: 4,
          mono: true,
          color: COLOR_MUTED,
          fill: rowBaseFill,
        }),
        makeDataCell(`${formatHex(entry.cs, 4)}:${formatHex(entry.ip, 4)}`, {
          widthPct: 9,
          mono: true,
          color: COLOR_MUTED,
          fill: rowBaseFill,
        }),
        makeDataCell(formatInstructionLabel(entry, locale), {
          widthPct: 21,
          align: AlignmentType.LEFT,
          mono: !entry.isInitial,
          bold: entry.isInitial,
          fill: rowBaseFill,
        }),
        ...regCols.map(({ key, width }) => {
          const val = entry.registers[key];
          const changed = changedSet.has(key);
          return makeDataCell(formatHex(val, 4), {
            widthPct: width,
            mono: true,
            bold: changed,
            color: changed ? COLOR_REG_CHANGED_TEXT : COLOR_TEXT,
            fill: changed ? COLOR_REG_CHANGED_BG : rowBaseFill,
          });
        }),
        makeDataCell(memText, {
          widthPct: 18,
          align: AlignmentType.LEFT,
          mono: hasMemOrSegWrite,
          bold: hasMemOrSegWrite,
          color: hasMemOrSegWrite ? COLOR_REG_CHANGED_TEXT : COLOR_MUTED,
          fill: hasMemOrSegWrite ? COLOR_REG_CHANGED_BG : rowBaseFill,
        }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [headerRow, ...bodyRows],
  });
}

function buildFlagsTable(
  traceLog: readonly ITraceEntry[],
  locale: 'tr' | 'en'
): Table {
  const isTr = locale === 'tr';
  const flagOrder: Array<{ key: FlagName; label: string }> = [
    { key: 'OF', label: 'O (OF)' },
    { key: 'SF', label: 'S (SF)' },
    { key: 'ZF', label: 'Z (ZF)' },
    { key: 'AF', label: 'A (AF)' },
    { key: 'PF', label: 'P (PF)' },
    { key: 'CF', label: 'C (CF)' },
    { key: 'DF', label: 'D (DF)' },
    { key: 'IF', label: 'I (IF)' },
    { key: 'TF', label: 'T (TF)' },
  ];

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      makeHeaderCell('#', 5),
      makeHeaderCell('CS:IP', 10),
      makeHeaderCell(isTr ? 'Komut' : 'Instruction', 31, AlignmentType.LEFT),
      ...flagOrder.map((f) => makeHeaderCell(f.label, 6)),
    ],
  });

  const bodyRows = traceLog.map((entry, idx) => {
    const changedSet = new Set<FlagName>(entry.changedFlags);
    const rowBaseFill = entry.isInitial
      ? COLOR_INITIAL_BG
      : idx % 2 === 0
        ? COLOR_ZEBRA_BG
        : undefined;

    return new TableRow({
      cantSplit: true,
      children: [
        makeDataCell(String(entry.step), {
          widthPct: 5,
          mono: true,
          color: COLOR_MUTED,
          fill: rowBaseFill,
        }),
        makeDataCell(`${formatHex(entry.cs, 4)}:${formatHex(entry.ip, 4)}`, {
          widthPct: 10,
          mono: true,
          color: COLOR_MUTED,
          fill: rowBaseFill,
        }),
        makeDataCell(formatInstructionLabel(entry, locale), {
          widthPct: 31,
          align: AlignmentType.LEFT,
          mono: !entry.isInitial,
          bold: entry.isInitial,
          fill: rowBaseFill,
        }),
        ...flagOrder.map(({ key }) => {
          const val = entry.registers.FLAGS[key];
          const changed = changedSet.has(key);
          return makeDataCell(val ? '1' : '0', {
            widthPct: 6,
            mono: true,
            bold: changed || val,
            color: changed
              ? COLOR_FLAG_CHANGED_TEXT
              : val
                ? COLOR_TEXT
                : COLOR_MUTED,
            fill: changed ? COLOR_FLAG_CHANGED_BG : rowBaseFill,
          });
        }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [headerRow, ...bodyRows],
  });
}

function buildSourceCodeBlock(sourceCode: string): Table {
  const lines = sourceCode.split('\n');
  const paragraphs = lines.map((line, idx) => {
    const lineNo = String(idx + 1).padStart(2, '0');
    return new Paragraph({
      spacing: { before: 15, after: 15 },
      children: [
        new TextRun({
          text: `${lineNo}  `,
          font: FONT_MONO,
          size: 17,
          color: COLOR_MUTED,
        }),
        new TextRun({
          text: line,
          font: FONT_MONO,
          size: 17,
          color: COLOR_TEXT,
        }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_ZEBRA_BG },
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: paragraphs,
          }),
        ],
      }),
    ],
  });
}

/**
 * Generates a Microsoft Word (.docx) homework report containing:
 *  1. Step-by-Step Register & Memory Trace Table (including all loop iterations)
 *  2. Step-by-Step Flag Register Table (O, S, Z, A, P, C + D, I, T)
 *  3. Numbered Assembly Source Code Listing
 */
export async function generateTraceDocx(
  options: IDocxExportOptions
): Promise<Uint8Array> {
  const { programName, sourceCode, traceLog, truncated, locale } = options;
  const isTr = locale === 'tr';
  const dateStr = (options.generatedAt ?? new Date()).toLocaleString(
    isTr ? 'tr-TR' : 'en-US'
  );

  const executedCount = traceLog.filter((e) => !e.isInitial).length;
  const firstEntry = traceLog[0];
  const segmentSummary = firstEntry
    ? `CS=${formatHex(firstEntry.registers.CS, 4)}H  DS=${formatHex(firstEntry.registers.DS, 4)}H  SS=${formatHex(firstEntry.registers.SS, 4)}H  ES=${formatHex(firstEntry.registers.ES, 4)}H`
    : '';

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 80 },
      children: [
        new TextRun({
          text: isTr
            ? 'EMU8086 — Adım Adım Çalıştırma ve Bayrak Raporu'
            : 'EMU8086 — Step-by-Step Execution & Flag Report',
          bold: true,
          font: FONT_SANS,
          size: 28,
          color: COLOR_TEXT,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: isTr
            ? `Program: ${programName}   |   Tarih: ${dateStr}   |   Toplam Adım: ${executedCount}`
            : `Program: ${programName}   |   Date: ${dateStr}   |   Total Steps: ${executedCount}`,
          font: FONT_SANS,
          size: 19,
          color: COLOR_MUTED,
        }),
      ],
    }),
  ];

  if (segmentSummary) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: `${isTr ? 'Başlangıç Segmentleri' : 'Initial Segments'}: `,
            font: FONT_SANS,
            size: 18,
            bold: true,
            color: COLOR_MUTED,
          }),
          new TextRun({
            text: segmentSummary,
            font: FONT_MONO,
            size: 18,
            color: COLOR_TEXT,
          }),
        ],
      })
    );
  }

  if (truncated) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: isTr
              ? 'Not: Kayıt sınırı (5000 adım) aşıldığı için yalnızca ilk 5000 adım rapora dahil edilmiştir.'
              : 'Note: Trace limit (5000 steps) was reached; only the first 5000 steps are included.',
            italics: true,
            font: FONT_SANS,
            size: 18,
            color: COLOR_FLAG_CHANGED_TEXT,
          }),
        ],
      })
    );
  }

  // Section 1: Registers & Memory Trace Table
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 120, after: 80 },
      children: [
        new TextRun({
          text: isTr
            ? '1. Adım Adım Yazmaç (Register) ve Bellek Tablosu'
            : '1. Step-by-Step Register & Memory Trace Table',
          bold: true,
          font: FONT_SANS,
          size: 22,
          color: COLOR_TEXT,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({
          text: isTr
            ? 'Her adımda değeri değişen yazmaçlar, segmentler ve bellek yazmaları mavi ile vurgulanmıştır. Döngü tekrarları (#2, #3...) şeklinde gösterilir.'
            : 'Registers, segments, and memory writes modified in each step are highlighted in blue. Loop iterations are marked as (#2, #3...).',
          font: FONT_SANS,
          size: 17,
          color: COLOR_MUTED,
        }),
      ],
    }),
    buildRegistersTable(traceLog, locale)
  );

  // Section 2: Flags Table
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      pageBreakBefore: true,
      spacing: { before: 80, after: 80 },
      children: [
        new TextRun({
          text: isTr
            ? '2. Adım Adım Bayrak (Flag) Tablosu (O, S, Z, A, P, C)'
            : '2. Step-by-Step Flag Register Table (O, S, Z, A, P, C)',
          bold: true,
          font: FONT_SANS,
          size: 22,
          color: COLOR_TEXT,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({
          text: isTr
            ? 'İlgili adımda durumu değişen bayraklar sarı ile vurgulanmıştır.'
            : 'Flags whose state changed during a step are highlighted in amber.',
          font: FONT_SANS,
          size: 17,
          color: COLOR_MUTED,
        }),
      ],
    }),
    buildFlagsTable(traceLog, locale)
  );

  // Section 3: Source Code
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 80 },
      children: [
        new TextRun({
          text: isTr ? '3. Assembly Kaynak Kodu' : '3. Assembly Source Code',
          bold: true,
          font: FONT_SANS,
          size: 22,
          color: COLOR_TEXT,
        }),
      ],
    }),
    buildSourceCodeBlock(sourceCode)
  );

  const doc = new Document({
    creator: 'EMU8086',
    title: `${programName} — EMU8086 Trace Report`,
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: PageOrientation.LANDSCAPE,
            },
            margin: {
              top: 720,
              bottom: 720,
              left: 720,
              right: 720,
            },
          },
        },
        children,
      },
    ],
  });

  if (typeof window !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
