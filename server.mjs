import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probePayload } from './lib/probe.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
function sendJson(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/probe') { let raw = ''; for await (const chunk of req) raw += chunk; try { const result = await probePayload(JSON.parse(raw || '{}')); return sendJson(res, result.status || 200, result) } catch { return sendJson(res, 400, { ok: false, status: 400, error: 'Request body must be valid JSON.' }) } }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' })
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0]); const safePath = normalize(requestPath === '/' ? '/index.html' : requestPath).replace(/^(\.\.(\\|\/|$))+/, ''); const path = join(root, safePath)
  if (!path.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' })
  try { const info = await stat(path); if (!info.isFile()) return sendJson(res, 404, { error: 'Not found' }); const content = await readFile(path); res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : content) } catch { sendJson(res, 404, { error: 'Not found' }) }
}).listen(port, '127.0.0.1', () => console.log(`LLM API Tester is running at http://127.0.0.1:${port}`))
