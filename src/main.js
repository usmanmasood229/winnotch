'use strict';

const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage, powerMonitor, desktopCapturer
} = require('electron');

const path  = require('path');
const os    = require('os');
const { exec, spawn } = require('child_process');
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

// ── Settings ──────────────────────────────────────────────────────────────────
// Plain JSON in userData. electron-store is in package.json, but v11 is ESM-only
// and can't be required from this CommonJS main process — and a handful of
// booleans doesn't justify converting the whole app to ESM.
const DEFAULT_SETTINGS = {
  enabled:    true,   // notch visible at all
  lidBlur:    true,   // hinge-driven blur effect
  startup:    false,  // launch at login
  workspaces: true,   // visible across virtual desktops
  fullscreen: true,   // sit above fullscreen apps
};
let settings = { ...DEFAULT_SETTINGS };
let settingsFile = null, settingsWin = null;

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch (_) { /* first run or unreadable — defaults stand */ }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.log('[WinNotch] could not save settings:', e.message);
  }
}

function aotLevel() { return settings.fullscreen ? 'screen-saver' : 'normal'; }

function applySettings() {
  if (win && !win.isDestroyed()) {
    if (settings.enabled && !win.isVisible())      win.show();
    else if (!settings.enabled && win.isVisible()) win.hide();
    win.setAlwaysOnTop(true, aotLevel(), 1);
    win.setVisibleOnAllWorkspaces(settings.workspaces, { visibleOnFullScreen: settings.fullscreen });
  }

  if (settings.enabled && settings.lidBlur) {
    if (!hingeProc) startHingeSensor();
  } else {
    stopHingeSensor();
    if (blurWin && !blurWin.isDestroyed() && blurWin.isVisible()) blurWin.hide();
  }

  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.startup });
  } catch (e) {
    console.log('[WinNotch] could not set login item:', e.message);
  }
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show(); settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 440,
    height: 660,
    frame: false,              // settings.html draws its own titlebar
    resizable: false,
    maximizable: false,
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'settings-preload.js'),
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, key, value) => {
  if (!(key in DEFAULT_SETTINGS)) return settings;   // ignore unknown keys
  settings[key] = value;
  saveSettings();
  applySettings();
  return settings;
});
ipcMain.on('settings:hide', () => settingsWin?.hide());
ipcMain.on('settings:quit', () => {
  stopHingeSensor();
  if (tray) tray.destroy();
  app.exit(0);
});

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
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, aotLevel(), 1);
    else clearInterval(aotInterval);
  }, 5000);
  win._aotInterval = aotInterval;

  // ── Charging events → renderer ───────────────────────────────────────────
  powerMonitor.on('on-ac', () => {
    if (win && !win.isDestroyed()) win.webContents.send('charging-change', true);
  });
  powerMonitor.on('on-battery', () => {
    if (win && !win.isDestroyed()) win.webContents.send('charging-change', false);
  });
}

function refit() {
  const { bounds } = getPrimary();
  if (win && !win.isDestroyed()) {
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: NOTCH_H }, false);
  }
  if (blurWin && !blurWin.isDestroyed()) blurWin.setBounds(bounds, false);
}

// ── Hinge angle → full-screen blur (MacDuo-style) ─────────────────────────────
// Angle comes from a PowerShell sidecar (see hinge-sensor.ps1) because the
// hinge is only reachable through the Win32 COM Sensor API, which Node can't
// call directly.
const HINGE_CLEAR  = 120; // at/above this angle the desktop is fully clear.
                          // Deliberately above a normal working angle so the
                          // curtain tracks the lid across its whole travel — a
                          // parked lid is handled by the settle-fade below, not
                          // by keeping this threshold low.
const HINGE_CLOSED = 5;   // at/below this angle the effect is at full strength

let blurWin = null, blurReady = false, hingeProc = null;

function hingeProgress(angle) {
  if (angle > 180) return 0;              // folded back past flat into tablet mode
  if (angle >= HINGE_CLEAR) return 0;
  if (angle <= HINGE_CLOSED) return 1;
  return (HINGE_CLEAR - angle) / (HINGE_CLEAR - HINGE_CLOSED);
}

function createBlurOverlay() {
  const { bounds } = getPrimary();
  blurWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  blurWin.loadFile(path.join(__dirname, 'lid-blur.html'));
  blurWin.setIgnoreMouseEvents(true, { forward: true });
  blurWin.setAlwaysOnTop(true, 'screen-saver', 1);
  blurWin.webContents.on('did-finish-load', () => { blurReady = true; });
}

// A transparent window can't blur the real desktop behind it (backdrop-filter
// only samples content inside its own page), so grab the desktop and blur that
// image instead. Captured at half resolution — it's about to be blurred by tens
// of pixels, so the lost detail is invisible and the capture is much faster.
let capturing = false;

ipcMain.on('hinge-idle', () => {
  if (blurWin && !blurWin.isDestroyed() && blurWin.isVisible()) blurWin.hide();
});

// Captured at a third of screen resolution: it's about to be blurred by tens of
// pixels, so the lost detail is invisible and the grab is far quicker.
//
// Only ever called while the overlay is invisible — capturing with the curtain
// on screen would photograph our own blur and feed it back on itself.
async function captureDesktop() {
  if (capturing) return;
  capturing = true;
  try {
    const display = getPrimary();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width:  Math.round(display.bounds.width  / 2),
        height: Math.round(display.bounds.height / 2),
      },
    });
    const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (src && blurWin && !blurWin.isDestroyed() && blurReady) {
      blurWin.webContents.send('hinge-shot', src.thumbnail.toDataURL());
    }
  } catch (e) {
    console.log('[WinNotch] desktop capture failed:', e.message);
  } finally {
    capturing = false;
  }
}

// A lid parked at some angle shouldn't keep the curtain pinned there, so once
// the hinge holds still the blur fades off and gives the screen back. Moving
// again brings it straight back.
const SETTLE_MS = 700;
const MOVE_EPS  = 4;   // degrees — the sensor jitters a couple of degrees at
                       // rest, and reacting to that jitter makes the curtain
                       // flash in and out

// The hinge angle is derived from the difference between two accelerometers,
// one in the lid and one in the base. Moving the whole laptop hits both with
// linear acceleration and corrupts their idea of which way gravity points, so
// the reported angle lurches even though the hinge never turned. Telling the
// two apart: closing the lid is a sustained move that keeps going one way,
// while a bump wobbles and comes straight back. So arming needs both a real
// excursion and a consistent direction.
const ARM_DELTA    = 8;   // degrees away from rest before the effect arms
const CONSISTENT_N = 3;   // consecutive samples that must agree on direction
const SMOOTH_N     = 3;   // samples averaged to take the edge off the noise

// Starts settled: nothing has been captured yet, so the first real movement is
// what arms the effect.
let settleTimer = null, settled = true, lastMoveAngle = null;
let angleHist = [], restAngle = null;

// Mean of the last few samples — the raw feed is whole degrees at ~10Hz and
// rattles by a degree or two even at rest.
function smoothAngle(raw) {
  angleHist.push(raw);
  if (angleHist.length > CONSISTENT_N + 2) angleHist.shift();
  const n = Math.min(SMOOTH_N, angleHist.length);
  let sum = 0;
  for (let i = angleHist.length - n; i < angleHist.length; i++) sum += angleHist[i];
  return sum / n;
}

// True only when the recent samples all move the same way — a jolt reverses
// almost immediately, a lid being closed doesn't.
function movingConsistently() {
  if (angleHist.length < CONSISTENT_N + 1) return false;
  const tail = angleHist.slice(-(CONSISTENT_N + 1));
  let dir = 0;
  for (let i = 1; i < tail.length; i++) {
    const d = tail[i] - tail[i - 1];
    if (d === 0) continue;
    const s = Math.sign(d);
    if (dir === 0) dir = s;
    else if (s !== dir) return false;
  }
  return dir !== 0;
}

function onSettle() {
  settled = true;
  lastMoveAngle = null;
  if (angleHist.length) restAngle = angleHist[angleHist.length - 1];
  if (blurWin && !blurWin.isDestroyed()) blurWin.webContents.send('hinge-settled', true);
}

// Each gesture begins with a fresh snapshot, and the curtain is only revealed
// once that snapshot has actually landed — otherwise the first frames would
// show whatever was on screen the last time round. Re-capturing mid-gesture is
// deliberately avoided: it would swap the image under the animation (a visible
// flicker) and would photograph our own blur.
async function armCurtain() {
  await captureDesktop();
  if (blurWin && !blurWin.isDestroyed()) blurWin.webContents.send('hinge-settled', false);
}

function noteHingeMotion(angle) {
  if (settled) {
    if (restAngle === null) restAngle = angle;

    if (Math.abs(angle - restAngle) < ARM_DELTA) {
      // Still around where the lid was parked. Drift the resting point along
      // slowly so gradually repositioning the screen doesn't bank up into a
      // false trigger later.
      restAngle += (angle - restAngle) * 0.1;
      return;
    }
    if (!movingConsistently() || angle > 180) return;  // a jolt, or folded into tablet mode

    settled = false;
    lastMoveAngle = angle;
    armCurtain();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettle, SETTLE_MS);
    return;
  }

  // Already armed — keep it alive for as long as the lid keeps moving.
  if (lastMoveAngle === null || Math.abs(angle - lastMoveAngle) >= MOVE_EPS) {
    lastMoveAngle = angle;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettle, SETTLE_MS);
  }
}

function applyHinge(raw) {
  if (!blurWin || blurWin.isDestroyed() || !blurReady) return;

  // Everything downstream runs off the smoothed angle, so sensor rattle doesn't
  // show up as wobble in the blur.
  const angle = smoothAngle(raw);
  noteHingeMotion(angle);

  const p = hingeProgress(angle);

  // The window is only ever hidden once the renderer reports it has finished
  // easing the curtain away (see the 'hinge-idle' handler) — hiding it here on
  // a timer would cut the fade off mid-flight.
  if (p > 0 && !blurWin.isVisible()) blurWin.showInactive();
  blurWin.webContents.send('hinge-progress', p);
}

function startHingeSensor() {
  // In a packaged build __dirname points inside app.asar, which PowerShell (an
  // outside process) can't read from. The build unpacks .ps1 files alongside it,
  // so point at that copy instead.
  const script = path.join(__dirname, 'hinge-sensor.ps1')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  hingeProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script,
  ], { windowsHide: true });

  let buf = '';
  hingeProc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();                    // keep the partial trailing line
    for (const line of lines) {
      const angle = parseInt(line, 10);
      if (!Number.isNaN(angle)) applyHinge(angle);
    }
  });
  // No hinge sensor (or any other failure) just means no blur — the rest of
  // the app carries on normally.
  hingeProc.stderr.on('data', d => console.log('[WinNotch]', d.toString().trim()));
  hingeProc.on('error', e => { hingeProc = null; console.log('[WinNotch] hinge sensor unavailable:', e.message); });
  hingeProc.on('exit',  c => { hingeProc = null; if (c) console.log('[WinNotch] hinge sensor exited:', c); });
}

function stopHingeSensor() {
  clearTimeout(settleTimer);
  if (hingeProc) { hingeProc.kill(); hingeProc = null; }
}

ipcMain.on('mouse-enter', () => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false); });
ipcMain.on('mouse-leave', () => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true }); });

// ── Charging state query ──────────────────────────────────────────────────────
ipcMain.handle('get-charging', () => {
  // powerMonitor.getSystemIdleState is sync; charging comes from systemBatteryStatus
  try {
    // On Windows this returns 'charging' | 'discharging' | 'full' | 'unknown'
    const status = powerMonitor.onBatteryPower;   // true = on battery (NOT charging)
    return !status; // true = charging / on AC
  } catch (_) {
    return false;
  }
});

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
      if (response.statusCode !== 200) { resolve(''); return; }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    }).on('error', () => resolve(''));
  });
}

async function getYouTubeThumbnail(title) {
  try {
    let cleanTitle = title
      .replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '')
      .replace(/official\s+(music\s+)?video/gi, '')
      .replace(/lyrics?/gi, '').replace(/HD|HQ|4K|1080p|720p/gi, '')
      .replace(/[-|]/g, ' ').trim();
    if (cleanTitle.includes(' - ')) {
      const parts = cleanTitle.split(' - ');
      cleanTitle = parts[parts.length - 1];
    }
    const searchResult = await ytSearch(cleanTitle);
    if (!searchResult?.videos?.length) return '';
    const video = searchResult.videos[0];
    const thumbUrl = video.thumbnail || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
    return await fetchImageAsBase64(thumbUrl);
  } catch (_) { return ''; }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cachedKey = '', _cachedB64 = '', _fetching = false;

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
  } catch (_) { return null; }
});

ipcMain.handle('get-art', async (_, artKey, meta) => {
  if (process.platform !== 'win32') return '';
  if (artKey === _cachedKey && _cachedB64) return _cachedB64;
  if (_fetching) return '';
  _fetching = true;
  try {
    let b64 = await runPS(CMD_ART, 16 * 1024 * 1024);
    if ((!b64 || b64 === '') && meta?.src && meta?.title) {
      const src = meta.src.toLowerCase();
      const isBrowser = src.includes('chrome') || src.includes('edge') || src.includes('firefox') || src.includes('msedge');
      if (isBrowser) b64 = await getYouTubeThumbnail(meta.title);
    }
    if (b64 && b64 !== '') { _cachedKey = artKey; _cachedB64 = b64; }
    return b64 || '';
  } catch (_) { return ''; } 
  finally { _fetching = false; }
});

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
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Show', click: () => win?.show() },
    { label: 'Hide', click: () => win?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => { stopHingeSensor(); if (tray) tray.destroy(); app.exit(0); }},
  ]));
  tray.on('double-click', () => win?.isVisible() ? win.hide() : win?.show());
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const ud = app.getPath('userData');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(ud, f)); } catch (_) {}
  }
  if (app.dock) app.dock.hide();
  loadSettings();
  createWindow();
  createTray();
  createBlurOverlay();
  applySettings();   // starts the hinge sensor too, if it's enabled
});

app.on('window-all-closed', e => e.preventDefault());

app.on('before-quit', () => {
  stopHingeSensor();
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