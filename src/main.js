'use strict';

const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage, powerMonitor, desktopCapturer
} = require('electron');

const path  = require('path');
const os    = require('os');
const { spawn } = require('child_process');
const fs    = require('fs');
const https = require('https');

// ── Single instance ───────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// ── Window ────────────────────────────────────────────────────────────────────
let win, tray;
const NOTCH_H = 210;   // tall enough for the open panel and its shadow

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
    startHingeSensor();
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
  stopHelper();
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

// ── Hinge angle → full-screen blur ────────────────────────────────────────────
// Angle comes from the native helper (src/helper/WinNotchHelper.cs) because the
// hinge is only reachable through the Win32 COM Sensor API, which Node can't
// call directly.
//
// The main process only decides when a gesture starts and grabs the desktop for
// it. How the blur looks and moves lives in lid-blur.html, which runs per frame:
// IPC and timers here can't pace an animation smoothly.
let blurWin = null, blurReady = false;

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
// image instead. Half resolution: it's about to be blurred, and the grab is far
// quicker. Only ever called while the overlay is hidden — capturing with it on
// screen would photograph our own blur. Resolves to a data URL, or null.
//
// The native helper captures in tens of milliseconds; desktopCapturer takes
// 300-450 ms, which made the effect start visibly after the lid had moved. It
// stays as the fallback for when the helper isn't running or can't capture.
const SHOT_TIMEOUT_MS = 1500;
let capturing = false, shotSeq = 0;
const shotWaiters = new Map();

function onShotLine(rest) {
  const space = rest.indexOf(' ');
  const id = space < 0 ? rest : rest.slice(0, space);
  const b64 = space < 0 ? '' : rest.slice(space + 1).trim();
  const resolve = shotWaiters.get(id);
  if (resolve) { shotWaiters.delete(id); resolve(b64); }
}

function helperShot() {
  return new Promise(resolve => {
    const id = String(++shotSeq);
    if (!sendHelperCommand(`shot ${id}`)) { resolve(''); return; }
    const timer = setTimeout(() => { shotWaiters.delete(id); resolve(''); }, SHOT_TIMEOUT_MS);
    shotWaiters.set(id, b64 => { clearTimeout(timer); resolve(b64); });
  });
}

async function captureDesktop() {
  if (capturing) return null;
  capturing = true;
  try {
    const b64 = await helperShot();
    if (b64) return 'data:image/jpeg;base64,' + b64;
    const display = getPrimary();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width:  Math.round(display.bounds.width  / 2),
        height: Math.round(display.bounds.height / 2),
      },
    });
    const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
    // JPEG, not PNG: a fraction of the size and encode time, and it's about to
    // be blurred, so compression artefacts never show.
    return src ? 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(90).toString('base64') : null;
  } catch (e) {
    console.log('[WinNotch] desktop capture failed:', e.message);
    return null;
  } finally {
    capturing = false;
  }
}

// The hinge angle is derived from the difference between two accelerometers,
// one in the lid and one in the base. Moving the whole laptop hits both with
// linear acceleration and corrupts their idea of which way gravity points, so
// the reported angle lurches even though the hinge never turned. Telling the
// two apart: closing the lid is a sustained move that keeps going one way,
// while a bump wobbles and comes straight back. So arming needs both a real
// excursion and a consistent direction.
// Kept low so the effect starts as the lid starts moving. A false start from a
// bump is harmless: the renderer ignores sensor rattle, and the overlay stays
// fully transparent under 2° of tilt until it times out.
const ARM_DELTA    = 4;   // degrees away from rest before the effect arms
const CONSISTENT_N = 2;   // consecutive samples that must agree on direction
const SMOOTH_N     = 3;   // samples averaged to take the edge off the noise

// How far the base accelerometer may stray from its resting reading (in g)
// before the laptop counts as being moved. The base stays put when only the lid
// moves, so this rejects carried or nudged laptops without slowing the hinge.
// Resting noise measured at about 0.02g.
const LAPTOP_MOVING_G = 0.06;

// Starts disarmed: nothing has been captured yet, so the first real movement is
// what arms the effect.
let armed = false, angleHist = [], restAngle = null, lastSmoothed = null, lastRaw = null;

// Mean of the last few samples, used only to decide when a gesture starts —
// the raw feed is coarse and rattles by a degree or two even at rest.
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

// The renderer says when the blur has fully eased away; only then is the window
// pulled and the next movement allowed to start a fresh gesture. The rest angle
// is wherever the lid came to a stop.
function disarm() {
  armed = false;
  if (lastSmoothed !== null) restAngle = lastSmoothed;
  if (blurWin && !blurWin.isDestroyed() && blurWin.isVisible()) blurWin.hide();
}

ipcMain.on('hinge-idle', disarm);

// Each gesture begins with a fresh snapshot. Re-capturing mid-gesture is
// deliberately avoided: it would swap the image under the animation and would
// photograph our own blur. The anchor is the angle the lid rested at, so the
// blur measures how far it has travelled from there.
async function arm(anchor) {
  armed = true;
  const dataUrl = await captureDesktop();
  if (!armed) return;                                  // sensor stopped meanwhile
  if (!dataUrl || !blurWin || blurWin.isDestroyed()) { disarm(); return; }
  blurWin.webContents.send('hinge-shot', { dataUrl, anchor, angle: lastRaw });
  blurWin.showInactive();
}

function applyHinge(raw, baseMotion = 0) {
  if (!blurWin || blurWin.isDestroyed() || !blurReady) return;

  // The laptop itself is moving: its acceleration corrupts the reported angle,
  // so these samples say nothing about the hinge. Mid-gesture the renderer just
  // holds its last good angle. At rest the readings are dropped without
  // touching the rest point, and the history is cleared so the lurch can't
  // count as lid travel once the laptop settles.
  if (baseMotion > LAPTOP_MOVING_G) {
    if (!armed) angleHist.length = 0;
    return;
  }

  lastRaw = raw;
  const angle = smoothAngle(raw);
  lastSmoothed = angle;

  // Mid-gesture the renderer gets every raw sample: its own per-frame smoothing
  // does a better job than averaging here, which only adds lag.
  if (armed) {
    blurWin.webContents.send('hinge-angle', raw);
    return;
  }

  if (restAngle === null) restAngle = angle;
  if (Math.abs(angle - restAngle) < ARM_DELTA) {
    // Still around where the lid was parked. Drift the resting point along
    // slowly so gradually repositioning the screen doesn't bank up into a
    // false trigger later.
    restAngle += (angle - restAngle) * 0.1;
    return;
  }
  if (!movingConsistently() || angle > 180) return;  // a jolt, or folded into tablet mode
  arm(restAngle);
}

// The angle arrives from the native helper (see "Native helper" below) for as
// long as the hinge is switched on there.
let hingeWanted = false;

function startHingeSensor() {
  hingeWanted = true;
  sendHelperCommand('hinge on');
}

function stopHingeSensor() {
  hingeWanted = false;
  sendHelperCommand('hinge off');
  disarm();
}

ipcMain.on('mouse-enter', () => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false); });
ipcMain.on('mouse-leave', () => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true }); });

// Where the pointer is, in the notch window's own coordinates. While the window
// is click-through it only ever sees forwarded mouse *moves*, so a pointer that
// stops moving or leaves the window goes silent — hover has to be able to ask
// outright. Window bounds and the cursor are both in screen points, and the
// page's CSS pixels match, so this needs no scaling.
ipcMain.handle('cursor-point', () => {
  if (!win || win.isDestroyed()) return null;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return { x: p.x - b.x, y: p.y - b.y };
});

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

// ── Native helper ─────────────────────────────────────────────────────────────
// One small compiled process (src/helper/WinNotchHelper.cs, built by
// scripts/build-helper.js) reads the hinge and reports / controls media. It
// replaced a PowerShell process for each job, and before that a fresh
// PowerShell for every 2s media poll — each one a 60-80 MB runtime.
const MEDIA_CMDS = new Set(['play', 'pause', 'next', 'prev', 'toggle']);
const ART_TIMEOUT_MS = 8000;

let helperProc = null, helperRestartTimer = null, helperStopping = false;
let mediaMeta = null, artWaiters = [];

function settleArtWaiters(b64) {
  const waiters = artWaiters;
  artWaiters = [];
  for (const resolve of waiters) resolve(b64);
}

function onHelperLine(line) {
  if (line.startsWith('ANGLE ')) {
    const [angle, baseMotion] = line.slice(6).split(' ').map(parseFloat);
    if (Number.isFinite(angle)) applyHinge(angle, Number.isFinite(baseMotion) ? baseMotion : 0);
  } else if (line.startsWith('META ')) {
    try {
      const d = JSON.parse(line.slice(5));
      mediaMeta = d && d.title ? d : null;
    } catch (_) { mediaMeta = null; }
  } else if (line.startsWith('ART ')) {
    settleArtWaiters(line.slice(4).trim());
  } else if (line.startsWith('SHOT ')) {
    onShotLine(line.slice(5));
  }
}

function startHelper() {
  if (process.platform !== 'win32' || helperProc) return;
  helperStopping = false;
  // In a packaged build __dirname points inside app.asar, which an outside
  // process can't be launched from; the build unpacks the exe alongside it.
  const exe = path.join(__dirname, 'helper', 'winnotch-helper.exe')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const proc = spawn(exe, [], { windowsHide: true });
  helperProc = proc;

  // Artwork arrives as one multi-megabyte line, so only the new chunk is
  // searched for line breaks rather than rescanning everything buffered.
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    if (chunk.indexOf('\n') < 0) { buf += chunk; return; }
    const lines = (buf + chunk).split('\n');
    buf = lines.pop();
    for (const line of lines) onHelperLine(line.replace(/\r$/, ''));
  });
  proc.stdin.on('error', () => {});   // helper gone; the exit handler cleans up
  // No hinge sensor (or any other failure) just means no blur or no media —
  // the rest of the app carries on normally.
  proc.stderr.on('data', d => console.log('[WinNotch]', d.toString().trim()));
  proc.on('error', e => console.log('[WinNotch] helper unavailable:', e.message));
  proc.on('exit', code => {
    if (helperProc !== proc) return;
    helperProc = null;
    mediaMeta = null;
    settleArtWaiters('');
    disarm();
    if (helperStopping) return;
    console.log('[WinNotch] helper exited:', code, '— restarting');
    helperRestartTimer = setTimeout(startHelper, 3000);
  });

  if (hingeWanted) sendHelperCommand('hinge on');
}

function stopHelper() {
  helperStopping = true;
  clearTimeout(helperRestartTimer);
  settleArtWaiters('');
  if (helperProc) {
    const proc = helperProc;
    helperProc = null;
    try { proc.stdin.end(); } catch (_) {}   // closing stdin tells it to exit
    setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 1500);
  }
}

function sendHelperCommand(cmd) {
  if (!helperProc || !helperProc.stdin.writable) return false;
  helperProc.stdin.write(cmd + '\n');
  return true;
}

function requestArt() {
  return new Promise(resolve => {
    if (!sendHelperCommand('art')) { resolve(''); return; }
    const timer = setTimeout(() => {
      artWaiters = artWaiters.filter(r => r !== done);
      resolve('');
    }, ART_TIMEOUT_MS);
    const done = b64 => { clearTimeout(timer); resolve(b64); };
    artWaiters.push(done);
  });
}

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
    // Loaded on first use: it pulls in a sizeable dependency tree that most
    // sessions never need.
    const ytSearch = require('yt-search');
    const searchResult = await ytSearch(cleanTitle);
    if (!searchResult?.videos?.length) return '';
    const video = searchResult.videos[0];
    const thumbUrl = video.thumbnail || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
    return await fetchImageAsBase64(thumbUrl);
  } catch (_) { return ''; }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cachedKey = '', _cachedB64 = '', _fetching = false;

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-media', () => {
  const d = mediaMeta;
  if (!d) return null;
  // Artwork isn't included: the notch asks for it once per track via get-art.
  // Sending it here meant re-copying the whole image every 2s just to be
  // thrown away.
  return {
    title:   String(d.title  || '').trim(),
    artist:  String(d.artist || '').trim(),
    album:   String(d.album  || '').trim(),
    playing: Boolean(d.playing),
    pos:     Number(d.pos || 0),
    dur:     Number(d.dur || 0),
    src:     String(d.src || ''),
    artKey:  `${d.title}||${d.artist}||${d.album}||${d.src}`,
  };
});

ipcMain.handle('get-art', async (_, artKey, meta) => {
  if (process.platform !== 'win32') return '';
  if (artKey === _cachedKey && _cachedB64) return _cachedB64;
  if (_fetching) return '';
  _fetching = true;
  try {
    let b64 = await requestArt();
    if (!b64 && meta?.src && meta?.title) {
      const src = String(meta.src).toLowerCase();
      const isBrowser = src.includes('chrome') || src.includes('edge') || src.includes('firefox') || src.includes('msedge');
      if (isBrowser) b64 = await getYouTubeThumbnail(String(meta.title));
    }
    if (b64) { _cachedKey = artKey; _cachedB64 = b64; }
    return b64 || '';
  } catch (_) { return ''; }
  finally { _fetching = false; }
});

ipcMain.handle('media-cmd', (_, cmd) => {
  if (process.platform !== 'win32') return false;
  return sendHelperCommand(MEDIA_CMDS.has(cmd) ? cmd : 'toggle');
});

// Screen share: Windows puts casting behind Win+K, and there's no API for it,
// so the shortcut is pressed for the user. The notch window never takes focus,
// so the panel opens over whatever they were using.
ipcMain.handle('open-cast', () => {
  if (process.platform !== 'win32') return false;
  const script = [
    '$s = \'[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, System.UIntPtr e);\'',
    '$k = Add-Type -MemberDefinition $s -Name Keys -Namespace WinNotch -PassThru',
    '$k::keybd_event(0x5B,0,0,[UIntPtr]::Zero)',   // Win down
    '$k::keybd_event(0x4B,0,0,[UIntPtr]::Zero)',   // K down
    '$k::keybd_event(0x4B,0,2,[UIntPtr]::Zero)',   // K up
    '$k::keybd_event(0x5B,0,2,[UIntPtr]::Zero)',   // Win up
  ].join('; ');
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    return true;
  } catch (e) {
    console.log('[WinNotch] could not open the cast panel:', e.message);
    return false;
  }
});

// Scrubbing the progress bar. Anything that isn't a sane number of seconds is
// dropped rather than passed to the player.
ipcMain.handle('media-seek', (_, seconds) => {
  if (process.platform !== 'win32') return false;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0 || s > 24 * 3600) return false;
  return sendHelperCommand(`seek ${s.toFixed(3)}`);
});

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
    { label: 'Quit', click: () => { stopHingeSensor(); stopHelper(); if (tray) tray.destroy(); app.exit(0); }},
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
  startHelper();
  applySettings();   // starts the hinge sensor too, if it's enabled
});

app.on('window-all-closed', e => e.preventDefault());

app.on('before-quit', () => {
  stopHingeSensor();
  stopHelper();
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