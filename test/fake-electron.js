'use strict';
// Loads src/main.js under a stand-in `electron`, so the main process can be
// driven from node:test: every ipcMain handler is captured, every window records
// what was done to it, and child_process.spawn hands back a fake helper whose
// stdout the test writes to. Not a test file itself (npm test lists files).
//
// main.js computes HOOK_FILE from os.homedir() when it loads. The caller must
// point USERPROFILE/HOME at a temp dir first; loadMain refuses to run otherwise,
// because the real ~/.claude/winnotch-hook.json belongs to a running notch.

const Module = require('module');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');

let nextElectron = null;
let ytSearch = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    if (!nextElectron) throw new Error('electron required outside loadMain');
    return nextElectron;
  }
  if (request === 'yt-search' && ytSearch) return ytSearch;
  return realLoad.apply(this, arguments);
};

// main.js requires yt-search lazily, so this can be swapped per test.
function setYtSearch(fn) { ytSearch = fn; }

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.sent = []; this.reloads = 0; this.openHandler = null; }
  send(channel, ...args) { this.sent.push([channel, ...args]); }
  reload() { this.reloads++; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  sentOn(channel) { return this.sent.filter(s => s[0] === channel).map(s => s[1]); }
}

class FakeWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.webContents = new FakeWebContents();
    this.visible = this.opts.show !== false;   // Electron's default is to show
    this.destroyed = false;
    this.calls = [];
  }
  rec(name, args) { this.calls.push([name, ...args]); }
  callsOf(name) { return this.calls.filter(c => c[0] === name).map(c => c.slice(1)); }
  loadFile(...a) { this.rec('loadFile', a); }
  setIgnoreMouseEvents(...a) { this.rec('setIgnoreMouseEvents', a); }
  setAlwaysOnTop(...a) { this.rec('setAlwaysOnTop', a); }
  setVisibleOnAllWorkspaces(...a) { this.rec('setVisibleOnAllWorkspaces', a); }
  setBounds(...a) { this.rec('setBounds', a); }
  setContentProtection(...a) { this.rec('setContentProtection', a); }
  show() { this.rec('show', []); this.visible = true; }
  showInactive() { this.rec('showInactive', []); this.visible = true; }
  hide() { this.rec('hide', []); this.visible = false; }
  focus() { this.rec('focus', []); }
  restore() { this.rec('restore', []); }
  isMinimized() { return false; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getBounds() { return { x: 0, y: 0, width: 1920, height: 480 }; }
}

// A stand-in for the native helper process.
function fakeProc(cmd) {
  const p = new EventEmitter();
  p.cmd = cmd;
  p.pid = 4242;
  p.exitCode = null;
  p.written = [];
  p.stdout = new EventEmitter();
  p.stdout.setEncoding = () => {};
  p.stderr = new EventEmitter();
  p.stdin = new EventEmitter();
  p.stdin.writable = true;
  p.stdin.write = s => { p.written.push(s); return true; };
  p.stdin.end = () => { p.stdin.writable = false; };
  p.kill = () => { p.killed = true; };
  p.line = s => p.stdout.emit('data', s + '\n');
  p.commands = name => p.written.filter(w => w === name + '\n' || w.startsWith(name + ' ')).length;
  return p;
}

function makeElectron(userData) {
  const handlers = {}, listeners = {};
  const windows = [], trays = [], procs = [];
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.quit = () => { app.quitCalled = true; };
  app.exit = code => { app.exitCode = code; };
  app.getPath = () => userData;
  app.whenReady = () => ready;
  app.setLoginItemSettings = s => { app.loginItem = s; };

  const ipcMain = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { listeners[ch] = fn; },
  };

  class BrowserWindow extends FakeWindow {
    constructor(opts) { super(opts); windows.push(this); }
  }

  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
  screen.getCursorScreenPoint = () => ({ x: 10, y: 10 });

  class Tray extends EventEmitter {
    constructor(img) { super(); this.img = img; this.destroyed = false; trays.push(this); }
    setToolTip(t) { this.tip = t; }
    setContextMenu(m) { this.menu = m; }
    destroy() { this.destroyed = true; }
    item(label) { return this.menu.find(i => i.label === label); }
  }

  const powerMonitor = new EventEmitter();
  powerMonitor.onBatteryPower = false;

  const electron = {
    app, ipcMain, BrowserWindow, screen, Tray, powerMonitor,
    Menu: { buildFromTemplate: t => t },
    nativeImage: { createEmpty: () => ({ empty: true }) },
    desktopCapturer: { getSources: async () => [] },
  };
  const spawn = (cmd) => { const p = fakeProc(cmd); procs.push(p); return p; };
  return { electron, app, handlers, listeners, windows, trays, procs, spawn, resolveReady };
}

let loads = 0;
const live = new Set();

// Loads a fresh copy of main.js. `ready` runs app.whenReady (window, tray, helper,
// hook server...); `loaded` then reports both pages as finished loading.
async function loadMain({ home, ready = true, loaded = true, settingsJson } = {}) {
  if (!home || os.homedir() !== home) {
    throw new Error('refusing to load main.js: os.homedir() is ' + os.homedir() + ', not the test home ' + home);
  }
  const userData = path.join(home, 'userData-' + (++loads));
  fs.mkdirSync(userData, { recursive: true });
  if (settingsJson !== undefined) fs.writeFileSync(path.join(userData, 'settings.json'), settingsJson);

  const f = makeElectron(userData);
  const mainPath = path.join(SRC, 'main.js');
  delete require.cache[require.resolve(mainPath)];
  const realSpawn = cp.spawn;
  nextElectron = f.electron;
  cp.spawn = f.spawn;   // main.js destructures spawn when it loads
  try { require(mainPath); }
  finally { cp.spawn = realSpawn; nextElectron = null; }

  const inst = {
    ...f,
    userData,
    settingsFile: path.join(userData, 'settings.json'),
    get win() { return f.windows[0]; },
    get blurWin() { return f.windows[1]; },
    get tray() { return f.trays[0]; },
    get helper() { return f.procs[f.procs.length - 1]; },
    invoke: (ch, ...args) => f.handlers[ch]({}, ...args),
    emit: (ch, ...args) => f.listeners[ch]({}, ...args),
    quit() { live.delete(inst); f.app.emit('before-quit'); },
  };
  live.add(inst);
  if (ready) {
    f.resolveReady();
    await flush();
    if (loaded) {
      inst.win.webContents.emit('did-finish-load');
      inst.blurWin.webContents.emit('did-finish-load');
    }
  }
  return inst;
}

// Stops every instance a test left running, so no server or interval outlives it.
function quitAll() { for (const inst of [...live]) inst.quit(); }

// One pass of the event loop (setImmediate is never mocked by these tests).
function flush(n = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

// Polls without timers, so it works while setTimeout is mocked.
async function until(cond, ms = 3000, what = 'condition') {
  const end = performance.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (performance.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setImmediate(r));
  }
}

module.exports = { SRC, loadMain, quitAll, flush, until, setYtSearch };
