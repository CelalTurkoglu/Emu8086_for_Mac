import React, { useState } from 'react';
import { FileDown, Trash2, X } from 'lucide-react';
import {
  formatHex,
  type FlagName,
  type ITraceEntry,
  type ITraceMemoryWrite,
  type RegisterName,
} from '../core';
import { useI18n } from '../i18n';

interface TraceModalProps {
  open: boolean;
  traceLog: readonly ITraceEntry[];
  truncated: boolean;
  onClose: () => void;
  onClear: () => void;
  onExportDocx: () => void;
}

const REG_COLS: RegisterName[] = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP'];
const FLAG_COLS: Array<{ key: FlagName; label: string }> = [
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

function formatMemWrites(writes: readonly ITraceMemoryWrite[]): string {
  if (writes.length === 0) return '—';
  return writes
    .map((w) => {
      const val = w.size === 8 ? `${formatHex(w.value, 2)}H` : `${formatHex(w.value, 4)}H`;
      return `${w.segmentReg}:[${formatHex(w.offset, 4)}H]=${val}`;
    })
    .join(', ');
}

export const TraceModal: React.FC<TraceModalProps> = ({
  open,
  traceLog,
  truncated,
  onClose,
  onClear,
  onExportDocx,
}) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'registers' | 'flags'>('registers');

  if (!open) return null;

  const executedCount = traceLog.filter((e) => !e.isInitial).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-[#1e1e1e]">
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 dark:border-neutral-800 dark:bg-[#252527]">
          <div className="flex items-center gap-3">
            {/* Tabs */}
            <div className="flex rounded border border-neutral-300 bg-neutral-200/70 p-0.5 text-xs font-medium dark:border-neutral-700 dark:bg-neutral-900">
              <button
                type="button"
                onClick={() => setActiveTab('registers')}
                className={`rounded-sm px-2.5 py-1 transition-colors ${
                  activeTab === 'registers'
                    ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                    : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200'
                }`}
              >
                {t.trace.tabRegisters}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('flags')}
                className={`rounded-sm px-2.5 py-1 transition-colors ${
                  activeTab === 'flags'
                    ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                    : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200'
                }`}
              >
                {t.trace.tabFlags}
              </button>
            </div>

            <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
              {executedCount} {t.trace.stepsRecorded}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onClear}
              disabled={traceLog.length === 0}
              className="inline-flex items-center gap-1 rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t.trace.clearTrace}</span>
            </button>

            <button
              type="button"
              onClick={onExportDocx}
              disabled={executedCount === 0}
              className="inline-flex items-center gap-1.5 rounded border border-blue-600 bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <FileDown className="h-3.5 w-3.5" />
              <span>{t.trace.exportWord}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label={t.trace.close}
              className="ml-1 rounded p-1 text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {truncated && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            {t.trace.truncatedNotice}
          </div>
        )}

        {/* Table Content */}
        <div className="flex-1 overflow-auto p-3">
          {traceLog.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">
              {t.trace.emptyNotice}
            </div>
          ) : activeTab === 'registers' ? (
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 bg-neutral-100 dark:bg-[#252527]">
                <tr className="border-b border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                  <th className="px-2 py-1.5 text-center font-semibold">{t.trace.colStep}</th>
                  <th className="px-2 py-1.5 text-left font-semibold">CS:IP</th>
                  <th className="px-2 py-1.5 text-left font-semibold">
                    {t.trace.colInstruction}
                  </th>
                  {REG_COLS.map((r) => (
                    <th key={r} className="px-2 py-1.5 text-center font-semibold">
                      {r}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 text-left font-semibold">
                    {t.trace.colMemory}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {traceLog.map((entry, idx) => {
                  const changedSet = new Set(entry.changedRegisters);
                  const memText = formatMemWrites(entry.memoryWrites);
                  const hasMem = entry.memoryWrites.length > 0;
                  return (
                    <tr
                      key={`${entry.step}-${idx}`}
                      className={
                        entry.isInitial
                          ? 'bg-neutral-50 text-neutral-600 dark:bg-neutral-900/70 dark:text-neutral-400'
                          : 'hover:bg-neutral-50/80 dark:hover:bg-neutral-800/40'
                      }
                    >
                      <td className="px-2 py-1 text-center text-neutral-400">
                        {entry.step}
                      </td>
                      <td className="px-2 py-1 text-neutral-500 whitespace-nowrap dark:text-neutral-400">
                        {formatHex(entry.cs, 4)}:{formatHex(entry.ip, 4)}
                      </td>
                      <td className="px-2 py-1 text-neutral-900 whitespace-nowrap dark:text-neutral-100">
                        {entry.isInitial ? (
                          <span className="font-sans font-medium text-neutral-500">
                            {t.trace.initialState}
                          </span>
                        ) : (
                          <>
                            <span>{entry.instruction}</span>
                            {entry.lineHitCount > 1 && (
                              <span className="ml-1.5 rounded bg-neutral-200/80 px-1 py-0.2 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                                #{entry.lineHitCount}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      {REG_COLS.map((reg) => {
                        const changed = changedSet.has(reg);
                        return (
                          <td
                            key={reg}
                            className={`px-2 py-1 text-center ${
                              changed
                                ? 'bg-blue-50 font-bold text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                                : 'text-neutral-800 dark:text-neutral-200'
                            }`}
                          >
                            {formatHex(entry.registers[reg], 4)}
                          </td>
                        );
                      })}
                      <td
                        className={`px-2 py-1 whitespace-nowrap ${
                          hasMem
                            ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                            : 'text-neutral-400 dark:text-neutral-600'
                        }`}
                      >
                        {memText}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 bg-neutral-100 dark:bg-[#252527]">
                <tr className="border-b border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                  <th className="px-2 py-1.5 text-center font-semibold">{t.trace.colStep}</th>
                  <th className="px-2 py-1.5 text-left font-semibold">CS:IP</th>
                  <th className="px-2 py-1.5 text-left font-semibold">
                    {t.trace.colInstruction}
                  </th>
                  {FLAG_COLS.map((f) => (
                    <th key={f.key} className="px-2 py-1.5 text-center font-semibold">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {traceLog.map((entry, idx) => {
                  const changedSet = new Set(entry.changedFlags);
                  return (
                    <tr
                      key={`${entry.step}-${idx}`}
                      className={
                        entry.isInitial
                          ? 'bg-neutral-50 text-neutral-600 dark:bg-neutral-900/70 dark:text-neutral-400'
                          : 'hover:bg-neutral-50/80 dark:hover:bg-neutral-800/40'
                      }
                    >
                      <td className="px-2 py-1 text-center text-neutral-400">
                        {entry.step}
                      </td>
                      <td className="px-2 py-1 text-neutral-500 whitespace-nowrap dark:text-neutral-400">
                        {formatHex(entry.cs, 4)}:{formatHex(entry.ip, 4)}
                      </td>
                      <td className="px-2 py-1 text-neutral-900 whitespace-nowrap dark:text-neutral-100">
                        {entry.isInitial ? (
                          <span className="font-sans font-medium text-neutral-500">
                            {t.trace.initialState}
                          </span>
                        ) : (
                          <>
                            <span>{entry.instruction}</span>
                            {entry.lineHitCount > 1 && (
                              <span className="ml-1.5 rounded bg-neutral-200/80 px-1 py-0.2 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                                #{entry.lineHitCount}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      {FLAG_COLS.map((f) => {
                        const val = entry.registers.FLAGS[f.key];
                        const changed = changedSet.has(f.key);
                        return (
                          <td
                            key={f.key}
                            className={`px-2 py-1 text-center ${
                              changed
                                ? 'bg-amber-100 font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
                                : val
                                  ? 'font-semibold text-neutral-900 dark:text-neutral-100'
                                  : 'text-neutral-400 dark:text-neutral-600'
                            }`}
                          >
                            {val ? '1' : '0'}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
