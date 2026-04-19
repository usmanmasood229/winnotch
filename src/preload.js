'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// API for the notch overlay
contextBridge.exposeInMainWorld('api', {
  mouseEnter:  ()       => ipcRenderer.send('mouse-enter'),
  mouseLeave:  ()       => ipcRenderer.send('mouse-leave'),
  getStats:    ()       => ipcRenderer.invoke('get-stats'),
  getMedia:    ()       => ipcRenderer.invoke('get-media'),
  getArt:      (artKey, meta) => ipcRenderer.invoke('get-art', artKey, meta),
  mediaCmd:    (cmd)    => ipcRenderer.invoke('media-cmd', cmd),
  mediaPlay:   ()       => ipcRenderer.invoke('media-cmd', 'play'),
  mediaPause:  ()       => ipcRenderer.invoke('media-cmd', 'pause'),
  mediaNext:   ()       => ipcRenderer.invoke('media-cmd', 'next'),
  mediaPrev:   ()       => ipcRenderer.invoke('media-cmd', 'prev'),
});