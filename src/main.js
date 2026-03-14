'use strict';

const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage
} = require('electron');
const path  = require('path');
const os    = require('os');
const https = require('https');
const { exec } = require('child_process');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win, tray;

function createWindow() {
  const { x, y, width } = screen.getPrimaryDisplay().bounds;

  win = new BrowserWindow({
    width, height: 160,
    x, y: 0,
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

  screen.on('display-metrics-changed', () => {
    const b = screen.getPrimaryDisplay().bounds;
    win.setBounds({ x: b.x, y: 0, width: b.width, height: 160 }, false);
  });

  setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver', 1);
  }, 2000);
}

// Click-through toggle
ipcMain.on('mouse-enter', () => win?.setIgnoreMouseEvents(false));
ipcMain.on('mouse-leave', () => win?.setIgnoreMouseEvents(true, { forward: true }));

// CPU + RAM
function cpuSample() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle: idle / os.cpus().length, total: total / os.cpus().length };
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

// SMTC Media
const PS = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
  function Aw($op) { $m.MakeGenericMethod($op.GetType().GetGenericArguments()[0]).Invoke($null,@($op)).GetAwaiter().GetResult() }
  $mgr  = Aw ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync())
  $sess = $mgr.GetCurrentSession()
  if (-not $sess) { '{}'; exit }
  $p  = Aw ($sess.TryGetMediaPropertiesAsync())
  $pb = $sess.GetPlaybackInfo()
  $tl = $sess.GetTimelineProperties()
  $playing = $pb.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
  $pos = [long]$tl.Position.TotalSeconds
  $dur = [long]$tl.EndTime.TotalSeconds
  $art = ''
  if ($p.Thumbnail) {
    try {
      $s = Aw ($p.Thumbnail.OpenReadAsync())
      $buf = New-Object byte[] $s.Size
      $dr = [Windows.Storage.Streams.DataReader,Windows.Storage,ContentType=WindowsRuntime]::CreateDataReader($s)
      Aw ($dr.LoadAsync($s.Size)) | Out-Null
      $dr.ReadBytes($buf)
      $art = [Convert]::ToBase64String($buf)
    } catch {}
  }
  [ordered]@{title=$p.Title;artist=$p.Artist;playing=[bool]$playing;pos=$pos;dur=$dur;src=$sess.SourceAppUserModelId;art=$art} | ConvertTo-Json -Compress
} catch { '{}' }
`.replace(/\n/g,' ').trim();

ipcMain.handle('get-media', () => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve(null);
  exec(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${PS.replace(/"/g,'\\"')}"`,
    { timeout: 4000, windowsHide: true },
    (err, out) => {
      if (err || !out?.trim() || out.trim() === '{}') return resolve(null);
      try { const d = JSON.parse(out.trim()); resolve(d.title ? d : null); }
      catch { resolve(null); }
    }
  );
}));

// Tray
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WinNotch');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'WinNotch', enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => win?.show() },
    { label: 'Hide', click: () => win?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.exit(0) },
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