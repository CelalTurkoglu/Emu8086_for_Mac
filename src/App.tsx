import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderSearch, X } from 'lucide-react';
import { CodeEditor } from './components/CodeEditor';
import { ConfirmModal } from './components/ConfirmModal';
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
  type FlagName,
  type ICPUSnapshot,
  type IParseError,
  type IParseWarning,
  type IPendingInputRequest,
  type IRuntimeError,
  type IRuntimeWarning,
  type IStepResult,
  type ITraceEntry,
  type RegisterName,
} from './core';
import { COURSE_EXAMPLES, type ICodeExample } from './data/examples';
import { useI18n } from './i18n';
import {
  decodeCodeFromShareHash,
  encodeCodeToShareHash,
  isElectron,
  loadDraftCode,
  loadInitialStrictMode,
  readWebAsmFileSafe,
  saveDraftCode,
  saveStrictMode,
} from './platform';

const RUN_INTERVAL_MS: Record<Exclude<RunSpeed, 'instant'>, number> = {
  normal: 75,
  slow: 340,
};

const NEW_FILE_TEMPLATE = `; EMU8086
ORG 100h

    MOV AX, 0000H
    RET
`;

interface INotification {
  message: string;
  savedPath?: string;
  isWordReport?: boolean;
  isError?: boolean;
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
  const resumeRunAfterInputRef = useRef<boolean>(false);
  const webFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingProtectedActionRef = useRef<(() => void) | null>(null);

  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [strictMode, setStrictMode] = useState<boolean>(loadInitialStrictMode);
  const [selectedExampleId, setSelectedExampleId] = useState<string>(
    defaultExample.id
  );
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string | null>(
    `${defaultExample.id}.asm`
  );
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState<boolean>(false);

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
  const [externalMemJumpNonce, setExternalMemJumpNonce] = useState<number>(0);

  const [lastExecutedLine, setLastExecutedLine] = useState<number | null>(null);
  const [changedRegisters, setChangedRegisters] = useState<Set<RegisterName>>(
    () => new Set()
  );
  const [changedFlags, setChangedFlags] = useState<Set<FlagName>>(
    () => new Set()
  );
  const [writtenAddresses, setWrittenAddresses] = useState<Set<number>>(
    () => new Set()
  );

  const [parseErrors, setParseErrors] = useState<IParseError[]>([]);
  const [parseWarnings, setParseWarnings] = useState<IParseWarning[]>([]);
  const [runtimeError, setRuntimeError] = useState<IRuntimeError | null>(null);
  const [runtimeWarning, setRuntimeWarning] = useState<IRuntimeWarning | null>(
    null
  );
  const [pendingInput, setPendingInput] =
    useState<IPendingInputRequest | null>(null);
  const [consoleOutput, setConsoleOutput] = useState<string>('');

  // Step-by-Step Trace Recording & Word (.docx) Export state
  const [traceEnabled, setTraceEnabled] = useState<boolean>(false);
  const [traceLog, setTraceLog] = useState<ITraceEntry[]>([]);
  const [traceTruncated, setTraceTruncated] = useState<boolean>(false);
  const [traceModalOpen, setTraceModalOpen] = useState<boolean>(false);
  const [isExportingDocx, setIsExportingDocx] = useState<boolean>(false);

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

  // Keep window title & Electron dirty state updated
  useEffect(() => {
    const label = currentFileName ?? t.files.untitled;
    const appTitle = isElectron() ? 'EMU8086 Mac' : 'EMU8086 Online';
    document.title = `${label}${hasUnsavedChanges ? ' •' : ''} — ${appTitle}`;
    void window.electronAPI?.setUnsavedChanges?.(hasUnsavedChanges);
  }, [currentFileName, hasUnsavedChanges, t.files.untitled]);

  // Browser beforeunload guard when unsaved changes exist on Web
  useEffect(() => {
    if (isElectron()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  // Security: Global dragover/drop prevention so dropping files outside CodeEditor never navigates
  useEffect(() => {
    const preventNav = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener('dragover', preventNav);
    window.addEventListener('drop', preventNav);
    return () => {
      window.removeEventListener('dragover', preventNav);
      window.removeEventListener('drop', preventNav);
    };
  }, []);

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
    setPendingInput(engine.pendingInput);
    setMemoryVersion((v) => v + 1);
    syncTraceFromEngine();
  }, [syncTraceFromEngine]);

  const compileSource = useCallback(
    (source: string, strictOverride?: boolean): boolean => {
      stopTimer();
      resumeRunAfterInputRef.current = false;
      const engine = engineRef.current;
      const useStrict = strictOverride ?? strictMode;
      engine.strictMode = useStrict;
      const result = engine.load(source, { strictMode: useStrict });

      setChangedRegisters(new Set());
      setChangedFlags(new Set());
      setWrittenAddresses(new Set());
      setLastExecutedLine(null);
      setRuntimeError(null);
      setRuntimeWarning(null);
      setPendingInput(null);
      setParseWarnings(result.warnings);

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
    [stopTimer, strictMode, syncFromEngine]
  );

  // Initial load: check URL `#code=...` share link first, then saved web draft, then default example
  useEffect(() => {
    const sharedCode =
      typeof window !== 'undefined'
        ? decodeCodeFromShareHash(window.location.hash)
        : null;
    if (sharedCode) {
      setSelectedExampleId('');
      setCurrentFileName('shared.asm');
      setCode(sharedCode);
      compileSource(sharedCode);
    } else {
      const savedDraft = !isElectron() ? loadDraftCode() : null;
      if (savedDraft && savedDraft.trim().length > 0 && savedDraft !== defaultExample.code) {
        setSelectedExampleId('');
        setCurrentFileName(t.files.untitled);
        setCode(savedDraft);
        compileSource(savedDraft);
      } else {
        compileSource(defaultExample.code);
      }
    }
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
      setPendingInput(res.waitingForInput ?? null);
      if (res.warning) {
        setRuntimeWarning(res.warning);
      }
      if (res.writtenAddresses.length > 0) {
        setMemoryVersion((v) => v + 1);
      }
      syncTraceFromEngine();

      if (res.error) {
        setRuntimeError(res.error);
        setStatus('error');
      } else if (res.waitingForInput) {
        setRuntimeError(null);
        setStatus('compiled');
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

  const handleToggleStrictMode = useCallback(() => {
    const nextStrict = !strictMode;
    setStrictMode(nextStrict);
    saveStrictMode(nextStrict);
    compileSource(code, nextStrict);
  }, [strictMode, code, compileSource]);

  const handleShareLink = useCallback(() => {
    const hash = encodeCodeToShareHash(code);
    const baseUrl = window.location.href.split('#')[0];
    const fullUrl = `${baseUrl}${hash}`;
    try {
      window.history.replaceState(null, '', hash);
    } catch {
      // ignore in file:// origin if restricted
    }
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(fullUrl);
    }
    setNotice({ message: t.app.shareLinkCopied });
  }, [code, t.app.shareLinkCopied]);

  const handleStep = useCallback(() => {
    if (isRunning) return;
    if (isDirty) {
      compileSource(code);
      return;
    }
    const engine = engineRef.current;
    if (!engine.program || engine.cpu.halted) return;

    resumeRunAfterInputRef.current = false;
    const res = engine.step();
    applyStepResult(res);
  }, [isRunning, isDirty, compileSource, code, applyStepResult]);

  const handleStepBack = useCallback(() => {
    if (isRunning) return;
    resumeRunAfterInputRef.current = false;
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
    setRuntimeWarning(null);
    setPendingInput(null);
    setMemoryVersion((v) => v + 1);
    syncTraceFromEngine();
    setStatus(engine.cpu.halted ? 'halted' : 'compiled');
  }, [isRunning, syncTraceFromEngine]);

  const handleReset = useCallback(() => {
    stopTimer();
    resumeRunAfterInputRef.current = false;
    const engine = engineRef.current;
    engine.resetLoadedProgram();
    setChangedRegisters(new Set());
    setChangedFlags(new Set());
    setWrittenAddresses(new Set());
    setLastExecutedLine(null);
    setRuntimeError(null);
    setRuntimeWarning(null);
    setPendingInput(null);
    syncFromEngine();
    if (parseErrors.length > 0) {
      setStatus('error');
    } else if (isDirty) {
      setStatus('modified');
    } else {
      setStatus(engine.cpu.halted ? 'halted' : 'compiled');
    }
  }, [stopTimer, syncFromEngine, parseErrors.length, isDirty]);

  const startContinuousRun = useCallback(() => {
    const engine = engineRef.current;
    if (!engine.program || engine.cpu.halted) return;

    if (runSpeed === 'instant') {
      const res = engine.run(50000);
      if (res.waitingForInput) {
        resumeRunAfterInputRef.current = true;
      } else {
        resumeRunAfterInputRef.current = false;
      }
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
      if (res.waitingForInput) {
        if (runTimerRef.current !== null) {
          window.clearInterval(runTimerRef.current);
          runTimerRef.current = null;
        }
        resumeRunAfterInputRef.current = true;
        setIsRunning(false);
      } else if (res.halted || res.error || !res.executed) {
        if (runTimerRef.current !== null) {
          window.clearInterval(runTimerRef.current);
          runTimerRef.current = null;
        }
        resumeRunAfterInputRef.current = false;
        setIsRunning(false);
      } else {
        setStatus('running');
      }
    }, delay);
  }, [runSpeed, applyStepResult]);

  const handleRunOrStop = useCallback(() => {
    if (isRunning) {
      stopTimer();
      resumeRunAfterInputRef.current = false;
      setStatus(engineRef.current.cpu.halted ? 'halted' : 'compiled');
      return;
    }

    if (isDirty) {
      const ok = compileSource(code);
      if (!ok) return;
    }

    startContinuousRun();
  }, [isRunning, stopTimer, isDirty, compileSource, code, startContinuousRun]);

  const handleProvideInput = useCallback(
    (value: string) => {
      const engine = engineRef.current;
      engine.provideInput(value);
      setPendingInput(null);
      if (resumeRunAfterInputRef.current) {
        startContinuousRun();
      } else {
        const res = engine.step();
        applyStepResult(res);
      }
    },
    [startContinuousRun, applyStepResult]
  );

  const handleCodeChange = useCallback((nextCode: string) => {
    setCode(nextCode);
    setIsDirty(true);
    setHasUnsavedChanges(true);
    setStatus('modified');
    setRuntimeError(null);
    setRuntimeWarning(null);
    saveDraftCode(nextCode);
  }, []);

  // -------------------------------------------------------------------------
  // Unsaved Changes Protection Wrapper
  // -------------------------------------------------------------------------

  const runWithUnsavedGuard = useCallback(
    (action: () => void) => {
      if (hasUnsavedChanges) {
        pendingProtectedActionRef.current = action;
        setConfirmModalOpen(true);
      } else {
        action();
      }
    },
    [hasUnsavedChanges]
  );

  const handleSelectExample = useCallback(
    (example: ICodeExample) => {
      runWithUnsavedGuard(() => {
        setSelectedExampleId(example.id);
        setCurrentFilePath(null);
        setCurrentFileName(`${example.id}.asm`);
        setHasUnsavedChanges(false);
        setCode(example.code);
        saveDraftCode(example.code);
        setExternalMemJump(example.suggestedMemoryAddress);
        setExternalMemJumpNonce((n) => n + 1);
        compileSource(example.code);
      });
    },
    [runWithUnsavedGuard, compileSource]
  );

  // -------------------------------------------------------------------------
  // File Operations (New / Open / Save / Save As / Drag & Drop)
  // -------------------------------------------------------------------------

  const handleNewFile = useCallback(() => {
    if (isRunning) return;
    runWithUnsavedGuard(() => {
      setSelectedExampleId('');
      setCurrentFilePath(null);
      setCurrentFileName(null);
      setHasUnsavedChanges(false);
      setCode(NEW_FILE_TEMPLATE);
      saveDraftCode(NEW_FILE_TEMPLATE);
      compileSource(NEW_FILE_TEMPLATE);
    });
  }, [isRunning, runWithUnsavedGuard, compileSource]);

  const loadOpenedAsm = useCallback(
    (fileName: string, content: string, filePath: string | null) => {
      setSelectedExampleId('');
      setCurrentFilePath(filePath);
      setCurrentFileName(fileName);
      setHasUnsavedChanges(false);
      setCode(content);
      saveDraftCode(content);
      compileSource(content);
      setNotice({ message: `${t.files.openedNotice} ${fileName}` });
    },
    [compileSource, t.files.openedNotice]
  );

  const performOpenFile = useCallback(async () => {
    if (isRunning) return;
    if (window.electronAPI?.openAsmFile) {
      const res = await window.electronAPI.openAsmFile();
      if (res.error) {
        setNotice({ message: res.error, isError: true });
        return;
      }
      if (!res.canceled && res.content !== undefined && res.fileName) {
        loadOpenedAsm(res.fileName, res.content, res.filePath ?? null);
      }
      return;
    }
    webFileInputRef.current?.click();
  }, [isRunning, loadOpenedAsm]);

  const handleOpenFile = useCallback(() => {
    if (isRunning) return;
    runWithUnsavedGuard(() => {
      void performOpenFile();
    });
  }, [isRunning, runWithUnsavedGuard, performOpenFile]);

  const handleWebFilePicked = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const res = await readWebAsmFileSafe(file);
    if (!res.ok) {
      setNotice({
        message:
          locale === 'tr'
            ? res.errorTr ?? 'Dosya açılamadı.'
            : res.errorEn ?? 'Could not open file.',
        isError: true,
      });
      return;
    }
    if (res.content !== undefined) {
      loadOpenedAsm(file.name, res.content, null);
    }
  };

  const handleSaveFile = useCallback(
    async (forceSaveAs: boolean = false): Promise<boolean> => {
      if (isRunning) return false;
      const defaultName = currentFileName ?? t.files.untitled;

      if (window.electronAPI?.saveAsmFile) {
        const res = await window.electronAPI.saveAsmFile({
          filePath: forceSaveAs ? null : currentFilePath,
          defaultName,
          content: code,
        });
        if (res.error) {
          setNotice({ message: res.error, isError: true });
          return false;
        }
        if (!res.canceled && res.filePath && res.fileName) {
          setCurrentFilePath(res.filePath);
          setCurrentFileName(res.fileName);
          setHasUnsavedChanges(false);
          setNotice({
            message: `${t.files.savedNotice} ${res.fileName}`,
            savedPath: res.filePath,
          });
          return true;
        }
        return false;
      }

      const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
      triggerBrowserDownload(blob, defaultName);
      setHasUnsavedChanges(false);
      setNotice({ message: `${t.files.savedNotice} ${defaultName}` });
      return true;
    },
    [
      isRunning,
      currentFileName,
      currentFilePath,
      code,
      t.files.untitled,
      t.files.savedNotice,
    ]
  );

  // -------------------------------------------------------------------------
  // Trace Recording & Lazy-Loaded Word (.docx) Homework Report Export
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
    const executedSteps =
      engine.traceLog.length > 0 && engine.traceLog[0].isInitial
        ? engine.traceLog.length - 1
        : engine.traceLog.filter((e) => !e.isInitial).length;
    if (executedSteps === 0 || isExportingDocx) return;

    const baseName = (currentFileName ?? t.files.untitled).replace(
      /\.[^.]+$/,
      ''
    );
    const defaultDocxName = `${baseName}_${
      locale === 'tr' ? 'rapor' : 'trace'
    }.docx`;
    // Always use the compiled program's sourceCode so edits made after execution don't mismatch the trace
    const reportSourceCode = engine.program?.sourceCode ?? code;

    setIsExportingDocx(true);
    try {
      const { generateTraceDocx } = await import('./core/docxExporter');
      const bytes = await generateTraceDocx({
        programName: currentFileName ?? t.files.untitled,
        sourceCode: reportSourceCode,
        traceLog: engine.traceLog,
        truncated: engine.traceTruncated,
        locale,
      });

      if (window.electronAPI?.saveDocxFile) {
        const res = await window.electronAPI.saveDocxFile({
          defaultName: defaultDocxName,
          data: bytes,
        });
        if (res.error) {
          setNotice({
            message: `${t.trace.exportError} ${res.error}`,
            isError: true,
          });
          return;
        }
        if (!res.canceled && res.filePath && res.fileName) {
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
    } catch (err) {
      setNotice({
        message: `${t.trace.exportError} ${String(err)}`,
        isError: true,
      });
    } finally {
      setIsExportingDocx(false);
    }
  }, [
    currentFileName,
    code,
    locale,
    isExportingDocx,
    t.files.untitled,
    t.trace.wordSavedNotice,
    t.trace.exportError,
  ]);

  // Wire native Electron Menu Bar actions
  useEffect(() => {
    if (!window.electronAPI?.onMenuAction) return;
    return window.electronAPI.onMenuAction((action) => {
      if (action === 'new') handleNewFile();
      else if (action === 'open') handleOpenFile();
      else if (action === 'save') void handleSaveFile(false);
      else if (action === 'save-as') void handleSaveFile(true);
      else if (action === 'export-docx') void handleExportDocx();
    });
  }, [handleNewFile, handleOpenFile, handleSaveFile, handleExportDocx]);

  // Global keyboard shortcuts (works on both Web and Desktop)
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
        handleOpenFile();
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
        if (confirmModalOpen) {
          setConfirmModalOpen(false);
          pendingProtectedActionRef.current = null;
        } else if (traceModalOpen) {
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
    confirmModalOpen,
  ]);

  const handleEditMemoryByte = useCallback(
    (physicalAddress: number, newValue: number) => {
      const engine = engineRef.current;
      engine.cpu.memory.writeByte(physicalAddress, newValue);
      setWrittenAddresses(new Set([physicalAddress]));
      setMemoryVersion((v) => v + 1);
    },
    []
  );

  const handleClearConsole = useCallback(() => {
    engineRef.current.consoleOutput = '';
    setConsoleOutput('');
  }, []);

  const engine = engineRef.current;
  const nextInstruction = engine.nextInstruction;
  const activeLine = nextInstruction ? nextInstruction.line : null;
  const instructionCount = engine.program
    ? engine.program.instructions.length
    : 0;
  const canStep = Boolean(
    isDirty ||
      (engine.program &&
        !engine.cpu.halted &&
        parseErrors.length === 0 &&
        !pendingInput)
  );
  const canStepBack = !isDirty && engine.canStepBack;
  const traceStepCount =
    traceLog.length > 0 && traceLog[0].isInitial
      ? traceLog.length - 1
      : traceLog.filter((e) => !e.isInitial).length;

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-100 text-neutral-900 overflow-hidden dark:bg-[#1c1c1e] dark:text-neutral-100">
      {/* Hidden input fallback for web-mode file opening */}
      <input
        ref={webFileInputRef}
        type="file"
        accept=".asm,.txt,.s,.inc"
        onChange={(e) => void handleWebFilePicked(e)}
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
        strictMode={strictMode}
        traceEnabled={traceEnabled}
        traceStepCount={traceStepCount}
        isExportingDocx={isExportingDocx}
        theme={theme}
        onToggleTheme={() =>
          setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))
        }
        onToggleStrictMode={handleToggleStrictMode}
        onShareLink={handleShareLink}
        onRunSpeedChange={setRunSpeed}
        onNewFile={handleNewFile}
        onOpenFile={handleOpenFile}
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
        <div
          className={`flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs shrink-0 ${
            notice.isError
              ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
              : 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-[#252527] dark:text-neutral-200'
          }`}
        >
          <span className="truncate font-medium">{notice.message}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {notice.savedPath && window.electronAPI && (
              <>
                {notice.isWordReport && (
                  <button
                    type="button"
                    onClick={() =>
                      void window.electronAPI?.openSavedFile(notice.savedPath!)
                    }
                    className="inline-flex items-center gap-1 rounded border border-neutral-300 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>{t.trace.openInWord}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void window.electronAPI?.revealInFinder(notice.savedPath!)
                  }
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
      <main className="flex flex-1 flex-col gap-2 p-2 overflow-y-auto lg:overflow-hidden min-h-0">
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_350px] gap-2 min-h-[360px] lg:min-h-0">
          <CodeEditor
            code={code}
            onChange={handleCodeChange}
            onDropFile={(name, content) =>
              runWithUnsavedGuard(() => loadOpenedAsm(name, content, null))
            }
            onFileError={(msg) => setNotice({ message: msg, isError: true })}
            activeLine={activeLine}
            lastExecutedLine={lastExecutedLine}
            nextInstruction={nextInstruction}
            csRegister={snapshot.registers.CS}
            instructionCount={instructionCount}
            parseErrors={parseErrors}
            parseWarnings={parseWarnings}
            runtimeError={runtimeError}
            runtimeWarning={runtimeWarning}
            pendingInput={pendingInput}
            onProvideInput={handleProvideInput}
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
          externalJumpNonce={externalMemJumpNonce}
          onEditByte={handleEditMemoryByte}
        />
      </main>

      {/* Trace Preview & Word Export Modal */}
      <TraceModal
        open={traceModalOpen}
        traceLog={traceLog}
        truncated={traceTruncated}
        isExporting={isExportingDocx}
        onClose={() => setTraceModalOpen(false)}
        onClear={handleClearTrace}
        onExportDocx={() => void handleExportDocx()}
      />

      {/* Unsaved Changes Confirmation Modal */}
      <ConfirmModal
        open={confirmModalOpen}
        onCancel={() => {
          setConfirmModalOpen(false);
          pendingProtectedActionRef.current = null;
        }}
        onDiscard={() => {
          const act = pendingProtectedActionRef.current;
          setConfirmModalOpen(false);
          pendingProtectedActionRef.current = null;
          act?.();
        }}
        onSaveAndContinue={() => {
          const act = pendingProtectedActionRef.current;
          setConfirmModalOpen(false);
          pendingProtectedActionRef.current = null;
          void handleSaveFile(false).then((saved) => {
            if (saved) act?.();
          });
        }}
      />
    </div>
  );
};

export default App;
