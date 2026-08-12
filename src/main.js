const $ = (id) => document.getElementById(id)
const providerInfo = {
  openai: { title: 'OpenAI-compatible API', defaultUrl: '', placeholder: 'https://api.example.com/v1', help: 'Use the root or /v1 address. The required endpoint is added automatically.', keyPlaceholder: 'sk-...' },
  anthropic: { title: 'Anthropic Messages API', defaultUrl: 'https://api.anthropic.com', placeholder: 'https://api.anthropic.com', help: 'Defaults to the official Anthropic API. The app calls /v1/models and /v1/messages.', keyPlaceholder: 'sk-ant-...' },
  gemini: { title: 'Google Gemini API', defaultUrl: 'https://generativelanguage.googleapis.com', placeholder: 'https://generativelanguage.googleapis.com', help: 'Defaults to the Gemini API. The app calls v1beta/models and generateContent.', keyPlaceholder: 'AIza...' },
}
const state = { provider: 'openai', models: [], listResult: null, probeResult: null }
const statusPanel = $('statusPanel')

function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value); return el.innerHTML }
function currentConfig() { return { provider: state.provider, baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), timeoutMs: Number($('timeout').value) } }
function setStatus(kind, title, message, meta = '') { statusPanel.className = `status ${kind}`; statusPanel.innerHTML = `<div class="status-icon">${kind === 'loading' ? '~' : kind === 'success' ? 'OK' : kind === 'error' ? '!' : 'o'}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</div>` }
function errorMessage(result) { const mapped = { 400: 'The request configuration was rejected.', 401: 'The API key is invalid or expired.', 403: 'The API key does not have permission.', 404: 'The endpoint was not found. Check the Base URL.', 429: 'The provider is rate-limiting this request or the account has no credit.', 500: 'The upstream service returned an error.', 502: 'The upstream service could not be reached.' }; return mapped[result.status] || result.error || 'The request failed.' }
async function requestProbe(payload) { if (window.llmApi?.isDesktop) return window.llmApi.probe(payload); const response = await fetch('/api/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); return response.json() }
async function callApi(action, extra = {}) { return requestProbe({ ...currentConfig(), action, ...extra }) }
async function callConfig(config) { return requestProbe({ ...config, action: 'models' }) }
function chooseProvider(provider) { state.provider = provider; state.models = []; state.listResult = null; state.probeResult = null; const info = providerInfo[provider]; $('providerTitle').textContent = info.title; $('baseUrl').placeholder = info.placeholder; $('baseUrl').value = info.defaultUrl; $('baseUrlHelp').textContent = info.help; $('apiKey').placeholder = info.keyPlaceholder; $('modelsCard').classList.add('hidden'); $('resultCard').classList.add('hidden'); document.querySelectorAll('.provider').forEach(button => button.classList.toggle('active', button.dataset.provider === provider)); setStatus('empty', 'Ready to test', `Selected ${info.title}. Enter a key, then fetch models.`) }
function parseBatch() {
  const validProviders = new Set(Object.keys(providerInfo))
  return $('batchInput').value.split(/\r?\n/).map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(item => item.line && !item.line.startsWith('#')).map(item => {
    const [name, provider, baseUrl, apiKey] = item.line.split('|').map(value => value.trim())
    if (!name || !validProviders.has(provider) || !apiKey || (provider === 'openai' && !baseUrl)) return { ...item, error: 'Invalid format or provider' }
    return { ...item, name, provider, baseUrl: baseUrl || providerInfo[provider].defaultUrl, apiKey, timeoutMs: Number($('timeout').value) }
  })
}
function renderBatch(rows) {
  $('batchResults').classList.remove('hidden')
  $('batchResults').innerHTML = `<table><thead><tr><th>Name</th><th>Provider</th><th>Status</th><th>Models</th><th>Latency</th><th>Endpoint / reason</th></tr></thead><tbody>${rows.map(row => {
    if (row.error) return `<tr><td>${escapeHtml(row.name || `Line ${row.number}`)}</td><td>${escapeHtml(row.provider || '-')}</td><td class="batch-fail">INVALID</td><td>-</td><td>-</td><td>${escapeHtml(row.error)}</td></tr>`
    const ok = row.result?.ok
    return `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.provider)}</td><td class="${ok ? 'batch-ok' : 'batch-fail'}">${ok ? 'AVAILABLE' : `HTTP ${row.result?.status || 0}`}</td><td>${ok ? row.result.models.length : '-'}</td><td>${row.result ? `${row.result.elapsedMs} ms` : '-'}</td><td><code>${escapeHtml(ok ? row.result.url : errorMessage(row.result || {}))}</code></td></tr>`
  }).join('')}</tbody></table>`
}

document.querySelectorAll('.provider').forEach(button => button.addEventListener('click', () => chooseProvider(button.dataset.provider)))
$('toggleKey').addEventListener('click', () => { $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password' })
$('fetchModels').addEventListener('click', async () => {
  const { baseUrl, apiKey, provider } = currentConfig()
  if (!apiKey || (provider === 'openai' && !baseUrl)) return setStatus('error', 'Missing configuration', 'Enter an API key and the required Base URL.')
  const button = $('fetchModels'); button.disabled = true; button.textContent = 'Fetching...'; setStatus('loading', 'Checking credentials', 'Requesting the model list from the selected provider.')
  try {
    const result = await callApi('models'); state.listResult = result
    if (!result.ok) return setStatus('error', 'Could not fetch models', errorMessage(result), `${result.elapsedMs} ms | ${result.url}`)
    state.models = result.models; $('modelSelect').innerHTML = '<option value="">Choose a model</option>' + result.models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join(''); $('modelCount').textContent = `${result.models.length} models`; $('modelsCard').classList.remove('hidden'); setStatus('success', 'Credentials are accepted', `Fetched ${result.models.length} models from ${providerInfo[result.provider].title}.`, `HTTP ${result.status} | ${result.elapsedMs} ms | ${result.url}`)
  } catch { setStatus('error', 'Local service error', 'The local app could not process this request.') }
  finally { button.disabled = false; button.innerHTML = 'Fetch models <span>-></span>' }
})
$('modelSelect').addEventListener('change', () => { $('probeModel').disabled = !$('modelSelect').value })
$('probeModel').addEventListener('click', async () => {
  const model = $('modelSelect').value; if (!model) return
  const button = $('probeModel'); button.disabled = true; button.textContent = 'Testing...'; setStatus('loading', 'Calling the model', `Sending a minimal request to ${model}.`)
  try {
    const result = await callApi('chat', { model }); state.probeResult = result; $('resultCard').classList.remove('hidden')
    if (!result.ok) { setStatus('error', 'Model call failed', errorMessage(result), `${result.elapsedMs} ms | ${result.url}`); $('resultContent').innerHTML = `<div class="error-detail"><strong>${escapeHtml(result.error)}</strong><pre>${escapeHtml(JSON.stringify(result.details || result, null, 2))}</pre></div>`; return }
    setStatus('success', 'The model is usable', `${result.model} returned a response.`, `HTTP ${result.status} | ${result.elapsedMs} ms | ${result.url}`)
    const usage = result.usage ? Object.entries(result.usage).filter(([, value]) => typeof value === 'number').map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('') : '<span>The provider did not return token usage.</span>'
    $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">RETURNED MODEL</p><code>${escapeHtml(result.model)}</code></div><div><p class="label">TOTAL TIME</p><strong>${result.elapsedMs} ms</strong></div></div><div class="response"><p class="label">RESPONSE</p><pre>${escapeHtml(result.content)}</pre></div><div class="usage">${usage}</div>`
  } catch { setStatus('error', 'Local service error', 'The local app could not process this request.') }
  finally { button.disabled = false; button.textContent = 'Test real call' }
})
$('exportReport').addEventListener('click', () => { const report = { generatedAt: new Date().toISOString(), provider: state.provider, endpoint: $('baseUrl').value.trim(), modelListCheck: state.listResult, modelCheck: state.probeResult, note: 'API keys are excluded from this report.' }; const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'llm-api-report.json'; link.click(); URL.revokeObjectURL(url) })
$('loadCurrent').addEventListener('click', () => { const config = currentConfig(); if (!config.apiKey || (config.provider === 'openai' && !config.baseUrl)) { $('batchMessage').textContent = 'Enter a valid current configuration before adding it.'; return }; const label = providerInfo[config.provider].title.replace(' API', ''); const line = `${label} | ${config.provider} | ${config.baseUrl || providerInfo[config.provider].defaultUrl} | ${config.apiKey}`; $('batchInput').value = $('batchInput').value.trim() ? `${$('batchInput').value.trim()}\n${line}` : line; $('batchMessage').textContent = 'Current configuration added. API keys remain only in the page memory.' })
$('runBatch').addEventListener('click', async () => {
  const rows = parseBatch(); if (!rows.length) { $('batchMessage').textContent = 'Add at least one configuration line.'; return }
  const button = $('runBatch'); button.disabled = true; button.textContent = 'Running...'; $('batchMessage').textContent = `Checking ${rows.length} configuration(s), one at a time...`; renderBatch(rows)
  let passed = 0
  for (const row of rows) { if (row.error) continue; try { row.result = await callConfig(row); if (row.result.ok) passed += 1 } catch { row.result = { ok: false, status: 0, error: 'Local service error', elapsedMs: 0 } }; renderBatch(rows) }
  $('batchMessage').textContent = `Batch check complete: ${passed} of ${rows.filter(row => !row.error).length} valid configurations returned a model list.`; button.disabled = false; button.textContent = 'Run batch check'
})
