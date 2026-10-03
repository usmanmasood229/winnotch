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
const net   = require('net');
const crypto = require('crypto');
const agentScan = require('./agent-scan');

// ── Single instance ───────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

// Launching it again is the one way to reach settings while the tray icon is
// blank, so a second launch opens them.
app.on('second-instance', () => openSettings());

// Nothing here ever navigates or opens a window; a dropped file or a stray link must not
// turn a preload-bearing window into a browser.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', e => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// ── Window ────────────────────────────────────────────────────────────────────
let win, tray, winReady = false;
// Tall enough for the agents panel, which is a dropdown rather than a strip.
// The window is transparent and click-through outside the panel itself, so the
// spare height below costs nothing — see setInteractive() in the renderer, which
// hands clicks back to whatever is underneath.
const NOTCH_H = 480;

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

// Only keys we ship, with the type we ship them as. `key in DEFAULT_SETTINGS` let
// __proto__ / constructor through.
function validSetting(key, value) {
  return typeof key === 'string' && Object.hasOwn(DEFAULT_SETTINGS, key)
      && typeof value === typeof DEFAULT_SETTINGS[key];
}

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const next = { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    // A hand-edited file is trusted no more than the settings page: anything
    // that isn't one of our keys with our type keeps its default.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (validSetting(key, value)) next[key] = value;
      }
    }
  } catch (_) { /* first run or unreadable — defaults stand */ }
  settings = next;
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
    if (settings.enabled && !win.isVisible())      win.showInactive();
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
  if (!validSetting(key, value)) return settings;
  settings[key] = value;
  saveSettings();
  applySettings();
  return settings;
});
ipcMain.on('settings:hide', () => settingsWin?.hide());
ipcMain.on('settings:quit', () => quitApp());

// A crashed page is reloaded, but a page that crashes again straight away backs
// off instead of reloading every second forever.
const winCrash = { at: 0, delay: 1000 }, blurCrash = { at: 0, delay: 1000 };
function recoverRenderer(w, st, reason) {
  if (reason === 'clean-exit') return;
  const now = Date.now();
  st.delay = now - st.at < 30000 ? Math.min(st.delay * 2, 60000) : 1000;
  st.at = now;
  setTimeout(() => { if (w && !w.isDestroyed()) w.webContents.reload(); }, st.delay);
}

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

  // Prompts are only handed to a page that has finished loading (see canPrompt).
  win.webContents.on('did-start-loading', () => { winReady = false; });
  win.webContents.on('did-finish-load', () => { winReady = true; });
  win.webContents.on('render-process-gone', (_e, d) => {
    winReady = false;
    console.log('[WinNotch] notch renderer gone:', d.reason);
    // A dead page cannot hand clicks back: without this a crash while open left
    // an invisible click-eating strip.
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
    // Their cards died with the page. true: no permission-gone to a dead page.
    for (const id of [...pendingPermissions.keys()]) finishPermission(id, 'ask', true);
    recoverRenderer(win, winCrash, d.reason);
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on('blur',  () => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, aotLevel(), 1); });
  win.on('focus', () => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, aotLevel(), 1); });

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
  blurWin.webContents.on('did-start-loading', () => { blurReady = false; });
  blurWin.webContents.on('did-finish-load', () => { blurReady = true; });
  blurWin.webContents.on('render-process-gone', (_e, d) => {
    blurReady = false;
    disarm();
    recoverRenderer(blurWin, blurCrash, d.reason);
  });
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

// The helper is gone, so no SHOT line is coming: let every waiting grab fall
// back now rather than wait out its timeout. Each waiter clears its own timer.
function settleShotWaiters() {
  for (const resolve of shotWaiters.values()) resolve('');
  shotWaiters.clear();
}

function helperShot() {
  return new Promise(resolve => {
    const id = String(++shotSeq);
    if (!sendHelperCommand(`shot ${id}`)) { resolve(''); return; }
    const timer = setTimeout(() => { shotWaiters.delete(id); resolve(''); }, SHOT_TIMEOUT_MS);
    shotWaiters.set(id, b64 => { clearTimeout(timer); resolve(b64); });
  });
}

// The notch sits on top of everything, so a full-screen grab catches the notch
// itself — and since the glass samples the screen exactly where the panel is,
// it ends up refracting a picture of itself and comes out black. The lid blur
// has the same problem for the same reason. Windows can leave a window out of
// captures altogether; Electron exposes that as content protection. It's held
// only for the length of the grab, so a screen recording loses the notch for a
// frame rather than for good.
// Two frames, not one. Nothing here can confirm the compositor actually dropped
// the windows, and if it has not the glass refracts itself and comes out black.
// This path runs on a hover, not per frame, so the extra 16ms costs nothing.
const CAPTURE_SETTLE_MS = 32;

async function withoutOverlays(fn) {
  const hidden = [win, blurWin].filter(w => w && !w.isDestroyed() && w.isVisible());
  hidden.forEach(w => w.setContentProtection(true));
  try {
    if (hidden.length) await new Promise(r => setTimeout(r, CAPTURE_SETTLE_MS));
    return await fn();
  } finally {
    hidden.forEach(w => { if (!w.isDestroyed()) w.setContentProtection(false); });
  }
}

async function captureDesktop() {
  if (capturing) return null;
  capturing = true;
  try {
    return await withoutOverlays(() => grabScreen());
  } catch (e) {
    console.log('[WinNotch] desktop capture failed:', e.message);
    return null;
  } finally {
    capturing = false;
  }
}

async function grabScreen() {
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
  clearTimeout(armWatchdog); armWatchdog = null;
  if (lastSmoothed !== null) restAngle = lastSmoothed;
  if (blurWin && !blurWin.isDestroyed() && blurWin.isVisible()) blurWin.hide();
}

ipcMain.on('hinge-idle', disarm);

// One fixed deadline per gesture, never pushed back by samples: the helper sends
// one on every 0.1 degree change, so rattle would keep a refreshed one alive for
// good. A healthy overlay reports idle a few seconds after the lid stops (hold
// 1 s + settle), so a gesture never lasts a minute; past that the overlay is gone
// and staying armed would kill the effect for good.
const ARM_WATCHDOG_MS = 60000;
let armWatchdog = null;

// Each gesture begins with a fresh snapshot. Re-capturing mid-gesture is
// deliberately avoided: it would swap the image under the animation and would
// photograph our own blur. The anchor is the angle the lid rested at, so the
// blur measures how far it has travelled from there.
async function arm(anchor) {
  armed = true;
  clearTimeout(armWatchdog); armWatchdog = setTimeout(disarm, ARM_WATCHDOG_MS);
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
// A helper that dies at launch (missing exe, blocked by AV) is retried with a
// growing pause instead of every 3 s forever; one that ran a while starts fresh.
const HELPER_RETRY_MIN_MS = 3000, HELPER_RETRY_MAX_MS = 60000, HELPER_STABLE_MS = 60000;

let helperProc = null, helperRestartTimer = null, helperStopping = false;
let helperBackoff = HELPER_RETRY_MIN_MS, helperStartedAt = 0;
let mediaMeta = null, mediaMetaAt = 0;

// The helper answers "art" strictly in order, one line each, on one thread, so
// the n-th ART line belongs to the n-th request. A timed-out request keeps its
// slot so its late reply is discarded instead of landing on the next track.
let artQueue = [];   // { resolve, timer, done }

function settleArtWaiters(b64) {
  const queue = artQueue;
  artQueue = [];
  for (const e of queue) {
    if (e.done) continue;
    e.done = true;
    clearTimeout(e.timer);
    e.resolve(b64);
  }
}

function onArtLine(b64) {
  const e = artQueue.shift();
  if (!e || e.done) return;
  e.done = true;
  clearTimeout(e.timer);
  e.resolve(b64);
}

function onHelperLine(line) {
  if (line.startsWith('ANGLE ')) {
    const [angle, baseMotion] = line.slice(6).split(' ').map(parseFloat);
    if (Number.isFinite(angle)) applyHinge(angle, Number.isFinite(baseMotion) ? baseMotion : 0);
  } else if (line.startsWith('META ')) {
    mediaMetaAt = Date.now();
    try {
      const d = JSON.parse(line.slice(5));
      mediaMeta = d && d.title ? d : null;
    } catch (_) { mediaMeta = null; }
  } else if (line.startsWith('ART ')) {
    onArtLine(line.slice(4).trim());
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
  helperStartedAt = Date.now();

  // The helper is gone, for whatever reason: nothing it owed is coming, so
  // settle it all now and schedule the next attempt.
  const gone = why => {
    if (helperProc !== proc) return;
    helperProc = null;
    mediaMeta = null;
    settleArtWaiters('');
    settleShotWaiters();
    disarm();
    if (helperStopping) return;
    if (Date.now() - helperStartedAt > HELPER_STABLE_MS) helperBackoff = HELPER_RETRY_MIN_MS;
    console.log('[WinNotch] helper', why, '- restarting in', helperBackoff, 'ms');
    helperRestartTimer = setTimeout(startHelper, helperBackoff);
    helperBackoff = Math.min(helperBackoff * 2, HELPER_RETRY_MAX_MS);
  };

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
  // A spawn failure emits 'error' and maybe no 'exit'. An 'error' on a running
  // process is only a failed signal, and must not start a second one.
  proc.on('error', e => {
    console.log('[WinNotch] helper unavailable:', e.message);
    if (proc.pid === undefined) gone('failed to start');
  });
  proc.on('exit', code => gone('exited: ' + code));

  if (hingeWanted) sendHelperCommand('hinge on');
}

function stopHelper() {
  helperStopping = true;
  clearTimeout(helperRestartTimer);
  settleArtWaiters('');
  settleShotWaiters();
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
    const e = { resolve, timer: null, done: false };
    // Settled but left queued: see artQueue.
    e.timer = setTimeout(() => { e.done = true; resolve(''); }, ART_TIMEOUT_MS);
    artQueue.push(e);
  });
}

// ── YouTube Thumbnail Extractor ───────────────────────────────────────────────
// A thumbnail server that stalls, or answers with something huge, must not hold
// a socket or memory for the life of the app.
const ART_FETCH_TIMEOUT_MS = 8000, ART_LOOKUP_TIMEOUT_MS = 15000, ART_MAX_BYTES = 5 * 1024 * 1024;

async function fetchImageAsBase64(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = b64 => { if (!settled) { settled = true; resolve(b64); } };
    let req;
    try {
      req = https.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); finish(''); return; }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > ART_MAX_BYTES) { req.destroy(); finish(''); return; }
          chunks.push(chunk);
        });
        res.on('end', () => finish(Buffer.concat(chunks).toString('base64')));
        res.on('error', () => finish(''));
        res.on('close', () => finish(''));
      });
    } catch (_) { finish(''); return; }   // e.g. an http: URL throws synchronously
    req.setTimeout(ART_FETCH_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', () => finish(''));
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
let _cachedKey = '', _cachedB64 = '';
// artKey -> the fetch already under way for it, so a repeat ask joins it
// rather than sending the helper a second "art".
const artInFlight = new Map();

function artKeyOf(d) { return d ? d.title + '||' + d.artist + '||' + d.album + '||' + d.src : ''; }

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
    // The reading is older now than when the helper sent it.
    posAge:  Math.max(0, Number(d.posAge) || 0) + (Date.now() - mediaMetaAt),
    src:     String(d.src || ''),
    artKey:  artKeyOf(d),
  };
});

async function fetchArt(key, meta) {
  try {
    let b64 = await requestArt();
    if (!b64 && meta?.src && meta?.title) {
      const src = String(meta.src).toLowerCase();
      const isBrowser = src.includes('chrome') || src.includes('edge') || src.includes('firefox') || src.includes('msedge');
      if (isBrowser) {
        let timer;
        b64 = await Promise.race([
          getYouTubeThumbnail(String(meta.title)),
          new Promise(r => { timer = setTimeout(() => r(''), ART_LOOKUP_TIMEOUT_MS); }),
        ]);
        clearTimeout(timer);
      }
    }
    // The helper always returns the CURRENT track's art, so a late request for an
    // older key would otherwise file the new track's picture under the old key
    // and evict the right one.
    if (b64 && key === artKeyOf(mediaMeta)) { _cachedKey = key; _cachedB64 = b64; }
    return b64 || '';
  } catch (_) { return ''; }
}

ipcMain.handle('get-art', (_, artKey, meta) => {
  if (process.platform !== 'win32') return '';
  const key = String(artKey);
  if (key === _cachedKey && _cachedB64) return _cachedB64;
  if (artInFlight.has(key)) return artInFlight.get(key);
  const p = fetchArt(key, meta).finally(() => artInFlight.delete(key));
  artInFlight.set(key, p);
  return p;
});

ipcMain.handle('media-cmd', (_, cmd) => {
  if (process.platform !== 'win32') return false;
  return sendHelperCommand(MEDIA_CMDS.has(cmd) ? cmd : 'toggle');
});

// The notch's glass refracts the desktop, and a transparent window can't read
// what's behind it, so the page asks for a snapshot as the panel opens. Same
// grab the lid effect uses: the native helper, tens of milliseconds.
// ── Claude Code agents ────────────────────────────────────────────────────────
// What the notch shows about agents comes from Claude Code's own files; see
// agent-scan.js. Watching is passive and costs nothing when nothing is running,
// so it starts with the app and simply pushes a snapshot when one changes.
let lastAgents = { at: 0, sessions: [], totals: { sessions: 0, busy: 0, agents: 0, running: 0, stalled: 0, done: 0 } };
let stopAgentWatch = null;

function startAgentWatch() {
  if (stopAgentWatch) return;
  try {
    stopAgentWatch = agentScan.watch(snap => {
      lastAgents = snap;
      if (win && !win.isDestroyed()) win.webContents.send('agents', snap);
    });
  } catch (e) {
    console.log('[WinNotch] agent watch unavailable:', e.message);
  }
}

// The renderer asks once on load, since it may come up after the first snapshot.
ipcMain.handle('agents-now', () => lastAgents);

ipcMain.handle('desktop-shot', async () => {
  try { return await captureDesktop(); } catch (_) { return null; }
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

// ── Claude Code permission prompts ───────────────────────────────────────────
// hook-relay.js runs as Claude Code's PermissionRequest hook and hands the
// request over a named pipe. Per launch, a random pipe name and a random 32-byte
// secret are written to HOOK_FILE (under the user profile, so only this user,
// SYSTEM and admins can read it). The relay reads it, connects and sends
// {"kind":"hello","nonce":<hex>}; the server answers {"proof":hmac} with
// hmac = HMAC-SHA256(secret, 'winnotch-hook:' + nonce) in hex, and only then does
// the relay send the request line. The one decision line back carries
// mac = HMAC-SHA256(secret, 'decision:' + nonce + ':' + decision), and the relay
// ignores a decision without a valid one. So a process squatting a pipe name (a
// stale file after a crash, or no notch running) can neither read the request
// nor answer it, and one relaying between the hook and the real notch cannot
// change the answer.
//
// Claude Code sits blocked on that relay for as long as it takes, so the one
// rule here is that every socket gets an answer. The renderer answers, or the
// timer below answers "ask" for it — which the relay reads as "let the terminal
// handle it", the same thing it does when the app isn't running at all.
const HOOK_PIPE_PREFIX = '\\\\.\\pipe\\winnotch-hook-';
const HOOK_FILE = path.join(os.homedir(), '.claude', 'winnotch-hook.json');
// A client that connects and never finishes the handshake is answered and closed.
const HOOK_HANDSHAKE_MS = 10000;
// Just past the relay's own 110s wait, so in practice the relay has already
// fallen back to the terminal by the time this fires. It exists so a socket
// nobody answered can't sit in the map for the life of the app.
const PERMISSION_ASK_MS = 115000;
// Nothing a hook sends is anywhere near this big; a client that keeps writing
// without a newline gets dropped rather than buffered forever.
const PERMISSION_MAX_LINE = 256 * 1024;
const PERMISSION_DECISIONS = new Set(['allow', 'always', 'deny', 'ask']);

// The secret lives only in startHookServer's closure, one per server, so a socket
// still open after a stop can never meet a missing key.
let hookServer = null, hookSeq = 0, hookPipe = null;
const pendingPermissions = new Map();

// A hidden (disabled hides it) or still-loading notch can't show the card, so the
// session shouldn't wait out the relay's timeout. No settings.enabled check: tray
// Show can put the notch on screen while enabled is false, and then it can.
function canPrompt() {
  return !!(win && !win.isDestroyed() && win.isVisible() && winReady);
}

// The card for this prompt is showing, and its question is gone: take it down.
function permissionGone(id) {
  try { if (win && !win.isDestroyed()) win.webContents.send('permission-gone', id); } catch (_) {}
}

// Writes the one reply line and closes. end() rather than write() because the
// relay is done the moment it has the line, and a socket left open is a session
// left waiting. answeredHere: the notch itself answered, so its card is already
// gone and needs no notice.
function finishPermission(id, decision, answeredHere) {
  const pending = pendingPermissions.get(id);
  if (!pending) return false;   // already answered, or timed out
  pendingPermissions.delete(id);
  clearTimeout(pending.timer);
  const safe = PERMISSION_DECISIONS.has(decision) ? decision : 'ask';
  try {
    pending.socket.end(JSON.stringify({
      decision: safe,
      mac: pending.mac('decision:' + pending.nonce + ':' + safe),
    }) + '\n');
  } catch (_) {
    try { pending.socket.destroy(); } catch (_) {}
  }
  if (!answeredHere) permissionGone(id);
  return true;
}

// Replaced in one rename, so the relay never reads half a file.
function writeHookFile(pipe, secret) {
  try {
    fs.mkdirSync(path.dirname(HOOK_FILE), { recursive: true });
    fs.writeFileSync(HOOK_FILE + '.tmp', JSON.stringify({ pipe, secret }));
    fs.renameSync(HOOK_FILE + '.tmp', HOOK_FILE);
  } catch (e) {
    console.log('[WinNotch] could not write the hook file:', e.message);
  }
}

function startHookServer() {
  // The pipe name is Windows syntax, and so is the relay; elsewhere it would
  // only leave a stray socket file behind.
  if (process.platform !== 'win32' || hookServer) return;
  const secret = crypto.randomBytes(32).toString('hex');
  const mac = text => crypto.createHmac('sha256', secret).update(text).digest('hex');
  const pipe = HOOK_PIPE_PREFIX + crypto.randomBytes(16).toString('hex');
  hookPipe = pipe;

  const server = net.createServer(sock => {
    // 'hello' -> 'request' -> 'done'. Nothing is read from the request until
    // the client has been shown we hold the secret.
    let buf = '', stage = 'hello', nonce = null;
    // Anything we can't turn into a question for the notch is answered "ask".
    const askNow = () => {
      try { sock.end('{"decision":"ask"}\n'); } catch (_) { try { sock.destroy(); } catch (_) {} }
    };
    // The socket went away on its own: drop whatever it was waiting on, so a
    // run of cancelled prompts can't grow the map, and take its card down.
    const forget = () => {
      for (const [id, pending] of pendingPermissions) {
        if (pending.socket === sock) {
          clearTimeout(pending.timer);
          pendingPermissions.delete(id);
          permissionGone(id);
        }
      }
    };

    const onRequest = req => {
      if (!req || req.kind !== 'permission') { askNow(); return; }
      if (!canPrompt()) { askNow(); return; }

      sock.setTimeout(0);   // the pending timer owns this socket from here
      const id = String(++hookSeq);
      pendingPermissions.set(id, {
        socket: sock,
        timer: setTimeout(() => finishPermission(id, 'ask'), PERMISSION_ASK_MS),
        nonce,
        mac,
      });
      try {
        win.webContents.send('permission', {
          id,
          tool: req.tool,
          input: req.input,
          project: req.project,
          cwd: req.cwd,
          sessionId: req.sessionId,
        });
      } catch (e) {
        console.log('[WinNotch] could not show a permission prompt:', e.message);
        finishPermission(id, 'ask');
      }
    };

    sock.setTimeout(HOOK_HANDSHAKE_MS);
    sock.on('timeout', () => { if (stage !== 'done') { stage = 'done'; askNow(); } });

    sock.on('data', chunk => {
      if (stage === 'done') return;   // one request per connection
      buf += chunk.toString('utf8');
      let nl;
      while (stage !== 'done' && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (_) { msg = null; }
        if (stage === 'hello') {
          if (!(msg && msg.kind === 'hello' && typeof msg.nonce === 'string' && /^[0-9a-f]{32,128}$/.test(msg.nonce))) {
            stage = 'done'; askNow(); return;
          }
          stage = 'request';
          nonce = msg.nonce;
          sock.write(JSON.stringify({ proof: mac('winnotch-hook:' + nonce) }) + '\n');
        } else {
          stage = 'done'; onRequest(msg); return;
        }
      }
      if (stage !== 'done' && buf.length > PERMISSION_MAX_LINE) { stage = 'done'; askNow(); }
    });

    sock.on('close', forget);
    sock.on('error', () => { forget(); try { sock.destroy(); } catch (_) {} });
  });

  // A stale pipe or a second copy of the app: the notch just can't answer
  // prompts this run, and the relay falls back to the terminal by itself. Never
  // a reason to stop starting up.
  server.on('error', e => {
    console.log('[WinNotch] hook pipe unavailable:', e.message);
    if (hookServer === server) { hookPipe = null; hookServer = null; }
    try { server.close(); } catch (_) {}
  });

  // Published only once the pipe is actually there to connect to, and not at
  // all if the server was stopped meanwhile.
  server.listen(pipe, () => { if (hookServer === server) writeHookFile(pipe, secret); });
  hookServer = server;
}

function stopHookServer() {
  // Answer everything still open before the process goes: a hung socket is a
  // Claude Code session stuck on a prompt that can no longer be shown. If the
  // write doesn't make it out in time the relay sees the close and falls back
  // to the terminal anyway.
  for (const id of [...pendingPermissions.keys()]) finishPermission(id, 'ask');
  if (hookServer) {
    try { hookServer.close(); } catch (_) {}
    hookServer = null;
  }
  // Remove the hook file only while it still names our pipe; a newer copy of the
  // app may have written its own since.
  if (hookPipe) {
    try {
      const f = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
      if (f && f.pipe === hookPipe) fs.unlinkSync(HOOK_FILE);
    } catch (_) {}
    hookPipe = null;
  }
}

// The notch answering a prompt. Returns false if the question is already gone —
// it timed out, or the session was cancelled — so the panel can close itself.
ipcMain.handle('permission-answer', (_, { id, decision } = {}) => finishPermission(String(id), decision, true));

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WinNotch');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'WinNotch', enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Show', click: () => win?.showInactive() },
    { label: 'Hide', click: () => win?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ]));
  tray.on('double-click', () => win?.isVisible() ? win.hide() : win?.showInactive());
}

// The one way out, from the tray and from settings alike. settings:quit used to
// skip stopHookServer, leaving pending sessions and the hook file behind.
function quitApp() {
  stopHingeSensor();
  stopHelper();
  if (stopAgentWatch) { stopAgentWatch(); stopAgentWatch = null; }
  stopHookServer();
  if (tray) tray.destroy();
  app.exit(0);
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
  startAgentWatch();
  startHookServer();
  applySettings();   // starts the hinge sensor too, if it's enabled
});

app.on('window-all-closed', e => e.preventDefault());

app.on('before-quit', () => {
  stopHingeSensor();
  stopHelper();
  if (stopAgentWatch) { stopAgentWatch(); stopAgentWatch = null; }
  stopHookServer();
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