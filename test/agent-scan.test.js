'use strict';
// The scanner reads an undocumented format that drifts between Claude Code
// versions, so these build the files by hand and check the state machine and the
// skip-rather-than-guess behaviour. Everything hangs off a fake home directory,
// which is why the module is required AFTER the env var is pointed at it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'winnotch-scan-'));
process.env.USERPROFILE = ROOT;   // os.homedir() on Windows
process.env.HOME = ROOT;          // ...and everywhere else

const CWD = path.join(ROOT, 'proj');
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-');
const SESSION = 'ffffffff-0000-4000-8000-000000000001';
const SUBS = path.join(ROOT, '.claude', 'projects', SLUG, SESSION, 'subagents');

fs.mkdirSync(path.join(ROOT, '.claude', 'sessions'), { recursive: true });
fs.mkdirSync(SUBS, { recursive: true });

function writeSession(pid) {
  fs.writeFileSync(
    path.join(ROOT, '.claude', 'sessions', pid + '.json'),
    JSON.stringify({ sessionId: SESSION, name: 'test-sess', cwd: CWD, status: 'busy', version: '9.9.9', pid }),
  );
}

// One agent: its meta, its log, and how long ago the log was last appended to.
function writeAgent(id, meta, lines, ageMs) {
  fs.writeFileSync(path.join(SUBS, 'agent-' + id + '.meta.json'),
    JSON.stringify(Object.assign({ agentType: 'builder', description: 'do a thing', spawnDepth: 1 }, meta)));
  const jsonl = path.join(SUBS, 'agent-' + id + '.jsonl');
  fs.writeFileSync(jsonl, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(jsonl, t, t);
  }
}

const working = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } };
const ended = { type: 'user', toolEndsTurn: true, message: { content: [] } };

writeSession(process.pid);                                   // this test's own pid is alive
writeAgent('a1', {}, [working]);                             // fresh, unfinished
writeAgent('a2', {}, [working, ended]);                      // carries the end marker
writeAgent('a3', { stoppedByUser: true }, [working]);        // killed by the user
writeAgent('a4', {}, [working], 10 * 60 * 1000);             // quiet for ten minutes
writeAgent('a5', { agentType: undefined }, [working]);       // format drifted: no type
writeAgent('a6', { spawnDepth: 2, parentAgentId: 'a1', description: 'child work' }, [working]);
// The end marker with another record written after it.
writeAgent('a7', {}, [working, ended, { type: 'system', subtype: 'summary' }]);
// The end marker buried behind a record far larger than a small tail would hold.
writeAgent('a8', {}, [ended, { type: 'assistant', bulk: 'x'.repeat(140 * 1024) }]);

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');
const scanMod = require(path.join(SRC, 'agent-scan.js'));
const { scan } = scanMod;
const snap = scan();
const byDesc = Object.fromEntries(snap.sessions[0].agents.map(a => [a.id, a]));

test('a live session is found and its agents read', () => {
  assert.strictEqual(snap.sessions.length, 1);
  assert.strictEqual(snap.sessions[0].name, 'test-sess');
  assert.strictEqual(snap.sessions[0].project, 'proj');
});

test('a fresh unfinished agent is running, and reports its current tool', () => {
  assert.strictEqual(byDesc.a1.state, 'running');
  assert.strictEqual(byDesc.a1.activity, 'Bash');
});

test('the end-of-turn marker means done, and outranks a fresh mtime', () => {
  assert.strictEqual(byDesc.a2.state, 'done');
});

test('stoppedByUser outranks everything else', () => {
  // It is fresh and unfinished, so without the flag it would read as running.
  assert.strictEqual(byDesc.a3.state, 'stopped');
});

test('a long-quiet agent is stalled, never silently called done', () => {
  assert.strictEqual(byDesc.a4.state, 'stalled');
  assert.notStrictEqual(byDesc.a4.state, 'done');
});

test('an agent whose metadata lost its fields is skipped, not guessed at', () => {
  assert.strictEqual(byDesc.a5, undefined);
});

test('nesting is preserved so children group under their parent', () => {
  assert.strictEqual(byDesc.a6.depth, 2);
  assert.strictEqual(byDesc.a6.parentId, 'a1');
  const depths = snap.sessions[0].agents.map(a => a.depth);
  assert.deepStrictEqual(depths, [...depths].sort((x, y) => x - y), 'shallowest first');
});

test('the end marker still counts when a record follows it', () => {
  // Checking only the last line missed this and left a finished agent looking
  // like it was still working.
  assert.strictEqual(byDesc.a7.state, 'done');
});

test('the end marker is found behind a record larger than a small tail', () => {
  // The tail has to hold the biggest record whole, or a finished agent reads as
  // running and then sticks on stalled for good.
  assert.strictEqual(byDesc.a8.state, 'done');
});

test('totals count only what is actually running', () => {
  assert.strictEqual(snap.totals.agents, 7);    // a5 was skipped
  assert.strictEqual(snap.totals.running, 2);   // a1 and a6
  assert.strictEqual(snap.totals.stalled, 1);
  assert.strictEqual(snap.totals.done, 3);      // a2, a7, a8
});

test('a session whose process is gone is dropped', () => {
  // A pid that cannot exist; the file stays behind, the session must not show.
  fs.writeFileSync(path.join(ROOT, '.claude', 'sessions', '999999.json'),
    JSON.stringify({ sessionId: 'dead', name: 'ghost', cwd: CWD, pid: 999999 }));
  const again = scan();
  assert.ok(!again.sessions.some(s => s.name === 'ghost'), 'stale session file must be ignored');
  fs.unlinkSync(path.join(ROOT, '.claude', 'sessions', '999999.json'));
});

test('no sessions directory at all is empty, not a crash', () => {
  fs.rmSync(path.join(ROOT, '.claude', 'sessions'), { recursive: true, force: true });
  const empty = scan();
  assert.deepStrictEqual(empty.sessions, []);
  assert.strictEqual(empty.totals.running, 0);
});

// ── end detection, validation, cache, payload, watch (R2, findings 6-8, 12) ──
// Each test gets a session of its own, removed afterwards, so the snapshots the
// watch tests compare hold nothing but what that test wrote.

const SESSIONS = path.join(ROOT, '.claude', 'sessions');
let nSess = 0;
function session(t, fields = {}) {
  const k = ++nSess;
  const sid = 'eeeeeeee-0000-4000-8000-' + String(k).padStart(12, '0');
  const cwd = path.join(ROOT, 'proj' + k);
  const subs = path.join(ROOT, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), sid, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  const file = path.join(SESSIONS, 'extra-' + k + '.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign(
    { sessionId: sid, name: 'sess' + k, cwd, status: 'busy', version: '1', pid: process.pid }, fields)));
  t.after(() => fs.rmSync(file, { force: true }));
  const s = {
    sid, subs, file,
    jsonl: id => path.join(subs, 'agent-' + id + '.jsonl'),
    meta: id => path.join(subs, 'agent-' + id + '.meta.json'),
    agent(id, lines, meta = {}, ageMs = 0) {
      fs.writeFileSync(s.meta(id), JSON.stringify(Object.assign({ agentType: 'builder', description: 'job ' + id, spawnDepth: 1 }, meta)));
      fs.writeFileSync(s.jsonl(id), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
      if (ageMs) { const d = new Date(Date.now() - ageMs); fs.utimesSync(s.jsonl(id), d, d); }
    },
    append(id, lines) { fs.appendFileSync(s.jsonl(id), lines.map(l => JSON.stringify(l)).join('\n') + '\n'); },
    // The chat's own log, which sits one level up from its subagents'.
    selfLog(lines) {
      fs.writeFileSync(path.join(subs, '..', '..', sid + '.jsonl'),
        lines.map(l => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    },
    self: () => s.read().agents.find(a => a.isSession),
    read: () => scan().sessions.find(x => x.sessionId === sid),
    get: id => s.read().agents.find(a => a.id === id),
  };
  return s;
}

const toolUse = (name, id) => ({ type: 'assistant', message: { stop_reason: 'tool_use', content: [
  { type: 'text', text: 'next: ' + id }, { type: 'tool_use', id, name, input: { command: 'run ' + id, description: 'step ' + id } }] } });
const result = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const stopped = reason => ({ type: 'assistant', message: { stop_reason: reason, content: [{ type: 'text', text: 'All done.' }] } });
const apiError = { type: 'assistant', isApiErrorMessage: true, message: { stop_reason: null, content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } };
const marker = { type: 'user', toolEndsTurn: true, message: { content: [] } };
const partial = { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'Thinking it over' }] } };
const userText = { type: 'user', message: { content: [{ type: 'text', text: 'carry on' }] } };
// What pressing Esc mid-tool leaves in the log, and nothing else.
const interrupted = { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };

test('E32 an agent whose last record is an API error (no tool call) is done', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), result('t1'), apiError]);
  assert.strictEqual(s.get('x').state, 'done');
});

test('E33 older Claude Code without a marker: a terminal stop_reason means done', t => {
  const s = session(t);
  for (const reason of ['end_turn', 'stop_sequence', 'refusal']) {
    s.agent(reason, [toolUse('Bash', 't1'), result('t1'), stopped(reason)]);
    assert.strictEqual(s.get(reason).state, 'done', reason);
  }
  s.agent('max', [toolUse('Bash', 't1'), result('t1'), stopped('max_tokens')]);
  assert.strictEqual(s.get('max').state, 'running', 'max_tokens is not the end of a turn');
});

test('E34 a fresh pending tool call is running', t => {
  const s = session(t);
  s.agent('x', [stopped('end_turn'), toolUse('Read', 't1')]);
  assert.strictEqual(s.get('x').state, 'running');
  assert.strictEqual(s.get('x').activity, 'Read');
});

test('E35 a user record after end_turn means the turn carried on (running, or stalled when quiet)', t => {
  const s = session(t);
  s.agent('fresh', [stopped('end_turn'), userText]);
  s.agent('quiet', [stopped('end_turn'), userText], {}, 10 * 60 * 1000);
  assert.strictEqual(s.get('fresh').state, 'running');
  assert.strictEqual(s.get('quiet').state, 'stalled');
});

test('E55 a streamed partial or a system record after the end changes nothing', t => {
  const s = session(t);
  s.agent('p', [stopped('end_turn'), partial]);
  s.agent('m', [toolUse('Bash', 't1'), marker, { type: 'system', subtype: 'x' }]);
  assert.strictEqual(s.get('p').state, 'done');
  assert.strictEqual(s.get('m').state, 'done');
});

test('E54 an agent resumed after a toolEndsTurn marker reads running again', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), marker, toolUse('Edit', 't2')]);
  assert.strictEqual(s.get('x').state, 'running');
  assert.strictEqual(s.get('x').activity, 'Edit');
});

test('a marker cut in half by the tail still ends the agent, unless a later record resumes it', t => {
  const s = session(t);
  // Bigger than the 256 KB tail, so the tail starts inside this record.
  const big = JSON.stringify({ type: 'user', bulk: 'x'.repeat(300 * 1024), toolEndsTurn: true });
  s.agent('cut', [big, JSON.stringify({ type: 'system', subtype: 'x' })]);
  s.agent('resumed', [big, toolUse('Grep', 't9')]);
  assert.strictEqual(s.get('cut').state, 'done');
  assert.strictEqual(s.get('resumed').state, 'running');
});

test('E36 malformed agent meta is skipped without throwing; odd optional fields are dropped', t => {
  const s = session(t);
  s.agent('ok', [toolUse('Bash', 't1')], { spawnDepth: 'deep', parentAgentId: 5, model: {}, requestShape: 7 });
  s.agent('bad-type', [toolUse('Bash', 't1')], { agentType: {} });
  const agents = s.read().agents;
  assert.deepStrictEqual(agents.map(a => a.id), ['ok'], 'only the type is required');
  assert.strictEqual(agents[0].depth, 1);
  assert.strictEqual(agents[0].parentId, null);
  assert.strictEqual(agents[0].model, null);
  assert.strictEqual(agents[0].shape, null);
});

// A slash command starts an agent with a type and nothing else. Dropping those
// meant a running agent was simply absent from the panel, with no sign of it.
test('E50 an agent with no description is named from the line it was started with', t => {
  const s = session(t);
  s.agent('x', [
    { type: 'user', message: { content: [{ type: 'text', text: 'Review target: `pr-54`\nmore detail here' }] } },
    toolUse('Bash', 't1'),
  ], { agentType: 'general-purpose', description: undefined });
  assert.strictEqual(s.get('x').description, 'Review target: `pr-54`', 'first line only');
});

test('E50 a description that is not usable falls back the same way', t => {
  const s = session(t);
  const opener = [{ type: 'user', message: { content: [{ type: 'text', text: 'do the job' }] } }];
  s.agent('num',   [...opener, toolUse('Bash', 't1')], { description: 42 });
  s.agent('blank', [...opener, toolUse('Bash', 't2')], { description: '   ' });
  for (const id of ['num', 'blank']) assert.strictEqual(s.get(id).description, 'do the job', id);
});

test('E50 with nothing to read, the type is the name rather than nothing', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')], { agentType: 'general-purpose', description: '' });
  // The opening record is an assistant turn, so there is no prompt line to take.
  assert.strictEqual(s.get('x').description, 'general-purpose');
});

test('E37 malformed session records are skipped or cleaned, never thrown on', t => {
  const badId = path.join(SESSIONS, 'bad-id.json');
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(badId, JSON.stringify({ sessionId: 7, cwd: ROOT, pid: process.pid }));
  t.after(() => fs.rmSync(badId, { force: true }));
  const oddCwd = session(t, { cwd: 5, name: 42, status: 5, version: {} });
  const strPid = session(t, { pid: String(process.pid) });
  const snap = scan();
  assert.ok(!snap.sessions.some(x => x.sessionId === 7), 'a non-string sessionId is skipped');
  const odd = snap.sessions.find(x => x.sessionId === oddCwd.sid);
  assert.ok(odd, 'a session with an odd cwd is still listed');
  assert.strictEqual(odd.cwd, null);
  assert.strictEqual(odd.project, null);
  assert.strictEqual(odd.name, oddCwd.sid.slice(0, 8));
  assert.strictEqual(odd.status, null);
  assert.strictEqual(odd.version, null);
  assert.ok(!snap.sessions.some(x => x.sessionId === strPid.sid), 'a pid that is not an integer is not alive');
});

test('R2 the snapshot carries no prompt, and finished agents carry no recent calls', t => {
  const s = session(t);
  s.agent('run', [toolUse('Bash', 't1')]);
  s.agent('stall', [toolUse('Bash', 't1')], {}, 10 * 60 * 1000);
  s.agent('done', [toolUse('Bash', 't1'), marker]);
  s.agent('stop', [toolUse('Bash', 't1')], { stoppedByUser: true });
  const by = Object.fromEntries(s.read().agents.map(a => [a.id, a]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['done', 'run', 'stall', 'stop']);
  for (const a of Object.values(by)) assert.ok(!('prompt' in a), a.id + ' has no prompt field');
  assert.strictEqual(by.run.recent.length, 1);
  assert.strictEqual(by.stall.state, 'stalled');
  assert.strictEqual(by.stall.recent.length, 1);
  assert.deepStrictEqual(by.done.recent, []);
  assert.strictEqual(by.done.activity, 'Bash', 'activity still reported');
  assert.deepStrictEqual(by.stop.recent, []);
});

test('E44 an unchanged agent is not read again on the next scan', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  const open = t.mock.method(fs, 'openSync');
  const readF = t.mock.method(fs, 'readFileSync');
  const opensOf = f => open.mock.calls.filter(c => c.arguments[0] === f).length;
  const readsOf = f => readF.mock.calls.filter(c => c.arguments[0] === f).length;
  assert.strictEqual(s.get('x').activity, 'Bash');
  assert.strictEqual(opensOf(s.jsonl('x')), 1, 'read the first time');
  assert.strictEqual(readsOf(s.meta('x')), 1);
  assert.strictEqual(s.get('x').activity, 'Bash');
  assert.strictEqual(opensOf(s.jsonl('x')), 1, 'not read again');
  assert.strictEqual(readsOf(s.meta('x')), 1, 'meta not read again');
});

test('E45 an agent whose log grew is read again and shows the new call', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  assert.strictEqual(s.get('x').activity, 'Bash');
  s.append('x', [result('t1'), toolUse('Edit', 't2')]);
  const a = s.get('x');
  assert.strictEqual(a.activity, 'Edit');
  assert.deepStrictEqual(a.recent.map(c => c.id), ['t2', 't1']);
  assert.strictEqual(a.recent[1].output, 'ok', 'the result is attached to its call');
});

test('E45 a rewritten meta file is read again', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  assert.strictEqual(s.get('x').state, 'running');
  fs.writeFileSync(s.meta('x'), JSON.stringify({ agentType: 'builder', description: 'job x', stoppedByUser: true }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(s.meta('x'), later, later);
  assert.strictEqual(s.get('x').state, 'stopped');
});

test('E46 a done agent that resumes reads running again', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), result('t1'), stopped('end_turn')]);
  assert.strictEqual(s.get('x').state, 'done');
  s.append('x', [userText, toolUse('Write', 't2')]);
  assert.strictEqual(s.get('x').state, 'running');
});

// watch() with the clock under the test's control.
// The first `failing` deliveries throw, as a dead renderer's would.
function watching(t, apis = ['setTimeout', 'setInterval', 'Date'], failing = 0) {
  t.mock.timers.enable({ apis, now: Date.now() });
  const w = { snaps: [], attempts: 0 };
  const stop = scanMod.watch(snap => {
    w.attempts++;
    if (failing-- > 0) throw new Error('renderer gone');
    w.snaps.push(snap);
  }, 1000);
  t.after(stop);
  return w;
}
const agentOf = (snap, sid, id) => snap.sessions.find(x => x.sessionId === sid).agents.find(a => a.id === id);

test('E40 a quiet poll tick pushes nothing', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  const w = watching(t);
  assert.strictEqual(w.snaps.length, 1);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.strictEqual(w.snaps.length, 1, 'idle time moving is not a change');
});

test('E39 a running agent crossing 3 s idle pushes once', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  const at = new Date(Date.now() - 100);
  fs.utimesSync(s.jsonl('x'), at, at);
  const w = watching(t);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.strictEqual(w.snaps.length, 1, 'under 3 s');
  t.mock.timers.tick(1000);
  assert.strictEqual(w.snaps.length, 2, 'crossing 3 s');
  for (let i = 0; i < 5; i++) t.mock.timers.tick(1000);
  assert.strictEqual(w.snaps.length, 2, 'once, not every tick');
  assert.strictEqual(agentOf(w.snaps[1], s.sid, 'x').state, 'running');
});

test('E38 a new call of the same tool pushes', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  const w = watching(t);
  s.append('x', [result('t1'), toolUse('Bash', 't2')]);
  t.mock.timers.tick(1000);
  assert.strictEqual(w.snaps.length, 2);
  assert.strictEqual(agentOf(w.snaps[1], s.sid, 'x').recent[0].id, 't2');
});

test('E43/E70 a delivery that throws is offered again next tick, and the poll keeps going', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  let w;
  assert.doesNotThrow(() => { w = watching(t, undefined, 1); }, 'watch() survives the first delivery throwing');
  assert.strictEqual(w.attempts, 1);
  assert.strictEqual(w.snaps.length, 0);
  t.mock.timers.tick(1000);
  assert.strictEqual(w.attempts, 2, 'the same snapshot offered again');
  assert.strictEqual(agentOf(w.snaps[0], s.sid, 'x').activity, 'Bash');
  t.mock.timers.tick(1000);
  assert.strictEqual(w.attempts, 2, 'not offered again once it went through');
  s.append('x', [result('t1'), toolUse('Glob', 't2')]);
  t.mock.timers.tick(1000);
  assert.strictEqual(w.attempts, 3, 'later changes still delivered');
  assert.strictEqual(agentOf(w.snaps[1], s.sid, 'x').activity, 'Glob');
});

test('E71 a scan that throws is skipped and the poll carries on', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1')]);
  const w = watching(t, ['setTimeout', 'setInterval']);
  assert.strictEqual(w.snaps.length, 1);
  const realNow = Date.now.bind(Date);
  let boom = 1;
  t.mock.method(Date, 'now', () => { if (boom > 0) { boom--; throw new Error('clock gone'); } return realNow(); });
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.strictEqual(boom, 0, 'the scan did throw');
  s.append('x', [result('t1'), toolUse('Read', 't2')]);
  t.mock.timers.tick(1000);
  assert.strictEqual(w.snaps.length, 2, 'the poll is still running');
  assert.strictEqual(agentOf(w.snaps[1], s.sid, 'x').activity, 'Read');
});

test('E41 while one folder is missing, the other is watched exactly once', t => {
  const away = scanMod.PROJECTS_DIR + '.away';
  fs.renameSync(scanMod.PROJECTS_DIR, away);
  t.after(() => { if (fs.existsSync(away)) fs.renameSync(away, scanMod.PROJECTS_DIR); });
  fs.mkdirSync(SESSIONS, { recursive: true });
  const spy = t.mock.method(fs, 'watch');
  const callsFor = dir => spy.mock.calls.filter(c => c.arguments[0] === dir).length;
  watching(t, ['setTimeout', 'setInterval']);
  t.mock.timers.tick(15000);
  assert.strictEqual(callsFor(scanMod.SESSIONS_DIR), 1, 'no second watcher on sessions');
  assert.strictEqual(callsFor(scanMod.PROJECTS_DIR), 4, 'projects retried every 5 s');
  fs.renameSync(away, scanMod.PROJECTS_DIR);
  t.mock.timers.tick(5000);
  assert.strictEqual(callsFor(scanMod.PROJECTS_DIR), 5, 'armed once it is back');
  t.mock.timers.tick(15000);
  assert.strictEqual(callsFor(scanMod.PROJECTS_DIR), 5, 'retry stopped');
  assert.strictEqual(callsFor(scanMod.SESSIONS_DIR), 1);
});

test('E42 a watcher error does not throw, and the folder is watched again', t => {
  fs.mkdirSync(SESSIONS, { recursive: true });
  const spy = t.mock.method(fs, 'watch');
  const callsFor = dir => spy.mock.calls.filter(c => c.arguments[0] === dir);
  watching(t, ['setTimeout', 'setInterval']);
  assert.strictEqual(callsFor(scanMod.SESSIONS_DIR).length, 1);
  const w = callsFor(scanMod.SESSIONS_DIR)[0].result;
  assert.doesNotThrow(() => w.emit('error', new Error('EPERM: folder deleted')));
  t.mock.timers.tick(5000);
  assert.strictEqual(callsFor(scanMod.SESSIONS_DIR).length, 2, 're-armed by the retry');
  t.mock.timers.tick(15000);
  assert.strictEqual(callsFor(scanMod.SESSIONS_DIR).length, 2, 'and only once');
});

test('E46 a closing message is carried once, not once per record that follows', t => {
  const s = session(t);
  // Narration lands in its own record and the results keep arriving after it.
  // The push used to sit inside the content loop, so every later block that came
  // past while the message was still held pushed another copy of it.
  s.agent('x', [toolUse('Bash', 't1'), toolUse('Read', 't2'), partial, result('t1'), result('t2')]);
  const dones = s.get('x').recent.filter(c => c.tool === 'Done');
  assert.strictEqual(dones.length, 1, 'one closing message, however many records follow it');
  assert.strictEqual(dones[0].say, 'Thinking it over');
});

test('E47 an agent interrupted by the user is done, not left running', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), interrupted]);
  assert.strictEqual(s.get('x').state, 'done');
});

test('E47 an interrupt is only the end until the turn picks back up', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), interrupted, userText, toolUse('Edit', 't2')]);
  assert.strictEqual(s.get('x').state, 'running');
});

test('E47 an ordinary user message still means the turn carried on', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), stopped('end_turn'), userText]);
  assert.strictEqual(s.get('x').state, 'running', 'a reply after an end_turn reopens the turn');
});

// A message typed mid-run is part of the history; what the harness injects under
// a user record is not. The two are only told apart by isMeta.
const saidByYou = text => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
const injected  = text => ({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text }] } });

test('E49 what you typed shows up among the calls', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), saidByYou('stop and install'), toolUse('Read', 't2')]);
  const recent = s.get('x').recent.slice().reverse();   // oldest first
  assert.deepStrictEqual(recent.map(c => c.tool), ['Bash', 'You', 'Read']);
  assert.strictEqual(recent[1].say, 'stop and install');
});

// The closing message was held to the end of the log, so the reply you were
// answering landed below your new message, as though said in answer to it.
test('E49 the reply you answered sits above your message, not below it', t => {
  const s = session(t);
  s.agent('x', [toolUse('Bash', 't1'), stopped('end_turn'), saidByYou('lets write another blog'), toolUse('Read', 't2')]);
  const recent = s.get('x').recent.slice().reverse();   // oldest first
  assert.deepStrictEqual(recent.map(c => c.tool), ['Bash', 'Done', 'You', 'Read']);
  assert.strictEqual(recent[1].say, 'All done.');
});

test('E49 a reply answered before anything new has run is still shown once, above you', t => {
  const s = session(t);
  s.agent('x', [stopped('end_turn'), saidByYou('again')]);
  const recent = s.get('x').recent.slice().reverse();
  assert.deepStrictEqual(recent.map(c => c.tool), ['Done', 'You']);
});

test('E49 a message of yours is not mistaken for the agent narrating', t => {
  const s = session(t);
  s.agent('x', [saidByYou('do the thing'), toolUse('Bash', 't1')]);
  const recent = s.get('x').recent.slice().reverse();
  assert.deepStrictEqual(recent.map(c => c.tool), ['You', 'Bash']);
  assert.strictEqual(recent[1].say, 'next: t1', 'the call keeps the assistant text, not yours');
});

test('E49 what the harness injects under a user record is left out', t => {
  const s = session(t);
  s.agent('x', [
    toolUse('Bash', 't1'),
    injected('[Image: source: C:\\tmp\\shot.png]'),
    injected('Base directory for this skill: C:\\skills\\pre-pr'),
    saidByYou('carry on'),
  ]);
  const said = s.get('x').recent.filter(c => c.tool === 'You');
  assert.strictEqual(said.length, 1, 'only the one that was typed');
  assert.strictEqual(said[0].say, 'carry on');
});

test('E49 the newest thing you said survives a burst of calls', t => {
  const s = session(t);
  const calls = [];
  for (let i = 0; i < 12; i++) calls.push(toolUse('Bash', 'b' + i));
  s.agent('x', [saidByYou('first thing'), saidByYou('do it this way instead'), ...calls]);
  const recent = s.get('x').recent.slice().reverse();
  const said = recent.filter(c => c.tool === 'You');
  assert.strictEqual(said.length, 1, 'kept, though twelve calls came after it');
  assert.strictEqual(said[0].say, 'do it this way instead', 'the newest one, not the first');
  assert.strictEqual(recent[0].tool, 'You', 'in order: above the calls it set off');
});

test('E49 harness blocks and the interrupt line are not messages', t => {
  const s = session(t);
  s.agent('x', [
    toolUse('Bash', 't1'),
    saidByYou('<system-reminder>something injected</system-reminder>'),
    saidByYou('[Request interrupted by user for tool use]'),
    saidByYou('   '),
  ]);
  assert.deepStrictEqual(s.get('x').recent.filter(c => c.tool === 'You'), []);
});

test('E49 a session keeps your last message once it drops out of the tail', t => {
  const s = session(t);
  s.selfLog([saidByYou('do it this way instead'), toolUse('Bash', 'b0')]);
  const first = s.self().recent.filter(c => c.tool === 'You');
  assert.strictEqual(first.length, 1, 'seen while it is still in the tail');

  // The log moves on past the 256KB the scan reads, so the message is genuinely
  // no longer in the tail: without the carry-over there is nothing left to find.
  const bulk = [
    { type: 'assistant', filler: 'x'.repeat(300 * 1024), message: { content: [] } },
    toolUse('Bash', 'c0'),
  ];
  fs.appendFileSync(path.join(s.subs, '..', '..', s.sid + '.jsonl'),
    bulk.map(l => JSON.stringify(l)).join('\n') + '\n');

  const after = s.self().recent;
  const said = after.filter(c => c.tool === 'You');
  assert.strictEqual(said.length, 1, 'still there, remembered from the earlier read');
  assert.strictEqual(said[0].say, 'do it this way instead');
  assert.strictEqual(after[after.length - 1].tool, 'You', 'oldest, so last in a newest-first list');
});

test('E48 a session row is titled by the name the chat gave itself', t => {
  const s = session(t);
  s.selfLog([
    { type: 'user', message: { content: [{ type: 'text', text: 'open the thing' }] } },
    { type: 'ai-title', aiTitle: 'First guess' },
    { type: 'ai-title', aiTitle: 'Work status check' },
  ]);
  assert.strictEqual(s.self().description, 'Work status check', 'the last name wins');
});

test('E48 a session whose log never named itself falls back to its first message', t => {
  const s = session(t);
  s.selfLog([{ type: 'user', message: { content: [{ type: 'text', text: 'open the thing' }] } }]);
  assert.strictEqual(s.self().description, 'open the thing');
});

test('E48 an empty or malformed name is not used', t => {
  const s = session(t);
  s.selfLog([
    { type: 'user', message: { content: [{ type: 'text', text: 'open the thing' }] } },
    { type: 'ai-title', aiTitle: '   ' },
    { type: 'ai-title', aiTitle: 42 },
  ]);
  assert.strictEqual(s.self().description, 'open the thing');
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
