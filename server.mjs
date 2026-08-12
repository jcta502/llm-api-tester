import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function endpoint(baseUrl, path) {
  const base = new URL(baseUrl.trim())
  base.hash = ''
  base.search = ''
  let pathname = base.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/models') || pathname.endsWith('/chat/completions')) pathname = pathname.replace(/\/(models|chat\/completions)$/, '')
  base.pathname = `${pathname}${path}`.replace(/\/+/g, '/')
  return base.toString()
}

async function apiProxy(req, res) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body
  try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { error: '请求内容不是有效 JSON。' }) }
  const { baseUrl, apiKey, action, model, timeoutMs = 15000 } = body
  if (!baseUrl || !apiKey) return json(res, 400, { error: '请填写 API Base URL 和 API Key。' })
  let url
  try { url = endpoint(baseUrl, action === 'models' ? '/models' : '/chat/completions') } catch { return json(res, 400, { error: 'API Base URL 格式无效，请填写完整 http(s) 地址。' }) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || 15000, 3000), 60000))
  const start = performance.now()
  try {
    const response = await fetch(url, {
      method: action === 'models' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: action === 'models' ? undefined : JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8, temperature: 0, stream: false }),
      signal: controller.signal,
    })
    const elapsedMs = Math.round(performance.now() - start)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
    if (!response.ok) return json(res, response.status, { ok: false, status: response.status, elapsedMs, url, error: data?.error?.message || data?.message || data?.error || `HTTP ${response.status}`, details: data })
    if (action === 'models') {
      const models = Array.isArray(data?.data) ? data.data.map(x => typeof x === 'string' ? x : x.id).filter(Boolean).sort() : []
      return json(res, 200, { ok: true, status: response.status, elapsedMs, url, models, rawCount: models.length })
    }
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? '（接口未返回可识别的文本内容）'
    return json(res, 200, { ok: true, status: response.status, elapsedMs, url, model: data?.model || model, content: typeof content === 'string' ? content : JSON.stringify(content), usage: data?.usage || null })
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - start)
    const message = error?.name === 'AbortError' ? '请求超时。' : `网络请求失败：${error?.cause?.code || error?.message || '未知错误'}`
    return json(res, 502, { ok: false, status: 0, elapsedMs, url, error: message })
  } finally { clearTimeout(timer) }
}

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/probe') return apiProxy(req, res)
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' })
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0])
  const safePath = normalize(requestPath === '/' ? '/index.html' : requestPath).replace(/^(\.\.(\\|\/|$))+/, '')
  const path = join(root, safePath)
  if (!path.startsWith(root)) return json(res, 403, { error: 'Forbidden' })
  try {
    const info = await stat(path)
    if (!info.isFile()) return json(res, 404, { error: 'Not found' })
    const content = await readFile(path)
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : content)
  } catch { json(res, 404, { error: 'Not found' }) }
}).listen(port, '127.0.0.1', () => console.log(`API Test is running at http://127.0.0.1:${port}`))
