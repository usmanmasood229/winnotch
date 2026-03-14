// src/preload.js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// API for the notch overlay (index.html)
contextBridge.exposeInMainWorld('api', {
  mouseEnter:  ()    => ipcRenderer.send('mouse-enter'),
  mouseLeave:  ()    => ipcRenderer.send('mouse-leave'),
  getStats:    ()    => ipcRenderer.invoke('get-stats'),
  getMedia:    ()    => ipcRenderer.invoke('get-media'),
  mediaPlay:   ()    => ipcRenderer.invoke('media-cmd', 'play'),
  mediaPause:  ()    => ipcRenderer.invoke('media-cmd', 'pause'),
  mediaNext:   ()    => ipcRenderer.invoke('media-cmd', 'next'),
  mediaPrev:   ()    => ipcRenderer.invoke('media-cmd', 'prev'),
});

// API for the settings window (settings.html)
contextBridge.exposeInMainWorld('settingsApi', {
  hide:        ()      => ipcRenderer.send('settings-hide'),
  quit:        ()      => ipcRenderer.send('app-quit'),
  setEnabled:  (on)    => ipcRenderer.send('notch-set-enabled', on),
  setSetting:  (k, v)  => ipcRenderer.send('setting-set', k, v),
  getSettings: ()      => ipcRenderer.invoke('settings-get'),
  getStats:    ()      => ipcRenderer.invoke('get-stats'),
});