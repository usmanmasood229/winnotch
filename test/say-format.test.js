'use strict';
// The closing message a session leaves behind is markdown, and the panel turns it
// into nodes by hand -- it is never handed to the DOM as markup, so every shape
// it has to cope with is checked here rather than trusted.
//
// The renderer has no build step and no module boundary: it is one inline script
// in index.html. Rather than move the formatter out to be testable, the block is
// lifted from the page and run against the smallest DOM that satisfies it, so
// what is tested is the code that actually ships.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');
const page = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

const START = '  const MD_BULLET';
const END = '\n  // Oldest at the top';
const from = page.indexOf(START);
const to = page.indexOf(END, from);
assert.ok(from !== -1 && to > from, 'the formatter block moved; fix the markers above');
const source = page.slice(from, to);

// Enough of a document for the formatter: elements that hold children and report
// their text, and nothing else.
function makeDoc() {
  const node = tag => ({
    tag,
    className: '',
    children: [],
    set textContent(v) { this.children = v === '' ? [] : [{ tag: '#text', text: String(v) }]; },
    get textContent() {
      return this.children.map(c => (c.tag === '#text' ? c.text : c.textContent)).join('');
    },
    appendChild(c) { this.children.push(c); return c; },
    get childNodes() { return this.children; },
  });
  return {
    createElement: tag => node(tag),
    createTextNode: text => ({ tag: '#text', text, get textContent() { return this.text; } }),
  };
}

const { writeSay } = new Function('document', source + '\n  return { writeSay };')(makeDoc());

// What the formatter produced, as something an assertion can read:
// one entry per block, with its class and the tags it holds.
function render(md) {
  const host = makeDoc().createElement('div');
  writeSay(host, md);
  return host.children.map(b => ({
    cls: b.className,
    text: b.textContent,
    tags: b.children.map(c => c.tag),
  }));
}

test('a blank line starts a new paragraph, a wrapped line does not', () => {
  const out = render('First line\nsame paragraph.\n\nSecond paragraph.');
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-p']);
  assert.strictEqual(out[0].text, 'First line same paragraph.', 'joined with a space');
  assert.strictEqual(out[1].text, 'Second paragraph.');
});

test('bullets become their own blocks', () => {
  const out = render('Intro:\n\n- first thing\n- second thing\n\nAfter.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-li', 'say-li', 'say-p']);
  assert.strictEqual(out[1].text, 'first thing');
  assert.strictEqual(out[2].text, 'second thing');
});

test('a bullet ends the paragraph above it without a blank line', () => {
  const out = render('Intro:\n- first thing');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-li']);
});

test('numbered and dot bullets count too', () => {
  assert.deepStrictEqual(render('1. one\n2. two').map(b => b.cls), ['say-li', 'say-li']);
  assert.deepStrictEqual(render('• one').map(b => b.cls), ['say-li']);
  assert.deepStrictEqual(render('* one').map(b => b.cls), ['say-li']);
});

test('bold at the start of a line is not mistaken for a bullet', () => {
  const out = render('**Bold lead** and the rest.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p']);
  assert.deepStrictEqual(out[0].tags, ['strong', '#text']);
  assert.strictEqual(out[0].text, 'Bold lead and the rest.');
});

test('a heading is its own bold block', () => {
  const out = render('## What changed\n\nThe body.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-h', 'say-p']);
  assert.strictEqual(out[0].text, 'What changed');
});

test('a link is reduced to its label', () => {
  const out = render('See [index.html:458](src/index.html#L458) for it.');
  assert.strictEqual(out[0].text, 'See index.html:458 for it.');
});

test('a link whose url carries brackets still collapses', () => {
  const out = render('See [the row](src/a.js#L1(x)) now.');
  assert.strictEqual(out[0].text, 'See the row now.');
});

test('code spans survive, and are not formatted inside', () => {
  const out = render('Set `font-weight:**600**` on it.');
  assert.deepStrictEqual(out[0].tags, ['#text', 'code', '#text']);
  assert.strictEqual(out[0].text, 'Set font-weight:**600** on it.', 'no bold inside code');
});

test('a link inside a code span is left alone', () => {
  const out = render('Write `[a](b)` exactly.');
  assert.deepStrictEqual(out[0].tags, ['#text', 'code', '#text']);
  assert.strictEqual(out[0].text, 'Write [a](b) exactly.');
});

test('an unclosed backtick does not swallow the line', () => {
  const out = render('A stray ` and [a link](x) after it.');
  assert.strictEqual(out[0].text, 'A stray ` and a link after it.');
  assert.ok(!out[0].tags.includes('code'));
});

test('an unclosed bold marker is left as typed', () => {
  const out = render('A stray ** marker.');
  assert.strictEqual(out[0].text, 'A stray ** marker.');
  assert.ok(!out[0].tags.includes('strong'));
});

test('empty and whitespace messages produce nothing to draw', () => {
  assert.deepStrictEqual(render(''), []);
  assert.deepStrictEqual(render('\n\n   \n'), []);
});

test('carriage returns do not leak into the text', () => {
  const out = render('One line\r\n\r\nTwo.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-p']);
  assert.strictEqual(out[0].text, 'One line');
});

test('a long run of lines stays one paragraph per blank-line group', () => {
  const out = render(Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'));
  assert.strictEqual(out.length, 1);
});

test('the real shape of a closing message comes out as blocks, not a wall', () => {
  const out = render([
    'App is up with all three changes. **173 tests pass**, 0 skipped.',
    '',
    '**Icon was still in the corner** --- `#agent-mini-av` sits inside',
    '`#agent-mini`, which is pinned right. [index.html:458](src/index.html#L458)',
    'now gives that box `left:0`.',
    '',
    '- Three animations, on three properties.',
    '- Periods of 7.3s, 0.67s and 2.9s.',
  ].join('\n'));
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-p', 'say-li', 'say-li']);
  assert.ok(out[1].text.includes('index.html:458 now gives'), 'link collapsed and lines joined');
  assert.ok(!out[1].text.includes('](src/'), 'no raw link syntax left');
});
