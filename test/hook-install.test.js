'use strict';
// hook-install.js edits the user's real Claude Code config, so these tests care
// about one thing above all: nothing that was already in that file is lost.
//
// SETTINGS_PATH is resolved from os.homedir() when the module loads, so the env
// vars are pointed at a throwaway directory BEFORE the require, exactly as in
// agent-scan.test.js. Every disk test then runs against that fake home; the real
// ~/.claude/settings.json is never opened.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'winnotch-hookinstall-'));
process.env.USERPROFILE = HOME;   // os.homedir() on Windows
process.env.HOME = HOME;          // ...and everywhere else
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

const hi = require('../src/hook-install.js');
const { hookCommand, withHook, withoutHook, hasHook, install, uninstall, MARKER } = hi;

const RELAY = 'C:\\Users\\x\\winnotch\\src\\hook-relay.js';

// The shape of the user's actual settings.json, trimmed but structurally the
// same: a permissions block, scalars, nested objects, and the four PreToolUse
// hooks that must come out the other side intact.
function realistic() {
  return {
    permissions: {
      allow: ['Bash(npm run *)', 'Bash(npm install *)'],
      additionalDirectories: ['C:\\Users\\x\\other'],
    },
    model: 'opus[1m]',
    hooks: {
      PreToolUse: [{
        matcher: 'Bash|PowerShell',
        hooks: ['git *', 'gh *', 'PowerShell git *', 'PowerShell gh *'].map(iff => ({
          type: 'command',
          command: 'node',
          args: ['C:/Users/x/.claude/hooks/push-gate.js'],
          if: iff,
          timeout: 30,
          statusMessage: 'Checking the pre-PR gate',
        })),
      }],
    },
    statusLine: { type: 'command', command: 'powershell -File "C:\\x\\sl.ps1"' },
    enabledPlugins: { 'ponytail@ponytail': true },
    theme: 'dark',
    effortLevel: 'medium',
  };
}

const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /somebody/else/guard.js', timeout: 5 }] };

function entriesOf(s) {
  return (s.hooks && s.hooks.PermissionRequest) || [];
}

function writeSettings(obj, raw) {
  fs.writeFileSync(hi.SETTINGS_PATH, raw !== undefined ? raw : JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function rmSettings() {
  for (const f of [hi.SETTINGS_PATH, hi.BACKUP_PATH]) {
    try { fs.unlinkSync(f); } catch { /* not there */ }
  }
}

// -- hookCommand --------------------------------------------------------------

test('hookCommand quotes both paths and uses forward slashes only', () => {
  const cmd = hookCommand(RELAY);
  assert.ok(!cmd.includes('\\'), 'no backslashes left in: ' + cmd);
  assert.ok(cmd.includes('"C:/Users/x/winnotch/src/hook-relay.js"'), 'relay path quoted: ' + cmd);
  assert.ok(cmd.includes('"' + process.execPath.replace(/\\/g, '/') + '"'), 'node exe quoted: ' + cmd);
  assert.ok(cmd.includes(MARKER), 'carries the marker: ' + cmd);
  // The exe comes first so Git Bash runs it, with the script as its argument.
  assert.match(cmd, /^"[^"]+" "[^"]+" winnotch-hook$/);
});

test('hookCommand asks Electron to behave like node when running inside it', () => {
  assert.ok(!process.versions.electron, 'test runs under plain node');
  process.versions.electron = '29.0.0';
  try {
    assert.match(hookCommand(RELAY), /^ELECTRON_RUN_AS_NODE=1 "/);
  } finally {
    delete process.versions.electron;
  }
});

// -- withHook -----------------------------------------------------------------

test('withHook writes exactly the entry shape Claude Code expects', () => {
  const list = entriesOf(withHook({}, RELAY));
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0], {
    hooks: [{ type: 'command', command: hookCommand(RELAY), timeout: 120 }],
  });
});

test('withHook registers PermissionRequest and no other event', () => {
  const out = withHook({}, RELAY);
  assert.deepStrictEqual(Object.keys(out.hooks), ['PermissionRequest']);
});

test('existing PreToolUse hooks survive a withHook round-trip', () => {
  const before = realistic();
  const snapshot = JSON.stringify(before);

  const installed = withHook(before, RELAY);
  // The other event is still there, value for value, while ours sits beside it.
  assert.deepStrictEqual(installed.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.strictEqual(installed.hooks.PreToolUse[0].hooks.length, 4);
  assert.strictEqual(entriesOf(installed).length, 1);

  const removed = withoutHook(installed);
  assert.deepStrictEqual(removed, before);
  assert.strictEqual(JSON.stringify(removed), snapshot, 'round-trip is byte-for-byte');
});

test('withHook is idempotent', () => {
  const once = withHook(realistic(), RELAY);
  const twice = withHook(once, RELAY);
  assert.strictEqual(entriesOf(twice).length, 1);
  assert.deepStrictEqual(twice, once);
});

test('withHook replaces our own stale entry instead of stacking a second one', () => {
  const old = withHook({}, 'C:/old/place/hook-relay.js');
  const fresh = withHook(old, RELAY);
  assert.strictEqual(entriesOf(fresh).length, 1);
  assert.ok(entriesOf(fresh)[0].hooks[0].command.includes('winnotch/src/hook-relay.js'));
});

test('withHook keeps a foreign PermissionRequest entry and appends after it', () => {
  const out = withHook({ hooks: { PermissionRequest: [FOREIGN] } }, RELAY);
  assert.strictEqual(entriesOf(out).length, 2);
  assert.deepStrictEqual(entriesOf(out)[0], FOREIGN);
  assert.ok(hasHook(out));
});

test('withHook does not mutate its input', () => {
  const before = realistic();
  const snapshot = JSON.stringify(before);
  withHook(before, RELAY);
  assert.strictEqual(JSON.stringify(before), snapshot);
  assert.strictEqual(before.hooks.PermissionRequest, undefined);

  // ...nor when it has to drop a previous copy of our own entry first.
  const installed = withHook({ hooks: { PermissionRequest: [FOREIGN] } }, RELAY);
  const snap2 = JSON.stringify(installed);
  withHook(installed, 'C:/elsewhere/hook-relay.js');
  assert.strictEqual(JSON.stringify(installed), snap2);
});

test('withHook preserves every unrelated top-level key', () => {
  const before = realistic();
  const out = withHook(before, RELAY);
  for (const key of Object.keys(before)) {
    if (key === 'hooks') continue;
    assert.deepStrictEqual(out[key], before[key], key + ' changed');
  }
  assert.deepStrictEqual(Object.keys(out), Object.keys(before), 'no key added or reordered');
});

// -- withoutHook --------------------------------------------------------------

test('withoutHook removes ours and keeps a foreign entry in the same event', () => {
  const both = withHook({ hooks: { PermissionRequest: [FOREIGN], PreToolUse: [] } }, RELAY);
  const out = withoutHook(both);
  assert.deepStrictEqual(out.hooks.PermissionRequest, [FOREIGN]);
  assert.strictEqual(hasHook(out), false);
  assert.deepStrictEqual(out.hooks.PreToolUse, []);
});

test('withoutHook drops the event key once it is empty', () => {
  const installed = withHook(realistic(), RELAY);
  const out = withoutHook(installed);
  assert.ok(!('PermissionRequest' in out.hooks), 'event key gone, not left as []');
  assert.ok(out.hooks.PreToolUse, 'the other event is untouched');

  // With nothing else under hooks, the hooks object we created goes too.
  const bare = withoutHook(withHook({ model: 'opus' }, RELAY));
  assert.deepStrictEqual(bare, { model: 'opus' });
});

test('withoutHook does not mutate its input and is a no-op when ours is absent', () => {
  const before = realistic();
  const snapshot = JSON.stringify(before);
  const out = withoutHook(before);
  assert.strictEqual(JSON.stringify(before), snapshot);
  assert.deepStrictEqual(out, before);

  const installed = withHook(before, RELAY);
  const snap2 = JSON.stringify(installed);
  withoutHook(installed);
  assert.strictEqual(JSON.stringify(installed), snap2);
});

// -- hasHook ------------------------------------------------------------------

test('hasHook is true only when our own entry is present', () => {
  assert.strictEqual(hasHook({}), false);
  assert.strictEqual(hasHook(realistic()), false);
  assert.strictEqual(hasHook({ hooks: {} }), false);
  assert.strictEqual(hasHook({ hooks: { PermissionRequest: [] } }), false);
  assert.strictEqual(hasHook({ hooks: { PermissionRequest: [FOREIGN] } }), false);
  assert.strictEqual(hasHook(withHook(realistic(), RELAY)), true);
  assert.strictEqual(hasHook(withHook({ hooks: { PermissionRequest: [FOREIGN] } }, RELAY)), true);
});

test('hasHook survives junk entries rather than throwing', () => {
  assert.strictEqual(hasHook({ hooks: { PermissionRequest: [null, 'x', {}, { hooks: 'nope' }, { hooks: [null, {}] }] } }), false);
  assert.strictEqual(hasHook(null), false);
  assert.strictEqual(hasHook(undefined), false);
});

test('a settings shape we do not understand throws instead of being overwritten', () => {
  assert.throws(() => withHook({ hooks: 'oops' }, RELAY), TypeError);
  assert.throws(() => withoutHook({ hooks: { PermissionRequest: {} } }), TypeError);
  assert.throws(() => hasHook({ hooks: [] }), TypeError);
});

// -- install / uninstall ------------------------------------------------------

test('install merges into the real file and uninstall puts it back', () => {
  rmSettings();
  const before = realistic();
  writeSettings(before);

  const res = install(RELAY);
  assert.strictEqual(res.changed, true);
  assert.strictEqual(res.backupPath, hi.BACKUP_PATH);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(hi.BACKUP_PATH, 'utf8')), before, 'backup holds the original');

  const after = JSON.parse(fs.readFileSync(hi.SETTINGS_PATH, 'utf8'));
  assert.strictEqual(hasHook(after), true);
  assert.deepStrictEqual(after.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepStrictEqual(after.permissions, before.permissions);
  assert.strictEqual(after.theme, 'dark');
  assert.ok(!fs.existsSync(hi.SETTINGS_PATH + '.winnotch-tmp'), 'temp file cleaned up by the rename');

  const gone = uninstall();
  assert.strictEqual(gone.changed, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(hi.SETTINGS_PATH, 'utf8')), before, 'file is exactly as it started');
});

test('install resolves a relative relay path to an absolute one', () => {
  rmSettings();
  writeSettings({});
  install('src/hook-relay.js');
  const cmd = entriesOf(JSON.parse(fs.readFileSync(hi.SETTINGS_PATH, 'utf8')))[0].hooks[0].command;
  assert.ok(cmd.includes(path.resolve('src/hook-relay.js').replace(/\\/g, '/')), cmd);
});

test('install and uninstall write nothing when there is nothing to change', () => {
  rmSettings();
  writeSettings(realistic());
  assert.deepStrictEqual(uninstall(), { changed: false, backupPath: null }, 'nothing of ours to remove');
  assert.ok(!fs.existsSync(hi.BACKUP_PATH), 'a no-op does not even make a backup');

  install(RELAY);
  const bytes = fs.readFileSync(hi.SETTINGS_PATH, 'utf8');
  fs.unlinkSync(hi.BACKUP_PATH);
  assert.deepStrictEqual(install(RELAY), { changed: false, backupPath: null }, 'second install is a no-op');
  assert.strictEqual(fs.readFileSync(hi.SETTINGS_PATH, 'utf8'), bytes, 'file not rewritten');
  assert.ok(!fs.existsSync(hi.BACKUP_PATH), 'and not re-backed-up');
});

test('install refuses to touch a settings file it cannot parse', () => {
  rmSettings();
  const broken = '{ "model": "opus", \n // a comment, or a half-saved file\n';
  writeSettings(null, broken);
  assert.throws(() => install(RELAY), /Could not parse/);
  assert.throws(() => uninstall(), /Could not parse/);
  assert.strictEqual(fs.readFileSync(hi.SETTINGS_PATH, 'utf8'), broken, 'left byte-for-byte alone');
  assert.ok(!fs.existsSync(hi.BACKUP_PATH), 'and no backup written either');

  writeSettings(null, '["not", "an", "object"]');
  assert.throws(() => install(RELAY), /not a JSON object/);
  assert.strictEqual(fs.readFileSync(hi.SETTINGS_PATH, 'utf8'), '["not", "an", "object"]');
});

test('install creates the file when there is none, uninstall does not', () => {
  rmSettings();
  assert.deepStrictEqual(uninstall(), { changed: false, backupPath: null });
  assert.ok(!fs.existsSync(hi.SETTINGS_PATH), 'uninstall never conjures a settings file');

  const res = install(RELAY);
  assert.strictEqual(res.changed, true);
  assert.strictEqual(res.backupPath, null, 'nothing existed to back up');
  assert.strictEqual(hasHook(JSON.parse(fs.readFileSync(hi.SETTINGS_PATH, 'utf8'))), true);
});

test('install rejects a missing relay path rather than writing a broken hook', () => {
  rmSettings();
  writeSettings(realistic());
  for (const bad of [undefined, null, '', '   ', 42]) {
    assert.throws(() => install(bad), TypeError, 'accepted ' + JSON.stringify(bad));
  }
  assert.strictEqual(hasHook(JSON.parse(fs.readFileSync(hi.SETTINGS_PATH, 'utf8'))), false);
});

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });
