import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { probePayload, configureProxy } from './probe.mjs'
import { runBatch } from './batch-runner.mjs'
import { createCheckService } from './check-service.mjs'
import { rendererProbeResult } from './report.mjs'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(JSON.stringify(value))
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let aborted = false
    const timer = setTimeout(() => { aborted = true; reject(new Error('请求体读取超时。')) }, 10000)
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > limit) { aborted = true; clearTimeout(timer); reject(new Error('请求体过大。')); req.destroy() }
    })
    req.on('end', () => { if (!aborted) { clearTimeout(timer); resolve(raw) } })
    req.on('error', error => { if (!aborted) { clearTimeout(timer); reject(error) } })
  })
}

// Only the files the page actually needs are reachable. Without this the whole
// project root (package.json, node_modules, .git) would be readable over HTTP.
const SERVABLE_ROOTS = ['src/', 'lib/', 'public/']
const SERVABLE_FILES = new Set(['index.html', 'favicon.ico'])

function servable(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (SERVABLE_FILES.has(normalized)) return true
  return SERVABLE_ROOTS.some(prefix => normalized.startsWith(prefix))
}

function safeJoin(root, requestPath) {
  const safe = normalize(requestPath === '/' ? '/index.html' : requestPath).replace(/^(\.\.(\\|\/|$))+/, '')
  const path = join(root, safe)
  if (!path.startsWith(root)) return null
  if (!servable(path.slice(root.length))) return null
  return path
}

export async function serveStatic(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' })
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0])
  const path = safeJoin(root, requestPath)
  if (!path) return sendJson(res, 403, { error: 'Forbidden' })
  try {
    const info = await stat(path)
    if (!info.isFile()) return sendJson(res, 404, { error: 'Not found' })
    const content = await readFile(path)
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : content)
  } catch {
    sendJson(res, 404, { error: 'Not found' })
  }
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase()
  const hostname = host.split(':')[0]
  return ALLOWED_HOSTS.has(hostname)
}

function checkToken(req, expectedToken) {
  if (!expectedToken) return true
  const auth = String(req.headers['x-local-token'] || '')
  const fromQuery = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token')
  return auth === expectedToken || fromQuery === expectedToken
}

function batchJobOptions(eventSink, jobId) {
  return {
    concurrency: 3,
    onResult: (id, result) => {
      try { eventSink(jobId, { type: 'progress', jobId, id, result }) } catch { /* sink closed */ }
    },
  }
}

export function createHttpServer({ root, profileStore, historyStore, settingsStore, themeHandler, token = '', updateHandler, backupExport, backupImport, onSettingsChanged }) {
  const batchJobs = new Map()
  const sseClients = new Map()
  const checkService = createCheckService({ profileStore, historyStore })

  function broadcast(jobId, payload) {
    const clients = sseClients.get(jobId)
    if (!clients) return
    for (const res of clients) {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* client gone */ }
    }
  }

  const server = createServer(async (req, res) => {
    if (!hostAllowed(req)) return sendJson(res, 403, { error: 'Forbidden host' })

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname

    // Static assets stay open so a plain bookmark can load the page; the token is
    // persisted client-side and only enforced on the API surface below.
    if (!pathname.startsWith('/api/')) return serveStatic(root, req, res)
    if (!checkToken(req, token)) return sendJson(res, 401, { error: 'Invalid local token' })

    try {
      if (req.method === 'POST' && pathname === '/api/probe') {
        const raw = await readBody(req)
        const payload = JSON.parse(raw || '{}')
        const result = await probePayload(payload)
        return sendJson(res, result.status || 200, rendererProbeResult(result, payload?.apiKey))
      }

      if (req.method === 'GET' && pathname === '/api/profiles') {
        if (!profileStore) return sendJson(res, 200, { profiles: [] })
        return sendJson(res, 200, { profiles: await profileStore.list() })
      }

      if (req.method === 'GET' && pathname === '/api/profiles/history') {
        if (!historyStore) return sendJson(res, 200, { history: {} })
        return sendJson(res, 200, { history: await historyStore.all() })
      }

      if (req.method === 'GET' && pathname === '/api/profiles/capabilities') {
        return sendJson(res, 200, { storeEnabled: Boolean(profileStore), secureStorage: Boolean(profileStore?.encryption?.isEncryptionAvailable()) })
      }

      if (req.method === 'POST' && pathname === '/api/profiles/save') {
        if (!profileStore) return sendJson(res, 400, { error: '浏览器开发模式不提供配置库，请启动桌面应用。' })
        const raw = await readBody(req)
        const saved = await profileStore.save(JSON.parse(raw || '{}'))
        return sendJson(res, 200, saved)
      }

      if (req.method === 'POST' && pathname === '/api/profiles/remove') {
        if (!profileStore) return sendJson(res, 400, { error: '浏览器开发模式不提供配置库，请启动桌面应用。' })
        const raw = await readBody(req)
        const { id } = JSON.parse(raw || '{}')
        const removed = await profileStore.remove(id)
        if (removed && historyStore) await historyStore.remove(id).catch(() => {})
        return sendJson(res, 200, { removed })
      }

      if (req.method === 'POST' && pathname === '/api/profiles/probe') {
        if (!profileStore) return sendJson(res, 400, { error: '浏览器开发模式不提供配置库，请启动桌面应用。' })
        const raw = await readBody(req)
        const { id, action, model } = JSON.parse(raw || '{}')
        return sendJson(res, 200, await checkService.checkSingle(id, { action, model }))
      }

      if (req.method === 'POST' && pathname === '/api/profiles/run') {
        if (!profileStore) return sendJson(res, 400, { error: '浏览器开发模式不提供配置库，请启动桌面应用。' })
        const raw = await readBody(req)
        const { jobId, ids, deep = false, model = '' } = JSON.parse(raw || '{}')
        if (typeof jobId !== 'string' || jobId.length > 100 || batchJobs.has(jobId)) return sendJson(res, 400, { error: '批量任务标识无效。' })
        if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return sendJson(res, 400, { error: '请选择 1 至 100 个不重复的有效配置。' })
        if (typeof model !== 'string' || model.length > 200) return sendJson(res, 400, { error: '指定的模型名称无效。' })
        const controller = new AbortController()
        batchJobs.set(jobId, controller)
        try {
          const result = await runBatch(ids, async id => checkService.checkProfile(id, { deep: Boolean(deep), model, signal: controller.signal }), { ...batchJobOptions(broadcast, jobId), signal: controller.signal })
          return sendJson(res, 200, result)
        } finally {
          batchJobs.delete(jobId)
        }
      }

      if (req.method === 'POST' && pathname === '/api/profiles/cancel') {
        const raw = await readBody(req)
        const { jobId } = JSON.parse(raw || '{}')
        const controller = batchJobs.get(jobId)
        if (!controller) return sendJson(res, 200, { cancelled: false })
        controller.abort()
        return sendJson(res, 200, { cancelled: true })
      }

      if (req.method === 'GET' && pathname === '/api/profiles/progress') {
        const jobId = url.searchParams.get('jobId')
        if (typeof jobId !== 'string' || jobId.length > 100) return sendJson(res, 400, { error: '无效的 jobId。' })
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'connection': 'keep-alive' })
        res.write(': connected\n\n')
        if (!sseClients.has(jobId)) sseClients.set(jobId, new Set())
        sseClients.get(jobId).add(res)
        const cleanup = () => { sseClients.get(jobId)?.delete(res); if (sseClients.get(jobId)?.size === 0) sseClients.delete(jobId) }
        req.on('close', cleanup)
        req.on('error', cleanup)
        return
      }

      if (req.method === 'POST' && pathname === '/api/app/set-theme') {
        if (!themeHandler) return sendJson(res, 200, { theme: 'system' })
        const raw = await readBody(req)
        const { theme } = JSON.parse(raw || '{}')
        const result = await themeHandler(theme)
        return sendJson(res, 200, { theme: result })
      }

      if (req.method === 'GET' && pathname === '/api/app/settings') {
        if (!settingsStore) return sendJson(res, 200, { proxyUrl: '', scheduleEnabled: false, scheduleMinutes: 30 })
        return sendJson(res, 200, await settingsStore.get())
      }

      if (req.method === 'POST' && pathname === '/api/app/settings') {
        if (!settingsStore) return sendJson(res, 400, { error: '浏览器开发模式不提供全局设置，请启动桌面应用。' })
        const raw = await readBody(req)
        const settings = JSON.parse(raw || '{}')
        try {
          const saved = await settingsStore.set(settings)
          await configureProxy(saved.proxyUrl)
          if (onSettingsChanged) await onSettingsChanged().catch(() => {})
          return sendJson(res, 200, saved)
        } catch (error) {
          return sendJson(res, 400, { error: error?.message || '设置无效。' })
        }
      }

      if (req.method === 'GET' && pathname === '/api/app/update') {
        if (!updateHandler) return sendJson(res, 200, { current: null, latest: null, hasUpdate: false, error: '当前模式不支持更新检查。' })
        return sendJson(res, 200, await updateHandler())
      }

      if (req.method === 'POST' && pathname === '/api/backup/export') {
        if (!profileStore || !backupExport) return sendJson(res, 400, { error: '浏览器开发模式不支持备份，请启动桌面应用。' })
        const raw = await readBody(req)
        const { passphrase } = JSON.parse(raw || '{}')
        try { return sendJson(res, 200, await backupExport(String(passphrase || ''))) }
        catch (error) { return sendJson(res, 400, { error: error?.message || '备份失败。' }) }
      }

      if (req.method === 'POST' && pathname === '/api/backup/import') {
        if (!profileStore || !backupImport) return sendJson(res, 400, { error: '浏览器开发模式不支持恢复备份，请启动桌面应用。' })
        const raw = await readBody(req, 5 << 20)
        const { blob, passphrase } = JSON.parse(raw || '{}')
        try { return sendJson(res, 200, await backupImport({ blob, passphrase: String(passphrase || '') })) }
        catch (error) { return sendJson(res, 400, { error: error?.message || '恢复备份失败。' }) }
      }

      return sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      const status = error?.name === 'SyntaxError' ? 400 : 500
      return sendJson(res, status, { ok: false, error: error?.message || '请求处理失败。' })
    }
  })

  server.batchJobs = batchJobs
  server.abortAll = () => { for (const controller of batchJobs.values()) controller.abort() }
  return server
}

// Binding and retrying on EADDRINUSE avoids the race a "probe a free port then
// bind it" helper has, where another process can take the port in between.
export function listenWithRetry(server, startPort, host = '127.0.0.1', attemptsLeft = 10) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening)
      if (error?.code !== 'EADDRINUSE' || attemptsLeft <= 0) return reject(error)
      listenWithRetry(server, startPort + 1, host, attemptsLeft - 1).then(resolve, reject)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(startPort, host)
  })
}
