'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  mouseEnter:  ()            => ipcRenderer.send('mouse-enter'),
  mouseLeave:  ()            => ipcRenderer.send('mouse-leave'),
  // Pointer position in the notch window's coordinates, or null
  cursorPoint: ()            => ipcRenderer.invoke('cursor-point'),
  getStats:    ()            => ipcRenderer.invoke('get-stats'),
  getMedia:    ()            => ipcRenderer.invoke('get-media'),
  getArt:      (artKey,meta) => ipcRenderer.invoke('get-art', artKey, meta),
  mediaCmd:    (cmd)         => ipcRenderer.invoke('media-cmd', cmd),
  mediaSeek:   (seconds)     => ipcRenderer.invoke('media-seek', seconds),
  openCast:    ()            => ipcRenderer.invoke('open-cast'),
  desktopShot: ()            => ipcRenderer.invoke('desktop-shot'),
  agentsNow:   ()            => ipcRenderer.invoke('agents-now'),
  // Put text into a VS Code chat's box: { ok } or { ok:false, reason }.
  sendToChat:  (sessionId, text) => ipcRenderer.invoke('session-prompt', { sessionId, text }),
  onAgents:    (fn)          => {
    const handler = (_e, snap) => fn(snap);
    ipcRenderer.on('agents', handler);
    return () => ipcRenderer.removeListener('agents', handler);
  },
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

  // Claude Code permission prompts. A prompt arrives as
  // { id, tool, input, project, cwd, sessionId }; answering it with one of
  // 'allow' | 'always' | 'deny' | 'ask' unblocks the session that's waiting.
  // answerPermission resolves false if the prompt already timed out.
  answerPermission: (id, decision) => ipcRenderer.invoke('permission-answer', { id, decision }),
  onPermission: (cb)         => {
    const handler = (_, req) => cb(req);
    ipcRenderer.on('permission', handler);
    return () => ipcRenderer.removeListener('permission', handler);
  },
  // The prompt with this id was settled elsewhere (timed out, cancelled), so its card goes.
  onPermissionGone: (cb)     => {
    const h = (_, id) => cb(id);
    ipcRenderer.on('permission-gone', h);
    return () => ipcRenderer.removeListener('permission-gone', h);
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