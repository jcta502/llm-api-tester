import { batchReport, batchReportCsv, reportResult, streamAggregate } from '../lib/report.mjs'

const $ = id => document.getElementById(id)

const localToken = (() => {
  try {
    const params = new URLSearchParams(location.search)
    const fromUrl = params.get('token')
    if (fromUrl) {
      localStorage.setItem('localToken', fromUrl)
      params.delete('token')
      const clean = `${location.pathname}${params.toString() ? `?${params}` : ''}`
      history.replaceState(null, '', clean)
      return fromUrl
    }
    return localStorage.getItem('localToken') || ''
  } catch { return '' }
})()

const browserApi = {
  async request(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) }
    if (localToken) headers['x-local-token'] = localToken
    const response = await fetch(path, { ...options, headers })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try { const data = await response.json(); message = data.error || message } catch { /* ignore */ }
      throw new Error(message)
    }
    return response.json()
  },
  profiles: {
    list: () => browserApi.request('/api/profiles').then(data => data.profiles),
    history: () => browserApi.request('/api/profiles/history').then(data => data.history),
    capabilities: () => browserApi.request('/api/profiles/capabilities'),
    save: (profile) => browserApi.request('/api/profiles/save', { method: 'POST', body: JSON.stringify(profile) }),
    remove: (id) => browserApi.request('/api/profiles/remove', { method: 'POST', body: JSON.stringify({ id }) }),
    probe: (payload) => browserApi.request('/api/profiles/probe', { method: 'POST', body: JSON.stringify(payload) }),
    run: (payload) => browserApi.request('/api/profiles/run', { method: 'POST', body: JSON.stringify(payload) }),
    cancel: (jobId) => browserApi.request('/api/profiles/cancel', { method: 'POST', body: JSON.stringify({ jobId }) }),
    onProgress: (callback) => {
      let currentJobId = null
      let eventSource = null
      const api = {
        subscribe(jobId) {
          if (eventSource) eventSource.close()
          currentJobId = jobId
          const url = new URL('/api/profiles/progress', location.origin)
          url.searchParams.set('jobId', jobId)
          if (localToken) url.searchParams.set('token', localToken)
          eventSource = new EventSource(url.toString())
          eventSource.onmessage = event => {
            try { const payload = JSON.parse(event.data); if (payload.jobId === currentJobId) callback(payload) } catch { /* ignore */ }
          }
        },
        close() { currentJobId = null; if (eventSource) { eventSource.close(); eventSource = null } },
      }
      return api
    },
  },
  probe: (payload) => browserApi.request('/api/probe', { method: 'POST', body: JSON.stringify(payload) }),
  setTheme: (theme) => browserApi.request('/api/app/set-theme', { method: 'POST', body: JSON.stringify({ theme }) }).then(data => data.theme),
  getSettings: () => browserApi.request('/api/app/settings'),
  setSettings: (settings) => browserApi.request('/api/app/settings', { method: 'POST', body: JSON.stringify(settings) }),
  checkUpdate: () => browserApi.request('/api/app/update'),
  openRelease: async () => { const r = await browserApi.checkUpdate(); if (r?.url) window.open(r.url, '_blank', 'noopener'); return Boolean(r?.url) },
  backupExport: (passphrase) => browserApi.request('/api/backup/export', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  backupImport: (blob, passphrase) => browserApi.request('/api/backup/import', { method: 'POST', body: JSON.stringify({ blob, passphrase }) }),
}

const providerInfo = {
  openai: { title: 'OpenAI 兼容接口', defaultUrl: '', placeholder: 'https://api.example.com/v1', help: '填写根地址或包含 /v1 的地址，工具会自动补全接口路径。', keyPlaceholder: 'sk-...' },
  anthropic: { title: 'Anthropic Messages 接口', defaultUrl: 'https://api.anthropic.com', placeholder: 'https://api.anthropic.com', help: '默认使用 Anthropic 官方地址，也支持兼容的自定义网关。', keyPlaceholder: 'sk-ant-...' },
  gemini: { title: 'Google Gemini 接口', defaultUrl: 'https://generativelanguage.googleapis.com', placeholder: 'https://generativelanguage.googleapis.com', help: '默认使用 Gemini 官方地址，也支持兼容的自定义网关。', keyPlaceholder: 'AIza...' },
}
const state = {
  provider: 'openai', models: [], listResult: null, probeResult: null, providerUrls: {},
  editingId: null, editingHasKey: false, editingHasHeaders: false, profiles: [], history: {}, selectedIds: new Set(),
  batchRows: [], batchJobId: null, batchTotal: 0, batchCompleted: 0, lastBatchDeep: false,
}
const statusPanel = $('statusPanel')
const isDesktop = Boolean(window.llmApi?.isDesktop)
if (!isDesktop) window.llmApi = browserApi

function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value ?? ''); return el.innerHTML }
function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;') }
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
function setStatus(kind, title, message, meta = '') { statusPanel.className = `status ${kind}`; statusPanel.innerHTML = `<div class="status-icon">${kind === 'loading' ? '…' : kind === 'success' ? '✓' : kind === 'error' ? '!' : '1'}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</div>` }
function errorMessage(result) { if (result?.diagnosis?.message) return result.diagnosis.message; const mapped = { 400: '请求配置不正确，请检查填写内容。', 401: 'API Key 无效或已经过期。', 403: '当前 API Key 没有访问权限。', 404: '没有找到接口，请检查 Base URL。', 429: '请求受到限流，或者账户额度不足。', 500: '上游服务发生错误。', 502: '无法连接上游服务。' }; return mapped[result?.status] || result?.error || '请求失败。' }
function errorMeta(result) { return [result?.diagnosis?.hint, result?.diagnosis?.upstream || result?.error, result?.url].filter(Boolean).join(' | ') }
function setSelectOptions(select, values, placeholder) { select.replaceChildren(new Option(placeholder, '')); for (const value of values) select.add(new Option(value, value)) }
function renderModelOptions() {
  const query = $('modelSearch').value.trim().toLowerCase()
  const models = query ? state.models.filter(model => model.toLowerCase().includes(query)) : state.models
  setSelectOptions($('modelSelect'), models, query ? `匹配到 ${models.length} 个模型` : '请选择模型')
  const disabled = !$('modelSelect').value
  $('probeModel').disabled = disabled; $('probeStream').disabled = disabled; $('copyModel').disabled = disabled
}
function providerLabel(provider) { return { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' }[provider] || provider }
function saveBlob(content, type, filename) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0) }
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

function chooseProvider(provider, options = {}) {
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

function resetForm() {
  state.editingId = null; state.editingHasKey = false; state.editingHasHeaders = false
  $('profileName').value = ''; $('profileGroup').value = ''; $('customHeaders').value = ''; $('headersHelp').textContent = '部分网关需要附加请求头。内容会与密钥一样加密保存，导出配置时不会包含。'
  $('apiKey').value = ''; $('timeout').value = '15000'; $('editBadge').textContent = '新建'; $('keyHelp').textContent = '新配置需要输入密钥；编辑配置时留空会保留原密钥。'
  chooseProvider('openai')
}

function loadProfile(id, { duplicate = false } = {}) {
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

async function loadProfiles() {
  try {
    const [profiles, history] = await Promise.all([
      window.llmApi.profiles.list(),
      window.llmApi.profiles.history?.().catch(() => ({})) || {},
    ])
    state.profiles = profiles
    state.history = history || {}
    const validIds = new Set(state.profiles.map(item => item.id))
    state.selectedIds = new Set([...state.selectedIds].filter(id => validIds.has(id)))
    renderProfiles()
  } catch (error) { setStatus('error', '读取配置失败', error.message || '无法读取本机配置库。') }
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function healthBadge(profile) {
  const records = (state.history[profile.id] || []).filter(item => item && item.at)
  if (!records.length) return ''
  const dots = records.slice(-10).map(record => `<span class="health-dot ${record.ok ? 'ok' : 'fail'}" title="${escapeAttr(`${timeAgo(record.at) || record.at} ${record.ok ? '可用' : '失败'}${record.modelCount ? ` · ${record.modelCount} 模型` : ''}`)}"></span>`).join('')
  const last = records[records.length - 1]
  const summary = `${timeAgo(last.at) || '最近'}：${last.ok ? `可用 · ${last.elapsedMs} ms` : `失败${last.errorCode ? ` · ${last.errorCode}` : ''}`}`
  return `<div class="profile-health"><span class="health-dots">${dots}</span><span>${escapeHtml(summary)}</span></div>`
}

function renderProfiles() {
  $('profileCount').textContent = `${state.profiles.length} 个配置`
  $('selectAllProfiles').disabled = !state.profiles.length
  $('exportProfiles').disabled = !state.profiles.length
  const groups = new Map()
  for (const profile of state.profiles) {
    const key = profile.group || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(profile)
  }
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  $('groupSuggestions').replaceChildren(...groupNames.filter(Boolean).map(name => new Option(name)))
  if (!state.profiles.length) { $('profileList').innerHTML = `<div class="empty-state">还没有保存配置。先在上方填写并点击“安全保存配置”。</div>`; return }
  $('profileList').innerHTML = groupNames.map(group => `${group ? `<div class="profile-group-title">${escapeHtml(group)}</div>` : `<div class="profile-group-title">未分组</div>`}${groups.get(group).map(profile => `<article class="profile-item${state.editingId === profile.id ? ' active' : ''}" data-id="${escapeAttr(profile.id)}"><label class="profile-check"><input type="checkbox" data-action="select" ${state.selectedIds.has(profile.id) ? 'checked' : ''} aria-label="选择 ${escapeAttr(profile.name)}" /></label><div class="profile-provider">${escapeHtml(providerLabel(profile.provider))}</div><div class="profile-info"><strong>${escapeHtml(profile.name)}</strong><code>${escapeHtml(profile.baseUrl || providerInfo[profile.provider].defaultUrl)}</code>${healthBadge(profile)}</div><div class="profile-key ${profile.hasKey ? 'saved' : 'missing'}">${profile.hasKey ? '密钥已加密' : '缺少密钥'}</div><div class="profile-actions"><button class="text-button" data-action="edit" type="button">编辑</button><button class="text-button" data-action="duplicate" type="button">复制</button><button class="text-button danger-text" data-action="delete" type="button">删除</button></div></article>`).join('')}`).join('')
}

function sortedBatchRows() {
  const rows = [...state.batchRows]; const sort = $('sortBatch').value
  if (sort === 'original') return rows.sort((a, b) => a.index - b.index)
  if (sort === 'status') return rows.sort((a, b) => Number(Boolean(b.result?.ok)) - Number(Boolean(a.result?.ok)) || a.index - b.index)
  if (sort === 'latency') return rows.sort((a, b) => (a.result?.elapsedMs ?? Infinity) - (b.result?.elapsedMs ?? Infinity) || a.index - b.index)
  if (sort === 'models') return rows.sort((a, b) => (b.result?.models?.length ?? -1) - (a.result?.models?.length ?? -1) || a.index - b.index)
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.index - b.index)
}

function renderBatch() {
  if (!state.batchRows.length) { $('batchResults').classList.add('hidden'); $('batchSummary').innerHTML = ''; updateRetryButton(); return }
  const deep = state.lastBatchDeep
  const rows = sortedBatchRows(); $('batchResults').classList.remove('hidden')
  const chatCell = row => {
    const chat = row.result?.chat
    if (chat) return `<td class="${chat.ok ? 'batch-ok' : 'batch-fail'}">${chat.ok ? `可用 · ${chat.elapsedMs} ms` : escapeHtml(chat.error || '调用失败')}</td>`
    return `<td>${row.state === 'pending' || row.state === 'running' ? '—' : row.result?.ok ? '未执行' : '—'}</td>`
  }
  $('batchResults').innerHTML = `<table><thead><tr><th>配置</th><th>服务商</th><th>状态</th>${deep ? '<th>真实调用</th>' : ''}<th>模型数</th><th>延迟</th><th>接口 / 原因</th></tr></thead><tbody>${rows.map(row => { const result = row.result; const stateLabel = row.state === 'pending' ? '等待中' : row.state === 'running' ? '检测中…' : result?.ok ? '可用' : result?.diagnosis?.code === 'cancelled' ? '已取消' : `失败${result?.status ? ` · ${result.status}` : ''}`; return `<tr><td><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.baseUrl || providerInfo[row.provider].defaultUrl)}</small></td><td>${escapeHtml(providerLabel(row.provider))}</td><td class="${result?.ok ? 'batch-ok' : row.state === 'pending' || row.state === 'running' ? 'batch-wait' : 'batch-fail'}">${escapeHtml(stateLabel)}</td>${deep ? chatCell(row) : ''}<td>${result?.ok ? result.models.length : '—'}</td><td>${Number.isFinite(result?.elapsedMs) ? `${result.elapsedMs} ms` : '—'}</td><td><code>${escapeHtml(result?.ok ? result.resolvedEndpoint || result.url : result ? errorMessage(result) : '等待开始')}</code></td></tr>` }).join('')}</tbody></table>`
  const finished = state.batchRows.filter(row => row.result); const passed = finished.filter(row => row.result.ok).length; const failed = finished.filter(row => !row.result.ok && row.result.diagnosis?.code !== 'cancelled').length
  const chatFailed = deep ? finished.filter(row => row.result.ok && row.result.chat && !row.result.chat.ok).length : 0
  $('batchSummary').innerHTML = `<span>${state.batchCompleted}/${state.batchTotal || state.batchRows.length} 已完成</span><span class="positive">${passed} 可用</span><span class="negative">${failed} 失败</span>${deep && chatFailed ? `<span class="negative">${chatFailed} 个仅列表可用</span>` : ''}`
  updateRetryButton()
}

function updateRetryButton() {
  const failedIds = state.batchRows.filter(row => row.result && !row.result.ok && row.result.diagnosis?.code !== 'cancelled').map(row => row.id)
  $('retryFailed').disabled = !failedIds.length || Boolean(state.batchJobId)
  $('retryFailed').textContent = failedIds.length ? `仅重试失败项（${failedIds.length}）` : '仅重试失败项'
}

function updateBatchProgress() { const ratio = state.batchTotal ? Math.min(state.batchCompleted / state.batchTotal, 1) : 0; $('batchProgress').value = ratio * 100 }

async function runBatch(targetIds) {
  const deep = $('deepCheck').checked
  const model = $('deepModel').value.trim()
  const ids = targetIds || [...state.selectedIds]
  if (!ids.length) { $('batchMessage').textContent = '请先从配置库中选择至少一个端点。'; return }
  state.batchJobId = crypto.randomUUID(); state.lastBatchDeep = deep; state.batchTotal = ids.length; state.batchCompleted = 0
  state.batchRows = ids.map((id, index) => { const profile = state.profiles.find(item => item.id === id); return { ...profile, index, state: 'pending', result: null } })
  $('runBatch').disabled = true; $('cancelBatch').classList.remove('hidden'); $('batchProgress').classList.remove('hidden'); $('batchMessage').textContent = deep ? `正在检测 ${ids.length} 个端点（含真实调用），并发上限为 3…` : `正在检测 ${ids.length} 个端点，并发上限为 3…`; $('exportBatchJson').disabled = true; $('exportBatchCsv').disabled = true
  renderBatch(); updateBatchProgress()
  const progressChannel = window.llmApi.profiles.onProgress(({ jobId, id, result }) => { if (jobId !== state.batchJobId) return; const row = state.batchRows.find(item => item.id === id); if (!row || row.result) return; row.result = result; row.state = result.ok ? 'success' : result.diagnosis?.code === 'cancelled' ? 'cancelled' : 'failed'; state.batchCompleted += 1; updateBatchProgress(); renderBatch() })
  try {
    progressChannel?.subscribe?.(state.batchJobId)
    const result = await window.llmApi.profiles.run({ jobId: state.batchJobId, ids, concurrency: 3, deep, model })
    result.results?.forEach((item, index) => {
      if (!item || state.batchRows[index]?.result) return
      state.batchRows[index].result = item
      state.batchRows[index].state = item.ok ? 'success' : item.diagnosis?.code === 'cancelled' ? 'cancelled' : 'failed'
      state.batchCompleted += 1
    })
    if (result.cancelled) {
      for (const row of state.batchRows.filter(item => !item.result)) { row.state = 'cancelled'; row.result = { ok: false, status: 0, diagnosis: { code: 'cancelled', message: '检测已取消' } } }
      state.batchCompleted = state.batchRows.length; $('batchMessage').textContent = `检测已取消，已完成 ${result.completed} 个请求。`
    } else {
      const usable = state.batchRows.filter(row => row.result?.ok).length
      const chatReady = deep ? state.batchRows.filter(row => row.result?.ok && row.result?.chat?.ok).length : 0
      $('batchMessage').textContent = deep ? `批量检测完成：${usable}/${ids.length} 个端点列表可用，其中 ${chatReady} 个真实调用成功。` : `批量检测完成：${usable}/${ids.length} 个端点可用。`
    }
  } catch (error) { $('batchMessage').textContent = error.message || '批量检测执行失败。' }
  finally { state.batchJobId = null; progressChannel?.close?.(); $('runBatch').disabled = false; $('cancelBatch').classList.add('hidden'); $('exportBatchJson').disabled = !state.batchRows.some(row => row.result); $('exportBatchCsv').disabled = !state.batchRows.some(row => row.result); updateBatchProgress(); renderBatch(); loadProfiles().catch(() => {}) }
}

$('runBatch').addEventListener('click', () => runBatch())
$('retryFailed').addEventListener('click', () => {
  const failedIds = state.batchRows.filter(row => row.result && !row.result.ok && row.result.diagnosis?.code !== 'cancelled').map(row => row.id)
  if (failedIds.length) runBatch(failedIds)
})

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
$('profileList').addEventListener('change', event => { const input = event.target.closest('[data-action="select"]'); if (!input) return; const id = input.closest('.profile-item').dataset.id; if (input.checked) state.selectedIds.add(id); else state.selectedIds.delete(id) })
$('profileList').addEventListener('click', async event => { const button = event.target.closest('button[data-action]'); if (!button) return; const id = button.closest('.profile-item').dataset.id; if (button.dataset.action === 'edit') return loadProfile(id); if (button.dataset.action === 'duplicate') return loadProfile(id, { duplicate: true }); if (button.dataset.action === 'delete') { const profile = state.profiles.find(item => item.id === id); if (!confirm(`删除“${profile?.name || '此配置'}”？保存的加密密钥也会一并删除。`)) return; try { await window.llmApi.profiles.remove(id); state.selectedIds.delete(id); if (state.editingId === id) resetForm(); await loadProfiles() } catch (error) { setStatus('error', '删除失败', error.message || '无法删除该配置。') } } })
$('selectAllProfiles').addEventListener('click', () => { const allSelected = state.profiles.length && state.profiles.every(item => state.selectedIds.has(item.id)); state.selectedIds = allSelected ? new Set() : new Set(state.profiles.map(item => item.id)); renderProfiles() })
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
$('cancelBatch').addEventListener('click', async () => { if (!state.batchJobId) return; $('cancelBatch').disabled = true; $('batchMessage').textContent = '正在取消尚未完成的检测…'; await window.llmApi.profiles.cancel(state.batchJobId); $('cancelBatch').disabled = false })
$('sortBatch').addEventListener('change', renderBatch)
$('exportBatchJson').addEventListener('click', () => saveBlob(JSON.stringify({ generatedAt: new Date().toISOString(), results: batchReport(sortedBatchRows()) }, null, 2), 'application/json', 'llm-api-batch-report.json'))
$('exportBatchCsv').addEventListener('click', () => saveBlob(batchReportCsv(sortedBatchRows()), 'text/csv;charset=utf-8', 'llm-api-batch-report.csv'))
$('exportProfiles').addEventListener('click', () => {
  const data = { format: 'llm-api-tester-profiles', version: 1, exportedAt: new Date().toISOString(), note: 'API 密钥与自定义请求头不会导出，导入后需重新填写。', profiles: state.profiles.map(({ name, provider, baseUrl, group, timeoutMs }) => ({ name, provider, baseUrl, group: group || '', timeoutMs })) }
  saveBlob(JSON.stringify(data, null, 2), 'application/json', 'llm-api-profiles.json')
})
$('importProfiles').addEventListener('click', () => $('importFile').click())
$('importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  let payload
  try { payload = JSON.parse(await file.text()) } catch { return setStatus('error', '导入失败', '文件不是有效的 JSON。') }
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.profiles) ? payload.profiles : null
  if (!items) return setStatus('error', '导入失败', '文件里没有找到配置列表。')
  let imported = 0; const errors = []
  for (const item of items.slice(0, 100)) {
    try { await window.llmApi.profiles.save({ name: item?.name, provider: item?.provider, baseUrl: item?.baseUrl, group: item?.group, timeoutMs: item?.timeoutMs }); imported += 1 }
    catch (error) { errors.push(`${item?.name || '未命名'}：${error.message || '无法导入'}`) }
  }
  await loadProfiles()
  setStatus(imported ? 'success' : 'error', `导入完成：${imported}/${items.length} 个配置`, imported ? '密钥和请求头不随导入迁移，请逐个补充后保存。' : '', errors.slice(0, 3).join(' | '))
})
$('saveProxy').addEventListener('click', async () => {
  const button = $('saveProxy'); button.disabled = true
  try { const saved = await window.llmApi.setSettings({ proxyUrl: $('proxyUrl').value.trim() }); $('proxyUrl').value = saved.proxyUrl || ''; setStatus('success', '代理设置已保存', saved.proxyUrl ? `后续检测请求将通过 ${saved.proxyUrl} 发送。` : '已恢复直连。') } catch (error) { setStatus('error', '代理设置无效', error.message || '请检查代理地址格式。') } finally { button.disabled = false }
})
$('saveSchedule').addEventListener('click', async () => {
  const button = $('saveSchedule'); button.disabled = true
  try {
    const saved = await window.llmApi.setSettings({ scheduleEnabled: $('scheduleEnabled').checked, scheduleMinutes: Number($('scheduleMinutes').value) })
    $('scheduleEnabled').checked = Boolean(saved.scheduleEnabled)
    $('scheduleMinutes').value = String(saved.scheduleMinutes)
    setStatus('success', '定时设置已保存', saved.scheduleEnabled ? `每 ${saved.scheduleMinutes} 分钟自动检测一次，状态变化时会通知。` : '已关闭定时检测。')
  } catch (error) { setStatus('error', '定时设置无效', error.message || '请检查间隔设置。') } finally { button.disabled = false }
})
$('backupExportBtn').addEventListener('click', async () => {
  const passphrase = $('backupPassphrase').value
  if (!passphrase || passphrase.length < 6) return setStatus('error', '备份口令太短', '请输入至少 6 位的备份口令。')
  const button = $('backupExportBtn'); button.disabled = true
  try {
    const blob = await window.llmApi.backupExport(passphrase)
    saveBlob(JSON.stringify(blob, null, 2), 'application/json', 'llm-api-backup.json')
    $('backupPassphrase').value = ''
    setStatus('success', '加密备份已导出', '文件包含全部配置、密钥与请求头，请妥善保管备份口令。')
  } catch (error) { setStatus('error', '备份失败', error.message || '无法完成备份。') } finally { button.disabled = false }
})
$('backupImportBtn').addEventListener('click', () => $('backupFile').click())
$('backupFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  const passphrase = $('backupPassphrase').value
  if (!passphrase) return setStatus('error', '缺少备份口令', '请先在上方输入导出备份时使用的口令。')
  try {
    const blob = JSON.parse(await file.text())
    const restored = await window.llmApi.backupImport(blob, passphrase)
    $('backupPassphrase').value = ''
    await loadProfiles()
    setStatus(restored.imported ? 'success' : 'error', `恢复完成：${restored.imported}/${restored.total} 个配置`, '已恢复的配置保留原有密钥与请求头，可直接检测。', restored.errors?.join(' | '))
  } catch (error) { setStatus('error', '恢复备份失败', error.message || '无法读取备份文件。') }
})
$('themeSelect').addEventListener('change', async () => { const theme = $('themeSelect').value; localStorage.setItem('theme', theme); document.documentElement.dataset.theme = theme; await window.llmApi?.setTheme?.(theme) })

const savedTheme = localStorage.getItem('theme') || 'system'; $('themeSelect').value = savedTheme; document.documentElement.dataset.theme = savedTheme; window.llmApi?.setTheme?.(savedTheme)
window.llmApi.profiles.capabilities().then(capability => {
  if (!capability.storeEnabled) { $('saveProfile').disabled = true; $('securityText').textContent = '当前为纯浏览器开发模式，不提供配置库；启动桌面应用后即可保存并共享加密配置。' }
  else if (!capability.secureStorage) { $('saveProfile').disabled = true; $('securityText').textContent = '系统安全存储当前不可用，因此已禁用密钥保存。' }
  else $('importProfiles').disabled = false
}).catch(() => { $('saveProfile').disabled = true; $('securityText').textContent = '无法连接本地服务；请确认桌面应用正在运行。' })
window.llmApi.getSettings?.().then(settings => {
  $('proxyUrl').value = settings?.proxyUrl || ''
  $('scheduleEnabled').checked = Boolean(settings?.scheduleEnabled)
  $('scheduleMinutes').value = String(settings?.scheduleMinutes || 30)
}).catch(() => {})
window.llmApi.checkUpdate?.().then(info => {
  if (!info?.hasUpdate) return
  const badge = $('updateBadge')
  badge.textContent = `新版本 v${info.latest}`
  badge.title = `当前 v${info.current}，点击查看发布页`
  badge.classList.remove('hidden')
  badge.addEventListener('click', () => window.llmApi.openRelease?.())
}).catch(() => {})
if (isDesktop) {
  window.llmApi.localEndpoint?.().then(endpoint => {
    if (!endpoint?.url) return
    const button = $('openInBrowser')
    button.classList.remove('hidden')
    button.title = `本地地址 http://127.0.0.1:${endpoint.port}（首次请从这里打开以获取访问令牌）`
    button.addEventListener('click', () => window.llmApi.openInBrowser())
  }).catch(() => { /* endpoint unavailable */ })
} else if (!localToken) {
  setStatus('error', '缺少访问令牌', '请从桌面应用的“在浏览器中打开”入口进入一次，之后即可直接使用收藏栏地址。')
}
loadProfiles()
