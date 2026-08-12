import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function joinEndpoint(baseUrl, path) {
  const base = new URL(baseUrl.trim())
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Only HTTP(S) URLs are supported.')
  base.hash = ''
  base.search = ''
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/+/g, '/')
  return base.toString()
}

function providerRequest(provider, baseUrl, apiKey, action, model) {
  if (provider === 'anthropic') {
    const url = joinEndpoint(baseUrl || 'https://api.anthropic.com', action === 'models' ? 'v1/models' : 'v1/messages')
    return {
      url,
      method: action === 'models' ? 'GET' : 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' },
      body: action === 'models' ? undefined : { model, max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] },
    }
  }
  if (provider === 'gemini') {
    const rootUrl = baseUrl || 'https://generativelanguage.googleapis.com'
    const normalizedModel = model?.replace(/^models\//, '')
    const url = new URL(joinEndpoint(rootUrl, action === 'models' ? 'v1beta/models' : `v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent`))
    url.searchParams.set('key', apiKey)
    return {
      url: url.toString(),
      method: action === 'models' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: action === 'models' ? undefined : { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } },
    }
  }
  const url = joinEndpoint(baseUrl, action === 'models' ? 'models' : 'chat/completions')
  return {
    url,
    method: action === 'models' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: action === 'models' ? undefined : { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8, temperature: 0, stream: false },
  }
}

function modelsFrom(provider, data) {
  if (provider === 'gemini') return (data.models || []).filter(item => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent')).map(item => item.name || item.displayName).filter(Boolean).map(id => id.replace(/^models\//, '')).sort()
  return (data.data || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean).sort()
}

function resultFrom(provider, data, requestedModel) {
  if (provider === 'anthropic') return { model: data.model || requestedModel, content: (data.content || []).map(item => item.text || '').filter(Boolean).join('\n'), usage: data.usage || null }
  if (provider === 'gemini') return { model: requestedModel, content: (data.candidates || []).flatMap(item => item.content?.parts || []).map(part => part.text || '').filter(Boolean).join('\n'), usage: data.usageMetadata || null }
  return { model: data.model || requestedModel, content: data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? data.output_text ?? '(The API returned no recognizable text.)', usage: data.usage || null }
}

function errorFrom(data, status) {
  return data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '') || `HTTP ${status}`
}

async function probe(req, res) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  let payload
  try { payload = JSON.parse(raw || '{}') } catch { return sendJson(res, 400, { error: 'Request body must be valid JSON.' }) }
  const { provider = 'openai', baseUrl, apiKey, action, model, timeoutMs = 15000 } = payload
  if (!apiKey || (provider === 'openai' && !baseUrl)) return sendJson(res, 400, { error: 'Enter an API key and the required Base URL.' })
  if (!['openai', 'anthropic', 'gemini'].includes(provider)) return sendJson(res, 400, { error: 'Unsupported provider.' })
  if (action !== 'models' && (!model || typeof model !== 'string')) return sendJson(res, 400, { error: 'Choose a model before testing it.' })
  let request
  try { request = providerRequest(provider, baseUrl, apiKey, action, model) } catch { return sendJson(res, 400, { error: 'The Base URL must be a valid HTTP(S) address.' }) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || 15000, 3000), 60000))
  const startedAt = performance.now()
  try {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ? JSON.stringify(request.body) : undefined, signal: controller.signal })
    const elapsedMs = Math.round(performance.now() - startedAt)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
    if (!response.ok) return sendJson(res, response.status, { ok: false, status: response.status, elapsedMs, provider, url: request.url.replace(/([?&]key=)[^&]+/, '$1[hidden]'), error: errorFrom(data, response.status), details: data })
    if (action === 'models') {
      const models = modelsFrom(provider, data)
      return sendJson(res, 200, { ok: true, status: response.status, elapsedMs, provider, url: request.url.replace(/([?&]key=)[^&]+/, '$1[hidden]'), models, rawCount: models.length })
    }
    const result = resultFrom(provider, data, model)
    return sendJson(res, 200, { ok: true, status: response.status, elapsedMs, provider, url: request.url.replace(/([?&]key=)[^&]+/, '$1[hidden]'), ...result })
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt)
    const errorMessage = error?.name === 'AbortError' ? 'Request timed out.' : `Network request failed: ${error?.cause?.code || error?.message || 'Unknown error'}`
    return sendJson(res, 502, { ok: false, status: 0, elapsedMs, provider, url: request.url.replace(/([?&]key=)[^&]+/, '$1[hidden]'), error: errorMessage })
  } finally { clearTimeout(timer) }
}

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/probe') return probe(req, res)
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' })
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0])
  const safePath = normalize(requestPath === '/' ? '/index.html' : requestPath).replace(/^(\.\.(\\|\/|$))+/, '')
  const path = join(root, safePath)
  if (!path.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' })
  try {
    const info = await stat(path)
    if (!info.isFile()) return sendJson(res, 404, { error: 'Not found' })
    const content = await readFile(path)
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : content)
  } catch { sendJson(res, 404, { error: 'Not found' }) }
}).listen(port, '127.0.0.1', () => console.log(`LLM API Tester is running at http://127.0.0.1:${port}`))
