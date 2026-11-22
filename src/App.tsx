import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderSearch, X } from 'lucide-react';
import { CodeEditor } from './components/CodeEditor';
import { MemoryViewer } from './components/MemoryViewer';
import { RegistersPanel } from './components/RegistersPanel';
import {
  TopBar,
  type EmulatorStatus,
  type RunSpeed,
  type ThemeMode,
} from './components/TopBar';
import { TraceModal } from './components/TraceModal';
import {
  EmulatorEngine,
  generateTraceDocx,
  type FlagName,
  type ICPUSnapshot,
  type IParseError,
  type IRuntimeError,
  type IStepResult,
  type ITraceEntry,
  type RegisterName,
} from './core';
import { COURSE_EXAMPLES, type ICodeExample } from './data/examples';
import { useI18n } from './i18n';

const RUN_INTERVAL_MS: Record<Exclude<RunSpeed, 'instant'>, number> = {
  normal: 75,
  slow: 340,
};

const NEW_FILE_TEMPLATE = `; EMU8086 Mac
ORG 100h

    MOV AX, 0000H
    RET
`;

interface INotification {
  message: string;
  savedPath?: string;
  isWordReport?: boolean;
}

function getInitialTheme(): ThemeMode {
  try {
    const saved = window.localStorage.getItem('emu8086-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // ignore storage errors
  }
  return 'light';
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export const App: React.FC = () => {
  const { locale, t } = useI18n();
  const defaultExample = COURSE_EXAMPLES[0];
  const engineRef = useRef<EmulatorEngine>(new EmulatorEngine());
  const runTimerRef = useRef<number | null>(null);
  const webFileInputRef = useRef<HTMLInputElement | null>(null);

  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [selectedExampleId, setSelectedExampleId] = useState<string>(defaultExample.id);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);

  const [code, setCode] = useState<string>(defaultExample.code);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [status, setStatus] = useState<EmulatorStatus>('ready');
  const [runSpeed, setRunSpeed] = useState<RunSpeed>('instant');
  const [isRunning, setIsRunning] = useState<boolean>(false);

  const [snapshot, setSnapshot] = useState<ICPUSnapshot>(() =>
    engineRef.current.cpu.getSnapshot()
  );
  const [memoryVersion, setMemoryVersion] = useState<number>(0);
  const [externalMemJump, setExternalMemJump] = useState<string | null>(
    defaultExample.suggestedMemoryAddress
  );

  const [lastExecutedLine, setLastExecutedLine] = useState<number | null>(null);
  const [changedRegisters, setChangedRegisters] = useState<Set<RegisterName>>(
    () => new Set()
  );
  const [changedFlags, setChangedFlags] = useState<Set<FlagName>>(() => new Set());
  const [writtenAddresses, setWrittenAddresses] = useState<Set<number>>(() => new Set());

  const [parseErrors, setParseErrors] = useState<IParseError[]>([]);
  const [runtimeError, setRuntimeError] = useState<IRuntimeError | null>(null);
  const [consoleOutput, setConsoleOutput] = useState<string>('');

  // Step-by-Step Trace Recording & Word (.docx) Export state
  const [traceEnabled, setTraceEnabled] = useState<boolean>(false);
  const [traceLog, setTraceLog] = useState<ITraceEntry[]>([]);
  const [traceTruncated, setTraceTruncated] = useState<boolean>(false);
  const [traceModalOpen, setTraceModalOpen] = useState<boolean>(false);

  const [notice, setNotice] = useState<INotification | null>(null);

  // Sync theme class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem('emu8086-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Keep window title updated with active filename
  useEffect(() => {
    const label = currentFileName ?? t.files.untitled;
    document.title = `${label}${hasUnsavedChanges ? ' •' : ''} — EMU8086 Mac`;
  }, [currentFileName, hasUnsavedChanges, t.files.untitled]);

  const syncTraceFromEngine = useCallback(() => {
    const engine = engineRef.current;
    setTraceLog([...engine.traceLog]);
    setTraceTruncated(engine.traceTruncated);
  }, []);

  const stopTimer = useCallback(() => {
    if (runTimerRef.current !== null) {
      window.clearInterval(runTimerRef.current);
      runTimerRef.current = null;
    }
    setIsRunning(false);
  }, []);

  const syncFromEngine = useCallback(() => {
    const engine = engineRef.current;
    setSnapshot(engine.cpu.getSnapshot());
    setConsoleOutput(engine.consoleOutput);
    setMemoryVersion((v) => v + 1);
    syncTraceFromEngine();
  }, [syncTraceFromEngine]);

  const compileSource = useCallback(
    (source: string): boolean => {
      stopTimer();
      const engine = engineRef.current;
      const result = engine.load(source);

      setChangedRegisters(new Set());
      setChangedFlags(new Set());
      setWrittenAddresses(new Set());
      setLastExecutedLine(null);
      setRuntimeError(null);

      if (!result.ok) {
        setParseErrors(result.errors);
        setStatus('error');
        return false;
      }

      setParseErrors([]);
      setIsDirty(false);
      syncFromEngine();
      setStatus(engine.cpu.halted ? 'halted' : 'compiled');
      return true;
    },
    [stopTimer, syncFromEngine]
  );

  useEffect(() => {
    compileSource(defaultExample.code);
    return () => {
      if (runTimerRef.current !== null) {
        window.clearInterval(runTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyStepResult = useCallback(
    (res: IStepResult) => {
      const engine = engineRef.current;
      setSnapshot(engine.cpu.getSnapshot());
      setConsoleOutput(res.consoleOutput);
      setLastExecutedLine(res.executedLine);
      setChangedRegisters(new Set(res.changedRegisters));
      setChangedFlags(new Set(res.changedFlags));
      setWrittenAddresses(new Set(res.writtenAddresses));
      if (res.writtenAddresses.length > 0) {
        setMemoryVersion((v) => v + 1);
      }
      syncTraceFromEngine();

      if (res.error) {
        setRuntimeError(res.error);
        setStatus('error');
      } else if (res.halted) {
        setRuntimeError(null);
        setStatus('halted');
      } else {
        setRuntimeError(null);
        setStatus('compiled');
      }
    },
    [syncTraceFromEngine]
  );

  const handleCompile = useCallback(() => {
    compileSource(code);
  }, [code, compileSource]);

  const handleStep = useCallback(() => {
    if (isRunning) return;
    if (isDirty) {
      compileSource(code);
      return;
    }
    const engine = engineRef.current;
    if (!engine.program || engine.cpu.halted) return;

    const res = engine.step();
    applyStepResult(res);
  }, [isRunning, isDirty, compileSource, code, applyStepResult]);

  const handleStepBack = useCallback(() => {
    if (isRunning) return;
    const engine = engineRef.current;
    const res = engine.stepBack();
    if (!res) return;

    setSnapshot(engine.cpu.getSnapshot());
    setConsoleOutput(res.consoleOutput);
    setLastExecutedLine(null);
    setChangedRegisters(new Set());
    setChangedFlags(new Set());
    setWrittenAddresses(new Set(res.writtenAddresses));
    setRuntimeError(null);
    setMemoryVersion((v) => v + 1);
    syncTraceFromEngine();
    setStatus(engine.cpu.halted ? 'halted' : 'compiled');
  }, [isRunning, syncTraceFromEngine]);

  const handleReset = useCallback(() => {
    stopTimer();
    const engine = engineRef.current;
    engine.resetLoadedProgram();
    setChangedRegisters(new Set());
    setChangedFlags(new Set());
    setWrittenAddresses(new Set());
    setLastExecutedLine(null);
    setRuntimeError(null);
    syncFromEngine();
    if (parseErrors.length > 0) {
      setStatus('error');
    } else if (isDirty) {
      setStatus('modified');
    } else {
      setStatus(engine.cpu.halted ? 'halted' : 'compiled');
    }
  }, [stopTimer, syncFromEngine, parseErrors.length, isDirty]);

  const handleRunOrStop = useCallback(() => {
    if (isRunning) {
      stopTimer();
      setStatus(engineRef.current.cpu.halted ? 'halted' : 'compiled');
      return;
    }

    if (isDirty) {
      const ok = compileSource(code);
      if (!ok) return;
    }

    const engine = engineRef.current;
    if (!engine.program || engine.cpu.halted) return;

    if (runSpeed === 'instant') {
      const res = engine.run(50000);
      applyStepResult(res);
      setMemoryVersion((v) => v + 1);
      return;
    }

    setIsRunning(true);
    setStatus('running');
    const delay = RUN_INTERVAL_MS[runSpeed];

    runTimerRef.current = window.setInterval(() => {
      const res = engine.step();
      applyStepResult(res);
      if (res.halted || res.error || !res.executed) {
        if (runTimerRef.current !== null) {
          window.clearInterval(runTimerRef.current);
          runTimerRef.current = null;
        }
        setIsRunning(false);
      } else {
        setStatus('running');
      }
    }, delay);
  }, [isRunning, stopTimer, isDirty, compileSource, code, runSpeed, applyStepResult]);

  const handleCodeChange = useCallback((nextCode: string) => {
    setCode(nextCode);
    setIsDirty(true);
    setHasUnsavedChanges(true);
    setStatus('modified');
    setRuntimeError(null);
  }, []);

  const handleSelectExample = useCallback(
    (example: ICodeExample) => {
      setSelectedExampleId(example.id);
      setCurrentFilePath(null);
      setCurrentFileName(`${example.id}.asm`);
      setHasUnsavedChanges(false);
      setCode(example.code);
      setExternalMemJump(example.suggestedMemoryAddress);
      compileSource(example.code);
    },
    [compileSource]
  );

  // -------------------------------------------------------------------------
  // Native File Operations (New / Open / Save / Save As / Drag & Drop)
  // -------------------------------------------------------------------------

  const handleNewFile = useCallback(() => {
    if (isRunning) return;
    setSelectedExampleId('');
    setCurrentFilePath(null);
    setCurrentFileName(null);
    setHasUnsavedChanges(false);
    setCode(NEW_FILE_TEMPLATE);
    compileSource(NEW_FILE_TEMPLATE);
  }, [isRunning, compileSource]);

  const loadOpenedAsm = useCallback(
    (fileName: string, content: string, filePath: string | null) => {
      setSelectedExampleId('');
      setCurrentFilePath(filePath);
      setCurrentFileName(fileName);
      setHasUnsavedChanges(false);
      setCode(content);
      compileSource(content);
      setNotice({ message: `${t.files.openedNotice} ${fileName}` });
    },
    [compileSource, t.files.openedNotice]
  );

  const handleOpenFile = useCallback(async () => {
    if (isRunning) return;
    if (window.electronAPI?.openAsmFile) {
      const res = await window.electronAPI.openAsmFile();
      if (!res.canceled && res.content !== undefined && res.fileName) {
        loadOpenedAsm(res.fileName, res.content, res.filePath ?? null);
      }
      return;
    }
    webFileInputRef.current?.click();
  }, [isRunning, loadOpenedAsm]);

  const handleWebFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        loadOpenedAsm(file.name, reader.result, null);
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleSaveFile = useCallback(
    async (forceSaveAs: boolean = false) => {
      if (isRunning) return;
      const defaultName = currentFileName ?? t.files.untitled;

      if (window.electronAPI?.saveAsmFile) {
        const res = await window.electronAPI.saveAsmFile({
          filePath: forceSaveAs ? null : currentFilePath,
          defaultName,
          content: code,
        });
        if (!res.canceled && !res.error && res.filePath && res.fileName) {
          setCurrentFilePath(res.filePath);
          setCurrentFileName(res.fileName);
          setHasUnsavedChanges(false);
          setNotice({
            message: `${t.files.savedNotice} ${res.fileName}`,
            savedPath: res.filePath,
          });
        }
        return;
      }

      const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
      triggerBrowserDownload(blob, defaultName);
      setHasUnsavedChanges(false);
      setNotice({ message: `${t.files.savedNotice} ${defaultName}` });
    },
    [isRunning, currentFileName, currentFilePath, code, t.files.untitled, t.files.savedNotice]
  );

  // -------------------------------------------------------------------------
  // Trace Recording & Word (.docx) Homework Report Export
  // -------------------------------------------------------------------------

  const handleToggleTrace = useCallback(() => {
    const engine = engineRef.current;
    const next = !traceEnabled;
    engine.setTraceEnabled(next);
    setTraceEnabled(next);
    syncTraceFromEngine();
  }, [traceEnabled, syncTraceFromEngine]);

  const handleClearTrace = useCallback(() => {
    engineRef.current.clearTrace();
    syncTraceFromEngine();
  }, [syncTraceFromEngine]);

  const handleExportDocx = useCallback(async () => {
    const engine = engineRef.current;
    const executedSteps = engine.traceLog.filter((e) => !e.isInitial).length;
    if (executedSteps === 0) return;

    const baseName = (currentFileName ?? t.files.untitled).replace(/\.[^.]+$/, '');
    const defaultDocxName = `${baseName}_${locale === 'tr' ? 'rapor' : 'trace'}.docx`;

    const bytes = await generateTraceDocx({
      programName: currentFileName ?? t.files.untitled,
      sourceCode: code,
      traceLog: engine.traceLog,
      truncated: engine.traceTruncated,
      locale,
    });

    if (window.electronAPI?.saveDocxFile) {
      const res = await window.electronAPI.saveDocxFile({
        defaultName: defaultDocxName,
        data: bytes,
      });
      if (!res.canceled && !res.error && res.filePath && res.fileName) {
        setNotice({
          message: `${t.trace.wordSavedNotice} ${res.fileName}`,
          savedPath: res.filePath,
          isWordReport: true,
        });
      }
      return;
    }

    const blob = new Blob([new Uint8Array(bytes)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    triggerBrowserDownload(blob, defaultDocxName);
    setNotice({
      message: `${t.trace.wordSavedNotice} ${defaultDocxName}`,
      isWordReport: true,
    });
  }, [currentFileName, code, locale, t.files.untitled, t.trace.wordSavedNotice]);

  // Wire native macOS Menu Bar actions (File -> New/Open/Save/Save As/Export Word)
  useEffect(() => {
    if (!window.electronAPI?.onMenuAction) return;
    return window.electronAPI.onMenuAction((action) => {
      if (action === 'new') handleNewFile();
      else if (action === 'open') void handleOpenFile();
      else if (action === 'save') void handleSaveFile(false);
      else if (action === 'save-as') void handleSaveFile(true);
      else if (action === 'export-docx') void handleExportDocx();
    });
  }, [handleNewFile, handleOpenFile, handleSaveFile, handleExportDocx]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        handleCompile();
      } else if (!window.electronAPI && mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveFile(e.shiftKey);
      } else if (!window.electronAPI && mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void handleOpenFile();
      } else if (!window.electronAPI && mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void handleExportDocx();
      } else if (e.key === 'F8') {
        e.preventDefault();
        handleStep();
      } else if (e.key === 'F7') {
        e.preventDefault();
        handleStepBack();
      } else if (e.key === 'F9') {
        e.preventDefault();
        handleRunOrStop();
      } else if (e.key === 'Escape') {
        if (traceModalOpen) {
          setTraceModalOpen(false);
        } else if (isRunning) {
          e.preventDefault();
          handleRunOrStop();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleCompile,
    handleSaveFile,
    handleOpenFile,
    handleExportDocx,
    handleStep,
    handleStepBack,
    handleRunOrStop,
    isRunning,
    traceModalOpen,
  ]);

  const handleEditMemoryByte = useCallback((physicalAddress: number, newValue: number) => {
    const engine = engineRef.current;
    engine.cpu.memory.writeByte(physicalAddress, newValue);
    setWrittenAddresses(new Set([physicalAddress]));
    setMemoryVersion((v) => v + 1);
  }, []);

  const handleClearConsole = useCallback(() => {
    engineRef.current.consoleOutput = '';
    setConsoleOutput('');
  }, []);

  const engine = engineRef.current;
  const nextInstruction = engine.nextInstruction;
  const activeLine = nextInstruction ? nextInstruction.line : null;
  const instructionCount = engine.program ? engine.program.instructions.length : 0;
  const canStep = Boolean(
    isDirty || (engine.program && !engine.cpu.halted && parseErrors.length === 0)
  );
  const canStepBack = !isDirty && engine.canStepBack;
  const traceStepCount = traceLog.filter((e) => !e.isInitial).length;

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-100 text-neutral-900 overflow-hidden dark:bg-[#1c1c1e] dark:text-neutral-100">
      {/* Hidden input fallback for web-mode file opening */}
      <input
        ref={webFileInputRef}
        type="file"
        accept=".asm,.txt,.s,.inc"
        onChange={handleWebFilePicked}
        className="hidden"
      />

      {/* Top Bar */}
      <TopBar
        status={status}
        cycleCount={snapshot.cycleCount}
        isRunning={isRunning}
        canStep={canStep}
        canStepBack={canStepBack}
        runSpeed={runSpeed}
        selectedExampleId={selectedExampleId}
        currentFileName={currentFileName}
        hasUnsavedChanges={hasUnsavedChanges}
        traceEnabled={traceEnabled}
        traceStepCount={traceStepCount}
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
        onRunSpeedChange={setRunSpeed}
        onNewFile={handleNewFile}
        onOpenFile={() => void handleOpenFile()}
        onSaveFile={() => void handleSaveFile(false)}
        onSaveFileAs={() => void handleSaveFile(true)}
        onCompile={handleCompile}
        onRunOrStop={handleRunOrStop}
        onStep={handleStep}
        onStepBack={handleStepBack}
        onReset={handleReset}
        onSelectExample={handleSelectExample}
        onToggleTrace={handleToggleTrace}
        onOpenTraceModal={() => setTraceModalOpen(true)}
        onExportDocx={() => void handleExportDocx()}
      />

      {/* Subtle File / Export Notification Banner */}
      {notice && (
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 shrink-0 dark:border-neutral-800 dark:bg-[#252527] dark:text-neutral-200">
          <span className="truncate font-medium">{notice.message}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {notice.savedPath && window.electronAPI && (
              <>
                {notice.isWordReport && (
                  <button
                    type="button"
                    onClick={() => void window.electronAPI?.openSavedFile(notice.savedPath!)}
                    className="inline-flex items-center gap-1 rounded border border-neutral-300 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>{t.trace.openInWord}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void window.electronAPI?.revealInFinder(notice.savedPath!)}
                  className="inline-flex items-center gap-1 rounded border border-neutral-300 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
                >
                  <FolderSearch className="h-3 w-3" />
                  <span>{t.trace.revealInFinder}</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label={t.trace.close}
              className="rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Workspace */}
      <main className="flex flex-1 flex-col gap-2 p-2 overflow-hidden min-h-0">
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_350px] gap-2 min-h-0">
          <CodeEditor
            code={code}
            onChange={handleCodeChange}
            onDropFile={(name, content) => loadOpenedAsm(name, content, null)}
            activeLine={activeLine}
            lastExecutedLine={lastExecutedLine}
            nextInstruction={nextInstruction}
            csRegister={snapshot.registers.CS}
            instructionCount={instructionCount}
            parseErrors={parseErrors}
            runtimeError={runtimeError}
            consoleOutput={consoleOutput}
            isDirty={isDirty}
            isRunning={isRunning}
            onClearConsole={handleClearConsole}
          />

          <RegistersPanel
            snapshot={snapshot}
            changedRegisters={changedRegisters}
            changedFlags={changedFlags}
          />
        </div>

        <MemoryViewer
          memory={engine.cpu.memory}
          memoryVersion={memoryVersion}
          registers={snapshot.registers}
          writtenAddresses={writtenAddresses}
          externalJumpAddress={externalMemJump}
          onEditByte={handleEditMemoryByte}
        />
      </main>

      {/* Trace Preview & Word Export Modal */}
      <TraceModal
        open={traceModalOpen}
        traceLog={traceLog}
        truncated={traceTruncated}
        onClose={() => setTraceModalOpen(false)}
        onClear={handleClearTrace}
        onExportDocx={() => void handleExportDocx()}
      />
    </div>
  );
};

export default App;
