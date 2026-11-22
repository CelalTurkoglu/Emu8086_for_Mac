import React from 'react';
import {
  FileCode2,
  FileDown,
  FilePlus2,
  FolderOpen,
  Moon,
  Play,
  RotateCcw,
  Save,
  SaveAll,
  Square,
  StepForward,
  Sun,
  Table2,
  Undo2,
  Wrench,
} from 'lucide-react';
import { COURSE_EXAMPLES, type ICodeExample } from '../data/examples';
import { useI18n } from '../i18n';

export type EmulatorStatus =
  | 'ready'
  | 'compiled'
  | 'modified'
  | 'running'
  | 'halted'
  | 'error';

export type RunSpeed = 'instant' | 'normal' | 'slow';
export type ThemeMode = 'light' | 'dark';

interface TopBarProps {
  status: EmulatorStatus;
  cycleCount: number;
  isRunning: boolean;
  canStep: boolean;
  canStepBack: boolean;
  runSpeed: RunSpeed;
  selectedExampleId: string;
  currentFileName: string | null;
  hasUnsavedChanges: boolean;
  traceEnabled: boolean;
  traceStepCount: number;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onRunSpeedChange: (speed: RunSpeed) => void;
  onNewFile: () => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onSaveFileAs: () => void;
  onCompile: () => void;
  onRunOrStop: () => void;
  onStep: () => void;
  onStepBack: () => void;
  onReset: () => void;
  onSelectExample: (example: ICodeExample) => void;
  onToggleTrace: () => void;
  onOpenTraceModal: () => void;
  onExportDocx: () => void;
}

const btnBase =
  'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

const btnNeutral =
  `${btnBase} border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700`;

const btnSubtle =
  'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

export const TopBar: React.FC<TopBarProps> = ({
  status,
  cycleCount,
  isRunning,
  canStep,
  canStepBack,
  runSpeed,
  selectedExampleId,
  currentFileName,
  hasUnsavedChanges,
  traceEnabled,
  traceStepCount,
  theme,
  onToggleTheme,
  onRunSpeedChange,
  onNewFile,
  onOpenFile,
  onSaveFile,
  onSaveFileAs,
  onCompile,
  onRunOrStop,
  onStep,
  onStepBack,
  onReset,
  onSelectExample,
  onToggleTrace,
  onOpenTraceModal,
  onExportDocx,
}) => {
  const { locale, setLocale, t } = useI18n();

  const statusText = t.status[status];
  const displayFileName = currentFileName ?? t.files.untitled;

  const statusDotClass =
    status === 'error'
      ? 'bg-red-500'
      : status === 'running'
        ? 'bg-blue-500'
        : status === 'modified'
          ? 'bg-amber-500'
          : status === 'compiled'
            ? 'bg-emerald-600'
            : 'bg-neutral-400';

  return (
    <header className="shrink-0 select-none border-b border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-[#242426]">
      {/* Row 1: macOS Window Titlebar — File Actions, Active File, Examples, Theme & Language */}
      <div className="macos-drag flex h-10 items-center justify-between gap-2 border-b border-neutral-200/80 pl-20 pr-3 dark:border-neutral-800">
        {/* Left: File Operations & Examples */}
        <div className="macos-no-drag flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={onNewFile}
            disabled={isRunning}
            title={t.files.newFileTip}
            className={btnSubtle}
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            <span>{t.files.newFile}</span>
          </button>

          <button
            type="button"
            onClick={onOpenFile}
            disabled={isRunning}
            title={t.files.openFileTip}
            className={btnSubtle}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>{t.files.openFile}</span>
          </button>

          <button
            type="button"
            onClick={onSaveFile}
            disabled={isRunning}
            title={t.files.saveFileTip}
            className={btnSubtle}
          >
            <Save className="h-3.5 w-3.5" />
            <span>{t.files.saveFile}</span>
          </button>

          <button
            type="button"
            onClick={onSaveFileAs}
            disabled={isRunning}
            title={t.files.saveAsTip}
            className={`${btnSubtle} hidden xl:inline-flex`}
          >
            <SaveAll className="h-3.5 w-3.5" />
            <span>{t.files.saveAs}</span>
          </button>

          <div className="mx-1.5 h-4 w-px bg-neutral-300 dark:bg-neutral-700" />

          {/* Examples Dropdown */}
          <select
            aria-label={t.toolbar.examples}
            value={selectedExampleId}
            onChange={(e) => {
              const found = COURSE_EXAMPLES.find((ex) => ex.id === e.target.value);
              if (found) onSelectExample(found);
            }}
            disabled={isRunning}
            className="max-w-[230px] truncate rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 cursor-pointer"
          >
            <option value="" disabled>
              {t.toolbar.examples}…
            </option>
            {COURSE_EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {locale === 'tr' ? ex.titleTr : ex.titleEn}
              </option>
            ))}
          </select>
        </div>

        {/* Center: Active File Name */}
        <div className="hidden md:flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 truncate max-w-[240px]">
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <span className="truncate font-medium">{displayFileName}</span>
          {hasUnsavedChanges && (
            <span
              title={t.status.modified}
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400 dark:bg-neutral-500"
            />
          )}
        </div>

        {/* Right: Status, Theme, TR/EN */}
        <div className="macos-no-drag flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 rounded border border-neutral-200 bg-white px-2 py-0.5 text-[11px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
            <span className="font-medium">{statusText}</span>
            <span className="text-neutral-300 dark:text-neutral-600">|</span>
            <span className="font-mono text-[11px]">
              {t.panels.cycles}: {cycleCount}
            </span>
          </div>

          {/* Theme Switcher */}
          <button
            type="button"
            onClick={onToggleTheme}
            title={theme === 'light' ? t.app.themeDark : t.app.themeLight}
            aria-label={theme === 'light' ? t.app.themeDark : t.app.themeLight}
            className="flex h-6 w-6 items-center justify-center rounded border border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {theme === 'light' ? (
              <Moon className="h-3.5 w-3.5" />
            ) : (
              <Sun className="h-3.5 w-3.5" />
            )}
          </button>

          {/* TR | EN Segmented Control */}
          <div
            className="flex items-center rounded border border-neutral-300 bg-neutral-200/70 p-0.5 text-[11px] font-medium dark:border-neutral-700 dark:bg-neutral-900"
            role="group"
            aria-label={t.app.languageLabel}
          >
            <button
              type="button"
              onClick={() => setLocale('tr')}
              className={`rounded-sm px-1.5 py-0.5 transition-colors ${
                locale === 'tr'
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              TR
            </button>
            <button
              type="button"
              onClick={() => setLocale('en')}
              className={`rounded-sm px-1.5 py-0.5 transition-colors ${
                locale === 'en'
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              EN
            </button>
          </div>
        </div>
      </div>

      {/* Row 2: Execution Controls + Homework Trace & Word (.docx) Export */}
      <div className="flex h-10 items-center justify-between gap-2 bg-neutral-50 px-3 dark:bg-[#1f1f21]">
        {/* Left: Debugger Controls */}
        <div className="flex items-center gap-1.5">
          {/* Compile / Load */}
          <button
            type="button"
            onClick={onCompile}
            disabled={isRunning}
            title={t.toolbar.compileLoadTip}
            className={
              status === 'modified' || status === 'error'
                ? `${btnBase} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`
                : btnNeutral
            }
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>{t.toolbar.compileLoad}</span>
          </button>

          {/* Run / Stop */}
          <button
            type="button"
            onClick={onRunOrStop}
            disabled={!isRunning && !canStep}
            title={t.toolbar.runTip}
            className={
              isRunning
                ? `${btnBase} border-red-600 bg-red-600 text-white hover:bg-red-700`
                : btnNeutral
            }
          >
            {isRunning ? (
              <>
                <Square className="h-3 w-3 fill-current" />
                <span>{t.toolbar.stop}</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current text-neutral-700 dark:text-neutral-200" />
                <span>{t.toolbar.run}</span>
              </>
            )}
          </button>

          {/* Single Step */}
          <button
            type="button"
            onClick={onStep}
            disabled={isRunning || !canStep}
            title={t.toolbar.singleStepTip}
            className={btnNeutral}
          >
            <StepForward className="h-3.5 w-3.5" />
            <span>{t.toolbar.singleStep}</span>
          </button>

          {/* Step Back */}
          <button
            type="button"
            onClick={onStepBack}
            disabled={isRunning || !canStepBack}
            title={t.toolbar.stepBackTip}
            className={btnNeutral}
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{t.toolbar.stepBack}</span>
          </button>

          {/* Reset */}
          <button
            type="button"
            onClick={onReset}
            disabled={isRunning}
            title={t.toolbar.resetTip}
            className={btnNeutral}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{t.toolbar.reset}</span>
          </button>

          {/* Speed selector */}
          <select
            aria-label={t.toolbar.speedLabel}
            value={runSpeed}
            onChange={(e) => onRunSpeedChange(e.target.value as RunSpeed)}
            disabled={isRunning}
            title={t.toolbar.speedLabel}
            className="ml-0.5 rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 focus:border-blue-500 focus:outline-none disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 cursor-pointer"
          >
            <option value="instant">{t.toolbar.speedInstant}</option>
            <option value="normal">{t.toolbar.speedNormal}</option>
            <option value="slow">{t.toolbar.speedSlow}</option>
          </select>
        </div>

        {/* Right: Step-by-Step Trace Recording & Word (.docx) Export */}
        <div className="flex items-center gap-1.5">
          {/* Trace Toggle */}
          <button
            type="button"
            onClick={onToggleTrace}
            disabled={isRunning}
            title={t.trace.recordTip}
            className={
              traceEnabled
                ? `${btnBase} border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300`
                : btnNeutral
            }
          >
            <span
              className={`h-2 w-2 rounded-full ${
                traceEnabled
                  ? 'bg-red-600 dark:bg-red-400'
                  : 'border border-neutral-400 bg-transparent'
              }`}
            />
            <span>{traceEnabled ? t.trace.recordOn : t.trace.recordLabel}</span>
            {traceStepCount > 0 && (
              <span className="rounded bg-black/10 px-1 py-0.2 font-mono text-[10px] dark:bg-white/10">
                {traceStepCount}
              </span>
            )}
          </button>

          {/* Preview Trace Table */}
          <button
            type="button"
            onClick={onOpenTraceModal}
            disabled={isRunning || traceStepCount === 0}
            title={t.trace.previewTable}
            className={btnNeutral}
          >
            <Table2 className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{t.trace.previewTable}</span>
          </button>

          {/* Export Word (.docx) */}
          <button
            type="button"
            onClick={onExportDocx}
            disabled={isRunning || traceStepCount === 0}
            title={t.trace.exportWordTip}
            className={
              traceStepCount > 0
                ? `${btnBase} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`
                : btnNeutral
            }
          >
            <FileDown className="h-3.5 w-3.5" />
            <span>{t.trace.exportWord}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
