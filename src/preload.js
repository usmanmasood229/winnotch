'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  mouseEnter:  ()            => ipcRenderer.send('mouse-enter'),
  mouseLeave:  ()            => ipcRenderer.send('mouse-leave'),
  getStats:    ()            => ipcRenderer.invoke('get-stats'),
  getMedia:    ()            => ipcRenderer.invoke('get-media'),
  getArt:      (artKey,meta) => ipcRenderer.invoke('get-art', artKey, meta),
  mediaCmd:    (cmd)         => ipcRenderer.invoke('media-cmd', cmd),
  mediaPlay:   ()            => ipcRenderer.invoke('media-cmd', 'play'),
  mediaPause:  ()            => ipcRenderer.invoke('media-cmd', 'pause'),
  mediaNext:   ()            => ipcRenderer.invoke('media-cmd', 'next'),
  mediaPrev:   ()            => ipcRenderer.invoke('media-cmd', 'prev'),

  // Charging
  getCharging: ()            => ipcRenderer.invoke('get-charging'),
  onCharging:  (cb)          => {
    const handler = (_, isCharging) => cb(isCharging);
    ipcRenderer.on('charging-change', handler);
    return () => ipcRenderer.removeListener('charging-change', handler);
  },

  // Hinge angle, as 0..1 blur strength (used by lid-blur.html)
  onHingeProgress: (cb)      => {
    const handler = (_, p) => cb(p);
    ipcRenderer.on('hinge-progress', handler);
    return () => ipcRenderer.removeListener('hinge-progress', handler);
  },

  // Desktop snapshot to blur (data URL, or null to drop it)
  onHingeShot: (cb)          => {
    const handler = (_, dataUrl) => cb(dataUrl);
    ipcRenderer.on('hinge-shot', handler);
    return () => ipcRenderer.removeListener('hinge-shot', handler);
  },

  // true once the lid has stopped moving, false the moment it moves again
  onHingeSettled: (cb)       => {
    const handler = (_, isSettled) => cb(isSettled);
    ipcRenderer.on('hinge-settled', handler);
    return () => ipcRenderer.removeListener('hinge-settled', handler);
  },

  // the curtain has finished animating and is fully invisible — safe to hide
  hingeIdle: ()              => ipcRenderer.send('hinge-idle'),
});