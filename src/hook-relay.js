'use strict';
// Run by Claude Code as a PermissionRequest hook. It hands the request to the
// notch, waits for you to answer there, and prints the decision back.
//
// The one rule that matters: if anything at all goes wrong — the app is not
// running, the pipe is gone, the answer never comes, the payload is malformed,
// the other end cannot prove it is the notch — this exits 0 having printed
// NOTHING. Claude Code then asks in the terminal the way it always did. A
// failure here can never turn into a silent "allow".
//
// Who is on the other end: the notch picks a random pipe name and a random
// secret each launch and writes both to HOOK_FILE, which sits in the user's
// profile, so only this user (and SYSTEM / admins) can read it. Before sending
// anything the relay says hello with a fresh nonce, and the server has to answer
// with HMAC-SHA256(secret, 'winnotch-hook:' + nonce), and its decision line must
// carry HMAC-SHA256(secret, 'decision:' + nonce + ':' + decision). A process
// squatting the pipe can't read the secret, so it never sees the request and
// can't answer it. The server side is startHookServer() in main.js; both strings
// must match the ones there.
//
// Wired up by hook-install.js.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const HOOK_FILE = path.join(os.homedir(), '.claude', 'winnotch-hook.json');
const PIPE_PREFIX = '\\\\.\\pipe\\winnotch-hook-';
// Must stay under the hook timeout in settings.json, so the fallback is ours.
const WAIT_MS = 110000;
// The notch answers a hello at once. Anything slower is not the notch, and a
// session shouldn't sit waiting on it.
const HELLO_MS = 3000;
// Replies are a line of JSON; anything bigger without a newline is not ours.
const MAX_LINE = 64 * 1024;
// Tools the notch has no business answering; see main() for why.
const NOT_OURS = new Set(['AskUserQuestion']);

function mac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

// What the notch must answer a hello with.
function proof(secret, nonce) {
  return mac(secret, 'winnotch-hook:' + nonce);
}

function sameProof(got, want) {
  if (typeof got !== 'string' || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// Where the notch is listening and the secret it proves itself with, or null.
function readHookInfo() {
  let info;
  try { info = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8')); } catch { return null; }
  if (!info || typeof info !== 'object') return null;
  if (typeof info.pipe !== 'string' || !info.pipe.startsWith(PIPE_PREFIX)) return null;
  if (typeof info.secret !== 'string' || !/^[0-9a-f]{64}$/.test(info.secret)) return null;
  return { pipe: info.pipe, secret: info.secret };
}

// The hook's stdout for a decision, or null for "let the terminal ask".
function decisionOutput(decision, payload) {
  const out = { hookSpecificOutput: { hookEventName: 'PermissionRequest' } };
  if (decision === 'allow') {
    out.hookSpecificOutput.decision = { behavior: 'allow' };
  } else if (decision === 'always') {
    // A suggestion comes in as {type, description, rule}; updatedPermissions
    // wants {rule, scope}, and the documented scopes are "session" and
    // "project". Session, because project would write the repo's shared
    // .claude/settings.json behind the user's back.
    const sugg = payload && payload.permission_suggestions;
    const rules = Array.isArray(sugg)
      ? sugg.filter(r => r && typeof r.rule === 'string' && r.rule)
            .map(r => ({ rule: r.rule, scope: 'session' }))
      : [];
    out.hookSpecificOutput.decision = rules.length
      ? { behavior: 'allow', updatedPermissions: rules }
      : { behavior: 'allow' };
  } else if (decision === 'deny') {
    out.hookSpecificOutput.decision = { behavior: 'deny', message: 'Denied from the notch' };
  } else {
    return null;   // anything else, including "ask", means leave it to the terminal
  }
  return out;
}

function giveUp() {
  // No stdout at all: Claude Code prompts normally.
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
    // Claude Code closes stdin promptly; this is only a backstop.
    setTimeout(() => resolve(buf), 4000);
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { return giveUp(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return giveUp();
  // Without these there is nothing to show but the word "tool", and nobody can
  // judge a request they cannot see. Fall back to the terminal instead.
  if (typeof payload.tool_name !== 'string' || !payload.tool_name) return giveUp();
  if (!payload.tool_input || typeof payload.tool_input !== 'object') return giveUp();
  // Some tools cannot be arbitrated with allow/deny, and putting them in the
  // notch is worse than leaving them alone. AskUserQuestion is a question with
  // its own answers, not a permission: the card had no command to show, so it
  // read "(no detail given)" over three buttons that could not answer anything,
  // and because a pending card holds the panel open it sat there for the full
  // 110s wait while the question was being answered in the terminal.
  if (NOT_OURS.has(payload.tool_name)) return giveUp();
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  const info = readHookInfo();
  if (!info) return giveUp();   // notch not running, or not one that speaks this
  const nonce = crypto.randomBytes(16).toString('hex');
  const want = proof(info.secret, nonce);

  const sock = net.createConnection(info.pipe);
  let settled = false, verified = false, buf = '';
  const timers = [];
  const done = fn => {
    if (settled) return;
    settled = true;
    timers.forEach(clearTimeout);
    try { sock.destroy(); } catch {}
    fn();
  };

  timers.push(setTimeout(() => done(giveUp), WAIT_MS));
  timers.push(setTimeout(() => { if (!verified) done(giveUp); }, HELLO_MS));

  sock.on('error', () => done(giveUp));
  // The app shut down mid-question: fall back rather than hang.
  sock.on('close', () => done(giveUp));

  sock.on('connect', () => {
    sock.write(JSON.stringify({ kind: 'hello', nonce }) + '\n');
  });

  sock.on('data', chunk => {
    if (settled) return;
    buf += chunk.toString('utf8');
    let nl;
    while (!settled && (nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { msg = null; }
      if (!verified) {
        if (!msg || !sameProof(msg.proof, want)) { done(giveUp); return; }
        verified = true;
        sock.write(JSON.stringify({
          kind: 'permission',
          cwd,
          project: path.basename(cwd),
          sessionId: payload.session_id || null,
          tool: payload.tool_name,
          input: payload.tool_input,
        }) + '\n');
        continue;
      }
      // The answer is signed too, so nothing sitting between here and the notch can
      // swap it. Unsigned or wrongly signed counts as no answer.
      const decision = msg && typeof msg.decision === 'string'
        && sameProof(msg.mac, mac(info.secret, 'decision:' + nonce + ':' + msg.decision))
        ? msg.decision : null;
      const out = decisionOutput(decision, payload);
      done(() => {
        if (!out) return giveUp();
        // Exit once the line is out, so a slow pipe can't cut it short; the
        // backstop covers a stdout that never reports back.
        setTimeout(giveUp, 2000);
        process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0));
      });
      return;
    }
    if (!settled && buf.length > MAX_LINE) done(giveUp);
  });
}

module.exports = { mac, proof, decisionOutput, readHookInfo, HOOK_FILE, PIPE_PREFIX };

if (require.main === module) {
  // The socket callbacks run outside main()'s catch, so a throw in one of them
  // would escape and exit 1 with a stack trace. The contract is that every
  // failure is silent, so it is enforced at the process level. Only when run as
  // the hook: a test requiring this file must keep its own error handling.
  process.on('uncaughtException', giveUp);
  process.on('unhandledRejection', giveUp);
  main().catch(giveUp);
}
