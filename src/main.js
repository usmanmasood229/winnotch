'use strict';

const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage
} = require('electron');

const path  = require('path');
const os    = require('os');
const { exec } = require('child_process');
const fs    = require('fs');
const https = require('https');
const ytSearch = require('yt-search');

// ── Single instance ───────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// ── Window ────────────────────────────────────────────────────────────────────
let win, tray;
const NOTCH_H = 160;

function getPrimary() { return screen.getPrimaryDisplay(); }

function createWindow() {
  const { bounds } = getPrimary();

  win = new BrowserWindow({
    width: bounds.width,
    height: NOTCH_H,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
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

  win.on('blur',  () => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver', 1); });
  win.on('focus', () => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver', 1); });

  const refitHandler = () => refit();
  screen.on('display-metrics-changed', refitHandler);
  screen.on('display-added',           refitHandler);
  screen.on('display-removed',         refitHandler);
  win._refitHandler = refitHandler;

  const aotInterval = setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver', 1);
    else clearInterval(aotInterval);
  }, 5000);
  win._aotInterval = aotInterval;
}

function refit() {
  if (!win || win.isDestroyed()) return;
  const { bounds } = getPrimary();
  win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: NOTCH_H }, false);
}

ipcMain.on('mouse-enter', () => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false); });
ipcMain.on('mouse-leave', () => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true }); });

// ── CPU / RAM ─────────────────────────────────────────────────────────────────
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

// ── PowerShell helpers ────────────────────────────────────────────────────────
function encodePS(script) {
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function runPS(cmd, maxBuf = 256 * 1024) {
  return new Promise(resolve => {
    exec(cmd, { 
      timeout: 8000,
      windowsHide: true, 
      maxBuffer: maxBuf,
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
    }, (err, stdout) => {
      resolve((stdout || '').trim());
    });
  });
}

// ── Shared WinRT setup ────────────────────────────────────────────────────────
const PS_BASE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethod})[0]
function WA($t,$type){$gm=$asTask.MakeGenericMethod($type);$task=$gm.Invoke($null,@($t));$task.Wait(-1)|Out-Null;$task.Result}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr=WA ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions=$mgr.GetSessions()

$Playing=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
$Paused=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused

$best=$null;$bestScore=0

foreach($s in $sessions){
 try{
  $pb=$s.GetPlaybackInfo()
  $score=0

  if($pb.PlaybackStatus -eq $Playing){$score+=50}
  elseif($pb.PlaybackStatus -eq $Paused){$score+=10}

  $propsTmp=WA ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if($propsTmp.Title){$score+=20}
  if($propsTmp.Thumbnail){$score+=10}

  if($score -gt $bestScore){$bestScore=$score;$best=$s}
 }catch{}
}
`;

// ── Metadata ──────────────────────────────────────────────────────────────────
const PS_META = `
try{
${PS_BASE}
if($best -eq $null){Write-Output '{}';exit}

$props=WA ($best.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$tl=$best.GetTimelineProperties()
$pb2=$best.GetPlaybackInfo()

$out=[ordered]@{
 title=[string]$props.Title
 artist=[string]$props.Artist
 album=[string]$props.AlbumTitle
 playing=($pb2.PlaybackStatus -eq $Playing)
 pos=[math]::Floor($tl.Position.TotalSeconds)
 dur=[math]::Floor($tl.EndTime.TotalSeconds)
 src=[string]$best.SourceAppUserModelId
}

Write-Output ($out|ConvertTo-Json -Compress)
}catch{Write-Output '{}'}
`;

// ── Thumbnail from SMTC ───────────────────────────────────────────────────────
const PS_ART = `
try{
${PS_BASE}
if($best -eq $null){Write-Output '';exit}

$props=WA ($best.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
if($props.Thumbnail -eq $null){Write-Output '';exit}

[void][Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]

$stream=WA ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStream])
$sz=[uint32]$stream.Size

if($sz -gt 0 -and $sz -lt 5242880){
 $reader=[Windows.Storage.Streams.DataReader]::CreateDataReader($stream)
 $null=WA ($reader.LoadAsync($sz)) ([uint32])
 $buf=New-Object byte[] $sz
 $reader.ReadBytes($buf)
 $reader.Dispose()
 $stream.Dispose()
 Write-Output ([Convert]::ToBase64String($buf))
} else {
 $stream.Dispose()
 Write-Output ''
}
}catch{Write-Output ''}
`;

const CMD_META = encodePS(PS_META);
const CMD_ART  = encodePS(PS_ART);

// ── YouTube Thumbnail Extractor ───────────────────────────────────────────────
async function fetchImageAsBase64(url) {
  return new Promise((resolve) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        resolve('');
        return;
      }
      
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      });
    }).on('error', () => resolve(''));
  });
}

async function getYouTubeThumbnail(title) {
  try {
    // Clean the title for better search results
    let cleanTitle = title
      .replace(/\(.*?\)/g, '')           // Remove (parentheses)
      .replace(/\[.*?\]/g, '')           // Remove [brackets]
      .replace(/official\s+(music\s+)?video/gi, '')
      .replace(/lyrics?/gi, '')
      .replace(/HD|HQ|4K|1080p|720p/gi, '')
      .replace(/[-|]/g, ' ')
      .trim();
    
    // If title has " - " format (Artist - Song), use the song part
    if (cleanTitle.includes(' - ')) {
      const parts = cleanTitle.split(' - ');
      cleanTitle = parts[parts.length - 1]; // Take the song name
    }
    
    console.log('[YouTube] Searching for:', cleanTitle);
    
    const searchResult = await ytSearch(cleanTitle);
    
    if (!searchResult || !searchResult.videos || searchResult.videos.length === 0) {
      console.log('[YouTube] No results found');
      return '';
    }
    
    // Get the first video result
    const video = searchResult.videos[0];
    const thumbUrl = video.thumbnail || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
    
    console.log('[YouTube] Found:', video.title);
    
    // Fetch the thumbnail as base64
    const b64 = await fetchImageAsBase64(thumbUrl);
    return b64;
    
  } catch (error) {
    console.error('[YouTube] Error:', error);
    return '';
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cachedKey = '';
let _cachedB64 = '';
let _fetching = false;

// ── Control scripts ──────────────────────────────────────────────────────────
function buildCtrlScript(cmd) {
  const actionMap = {
    play:  `WA ($best.TryPlayAsync()) ([bool])|Out-Null`,
    pause: `WA ($best.TryPauseAsync()) ([bool])|Out-Null`,
    next:  `WA ($best.TrySkipNextAsync()) ([bool])|Out-Null`,
    prev:  `WA ($best.TrySkipPreviousAsync()) ([bool])|Out-Null`,
  };
  const action = actionMap[cmd] || `WA ($best.TryTogglePlayPauseAsync()) ([bool])|Out-Null`;
  return `try{${PS_BASE}\nif($best -ne $null){${action}}}catch{}`;
}

const _ctrlMap = {};
function getCtrlCmd(cmd) {
  return _ctrlMap[cmd] || (_ctrlMap[cmd] = encodePS(buildCtrlScript(cmd)));
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// Fast poll - returns metadata + cached art
ipcMain.handle('get-media', async () => {
  if (process.platform !== 'win32') return null;
  
  const raw = await runPS(CMD_META, 128 * 1024);
  if (!raw || raw === '{}') return null;
  
  try {
    const d = JSON.parse(raw);
    if (!d?.title) return null;
    
    const artKey = `${d.title}||${d.artist}||${d.album}||${d.src}`;
    
    return {
      title:   String(d.title  || '').trim(),
      artist:  String(d.artist || '').trim(),
      album:   String(d.album  || '').trim(),
      playing: Boolean(d.playing),
      pos:     Number(d.pos || 0),
      dur:     Number(d.dur || 0),
      src:     String(d.src || ''),
      artKey,
      art: artKey === _cachedKey ? _cachedB64 : '',
    };
  } catch (_) { 
    return null; 
  }
});

// Art handler with YouTube fallback for browsers
ipcMain.handle('get-art', async (_, artKey, meta) => {
  if (process.platform !== 'win32') return '';
  if (artKey === _cachedKey && _cachedB64) return _cachedB64;
  if (_fetching) return '';
  
  _fetching = true;
  
  try {
    // Try SMTC thumbnail first
    let b64 = await runPS(CMD_ART, 16 * 1024 * 1024);
    
    // If SMTC failed AND this is from a browser (Chrome/Edge)
    if ((!b64 || b64 === '') && meta && meta.src && meta.title) {
      const src = meta.src.toLowerCase();
      const isBrowser = src.includes('chrome') || src.includes('edge') || src.includes('firefox') || src.includes('msedge');
      
      if (isBrowser) {
        console.log('[Art] SMTC failed, trying YouTube for:', meta.title);
        b64 = await getYouTubeThumbnail(meta.title);
        
        if (b64 && b64 !== '') {
          console.log('[Art] ✓ YouTube thumbnail fetched successfully');
        }
      }
    }
    
    // Cache the result
    if (b64 && b64 !== '') {
      _cachedKey = artKey;
      _cachedB64 = b64;
    }
    
    return b64 || '';
    
  } catch (error) {
    console.error('[Art] Error:', error);
    return '';
  } finally {
    _fetching = false;
  }
});

// Playback control
ipcMain.handle('media-cmd', (_, cmd) => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve(false);
  
  exec(getCtrlCmd(cmd), {
    timeout: 3000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
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
    { label: 'Show', click: () => win?.show() },
    { label: 'Hide', click: () => win?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => { 
      if (tray) tray.destroy();
      app.exit(0); 
    }},
  ]));
  tray.on('double-click', () => win?.isVisible() ? win.hide() : win?.show());
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Clean up stale lock files
  const ud = app.getPath('userData');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(ud, f)); } catch (_) {}
  }
  
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
});

app.on('window-all-closed', e => e.preventDefault());

app.on('before-quit', () => {
  if (win && !win.isDestroyed()) {
    clearInterval(win._aotInterval);
    if (win._refitHandler) {
      screen.removeListener('display-metrics-changed', win._refitHandler);
      screen.removeListener('display-added',           win._refitHandler);
      screen.removeListener('display-removed',         win._refitHandler);
    }
  }
  tray?.destroy();
});