import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useI18n } from '../i18n';

interface ConfirmModalProps {
  open: boolean;
  onSaveAndContinue: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  onSaveAndContinue,
  onDiscard,
  onCancel,
}) => {
  const { t } = useI18n();

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-[#1e1e1e]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t.files.unsavedTitle}
            </h2>
          </div>

          <button
            type="button"
            onClick={onCancel}
            aria-label={t.files.cancel}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-2.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
          {t.files.unsavedMessage}
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            {t.files.cancel}
          </button>

          <button
            type="button"
            onClick={onDiscard}
            className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-900/60"
          >
            {t.files.discardChanges}
          </button>

          <button
            type="button"
            onClick={onSaveAndContinue}
            className="rounded border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            {t.files.saveAndContinue}
          </button>
        </div>
      </div>
    </div>
  );
};
