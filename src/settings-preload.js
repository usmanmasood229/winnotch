'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  hide:        ()      => ipcRenderer.send('settings:hide'),
  quit:        ()      => ipcRenderer.send('settings:quit'),
  getSettings: ()      => ipcRenderer.invoke('settings:get'),
  setSetting:  (k, v)  => ipcRenderer.invoke('settings:set', k, v),
  setEnabled:  (on)    => ipcRenderer.invoke('settings:set', 'enabled', on),
  getStats:    ()      => ipcRenderer.invoke('get-stats'),
});
