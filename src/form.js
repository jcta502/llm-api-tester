import { reportResult, streamAggregate } from '../lib/report.mjs'
import { $, escapeHtml, setStatus, saveBlob, errorMessage, errorMeta, setSelectOptions } from './dom.js'
import { providerInfo, state } from './state.js'
import { loadProfiles } from './profiles.js'

function parseHeaderLines(text) {
  const headers = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf(':')
    if (at <= 0) throw new Error(`请求头格式不正确：${trimmed.slice(0, 30)}`)
    headers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return headers
}

function currentConfig() {
  const headers = parseHeaderLines($('customHeaders').value)
  return { id: state.editingId, name: $('profileName').value.trim(), group: $('profileGroup').value.trim(), provider: state.provider, baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), ...(Object.keys(headers).length ? { headers } : {}), timeoutMs: Number($('timeout').value) }
}

function cleanForSingleReport() { return { generatedAt: new Date().toISOString(), provider: state.provider, endpoint: $('baseUrl').value.trim(), modelListCheck: reportResult(state.listResult), modelCheck: reportResult(state.probeResult), note: 'API keys and upstream raw payloads are excluded.' } }

async function requestProbe(payload) {
  if (!payload.apiKey && state.editingId && state.editingHasKey) {
    const typedHeaders = $('customHeaders').value.trim() !== ''
    const saved = state.profiles.find(item => item.id === state.editingId)
    const unchanged = saved && !typedHeaders && saved.provider === payload.provider && saved.baseUrl === payload.baseUrl && saved.timeoutMs === payload.timeoutMs
    if (!unchanged) return { ok: false, status: 400, error: '配置有未保存的修改。', diagnosis: { code: 'unsaved_profile', message: '请先保存配置修改', hint: '为了防止已保存的密钥被发送到未确认的新地址，修改 URL、服务商或请求头后必须先保存。' } }
    return window.llmApi.profiles.probe({ id: state.editingId, action: payload.action, model: payload.model })
  }
  return window.llmApi.probe(payload)
}

async function callApi(action, extra = {}) { return requestProbe({ ...currentConfig(), action, ...extra }) }

export function chooseProvider(provider, options = {}) {
  const previous = state.provider
  if (previous !== provider && !options.keepUrl) state.providerUrls[previous] = $('baseUrl').value.trim()
  state.provider = provider; state.models = []; state.listResult = null; state.probeResult = null
  const info = providerInfo[provider]
  $('providerTitle').textContent = info.title; $('baseUrl').placeholder = info.placeholder; $('baseUrlHelp').textContent = info.help; $('apiKey').placeholder = info.keyPlaceholder
  if (!options.keepUrl) {
    $('baseUrl').value = state.providerUrls[provider] ?? info.defaultUrl
    $('apiKey').value = ''
    if (previous !== provider && state.editingHasKey) $('keyHelp').textContent = '已切换服务商，原密钥不会沿用；如需继续用原配置请重新载入。'
  }
  $('modelsCard').classList.add('hidden'); $('resultCard').classList.add('hidden')
  document.querySelectorAll('.provider').forEach(button => button.classList.toggle('active', button.dataset.provider === provider))
  if (!options.silent) setStatus('empty', '等待开始检测', `已选择 ${info.title}，填写密钥或载入已保存配置后获取模型列表。`)
}

export function resetForm() {
  state.editingId = null; state.editingHasKey = false; state.editingHasHeaders = false
  $('profileName').value = ''; $('profileGroup').value = ''; $('customHeaders').value = ''; $('headersHelp').textContent = '部分网关需要附加请求头。内容会与密钥一样加密保存，导出配置时不会包含。'
  $('apiKey').value = ''; $('timeout').value = '15000'; $('editBadge').textContent = '新建'; $('keyHelp').textContent = '新配置需要输入密钥；编辑配置时留空会保留原密钥。'
  chooseProvider('openai')
}

export function loadProfile(id, { duplicate = false } = {}) {
  const profile = state.profiles.find(item => item.id === id); if (!profile) return
  state.editingId = duplicate ? null : profile.id; state.editingHasKey = duplicate ? false : profile.hasKey; state.editingHasHeaders = duplicate ? false : profile.hasHeaders
  $('profileName').value = duplicate ? `${profile.name} (副本)` : profile.name
  $('profileGroup').value = profile.group || ''
  $('baseUrl').value = profile.baseUrl; $('apiKey').value = ''; $('customHeaders').value = ''
  $('timeout').value = String(profile.timeoutMs)
  $('editBadge').textContent = duplicate ? '新建' : '编辑'
  $('keyHelp').textContent = profile.hasKey && !duplicate ? '已安全保存密钥。留空会保留原密钥，输入新值会替换。' : '此配置还没有密钥，请输入后重新保存。'
  $('headersHelp').textContent = profile.hasHeaders && !duplicate ? '已保存自定义请求头。留空会保留，输入新内容会整体替换。' : '部分网关需要附加请求头。内容会与密钥一样加密保存，导出配置时不会包含。'
  chooseProvider(profile.provider, { keepUrl: true, silent: true })
  setStatus('empty', duplicate ? '已复制配置' : '已载入保存配置', duplicate ? `${profile.name} 的参数已填入，请输入新的 API Key 后保存。` : `${profile.name} 已准备好，可直接获取模型列表。`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function renderModelOptions() {
  const query = $('modelSearch').value.trim().toLowerCase()
  const models = query ? state.models.filter(model => model.toLowerCase().includes(query)) : state.models
  setSelectOptions($('modelSelect'), models, query ? `匹配到 ${models.length} 个模型` : '请选择模型')
  const disabled = !$('modelSelect').value
  $('probeModel').disabled = disabled; $('probeStream').disabled = disabled; $('copyModel').disabled = disabled
}

function renderProbeResult(result, stream = false) {
  $('resultCard').classList.remove('hidden')
  if (!result.ok) { setStatus('error', stream ? '流式测试失败' : '模型调用失败', errorMessage(result), errorMeta(result)); $('resultContent').innerHTML = `<div class="error-detail"><strong>${escapeHtml(result.diagnosis?.message || result.error)}</strong><pre>${escapeHtml(JSON.stringify(reportResult(result), null, 2))}</pre></div>`; return }
  if (stream) { const ttft = result.ttftMs === null ? '未检测到文本块' : `${result.ttftMs} ms`; setStatus('success', '流式响应可用', `首字延迟 ${ttft}，共收到 ${result.chunks} 个文本块。`, `HTTP ${result.status} | 总耗时 ${result.elapsedMs} ms | ${result.resolvedEndpoint}`); $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">首字延迟 TTFT</p><strong>${escapeHtml(ttft)}</strong></div><div><p class="label">完整响应耗时</p><strong>${result.elapsedMs} ms</strong></div></div><div class="response"><p class="label">流式响应内容</p><pre>${escapeHtml(result.content || '接口建立了流连接，但没有返回可识别的文本块。')}</pre></div><div class="usage"><span><b>接口类型</b>${escapeHtml(result.apiStyle)}</span><span><b>文本块</b>${result.chunks}</span></div>`; return }
  setStatus('success', '模型实际可用', `${result.model} 已成功返回响应。`, `HTTP ${result.status} | ${result.elapsedMs} ms | ${result.url}`)
  const usage = result.usage ? Object.entries(result.usage).filter(([, value]) => typeof value === 'number').map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('') : '<span>接口未返回 Token 用量</span>'
  $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">实际返回模型</p><code>${escapeHtml(result.model)}</code></div><div><p class="label">总耗时</p><strong>${result.elapsedMs} ms</strong></div></div><div class="response"><p class="label">响应内容</p><pre>${escapeHtml(result.content)}</pre></div><div class="usage">${usage}</div>`
}

function renderStreamAggregate(runs) {
  $('resultCard').classList.remove('hidden')
  const agg = streamAggregate(runs.map(run => ({ ttftMs: run.ttftMs, elapsedMs: run.elapsedMs, content: run.content, apiStyle: run.apiStyle, resolvedEndpoint: run.resolvedEndpoint })))
  if (!agg) return renderProbeResult(runs[runs.length - 1], true)
  setStatus('success', '流式响应可用', `平均首字延迟 ${agg.avgTtftMs === null ? '未检测到文本块' : `${agg.avgTtftMs} ms`}${agg.bestTtftMs !== null ? `（最快 ${agg.bestTtftMs} ms）` : ''}，吞吐约 ${agg.charsPerSecond} 字符/秒。`, `共 ${agg.runs} 次测试 | 平均总耗时 ${agg.avgElapsedMs} ms | ${agg.resolvedEndpoint}`)
  $('resultContent').innerHTML = `<div class="result-grid"><div><p class="label">平均 TTFT（${agg.runs} 次）</p><strong>${agg.avgTtftMs === null ? '—' : `${agg.avgTtftMs} ms`}</strong></div><div><p class="label">最快 TTFT</p><strong>${agg.bestTtftMs === null ? '—' : `${agg.bestTtftMs} ms`}</strong></div><div><p class="label">平均总耗时</p><strong>${agg.avgElapsedMs === null ? '—' : `${agg.avgElapsedMs} ms`}</strong></div><div><p class="label">吞吐速度</p><strong>${agg.charsPerSecond} 字符/秒</strong></div></div><div class="response"><p class="label">最近一次流式内容</p><pre>${escapeHtml(agg.content || '接口建立了流连接，但没有返回可识别的文本块。')}</pre></div><div class="usage"><span><b>测试次数</b>${agg.runs}</span><span><b>接口类型</b>${escapeHtml(agg.apiStyle || '—')}</span></div>`
}

document.querySelectorAll('.provider').forEach(button => button.addEventListener('click', () => { if (button.dataset.provider !== state.provider) chooseProvider(button.dataset.provider) }))
$('toggleKey').addEventListener('click', () => { const showing = $('apiKey').type === 'password'; $('apiKey').type = showing ? 'text' : 'password'; $('toggleKey').textContent = showing ? '隐藏' : '显示' })
$('newProfile').addEventListener('click', resetForm)

$('saveProfile').addEventListener('click', async () => {
  let config
  try { config = currentConfig() } catch (error) { return setStatus('error', '自定义请求头格式不正确', error.message || '请按“名称: 值”的格式逐行填写。') }
  if (!config.name) return setStatus('error', '缺少配置名称', '请给这项配置填写一个容易识别的名称。')
  if (!config.apiKey && !state.editingHasKey) return setStatus('error', '缺少 API Key', '新配置必须输入 API Key 才能安全保存。')
  const button = $('saveProfile'); button.disabled = true
  try { const saved = await window.llmApi.profiles.save(config); state.editingId = saved.id; state.editingHasKey = saved.hasKey; state.editingHasHeaders = saved.hasHeaders; $('apiKey').value = ''; $('customHeaders').value = ''; $('editBadge').textContent = '编辑'; $('keyHelp').textContent = '密钥已由操作系统加密。留空会保留原密钥。'; $('headersHelp').textContent = saved.hasHeaders ? '已保存自定义请求头。留空会保留，输入新内容会整体替换。' : '部分网关需要附加请求头。内容会与密钥一样加密保存，导出配置时不会包含。'; await loadProfiles(); setStatus('success', '配置已安全保存', `${saved.name} 已加入配置库。`) } catch (error) { setStatus('error', '保存失败', error.message || '无法安全保存该配置。') } finally { button.disabled = false }
})

$('fetchModels').addEventListener('click', async () => {
  const { baseUrl, apiKey, provider } = currentConfig(); if ((!apiKey && !(state.editingId && state.editingHasKey)) || (provider === 'openai' && !baseUrl)) return setStatus('error', '缺少必要配置', '请填写 API Key 和所需的 Base URL。')
  const button = $('fetchModels'); button.disabled = true; button.textContent = '正在获取…'; setStatus('loading', '正在验证接口', '正在请求当前密钥可访问的模型列表。')
  try { const result = await callApi('models'); state.listResult = result; if (!result.ok) return setStatus('error', '获取模型失败', errorMessage(result), errorMeta(result)); state.models = result.models; $('modelSearch').value = ''; renderModelOptions(); $('modelCount').textContent = `${result.models.length} 个模型`; $('modelsCard').classList.remove('hidden'); setStatus('success', '接口和密钥可用', `成功获取 ${result.models.length} 个可用模型。`, `HTTP ${result.status} | ${result.elapsedMs} ms | ${result.url}`); if (state.editingId) loadProfiles().catch(() => {}) } catch (error) { setStatus('error', '程序处理失败', error.message || '应用无法完成本次请求。') } finally { button.disabled = false; button.innerHTML = '获取模型列表 <span>→</span>' }
})

$('modelSearch').addEventListener('input', renderModelOptions)
$('modelSelect').addEventListener('change', () => { const disabled = !$('modelSelect').value; $('probeModel').disabled = disabled; $('probeStream').disabled = disabled; $('copyModel').disabled = disabled })
$('copyModel').addEventListener('click', async () => {
  const model = $('modelSelect').value; if (!model) return
  const button = $('copyModel')
  try { await navigator.clipboard.writeText(model) } catch { const area = document.createElement('textarea'); area.value = model; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove() }
  button.textContent = '已复制'; button.disabled = true
  setTimeout(() => { button.textContent = '复制'; button.disabled = !$('modelSelect').value }, 1200)
})
for (const id of ['baseUrl', 'apiKey']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (!$('fetchModels').disabled) $('fetchModels').click() } })

$('probeModel').addEventListener('click', async () => { const model = $('modelSelect').value; if (!model) return; const button = $('probeModel'); button.disabled = true; button.textContent = '正在验证…'; setStatus('loading', '正在调用模型', `正在向 ${model} 发送最小测试请求。`); try { const result = await callApi('chat', { model }); state.probeResult = result; renderProbeResult(result) } catch (error) { setStatus('error', '程序处理失败', error.message || '应用无法完成本次请求。') } finally { button.disabled = false; button.textContent = '普通调用测试' } })

$('probeStream').addEventListener('click', async () => {
  const model = $('modelSelect').value; if (!model) return
  const runs = Math.min(Math.max(Number($('streamRuns').value) || 1, 1), 5)
  const button = $('probeStream'); button.disabled = true; button.textContent = '正在测试…'
  setStatus('loading', '正在进行流式测试', `正在测量 ${model} 的首字延迟${runs > 1 ? `，共 ${runs} 次` : ''}。`)
  const results = []
  try {
    for (let i = 0; i < runs; i += 1) {
      const result = await callApi('stream', { model })
      if (!result.ok) { state.probeResult = result; renderProbeResult(result, true); return }
      results.push(result)
    }
    state.probeResult = results[results.length - 1]
    renderStreamAggregate(results)
  } catch (error) { setStatus('error', '程序处理失败', error.message || '应用无法完成本次流式测试。') } finally { button.disabled = false; button.textContent = '流式速度测试' }
})

$('exportReport').addEventListener('click', () => saveBlob(JSON.stringify(cleanForSingleReport(), null, 2), 'application/json', 'llm-api-report.json'))
