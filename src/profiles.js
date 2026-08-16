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
  $('profileList').innerHTML = groupNames.map(group => `${group ? `<div class="profile-group-title">${escapeHtml(group)}</div>` : `<div class="profile-group-title">未分组</div>`}${groups.get(group).map(profile => `<article class="profile-item${state.editingId === profile.id ? ' active' : ''}" data-id="${escapeAttr(profile.id)}"><label class="profile-check"><input type="checkbox" data-action="select" ${state.selectedIds.has(profile.id) ? 'checked' : ''} aria-label="选择 ${escapeAttr(profile.name)}" /></label><div class="profile-provider">${escapeHtml(providerLabel(profile.provider))}</div><div class="profile-info"><strong>${escapeHtml(profile.name)}</strong><code>${escapeHtml(profile.baseUrl || providerInfo[profile.provider].defaultUrl)}</code>${healthBadge(profile)}</div><div class="profile-key ${profile.hasKey ? 'saved' : 'missing'}">${profile.hasKey ? '密钥已加密' : '缺少密钥'}</div><div class="profile-actions"><button class="text-button" data-action="edit" type="button">编辑</button><button class="text-button" data-action="duplicate" type="button">复制</button><button class="text-button danger-text" data-action="delete" type="button">删除</button></div></article>`).join('')}`).join('')
}

$('profileList').addEventListener('change', event => { const input = event.target.closest('[data-action="select"]'); if (!input) return; const id = input.closest('.profile-item').dataset.id; if (input.checked) state.selectedIds.add(id); else state.selectedIds.delete(id) })

$('profileList').addEventListener('click', async event => { const button = event.target.closest('button[data-action]'); if (!button) return; const id = button.closest('.profile-item').dataset.id; if (button.dataset.action === 'edit') return loadProfile(id); if (button.dataset.action === 'duplicate') return loadProfile(id, { duplicate: true }); if (button.dataset.action === 'delete') { const profile = state.profiles.find(item => item.id === id); if (!confirm(`删除“${profile?.name || '此配置'}”？保存的加密密钥也会一并删除。`)) return; try { await window.llmApi.profiles.remove(id); state.selectedIds.delete(id); if (state.editingId === id) resetForm(); await loadProfiles() } catch (error) { setStatus('error', '删除失败', error.message || '无法删除该配置。') } } })

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
