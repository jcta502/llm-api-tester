import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { probePayload } from '../lib/probe.mjs'
import { runBatch } from '../lib/batch-runner.mjs'
import { ProfileStore } from '../lib/profile-store.mjs'
import { rendererProbeResult } from '../lib/report.mjs'
import { createHttpServer, listenWithRetry } from '../lib/http-server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_PORT = 4173
let mainWindow
let profileStore
let httpServer
let httpPort = DEFAULT_PORT
let localToken = ''
const batchJobs = new Map()

function allowIpc(event) {
  const url = event.senderFrame?.url || ''
  if (!url.startsWith('file:') || event.sender !== mainWindow?.webContents) throw new Error('不允许的页面调用。')
}

function ipc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => { allowIpc(event); return handler(event, ...args) })
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1240, height: 880, minWidth: 800, minHeight: 680, show: false, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#f3f6fb', webPreferences: { preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadFile(join(root, 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
}

ipc('probe', async (_event, payload) => rendererProbeResult(await probePayload(payload), payload?.apiKey))
ipc('profiles:list', () => profileStore.list())
ipc('profiles:capabilities', () => ({ storeEnabled: true, secureStorage: safeStorage.isEncryptionAvailable() }))
ipc('profiles:save', (_event, profile) => profileStore.save(profile))
ipc('profiles:remove', (_event, id) => profileStore.remove(id))
ipc('profiles:probe', async (_event, { id, action, model }) => {
  const profile = await profileStore.resolve(id)
  if (!profile.apiKey) return { ok: false, status: 400, error: '该配置没有保存密钥。', diagnosis: { code: 'missing_key', message: '缺少已保存的密钥', hint: '编辑配置并重新输入 API Key。' } }
  return rendererProbeResult(await probePayload({ ...profile, action, model }), profile.apiKey)
})
ipc('profiles:run', async (event, { jobId, ids, concurrency = 3 }) => {
  if (typeof jobId !== 'string' || jobId.length > 100 || batchJobs.has(jobId)) throw new Error('批量任务标识无效。')
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('请选择 1 至 100 个不重复的有效配置。')
  const controller = new AbortController()
  batchJobs.set(jobId, controller)
  try {
    return await runBatch(ids, async id => {
      const profile = await profileStore.resolve(id)
      if (!profile.apiKey) return { ok: false, status: 400, elapsedMs: 0, error: '该配置没有保存密钥。', diagnosis: { code: 'missing_key', message: '缺少已保存的密钥', hint: '编辑配置并重新输入 API Key。' } }
      return rendererProbeResult(await probePayload({ ...profile, action: 'models' }, { signal: controller.signal }), profile.apiKey)
    }, {
      concurrency,
      signal: controller.signal,
      onResult: (id, result) => {
        if (!event.sender.isDestroyed()) event.sender.send('profiles:progress', { jobId, id, result })
      },
    })
  } finally {
    batchJobs.delete(jobId)
  }
})
ipc('profiles:cancel', (_event, jobId) => {
  const controller = batchJobs.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
})
ipc('app:set-theme', (_event, theme) => {
  const selected = ['system', 'light', 'dark'].includes(theme) ? theme : 'system'
  const colors = { light: '#f3f6fb', dark: '#0f172a' }
  nativeTheme.themeSource = selected
  const actual = selected === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : selected
  mainWindow?.setBackgroundColor(colors[actual])
  return selected
})

ipc('app:local-endpoint', () => ({ port: httpPort, token: localToken, url: localToken ? `http://127.0.0.1:${httpPort}/?token=${localToken}` : '' }))

ipc('app:open-in-browser', () => {
  if (!localToken) return false
  shell.openExternal(`http://127.0.0.1:${httpPort}/?token=${localToken}`)
  return true
})

async function ensureLocalToken() {
  const tokenFile = join(app.getPath('userData'), 'local-token.txt')
  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim()
    if (/^[0-9a-f-]{36}$/i.test(existing)) { localToken = existing; return }
  } catch { /* not yet created */ }
  localToken = randomUUID()
  await writeFile(tokenFile, localToken, { encoding: 'utf8', mode: 0o600 })
}

async function startHttpServer() {
  await ensureLocalToken()
  const themeHandler = theme => {
    const selected = ['system', 'light', 'dark'].includes(theme) ? theme : 'system'
    nativeTheme.themeSource = selected
    const colors = { light: '#f3f6fb', dark: '#0f172a' }
    const actual = selected === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : selected
    mainWindow?.setBackgroundColor(colors[actual])
    return selected
  }
  httpServer = createHttpServer({ root, profileStore, themeHandler, token: localToken })
  httpPort = await listenWithRetry(httpServer, DEFAULT_PORT)
  console.log(`LLM API Tester 本地网页服务: http://127.0.0.1:${httpPort}/?token=${localToken}`)
  if (httpPort !== DEFAULT_PORT) console.warn(`端口 ${DEFAULT_PORT} 被占用，已改用 ${httpPort}；收藏栏地址需要同步更新。`)
}

// A single instance keeps the bookmarked port stable; a second launch just
// focuses the running window instead of starting a rival server on port+1.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    profileStore = new ProfileStore({ filePath: join(app.getPath('userData'), 'profiles.json'), encryption: safeStorage })
    createWindow()
    try { await startHttpServer() } catch (error) { console.error('本地 HTTP 服务启动失败:', error?.message || error) }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
}

app.on('before-quit', () => {
  for (const controller of batchJobs.values()) controller.abort()
  httpServer?.batchJobs?.forEach(controller => controller.abort())
  try { httpServer?.close() } catch { /* closing */ }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
