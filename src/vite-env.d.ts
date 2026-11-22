/// <reference types="vite/client" />

type MenuFileAction = 'new' | 'open' | 'save' | 'save-as' | 'export-docx';

interface IOpenFileResult {
  canceled: boolean;
  filePath?: string;
  fileName?: string;
  content?: string;
  error?: string;
}

interface ISaveFileResult {
  canceled: boolean;
  filePath?: string;
  fileName?: string;
  error?: string;
}

interface ElectronAPI {
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  openAsmFile: () => Promise<IOpenFileResult>;
  saveAsmFile: (args: {
    filePath?: string | null;
    defaultName?: string;
    content: string;
  }) => Promise<ISaveFileResult>;
  saveDocxFile: (args: {
    defaultName: string;
    data: Uint8Array;
  }) => Promise<ISaveFileResult>;
  openSavedFile: (filePath: string) => Promise<void>;
  revealInFinder: (filePath: string) => Promise<void>;
  setUnsavedChanges?: (dirty: boolean) => Promise<void>;
  openExternal?: (url: string) => Promise<void>;
  onMenuAction: (callback: (action: MenuFileAction) => void) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
