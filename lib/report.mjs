const TEXT_LIMIT = 500

function safeText(value) {
  return String(value ?? '')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, '$1[hidden]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[hidden]@')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [hidden]')
    .replace(/\b(sk-(?:ant-)?|AIza)[A-Za-z0-9._-]{8,}\b/g, '[hidden]')
    .slice(0, TEXT_LIMIT)
}

function scrub(value, secret = '') {
  const text = safeText(value)
  return secret ? text.split(secret).join('[hidden]') : text
}

export function rendererProbeResult(result = {}, secret = '') {
  const safe = {
    ok: Boolean(result.ok),
    status: Number(result.status) || 0,
    elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0,
    provider: result.provider ? scrub(result.provider, secret) : undefined,
    url: result.url ? scrub(result.url, secret) : undefined,
    resolvedEndpoint: result.resolvedEndpoint ? scrub(result.resolvedEndpoint, secret) : undefined,
    apiStyle: result.apiStyle ? scrub(result.apiStyle, secret) : undefined,
  }
  if (Array.isArray(result.models)) safe.models = result.models.map(item => scrub(item, secret)).slice(0, 10000)
  if (result.model) safe.model = scrub(result.model, secret)
  if (typeof result.content === 'string') safe.content = scrub(result.content, secret)
  if (result.usage && typeof result.usage === 'object') safe.usage = Object.fromEntries(Object.entries(result.usage).filter(([, value]) => typeof value === 'number'))
  if (Number.isFinite(result.ttftMs)) safe.ttftMs = result.ttftMs
  else if ('ttftMs' in result) safe.ttftMs = null
  if (Number.isFinite(result.chunks)) safe.chunks = result.chunks
  if (result.error) safe.error = scrub(result.error, secret)
  if (result.diagnosis) safe.diagnosis = {
    code: scrub(result.diagnosis.code, secret),
    message: scrub(result.diagnosis.message, secret),
    hint: result.diagnosis.hint ? scrub(result.diagnosis.hint, secret) : undefined,
    upstream: result.diagnosis.upstream ? scrub(result.diagnosis.upstream, secret) : undefined,
  }
  return safe
}

export function reportResult(result = {}) {
  return {
    ok: Boolean(result.ok),
    status: Number(result.status) || 0,
    elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
    ttftMs: Number.isFinite(result.ttftMs) ? result.ttftMs : null,
    modelCount: Array.isArray(result.models) ? result.models.length : null,
    model: result.model ? safeText(result.model) : null,
    apiStyle: result.apiStyle ? safeText(result.apiStyle) : null,
    endpoint: result.resolvedEndpoint || result.url ? safeText(result.resolvedEndpoint || result.url) : null,
    errorCode: result.diagnosis?.code ? safeText(result.diagnosis.code) : null,
    error: result.ok ? null : safeText(result.diagnosis?.message || result.error || '请求失败'),
  }
}

function chatSummary(result = {}) {
  const chat = result.chat
  if (!chat) return { chatOk: null, chatModel: null, chatElapsedMs: null, chatError: null }
  return {
    chatOk: Boolean(chat.ok),
    chatModel: chat.model ? safeText(chat.model) : null,
    chatElapsedMs: Number.isFinite(chat.elapsedMs) ? chat.elapsedMs : null,
    chatError: chat.ok ? null : safeText(chat.error || '调用失败'),
  }
}

export function streamAggregate(runs = []) {
  const valid = runs.filter(run => run && Number.isFinite(run.elapsedMs))
  if (!valid.length) return null
  const ttfts = valid.map(run => run.ttftMs).filter(Number.isFinite)
  const avg = values => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null)
  const generateSeconds = valid.reduce((sum, run) => sum + Math.max((run.elapsedMs - (Number.isFinite(run.ttftMs) ? run.ttftMs : 0)) / 1000, 0.001), 0)
  const chars = valid.reduce((sum, run) => sum + String(run.content || '').length, 0)
  const last = valid[valid.length - 1]
  return {
    runs: valid.length,
    avgTtftMs: avg(ttfts),
    bestTtftMs: ttfts.length ? Math.min(...ttfts) : null,
    avgElapsedMs: avg(valid.map(run => run.elapsedMs)),
    charsPerSecond: Math.round(chars / generateSeconds),
    content: last.content || '',
    apiStyle: last.apiStyle,
    resolvedEndpoint: last.resolvedEndpoint,
  }
}

export function batchReport(rows = []) {
  return rows.map(row => ({
    name: safeText(row.name),
    provider: safeText(row.provider),
    baseUrl: safeText(row.baseUrl),
    state: safeText(row.state || (row.result?.ok ? 'success' : 'failed')),
    ...reportResult(row.result),
    ...chatSummary(row.result || {}),
  }))
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

export function batchReportCsv(rows = []) {
  const data = batchReport(rows)
  const fields = ['name', 'provider', 'baseUrl', 'state', 'ok', 'status', 'modelCount', 'chatOk', 'chatModel', 'chatElapsedMs', 'chatError', 'elapsedMs', 'endpoint', 'errorCode', 'error']
  return `\uFEFF${[fields, ...data.map(row => fields.map(field => row[field]))].map(line => line.map(csvCell).join(',')).join('\r\n')}`
}
