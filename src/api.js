// 浏览器端的本地 API 客户端；桌面模式下 window.llmApi 已由 preload 注入。
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

export const browserApi = {
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

export const isDesktop = Boolean(window.llmApi?.isDesktop)
if (!isDesktop) window.llmApi = browserApi
