// src/preload.js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  mouseEnter:  ()      => ipcRenderer.send('mouse-enter'),
  mouseLeave:  ()      => ipcRenderer.send('mouse-leave'),
  getStats:    ()      => ipcRenderer.invoke('get-stats'),
  getMedia:    ()      => ipcRenderer.invoke('get-media'),
  mediaPlay:   ()      => ipcRenderer.invoke('media-cmd', 'play'),
  mediaPause:  ()      => ipcRenderer.invoke('media-cmd', 'pause'),
  mediaNext:   ()      => ipcRenderer.invoke('media-cmd', 'next'),
  mediaPrev:   ()      => ipcRenderer.invoke('media-cmd', 'prev'),
});