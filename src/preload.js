const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadSettings: async () => {
    try {
      return await ipcRenderer.invoke('settings:load');
    } catch {
      return null;
    }
  },
  saveSettings: async (settings) => {
    try {
      return await ipcRenderer.invoke('settings:save', settings);
    } catch {
      return false;
    }
  }
  ,
  setSystemBrightness: async (level) => {
    try {
      return await ipcRenderer.invoke('brightness:set', level);
    } catch {
      return false;
    }
  }
  ,
  pickImage: async () => {
    try { return await ipcRenderer.invoke('pick:image'); } catch { return null; }
  }
  ,
  pickDepth: async () => {
    try { return await ipcRenderer.invoke('pick:depth'); } catch { return null; }
  }
  ,
  generateDepth: async (inputAbs) => {
    try { return await ipcRenderer.invoke('depth:generate', inputAbs); } catch { return null; }
  }
});
