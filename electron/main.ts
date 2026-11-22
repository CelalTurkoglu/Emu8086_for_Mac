import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'fs/promises';
import path from 'path';
import {
  canDirectSaveAsmPath,
  canOpenSavedDocxPath,
  canRevealSavedPath,
  isAllowedDevServerUrl,
  isAllowedExternalUrl,
  isAllowedNavigationUrl,
  isTrustedIpcSenderUrl,
  MAX_ASM_FILE_BYTES,
  MAX_DOCX_FILE_BYTES,
  normalizeLocalPath,
} from './security';

let mainWindow: BrowserWindow | null = null;
let hasUnsavedChanges = false;
let forceClosing = false;

const allowedAsmPaths = new Set<string>();
const allowedDocxPaths = new Set<string>();

function getDistIndexPath(): string {
  return path.join(__dirname, '../dist/index.html');
}

function assertTrustedSender(event: IpcMainInvokeEvent): boolean {
  const senderUrl = event.senderFrame?.url;
  return isTrustedIpcSenderUrl(senderUrl, app.isPackaged, getDistIndexPath());
}

function sendMenuAction(
  action: 'new' | 'open' | 'save' | 'save-as' | 'export-docx'
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', action);
  }
}

function createWindow(): void {
  const distIndexPath = getDistIndexPath();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'EMU8086 Mac',
    backgroundColor: '#f4f4f5',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Security: Block all arbitrary navigation (e.g. dropped .html files or external links)
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigationUrl(targetUrl, app.isPackaged, distIndexPath)) {
      event.preventDefault();
    }
  });

  // Security: Deny all new window / popup requests
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Security: Disallow embedding <webview> tags
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Guard against accidental window close when there are unsaved changes
  mainWindow.on('close', (event) => {
    if (!mainWindow || forceClosing || !hasUnsavedChanges) {
      return;
    }
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Kaydetmeden Kapat / Discard & Close', 'İptal / Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Kaydedilmemiş Değişiklikler / Unsaved Changes',
      message:
        'Kaydedilmemiş assembly kodu değişiklikleriniz var. Çıkmak istediğinize emin misiniz?\nYou have unsaved assembly code changes. Close anyway?',
    });
    if (choice === 0) {
      forceClosing = true;
      hasUnsavedChanges = false;
      mainWindow.close();
    }
  });

  const devServerUrl = process.env.ELECTRON_START_URL;
  if (isAllowedDevServerUrl(devServerUrl, app.isPackaged)) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(distIndexPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    forceClosing = false;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('file:open-asm', async (event) => {
    if (!assertTrustedSender(event) || !mainWindow) {
      return { canceled: true };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Assembly Dosyası Aç / Open Assembly File',
      properties: ['openFile'],
      filters: [
        { name: '8086 Assembly', extensions: ['asm', 'ASM', 's', 'inc', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const resolvedPath = normalizeLocalPath(result.filePaths[0]);
    if (!resolvedPath) {
      return { canceled: true };
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        return {
          canceled: false,
          error: 'Seçilen yol geçerli bir dosya değil / Selected path is not a regular file.',
        };
      }
      if (stat.size > MAX_ASM_FILE_BYTES) {
        return {
          canceled: false,
          error: 'Dosya boyutu çok büyük (maksimum 5 MB) / File exceeds 5 MB limit.',
        };
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');
      if (content.includes('\0')) {
        return {
          canceled: false,
          error: 'İkili (binary) dosya açılamaz; lütfen metin tabanlı .asm dosyası seçin / Binary files cannot be opened.',
        };
      }

      allowedAsmPaths.add(resolvedPath);
      return {
        canceled: false,
        filePath: resolvedPath,
        fileName: path.basename(resolvedPath),
        content,
      };
    } catch (err) {
      return {
        canceled: false,
        error: String(err),
      };
    }
  });

  ipcMain.handle(
    'file:save-asm',
    async (
      event,
      args: { filePath?: string | null; defaultName?: string; content: string }
    ) => {
      if (!assertTrustedSender(event) || !mainWindow) {
        return { canceled: true };
      }
      if (!args || typeof args.content !== 'string') {
        return { canceled: false, error: 'Invalid file content.' };
      }
      if (Buffer.byteLength(args.content, 'utf-8') > MAX_ASM_FILE_BYTES) {
        return {
          canceled: false,
          error: 'Dosya boyutu 5 MB sınırını aşıyor / File content exceeds 5 MB limit.',
        };
      }

      // Security: Only allow direct overwrite if the path was previously authorized by user via Open/Save dialog
      let targetPath = args.filePath
        ? canDirectSaveAsmPath(args.filePath, allowedAsmPaths)
        : null;

      if (!targetPath) {
        const safeDefault =
          typeof args.defaultName === 'string' && args.defaultName.trim()
            ? path.basename(args.defaultName.trim())
            : 'program.asm';
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Assembly Dosyasını Kaydet / Save Assembly File',
          defaultPath: safeDefault,
          filters: [
            { name: '8086 Assembly (.asm)', extensions: ['asm'] },
            { name: 'Text File (.txt)', extensions: ['txt'] },
          ],
        });
        if (result.canceled || !result.filePath) {
          return { canceled: true };
        }
        targetPath = normalizeLocalPath(result.filePath);
        if (!targetPath) {
          return { canceled: true };
        }
      }

      try {
        await fs.writeFile(targetPath, args.content, 'utf-8');
        allowedAsmPaths.add(targetPath);
        return {
          canceled: false,
          filePath: targetPath,
          fileName: path.basename(targetPath),
        };
      } catch (err) {
        return {
          canceled: false,
          error: String(err),
        };
      }
    }
  );

  ipcMain.handle(
    'file:save-docx',
    async (
      event,
      args: { defaultName: string; data: Uint8Array }
    ) => {
      if (!assertTrustedSender(event) || !mainWindow) {
        return { canceled: true };
      }
      if (!args || !(args.data instanceof Uint8Array || Buffer.isBuffer(args.data))) {
        return { canceled: false, error: 'Invalid DOCX binary payload.' };
      }
      if (args.data.byteLength > MAX_DOCX_FILE_BYTES) {
        return { canceled: false, error: 'DOCX report exceeds 50 MB limit.' };
      }

      const safeDefault =
        typeof args.defaultName === 'string' && args.defaultName.trim()
          ? path.basename(args.defaultName.trim())
          : 'emu8086_trace_report.docx';

      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Word Raporunu Kaydet / Export Word Report (.docx)',
        defaultPath: safeDefault,
        filters: [{ name: 'Word Document (.docx)', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      const rawTarget = result.filePath.toLowerCase().endsWith('.docx')
        ? result.filePath
        : `${result.filePath}.docx`;
      const targetPath = normalizeLocalPath(rawTarget);
      if (!targetPath) {
        return { canceled: true };
      }

      try {
        await fs.writeFile(targetPath, Buffer.from(args.data));
        allowedDocxPaths.add(targetPath);
        return {
          canceled: false,
          filePath: targetPath,
          fileName: path.basename(targetPath),
        };
      } catch (err) {
        return {
          canceled: false,
          error: String(err),
        };
      }
    }
  );

  ipcMain.handle('file:open-saved', async (event, filePath: string) => {
    if (!assertTrustedSender(event)) return;
    const validDocxPath = canOpenSavedDocxPath(filePath, allowedDocxPaths);
    if (validDocxPath) {
      await shell.openPath(validDocxPath);
    }
  });

  ipcMain.handle('file:reveal-in-finder', async (event, filePath: string) => {
    if (!assertTrustedSender(event)) return;
    const validPath = canRevealSavedPath(
      filePath,
      allowedAsmPaths,
      allowedDocxPaths
    );
    if (validPath) {
      shell.showItemInFolder(validPath);
    }
  });

  ipcMain.handle('app:set-unsaved-changes', (event, dirty: boolean) => {
    if (!assertTrustedSender(event)) return;
    hasUnsavedChanges = Boolean(dirty);
  });

  ipcMain.handle('app:open-external', async (event, url: string) => {
    if (!assertTrustedSender(event)) return;
    if (isAllowedExternalUrl(url)) {
      await shell.openExternal(url);
    }
  });
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...(!app.isPackaged
      ? ([
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
        ] as MenuItemConstructorOptions[])
      : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Assembly File',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new'),
        },
        {
          label: 'Open (.asm)...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('save'),
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('save-as'),
        },
        { type: 'separator' },
        {
          label: 'Export Trace to Word (.docx)...',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendMenuAction('export-docx'),
        },
        ...(!isMac
          ? ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: viewSubmenu,
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  buildAppMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
