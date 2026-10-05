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
    // Enough of a DOMTokenList for the formatter: it only ever adds.
    classList: {
      add(...names) {
        const have = new Set(String(this.owner.className).split(' ').filter(Boolean));
        for (const n of names) have.add(n);
        this.owner.className = [...have].join(' ');
      },
    },
    set textContent(v) { this.children = v === '' ? [] : [{ tag: '#text', text: String(v) }]; },
    get textContent() {
      return this.children.map(c => (c.tag === '#text' ? c.text : c.textContent)).join('');
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      return c;
    },
    get childNodes() { return this.children; },
  });
  return {
    createElement: tag => { const n = node(tag); n.classList.owner = n; return n; },
    createTextNode: text => ({ tag: '#text', text, get textContent() { return this.text; } }),
  };
}

const { writeSay } = new Function('document', source + '\n  return { writeSay };')(makeDoc());

// What the formatter produced, as something an assertion can read:
// one entry per block, with its class and the tags it holds.
function render(md) {
  const host = makeDoc().createElement('div');
  writeSay(host, md);
  // A bare text node means the formatter fell back to printing the raw message,
  // which is a result worth reading in a failure rather than a crash in here.
  return host.children.map(b => ({
    cls: b.tag === '#text' ? '(raw text)' : String(b.className).split(' ')[0],
    cls2: b.tag === '#text' ? '' : String(b.className),
    text: b.textContent,
    tags: b.tag === '#text' ? ['#text'] : b.children.map(c => c.tag),
    // A table reads as the grid it is, not as one joined string.
    rows: b.tag !== '#text' && String(b.className).startsWith('say-table')
      ? b.children.map(tr => tr.children.map(td => td.textContent))
      : null,
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

test('a fenced block keeps its lines and loses its fences', () => {
  const out = render('Run this:\n\n```\nnpm run build\nnpm test\n```\n\nThen look.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-pre', 'say-p']);
  assert.strictEqual(out[1].text, 'npm run build\nnpm test', 'line breaks kept, no backticks');
  assert.strictEqual(out[2].text, 'Then look.');
});

test('a language after the opening fence is not shown', () => {
  const out = render('```js\nconst a = 1;\n```');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre']);
  assert.strictEqual(out[0].text, 'const a = 1;');
});

test('nothing inside a fence is treated as markdown', () => {
  const out = render('```\n- not a bullet\n**not bold** and `not code`\n\n## not a heading\n```');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre']);
  assert.strictEqual(
    out[0].text,
    '- not a bullet\n**not bold** and `not code`\n\n## not a heading',
    'blank lines and markers survive exactly as typed',
  );
  assert.deepStrictEqual(out[0].tags.filter(t => t !== '#text'), [], 'text only, no elements');
});

test('a path with markdown characters in it survives a fence intact', () => {
  const p = 'C:\\Users\\x\\src\\**\\*.js  # and a_b_c -- not a bullet';
  const out = render('```\n' + p + '\n```');
  assert.strictEqual(out[0].text, p);
  assert.deepStrictEqual(out[0].tags.filter(t => t !== '#text'), [], 'no markup made of it');
});

test('a paragraph after a fence does not jump above it', () => {
  // No blank line anywhere: the fence itself has to end the paragraph before it
  // and start a fresh one after, or the trailing sentence joins the opening one.
  const out = render('Run:\n```\nx\n```\nThen look.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-pre', 'say-p']);
  assert.strictEqual(out[0].text, 'Run:');
  assert.strictEqual(out[2].text, 'Then look.');
});

test('a fence indented under a bullet is still a fence', () => {
  const out = render('- step one\n  ```\n  npm test\n  ```\n- step two');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-li', 'say-pre', 'say-li']);
  assert.strictEqual(out[1].text, '  npm test', 'the indent is content, kept as typed');
  assert.strictEqual(out[2].text, 'step two');
});

test('a blank line at the start or end of a fence is kept', () => {
  assert.strictEqual(render('```\n\nx\n```')[0].text, '\nx');
  assert.strictEqual(render('```\nx\n\n```')[0].text, 'x\n');
});

// The fence rule has to tell an opening line from a one-line code span, or a
// message that mentions a command inline loses it and everything after it.
test('a one-line triple-backtick span is code, not the start of a block', () => {
  const out = render('```npm run build``` builds it.\n\n- and this is still a bullet');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-li']);
  assert.strictEqual(out[0].text, 'npm run build builds it.');
  assert.ok(out[0].tags.includes('code'), 'rendered as inline code');
  assert.strictEqual(out[1].text, 'and this is still a bullet');
});

test('text after a closing fence is kept, not dropped', () => {
  const out = render('```\nnpm test\n``` then check the output');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre']);
  assert.strictEqual(out[0].text, 'npm test\n``` then check the output',
    'not a bare fence, so it stays inside the block');
});

test('a longer fence can quote a shorter one', () => {
  const out = render('````md\n```js\nx = 1\n```\n````');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre']);
  assert.strictEqual(out[0].text, '```js\nx = 1\n```');
});

test('a shorter fence does not close a longer block', () => {
  const out = render('````\n```\n````');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, '```');
});

test('an opening fence left dangling by truncation draws nothing', () => {
  assert.deepStrictEqual(render('```js'), [], 'no empty grey box');
  const out = render('Cut here.\n\n```');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p'], 'the text before it survives');
});

test('an unclosed fence still renders as a block', () => {
  const out = render('Here:\n\n```\nnpm run build');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-pre']);
  assert.strictEqual(out[1].text, 'npm run build');
});

test('an empty fence draws an empty block, not a stray paragraph', () => {
  const out = render('```\n```');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre']);
  assert.strictEqual(out[0].text, '');
});

test('two fenced blocks in one message stay separate', () => {
  const out = render('```\none\n```\n\n```\ntwo\n```');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre', 'say-pre']);
  assert.strictEqual(out[0].text, 'one');
  assert.strictEqual(out[1].text, 'two');
});

test('inline code still works after a fence closes', () => {
  const out = render('```\nx\n```\n\nSet `font-weight` after.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-pre', 'say-p']);
  assert.ok(out[1].tags.includes('code'));
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

// The stub cannot see CSS, so the one property the whole feature rests on is
// checked against the stylesheet instead: without pre-wrap a fenced block renders
// as one run-on line in Chromium and every test above still passes.
// A table used to come through as one run of pipes across the column, which was
// the worst thing a message could contain.
test('a table becomes rows and cells, not a run of pipes', () => {
  const out = render([
    'Measured:',
    '',
    '| | GPU CPU | Total RAM |',
    '|---|---|---|',
    '| Before | 35.8% | 679 MB |',
    '| After | 19% | 464 MB |',
    '',
    'Done.',
  ].join('\n'));
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p', 'say-table', 'say-p']);
  const rows = out[1].rows;
  assert.strictEqual(rows.length, 3, 'the |---| rule is not a row');
  assert.deepStrictEqual(rows[0], ['', 'GPU CPU', 'Total RAM']);
  assert.deepStrictEqual(rows[1], ['Before', '35.8%', '679 MB']);
  assert.deepStrictEqual(rows[2], ['After', '19%', '464 MB']);
  assert.ok(out[1].cls2.includes('headed'), 'the rule marks the row above as a header');
});

test('a table with no header rule still renders its rows', () => {
  const out = render('| a | b |\n| c | d |');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-table']);
  assert.deepStrictEqual(out[0].rows, [['a', 'b'], ['c', 'd']]);
  assert.ok(!out[0].cls2.includes('headed'));
});

test('cells are formatted, and a pipe inside a fence is not a table', () => {
  const out = render('| `code` | **bold** |');
  assert.deepStrictEqual(out[0].rows, [['code', 'bold']]);
  const fenced = render('```\n| not | a table |\n```');
  assert.deepStrictEqual(fenced.map(b => b.cls), ['say-pre']);
  assert.strictEqual(fenced[0].text, '| not | a table |');
});

test('two tables separated by text do not merge', () => {
  const out = render('| a |\n\nbetween\n\n| b |');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-table', 'say-p', 'say-table']);
  assert.deepStrictEqual(out[0].rows, [['a']]);
  assert.deepStrictEqual(out[2].rows, [['b']]);
});

test('a line with pipes that is not a row is left as prose', () => {
  const out = render('Run a | b to pipe it.');
  assert.deepStrictEqual(out.map(b => b.cls), ['say-p']);
  assert.strictEqual(out[0].text, 'Run a | b to pipe it.');
});

test('the fenced block keeps its line breaks in CSS too', () => {
  const rule = /\.say-pre\s*\{[^}]*\}/.exec(page);
  assert.ok(rule, 'no .say-pre rule in the stylesheet');
  assert.match(rule[0], /white-space\s*:\s*pre-wrap/, 'line breaks would collapse without this');
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
