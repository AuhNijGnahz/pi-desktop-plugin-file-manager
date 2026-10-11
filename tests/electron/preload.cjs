const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pluginBridge', {
  invoke: (channel, payload) => ipcRenderer.invoke('bridge', channel, payload),
  on: (event, handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('test:' + event, listener);
    return () => ipcRenderer.removeListener('test:' + event, listener);
  },
});
