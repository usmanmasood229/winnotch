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

const NOTCH_H = 148;

function getPrimary() {
  return screen.getPrimaryDisplay();
}

function createWindow() {
  const { bounds } = getPrimary();

  win = new BrowserWindow({
    width:           bounds.width,
    height:          NOTCH_H,
    x:               bounds.x,
    y:               bounds.y,
    frame:           false,
    transparent:     true,
    backgroundColor: '#00000000',
    hasShadow:       false,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       false,
    movable:         false,
    minimizable:     false,
    maximizable:     false,
    closable:        false,
    focusable:       true,
    webPreferences: {
      nodeIntegration:  false,
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

// CPU + RAM stats
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

// IMPROVED MEDIA DETECTION - Multiple methods
const PS_MEDIA_SCRIPT = `
# Method 1: Try SMTC first
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  
  if ($session -ne $null) {
    $mediaProps = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $timeline = $session.GetTimelineProperties()
    $playback = $session.GetPlaybackInfo()
    $isPlaying = $playback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
    
    $position = [math]::Floor($timeline.Position.TotalSeconds)
    $endTime = [math]::Floor($timeline.EndTime.TotalSeconds)
    
    $thumbnail = $mediaProps.Thumbnail
    $thumbnailBase64 = ""
    if ($thumbnail -ne $null) {
      try {
        $streamRef = $thumbnail
        $randomAccessStream = Await ($streamRef.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStream])
        $size = $randomAccessStream.Size
        $reader = [Windows.Storage.Streams.DataReader]::CreateDataReader($randomAccessStream)
        Await ($reader.LoadAsync([uint32]$size)) ([uint32])
        $buffer = New-Object byte[] $size
        $reader.ReadBytes($buffer)
        $thumbnailBase64 = [Convert]::ToBase64String($buffer)
        $reader.Dispose()
        $randomAccessStream.Dispose()
      } catch {
        $thumbnailBase64 = ""
      }
    }
    
    $result = @{
      title = $mediaProps.Title
      artist = $mediaProps.Artist
      album = $mediaProps.AlbumTitle
      playing = $isPlaying
      pos = $position
      dur = $endTime
      src = $session.SourceAppUserModelId
      art = $thumbnailBase64
    }
    $json = $result | ConvertTo-Json -Compress
    Write-Output $json
    exit
  }
} catch {
  # SMTC failed, try next method
}

# Method 2: Try to get Chrome/Edge media sessions
try {
  $chromeSessions = Get-Process | Where-Object { $_.ProcessName -match 'chrome|msedge|firefox' } | Select-Object -First 1
  if ($chromeSessions) {
    # Return a placeholder to indicate browser is playing something
    $result = @{
      title = "Media playing in browser"
      artist = "Click media controls in browser"
      album = ""
      playing = $true
      pos = 0
      dur = 0
      src = "Browser"
      art = ""
    }
    $json = $result | ConvertTo-Json -Compress
    Write-Output $json
    exit
  }
} catch {}

# No media found
Write-Output "{}"
`.trim();

ipcMain.handle('get-media', () => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve(null);
  
  const psCommand = PS_MEDIA_SCRIPT.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  
  exec(
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { ${psCommand} }"`,
    { 
      timeout: 3000, 
      windowsHide: true, 
      maxBuffer: 1024 * 1024,
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' }
    },
    (err, stdout, stderr) => {
      const raw = (stdout || '').trim();
      if (err || !raw || raw === '{}') {
        // Try one more method - check for any audio playing
        exec('powershell -Command "(Get-Process | Where-Object { $_.MainWindowTitle -ne \"\" -and $_.MainWindowTitle -match \"YouTube|Spotify|Music\" }).MainWindowTitle | Select-Object -First 1"',
          (err2, stdout2) => {
            if (!err2 && stdout2.trim()) {
              resolve({
                title: "Media Playing",
                artist: stdout2.trim(),
                album: "",
                playing: true,
                pos: 0,
                dur: 0,
                src: "Browser",
                art: ""
              });
            } else {
              resolve(null);
            }
          }
        );
        return;
      }
      
      try {
        const d = JSON.parse(raw);
        if (!d || !d.title) return resolve(null);
        
        resolve({
          title:   String(d.title  || ''),
          artist:  String(d.artist || ''),
          album:   String(d.album  || ''),
          playing: Boolean(d.playing),
          pos:     Number(d.pos || 0),
          dur:     Number(d.dur || 0),
          src:     String(d.src  || ''),
          art:     String(d.art  || ''),
        });
      } catch (e) {
        resolve(null);
      }
    }
  );
}));

// Tray
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WinNotch');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'WinNotch',  enabled: false },
    { type: 'separator' },
    { label: 'Show',  click: () => win?.show()  },
    { label: 'Hide',  click: () => win?.hide()  },
    { type: 'separator' },
    { label: 'Quit',  click: () => app.exit(0)  },
  ]));
  tray.on('double-click', () => win?.isVisible() ? win.hide() : win?.show());
}

// Boot
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
});
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => tray?.destroy());