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

  // Raw hinge angle in degrees, every sensor sample during a gesture (lid-blur.html)
  onHingeAngle: (cb)         => {
    const handler = (_, deg) => cb(deg);
    ipcRenderer.on('hinge-angle', handler);
    return () => ipcRenderer.removeListener('hinge-angle', handler);
  },

  // Start of a gesture: { dataUrl, anchor, angle } — desktop snapshot, the angle
  // the lid rested at, and the latest angle
  onHingeShot: (cb)          => {
    const handler = (_, shot) => cb(shot);
    ipcRenderer.on('hinge-shot', handler);
    return () => ipcRenderer.removeListener('hinge-shot', handler);
  },

  // the blur has fully eased away and the canvas is clear — safe to hide
  hingeIdle: ()              => ipcRenderer.send('hinge-idle'),
});