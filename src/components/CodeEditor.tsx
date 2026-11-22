import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatHex,
  type IParseError,
  type IParsedInstruction,
  type IRuntimeError,
} from '../core';
import { useI18n } from '../i18n';

interface CodeEditorProps {
  code: string;
  onChange: (nextCode: string) => void;
  onDropFile?: (fileName: string, content: string) => void;
  activeLine: number | null;
  lastExecutedLine: number | null;
  nextInstruction: IParsedInstruction | null;
  csRegister: number;
  instructionCount: number;
  parseErrors: IParseError[];
  runtimeError: IRuntimeError | null;
  consoleOutput: string;
  isDirty: boolean;
  isRunning: boolean;
  onClearConsole: () => void;
}

const LINE_HEIGHT_PX = 22;

export const CodeEditor: React.FC<CodeEditorProps> = ({
  code,
  onChange,
  onDropFile,
  activeLine,
  lastExecutedLine,
  nextInstruction,
  csRegister,
  instructionCount,
  parseErrors,
  runtimeError,
  consoleOutput,
  isDirty,
  isRunning,
  onClearConsole,
}) => {
  const { locale, t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const lines = useMemo(() => code.split('\n'), [code]);

  const errorLineSet = useMemo(() => {
    const set = new Set<number>();
    for (const err of parseErrors) {
      set.add(err.line);
    }
    if (runtimeError) {
      set.add(runtimeError.line);
    }
    return set;
  }, [parseErrors, runtimeError]);

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const top = e.currentTarget.scrollTop;
    if (gutterRef.current) gutterRef.current.scrollTop = top;
    if (backdropRef.current) backdropRef.current.scrollTop = top;
  };

  useEffect(() => {
    if (activeLine === null || !textareaRef.current) return;
    const ta = textareaRef.current;
    const lineTop = (activeLine - 1) * LINE_HEIGHT_PX;
    const lineBottom = lineTop + LINE_HEIGHT_PX;
    const visibleTop = ta.scrollTop;
    const visibleBottom = ta.scrollTop + ta.clientHeight - 24;

    if (lineTop < visibleTop || lineBottom > visibleBottom) {
      const targetScroll = Math.max(0, lineTop - ta.clientHeight / 3);
      ta.scrollTop = targetScroll;
      if (gutterRef.current) gutterRef.current.scrollTop = targetScroll;
      if (backdropRef.current) backdropRef.current.scrollTop = targetScroll;
    }
  }, [activeLine]);

  const jumpToLine = (lineNumber: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const targetIdx = Math.max(0, lineNumber - 1);
    let charOffset = 0;
    for (let i = 0; i < targetIdx && i < lines.length; i++) {
      charOffset += lines[i].length + 1;
    }
    ta.focus();
    ta.setSelectionRange(charOffset, charOffset + (lines[targetIdx]?.length ?? 0));
    const targetScroll = Math.max(0, targetIdx * LINE_HEIGHT_PX - ta.clientHeight / 3);
    ta.scrollTop = targetScroll;
    if (gutterRef.current) gutterRef.current.scrollTop = targetScroll;
    if (backdropRef.current) backdropRef.current.scrollTop = targetScroll;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = code.slice(0, start) + '    ' + code.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 4;
      });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!onDropFile || isRunning) return;
    e.preventDefault();
    setIsDraggingFile(true);
  };

  const handleDragLeave = () => {
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    if (!onDropFile || isRunning) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onDropFile(file.name, reader.result);
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const allDiagnostics = useMemo(() => {
    const items: Array<{
      line: number;
      code: string;
      message: string;
      kind: 'parse' | 'runtime';
    }> = [];
    for (const err of parseErrors) {
      items.push({
        line: err.line,
        code: err.code,
        message: locale === 'tr' ? err.messageTr : err.messageEn,
        kind: 'parse',
      });
    }
    if (runtimeError) {
      items.push({
        line: runtimeError.line,
        code: runtimeError.code,
        message: locale === 'tr' ? runtimeError.messageTr : runtimeError.messageEn,
        kind: 'runtime',
      });
    }
    return items;
  }, [parseErrors, runtimeError, locale]);

  return (
    <section
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex flex-col rounded-md border border-neutral-200 bg-white overflow-hidden min-h-0 dark:border-neutral-800 dark:bg-[#1e1e1e]"
    >
      {/* Drag-and-drop overlay */}
      {isDraggingFile && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-blue-50/90 border-2 border-dashed border-blue-500 text-sm font-medium text-blue-700 dark:bg-blue-950/80 dark:text-blue-200">
          {t.files.dropHint}
        </div>
      )}

      {/* Header Bar */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 shrink-0 dark:border-neutral-800 dark:bg-[#252527]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
            {t.panels.codeEditor}
          </span>
          <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            ({instructionCount} {t.panels.instructionsCount})
          </span>
        </div>

        {/* Next CS:IP instruction */}
        <div className="flex items-center gap-1.5 min-w-0">
          {nextInstruction && !isDirty ? (
            <div
              title={t.panels.nextInstruction}
              className="flex items-center gap-1.5 rounded border border-neutral-200 bg-white px-2 py-0.5 font-mono text-[11px] truncate max-w-[320px] dark:border-neutral-700 dark:bg-neutral-900"
            >
              <span className="font-semibold text-neutral-500 shrink-0 dark:text-neutral-400">
                {formatHex(csRegister, 4)}:{formatHex(nextInstruction.offset, 4)}
              </span>
              <span className="text-neutral-900 truncate dark:text-neutral-100">
                {nextInstruction.source.replace(/;.*$/, '').trim()}
              </span>
            </div>
          ) : (
            <span className="font-mono text-[11px] text-neutral-400 truncate dark:text-neutral-500">
              {isDirty ? t.status.modified : t.panels.noNextInstruction}
            </span>
          )}
        </div>
      </div>

      {/* Dirty / Needs Recompile Bar */}
      {isDirty && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1 text-[11px] text-amber-800 shrink-0 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="truncate">{t.status.needsRecompileHint}</span>
        </div>
      )}

      {/* Editor Body */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden bg-white dark:bg-[#1e1e1e]">
        {/* Gutter */}
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="w-12 shrink-0 select-none overflow-hidden border-r border-neutral-200 bg-neutral-50 py-2 font-mono text-[12px] text-neutral-400 dark:border-neutral-800 dark:bg-[#232325] dark:text-neutral-500"
        >
          {lines.map((_, idx) => {
            const lineNum = idx + 1;
            const isActive = !isDirty && activeLine === lineNum;
            const isLast = !isDirty && lastExecutedLine === lineNum && !isActive;
            const isError = errorLineSet.has(lineNum);

            return (
              <div
                key={lineNum}
                style={{ height: `${LINE_HEIGHT_PX}px`, lineHeight: `${LINE_HEIGHT_PX}px` }}
                className={`flex items-center justify-between pl-1.5 pr-2 ${
                  isError
                    ? 'bg-red-100 text-red-700 font-semibold dark:bg-red-950/60 dark:text-red-300'
                    : isActive
                      ? 'bg-yellow-200/80 text-neutral-900 font-bold dark:bg-yellow-900/45 dark:text-yellow-200'
                      : isLast
                        ? 'text-neutral-600 dark:text-neutral-300'
                        : ''
                }`}
              >
                <span className="w-2.5 text-center text-[10px]">
                  {isError ? (
                    <span className="text-red-600 dark:text-red-400">●</span>
                  ) : isActive ? (
                    <span className="text-amber-700 dark:text-yellow-400">▶</span>
                  ) : null}
                </span>
                <span>{lineNum}</span>
              </div>
            );
          })}
        </div>

        {/* Code Area */}
        <div className="relative flex-1 min-w-0 overflow-hidden">
          {/* Synchronized Line Highlights */}
          <div
            ref={backdropRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden py-2"
          >
            {lines.map((_, idx) => {
              const lineNum = idx + 1;
              const isActive = !isDirty && activeLine === lineNum;
              const isLast = !isDirty && lastExecutedLine === lineNum && !isActive;
              const isError = errorLineSet.has(lineNum);

              return (
                <div
                  key={lineNum}
                  style={{ height: `${LINE_HEIGHT_PX}px` }}
                  className={
                    isError
                      ? 'bg-red-50 border-l-2 border-red-500 dark:bg-red-950/35'
                      : isActive
                        ? 'bg-yellow-100/90 border-l-2 border-amber-500 dark:bg-yellow-900/30 dark:border-yellow-500'
                        : isLast
                          ? 'bg-neutral-100/70 border-l-2 border-neutral-300 dark:bg-neutral-800/40 dark:border-neutral-600'
                          : 'border-l-2 border-transparent'
                  }
                />
              );
            })}
          </div>

          <textarea
            ref={textareaRef}
            value={code}
            onChange={(e) => onChange(e.target.value)}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            disabled={isRunning}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            aria-label={t.panels.codeEditor}
            style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
            className="relative z-10 h-full w-full resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-[13px] text-neutral-900 caret-blue-600 selection:bg-blue-200/70 focus:outline-none disabled:opacity-80 whitespace-pre dark:text-neutral-100 dark:caret-blue-400 dark:selection:bg-blue-700/50"
          />
        </div>
      </div>

      {/* Diagnostics */}
      {allDiagnostics.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-t border-red-200 bg-red-50/90 px-3 py-1.5 shrink-0 space-y-1 dark:border-red-900/60 dark:bg-red-950/35">
          {allDiagnostics.map((diag, idx) => (
            <button
              key={`${diag.kind}-${diag.line}-${idx}`}
              type="button"
              onClick={() => jumpToLine(diag.line)}
              className="flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-left text-[11px] text-red-800 hover:bg-red-100/80 transition-colors dark:text-red-200 dark:hover:bg-red-900/40"
            >
              <span className="shrink-0 rounded bg-red-200/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-900 dark:bg-red-900/70 dark:text-red-100">
                {t.panels.line} {diag.line}
              </span>
              <span className="font-mono leading-relaxed">{diag.message}</span>
            </button>
          ))}
        </div>
      )}

      {/* INT 21H Console Output */}
      {consoleOutput.length > 0 && (
        <div className="border-t border-neutral-200 bg-neutral-50 px-3 py-1.5 shrink-0 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {t.panels.consoleOutput}
            </span>
            <button
              type="button"
              onClick={onClearConsole}
              className="text-[10px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              {t.panels.clearConsole}
            </button>
          </div>
          <pre className="max-h-16 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-neutral-900 dark:text-neutral-100">
            {consoleOutput}
          </pre>
        </div>
      )}
    </section>
  );
};
