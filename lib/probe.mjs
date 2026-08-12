function joinEndpoint(baseUrl, path) {
  const base = new URL(baseUrl.trim())
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Only HTTP(S) URLs are supported.')
  base.hash = ''
  base.search = ''
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/+/g, '/')
  return base.toString()
}

function safeUrl(value) {
  return value.replace(/([?&]key=)[^&]+/, '$1[hidden]')
}

function providerRequest(provider, baseUrl, apiKey, action, model) {
  if (provider === 'anthropic') {
    return { url: joinEndpoint(baseUrl || 'https://api.anthropic.com', action === 'models' ? 'v1/models' : 'v1/messages'), method: action === 'models' ? 'GET' : 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' }, body: action === 'models' ? undefined : { model, max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] } }
  }
  if (provider === 'gemini') {
    const url = new URL(joinEndpoint(baseUrl || 'https://generativelanguage.googleapis.com', action === 'models' ? 'v1beta/models' : `v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`))
    url.searchParams.set('key', apiKey)
    return { url: url.toString(), method: action === 'models' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: action === 'models' ? undefined : { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } } }
  }
  return { url: joinEndpoint(baseUrl, action === 'models' ? 'models' : 'chat/completions'), method: action === 'models' ? 'GET' : 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' }, body: action === 'models' ? undefined : { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8, temperature: 0, stream: false } }
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

export async function probePayload(payload) {
  const { provider = 'openai', baseUrl, apiKey, action, model, timeoutMs = 15000 } = payload || {}
  if (!apiKey || (provider === 'openai' && !baseUrl)) return { ok: false, status: 400, error: 'Enter an API key and the required Base URL.' }
  if (!['openai', 'anthropic', 'gemini'].includes(provider)) return { ok: false, status: 400, error: 'Unsupported provider.' }
  if (action !== 'models' && (!model || typeof model !== 'string')) return { ok: false, status: 400, error: 'Choose a model before testing it.' }
  let request
  try { request = providerRequest(provider, baseUrl, apiKey, action, model) } catch { return { ok: false, status: 400, error: 'The Base URL must be a valid HTTP(S) address.' } }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || 15000, 3000), 60000))
  const startedAt = performance.now()
  try {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ? JSON.stringify(request.body) : undefined, signal: controller.signal })
    const elapsedMs = Math.round(performance.now() - startedAt)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
    const url = safeUrl(request.url)
    if (!response.ok) return { ok: false, status: response.status, elapsedMs, provider, url, error: data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '') || `HTTP ${response.status}`, details: data }
    if (action === 'models') { const models = modelsFrom(provider, data); return { ok: true, status: response.status, elapsedMs, provider, url, models, rawCount: models.length } }
    return { ok: true, status: response.status, elapsedMs, provider, url, ...resultFrom(provider, data, model) }
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt)
    return { ok: false, status: 502, elapsedMs, provider, url: safeUrl(request.url), error: error?.name === 'AbortError' ? 'Request timed out.' : `Network request failed: ${error?.cause?.code || error?.message || 'Unknown error'}` }
  } finally { clearTimeout(timer) }
}
