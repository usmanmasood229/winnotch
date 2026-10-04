'use strict';
// Registers hook-relay.js with Claude Code by merging ONE PermissionRequest hook
// into ~/.claude/settings.json, and takes it back out again.
//
// That file is the user's live config. It already holds their permission
// allowlist, their model, their statusline and four PreToolUse hooks they depend
// on, so every rule below exists to make damaging it impossible:
//
//   * only the PermissionRequest event is ever added, read or removed;
//   * every other key, event and entry is carried over by value, untouched;
//   * our own entry is recognised by the MARKER in its command, so a foreign
//     PermissionRequest hook in the same event survives uninstall;
//   * a file that does not parse is NEVER written — it throws instead, because
//     treating an unreadable config as {} would wipe it;
//   * the real file is copied to settings.json.winnotch-backup before a write,
//     and the write itself is temp-file + rename, so a crash mid-write cannot
//     leave a half-written config behind;
//   * nothing is written at all when the merge changes nothing.
//
// withHook / withoutHook / hasHook / hookCommand are pure: they take a settings
// object and return a new one. Only install/uninstall touch the disk.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Appears in our command so we can find our own entry again later.
const MARKER = 'winnotch-hook';
const EVENT = 'PermissionRequest';
// Must stay above hook-relay.js's own WAIT_MS, so the relay's fallback runs
// first and Claude Code never sees a hook that simply timed out.
const TIMEOUT = 120;

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_PATH = SETTINGS_PATH + '.winnotch-backup';
const TEMP_PATH = SETTINGS_PATH + '.winnotch-tmp';

// -- pure helpers -------------------------------------------------------------

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Claude Code runs hook commands through Git Bash on Windows, so a backslashed
// path would come out as escapes. Forward slashes, double-quoted, every time.
function quote(p) {
  return '"' + String(p).replace(/\\/g, '/') + '"';
}

function hookCommand(relayPath) {
  // Under Electron process.execPath is WinNotch.exe, which would start a second
  // copy of the app instead of running the script; this env var is Electron's
  // own way of asking its bundled Node to run a plain script instead.
  const asNode = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  // The trailing MARKER is an argument hook-relay.js ignores. It exists only so
  // withoutHook can tell our entry apart from someone else's, and so the user
  // can see at a glance which line in their settings file is ours.
  return asNode + quote(process.execPath) + ' ' + quote(relayPath) + ' ' + MARKER;
}

// The PermissionRequest entries in a settings object, or [] if there are none.
// Throws rather than guessing when the shape is not what Claude Code documents --
// writing over something we do not understand is how configs get destroyed.
function eventEntries(settings) {
  if (!isPlain(settings)) return [];
  const hooks = settings.hooks;
  if (hooks === undefined || hooks === null) return [];
  if (!isPlain(hooks)) throw new TypeError('settings.hooks is not an object; refusing to touch it');
  const list = hooks[EVENT];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError('settings.hooks.' + EVENT + ' is not an array; refusing to touch it');
  return list;
}

function isOurs(entry) {
  const inner = isPlain(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
  return inner.some(h => isPlain(h) && typeof h.command === 'string' && h.command.includes(MARKER));
}

function hasHook(settings) {
  return eventEntries(settings).some(isOurs);
}

// A new settings object whose PermissionRequest entries are `list`. Everything
// else -- other top-level keys, other hook events -- is copied across by value.
function withEvent(settings, list) {
  const base = isPlain(settings) ? settings : {};
  const hooks = Object.assign({}, base.hooks);
  if (list.length) hooks[EVENT] = list;
  else delete hooks[EVENT];                      // empty event: drop the key
  const out = Object.assign({}, base);
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;                         // and the whole hooks object
  return out;
}

function ourEntry(relayPath) {
  return { hooks: [{ type: 'command', command: hookCommand(relayPath), timeout: TIMEOUT }] };
}

function withHook(settings, relayPath) {
  // Dropping ours first makes this idempotent, and updates the command in place
  // when the app has moved since it was installed.
  const keep = eventEntries(settings).filter(e => !isOurs(e));
  return withEvent(settings, keep.concat([ourEntry(relayPath)]));
}

function withoutHook(settings) {
  const list = eventEntries(settings);
  // Nothing of ours in there: hand back a copy and change nothing else, not even
  // an empty hooks object the user put there themselves.
  if (!list.some(isOurs)) return Object.assign({}, isPlain(settings) ? settings : {});
  return withEvent(settings, list.filter(e => !isOurs(e)));
}

// -- disk ---------------------------------------------------------------------

function readSettings() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};                    // empty file holds no config to lose
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Could not parse ' + SETTINGS_PATH + ' (' + err.message
      + '). Left untouched - fix or remove the file and try again.');
  }
  if (!isPlain(parsed)) throw new Error(SETTINGS_PATH + ' is not a JSON object. Left untouched.');
  return parsed;
}

// ponytail: no lock, so two installs at the same moment leave the last writer's
// version. Add one if WinNotch ever installs from more than one process.
function writeSettings(next) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  let backupPath = null;
  if (fs.existsSync(SETTINGS_PATH)) {
    fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);   // single slot, newest only
    backupPath = BACKUP_PATH;
  }
  fs.writeFileSync(TEMP_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(TEMP_PATH, SETTINGS_PATH);         // overwrites, Windows included
  return backupPath;
}

function commit(current, next) {
  if (JSON.stringify(current) === JSON.stringify(next)) return { changed: false, backupPath: null };
  return { changed: true, backupPath: writeSettings(next) };
}

function install(relayPath) {
  if (typeof relayPath !== 'string' || !relayPath.trim()) {
    throw new TypeError('install(relayPath) needs the path to hook-relay.js');
  }
  const current = readSettings();
  // Resolve now: the hook runs with the project as its cwd, so a relative path
  // here would point at nothing by the time Claude Code calls it.
  return commit(current, withHook(current, path.resolve(relayPath)));
}

function uninstall() {
  const current = readSettings();
  return commit(current, withoutHook(current));
}

module.exports = {
  hookCommand, withHook, withoutHook, hasHook, install, uninstall,
  SETTINGS_PATH, BACKUP_PATH, MARKER, EVENT, TIMEOUT,
};

// See what it would write, without writing it:  node src/hook-install.js
if (require.main === module) {
  const relay = path.join(__dirname, 'hook-relay.js');
  console.log('settings:  ' + SETTINGS_PATH);
  console.log('installed: ' + hasHook(readSettings()));
  console.log('command:   ' + hookCommand(relay));
}
