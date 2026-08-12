const PATH_SUFFIXES = [/\/chat\/completions\/?$/i, /\/responses\/?$/i, /\/messages\/?$/i, /\/models\/?$/i]

function parseBaseUrl(baseUrl) {
  const base = new URL(String(baseUrl || '').trim())
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Only HTTP(S) URLs are supported.')
  base.hash = ''
  base.search = ''
  base.pathname = base.pathname.replace(/\/+$/, '')
  for (const suffix of PATH_SUFFIXES) base.pathname = base.pathname.replace(suffix, '')
  return base
}

function joinEndpoint(baseUrl, path) {
  const base = baseUrl instanceof URL ? new URL(baseUrl) : parseBaseUrl(baseUrl)
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/+/g, '/')
  return base
}

function candidateRoots(baseUrl, version) {
  const base = parseBaseUrl(baseUrl)
  const roots = [base]
  if (base.pathname.endsWith(`/${version}`)) {
    const withoutVersion = new URL(base)
    withoutVersion.pathname = withoutVersion.pathname.slice(0, -version.length - 1) || '/'
    roots.push(withoutVersion)
  } else {
    roots.push(joinEndpoint(base, version))
  }
  return [...new Map(roots.map(url => [url.toString(), url])).values()]
}

function safeUrl(value) {
  return value.replace(/([?&]key=)[^&]+/i, '$1[hidden]')
}

function providerRequests(provider, baseUrl, apiKey, action, model) {
  if (provider === 'anthropic') {
    const roots = candidateRoots(baseUrl || 'https://api.anthropic.com', 'v1')
    return roots.map(root => ({ url: joinEndpoint(root, action === 'models' ? 'models' : 'messages').toString(), method: action === 'models' ? 'GET' : 'POST', apiStyle: 'anthropic', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: action === 'stream' ? 'text/event-stream' : 'application/json' }, body: action === 'models' ? undefined : { model, max_tokens: 8, temperature: 0, stream: action === 'stream', messages: [{ role: 'user', content: 'Reply with exactly: OK' }] } }))
  }
  if (provider === 'gemini') {
    const roots = candidateRoots(baseUrl || 'https://generativelanguage.googleapis.com', 'v1beta')
    return roots.map(root => {
      const modelId = String(model || '').replace(/^models\//, '')
      const method = action === 'models' ? 'models' : `models/${encodeURIComponent(modelId)}:${action === 'stream' ? 'streamGenerateContent' : 'generateContent'}`
      const url = joinEndpoint(root, method)
      url.searchParams.set('key', apiKey)
      if (action === 'stream') url.searchParams.set('alt', 'sse')
      return { url: url.toString(), method: action === 'models' ? 'GET' : 'POST', apiStyle: 'gemini', headers: { 'content-type': 'application/json', accept: action === 'stream' ? 'text/event-stream' : 'application/json' }, body: action === 'models' ? undefined : { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } } }
    })
  }
  const roots = candidateRoots(baseUrl, 'v1')
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: action === 'stream' ? 'text/event-stream' : 'application/json' }
  if (action === 'models') return roots.map(root => ({ url: joinEndpoint(root, 'models').toString(), method: 'GET', apiStyle: 'models', headers }))
  return roots.flatMap(root => [
    { url: joinEndpoint(root, 'chat/completions').toString(), method: 'POST', apiStyle: 'chat', headers, body: { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8, temperature: 0, stream: action === 'stream' } },
    { url: joinEndpoint(root, 'responses').toString(), method: 'POST', apiStyle: 'responses', headers, body: { model, input: 'Reply with exactly: OK', max_output_tokens: 8, stream: action === 'stream' } },
  ])
}

function modelsFrom(provider, data) {
  if (provider === 'gemini') return (data.models || []).filter(item => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent')).map(item => item.name || item.displayName).filter(Boolean).map(id => id.replace(/^models\//, '')).sort()
  return (data.data || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean).sort()
}

function resultFrom(provider, apiStyle, data, requestedModel) {
  if (provider === 'anthropic') return { model: data.model || requestedModel, content: (data.content || []).map(item => item.text || '').filter(Boolean).join('\n'), usage: data.usage || null }
  if (provider === 'gemini') return { model: requestedModel, content: (data.candidates || []).flatMap(item => item.content?.parts || []).map(part => part.text || '').filter(Boolean).join('\n'), usage: data.usageMetadata || null }
  if (apiStyle === 'responses') return { model: data.model || requestedModel, content: data.output_text || (data.output || []).flatMap(item => item.content || []).map(item => item.text || '').filter(Boolean).join('\n') || '(The API returned no recognizable text.)', usage: data.usage || null }
  return { model: data.model || requestedModel, content: data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '(The API returned no recognizable text.)', usage: data.usage || null }
}

function httpDiagnosis(status, data) {
  const upstream = data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '')
  const known = {
    400: ['bad_request', '请求参数被上游拒绝', '接口存在，但请求格式或模型参数不被接受。'],
    401: ['authentication', 'API Key 无效或已过期', '检查密钥是否完整、是否属于当前服务商。'],
    403: ['permission', '当前密钥没有访问权限', '检查模型权限、账户状态或地区限制。'],
    404: ['not_found', '没有找到接口路径', '工具将继续尝试其他兼容路径。'],
    405: ['method_not_allowed', '接口不接受当前请求方法', '工具将继续尝试其他兼容路径。'],
    408: ['upstream_timeout', '上游请求超时', '稍后重试或增加超时时间。'],
    429: ['rate_limit', '请求限流或账户额度不足', '检查余额、速率限制和并发数量。'],
  }
  const [code, message, hint] = known[status] || (status >= 500 ? ['upstream_server', '上游服务异常', '服务商暂时不可用，请稍后重试。'] : ['http_error', `HTTP ${status}`, '查看上游返回的错误详情。'])
  return { code, message, hint, upstream: upstream || undefined }
}

function networkDiagnosis(error) {
  if (error?.name === 'AbortError') return { code: 'timeout', message: '请求超时', hint: '增加超时时间，或检查接口是否响应过慢。' }
  const code = error?.cause?.code || error?.code || ''
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return { code: 'dns', message: '域名解析失败', hint: '检查域名拼写、DNS 或网络连接。' }
  if (code === 'ECONNREFUSED') return { code: 'connection_refused', message: '目标服务器拒绝连接', hint: '检查端口、服务状态或防火墙。' }
  if (['ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) return { code: 'connection_reset', message: '连接被中途重置', hint: '检查代理、网关稳定性或稍后重试。' }
  if (/CERT|TLS|SSL/i.test(`${code} ${error?.message || ''}`)) return { code: 'tls', message: 'TLS/证书校验失败', hint: '检查证书是否有效、域名是否匹配。' }
  return { code: 'network', message: '网络请求失败', hint: '检查网络、代理、防火墙和目标地址。', upstream: error?.message || undefined }
}

function parseSseText(provider, apiStyle, event) {
  if (!event || event === '[DONE]') return ''
  let data
  try { data = JSON.parse(event) } catch { return '' }
  if (provider === 'anthropic') return data.delta?.text || ''
  if (provider === 'gemini') return (data.candidates || []).flatMap(item => item.content?.parts || []).map(part => part.text || '').join('')
  if (apiStyle === 'responses') return typeof data.delta === 'string' ? data.delta : ''
  return data.choices?.[0]?.delta?.content || ''
}

async function readStream(response, provider, apiStyle, startedAt) {
  if (!response.body) return { content: '', ttftMs: null, chunks: 0 }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let ttftMs = null
  let chunks = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const text = parseSseText(provider, apiStyle, line.slice(5).trim())
        if (!text) continue
        if (ttftMs === null) ttftMs = Math.round(performance.now() - startedAt)
        content += text
        chunks += 1
      }
    }
  }
  return { content, ttftMs, chunks }
}

async function executeRequest(request, provider, action, model, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()
  try {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ? JSON.stringify(request.body) : undefined, signal: controller.signal })
    const url = safeUrl(request.url)
    if (action === 'stream' && response.ok) {
      const streamed = await readStream(response, provider, request.apiStyle, startedAt)
      return { ok: true, status: response.status, elapsedMs: Math.round(performance.now() - startedAt), provider, url, resolvedEndpoint: url, apiStyle: request.apiStyle, model, usage: null, ...streamed }
    }
    const elapsedMs = Math.round(performance.now() - startedAt)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
    if (!response.ok) return { ok: false, status: response.status, elapsedMs, provider, url, apiStyle: request.apiStyle, error: data?.error?.message || data?.message || `HTTP ${response.status}`, diagnosis: httpDiagnosis(response.status, data), details: data }
    if (action === 'models') { const models = modelsFrom(provider, data); return { ok: true, status: response.status, elapsedMs, provider, url, resolvedEndpoint: url, apiStyle: request.apiStyle, models, rawCount: models.length } }
    return { ok: true, status: response.status, elapsedMs, provider, url, resolvedEndpoint: url, apiStyle: request.apiStyle, ...resultFrom(provider, request.apiStyle, data, model) }
  } catch (error) {
    const diagnosis = networkDiagnosis(error)
    return { ok: false, status: 0, elapsedMs: Math.round(performance.now() - startedAt), provider, url: safeUrl(request.url), apiStyle: request.apiStyle, error: diagnosis.upstream || diagnosis.message, diagnosis }
  } finally { clearTimeout(timer) }
}

export async function probePayload(payload) {
  const { provider = 'openai', baseUrl, apiKey, action, model, timeoutMs = 15000 } = payload || {}
  if (!apiKey || (provider === 'openai' && !baseUrl)) return { ok: false, status: 400, error: '请填写 API Key 和所需的 Base URL。', diagnosis: { code: 'validation', message: '缺少必要配置', hint: '填写完整配置后重试。' } }
  if (!['openai', 'anthropic', 'gemini'].includes(provider)) return { ok: false, status: 400, error: '不支持的服务商。' }
  if (!['models', 'chat', 'stream'].includes(action)) return { ok: false, status: 400, error: '不支持的检测动作。' }
  if (action !== 'models' && (!model || typeof model !== 'string')) return { ok: false, status: 400, error: '请先选择模型。' }
  let requests
  try { requests = providerRequests(provider, baseUrl, apiKey, action, model) } catch { return { ok: false, status: 400, error: 'Base URL 必须是有效的 HTTP(S) 地址。', diagnosis: { code: 'invalid_url', message: 'URL 格式不正确', hint: '请填写包含 http:// 或 https:// 的完整地址。' } } }
  const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 3000), 60000)
  const attempts = []
  let last
  for (const request of requests) {
    const result = await executeRequest(request, provider, action, model, timeout)
    attempts.push({ url: result.url, status: result.status, elapsedMs: result.elapsedMs, apiStyle: result.apiStyle })
    if (result.ok) return { ...result, attempts }
    last = result
    if (![404, 405].includes(result.status)) return { ...result, attempts }
  }
  return { ...(last || { ok: false, status: 404, error: '未找到兼容接口。', diagnosis: { code: 'not_found', message: '未找到兼容接口', hint: '检查 Base URL 或服务商协议。' } }), attempts }
}
