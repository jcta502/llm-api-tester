const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('llmApi', { probe: (payload) => ipcRenderer.invoke('probe', payload), isDesktop: true })
