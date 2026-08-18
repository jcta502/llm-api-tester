import { $, escapeHtml, escapeAttr, setStatus, saveBlob, providerLabel } from './dom.js'
import { providerInfo, state } from './state.js'
import { loadProfile, resetForm } from './form.js'

export async function loadProfiles() {
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

function renderDetail(profile) {
  const detail = state.detail[profile.id]
  if (!detail?.open) return ''
  const parts = ['<div class="profile-detail open">']
  if (detail.type === 'key') {
    if (detail.loading) {
      parts.push('<p class="detail-status">正在解密本机存储的密钥…</p>')
    } else if (detail.error) {
      parts.push(`<p class="detail-status error">读取失败：${escapeHtml(detail.error)}</p>`)
    } else {
      const key = detail.data?.apiKey || ''
      parts.push('<div class="detail-row">')
      parts.push(`<span class="detail-label">API Key</span><code class="detail-value${key ? '' : ' empty'}">${key ? escapeHtml(key) : '未保存密钥'}</code>`)
      if (key) parts.push('<button class="text-button" data-action="copy-key" type="button">复制</button>')
      parts.push('</div>')
      const headers = detail.data?.headers || {}
      const names = Object.keys(headers)
      parts.push('<div class="detail-row">')
      parts.push('<span class="detail-label">自定义请求头</span>')
      if (names.length) {
        parts.push('<dl class="header-list">')
        for (const name of names) parts.push(`<div class="header-item"><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(headers[name])}</dd></div>`)
        parts.push('</dl>')
      } else parts.push('<span class="detail-empty">无</span>')
      parts.push('</div>')
      parts.push('<p class="detail-note">密钥与请求头仅在本机解密显示，不会写入导出文件。</p>')
    }
  } else if (detail.type === 'models') {
    if (detail.loading) {
      parts.push('<p class="detail-status">正在用已保存的密钥请求模型列表…</p>')
    } else if (detail.error) {
      parts.push(`<p class="detail-status error">获取失败：${escapeHtml(detail.error)}</p>`)
    } else {
      const models = detail.data?.models || []
      parts.push(`<div class="detail-row"><span class="detail-label">可用模型 · ${models.length}</span>${models.length ? '<button class="text-button" data-action="copy-models" type="button">复制全部</button>' : ''}</div>`)
      if (models.length) {
        parts.push('<ul class="model-list">')
        for (const model of models) parts.push(`<li><code>${escapeHtml(model)}</code></li>`)
        parts.push('</ul>')
      } else parts.push('<p class="detail-empty">接口未返回任何模型。</p>')
    }
  } else if (detail.type === 'compat') {
    if (detail.loading) {
      parts.push('<p class="detail-status">正在运行兼容性检测（模型列表 / 非流式对话 / 流式）…</p>')
    } else if (detail.error) {
      parts.push(`<p class="detail-status error">检测失败：${escapeHtml(detail.error)}</p>`)
    } else {
      const data = detail.data
      if (!data) {
        parts.push('<p class="detail-empty">无结果。</p>')
      } else if (!data.ok && data.error && !data.models) {
        parts.push(`<p class="detail-status error">${escapeHtml(data.error)}</p>`)
      } else {
        const agent = data.agent || {}
        parts.push('<div class="compat-card">')
        parts.push(`<div class="detail-row"><span class="detail-label">智能体 Base URL</span><code class="detail-value">${escapeHtml(agent.baseUrl || '—')}</code><button class="text-button" data-action="copy-compat" type="button">复制配置</button></div>`)
        parts.push(`<div class="detail-row"><span class="detail-label">模型名</span><code class="detail-value">${escapeHtml(agent.model || '—')}</code></div>`)
        parts.push(`<div class="detail-row"><span class="detail-label">鉴权头</span><code class="detail-value">${escapeHtml(agent.authHeader || '—')}</code></div>`)
        parts.push(`<div class="detail-row"><span class="detail-label">流式</span>${verdictTag(agent.streamSupported)}</div>`)
        parts.push(`<div class="detail-row"><span class="detail-label">响应规范</span>${verdictTag(agent.schemaOk)}</div>`)
        parts.push('</div>')
        const models = data.models || {}
        const chat = data.chat
        const stream = data.stream
        parts.push('<ul class="compat-checks">')
        parts.push(`<li>${verdictTag(models.ok)}<span class="check-name">模型列表${models.ok ? ` · ${models.count} 个` : ''}</span>${models.error ? `<em class="check-err">${escapeHtml(models.error)}</em>` : ''}</li>`)
        if (chat) parts.push(`<li>${verdictTag(chat.ok)}<span class="check-name">非流式对话${chat.ok ? ` · ${chat.elapsedMs} ms${chat.schemaOk === false ? ' · schema 不合规' : ''}` : ''}</span>${chat.error ? `<em class="check-err">${escapeHtml(chat.error)}</em>` : ''}${chat.schemaIssue ? `<em class="check-err">${escapeHtml(chat.schemaIssue)}</em>` : ''}</li>`)
        else parts.push(`<li>${verdictTag(null)}<span class="check-name">非流式对话</span></li>`)
        if (stream) parts.push(`<li>${verdictTag(stream.ok)}<span class="check-name">流式对话${stream.ttftMs != null ? ` · 首字 ${stream.ttftMs} ms · ${stream.chunks} 块` : ''}</span>${stream.error ? `<em class="check-err">${escapeHtml(stream.error)}</em>` : ''}${stream.issue ? `<em class="check-err">${escapeHtml(stream.issue)}</em>` : ''}</li>`)
        else parts.push(`<li>${verdictTag(null)}<span class="check-name">流式对话</span></li>`)
        parts.push('</ul>')
        const chatRaw = chat?.raw
        const streamRaw = stream?.raw
        if (chatRaw || streamRaw) {
          parts.push('<div class="raw-block">')
          if (chatRaw) parts.push(`<details class="raw-details"><summary>上游原始返回 · 非流式</summary><pre class="raw-body">${escapeHtml(chatRaw)}</pre></details>`)
          if (streamRaw) parts.push(`<details class="raw-details"><summary>上游原始返回 · 流式</summary><pre class="raw-body">${escapeHtml(streamRaw)}</pre></details>`)
          parts.push('</div>')
        }
      }
    }
  }
  parts.push('</div>')
  return parts.join('')
}

async function toggleDetail(id, type) {
  const current = state.detail[id]
  if (current?.open && current.type === type) { delete state.detail[id]; return renderProfiles() }
  state.detail[id] = { type, open: true, loading: true }
  renderProfiles()
  try {
    if (type === 'key') {
      const data = await window.llmApi.profiles.reveal(id)
      state.detail[id] = { type, open: true, loading: false, data }
    } else if (type === 'models') {
      const result = await window.llmApi.profiles.probe({ id, action: 'models' })
      if (!result.ok) throw new Error(result.diagnosis?.message || result.error || '接口返回失败')
      state.detail[id] = { type, open: true, loading: false, data: { models: result.models || [] } }
    } else if (type === 'compat') {
      const data = await window.llmApi.profiles.compat(id)
      state.detail[id] = { type, open: true, loading: false, data }
    }
  } catch (error) {
    state.detail[id] = { type, open: true, loading: false, error: error.message || '请求失败' }
  }
  renderProfiles()
}

function copyDetailText(id, what) {
  const detail = state.detail[id]
  let text = ''
  if (what === 'key') text = detail?.data?.apiKey || ''
  else if (what === 'models') text = (detail?.data?.models || []).join('\n')
  if (!text) return
  navigator.clipboard?.writeText(text).then(
    () => setStatus('success', '已复制', what === 'key' ? 'API 密钥已复制到剪贴板。' : `${(detail.data.models || []).length} 个模型已复制到剪贴板。`),
    () => setStatus('error', '复制失败', '浏览器拒绝了剪贴板写入。'),
  )
}

function copyCompat(id) {
  const agent = state.detail[id]?.data?.agent
  if (!agent) return
  const label = v => v === true ? '支持' : v === false ? '不支持' : '未知'
  const lines = [
    `Base URL: ${agent.baseUrl || ''}`,
    `模型: ${agent.model || ''}`,
    `鉴权: ${agent.authHeader || ''}`,
    `流式: ${label(agent.streamSupported)}`,
    `响应规范: ${label(agent.schemaOk)}`,
  ]
  navigator.clipboard?.writeText(lines.join('\n')).then(
    () => setStatus('success', '已复制', '智能体配置已复制到剪贴板，可直接填入智能体的模型设置。'),
    () => setStatus('error', '复制失败', '浏览器拒绝了剪贴板写入。'),
  )
}

function verdictTag(ok) {
  if (ok === true) return '<span class="verdict ok">支持</span>'
  if (ok === false) return '<span class="verdict no">不支持</span>'
  return '<span class="verdict na">未测</span>'
}

export function renderProfiles() {
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
  const suggestions = groupNames.filter(Boolean).map(name => {
    const option = document.createElement('option')
    option.value = name
    return option
  })
  $('groupSuggestions').replaceChildren(...suggestions)
  if (!state.profiles.length) { $('profileList').innerHTML = `<div class="empty-state">还没有保存配置。先在上方填写并点击“安全保存配置”。</div>`; return }
  $('profileList').innerHTML = groupNames.map(group => `${group ? `<div class="profile-group-title">${escapeHtml(group)}</div>` : `<div class="profile-group-title">未分组</div>`}${groups.get(group).map(profile => `<article class="profile-item${state.editingId === profile.id ? ' active' : ''}" data-id="${escapeAttr(profile.id)}"><label class="profile-check"><input type="checkbox" data-action="select" ${state.selectedIds.has(profile.id) ? 'checked' : ''} aria-label="选择 ${escapeAttr(profile.name)}" /></label><div class="profile-provider">${escapeHtml(providerLabel(profile.provider))}</div><div class="profile-info"><strong>${escapeHtml(profile.name)}</strong><code>${escapeHtml(profile.baseUrl || providerInfo[profile.provider].defaultUrl)}</code>${healthBadge(profile)}</div><div class="profile-key ${profile.hasKey ? 'saved' : 'missing'}">${profile.hasKey ? '密钥已加密' : '缺少密钥'}</div><div class="profile-actions"><button class="text-button${state.detail[profile.id]?.type === 'key' ? ' active' : ''}" data-action="reveal-key" type="button">密钥</button><button class="text-button${state.detail[profile.id]?.type === 'models' ? ' active' : ''}" data-action="models" type="button">模型</button><button class="text-button${state.detail[profile.id]?.type === 'compat' ? ' active' : ''}" data-action="compat" type="button">兼容</button><button class="text-button" data-action="edit" type="button">编辑</button><button class="text-button" data-action="duplicate" type="button">复制</button><button class="text-button danger-text" data-action="delete" type="button">删除</button></div>${renderDetail(profile)}</article>`).join('')}`).join('')
}

$('profileList').addEventListener('change', event => { const input = event.target.closest('[data-action="select"]'); if (!input) return; const id = input.closest('.profile-item').dataset.id; if (input.checked) state.selectedIds.add(id); else state.selectedIds.delete(id) })

$('profileList').addEventListener('click', async event => { const button = event.target.closest('button[data-action]'); if (!button) return; const id = button.closest('.profile-item').dataset.id; const action = button.dataset.action; if (action === 'edit') { delete state.detail[id]; return loadProfile(id); } if (action === 'duplicate') return loadProfile(id, { duplicate: true }); if (action === 'reveal-key' || action === 'models' || action === 'compat') { const type = action === 'reveal-key' ? 'key' : action === 'models' ? 'models' : 'compat'; return toggleDetail(id, type); } if (action === 'copy-key') return copyDetailText(id, 'key'); if (action === 'copy-models') return copyDetailText(id, 'models'); if (action === 'copy-compat') return copyCompat(id); if (action === 'delete') { const profile = state.profiles.find(item => item.id === id); if (!confirm(`删除“${profile?.name || '此配置'}”？保存的加密密钥也会一并删除。`)) return; try { await window.llmApi.profiles.remove(id); state.selectedIds.delete(id); delete state.detail[id]; if (state.editingId === id) resetForm(); await loadProfiles() } catch (error) { setStatus('error', '删除失败', error.message || '无法删除该配置。') } } })

$('selectAllProfiles').addEventListener('click', () => { const allSelected = state.profiles.length && state.profiles.every(item => state.selectedIds.has(item.id)); state.selectedIds = allSelected ? new Set() : new Set(state.profiles.map(item => item.id)); renderProfiles() })

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
