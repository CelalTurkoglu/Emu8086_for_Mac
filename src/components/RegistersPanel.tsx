import React from 'react';
import {
  formatHex,
  type ControlFlagName,
  type FlagName,
  type ICPUSnapshot,
  type IFlags,
  type PointerIndexRegister,
  type Register8,
  type RegisterName,
  type SegmentRegister,
  type StatusFlagName,
} from '../core';
import { useI18n } from '../i18n';

interface RegistersPanelProps {
  snapshot: ICPUSnapshot;
  changedRegisters: ReadonlySet<RegisterName>;
  changedFlags: ReadonlySet<FlagName>;
}

interface GPDescriptor {
  full: 'AX' | 'BX' | 'CX' | 'DX';
  high: Register8;
  low: Register8;
}

const GP_LIST: GPDescriptor[] = [
  { full: 'AX', high: 'AH', low: 'AL' },
  { full: 'BX', high: 'BH', low: 'BL' },
  { full: 'CX', high: 'CH', low: 'CL' },
  { full: 'DX', high: 'DH', low: 'DL' },
];

const PTR_LIST: PointerIndexRegister[] = ['IP', 'SP', 'BP', 'SI', 'DI'];
const SEG_LIST: SegmentRegister[] = ['CS', 'DS', 'SS', 'ES'];

const STATUS_FLAGS_ORDER: StatusFlagName[] = ['OF', 'SF', 'ZF', 'AF', 'PF', 'CF'];
const CONTROL_FLAGS_ORDER: ControlFlagName[] = ['DF', 'IF', 'TF'];

function toSigned16(val: number): number {
  const v = val & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
}

function toBinary16(val: number): string {
  const raw = (val & 0xffff).toString(2).padStart(16, '0');
  return `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8, 12)} ${raw.slice(12, 16)}`;
}

function packFlagsWord(flags: IFlags): number {
  let word = 0x0002;
  if (flags.CF) word |= 1 << 0;
  if (flags.PF) word |= 1 << 2;
  if (flags.AF) word |= 1 << 4;
  if (flags.ZF) word |= 1 << 6;
  if (flags.SF) word |= 1 << 7;
  if (flags.TF) word |= 1 << 8;
  if (flags.IF) word |= 1 << 9;
  if (flags.DF) word |= 1 << 10;
  if (flags.OF) word |= 1 << 11;
  return word;
}

export const RegistersPanel: React.FC<RegistersPanelProps> = ({
  snapshot,
  changedRegisters,
  changedFlags,
}) => {
  const { t } = useI18n();
  const regs = snapshot.registers;
  const flags = regs.FLAGS;
  const flagsWord = packFlagsWord(flags);

  return (
    <aside className="flex flex-col rounded-md border border-neutral-200 bg-white overflow-hidden min-h-0 dark:border-neutral-800 dark:bg-[#1e1e1e]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 shrink-0 dark:border-neutral-800 dark:bg-[#252527]">
        <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
          {t.panels.cpuRegisters}
        </span>
        <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
          {t.panels.flagsWord}:{' '}
          <span className="font-semibold text-neutral-800 dark:text-neutral-200">
            {formatHex(flagsWord, 4)}H
          </span>
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
        {/* 1. General Purpose Registers (AX..DX with H | L split) */}
        <div>
          <div className="mb-1 flex items-center justify-between px-0.5">
            <h3 className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              {t.panels.generalPurpose}
            </h3>
            <div className="flex items-center gap-1 pr-14 font-mono text-[10px] text-neutral-400">
              <span className="w-9 text-center">{t.panels.regHigh}</span>
              <span className="w-9 text-center">{t.panels.regLow}</span>
            </div>
          </div>

          <div className="divide-y divide-neutral-200 rounded border border-neutral-200 overflow-hidden dark:divide-neutral-800 dark:border-neutral-800">
            {GP_LIST.map(({ full, high, low }) => {
              const val16 = regs[full];
              const valH = regs[high];
              const valL = regs[low];
              const signed16 = toSigned16(val16);
              const changedFull = changedRegisters.has(full);
              const changedH = changedRegisters.has(high);
              const changedL = changedRegisters.has(low);

              const tooltip = `${full} = ${formatHex(val16, 4)}H (${high}=${formatHex(valH, 2)}H, ${low}=${formatHex(valL, 2)}H)\n${t.panels.unsignedDec}: ${val16}\n${t.panels.signedDec}: ${signed16}\n${t.panels.binary}: ${toBinary16(val16)}`;

              return (
                <div
                  key={full}
                  title={tooltip}
                  className={`flex items-center justify-between px-2.5 py-1 font-mono text-xs ${
                    changedFull
                      ? 'bg-blue-50/70 dark:bg-blue-950/30'
                      : 'bg-white dark:bg-[#1e1e1e]'
                  }`}
                >
                  <span
                    className={`w-8 font-semibold ${
                      changedFull
                        ? 'text-blue-700 dark:text-blue-300'
                        : 'text-neutral-600 dark:text-neutral-400'
                    }`}
                  >
                    {full}
                  </span>

                  <div className="flex items-center gap-1">
                    <span
                      className={`w-9 rounded border py-0.5 text-center text-xs ${
                        changedH
                          ? 'border-blue-300 bg-blue-100/80 font-bold text-blue-800 dark:border-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                          : 'border-neutral-200 bg-neutral-50 font-medium text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'
                      }`}
                    >
                      {formatHex(valH, 2)}
                    </span>
                    <span
                      className={`w-9 rounded border py-0.5 text-center text-xs ${
                        changedL
                          ? 'border-blue-300 bg-blue-100/80 font-bold text-blue-800 dark:border-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                          : 'border-neutral-200 bg-neutral-50 font-medium text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'
                      }`}
                    >
                      {formatHex(valL, 2)}
                    </span>
                  </div>

                  <span className="w-14 text-right text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400">
                    {val16}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 2. Pointer/Index & Segment Registers */}
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <h3 className="mb-1 px-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              {t.panels.pointersAndIndex}
            </h3>
            <div className="divide-y divide-neutral-200 rounded border border-neutral-200 overflow-hidden dark:divide-neutral-800 dark:border-neutral-800">
              {PTR_LIST.map((reg) => {
                const val = regs[reg];
                const changed = changedRegisters.has(reg);
                const tooltip = `${reg} = ${formatHex(val, 4)}H\n${t.panels.unsignedDec}: ${val}\n${t.panels.binary}: ${toBinary16(val)}`;

                return (
                  <div
                    key={reg}
                    title={tooltip}
                    className={`flex items-center justify-between px-2 py-1 font-mono text-xs ${
                      changed
                        ? 'bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200'
                        : 'bg-white text-neutral-900 dark:bg-[#1e1e1e] dark:text-neutral-100'
                    }`}
                  >
                    <span
                      className={`font-semibold ${
                        changed
                          ? 'text-blue-700 dark:text-blue-300'
                          : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      {reg}
                    </span>
                    <span className={changed ? 'font-bold' : 'font-medium'}>
                      {formatHex(val, 4)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="mb-1 px-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              {t.panels.segments}
            </h3>
            <div className="divide-y divide-neutral-200 rounded border border-neutral-200 overflow-hidden dark:divide-neutral-800 dark:border-neutral-800">
              {SEG_LIST.map((reg) => {
                const val = regs[reg];
                const changed = changedRegisters.has(reg);
                const basePhys = ((val << 4) & 0xfffff) >>> 0;
                const tooltip = `${reg} = ${formatHex(val, 4)}H\nBase: ${formatHex(basePhys, 5)}H`;

                return (
                  <div
                    key={reg}
                    title={tooltip}
                    className={`flex items-center justify-between px-2 py-1 font-mono text-xs ${
                      changed
                        ? 'bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200'
                        : 'bg-white text-neutral-900 dark:bg-[#1e1e1e] dark:text-neutral-100'
                    }`}
                  >
                    <span
                      className={`font-semibold ${
                        changed
                          ? 'text-blue-700 dark:text-blue-300'
                          : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      {reg}
                    </span>
                    <span className={changed ? 'font-bold' : 'font-medium'}>
                      {formatHex(val, 4)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 3. Status Flags Checklist */}
        <div className="border-t border-neutral-200 pt-2.5 dark:border-neutral-800">
          <h3 className="mb-1.5 px-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
            {t.panels.statusFlags}
          </h3>

          <div className="grid grid-cols-2 gap-1.5">
            {STATUS_FLAGS_ORDER.map((flagKey) => {
              const active = flags[flagKey];
              const changed = changedFlags.has(flagKey);
              const meta = t.flags[flagKey];

              return (
                <div
                  key={flagKey}
                  title={`${flagKey} — ${meta.name}\n${meta.desc}`}
                  className={`flex items-center justify-between rounded border px-2 py-1 text-xs cursor-help ${
                    changed
                      ? 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/40'
                      : active
                        ? 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/80'
                        : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-[#1e1e1e]'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] font-bold ${
                        active
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-neutral-300 bg-white text-transparent dark:border-neutral-600 dark:bg-neutral-900'
                      }`}
                    >
                      ✓
                    </span>
                    <span
                      className={`font-mono font-semibold ${
                        changed
                          ? 'text-amber-900 dark:text-amber-200'
                          : active
                            ? 'text-neutral-900 dark:text-neutral-100'
                            : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      {flagKey}
                    </span>
                    <span className="truncate text-[10px] text-neutral-400 dark:text-neutral-500">
                      {meta.shortName}
                    </span>
                  </div>

                  <span
                    className={`ml-1 font-mono text-xs ${
                      changed
                        ? 'font-bold text-amber-900 dark:text-amber-200'
                        : active
                          ? 'font-bold text-neutral-900 dark:text-white'
                          : 'text-neutral-400 dark:text-neutral-600'
                    }`}
                  >
                    {active ? '1' : '0'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Control Flags */}
          <div className="mt-2">
            <h4 className="mb-1 px-0.5 text-[10px] font-medium text-neutral-400 dark:text-neutral-500">
              {t.panels.controlFlags}
            </h4>
            <div className="grid grid-cols-3 gap-1.5">
              {CONTROL_FLAGS_ORDER.map((flagKey) => {
                const active = flags[flagKey];
                const changed = changedFlags.has(flagKey);
                const meta = t.flags[flagKey];

                return (
                  <div
                    key={flagKey}
                    title={`${flagKey} — ${meta.name}\n${meta.desc}`}
                    className={`flex items-center justify-between rounded border px-2 py-0.5 font-mono text-[11px] cursor-help ${
                      changed
                        ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-200'
                        : 'border-neutral-200 bg-neutral-50/60 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
                    }`}
                  >
                    <span className="font-medium text-neutral-500 dark:text-neutral-400">
                      {flagKey}
                    </span>
                    <span className={active ? 'font-bold' : 'text-neutral-400'}>
                      {active ? '1' : '0'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
