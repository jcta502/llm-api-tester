const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('llmApi', {
  probe: (payload) => ipcRenderer.invoke('probe', payload),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    capabilities: () => ipcRenderer.invoke('profiles:capabilities'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id),
    probe: (payload) => ipcRenderer.invoke('profiles:probe', payload),
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
  localEndpoint: () => ipcRenderer.invoke('app:local-endpoint'),
  openInBrowser: () => ipcRenderer.invoke('app:open-in-browser'),
  isDesktop: true,
})
