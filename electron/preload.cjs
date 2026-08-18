const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('llmApi', {
  probe: (payload) => ipcRenderer.invoke('probe', payload),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    history: () => ipcRenderer.invoke('profiles:history'),
    capabilities: () => ipcRenderer.invoke('profiles:capabilities'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id),
    probe: (payload) => ipcRenderer.invoke('profiles:probe', payload),
    reveal: (id) => ipcRenderer.invoke('profiles:reveal', id),
    compat: (id) => ipcRenderer.invoke('profiles:compat', id),
    run: (payload) => ipcRenderer.invoke('profiles:run', payload),
    cancel: (jobId) => ipcRenderer.invoke('profiles:cancel', jobId),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('profiles:progress', listener)
      return {
        subscribe: () => {},
        close: () => ipcRenderer.removeListener('profiles:progress', listener),
      }
    },
  },
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  getSettings: () => ipcRenderer.invoke('app:settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('app:settings:set', settings),
  checkUpdate: () => ipcRenderer.invoke('app:update-check'),
  openRelease: () => ipcRenderer.invoke('app:open-release'),
  backupExport: (passphrase) => ipcRenderer.invoke('backup:export', { passphrase }),
  backupImport: (blob, passphrase) => ipcRenderer.invoke('backup:import', { blob, passphrase }),
  localEndpoint: () => ipcRenderer.invoke('app:local-endpoint'),
  openInBrowser: () => ipcRenderer.invoke('app:open-in-browser'),
  isDesktop: true,
})
