// src/main.js
'use strict';

const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage
} = require('electron');
const path  = require('path');
const os    = require('os');
const { exec } = require('child_process');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win, tray;
const NOTCH_H = 160;

function getPrimary() { return screen.getPrimaryDisplay(); }

function createWindow() {
  const { bounds } = getPrimary();
  win = new BrowserWindow({
    width: bounds.width, height: NOTCH_H,
    x: bounds.x, y: bounds.y,
    frame: false, transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false,
    movable: false, minimizable: false,
    maximizable: false, closable: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('blur',  () => win.setAlwaysOnTop(true, 'screen-saver', 1));
  win.on('focus', () => win.setAlwaysOnTop(true, 'screen-saver', 1));
  screen.on('display-metrics-changed', refit);
  screen.on('display-added',           refit);
  screen.on('display-removed',         refit);
  setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver', 1);
  }, 2000);
}

function refit() {
  if (!win || win.isDestroyed()) return;
  const { bounds } = getPrimary();
  win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: NOTCH_H }, false);
}

ipcMain.on('mouse-enter', () => win?.setIgnoreMouseEvents(false));
ipcMain.on('mouse-leave', () => win?.setIgnoreMouseEvents(true, { forward: true }));

// ── CPU + RAM ─────────────────────────────────────────────────────────────────
function cpuSample() {
  let idle = 0, total = 0;
  const cpus = os.cpus();
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle: idle / cpus.length, total: total / cpus.length };
}

ipcMain.handle('get-stats', async () => {
  const a = cpuSample();
  await new Promise(r => setTimeout(r, 300));
  const b = cpuSample();
  const cpu = Math.max(0, Math.min(100,
    Math.round(100 - (100 * (b.idle - a.idle)) / (b.total - a.total))
  ));
  const total = os.totalmem(), used = total - os.freemem();
  return { cpu, ram: Math.round((used / total) * 100) };
});

// ── Media read ────────────────────────────────────────────────────────────────
//
// THE FIX: Two-pass session selection:
//   Pass 1 — find any session with status=Playing → use it immediately
//   Pass 2 — if nothing is Playing, fall back to Paused
//
// This means Spotify Playing ALWAYS beats a browser tab that is Paused,
// regardless of source app name. No source-name bias at all.
//
const PS_GET_MEDIA = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $m=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1})[0]
  function WA($t,$r){$x=$m.MakeGenericMethod($r).Invoke($null,@($t));$x.Wait(-1)|Out-Null;$x.Result}
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $mgr=WA ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions=$mgr.GetSessions()
  if($sessions.Count -eq 0){Write-Output '{}';exit}

  $Playing=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
  $Paused=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused

  # Pass 1: find a session that is actively Playing
  $best=$null
  foreach($s in $sessions){
    try{
      $pb=$s.GetPlaybackInfo()
      if($pb.PlaybackStatus -eq $Playing){
        $best=$s
        break
      }
    }catch{}
  }

  # Pass 2: nothing Playing — take first Paused session
  if($best -eq $null){
    foreach($s in $sessions){
      try{
        $pb=$s.GetPlaybackInfo()
        if($pb.PlaybackStatus -eq $Paused){
          $best=$s
          break
        }
      }catch{}
    }
  }

  if($best -eq $null){Write-Output '{}';exit}

  $props=WA ($best.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl=$best.GetTimelineProperties()
  $pb2=$best.GetPlaybackInfo()
  $isPlaying=($pb2.PlaybackStatus -eq $Playing)
  $pos=[math]::Floor($tl.Position.TotalSeconds)
  $dur=[math]::Floor($tl.EndTime.TotalSeconds)
  $art=''
  if($props.Thumbnail -ne $null){
    try{
      [void][Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
      [void][Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
      $stream=WA ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStream])
      $sz=[uint32]$stream.Size
      if($sz -gt 0 -and $sz -lt 2097152){
        $dr=[Windows.Storage.Streams.DataReader]::CreateDataReader($stream)
        WA ($dr.LoadAsync($sz)) ([uint32])|Out-Null
        $buf=New-Object byte[] $sz;$dr.ReadBytes($buf)
        $art=[Convert]::ToBase64String($buf);$dr.Dispose()
      }
      $stream.Dispose()
    }catch{$art=''}
  }
  $r=[ordered]@{
    title=[string]$props.Title
    artist=[string]$props.Artist
    album=[string]$props.AlbumTitle
    playing=$isPlaying
    pos=$pos
    dur=$dur
    src=[string]$best.SourceAppUserModelId
    art=$art
  }
  Write-Output ($r|ConvertTo-Json -Compress -Depth 1)
}catch{Write-Output '{}'}
`.trim();

// ── Media control ─────────────────────────────────────────────────────────────
// Same two-pass logic for controls — targets the Playing session first
function buildControlScript(cmd) {
  let action = '';
  switch (cmd) {
    case 'play':  action = `WA ($best.TryPlayAsync()) ([bool])|Out-Null`; break;
    case 'pause': action = `WA ($best.TryPauseAsync()) ([bool])|Out-Null`; break;
    case 'next':  action = `WA ($best.TrySkipNextAsync()) ([bool])|Out-Null`; break;
    case 'prev':  action = `WA ($best.TrySkipPreviousAsync()) ([bool])|Out-Null`; break;
    default:      action = `WA ($best.TryTogglePlayPauseAsync()) ([bool])|Out-Null`;
  }
  return `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $m=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1})[0]
  function WA($t,$r){$x=$m.MakeGenericMethod($r).Invoke($null,@($t));$x.Wait(-1)|Out-Null;$x.Result}
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $mgr=WA ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions=$mgr.GetSessions()
  if($sessions.Count -eq 0){exit}
  $Playing=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
  $Paused=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused
  $best=$null
  foreach($s in $sessions){
    try{ $pb=$s.GetPlaybackInfo(); if($pb.PlaybackStatus -eq $Playing){$best=$s;break} }catch{}
  }
  if($best -eq $null){
    foreach($s in $sessions){
      try{ $pb=$s.GetPlaybackInfo(); if($pb.PlaybackStatus -eq $Paused){$best=$s;break} }catch{}
    }
  }
  if($best -eq $null){exit}
  ${action}
}catch{}
`.trim();
}

function encodeCmd(script) {
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

const PS_GET_CMD = encodeCmd(PS_GET_MEDIA);
const _ctrlCache = {};
function getCtrlCmd(cmd) {
  if (!_ctrlCache[cmd]) _ctrlCache[cmd] = encodeCmd(buildControlScript(cmd));
  return _ctrlCache[cmd];
}

ipcMain.handle('get-media', () => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve(null);
  exec(PS_GET_CMD, {
    timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
  }, (err, stdout) => {
    const raw = (stdout || '').trim();
    if (!raw || raw === '{}') return resolve(null);
    try {
      const d = JSON.parse(raw);
      if (!d || !d.title) return resolve(null);
      resolve({
        title:   String(d.title  || '').trim(),
        artist:  String(d.artist || '').trim(),
        album:   String(d.album  || '').trim(),
        playing: Boolean(d.playing),
        pos:     Number(d.pos || 0),
        dur:     Number(d.dur || 0),
        src:     String(d.src || ''),
        art:     String(d.art || ''),
      });
    } catch(_) { resolve(null); }
  });
}));

ipcMain.handle('media-cmd', (_, cmd) => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve(false);
  exec(getCtrlCmd(cmd), {
    timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024,
    env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
  }, (err) => resolve(!err));
}));

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WinNotch');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'WinNotch', enabled: false },
    { type: 'separator' },
    { label: 'Show',  click: () => win?.show()  },
    { label: 'Hide',  click: () => win?.hide()  },
    { type: 'separator' },
    { label: 'Quit',  click: () => app.exit(0)  },
  ]));
  tray.on('double-click', () => win?.isVisible() ? win.hide() : win?.show());
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
});
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => tray?.destroy());