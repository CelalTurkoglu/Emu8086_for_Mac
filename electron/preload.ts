import { contextBridge, ipcRenderer } from 'electron';

export type MenuFileAction = 'new' | 'open' | 'save' | 'save-as' | 'export-docx';

export interface IOpenFileResult {
  canceled: boolean;
  filePath?: string;
  fileName?: string;
  content?: string;
  error?: string;
}

export interface ISaveFileResult {
  canceled: boolean;
  filePath?: string;
  fileName?: string;
  error?: string;
}

export interface ElectronAPI {
  platform: NodeJS.Platform;
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
  setUnsavedChanges: (dirty: boolean) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onMenuAction: (callback: (action: MenuFileAction) => void) => () => void;
}

const api: ElectronAPI = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openAsmFile: () => ipcRenderer.invoke('file:open-asm'),
  saveAsmFile: (args) => ipcRenderer.invoke('file:save-asm', args),
  saveDocxFile: (args) => ipcRenderer.invoke('file:save-docx', args),
  openSavedFile: (filePath) => ipcRenderer.invoke('file:open-saved', filePath),
  revealInFinder: (filePath) => ipcRenderer.invoke('file:reveal-in-finder', filePath),
  setUnsavedChanges: (dirty) => ipcRenderer.invoke('app:set-unsaved-changes', dirty),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onMenuAction: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuFileAction) => {
      callback(action);
    };
    ipcRenderer.on('menu:action', listener);
    return () => {
      ipcRenderer.removeListener('menu:action', listener);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
