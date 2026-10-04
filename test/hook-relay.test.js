'use strict';
// Drives the real relay process against a stand-in notch server on a random pipe,
// with HOME pointed at a temp dir so the real ~/.claude is never read. The last
// test runs it against main.js's own pipe server instead (fake-electron.js).
const nodeTest = require('node:test');
// Every case is a few seconds at most; a hang is a failure, not a wait.
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
test.after = nodeTest.after;
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'winnotch-relay-'));
// In this process too: the relay required as a module, and main.js in the
// end-to-end test, both derive HOOK_FILE from the home directory when loaded.
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
assert.strictEqual(os.homedir(), HOME, 'home must be the temp dir before anything loads');
const FILE = path.join(HOME, '.claude', 'winnotch-hook.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

const { SRC, loadMain, quitAll, until } = require('./fake-electron');
const RELAY = process.env.RELAY_PATH || path.join(SRC, 'hook-relay.js');

const PAYLOAD = {
  session_id: 's1', cwd: 'C:\\x\\proj', tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  permission_suggestions: [
    { type: 'allow', description: 'Allow this exact command', rule: 'Bash(npm test)' },
    { type: 'allow_pattern', description: 'all npm', rule: 'Bash(npm *)' },
    { type: 'allow', description: 'junk' },
  ],
};

function runRelay(payload = PAYLOAD) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, { USERPROFILE: HOME, HOME });
    delete env.ELECTRON_RUN_AS_NODE;
    const t0 = Date.now();
    const p = spawn(process.execPath, [RELAY, 'winnotch-hook'], { env });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const SECRET = crypto.randomBytes(32).toString('hex');
const macOf = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
const proofOf = (secret, nonce) => macOf(secret, 'winnotch-hook:' + nonce);
const signed = (decision, nonce, secret = SECRET) => JSON.stringify({ decision, mac: macOf(secret, 'decision:' + nonce + ':' + decision) }) + '\n';

// A stand-in notch. `behave(sock, line, stage, record)` decides what happens.
const live = new Set();
function server(behave, opts = {}) {
  const pipe = (opts.prefix || '\\\\.\\pipe\\winnotch-hook-') + crypto.randomBytes(16).toString('hex');
  const record = { lines: [], requests: 0 };
  const socks = new Set();
  const srv = net.createServer(sock => {
    socks.add(sock);
    let buf = '', stage = 'hello', nonce = null;
    sock.on('error', () => {});
    sock.on('data', c => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        record.lines.push(line);
        let msg; try { msg = JSON.parse(line); } catch { msg = null; }
        if (stage === 'request' && msg && msg.kind === 'permission') record.requests++;
        if (stage === 'hello' && msg && msg.nonce) nonce = msg.nonce;
        behave(sock, msg, stage, record, nonce);
        stage = stage === 'hello' ? 'request' : 'done';
      }
    });
  });
  return new Promise(res => srv.listen(pipe, () => {
    fs.writeFileSync(FILE, JSON.stringify({ pipe, secret: opts.secret || SECRET }));
    const h = { srv, record, close: () => new Promise(r => { live.delete(h); socks.forEach(x => x.destroy()); srv.close(() => r()); }) };
    live.add(h);
    res(h);
  }));
}

const honest = decision => (sock, msg, stage, record, nonce) => {
  if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf(SECRET, msg.nonce) }) + '\n');
  else sock.end(signed(decision, nonce));
};

const proves = then => (sock, msg, stage, record, nonce) => {
  if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf(SECRET, msg.nonce) }) + '\n');
  else then(sock, nonce);
};

test('a decision without a mac is not honoured', async () => {
  const s = await server(proves(sock => sock.end('{"decision":"allow"}\n')));
  silent(await runRelay());
  await s.close();
});

test('a mac for a different decision is not honoured', async () => {
  const s = await server(proves((sock, nonce) => sock.end(JSON.stringify({ decision: 'always', mac: macOf(SECRET, 'decision:' + nonce + ':allow') }) + '\n')));
  silent(await runRelay());
  await s.close();
});

test('a mac for another nonce is not honoured', async () => {
  const s = await server(proves(sock => sock.end(signed('allow', 'f'.repeat(32)))));
  silent(await runRelay());
  await s.close();
});

function silent(r) {
  assert.strictEqual(r.code, 0, 'exit 0');
  assert.strictEqual(r.out, '', 'no stdout: ' + r.out);
  assert.strictEqual(r.err, '', 'no stderr: ' + r.err);
}

test('no hook file: falls back at once', async () => {
  try { fs.unlinkSync(FILE); } catch {}
  const r = await runRelay();
  silent(r);
  assert.ok(r.ms < 2500, 'fast: ' + r.ms);
});

for (const [name, body] of [
  ['bad json', '{nope'],
  ['wrong prefix', JSON.stringify({ pipe: '\\\\.\\pipe\\other', secret: SECRET })],
  ['short secret', JSON.stringify({ pipe: '\\\\.\\pipe\\winnotch-hook-x', secret: 'ab' })],
  ['array', '[]'],
]) {
  test('unusable hook file (' + name + '): falls back', async () => {
    fs.writeFileSync(FILE, body);
    silent(await runRelay());
  });
}

test('a file naming some other pipe is not followed, even to a server that would answer', async () => {
  const s = await server(honest('allow'), { prefix: '\\\\.\\pipe\\other-' });
  silent(await runRelay());
  assert.strictEqual(s.record.lines.length, 0, 'must not connect');
  await s.close();
});

test('a malformed secret is refused, even when the server proves with it', async () => {
  const bad = 'not-hex';
  const s = await server((sock, msg, stage) => {
    if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf(bad, msg.nonce) }) + '\n');
    else sock.end('{"decision":"allow"}\n');
  }, { secret: bad });
  silent(await runRelay());
  assert.strictEqual(s.record.lines.length, 0, 'must not connect');
  await s.close();
});

test('stale file, nobody listening: falls back fast', async () => {
  fs.writeFileSync(FILE, JSON.stringify({ pipe: '\\\\.\\pipe\\winnotch-hook-' + 'f'.repeat(32), secret: SECRET }));
  const r = await runRelay();
  silent(r);
  assert.ok(r.ms < 2500, 'fast: ' + r.ms);
});

test('a squatter without the secret never sees the request and decides nothing', async () => {
  const s = await server((sock, msg, stage) => {
    if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf('0'.repeat(64), msg.nonce) }) + '\n');
    else sock.end('{"decision":"always"}\n');
  });
  const r = await runRelay();
  silent(r);
  assert.strictEqual(s.record.requests, 0, 'request must not be sent to an unproven server');
  assert.ok(!s.record.lines.some(l => l.includes('npm test')), 'tool input leaked');
  await s.close();
});

test('a server that sends a decision instead of a proof is ignored', async () => {
  const s = await server(sock => sock.end('{"decision":"allow"}\n'));
  silent(await runRelay());
  await s.close();
});

test('a server that never answers hello: falls back after ~3 s', async () => {
  const s = await server(() => {});
  const r = await runRelay();
  silent(r);
  assert.ok(r.ms >= 2500 && r.ms < 8000, 'hello timeout honoured: ' + r.ms);
  assert.strictEqual(s.record.requests, 0);
  await s.close();
});

test('server closes after a valid proof: falls back', async () => {
  const s = await server((sock, msg, stage) => {
    if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf(SECRET, msg.nonce) }) + '\n');
    else sock.destroy();
  });
  silent(await runRelay());
  await s.close();
});

test('allow', async () => {
  const s = await server(honest('allow'));
  const r = await runRelay();
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.strictEqual(s.record.requests, 1);
  const req = JSON.parse(s.record.lines[1]);
  assert.strictEqual(req.tool, 'Bash');
  assert.deepStrictEqual(req.input, { command: 'npm test' });
  assert.strictEqual(req.project, 'proj');
  assert.strictEqual(req.sessionId, 's1');
  await s.close();
});

test('deny', async () => {
  const s = await server(honest('deny'));
  const r = await runRelay();
  assert.strictEqual(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'deny');
  await s.close();
});

test('ask means the terminal', async () => {
  const s = await server(honest('ask'));
  silent(await runRelay());
  await s.close();
});

test('always turns suggestions into session rules', async () => {
  const s = await server(honest('always'));
  const r = await runRelay();
  assert.deepStrictEqual(JSON.parse(r.out).hookSpecificOutput.decision, {
    behavior: 'allow',
    updatedPermissions: [{ rule: 'Bash(npm test)', scope: 'session' }, { rule: 'Bash(npm *)', scope: 'session' }],
  });
  await s.close();
});

test('always with no usable suggestion is a plain allow', async () => {
  const s = await server(honest('always'));
  const r = await runRelay(Object.assign({}, PAYLOAD, { permission_suggestions: [{ rule: 5 }] }));
  assert.deepStrictEqual(JSON.parse(r.out).hookSpecificOutput.decision, { behavior: 'allow' });
  await s.close();
});

test('garbage reply after the proof: falls back', async () => {
  const s = await server((sock, msg, stage) => {
    if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf(SECRET, msg.nonce) }) + '\n');
    else sock.end('not json\n');
  });
  silent(await runRelay());
  await s.close();
});

test('replies split mid-line still work', async () => {
  const s = await server((sock, msg, stage, record, nonce) => {
    const line = stage === 'hello'
      ? JSON.stringify({ proof: proofOf(SECRET, msg.nonce) }) + '\n'
      : signed('allow', nonce);
    sock.write(line.slice(0, 5));
    setTimeout(() => { if (stage === 'hello') sock.write(line.slice(5)); else sock.end(line.slice(5)); }, 50);
  });
  const r = await runRelay();
  assert.strictEqual(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'allow');
  await s.close();
});

test('a reply that never ends a line is cut off', async () => {
  const s = await server((sock, msg, stage) => {
    if (stage === 'hello') sock.write(JSON.stringify({ proof: proofOf(SECRET, msg.nonce) }) + '\n');
    else sock.write('x'.repeat(70 * 1024));
  });
  const r = await runRelay();
  silent(r);
  assert.ok(r.ms < 8000, 'cut off promptly: ' + r.ms);
  await s.close();
});

for (const [name, p] of [
  ['not json', 'nope'],
  ['array', '[]'],
  ['no tool', JSON.stringify({ tool_input: {} })],
  ['no input', JSON.stringify({ tool_name: 'Bash' })],
]) {
  test('bad stdin (' + name + '): falls back without connecting', async () => {
    const s = await server(honest('allow'));
    silent(await runRelay(p));
    assert.strictEqual(s.record.lines.length, 0, 'must not connect');
    await s.close();
  });
}

test('required as a module it has no side effects', () => {
  const before = process.listenerCount('uncaughtException');
  const m = require(RELAY);
  assert.strictEqual(process.listenerCount('uncaughtException'), before);
  assert.strictEqual(typeof m.proof, 'function');
  assert.strictEqual(m.proof(SECRET, 'ab'), proofOf(SECRET, 'ab'));
});

test('end to end: the real relay and main.js\'s real pipe server agree on proof and mac', async () => {
  try { fs.unlinkSync(FILE); } catch {}
  const realLog = console.log;
  console.log = (...a) => { if (!String(a[0]).startsWith('[WinNotch]')) realLog(...a); };
  const inst = await loadMain({ home: HOME });
  try {
    await until(() => fs.existsSync(FILE), 3000, 'main.js to publish its hook file');
    const rules = [{ rule: 'Bash(npm test)', scope: 'session' }, { rule: 'Bash(npm *)', scope: 'session' }];
    for (const [decision, want] of [
      ['allow', { behavior: 'allow' }],
      ['always', { behavior: 'allow', updatedPermissions: rules }],
      ['deny', { behavior: 'deny', message: 'Denied from the notch' }],
      ['ask', null],
    ]) {
      const before = inst.win.webContents.sentOn('permission').length;
      const run = runRelay();
      const req = await until(() => inst.win.webContents.sentOn('permission')[before], 8000, 'the card for ' + decision);
      assert.deepStrictEqual(req, { id: req.id, tool: 'Bash', input: { command: 'npm test' }, project: 'proj', cwd: 'C:\\x\\proj', sessionId: 's1' });
      assert.strictEqual(await inst.invoke('permission-answer', { id: req.id, decision }), true);
      const r = await run;
      if (want === null) silent(r);
      else {
        assert.strictEqual(r.code, 0);
        assert.deepStrictEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: want } }, decision);
      }
    }
  } finally {
    inst.quit();
    console.log = realLog;
  }
  assert.strictEqual(fs.existsSync(FILE), false, 'quitting removed the hook file');
});

test.after(async () => {
  quitAll();
  for (const h of [...live]) await h.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});
