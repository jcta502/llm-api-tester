export const $ = id => document.getElementById(id)

export function escapeHtml(value) { const el = document.createElement('div'); el.textContent = String(value ?? ''); return el.innerHTML }
export function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;') }

export function setStatus(kind, title, message, meta = '') {
  const statusPanel = $('statusPanel')
  statusPanel.className = `status ${kind}`
  statusPanel.innerHTML = `<div class="status-icon">${kind === 'loading' ? '…' : kind === 'success' ? '✓' : kind === 'error' ? '!' : '1'}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</div>`
}

export function saveBlob(content, type, filename) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function errorMessage(result) {
  if (result?.diagnosis?.message) return result.diagnosis.message
  const mapped = { 400: '请求配置不正确，请检查填写内容。', 401: 'API Key 无效或已经过期。', 403: '当前 API Key 没有访问权限。', 404: '没有找到接口，请检查 Base URL。', 429: '请求受到限流，或者账户额度不足。', 500: '上游服务发生错误。', 502: '无法连接上游服务。' }
  return mapped[result?.status] || result?.error || '请求失败。'
}

export function errorMeta(result) { return [result?.diagnosis?.hint, result?.diagnosis?.upstream || result?.error, result?.url].filter(Boolean).join(' | ') }

export function providerLabel(provider) { return { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' }[provider] || provider }

export function setSelectOptions(select, values, placeholder) {
  select.replaceChildren()
  select.add(makeOption('', placeholder))
  for (const value of values) select.add(makeOption(value, value))
}

function makeOption(value, text) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = text
  return option
}
