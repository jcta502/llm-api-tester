import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { probePayload } from '../lib/probe.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 840, minWidth: 760, minHeight: 640, show: false, autoHideMenuBar: true, backgroundColor: '#f3f6fb', webPreferences: { preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadFile(join(root, 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

ipcMain.handle('probe', (_event, payload) => probePayload(payload))
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
