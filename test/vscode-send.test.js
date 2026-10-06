'use strict';
// The check that keeps the notch from typing over, or sending, something you
// were writing in a VS Code chat: an empty box reports VS Code's grey hint as
// its value, so only those hints (and nothing) count as empty. The functions
// are lifted from the script that ships and run in PowerShell, as they are live.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');
const { SCRIPT, sendToChat } = require(path.join(SRC, 'vscode-send.js'));
const onWindows = process.platform === 'win32';

// Norm, the hint list and IsEmptyBox, exactly as the script defines them.
function lift() {
  const lines = SCRIPT.split(/\r?\n/);
  const pick = re => { const l = lines.find(x => re.test(x)); assert.ok(l, 'moved: ' + re); return l; };
  return [pick(/^function Norm\(/), pick(/^\$HINTS = /), pick(/^function IsEmptyBox\(/)].join('\n');
}

function isEmpty(values) {
  const cases = JSON.stringify(values);
  const ps = lift() + `
$in = '${Buffer.from(cases, 'utf8').toString('base64')}'
$vals = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in)) | ConvertFrom-Json
$out = foreach ($v in $vals) { if ($v -eq '<null>') { IsEmptyBox $null } else { IsEmptyBox $v } }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
($out | ForEach-Object { if ($_) { '1' } else { '0' } }) -join ''`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' }).trim();
}

test('the message never becomes part of the script: it only travels on stdin', () => {
  // Read as written: a ${...} in the template would already be filled in by the
  // time the module loads, so the loaded SCRIPT could never show one.
  const src = require('node:fs').readFileSync(path.join(SRC, 'vscode-send.js'), 'utf8');
  const start = src.indexOf('String.raw`');
  const body = src.slice(start, src.indexOf('`;', start));
  assert.ok(start !== -1 && body.length > 1000, 'found the script');
  assert.ok(!body.includes('${'), 'no template interpolation in the PowerShell source');
});

test('an empty box, and VS Code\'s own hints, count as empty', { skip: !onWindows && 'needs PowerShell' }, () => {
  assert.strictEqual(isEmpty([
    '',
    'ctrl esc to focus or unfocus Claude',
    'Queue another message…',
    'queue another message...',
    '  Queue  another   message…  ',
  ]), '11111');
});

test('anything you typed is a draft, and is never typed over', { skip: !onWindows && 'needs PowerShell' }, () => {
  assert.strictEqual(isEmpty([
    'x',
    'fix the bug',
    'ctrl esc to focus or unfocus Claude please',
    'Queue another message about the tests',
    '<null>',                                   // an unreadable box is not empty
  ]), '00000');
});

// Two at once would fight over the front window and over which window to give
// back. A folder no VS Code window has open makes the first one end quickly
// (no-window), having typed nothing; the second is refused while it runs.
test('one send at a time: a second while one runs is refused, then the next goes', { skip: !onWindows && 'needs PowerShell' }, async () => {
  const args = { folder: 'Z:\\no-such-notch-test-folder', exe: '', uri: 'vscode://x', text: 'never typed', title: 'nothing', dry: true };
  const first = sendToChat(args);
  assert.deepStrictEqual(await sendToChat(args), { ok: false, reason: 'busy' });
  assert.strictEqual((await first).reason, 'no-window', 'the first one ran, and touched nothing');
  assert.strictEqual((await sendToChat(args)).reason, 'no-window', 'free again once it settled');
});
