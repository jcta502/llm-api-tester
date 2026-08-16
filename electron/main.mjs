import { app, BrowserWindow, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { probePayload, configureProxy, proxyFetch } from '../lib/probe.mjs'
import { runBatch } from '../lib/batch-runner.mjs'
import { ProfileStore } from '../lib/profile-store.mjs'
import { HistoryStore } from '../lib/history-store.mjs'
import { SettingsStore } from '../lib/settings-store.mjs'
import { createCheckService } from '../lib/check-service.mjs'
import { encryptBackup, decryptBackup } from '../lib/backup.mjs'
import { createUpdateChecker } from '../lib/update-check.mjs'
import { createScheduler } from '../lib/scheduler.mjs'
import { rendererProbeResult } from '../lib/report.mjs'
import { createHttpServer, listenWithRetry } from '../lib/http-server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_PORT = 4173
const UPDATE_REPO = 'jcta502/llm-api-tester'
let mainWindow
let profileStore
let historyStore
let settingsStore
let checkService
let scheduler
const updateChecker = createUpdateChecker({ repo: UPDATE_REPO, currentVersion: app.getVersion(), fetchImpl: proxyFetch })
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
ipc('profiles:history', () => historyStore.all())
ipc('profiles:capabilities', () => ({ storeEnabled: true, secureStorage: safeStorage.isEncryptionAvailable() }))
ipc('profiles:save', (_event, profile) => profileStore.save(profile))
ipc('profiles:remove', async (_event, id) => {
  const removed = await profileStore.remove(id)
  if (removed) await historyStore.remove(id).catch(() => {})
  return removed
})
ipc('profiles:probe', (_event, { id, action, model }) => checkService.checkSingle(id, { action, model }))
ipc('profiles:run', async (event, { jobId, ids, concurrency = 3, deep = false, model = '' }) => {
  if (typeof jobId !== 'string' || jobId.length > 100 || batchJobs.has(jobId)) throw new Error('批量任务标识无效。')
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('请选择 1 至 100 个不重复的有效配置。')
  if (typeof model !== 'string' || model.length > 200) throw new Error('指定的模型名称无效。')
  const controller = new AbortController()
  batchJobs.set(jobId, controller)
  try {
    return await runBatch(ids, async id => checkService.checkProfile(id, { deep: Boolean(deep), model, signal: controller.signal }), {
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

ipc('app:settings:get', () => settingsStore.get())
ipc('app:settings:set', async (_event, settings = {}) => {
  const saved = await settingsStore.set(settings)
  await configureProxy(saved.proxyUrl)
  await scheduler?.restart()
  return saved
})

ipc('app:update-check', () => updateChecker.check())
ipc('app:open-release', () => {
  return updateChecker.check().then(result => {
    if (result?.url) shell.openExternal(result.url)
    return Boolean(result?.url)
  })
})

async function ipcBackupExport(passphrase) {
  const profiles = await profileStore.list()
  const resolved = []
  for (const profile of profiles) resolved.push(await profileStore.resolve(profile.id))
  return encryptBackup(resolved, passphrase)
}

async function ipcBackupImport({ blob, passphrase } = {}) {
  const restored = decryptBackup(blob, passphrase)
  let imported = 0
  const errors = []
  for (const profile of restored.slice(0, 100)) {
    try {
      await profileStore.save({
        name: profile?.name, provider: profile?.provider, baseUrl: profile?.baseUrl,
        group: profile?.group, timeoutMs: profile?.timeoutMs,
        ...(profile?.apiKey ? { apiKey: profile.apiKey } : {}),
        ...(profile?.headers && Object.keys(profile.headers).length ? { headers: profile.headers } : {}),
      })
      imported += 1
    } catch (error) { errors.push(`${profile?.name || '未命名'}：${error?.message || '无法导入'}`) }
  }
  return { imported, total: restored.length, errors: errors.slice(0, 3) }
}

ipc('backup:export', (_event, { passphrase } = {}) => ipcBackupExport(passphrase))
ipc('backup:import', (_event, payload) => ipcBackupImport(payload))

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
  httpServer = createHttpServer({
    root, profileStore, historyStore, settingsStore, themeHandler, token: localToken,
    updateHandler: () => updateChecker.check(),
    backupExport: passphrase => ipcBackupExport(passphrase),
    backupImport: payload => ipcBackupImport(payload),
    onSettingsChanged: () => scheduler?.restart(),
  })
  httpPort = await listenWithRetry(httpServer, DEFAULT_PORT)
  console.log(`LLM API Tester 本地网页服务: http://127.0.0.1:${httpPort}/?token=${localToken}`)
  if (httpPort !== DEFAULT_PORT) console.warn(`端口 ${DEFAULT_PORT} 被占用，已改用 ${httpPort}；收藏栏地址需要同步更新。`)
}

// 定时检测：只在状态翻转（可用↔失败）时发送系统通知，避免每次都打扰。
async function scheduledRun() {
  const profiles = (await profileStore.list()).filter(profile => profile.hasKey)
  if (!profiles.length) return
  const previous = await historyStore.all().catch(() => ({}))
  for (const profile of profiles.slice(0, 50)) {
    const result = await checkService.checkProfile(profile.id, {}).catch(() => null)
    if (!result) continue
    const before = (previous[profile.id] || []).at(-1)
    if (!before || Boolean(before.ok) === Boolean(result.ok)) continue
    const state = result.ok ? `已恢复可用（${result.models?.length || 0} 个模型）` : `检测失败：${result.diagnosis?.message || result.error || '未知原因'}`
    try { new Notification({ title: `LLM API Tester · ${profile.name}`, body: state }).show() } catch { /* 系统不支持通知 */ }
  }
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
    const userData = app.getPath('userData')
    profileStore = new ProfileStore({ filePath: join(userData, 'profiles.json'), encryption: safeStorage })
    historyStore = new HistoryStore({ filePath: join(userData, 'history.json') })
    settingsStore = new SettingsStore({ filePath: join(userData, 'settings.json') })
    checkService = createCheckService({ profileStore, historyStore })
    scheduler = createScheduler({ getSettings: () => settingsStore.get(), runOnce: scheduledRun })
    createWindow()
    try { await configureProxy((await settingsStore.get()).proxyUrl) } catch (error) { console.warn('代理设置应用失败:', error?.message || error) }
    await scheduler.restart().catch(() => {})
    updateChecker.check().catch(() => {})
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
