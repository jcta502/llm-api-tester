const $ = (id) => document.getElementById(id)
const state = { models: [], listResult: null, probeResult: null }
const statusPanel = $('statusPanel')

function setStatus(kind, title, message, meta = '') {
  statusPanel.className = `status ${kind}`
  statusPanel.innerHTML = `<div class="status-icon">${kind === 'loading' ? '◌' : kind === 'success' ? '✓' : kind === 'error' ? '!' : '◎'}</div><div><strong>${title}</strong><p>${message}</p>${meta ? `<small>${meta}</small>` : ''}</div>`
}
function getConfig() { return { baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), timeoutMs: Number($('timeout').value) } }
async function callApi(action, extra = {}) {
  const response = await fetch('/api/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...getConfig(), action, ...extra }) })
  return response.json()
}
function escape(text) { const div = document.createElement('div'); div.textContent = String(text); return div.innerHTML }
function formatError(result) {
  const codes = { 401: 'Key 无效或已过期。', 403: '当前 Key 没有访问权限。', 404: '找不到接口，请检查 Base URL 是否包含正确的 /v1。', 429: '请求被限流或额度不足。', 500: '上游服务发生错误。', 502: '无法连接上游服务。' }
  return codes[result.status] || result.error || '请求失败。'
}
$('toggleKey').addEventListener('click', () => { $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password' })
$('fetchModels').addEventListener('click', async () => {
  const { baseUrl, apiKey } = getConfig()
  if (!baseUrl || !apiKey) return setStatus('error', '缺少配置', '请填写 API Base URL 与 API Key。')
  $('fetchModels').disabled = true; $('fetchModels').textContent = '正在获取…'; setStatus('loading', '正在验证连接', '尝试读取此 Key 可访问的模型列表。')
  try {
    const result = await callApi('models'); state.listResult = result
    if (!result.ok) { setStatus('error', '模型列表获取失败', formatError(result), `耗时 ${result.elapsedMs} ms · ${result.url}`); return }
    state.models = result.models; const select = $('modelSelect'); select.innerHTML = '<option value="">请选择模型</option>' + result.models.map(model => `<option value="${escape(model)}">${escape(model)}</option>`).join('')
    $('modelCount').textContent = `${result.models.length} 个模型`; $('modelsCard').classList.remove('hidden')
    setStatus('success', 'Key 与接口可用', `成功获取 ${result.models.length} 个模型。`, `HTTP ${result.status} · ${result.elapsedMs} ms · ${result.url}`)
  } catch { setStatus('error', '本地服务错误', '无法处理请求，请确认程序仍在运行。') }
  finally { $('fetchModels').disabled = false; $('fetchModels').innerHTML = '获取模型列表 <span>→</span>' }
})
$('modelSelect').addEventListener('change', () => { $('probeModel').disabled = !$('modelSelect').value })
$('probeModel').addEventListener('click', async () => {
  const model = $('modelSelect').value; if (!model) return
  $('probeModel').disabled = true; $('probeModel').textContent = '正在测试…'; setStatus('loading', '正在调用模型', `使用 ${model} 发送最小测试请求。`)
  try {
    const result = await callApi('chat', { model }); state.probeResult = result; $('resultCard').classList.remove('hidden')
    if (!result.ok) { setStatus('error', '模型调用失败', formatError(result), `耗时 ${result.elapsedMs} ms · ${result.url}`); $('resultContent').innerHTML = `<div class="error-detail"><strong>${escape(result.error)}</strong><pre>${escape(JSON.stringify(result.details || result, null, 2))}</pre></div>`; return }
    setStatus('success', '模型实际可用', `${result.model} 已成功响应。`, `HTTP ${result.status} · ${result.elapsedMs} ms · ${result.url}`)
    const usage = result.usage ? Object.entries(result.usage).filter(([, v]) => typeof v === 'number').map(([k, v]) => `<span><b>${escape(k)}</b>${escape(v)}</span>`).join('') : '<span>接口未返回 Token 用量</span>'
    $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">实际返回模型</p><code>${escape(result.model)}</code></div><div><p class="label">响应耗时</p><strong>${result.elapsedMs} ms</strong></div></div><div class="response"><p class="label">响应内容</p><pre>${escape(result.content)}</pre></div><div class="usage">${usage}</div>`
  } catch { setStatus('error', '本地服务错误', '无法处理请求，请确认程序仍在运行。') }
  finally { $('probeModel').disabled = false; $('probeModel').textContent = '实际调用测试' }
})
$('exportReport').addEventListener('click', () => {
  const report = { generatedAt: new Date().toISOString(), endpoint: $('baseUrl').value.trim(), modelListCheck: state.listResult, modelCheck: state.probeResult, note: 'API Key 已排除。' }
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'llm-api-report.json'; a.click(); URL.revokeObjectURL(url)
})
