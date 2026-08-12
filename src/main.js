const $ = (id) => document.getElementById(id)
const providerInfo = {
  openai: { title: 'OpenAI 兼容接口', defaultUrl: '', placeholder: 'https://api.example.com/v1', help: '填写根地址或包含 /v1 的地址，工具会自动补全接口路径。', keyPlaceholder: 'sk-...' },
  anthropic: { title: 'Anthropic Messages 接口', defaultUrl: 'https://api.anthropic.com', placeholder: 'https://api.anthropic.com', help: '默认使用 Anthropic 官方地址，也支持兼容的自定义网关。', keyPlaceholder: 'sk-ant-...' },
  gemini: { title: 'Google Gemini 接口', defaultUrl: 'https://generativelanguage.googleapis.com', placeholder: 'https://generativelanguage.googleapis.com', help: '默认使用 Gemini 官方地址，也支持兼容的自定义网关。', keyPlaceholder: 'AIza...' },
}
const state = { provider: 'openai', models: [], listResult: null, probeResult: null }
const statusPanel = $('statusPanel')

function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value); return el.innerHTML }
function currentConfig() { return { provider: state.provider, baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), timeoutMs: Number($('timeout').value) } }
function setStatus(kind, title, message, meta = '') { statusPanel.className = `status ${kind}`; statusPanel.innerHTML = `<div class="status-icon">${kind === 'loading' ? '…' : kind === 'success' ? '✓' : kind === 'error' ? '!' : '1'}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</div>` }
function errorMessage(result) { if (result?.diagnosis?.message) return result.diagnosis.message; const mapped = { 400: '请求配置不正确，请检查填写内容。', 401: 'API Key 无效或已经过期。', 403: '当前 API Key 没有访问权限。', 404: '没有找到接口，请检查 Base URL。', 429: '请求受到限流，或者账户额度不足。', 500: '上游服务发生错误。', 502: '无法连接上游服务。' }; return mapped[result.status] || result.error || '请求失败。' }
function errorMeta(result) { const hint = result?.diagnosis?.hint || ''; const upstream = result?.diagnosis?.upstream || result?.error || ''; return [hint, upstream, result?.url].filter(Boolean).join(' | ') }
async function requestProbe(payload) { if (window.llmApi?.isDesktop) return window.llmApi.probe(payload); const response = await fetch('/api/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); return response.json() }
async function callApi(action, extra = {}) { return requestProbe({ ...currentConfig(), action, ...extra }) }
async function callConfig(config) { return requestProbe({ ...config, action: 'models' }) }
function chooseProvider(provider) { state.provider = provider; state.models = []; state.listResult = null; state.probeResult = null; const info = providerInfo[provider]; $('providerTitle').textContent = info.title; $('baseUrl').placeholder = info.placeholder; $('baseUrl').value = info.defaultUrl; $('baseUrlHelp').textContent = info.help; $('apiKey').placeholder = info.keyPlaceholder; $('modelsCard').classList.add('hidden'); $('resultCard').classList.add('hidden'); document.querySelectorAll('.provider').forEach(button => button.classList.toggle('active', button.dataset.provider === provider)); setStatus('empty', '等待开始检测', `已选择 ${info.title}，填写密钥后获取模型列表。`) }
function parseBatch() {
  const validProviders = new Set(Object.keys(providerInfo))
  return $('batchInput').value.split(/\r?\n/).map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(item => item.line && !item.line.startsWith('#')).map(item => {
    const [name, provider, baseUrl, apiKey] = item.line.split('|').map(value => value.trim())
    if (!name || !validProviders.has(provider) || !apiKey || (provider === 'openai' && !baseUrl)) return { ...item, error: '格式错误或 provider 不受支持' }
    return { ...item, name, provider, baseUrl: baseUrl || providerInfo[provider].defaultUrl, apiKey, timeoutMs: Number($('timeout').value) }
  })
}
function renderBatch(rows) {
  $('batchResults').classList.remove('hidden')
  $('batchResults').innerHTML = `<table><thead><tr><th>名称</th><th>服务商</th><th>状态</th><th>模型数</th><th>延迟</th><th>接口 / 原因</th></tr></thead><tbody>${rows.map(row => {
    if (row.error) return `<tr><td>${escapeHtml(row.name || `第 ${row.number} 行`)}</td><td>${escapeHtml(row.provider || '-')}</td><td class="batch-fail">格式错误</td><td>-</td><td>-</td><td>${escapeHtml(row.error)}</td></tr>`
    const ok = row.result?.ok
    return `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.provider)}</td><td class="${ok ? 'batch-ok' : 'batch-fail'}">${ok ? '可用' : `HTTP ${row.result?.status || 0}`}</td><td>${ok ? row.result.models.length : '-'}</td><td>${row.result ? `${row.result.elapsedMs} ms` : '-'}</td><td><code>${escapeHtml(ok ? row.result.url : errorMessage(row.result || {}))}</code></td></tr>`
  }).join('')}</tbody></table>`
}

document.querySelectorAll('.provider').forEach(button => button.addEventListener('click', () => chooseProvider(button.dataset.provider)))
$('toggleKey').addEventListener('click', () => { const showing = $('apiKey').type === 'password'; $('apiKey').type = showing ? 'text' : 'password'; $('toggleKey').textContent = showing ? '隐藏' : '显示' })
$('fetchModels').addEventListener('click', async () => {
  const { baseUrl, apiKey, provider } = currentConfig()
  if (!apiKey || (provider === 'openai' && !baseUrl)) return setStatus('error', '缺少必要配置', '请填写 API Key 和所需的 Base URL。')
  const button = $('fetchModels'); button.disabled = true; button.textContent = '正在获取…'; setStatus('loading', '正在验证接口', '正在向服务商请求当前密钥可访问的模型列表。')
  try {
    const result = await callApi('models'); state.listResult = result
    if (!result.ok) return setStatus('error', '获取模型失败', errorMessage(result), errorMeta(result))
    state.models = result.models; $('modelSelect').innerHTML = '<option value="">请选择模型</option>' + result.models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join(''); $('modelCount').textContent = `${result.models.length} 个模型`; $('modelsCard').classList.remove('hidden'); setStatus('success', '接口和密钥可用', `成功获取 ${result.models.length} 个可用模型。`, `HTTP ${result.status} | ${result.elapsedMs} ms | ${result.url}`)
  } catch { setStatus('error', '程序处理失败', '应用无法完成本次请求，请稍后重试。') }
  finally { button.disabled = false; button.innerHTML = '获取模型列表 <span>→</span>' }
})
$('modelSelect').addEventListener('change', () => { const disabled = !$('modelSelect').value; $('probeModel').disabled = disabled; $('probeStream').disabled = disabled })
$('probeModel').addEventListener('click', async () => {
  const model = $('modelSelect').value; if (!model) return
  const button = $('probeModel'); button.disabled = true; button.textContent = '正在验证…'; setStatus('loading', '正在调用模型', `正在向 ${model} 发送最小测试请求。`)
  try {
    const result = await callApi('chat', { model }); state.probeResult = result; $('resultCard').classList.remove('hidden')
    if (!result.ok) { setStatus('error', '模型调用失败', errorMessage(result), errorMeta(result)); $('resultContent').innerHTML = `<div class="error-detail"><strong>${escapeHtml(result.diagnosis?.message || result.error)}</strong><pre>${escapeHtml(JSON.stringify(result.details || result.diagnosis || result, null, 2))}</pre></div>`; return }
    setStatus('success', '模型实际可用', `${result.model} 已成功返回响应。`, `HTTP ${result.status} | ${result.elapsedMs} ms | ${result.url}`)
    const usage = result.usage ? Object.entries(result.usage).filter(([, value]) => typeof value === 'number').map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('') : '<span>接口未返回 Token 用量</span>'
    $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">实际返回模型</p><code>${escapeHtml(result.model)}</code></div><div><p class="label">总耗时</p><strong>${result.elapsedMs} ms</strong></div></div><div class="response"><p class="label">响应内容</p><pre>${escapeHtml(result.content)}</pre></div><div class="usage">${usage}</div>`
  } catch { setStatus('error', '程序处理失败', '应用无法完成本次请求，请稍后重试。') }
  finally { button.disabled = false; button.textContent = '发起最小调用' }
})
$('probeStream').addEventListener('click', async () => {
  const model = $('modelSelect').value; if (!model) return
  const button = $('probeStream'); button.disabled = true; button.textContent = '正在测试…'; setStatus('loading', '正在进行流式测试', `正在测量 ${model} 的首字延迟。`)
  try {
    const result = await callApi('stream', { model }); state.probeResult = result; $('resultCard').classList.remove('hidden')
    if (!result.ok) { setStatus('error', '流式测试失败', errorMessage(result), errorMeta(result)); $('resultContent').innerHTML = `<div class="error-detail"><strong>${escapeHtml(result.diagnosis?.message || result.error)}</strong><pre>${escapeHtml(JSON.stringify(result.details || result.diagnosis || result, null, 2))}</pre></div>`; return }
    const ttft = result.ttftMs === null ? '未检测到文本块' : `${result.ttftMs} ms`
    setStatus('success', '流式响应可用', `首字延迟 ${ttft}，共收到 ${result.chunks} 个文本块。`, `HTTP ${result.status} | 总耗时 ${result.elapsedMs} ms | ${result.resolvedEndpoint}`)
    $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">首字延迟 TTFT</p><strong>${escapeHtml(ttft)}</strong></div><div><p class="label">完整响应耗时</p><strong>${result.elapsedMs} ms</strong></div></div><div class="response"><p class="label">流式响应内容</p><pre>${escapeHtml(result.content || '接口建立了流连接，但没有返回可识别的文本块。')}</pre></div><div class="usage"><span><b>接口类型</b>${escapeHtml(result.apiStyle)}</span><span><b>文本块</b>${result.chunks}</span></div>`
  } catch { setStatus('error', '程序处理失败', '应用无法完成本次流式测试，请稍后重试。') }
  finally { button.disabled = false; button.textContent = '流式速度测试' }
})
$('exportReport').addEventListener('click', () => { const report = { generatedAt: new Date().toISOString(), provider: state.provider, endpoint: $('baseUrl').value.trim(), modelListCheck: state.listResult, modelCheck: state.probeResult, note: 'API keys are excluded from this report.' }; const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'llm-api-report.json'; link.click(); URL.revokeObjectURL(url) })
$('loadCurrent').addEventListener('click', () => { const config = currentConfig(); if (!config.apiKey || (config.provider === 'openai' && !config.baseUrl)) { $('batchMessage').textContent = '请先填写完整的当前配置。'; return }; const label = providerInfo[config.provider].title; const line = `${label} | ${config.provider} | ${config.baseUrl || providerInfo[config.provider].defaultUrl} | ${config.apiKey}`; $('batchInput').value = $('batchInput').value.trim() ? `${$('batchInput').value.trim()}\n${line}` : line; $('batchMessage').textContent = '当前配置已加入。密钥仍只保留在页面内存中。' })
$('runBatch').addEventListener('click', async () => {
  const rows = parseBatch(); if (!rows.length) { $('batchMessage').textContent = '请至少添加一行配置。'; return }
  const button = $('runBatch'); button.disabled = true; button.textContent = '正在检测…'; $('batchMessage').textContent = `正在逐一检测 ${rows.length} 个配置…`; renderBatch(rows)
  let passed = 0
  for (const row of rows) { if (row.error) continue; try { row.result = await callConfig(row); if (row.result.ok) passed += 1 } catch { row.result = { ok: false, status: 0, error: '程序处理失败', elapsedMs: 0 } }; renderBatch(rows) }
  $('batchMessage').textContent = `批量检测完成：${rows.filter(row => !row.error).length} 个有效配置中有 ${passed} 个成功返回模型列表。`; button.disabled = false; button.textContent = '开始批量检测'
})
