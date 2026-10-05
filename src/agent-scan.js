'use strict';
// Reads Claude Code's own on-disk records to find out what agents are running,
// across every project, and what each one is doing.
//
// This is the ONLY file that knows those paths and field names. They are an
// undocumented internal format and they do drift between versions (2.1.278 had
// no toolEndsTurn marker at all), so everything downstream consumes the snapshot
// this returns and never touches the files. When the format moves, it moves here.
//
// Layout it reads, all under ~/.claude:
//   sessions/<pid>.json                      one per live session, any project
//   projects/<slug>/<sessionId>/subagents/
//     agent-<id>.meta.json                   what the agent is and was asked
//     agent-<id>.jsonl                       appended as it works
//
// Nothing here calls a model or costs tokens; it is file reads only.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// A single appended record can be enormous — a 119KB one was measured — so the
// tail has to be big enough to hold the last one whole or the end marker is
// missed and a finished agent reads as running, then sticks on stalled forever.
const TAIL_BYTES = 256 * 1024;

// An agent goes quiet between steps: a 5s gap was measured mid-run, and a long
// model turn is longer still. Past this it is reported as stalled, never as done.
// Guessing "finished" wrong is worse than admitting the state is unknown.
const STALL_MS = 120000;

// ── small helpers ─────────────────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// A non-empty string, or null. These files are another program's internal format,
// so a field of the wrong type is treated as missing rather than passed along.
function strOrNull(v) {
  return typeof v === 'string' && v ? v : null;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Signal 0 tests for the process without touching it. EPERM means it exists
  // but belongs to someone else, which still counts as alive.
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Claude Code names a project directory after its cwd with every non-alphanumeric
// character replaced by a dash. Deriving it is cheap, so try that first and only
// fall back to looking through the directory when the guess misses.
function projectSlug(cwd) {
  return typeof cwd === 'string' && cwd ? cwd.replace(/[^a-zA-Z0-9]/g, '-') : null;
}

// sessionId -> its subagents folder. Without it a session whose cwd does not
// derive its slug listed the whole projects folder on every scan.
const dirCache = new Map();

// The session's own transcript, next to the folder holding its subagents. The
// main thread does work too — reads, edits, commands — and without this the
// panel only ever showed what the session delegated, never what it did itself.
function sessionLog(sessionId, cwd) {
  const guess = projectSlug(cwd);
  if (guess) {
    const p = path.join(PROJECTS_DIR, guess, sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  let slugs;
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(PROJECTS_DIR, slug, sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function subagentsDir(sessionId, cwd) {
  const cached = dirCache.get(sessionId);
  if (cached) {
    if (fs.existsSync(cached)) return cached;
    dirCache.delete(sessionId);
  }
  const guess = projectSlug(cwd);
  if (guess) {
    const p = path.join(PROJECTS_DIR, guess, sessionId, 'subagents');
    if (fs.existsSync(p)) { dirCache.set(sessionId, p); return p; }
  }
  let slugs;
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(PROJECTS_DIR, slug, sessionId, 'subagents');
    if (fs.existsSync(p)) { dirCache.set(sessionId, p); return p; }
  }
  return null;   // no agents have been spawned in this session yet
}

// A session's own log is appended every turn, but between two scans it is
// usually untouched; re-parsing its tail every few seconds was most of a scan.
const sessionProbeCache = new Map();   // file -> { mtime, size, probe }

// The last thing you said, kept per log across reads. One long turn buries it:
// the message that prompted this ended up 493KB back in a 29MB log, and the scan
// only reads the last 256KB, so the panel lost it even though nothing about it
// had changed. Reading further back every tick would mean parsing megabytes of
// JSON for one line, so it is caught on the way past instead -- sending something
// grows the log, which is exactly what makes the next scan re-read its tail, and
// the message is at the end of it. The cost is one short string per session.
//
// ponytail: a message sent before the app started is not in any tail it ever
// reads, so it is not shown. Read backwards in chunks if that turns out to matter.
const lastSaid = new Map();            // file -> the newest { tool: 'You' } entry

function sessionProbe(file) {
  let st;
  try { st = fs.statSync(file); } catch { return EMPTY_PROBE; }
  const c = sessionProbeCache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.probe;
  const probe = readLog(readTail(file, st.size));
  // recent is newest first, so the newest of yours is the first one found, and a
  // remembered one is older than everything in the tail: it belongs on the end.
  const said = probe.recent.find(r => r.tool === 'You');
  if (said) {
    if (lastSaid.size >= 64) lastSaid.clear();
    lastSaid.set(file, said);
  } else if (lastSaid.has(file)) {
    probe.recent = probe.recent.concat([lastSaid.get(file)]);
  }
  if (sessionProbeCache.size >= 64) sessionProbeCache.clear();
  sessionProbeCache.set(file, { mtime: st.mtimeMs, size: st.size, probe });
  return probe;
}

// The size comes from the caller's stat, which also keys the cache below. A
// caller without one gets a fresh stat: a missing size used to turn the start
// into NaN, which silently read nothing.
// The opening message of a log: the fallback for a session whose log carries no
// ai-title record. Everything else here reads the tail, but this needs the other
// end of the file.
// A session's log can open with a very large injected block before the first
// real message, so the head has to reach past it.
const HEAD_BYTES = 384 * 1024;
// The opening message never changes once written, and this read is the biggest
// one a scan makes, so a log's answer is kept once found.
// ponytail: cleared wholesale past 64 logs; prune by live session if that churns.
const promptCache = new Map();
function readPrompt(file) {
  const known = promptCache.get(file);
  if (known) return known;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }   // may start mid-record
      if (rec.type !== 'user') continue;
      const c = rec.message && rec.message.content;
      const body = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
          : '';
      // Skip the harness's own injected blocks; they are not what was asked.
      const t = String(body).trim();
      if (t && !t.startsWith('<')) {
        if (promptCache.size >= 64) promptCache.clear();
        promptCache.set(file, t);
        return t;
      }
    }
  } catch {}
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  return '';
}

function readTail(file, size) {
  let fd;
  try {
    if (!Number.isFinite(size)) size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

// ── reading one agent ─────────────────────────────────────────────────────────

// Whether the agent has finished is decided by one walk over the tail in order,
// so whatever happened last wins: an agent resumed after it ended reads as
// running again. The end-of-turn marker sits on a record of its own; a tail that
// cut that record in half still finds it by a substring search.
//
// The same pass collects the agent's recent tool calls, which is the only real
// account of what it has been doing: a name alone says "Bash", the description
// says which Bash.
const RECENT_MAX = 7;
// A closing message is read in full, so this has to hold a real one -- at 2000 a
// long one stopped mid-word ("• Sen") and looked like the agent had simply
// stopped there. Only running and stalled agents carry their calls at all, and
// only the last few, so the worst case is a handful of these per snapshot, not
// one per call ever made. The running narration above it is still clamped to
// three lines by CSS, so the length only costs anything on the final one.
// ponytail: a flat cap on every entry. If the snapshots get heavy, cap the
// narration tightly and keep the long budget for the last entry alone.
const SAY_MAX = 12000;

// Tools carry their own best label in different fields.
function callLabel(name, input) {
  if (!input || typeof input !== 'object') return '';
  const base = p => {
    // Windows paths and posix ones both turn up here.
    const t = String(p), i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
    return i < 0 ? t : t.slice(i + 1);
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell': return input.description || String(input.command || '').slice(0, 60);
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
    case 'Edit': return input.file_path ? base(input.file_path) : '';
    case 'Grep':
    case 'Glob': return input.pattern || '';
    case 'Agent':
    case 'Task': return input.description || '';
    case 'Skill': return input.skill || '';
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    default: return input.description || input.file_path && base(input.file_path) || '';
  }
}

// The lines an edit swapped out and the ones it put in, so the panel can show
// the actual code the way the reference does. Capped: a panel shows a handful of
// lines and can scroll a few more, but holding a whole file in every snapshot
// helps nobody.
const DIFF_LINES = 18;
function callDiff(name, input) {
  if (!input || typeof input !== 'object') return null;
  const cut = t => String(t == null ? '' : t).split('\n').slice(0, DIFF_LINES);
  if (name === 'Edit') {
    return { removed: cut(input.old_string), added: cut(input.new_string) };
  }
  if (name === 'Write') return { removed: [], added: cut(input.content) };
  if (name === 'MultiEdit' && Array.isArray(input.edits) && input.edits.length) {
    const e = input.edits[input.edits.length - 1];
    return { removed: cut(e.old_string), added: cut(e.new_string) };
  }
  return null;
}

function callDelta(name, input) {
  if (!input || typeof input !== 'object') return null;
  const lines = t => (t == null || t === '') ? 0 : String(t).split('\n').length;
  if (name === 'Write') return { added: lines(input.content), removed: 0 };
  if (name === 'Edit') {
    return { added: lines(input.new_string), removed: lines(input.old_string) };
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits) && input.edits.length) {
    // The last edit only, to agree with the lines callDiff shows. Totalling every
    // edit here put counts beside a diff that did not account for them.
    const e = input.edits[input.edits.length - 1];
    return { added: lines(e.new_string), removed: lines(e.old_string) };
  }
  return null;
}

// What the call was actually told to do, in full, for when a row is opened.
const DETAIL_MAX = 1200;
function callDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  const t = v => String(v == null ? '' : v).slice(0, DETAIL_MAX);
  switch (name) {
    case 'Bash':
    case 'PowerShell': return t(input.command);
    case 'Grep':
    case 'Glob':       return t(input.pattern) + (input.path ? '  in ' + t(input.path) : '');
    case 'Read':
    case 'Write':
    case 'Edit':       return t(input.file_path);
    case 'WebFetch':   return t(input.url);
    case 'WebSearch':  return t(input.query);
    default:           return '';
  }
}

// A turn the model ended itself. Older Claude Code (2.1.285 and before, measured)
// writes no toolEndsTurn marker at all: its last record is an assistant turn
// with stop_reason end_turn, and an API failure ends on an isApiErrorMessage
// record with no tool call (measured across 374 logs on one machine).
const TERMINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal']);

// Pressing Esc leaves only this line behind, as a plain user message: no
// toolEndsTurn marker, and meta.stoppedByUser stays unset (measured on two
// agents interrupted mid-tool). A user record otherwise means the turn carried
// on, so without this an interrupted agent reads as running, turns stalled two
// minutes later, and then sits in the panel for the rest of the session.
// Both wordings seen: "[Request interrupted by user]" and "...by user for tool use]".
const INTERRUPT = '[Request interrupted by user';

function isInterrupt(content) {
  return Array.isArray(content) && content.some(c =>
    c && c.type === 'text' && typeof c.text === 'string' && c.text.startsWith(INTERRUPT));
}

function readLog(tail) {
  const lines = tail.split('\n').filter(Boolean);

  let ended = false;
  let title = null;
  const recent = [];
  const byId = new Map();   // tool_use id -> its call, for the results that follow
  let say = '';
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // A tail can start mid-record, so fall back to looking for the marker text.
      // Only the cut first line lands here, and every later line overrides it.
      if (line.indexOf('"toolEndsTurn":true') !== -1) ended = true;
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    // Claude Code names the chat itself and rewrites the name as the chat moves
    // on, appending a fresh record each time, so the last one in the tail is the
    // current name. It carries no message, so it falls out of everything below.
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) {
      title = rec.aiTitle.trim();
      continue;
    }
    const content = rec.message && rec.message.content;
    // Whether the turn had already ended before this record: then a pending
    // `say` is that turn's closing message, not narration for a call to come.
    const wasEnded = ended;

    // The marker is checked first because it sits on a user record, which
    // otherwise means the turn carried on.
    if (rec.toolEndsTurn === true) ended = true;
    else if (rec.type === 'assistant' && Array.isArray(content)) {
      if (content.some(c => c && c.type === 'tool_use')) ended = false;
      else if (rec.isApiErrorMessage === true || TERMINAL_STOPS.has(rec.message.stop_reason)) ended = true;
      // Anything else is a streamed partial block (stop_reason null): no change.
    } else if (rec.type === 'user') ended = isInterrupt(content);

    if (!Array.isArray(content)) continue;
    for (const c of content) {
      // What the agent said just before reaching for a tool. This is the running
      // commentary that makes a list of tool names actually readable, so it is
      // carried on the call it introduces.
      // Only what the assistant said. Without this the user's own messages were
      // picked up as narration, so a pasted prompt became the "closing message".
      if (rec.type === 'assistant'
          && c && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        say = c.text.trim().slice(0, SAY_MAX);
        continue;
      }
      // What you typed, in among the calls, so the history reads as the exchange
      // it was rather than only one side of it. The guard above deliberately keeps
      // user records out of the agent's narration, so they arrive here as an entry
      // of their own instead of being dropped. isMeta is what the harness puts on
      // everything it injects under a user record -- skill bodies, image notes,
      // reminders -- which was 59 of 154 user records in one session log; without
      // it the panel fills with those instead of with anything you said.
      if (rec.type === 'user' && rec.isMeta !== true
          && c && c.type === 'text' && typeof c.text === 'string') {
        const said = c.text.trim();
        // A leading '<' is one of the harness's own blocks, and the interrupt line
        // is the trace of pressing Esc, not something that was typed.
        if (said && said[0] !== '<' && !said.startsWith(INTERRUPT)) {
          // The reply you are answering goes in before what you said. Held to the
          // end of the log, it landed below your new message, so the panel read
          // as though the agent had said it in answer to you.
          if (wasEnded && say) {
            recent.push({ id: null, tool: 'Done', say, label: '', detail: '', delta: null, diff: null });
            say = '';
          }
          recent.push({ id: null, tool: 'You', say: said.slice(0, SAY_MAX),
                        label: '', detail: '', delta: null, diff: null });
        }
        continue;
      }
      if (c && c.type === 'tool_use' && c.name) {
        const call = {
          id: c.id || null,
          tool: c.name,
          say,
          label: callLabel(c.name, c.input),
          detail: callDetail(c.name, c.input),
          delta: callDelta(c.name, c.input),
          diff: callDiff(c.name, c.input),
        };
        recent.push(call);
        if (call.id && !byId.has(call.id)) byId.set(call.id, call);
        say = '';          // it belongs to this call, not the next one
        continue;
      }
      // Results arrive in later records, keyed by the call they answer. Attach
      // them so a row can be opened to see what actually came back.
      if (c && c.type === 'tool_result' && c.tool_use_id) {
        const call = byId.get(c.tool_use_id);
        if (!call) continue;
        const body = Array.isArray(c.content)
          ? c.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
          : (typeof c.content === 'string' ? c.content : '');
        call.output = String(body).slice(0, DETAIL_MAX);
        call.failed = c.is_error === true;
      }
    }
  }

  // A closing message has no tool call after it to ride on, so the loop above
  // drops it — and that is the one thing worth reading once something finishes.
  // Carry it as a final entry of its own. Once, after every record is read: this
  // lived inside the content loop for a while, where a still-set `say` pushed a
  // fresh copy on every block that came past, so the message showed up twice.
  if (say) recent.push({ id: null, tool: 'Done', say, label: '', detail: '', delta: null, diff: null });

  // The panel has room for a handful, and those are the newest ones -- except
  // that a busy turn makes seven tool calls in well under a minute, so what you
  // said would scroll out of sight almost as soon as you said it. The newest one
  // is carried through the trim, in its own place in the order, which is above
  // the calls it set off.
  const shown = recent.slice(-RECENT_MAX);
  if (!shown.some(c => c.tool === 'You')) {
    for (let i = recent.length - shown.length - 1; i >= 0; i--) {
      if (recent[i].tool === 'You') { shown.unshift(recent[i]); break; }
    }
  }

  return {
    finished: ended,
    title,
    recent: shown.reverse(),            // newest first, the way the panel reads it
    activity: recent.length ? recent[recent.length - 1].tool : null,
  };
}

const EMPTY_PROBE = { finished: false, title: null, activity: null, recent: [] };

// metaPath -> { metaMtime, logMtime, logSize, meta, probe }. An agent whose two
// files have not moved since the last scan is not read again; a finished agent
// sits on disk unchanged for the rest of its session. Timings are never cached.
const agentCache = new Map();

// The fields used from a meta file, or null when it is not one we understand.
function agentMeta(meta) {
  // No agentType means the format moved under us. Skip it rather than render
  // something wrong.
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.agentType !== 'string' || !meta.agentType) return null;
  // A description is only usually there. An agent a slash command starts has a
  // type and nothing else -- measured on a running /code-review, whose meta was
  // {agentType, spawnDepth, requestShape, requestNonInteractive}. Requiring one
  // meant that agent never appeared at all, which is worse than naming it from
  // its opening line; the caller does that.
  return {
    type: meta.agentType,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    parentId: strOrNull(meta.parentAgentId),
    depth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : 1,
    shape: strOrNull(meta.requestShape),
    model: strOrNull(meta.model),
    stoppedByUser: meta.stoppedByUser,
  };
}

function readAgent(dir, id, now, seen) {
  const metaPath = path.join(dir, 'agent-' + id + '.meta.json');
  const jsonl = path.join(dir, 'agent-' + id + '.jsonl');
  let metaSt, logSt = null;
  try { metaSt = fs.statSync(metaPath); } catch { return null; }
  try { logSt = fs.statSync(jsonl); } catch {}
  seen.add(metaPath);
  const logMtime = logSt ? logSt.mtimeMs : null, logSize = logSt ? logSt.size : null;

  let c = agentCache.get(metaPath);
  if (!c || c.metaMtime !== metaSt.mtimeMs || c.logMtime !== logMtime || c.logSize !== logSize) {
    const meta = agentMeta(readJSON(metaPath));
    const probe = meta && logSt ? readLog(readTail(jsonl, logSt.size)) : EMPTY_PROBE;
    c = { metaMtime: metaSt.mtimeMs, logMtime, logSize, meta, probe };
    agentCache.set(metaPath, c);
  }
  const { meta, probe } = c;
  if (!meta) return null;

  const startedAt = metaSt.mtimeMs, lastAt = logSt ? logSt.mtimeMs : now;

  // Order matters: the definitive markers win over the timing heuristics.
  let state;
  if (meta.stoppedByUser)           state = 'stopped';
  else if (probe.finished)          state = 'done';
  else if (now - lastAt > STALL_MS) state = 'stalled';
  else                              state = 'running';

  return {
    id,
    type: meta.type,
    // Named by whoever started it when they said; otherwise by the line it was
    // started with, which is what the agent was actually asked to do, and only
    // then by its type, which says almost nothing ("general-purpose").
    description: meta.description
      || (readPrompt(jsonl) || '').trim().split('\n')[0].slice(0, 80)
      || meta.type,
    parentId: meta.parentId,
    depth: meta.depth,
    shape: meta.shape,
    model: meta.model,
    state,
    activity: probe.activity,
    // The panel only ever shows live agents. Finished ones were 95% of a 272 KB
    // snapshot pushed to the renderer for nothing.
    recent: state === 'running' || state === 'stalled' ? probe.recent : [],
    elapsedMs: Math.max(0, lastAt - startedAt),
    idleMs: Math.max(0, now - lastAt),
  };
}

// ── reading one session ───────────────────────────────────────────────────────

function readSession(file, now, seen) {
  const s = readJSON(file);
  if (!s || typeof s.sessionId !== 'string' || !s.sessionId) return null;
  seen.sessions.add(s.sessionId);

  const cwd = strOrNull(s.cwd);
  const alive = isAlive(s.pid);
  const dir = subagentsDir(s.sessionId, cwd);

  let agents = [];
  if (dir) {
    let ids;
    try {
      ids = fs.readdirSync(dir)
        .filter(f => f.endsWith('.meta.json'))
        .map(f => f.slice('agent-'.length, -('.meta.json'.length)));
    } catch { ids = []; }
    agents = ids.map(id => readAgent(dir, id, now, seen.agents)).filter(Boolean);
  }

  // The session itself, as the first row. It is not a subagent, so it carries no
  // meta file — its state comes from the session record and its own log.
  const selfLog = sessionLog(s.sessionId, s.cwd);
  if (selfLog) {
    let lastAt = now;
    try { lastAt = fs.statSync(selfLog).mtimeMs; } catch {}
    const probe = sessionProbe(selfLog);
    agents.unshift({
      id: 'self:' + s.sessionId,
      type: 'session',
      // The chat's own name first: it is what the editor tab says, so it is what
      // you are already tracking the chat by. Not every log carries one (one in
      // five measured here did not), hence the opening message behind it.
      description: (probe.title || readPrompt(selfLog) || '').trim().split('\n')[0].slice(0, 80)
                   || s.name || 'This session',
      sessionName: s.name,
      parentId: null,
      depth: 0,
      shape: null,
      model: null,
      // Busy means the session is mid-turn; anything else is waiting on you.
      state: s.status === 'busy' && now - lastAt <= STALL_MS ? 'running' : 'done',
      isSession: true,
      prompt: '',
      activity: probe.activity,
      recent: probe.recent || [],
      elapsedMs: 0,
      idleMs: Math.max(0, now - lastAt),
    });
  }

  // Shallowest first, so an orchestrator sorts above the children it spawned.
  agents.sort((a, b) => a.depth - b.depth || a.description.localeCompare(b.description));

  return {
    sessionId: s.sessionId,
    name: strOrNull(s.name) || s.sessionId.slice(0, 8),
    cwd,
    project: cwd ? path.basename(cwd) : null,
    status: strOrNull(s.status),
    version: strOrNull(s.version),
    pid: s.pid,
    alive,
    agents,
  };
}

// ── the snapshot ──────────────────────────────────────────────────────────────

// Every live Claude Code session on this machine and the agents under each.
// Cheap enough to call on every change event: a few stats plus a 64KB tail per
// agent, and nothing at all when no session is running.
function scan() {
  const now = Date.now();

  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')); }
  catch { files = []; }   // no sessions dir yet: nothing is running

  const seen = { sessions: new Set(), agents: new Set() };
  const sessions = files
    .map(f => readSession(path.join(SESSIONS_DIR, f), now, seen))
    .filter(Boolean)
    .filter(s => s.alive)   // a dead pid means a session file was left behind
    .sort((a, b) => (a.project || '').localeCompare(b.project || ''));

  // Forget whatever has gone from disk, so the caches only ever hold what is there.
  for (const k of agentCache.keys()) if (!seen.agents.has(k)) agentCache.delete(k);
  for (const k of dirCache.keys()) if (!seen.sessions.has(k)) dirCache.delete(k);

  const all = sessions.reduce((acc, s) => acc.concat(s.agents), []);

  return {
    at: now,
    sessions,
    totals: {
      sessions: sessions.length,
      busy:     sessions.filter(s => s.status === 'busy').length,
      agents:   all.length,
      running:  all.filter(a => a.state === 'running').length,
      stalled:  all.filter(a => a.state === 'stalled').length,
      done:     all.filter(a => a.state === 'done').length,
    },
  };
}

// ── watching ──────────────────────────────────────────────────────────────────

// Mirrors BUSY_MS in index.html: past this a running agent reads as thinking.
const BUSY_MS = 3000;

// Calls back with a fresh snapshot whenever something actually changes.
//
// Two watchers, because the churn is lopsided: session files change rarely, while
// every project's main log is appended constantly. The recursive watch therefore
// ignores everything outside a subagents folder, or it would re-scan on every
// line any session writes. A slow poll runs on top, but only while an agent is
// running, so elapsed time and the stall cutoff stay current without file events.
// Returns a stop function.
function watch(onChange, intervalMs) {
  const period = intervalMs || 3000;
  let timer = null, debounce = null, last = null;

  const emit = () => {
    let snap;
    try { snap = scan(); } catch { return; }
    // Only wake the UI when something it can see has moved: everything the panel
    // draws, with idle time cut down to the one threshold it uses, so a quiet
    // tick does not push.
    const sig = JSON.stringify(snap.sessions, (k, v) =>
      k === 'idleMs' ? v < BUSY_MS : k === 'elapsedMs' ? undefined : v);
    if (sig !== last) {
      // Remembered only once delivered, so a snapshot whose delivery threw is
      // offered again on the next tick.
      try { onChange(snap); last = sig; } catch {}
    }

    const busy = snap.totals.running > 0;
    if (busy && !timer) timer = setInterval(emit, period);
    else if (!busy && timer) { clearInterval(timer); timer = null; }
  };

  const bump = () => { clearTimeout(debounce); debounce = setTimeout(emit, 250); };

  // dir -> its watcher. Keyed so a retry never stacks a second watcher on a
  // folder that is already watched.
  const armed = new Map();
  let retry = null;
  const arm = (dir, recursive, keep) => {
    if (armed.has(dir)) return;
    try {
      const w = fs.watch(dir, { recursive }, (_ev, f) => {
        if (!keep || (f && keep(f))) bump();
      });
      // The folder was deleted under it: drop the watcher and wait for it to
      // come back, rather than throw out of the event loop.
      w.on('error', () => { try { w.close(); } catch {} armed.delete(dir); ensureRetry(); });
      armed.set(dir, w);
    } catch {}   // directory not there yet
  };

  // On a machine where Claude Code has never run these do not exist yet. Arming
  // fails silently, and with nothing running there is no poll either, so the
  // panel would stay dead for the life of the app. Retry until they appear.
  function armAll() {
    arm(SESSIONS_DIR, false, null);
    arm(PROJECTS_DIR, true, f => f.indexOf('subagents') !== -1);
    return armed.size === 2;
  }
  function ensureRetry() {
    if (retry) return;
    retry = setInterval(() => {
      if (armAll()) { clearInterval(retry); retry = null; }
      emit();
    }, 5000);
  }
  if (!armAll()) ensureRetry();
  emit();

  return () => {
    for (const w of armed.values()) { try { w.close(); } catch {} }
    armed.clear();
    clearTimeout(debounce);
    clearInterval(timer);
    clearInterval(retry);
  };
}

module.exports = { scan, watch, CLAUDE_DIR, SESSIONS_DIR, PROJECTS_DIR, STALL_MS, BUSY_MS };

// Run it directly to see the real thing:  node src/agent-scan.js
if (require.main === module) {
  const snap = scan();
  const t = snap.totals;
  console.log(t.sessions + ' session(s), ' + t.agents + ' agent(s) — '
    + t.running + ' running, ' + t.stalled + ' stalled, ' + t.done + ' done\n');
  for (const s of snap.sessions) {
    console.log('  ' + s.name + '  [' + s.project + ']  status=' + s.status + '  v' + s.version);
    if (!s.agents.length) console.log('      (no agents)');
    for (const a of s.agents) {
      const pad = '    '.repeat(a.depth);
      const act = a.activity ? '  doing:' + a.activity : '';
      console.log('    ' + pad + a.state.toUpperCase().padEnd(8) + ' ' + a.type
        + '  "' + a.description + '"  ' + (a.elapsedMs / 1000).toFixed(1) + 's' + act);
    }
  }
}
