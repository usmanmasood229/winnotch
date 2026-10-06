'use strict';
// A message from the notch's box, into a Claude Code chat open in VS Code.
//
// Claude Code has no supported way for another app to submit a prompt into a
// running session. The VS Code extension's link,
//   vscode://anthropic.claude-code/open?session=<id>
// focuses that chat's tab, but for a chat that is already open (every chat the
// notch can see) it ignores a prompt= parameter: VS Code says "Session is already
// open. Your prompt was not applied". So the link only brings the chat forward,
// and vscode-send.js types the message into its box, with checks. The link opens
// in whichever VS Code window has focus, and the session must belong to that
// window's workspace, so main.js brings the project's window forward first
// (Code.exe on the session's folder).
//
// The renderer only names a session id and the text. Everything else comes from
// the scanner's own snapshot, so a page can't point this at an arbitrary folder.
// Only VS Code chats: the link would open a terminal session a second time in a
// VS Code tab, and two front ends on one session interleave its transcript.

const fs = require('fs');

const MAX_PROMPT = 1500;      // what the box allows (maxlength in index.html)
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A plain drive path below the root, to a folder that exists. Anything else (a
// UNC share, a relative path, something starting with "-" that Code.exe would
// read as a flag) is not handed over. A quote, which could close the quoting on
// Code.exe's command line and add flags, can't be in a Windows folder name, so
// "must exist" (isDir) is what keeps one out.
const DRIVE_PATH = /^[A-Za-z]:\\[^\\]/;

// { ok:true, folder, uri, text, title } or { ok:false, reason }. `title` is the
// chat's name as its VS Code tab shows it, for checking the right tab is the
// one in front before anything is typed; a chat without one is refused.
function planPrompt(snapshot, sessionId, text) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { ok: false, reason: 'bad-session' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
  // One line: the box takes one, and Enter in it sends.
  const prompt = text.replace(/[\r\n]+/g, ' ').trim();
  if (prompt.length > MAX_PROMPT) return { ok: false, reason: 'too-long' };

  const sessions = (snapshot && Array.isArray(snapshot.sessions)) ? snapshot.sessions : [];
  const s = sessions.find(x => x && x.sessionId === sessionId);
  if (!s) return { ok: false, reason: 'not-live' };
  if (s.entrypoint !== 'claude-vscode') return { ok: false, reason: 'not-vscode' };
  if (typeof s.cwd !== 'string' || !DRIVE_PATH.test(s.cwd)) return { ok: false, reason: 'bad-folder' };
  const folder = s.cwd.replace(/\\+$/, '');
  if (!isDir(folder)) return { ok: false, reason: 'bad-folder' };

  // The chat is told apart from the others in its window only by its name, so
  // it needs one, and no other open chat in that folder may share it: typing
  // into the wrong chat is worse than not sending.
  const title = titleOf(s);
  if (!title) return { ok: false, reason: 'no-title' };
  const same = sessions.filter(x => x && x !== s && typeof x.cwd === 'string'
    && x.cwd.replace(/\\+$/, '').toLowerCase() === folder.toLowerCase()
    && (titleOf(x) || '').toLowerCase() === title.toLowerCase());
  if (same.length) return { ok: false, reason: 'ambiguous-chat' };

  const uri = 'vscode://anthropic.claude-code/open?session=' + encodeURIComponent(sessionId);
  return { ok: true, folder, uri, text: prompt, title };
}

// The chat's name as its VS Code tab shows it: the session row's description.
function titleOf(s) {
  const head = Array.isArray(s.agents) ? s.agents.find(a => a && a.isSession) : null;
  return head && typeof head.description === 'string' && head.description.trim() ? head.description.trim() : null;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { planPrompt, MAX_PROMPT };
