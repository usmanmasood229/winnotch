'use strict';
// Which orb an agent wears: the kind of work while a tool is running, and the
// thinking orb between calls. Lifted from index.html the same way
// say-format.test.js lifts the formatter, so the shipped code is what runs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');
const page = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const from = page.indexOf('  const ORB_FOR_TOOL = {');
const fn = page.indexOf('function orbStateFor', from);
// The function's closing brace, at two-space indent; either line ending.
const close = /\r?\n  \}\r?\n/g;
close.lastIndex = fn;
const end = fn !== -1 && close.exec(page);
assert.ok(from !== -1 && end, 'the orb-state block moved; fix the markers above');
const to = end.index + end[0].length;
const { orbStateFor } = new Function(page.slice(from, to) + '\n  return { orbStateFor };')();

const agent = (...recent) => ({ recent });
const call = (tool, extra) => Object.assign({ id: 'toolu_' + tool, tool }, extra);

test('a running tool shows its kind of work', () => {
  assert.strictEqual(orbStateFor(agent(call('Grep'))), 'searching');
  assert.strictEqual(orbStateFor(agent(call('Edit'))), 'composing');
  assert.strictEqual(orbStateFor(agent(call('Write'))), 'composing');
  assert.strictEqual(orbStateFor(agent(call('Bash'))), 'working');
  assert.strictEqual(orbStateFor(agent(call('Read'))), 'listening');
  assert.strictEqual(orbStateFor(agent(call('Agent'))), 'connecting');
});

test('once the newest call has its result, the agent is thinking', () => {
  assert.strictEqual(orbStateFor(agent(call('Bash', { output: 'ok' }))), 'solving');
  // An empty result is still a result.
  assert.strictEqual(orbStateFor(agent(call('Edit', { output: '' }))), 'solving');
  assert.strictEqual(orbStateFor(agent(call('Bash', { output: 'boom', failed: true }))), 'solving');
});

test('only the newest call counts', () => {
  assert.strictEqual(orbStateFor(agent(call('Grep'), call('Edit', { output: '' }))), 'searching');
  assert.strictEqual(orbStateFor(agent(call('Grep', { output: 'x' }), call('Edit'))), 'solving');
});

test('nothing run yet, or a message from you, is thinking', () => {
  assert.strictEqual(orbStateFor(agent()), 'solving');
  assert.strictEqual(orbStateFor({}), 'solving');
  assert.strictEqual(orbStateFor(null), 'solving');
  assert.strictEqual(orbStateFor(agent({ id: null, tool: 'You', say: 'hi' })), 'solving');
  assert.strictEqual(orbStateFor(agent({ id: null, tool: 'Done', say: 'all set' })), 'solving');
});

test('never the ring or the morph, and every other shape is used', () => {
  const tools = ['Grep', 'Read', 'Edit', 'Bash', 'Agent', 'Skill', 'TodoWrite', 'ExitPlanMode',
                 'WebFetch', 'Write', 'mcp__x__y', 'SomethingNew'];
  const used = new Set(tools.map(t => orbStateFor(agent(call(t)))));
  used.add(orbStateFor(agent()));                          // thinking
  assert.ok(!used.has('breathing') && !used.has('shaping'), [...used].join(','));
  assert.deepStrictEqual([...used].sort(),
    ['composing', 'connecting', 'listening', 'searching', 'solving', 'weaving', 'working']);
});

test('tools it has no shape for still get one', () => {
  assert.strictEqual(orbStateFor(agent(call('mcp__slack__post'))), 'connecting');
  assert.strictEqual(orbStateFor(agent(call('SomethingNew'))), 'working');
});
