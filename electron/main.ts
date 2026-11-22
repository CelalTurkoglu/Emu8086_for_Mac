import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'fs/promises';
import path from 'path';

let mainWindow: BrowserWindow | null = null;
const allowedLocalPaths = new Set<string>();

function sendMenuAction(
  action: 'new' | 'open' | 'save' | 'save-as' | 'export-docx'
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', action);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'EMU8086 Mac',
    backgroundColor: '#f5f5f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServerUrl = process.env.ELECTRON_START_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('file:open-asm', async () => {
    if (!mainWindow) return { canceled: true };

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

    const filePath = result.filePaths[0];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      allowedLocalPaths.add(filePath);
      return {
        canceled: false,
        filePath,
        fileName: path.basename(filePath),
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
      _event,
      args: { filePath?: string | null; defaultName?: string; content: string }
    ) => {
      if (!mainWindow) return { canceled: true };

      let targetPath = args.filePath || null;
      if (!targetPath) {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Assembly Dosyasını Kaydet / Save Assembly File',
          defaultPath: args.defaultName || 'program.asm',
          filters: [
            { name: '8086 Assembly (.asm)', extensions: ['asm'] },
            { name: 'Text File (.txt)', extensions: ['txt'] },
          ],
        });
        if (result.canceled || !result.filePath) {
          return { canceled: true };
        }
        targetPath = result.filePath;
      }

      try {
        await fs.writeFile(targetPath, args.content, 'utf-8');
        allowedLocalPaths.add(targetPath);
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
    async (_event, args: { defaultName: string; data: Uint8Array }) => {
      if (!mainWindow) return { canceled: true };

      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Word Raporunu Kaydet / Export Word Report (.docx)',
        defaultPath: args.defaultName || 'emu8086_trace_report.docx',
        filters: [{ name: 'Word Document (.docx)', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      const targetPath = result.filePath.endsWith('.docx')
        ? result.filePath
        : `${result.filePath}.docx`;

      try {
        await fs.writeFile(targetPath, Buffer.from(args.data));
        allowedLocalPaths.add(targetPath);
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

  ipcMain.handle('file:open-saved', async (_event, filePath: string) => {
    if (typeof filePath === 'string' && allowedLocalPaths.has(filePath)) {
      await shell.openPath(filePath);
    }
  });

  ipcMain.handle('file:reveal-in-finder', async (_event, filePath: string) => {
    if (typeof filePath === 'string' && allowedLocalPaths.has(filePath)) {
      shell.showItemInFolder(filePath);
    }
  });
}

function buildMacMenu(): void {
  if (process.platform !== 'darwin') return;

  const template: MenuItemConstructorOptions[] = [
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
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
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
  buildMacMenu();
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
