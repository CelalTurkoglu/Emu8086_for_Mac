import React, { useEffect, useMemo, useState } from 'react';
import {
  calculatePhysicalAddress,
  formatHex,
  parseAddressInput,
  PHYSICAL_ADDRESS_MASK,
  type IRegisterState,
  type Memory,
} from '../core';
import { useI18n } from '../i18n';

interface MemoryViewerProps {
  memory: Memory;
  memoryVersion: number;
  registers: IRegisterState;
  writtenAddresses: ReadonlySet<number>;
  externalJumpAddress: string | null;
  onEditByte: (physicalAddress: number, newValue: number) => void;
}

const BYTES_PER_ROW = 16;
const VISIBLE_ROWS = 8;
const PAGE_BYTES = BYTES_PER_ROW * VISIBLE_ROWS;

function byteToAscii(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

export const MemoryViewer: React.FC<MemoryViewerProps> = ({
  memory,
  memoryVersion,
  registers,
  writtenAddresses,
  externalJumpAddress,
  onEditByte,
}) => {
  const { t } = useI18n();

  const [segment, setSegment] = useState<number>(0x0700);
  const [rowBaseOffset, setRowBaseOffset] = useState<number>(0x0050);
  const [targetOffset, setTargetOffset] = useState<number>(0x0050);
  const [addressInput, setAddressInput] = useState<string>('0700:0050');
  const [inputError, setInputError] = useState<boolean>(false);

  const [editingPhys, setEditingPhys] = useState<number | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  const jumpToString = (raw: string) => {
    const parsed = parseAddressInput(raw);
    if (!parsed) {
      setInputError(true);
      return;
    }
    setInputError(false);

    if (parsed.logical) {
      const seg = parsed.logical.segment & 0xffff;
      const off = parsed.logical.offset & 0xffff;
      setSegment(seg);
      setTargetOffset(off);
      setRowBaseOffset(off & 0xfff0);
      setAddressInput(`${formatHex(seg, 4)}:${formatHex(off, 4)}`);
    } else {
      const phys = parsed.physicalAddress & PHYSICAL_ADDRESS_MASK;
      const seg = (phys >>> 4) & 0xf000;
      const off = phys & 0xffff;
      setSegment(seg);
      setTargetOffset(off);
      setRowBaseOffset(off & 0xfff0);
      setAddressInput(`${formatHex(seg, 4)}:${formatHex(off, 4)}`);
    }
  };

  useEffect(() => {
    if (externalJumpAddress) {
      jumpToString(externalJumpAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalJumpAddress]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    jumpToString(addressInput);
  };

  const shiftView = (deltaBytes: number) => {
    const nextOff = (rowBaseOffset + deltaBytes) & 0xffff;
    setRowBaseOffset(nextOff);
    setTargetOffset(nextOff);
    setAddressInput(`${formatHex(segment, 4)}:${formatHex(nextOff, 4)}`);
    setInputError(false);
  };

  const jumpToSegOff = (seg: number, off: number) => {
    const s = seg & 0xffff;
    const o = off & 0xffff;
    setSegment(s);
    setTargetOffset(o);
    setRowBaseOffset(o & 0xfff0);
    setAddressInput(`${formatHex(s, 4)}:${formatHex(o, 4)}`);
    setInputError(false);
  };

  const targetPhysical = calculatePhysicalAddress(segment, targetOffset);

  const rows = useMemo(() => {
    void memoryVersion;
    const result: Array<{
      offset: number;
      physStart: number;
      bytes: Array<{ phys: number; value: number }>;
    }> = [];

    for (let r = 0; r < VISIBLE_ROWS; r++) {
      const rowOff = (rowBaseOffset + r * BYTES_PER_ROW) & 0xffff;
      const physStart = calculatePhysicalAddress(segment, rowOff);
      const bytes: Array<{ phys: number; value: number }> = [];
      for (let c = 0; c < BYTES_PER_ROW; c++) {
        const phys = calculatePhysicalAddress(segment, (rowOff + c) & 0xffff);
        bytes.push({ phys, value: memory.readByte(phys) });
      }
      result.push({ offset: rowOff, physStart, bytes });
    }
    return result;
  }, [memory, memoryVersion, segment, rowBaseOffset]);

  const startEditCell = (phys: number, currentValue: number) => {
    setEditingPhys(phys);
    setEditValue(formatHex(currentValue, 2));
  };

  const commitEditCell = () => {
    if (editingPhys === null) return;
    const cleaned = editValue.trim().toUpperCase().replace(/^0X/, '').replace(/H$/, '');
    if (/^[0-9A-F]{1,2}$/.test(cleaned)) {
      onEditByte(editingPhys, parseInt(cleaned, 16) & 0xff);
    }
    setEditingPhys(null);
  };

  const quickBtn =
    'rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700';

  return (
    <section className="flex h-[240px] shrink-0 flex-col rounded-md border border-neutral-200 bg-white overflow-hidden dark:border-neutral-800 dark:bg-[#1e1e1e]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 shrink-0 dark:border-neutral-800 dark:bg-[#252527]">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
            {t.panels.memoryViewer}
          </span>

          <form onSubmit={handleSubmit} className="flex items-center gap-1">
            <input
              type="text"
              value={addressInput}
              onChange={(e) => {
                setAddressInput(e.target.value);
                if (inputError) setInputError(false);
              }}
              placeholder={t.panels.addressPlaceholder}
              aria-label={t.panels.memoryViewer}
              className={`w-28 rounded border bg-white px-2 py-0.5 font-mono text-xs text-neutral-900 focus:outline-none dark:bg-neutral-900 dark:text-neutral-100 ${
                inputError
                  ? 'border-red-500 text-red-700 dark:text-red-300'
                  : 'border-neutral-300 focus:border-blue-500 dark:border-neutral-700'
              }`}
            />
            <button
              type="submit"
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              {t.panels.go}
            </button>
          </form>

          {inputError ? (
            <span className="text-[11px] text-red-600 dark:text-red-400">
              {t.panels.invalidAddress}
            </span>
          ) : (
            <span
              title={`(${formatHex(segment, 4)}H << 4) + ${formatHex(targetOffset, 4)}H = ${formatHex(targetPhysical, 5)}H`}
              className="hidden md:inline-flex items-center gap-1 font-mono text-[11px] text-neutral-500 dark:text-neutral-400"
            >
              <span>{t.panels.physicalAddress}:</span>
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                {formatHex(targetPhysical, 5)}H
              </span>
              <span className="hidden xl:inline text-neutral-400 dark:text-neutral-500">
                ({formatHex(segment, 4)}0H + {formatHex(targetOffset, 4)}H)
              </span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => jumpToSegOff(registers.DS, 0x0000)}
            className={quickBtn}
          >
            DS:0000
          </button>
          <button
            type="button"
            onClick={() => jumpToSegOff(registers.DS, 0x0050)}
            className={quickBtn}
          >
            DS:0050
          </button>
          <button
            type="button"
            onClick={() => jumpToSegOff(registers.CS, registers.IP)}
            className={quickBtn}
          >
            CS:IP
          </button>
          <button
            type="button"
            onClick={() => jumpToSegOff(registers.SS, registers.SP)}
            className={quickBtn}
          >
            SS:SP
          </button>

          <div className="mx-1 h-3.5 w-px bg-neutral-300 dark:bg-neutral-700" />

          <button
            type="button"
            onClick={() => shiftView(-PAGE_BYTES)}
            title="-128B"
            className={quickBtn}
          >
            «
          </button>
          <button
            type="button"
            onClick={() => shiftView(-BYTES_PER_ROW)}
            title="-16B"
            className={quickBtn}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => shiftView(BYTES_PER_ROW)}
            title="+16B"
            className={quickBtn}
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => shiftView(PAGE_BYTES)}
            title="+128B"
            className={quickBtn}
          >
            »
          </button>
        </div>
      </div>

      {/* Hex + ASCII Grid */}
      <div className="flex-1 overflow-auto bg-white px-3 py-1.5 font-mono text-[12px] dark:bg-[#1e1e1e]">
        <table className="w-full border-collapse select-none">
          <thead>
            <tr className="border-b border-neutral-200 text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
              <th className="py-0.5 pr-3 text-left font-medium w-[92px]">SEG:OFF</th>
              <th className="py-0.5 pr-3 text-left font-medium w-[62px]">PHYS</th>
              {Array.from({ length: BYTES_PER_ROW }, (_, col) => (
                <th
                  key={col}
                  className={`py-0.5 text-center font-medium w-[28px] ${
                    col === 8 ? 'pl-2' : ''
                  }`}
                >
                  {formatHex(col, 2)}
                </th>
              ))}
              <th className="py-0.5 pl-4 text-left font-medium">{t.panels.ascii}</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr
                key={row.offset}
                className="border-b border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40"
              >
                <td className="py-0.5 pr-3 text-neutral-600 whitespace-nowrap dark:text-neutral-400">
                  {formatHex(segment, 4)}:{formatHex(row.offset, 4)}
                </td>

                <td className="py-0.5 pr-3 text-neutral-400 whitespace-nowrap dark:text-neutral-500">
                  {formatHex(row.physStart, 5)}
                </td>

                {row.bytes.map((cell, col) => {
                  const isWritten = writtenAddresses.has(cell.phys);
                  const isTarget = cell.phys === targetPhysical;
                  const isEditing = editingPhys === cell.phys;
                  const isNonZero = cell.value !== 0;

                  return (
                    <td
                      key={col}
                      className={`py-0.5 text-center ${col === 8 ? 'pl-2' : ''}`}
                    >
                      {isEditing ? (
                        <input
                          type="text"
                          autoFocus
                          maxLength={2}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value.toUpperCase())}
                          onBlur={commitEditCell}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEditCell();
                            if (e.key === 'Escape') setEditingPhys(null);
                          }}
                          className="w-6 rounded border border-blue-500 bg-white text-center font-mono text-[11px] text-neutral-900 focus:outline-none dark:bg-neutral-900 dark:text-white"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditCell(cell.phys, cell.value)}
                          title={`${formatHex(segment, 4)}:${formatHex((row.offset + col) & 0xffff, 4)} (${formatHex(cell.phys, 5)}H) = ${formatHex(cell.value, 2)}H (${cell.value}) — ${t.panels.clickToEditByte}`}
                          className={`inline-block w-6 rounded py-0.2 text-center cursor-pointer ${
                            isWritten
                              ? 'bg-blue-100 text-blue-800 font-bold ring-1 ring-blue-300 dark:bg-blue-900/60 dark:text-blue-200 dark:ring-blue-700'
                              : isTarget
                                ? 'bg-neutral-200/80 text-neutral-900 font-semibold dark:bg-neutral-700 dark:text-white'
                                : isNonZero
                                  ? 'text-neutral-900 font-medium hover:bg-neutral-200/60 dark:text-neutral-100 dark:hover:bg-neutral-700'
                                  : 'text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
                          }`}
                        >
                          {formatHex(cell.value, 2)}
                        </button>
                      )}
                    </td>
                  );
                })}

                <td className="py-0.5 pl-4 tracking-wider whitespace-nowrap">
                  {row.bytes.map((cell, idx) => {
                    const ch = byteToAscii(cell.value);
                    const isWritten = writtenAddresses.has(cell.phys);
                    return (
                      <span
                        key={idx}
                        className={
                          isWritten
                            ? 'text-blue-700 font-bold dark:text-blue-300'
                            : ch !== '.'
                              ? 'text-neutral-800 dark:text-neutral-200'
                              : 'text-neutral-300 dark:text-neutral-700'
                        }
                      >
                        {ch}
                      </span>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
