'use strict';
// Drives src/main.js under a fake electron (see fake-electron.js): settings
// validation, the permission pipe and its handshake, helper restarts, album art,
// renderer crash recovery and the lid-blur watchdog. Real named pipes, fake
// windows; node:test mock timers wherever a deadline matters.

const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { EventEmitter } = require('node:events');

// Before anything loads main.js: it derives HOOK_FILE from the home directory,
// and the real ~/.claude/winnotch-hook.json belongs to a running notch.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'winnotch-main-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
assert.strictEqual(os.homedir(), HOME, 'home must be the temp dir before main.js loads');
fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
const HOOK_FILE = path.join(HOME, '.claude', 'winnotch-hook.json');
const PREFIX = '\\\\.\\pipe\\winnotch-hook-';

const { loadMain, quitAll, flush, until, setYtSearch } = require('./fake-electron');

// main.js narrates restarts and crashes; keep the test output readable.
const realLog = console.log;
console.log = (...a) => { if (!String(a[0]).startsWith('[WinNotch]')) realLog(...a); };

const DEFAULTS = { enabled: true, lidBlur: true, startup: false, workspaces: true, fullscreen: true };
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
const hex = n => crypto.randomBytes(n).toString('hex');
const ASK = '{"decision":"ask"}';

function mockClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
}

// Loads main.js, stops it after the test, and waits for the hook file it writes.
const seenPipes = new Set();
async function boot(t, opts = {}) {
  try { fs.unlinkSync(HOOK_FILE); } catch {}
  const inst = await loadMain({ home: HOME, ...opts });
  t.after(() => inst.quit());
  if (opts.ready !== false && opts.hook !== false) {
    inst.hook = await until(() => {
      try {
        const f = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
        if (f && !seenPipes.has(f.pipe)) { seenPipes.add(f.pipe); return f; }
      } catch {}
      return null;
    }, 3000, 'the hook file');
  }
  return inst;
}

function client(pipe) {
  const sock = net.createConnection(pipe);
  const c = { sock, lines: [], buf: '', closed: false, error: null, connected: false };
  sock.setEncoding('utf8');
  sock.on('connect', () => { c.connected = true; });
  sock.on('data', d => {
    c.buf += d;
    let nl;
    while ((nl = c.buf.indexOf('\n')) >= 0) { c.lines.push(c.buf.slice(0, nl)); c.buf = c.buf.slice(nl + 1); }
  });
  sock.on('close', () => { c.closed = true; });
  sock.on('error', e => { c.error = e; });
  c.send = v => sock.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\n');
  c.line = (i, ms) => until(() => c.lines.length > i, ms || 3000, 'reply line ' + i).then(() => c.lines[i]);
  return c;
}

const REQUEST = { kind: 'permission', tool: 'Bash', input: { command: 'npm test' }, project: 'p', cwd: 'C:\\p', sessionId: 's1' };

// Says hello and checks the proof; returns the nonce.
async function hello(c, secret) {
  const nonce = hex(16);
  c.send({ kind: 'hello', nonce });
  const reply = JSON.parse(await c.line(0));
  assert.strictEqual(reply.proof, hmac(secret, 'winnotch-hook:' + nonce), 'proof from the secret in the hook file');
  return nonce;
}

// A full handshake and request; resolves once the card was sent to the notch.
async function prompt(inst) {
  const c = client(inst.hook.pipe);
  const nonce = await hello(c, inst.hook.secret);
  const before = inst.win.webContents.sentOn('permission').length;
  c.send(REQUEST);
  const req = await until(() => inst.win.webContents.sentOn('permission')[before], 3000, 'the permission card');
  return { c, nonce, id: req.id, req };
}

// A refusal: exactly one bare ask line, then the socket closes.
async function refused(c, index = 0) {
  assert.strictEqual(await c.line(index), ASK);
  await until(() => c.closed, 3000, 'socket close');
  assert.strictEqual(c.lines.length, index + 1, 'nothing after the ask');
}

function decisionOf(line, secret, nonce) {
  const d = JSON.parse(line);
  assert.strictEqual(d.mac, hmac(secret, 'decision:' + nonce + ':' + d.decision), 'decision carries its mac');
  return d.decision;
}

nodeTest.after(() => {
  quitAll();
  console.log = realLog;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ── settings (finding 14) ─────────────────────────────────────────────────────

test('E1 settings:set refuses prototype keys: nothing stored, nothing written, prototype untouched', async t => {
  const inst = await boot(t, { hook: false });
  for (const [k, v] of [['__proto__', { polluted: true }], ['constructor', true], ['toString', 'x'], ['hasOwnProperty', false]]) {
    const r = await inst.invoke('settings:set', k, v);
    assert.deepStrictEqual({ ...r }, DEFAULTS, 'refused ' + k);
    assert.strictEqual(Object.getPrototypeOf(r), Object.prototype, 'prototype of settings after ' + k);
  }
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype untouched');
  assert.strictEqual(fs.existsSync(inst.settingsFile), false, 'a refused set writes nothing');
  // Control: a real key of the right type is stored and written.
  const ok = await inst.invoke('settings:set', 'lidBlur', false);
  assert.strictEqual(ok.lidBlur, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(inst.settingsFile, 'utf8')).lidBlur, false);
});

test('E2 settings:set refuses a value of the wrong type', async t => {
  const inst = await boot(t, { hook: false });
  for (const [k, v] of [['enabled', 'false'], ['enabled', 0], ['lidBlur', null], ['startup', 'yes'], [5, true]]) {
    const r = await inst.invoke('settings:set', k, v);
    assert.deepStrictEqual({ ...r }, DEFAULTS, 'refused ' + k + '=' + JSON.stringify(v));
  }
  assert.strictEqual(fs.existsSync(inst.settingsFile), false);
});

test('E3 a tampered settings file keeps only our keys with our types', async t => {
  const inst = await boot(t, { hook: false, settingsJson: '{"enabled":"no","__proto__":{"x":1},"lidBlur":false,"extra":true}' });
  const s = await inst.invoke('settings:get');
  assert.deepStrictEqual({ ...s }, { ...DEFAULTS, lidBlur: false });
  assert.strictEqual(Object.getPrototypeOf(s), Object.prototype);
  assert.strictEqual(s.x, undefined);
  assert.ok(!Object.hasOwn(s, '__proto__'));
});

test('E3 a settings file that is not an object falls back to defaults', async t => {
  for (const body of ['[{"enabled":false}]', '"enabled"', 'null', '{nope']) {
    const inst = await boot(t, { hook: false, settingsJson: body });
    assert.deepStrictEqual({ ...(await inst.invoke('settings:get')) }, DEFAULTS, body);
    inst.quit();
  }
});

// ── window behaviour (findings 18, 22, 23, 9) ─────────────────────────────────

test('finding 18: blur and focus re-pin at the level the settings ask for', async t => {
  const inst = await boot(t, { hook: false });
  await inst.invoke('settings:set', 'fullscreen', false);
  let n = inst.win.callsOf('setAlwaysOnTop').length;
  inst.win.emit('blur');
  inst.win.emit('focus');
  assert.deepStrictEqual(inst.win.callsOf('setAlwaysOnTop').slice(n), [[true, 'normal', 1], [true, 'normal', 1]]);
  await inst.invoke('settings:set', 'fullscreen', true);
  n = inst.win.callsOf('setAlwaysOnTop').length;
  inst.win.emit('blur');
  assert.deepStrictEqual(inst.win.callsOf('setAlwaysOnTop').slice(n), [[true, 'screen-saver', 1]]);
});

test('finding 23: the notch is never shown with focus (settings, tray Show, tray double-click)', async t => {
  const inst = await boot(t, { hook: false });
  await inst.invoke('settings:set', 'enabled', false);
  assert.strictEqual(inst.win.visible, false);
  await inst.invoke('settings:set', 'enabled', true);
  assert.strictEqual(inst.win.visible, true);
  assert.strictEqual(inst.win.callsOf('showInactive').length, 1);
  inst.tray.item('Hide').click();
  inst.tray.item('Show').click();
  assert.strictEqual(inst.win.visible, true);
  inst.tray.emit('double-click');
  assert.strictEqual(inst.win.visible, false);
  inst.tray.emit('double-click');
  assert.strictEqual(inst.win.visible, true);
  assert.strictEqual(inst.win.callsOf('showInactive').length, 3);
  assert.strictEqual(inst.win.callsOf('show').length, 0, 'show() takes focus');
});

test('E52 a second launch opens settings (and reuses the window)', async t => {
  const inst = await boot(t, { hook: false });
  const n = inst.windows.length;
  inst.app.emit('second-instance');
  assert.strictEqual(inst.windows.length, n + 1);
  const sw = inst.windows[n];
  assert.ok(sw.callsOf('loadFile')[0][0].endsWith('settings.html'));
  sw.emit('ready-to-show');
  assert.strictEqual(sw.visible, true);
  inst.app.emit('second-instance');
  assert.strictEqual(inst.windows.length, n + 1, 'no second settings window');
  assert.strictEqual(sw.callsOf('focus').length, 1);
});

test('E53 every web contents refuses navigation and new windows', async t => {
  const inst = await boot(t, { hook: false });
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = fn => { contents.openHandler = fn; };
  inst.app.emit('web-contents-created', {}, contents);
  let prevented = 0;
  contents.emit('will-navigate', { preventDefault: () => { prevented++; } }, 'https://evil.example');
  assert.strictEqual(prevented, 1);
  assert.deepStrictEqual(contents.openHandler({ url: 'https://evil.example' }), { action: 'deny' });
});

// ── hook file ─────────────────────────────────────────────────────────────────

test('the hook file names a random pipe and a random secret, fresh each launch', async t => {
  const a = await boot(t);
  assert.deepStrictEqual(Object.keys(a.hook).sort(), ['pipe', 'secret']);
  assert.match(a.hook.pipe, /^\\\\\.\\pipe\\winnotch-hook-[0-9a-f]{32}$/);
  assert.match(a.hook.secret, /^[0-9a-f]{64}$/);
  a.quit();
  const b = await boot(t);
  assert.notStrictEqual(b.hook.pipe, a.hook.pipe);
  assert.notStrictEqual(b.hook.secret, a.hook.secret);
});

test('stopping removes the hook file only while it still names our pipe', async t => {
  const a = await boot(t);
  a.quit();
  assert.strictEqual(fs.existsSync(HOOK_FILE), false, 'our own file is removed');
  const b = await boot(t);
  const other = JSON.stringify({ pipe: PREFIX + 'f'.repeat(32), secret: 'a'.repeat(64) });
  fs.writeFileSync(HOOK_FILE, other);   // a newer copy of the app took over
  b.quit();
  assert.strictEqual(fs.readFileSync(HOOK_FILE, 'utf8'), other, 'someone else\'s file is left alone');
  fs.unlinkSync(HOOK_FILE);
});

test('a server stopped before it is listening never publishes a hook file', async t => {
  try { fs.unlinkSync(HOOK_FILE); } catch {}
  const inst = await loadMain({ home: HOME, ready: false });
  inst.resolveReady();
  // Runs straight after main's own whenReady callback, before the pipe is up.
  await inst.app.whenReady().then(() => inst.quit());
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(fs.existsSync(HOOK_FILE), false);
});

// ── the handshake (findings 4, 5) ─────────────────────────────────────────────

test('E10 a request without a hello is answered ask, and nothing is shown', async t => {
  const inst = await boot(t);
  const c = client(inst.hook.pipe);
  c.send(REQUEST);
  await refused(c);
  assert.strictEqual(inst.win.webContents.sentOn('permission').length, 0);
});

test('E11 a bad nonce is answered ask, with no proof', async t => {
  const inst = await boot(t);
  for (const nonce of ['xyz', 'a'.repeat(31), 'a'.repeat(129), 5, 'A'.repeat(32), null]) {
    const c = client(inst.hook.pipe);
    c.send({ kind: 'hello', nonce });
    await refused(c);
  }
  const c = client(inst.hook.pipe);
  c.send({ kind: 'hi', nonce: hex(16) });
  await refused(c);
  // The boundaries themselves are fine.
  for (const n of ['a'.repeat(32), 'b'.repeat(128)]) {
    const ok = client(inst.hook.pipe);
    ok.send({ kind: 'hello', nonce: n });
    assert.strictEqual(JSON.parse(await ok.line(0)).proof, hmac(inst.hook.secret, 'winnotch-hook:' + n));
    ok.sock.destroy();
  }
  assert.strictEqual(inst.win.webContents.sentOn('permission').length, 0);
});

test('E14 hello and request in one chunk: proof, then the card', async t => {
  const inst = await boot(t);
  const c = client(inst.hook.pipe);
  const nonce = hex(16);
  c.sock.write(JSON.stringify({ kind: 'hello', nonce }) + '\n' + JSON.stringify(REQUEST) + '\n');
  assert.strictEqual(JSON.parse(await c.line(0)).proof, hmac(inst.hook.secret, 'winnotch-hook:' + nonce));
  const req = await until(() => inst.win.webContents.sentOn('permission')[0], 3000, 'card');
  assert.deepStrictEqual(req, { id: req.id, tool: 'Bash', input: { command: 'npm test' }, project: 'p', cwd: 'C:\\p', sessionId: 's1' });
  assert.strictEqual(await inst.invoke('permission-answer', { id: req.id, decision: 'deny' }), true);
  assert.strictEqual(decisionOf(await c.line(1), inst.hook.secret, nonce), 'deny');
});

test('E13 a line over 256 KB without a newline is answered ask, in either stage', async t => {
  const inst = await boot(t);
  const LIMIT = 256 * 1024;
  const a = client(inst.hook.pipe);
  a.sock.write('x'.repeat(LIMIT));          // at the limit: still waiting
  const end = performance.now() + 300;
  await until(() => performance.now() > end || a.lines.length, 1000);
  assert.strictEqual(a.lines.length, 0, 'exactly 256 KB is not over the limit');
  a.sock.write('x');
  await refused(a);
  const b = client(inst.hook.pipe);
  await hello(b, inst.hook.secret);
  b.sock.write('y'.repeat(LIMIT + 1));
  await refused(b, 1);
  assert.strictEqual(inst.win.webContents.sentOn('permission').length, 0);
});

test('E57 a client that never says hello, or never sends the request, is answered and closed at 10 s', async t => {
  const inst = await boot(t);
  const t0 = performance.now();
  const mute = client(inst.hook.pipe);
  const half = client(inst.hook.pipe);
  await hello(half, inst.hook.secret);
  await until(() => mute.closed && half.closed, 14000, 'both sockets closed');
  assert.ok(performance.now() - t0 > 9000, 'not before the handshake deadline');
  assert.deepStrictEqual(mute.lines, [ASK]);
  assert.strictEqual(half.lines[1], ASK);
  assert.strictEqual(half.lines.length, 2);
});

test('E12 a hidden notch answers ask at once and shows nothing', async t => {
  const inst = await boot(t);
  await inst.invoke('settings:set', 'enabled', false);
  const c = client(inst.hook.pipe);
  await hello(c, inst.hook.secret);
  c.send(REQUEST);
  await refused(c, 1);
  assert.strictEqual(inst.win.webContents.sentOn('permission').length, 0);
});

test('E12 a notch page that is (re)loading answers ask; once loaded it shows the card', async t => {
  const inst = await boot(t, { loaded: false });
  const c = client(inst.hook.pipe);
  await hello(c, inst.hook.secret);
  c.send(REQUEST);
  await refused(c, 1);
  inst.win.webContents.emit('did-finish-load');
  const { id } = await prompt(inst);
  await inst.invoke('permission-answer', { id, decision: 'ask' });
  inst.win.webContents.emit('did-start-loading');
  const d = client(inst.hook.pipe);
  await hello(d, inst.hook.secret);
  d.send(REQUEST);
  await refused(d, 1);
  assert.strictEqual(inst.win.webContents.sentOn('permission').length, 1);
});

test('E12 a request that is not a permission is answered ask', async t => {
  const inst = await boot(t);
  for (const body of [{ ...REQUEST, kind: 'other' }, 'not json']) {
    const c = client(inst.hook.pipe);
    await hello(c, inst.hook.secret);
    c.send(body);
    await refused(c, 1);
  }
  assert.strictEqual(inst.win.webContents.sentOn('permission').length, 0);
});

test('E65 tray Show while disabled puts the notch up, and prompts then show', async t => {
  const inst = await boot(t);
  await inst.invoke('settings:set', 'enabled', false);
  inst.tray.item('Show').click();
  const { c, nonce, id } = await prompt(inst);
  await inst.invoke('permission-answer', { id, decision: 'allow' });
  assert.strictEqual(decisionOf(await c.line(1), inst.hook.secret, nonce), 'allow');
});

// ── answers and the gone notice (findings 1, 5) ───────────────────────────────

test('E6/E58 the notch answering writes a signed decision and sends no gone notice', async t => {
  const inst = await boot(t);
  const { c, nonce, id } = await prompt(inst);
  assert.strictEqual(await inst.invoke('permission-answer', { id, decision: 'always' }), true);
  const line = await c.line(1);
  assert.deepStrictEqual(JSON.parse(line), { decision: 'always', mac: hmac(inst.hook.secret, 'decision:' + nonce + ':always') });
  await until(() => c.closed, 3000, 'close');
  assert.deepStrictEqual(inst.win.webContents.sentOn('permission-gone'), []);
  assert.strictEqual(await inst.invoke('permission-answer', { id, decision: 'allow' }), false, 'answered once');
});

test('E58 an unknown decision is signed as ask', async t => {
  const inst = await boot(t);
  const { c, nonce, id } = await prompt(inst);
  await inst.invoke('permission-answer', { id, decision: 'yes please' });
  assert.strictEqual(decisionOf(await c.line(1), inst.hook.secret, nonce), 'ask');
});

test('E4 a relay that goes away drops its entry and takes the card down', async t => {
  const inst = await boot(t);
  const { c, id } = await prompt(inst);
  c.sock.destroy();
  await until(() => inst.win.webContents.sentOn('permission-gone').includes(id), 3000, 'permission-gone');
  assert.deepStrictEqual(inst.win.webContents.sentOn('permission-gone'), [id]);
  assert.strictEqual(await inst.invoke('permission-answer', { id, decision: 'allow' }), false, 'entry removed');
});

test('E5 nobody answers for 115 s: ask is written and the card is taken down', async t => {
  mockClock(t);
  const inst = await boot(t);
  const { c, nonce, id } = await prompt(inst);
  t.mock.timers.tick(114999);
  await flush(3);
  assert.strictEqual(c.lines.length, 1, 'still waiting');
  t.mock.timers.tick(1);
  assert.strictEqual(decisionOf(await c.line(1), inst.hook.secret, nonce), 'ask');
  assert.deepStrictEqual(inst.win.webContents.sentOn('permission-gone'), [id]);
});

test('E56 a hello on a socket still open after the server stopped is proven with that server\'s secret', async t => {
  const inst = await boot(t);
  const { pipe, secret } = inst.hook;
  const c = client(pipe);
  await until(() => c.connected, 3000, 'connect');
  await new Promise(r => setTimeout(r, 100));   // let the server take the connection
  inst.quit();
  assert.strictEqual(fs.existsSync(HOOK_FILE), false);
  const nonce = await hello(c, secret);
  c.send(REQUEST);
  const req = await until(() => inst.win.webContents.sentOn('permission')[0], 3000, 'card');
  await inst.invoke('permission-answer', { id: req.id, decision: 'deny' });
  assert.strictEqual(decisionOf(await c.line(1), secret, nonce), 'deny');
});

// ── quitting (one quit path) ──────────────────────────────────────────────────

for (const [how, quit] of [
  ['settings:quit', inst => inst.emit('settings:quit')],
  ['tray Quit', inst => inst.tray.item('Quit').click()],
]) {
  test('quitApp via ' + how + ' answers pending prompts, stops the pipe and removes the hook file', async t => {
    const inst = await boot(t);
    const { c, nonce, id } = await prompt(inst);
    quit(inst);
    assert.strictEqual(decisionOf(await c.line(1), inst.hook.secret, nonce), 'ask');
    assert.deepStrictEqual(inst.win.webContents.sentOn('permission-gone'), [id]);
    assert.strictEqual(fs.existsSync(HOOK_FILE), false, 'hook file removed');
    assert.strictEqual(inst.app.exitCode, 0);
    assert.strictEqual(inst.tray.destroyed, true);
    assert.ok(inst.helper.written.includes('hinge off\n'), 'hinge sensor stopped');
    const late = client(inst.hook.pipe);
    await until(() => late.error || late.closed, 3000, 'refused connection');
    assert.ok(late.error, 'the pipe is gone');
  });
}

// ── renderer crash recovery (finding 19) ──────────────────────────────────────

test('E28/E64 a notch crash hands clicks back, answers its prompts ask without a gone notice, reloads after 1 s', async t => {
  mockClock(t);
  const inst = await boot(t);
  const { c, nonce } = await prompt(inst);
  inst.emit('mouse-enter');   // the panel was open and taking clicks
  const wc = inst.win.webContents;
  wc.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepStrictEqual(inst.win.callsOf('setIgnoreMouseEvents').at(-1), [true, { forward: true }]);
  assert.strictEqual(decisionOf(await c.line(1), inst.hook.secret, nonce), 'ask');
  assert.deepStrictEqual(wc.sentOn('permission-gone'), [], 'no notice to a dead page');
  // And no card is handed to the dead page meanwhile.
  const d = client(inst.hook.pipe);
  await hello(d, inst.hook.secret);
  d.send(REQUEST);
  await refused(d, 1);
  t.mock.timers.tick(999);
  assert.strictEqual(wc.reloads, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(wc.reloads, 1);
});

test('E29 a clean exit is not reloaded', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  inst.win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  t.mock.timers.tick(120000);
  assert.strictEqual(inst.win.webContents.reloads, 0);
});

test('E63 repeated crashes back off 1 s, 2 s, 4 s and reset after 30 s calm', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  const wc = inst.win.webContents;
  let reloads = 0;
  for (const delay of [1000, 2000, 4000]) {
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    t.mock.timers.tick(delay - 1);
    assert.strictEqual(wc.reloads, reloads, 'not before ' + delay);
    t.mock.timers.tick(1);
    assert.strictEqual(wc.reloads, ++reloads, 'at ' + delay);
  }
  t.mock.timers.tick(30001);
  wc.emit('render-process-gone', {}, { reason: 'crashed' });
  t.mock.timers.tick(999);
  assert.strictEqual(wc.reloads, reloads);
  t.mock.timers.tick(1);
  assert.strictEqual(wc.reloads, reloads + 1, 'back to 1 s');
});

test('E63 the crash back-off is capped at 60 s', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  const wc = inst.win.webContents;
  // 1, 2, 4, 8, 16, 32, then 60 (not 64) seconds.
  for (let i = 0; i < 7; i++) wc.emit('render-process-gone', {}, { reason: 'oom' });
  t.mock.timers.tick(59999);
  assert.strictEqual(wc.reloads, 6);
  t.mock.timers.tick(1);
  assert.strictEqual(wc.reloads, 7);
});

test('a lid-blur overlay crash disarms the gesture and reloads the overlay', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  await armGesture(t, inst);
  inst.blurWin.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.strictEqual(inst.blurWin.visible, false, 'disarmed');
  t.mock.timers.tick(1000);
  assert.strictEqual(inst.blurWin.webContents.reloads, 1);
});

// ── lid blur watchdog (E30, E62) ──────────────────────────────────────────────

// Feeds the helper a lid closing until a gesture arms, and answers its grab.
async function armGesture(t, inst) {
  const p = inst.helper;
  for (const a of [100, 100, 100, 110, 120]) p.line('ANGLE ' + a + ' 0');
  t.mock.timers.tick(32);   // the capture settle in withoutOverlays
  const cmd = await until(() => p.written.find(w => w.startsWith('shot ')), 3000, 'the desktop grab');
  p.line('SHOT ' + cmd.trim().split(' ')[1] + ' QUJD');
  await until(() => inst.blurWin.webContents.sentOn('hinge-shot').length === 1, 3000, 'hinge-shot');
  assert.strictEqual(inst.blurWin.visible, true, 'overlay up');
}

test('E30 an armed gesture whose overlay never reports idle is disarmed at 60 s', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  await armGesture(t, inst);
  t.mock.timers.tick(59999 - 32);
  assert.strictEqual(inst.blurWin.visible, true);
  t.mock.timers.tick(1);
  assert.strictEqual(inst.blurWin.visible, false, 'disarmed');
});

test('E62 rattle samples every 100 ms do not push the 60 s deadline back', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  await armGesture(t, inst);
  const p = inst.helper, wc = inst.blurWin.webContents;
  let elapsed = 32;
  while (elapsed + 100 < 60000) {
    t.mock.timers.tick(100); elapsed += 100;
    p.line('ANGLE ' + (elapsed % 200 ? '120.1' : '119.9') + ' 0');
  }
  assert.strictEqual(inst.blurWin.visible, true, 'still armed at ' + elapsed);
  const angles = wc.sentOn('hinge-angle').length;
  assert.ok(angles > 500, 'samples were flowing to the overlay');
  t.mock.timers.tick(60000 - elapsed);
  assert.strictEqual(inst.blurWin.visible, false, 'disarmed at 60 s');
  p.line('ANGLE 120 0');
  assert.strictEqual(wc.sentOn('hinge-angle').length, angles, 'no longer armed');
});

// ── native helper (findings 13, 21) ───────────────────────────────────────────

test('E19 a helper that fails to start is retried after 3, 6, 12, 24, 48, 60, 60 s', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  for (const delay of [3000, 6000, 12000, 24000, 48000, 60000, 60000]) {
    const n = inst.procs.length;
    const p = inst.helper;
    p.pid = undefined;
    p.emit('error', new Error('spawn ENOENT'));
    t.mock.timers.tick(delay - 1);
    assert.strictEqual(inst.procs.length, n, 'no restart before ' + delay);
    t.mock.timers.tick(1);
    assert.strictEqual(inst.procs.length, n + 1, 'restarted at ' + delay);
  }
});

test('E20 an error on a running helper does not start a second one', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  const p = inst.helper;
  p.emit('error', new Error('kill EPERM'));
  t.mock.timers.tick(120000);
  assert.strictEqual(inst.procs.length, 1, 'no restart for a failed signal');
  p.emit('exit', 1);
  t.mock.timers.tick(3000);
  assert.strictEqual(inst.procs.length, 2, 'its exit restarts it once');
  t.mock.timers.tick(120000);
  assert.strictEqual(inst.procs.length, 2);
});

test('E21 a helper that ran over 60 s restarts after 3 s again', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  for (const delay of [3000, 6000]) {
    inst.helper.pid = undefined;
    inst.helper.emit('error', new Error('spawn ENOENT'));
    t.mock.timers.tick(delay);
  }
  assert.strictEqual(inst.procs.length, 3);
  t.mock.timers.tick(61000);
  inst.helper.emit('exit', 0);
  t.mock.timers.tick(2999);
  assert.strictEqual(inst.procs.length, 3);
  t.mock.timers.tick(1);
  assert.strictEqual(inst.procs.length, 4, 'back-off reset to 3 s');
});

test('E23 a helper that exits mid-grab lets the grab fall back at once', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  const p = inst.helper;
  let result = 'pending';
  inst.invoke('desktop-shot').then(v => { result = v; });
  t.mock.timers.tick(32);
  await until(() => p.commands('shot') === 1, 3000, 'shot command');
  p.emit('exit', 1);
  await until(() => result !== 'pending', 1000, 'the grab to settle without its 1.5 s timeout');
  assert.strictEqual(result, null, 'fell back to desktopCapturer (no sources here)');
});

// ── media (findings 10, 17) ───────────────────────────────────────────────────

const META_A = { title: 'Song A', artist: 'Art', album: 'Alb', src: 'Spotify.exe', playing: true, pos: 10, dur: 200, posAge: 1000 };
const META_B = { ...META_A, title: 'Song B' };
const keyOf = d => d.title + '||' + d.artist + '||' + d.album + '||' + d.src;
const meta = p => (d => p.line('META ' + JSON.stringify(d)));

test('E27/finding 17 get-media adds the time since the helper read the position', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  meta(inst.helper)(META_A);
  t.mock.timers.tick(500);
  const m = await inst.invoke('get-media');
  assert.strictEqual(m.posAge, 1500);
  assert.strictEqual(m.artKey, keyOf(META_A));
  meta(inst.helper)({ ...META_A, posAge: 'junk' });
  t.mock.timers.tick(250);
  assert.strictEqual((await inst.invoke('get-media')).posAge, 250);
  meta(inst.helper)({ ...META_A, posAge: -900 });
  assert.strictEqual((await inst.invoke('get-media')).posAge, 0);
});

test('E24 two asks for the same art share one helper request', async t => {
  const inst = await boot(t, { hook: false });
  const p = inst.helper;
  meta(p)(META_A);
  const k = keyOf(META_A);
  const a = inst.invoke('get-art', k, META_A), b = inst.invoke('get-art', k, META_A);
  await flush();
  assert.strictEqual(p.commands('art'), 1);
  p.line('ART QUFB');
  assert.deepStrictEqual(await Promise.all([a, b]), ['QUFB', 'QUFB']);
  assert.strictEqual(await inst.invoke('get-art', k, META_A), 'QUFB', 'then cached');
  assert.strictEqual(p.commands('art'), 1);
});

test('E25 asks for different art both proceed, answered in order', async t => {
  const inst = await boot(t, { hook: false });
  const p = inst.helper;
  meta(p)(META_A);
  const a = inst.invoke('get-art', keyOf(META_A), META_A);
  const b = inst.invoke('get-art', keyOf(META_B), META_B);
  await flush();
  assert.strictEqual(p.commands('art'), 2);
  p.line('ART Rmlyc3Q=');
  p.line('ART U2Vjb25k');
  assert.deepStrictEqual(await Promise.all([a, b]), ['Rmlyc3Q=', 'U2Vjb25k']);
});

test('E22 a late ART reply for a timed-out request is not handed to the next one', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  const p = inst.helper;
  meta(p)(META_B);
  const first = inst.invoke('get-art', keyOf(META_A), META_A);
  await flush();
  t.mock.timers.tick(8000);
  assert.strictEqual(await first, '', 'timed out');
  const second = inst.invoke('get-art', keyOf(META_B), META_B);
  await flush();
  assert.strictEqual(p.commands('art'), 2);
  p.line('ART TEFURQ==');   // the first request's answer, late
  p.line('ART UklHSFQ=');
  assert.strictEqual(await second, 'UklHSFQ=');
});

test('E66 art that lands after the track changed is returned but not cached under the old key', async t => {
  const inst = await boot(t, { hook: false });
  const p = inst.helper;
  meta(p)(META_A);
  const stale = inst.invoke('get-art', keyOf(META_A), META_A);
  await flush();
  meta(p)(META_B);          // the track changed while the helper was busy
  p.line('ART QkJC');       // ...so this is B's picture
  assert.strictEqual(await stale, 'QkJC', 'the caller still gets it');
  const again = inst.invoke('get-art', keyOf(META_A), META_A);
  await flush();
  assert.strictEqual(p.commands('art'), 2, 'A was not served from the cache');
  p.line('ART QUFB');
  await again;
  // The current track's art is cached.
  const b = inst.invoke('get-art', keyOf(META_B), META_B);
  await flush();
  p.line('ART Q0ND');
  assert.strictEqual(await b, 'Q0ND');
  assert.strictEqual(await inst.invoke('get-art', keyOf(META_B), META_B), 'Q0ND');
  assert.strictEqual(p.commands('art'), 3);
});

// ── thumbnails for browser players (E26) ──────────────────────────────────────

// A browser track whose helper has no art, so get-art goes to the YouTube lookup.
async function browserArt(t, inst, key, getImpl) {
  inst.helper.stdin.writable = false;
  setYtSearch(async () => ({ videos: [{ videoId: 'v', thumbnail: 'https://thumbs.example/v.jpg' }] }));
  t.after(() => setYtSearch(null));
  if (getImpl) t.mock.method(https, 'get', getImpl);
  return inst.invoke('get-art', key, { src: 'chrome.exe', title: 'Song' });
}

function fakeReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.setTimeout = (ms, cb) => { req.timeoutMs = ms; req.onTimeout = cb; };
  req.destroy = err => { req.destroyed = true; if (err) req.emit('error', err); req.emit('close'); };
  return req;
}
function fakeRes(status) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.resume = () => { res.resumed = true; };
  return res;
}

test('E26 a thumbnail that answers 200 is returned as base64 (control)', async t => {
  const inst = await boot(t, { hook: false });
  const req = fakeReq(), res = fakeRes(200);
  const got = browserArt(t, inst, 'k-ok', (url, cb) => { setImmediate(() => { cb(res); res.emit('data', Buffer.from('ab')); res.emit('data', Buffer.from('cd')); res.emit('end'); }); return req; });
  assert.strictEqual(await got, Buffer.from('abcd').toString('base64'));
});

test('E26 a non-200 thumbnail is drained and gives no art', async t => {
  const inst = await boot(t, { hook: false });
  const req = fakeReq(), res = fakeRes(404);
  const got = browserArt(t, inst, 'k-404', (url, cb) => { setImmediate(() => cb(res)); return req; });
  assert.strictEqual(await got, '');
  assert.strictEqual(res.resumed, true, 'response drained so the socket is freed');
});

test('E26 a thumbnail server that hangs is cut off by an 8 s request timeout', async t => {
  const inst = await boot(t, { hook: false });
  const req = fakeReq();
  const got = browserArt(t, inst, 'k-hang', () => req);
  await until(() => req.onTimeout, 3000, 'request timeout set');
  assert.strictEqual(req.timeoutMs, 8000);
  req.onTimeout();
  assert.strictEqual(await got, '');
  assert.strictEqual(req.destroyed, true);
});

test('E26 a thumbnail over 5 MB is abandoned', async t => {
  const inst = await boot(t, { hook: false });
  const req = fakeReq(), res = fakeRes(200);
  const got = browserArt(t, inst, 'k-big', (url, cb) => {
    setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.alloc(5 * 1024 * 1024));
      assert.strictEqual(req.destroyed, false, 'exactly 5 MB is allowed');
      res.emit('data', Buffer.alloc(1));
      res.emit('end');
    });
    return req;
  });
  assert.strictEqual(await got, '');
  assert.strictEqual(req.destroyed, true);
});

test('E26 an http: thumbnail URL (sync throw from https.get) gives no art', async t => {
  const inst = await boot(t, { hook: false });
  inst.helper.stdin.writable = false;
  setYtSearch(async () => ({ videos: [{ videoId: 'v', thumbnail: 'http://thumbs.example/v.jpg' }] }));
  t.after(() => setYtSearch(null));
  assert.strictEqual(await inst.invoke('get-art', 'k-http', { src: 'msedge.exe', title: 'Song' }), '');
});

test('E26 a YouTube lookup that never returns gives up after 15 s', async t => {
  mockClock(t);
  const inst = await boot(t, { hook: false });
  inst.helper.stdin.writable = false;
  setYtSearch(() => new Promise(() => {}));
  t.after(() => setYtSearch(null));
  let result = 'pending';
  inst.invoke('get-art', 'k-lookup', { src: 'firefox.exe', title: 'Song' }).then(v => { result = v; });
  await flush(3);
  t.mock.timers.tick(14999);
  await flush(3);
  assert.strictEqual(result, 'pending');
  t.mock.timers.tick(1);
  await until(() => result !== 'pending', 1000, 'lookup timeout');
  assert.strictEqual(result, '');
});
