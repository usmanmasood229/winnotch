'use strict';
// What the notch's message box may open. The renderer names a session and the
// text; everything else must come from the scan, and anything odd is refused.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');
const { planPrompt, MAX_PROMPT } = require(path.join(SRC, 'session-prompt.js'));

const ID = 'e90a8658-b84b-47b8-aa39-4e1d7b2136fd';
// A real folder: the plan refuses one that does not exist.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-prompt-'));
const snap = (over = {}) => ({ sessions: [Object.assign({
  sessionId: ID, cwd: DIR, entrypoint: 'claude-vscode',
  agents: [{ id: 'a1', description: 'worker' }, { id: 'self:' + ID, isSession: true, description: 'App review agent' }],
}, over)] });

test('a VS Code chat gets its folder, a link that focuses it, the text and its title', () => {
  const p = planPrompt(snap(), ID, '  run the tests  ');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.folder, DIR);
  // Only the session: VS Code ignores prompt= for a chat that is already open.
  assert.strictEqual(p.uri, 'vscode://anthropic.claude-code/open?session=' + ID);
  assert.strictEqual(p.text, 'run the tests');
  assert.strictEqual(p.title, 'App review agent', 'the session row, not an agent');
});

test('the message is one line: Enter in the box sends, so newlines would split it', () => {
  assert.strictEqual(planPrompt(snap(), ID, 'first\r\nsecond\n\nthird').text, 'first second third');
});

test('a chat with no name is refused: it could not be told apart in its window', () => {
  assert.deepStrictEqual(planPrompt(snap({ agents: [] }), ID, 'hi'), { ok: false, reason: 'no-title' });
});

test('two open chats with the same name in one folder: refused rather than guessed', () => {
  const other = { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: DIR + '\\', entrypoint: 'claude-vscode',
    agents: [{ id: 'self:o', isSession: true, description: 'app REVIEW agent' }] };
  const snapshot = snap();
  snapshot.sessions.push(other);
  assert.deepStrictEqual(planPrompt(snapshot, ID, 'hi'), { ok: false, reason: 'ambiguous-chat' });
  other.agents[0].description = 'Something else';
  assert.strictEqual(planPrompt(snapshot, ID, 'hi').ok, true, 'a different name is fine');
});

test('only a chat open in VS Code: a terminal session is refused', () => {
  assert.deepStrictEqual(planPrompt(snap({ entrypoint: 'cli' }), ID, 'hi'), { ok: false, reason: 'not-vscode' });
  assert.deepStrictEqual(planPrompt(snap({ entrypoint: null }), ID, 'hi'), { ok: false, reason: 'not-vscode' });
});

test('a session the scan does not have is refused', () => {
  const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.deepStrictEqual(planPrompt(snap(), other, 'hi'), { ok: false, reason: 'not-live' });
  assert.deepStrictEqual(planPrompt({ sessions: [] }, ID, 'hi'), { ok: false, reason: 'not-live' });
  assert.deepStrictEqual(planPrompt(null, ID, 'hi'), { ok: false, reason: 'not-live' });
});

test('a session id that is not a uuid is refused before anything is looked up', () => {
  for (const bad of ['', 'x', ID + '&prompt=evil', ' ' + ID, 42, null, undefined]) {
    assert.deepStrictEqual(planPrompt(snap(), bad, 'hi'), { ok: false, reason: 'bad-session' }, String(bad));
  }
});

test('empty or whitespace text is not sent', () => {
  for (const t of ['', '   ', '\n\t', null, 5]) {
    assert.deepStrictEqual(planPrompt(snap(), ID, t), { ok: false, reason: 'empty' }, JSON.stringify(t));
  }
});

test('only a real folder on a plain drive path is handed to Code.exe', () => {
  const bad = [
    '\\\\server\\share\\proj', 'relative\\dir', '--disable-extensions', '-x', '', null,
    'C:\\',                                         // the root of a drive
    DIR + '" --extensions-dir "C:\\x',              // a quote would add flags
    DIR + '\n',                                     // control character
    path.join(DIR, 'missing'),                      // not there
  ];
  for (const cwd of bad) {
    assert.deepStrictEqual(planPrompt(snap({ cwd }), ID, 'hi'), { ok: false, reason: 'bad-folder' }, JSON.stringify(cwd));
  }
  // A trailing backslash would escape the closing quote on the command line.
  assert.strictEqual(planPrompt(snap({ cwd: DIR + '\\' }), ID, 'hi').folder, DIR);
});

test('length: up to the box limit goes, past it does not', () => {
  assert.strictEqual(planPrompt(snap(), ID, 'a'.repeat(MAX_PROMPT)).ok, true);
  assert.deepStrictEqual(planPrompt(snap(), ID, 'a'.repeat(MAX_PROMPT + 1)), { ok: false, reason: 'too-long' });
});
