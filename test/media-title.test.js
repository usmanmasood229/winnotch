'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { simplify } = require('../src/media-title.js');

// Real titles seen while building this, with the artist the player reported.
const CASES = [
  ['Murtaza Qizilbash | Bhool | Official Audio', 'Murtaza Qizilbash', 'Bhool'],
  ['Abdul Hannan – Haaray | Prod by Rovalio',    'Abdul Hannan',      'Haaray'],
  ['Bulbulay Ep 155 – ARY Digital Drama',        'ARY Digital HD',    'Bulbulay Ep 155'],
  ['Summer Breeze',                              'Mase',              'Summer Breeze'],
  ['Typed a monster.',                           'madebymilo3d',      'Typed a monster.'],
];

for (const [title, artist, want] of CASES) {
  test(`"${title}" -> "${want}"`, () => {
    assert.strictEqual(simplify(title, artist), want);
  });
}

test('a bracket ends the title', () => {
  assert.strictEqual(simplify('Haaray (Official Video)', 'Abdul Hannan'), 'Haaray');
  assert.strictEqual(simplify('Bhool (Slowed + Reverb)', 'Murtaza'), 'Bhool');
  assert.strictEqual(simplify('Alright (feat. Nate)', 'Kendrick'), 'Alright');
  assert.strictEqual(simplify('Runaway [Official Audio]', 'Kanye'), 'Runaway');
  assert.strictEqual(simplify('Song {live}', 'X'), 'Song');
});

test('caps at four words when there is nothing to cut on', () => {
  assert.strictEqual(simplify('This Is A Very Long Song Title Indeed', 'X'), 'This Is A Very');
  assert.strictEqual(simplify('One Two Three Four', 'X'), 'One Two Three Four');
  assert.strictEqual(simplify('One Two Three', 'X'), 'One Two Three');
  // Also applies after a separator cut.
  assert.strictEqual(simplify('Artist | Seven Word Title That Keeps Going On', 'Artist'), 'Seven Word Title That');
});

test('leaves a plain title alone', () => {
  assert.strictEqual(simplify('Bhool', 'Murtaza Qizilbash'), 'Bhool');
  assert.strictEqual(simplify('Mr. Brightside', 'The Killers'), 'Mr. Brightside');
});

test('a hyphenated word is not a separator', () => {
  assert.strictEqual(simplify('Spider-Man Theme', 'Danny Elfman'), 'Spider-Man Theme');
});

test('never returns empty when there is something to show', () => {
  assert.strictEqual(simplify('Official Video | Official Audio', 'X'), 'Official Video');
  assert.strictEqual(simplify('Drake', 'Drake'), 'Drake');
});

test('bad input is handled', () => {
  for (const bad of [null, undefined, 42, {}, '']) assert.strictEqual(simplify(bad, 'X'), '');
  assert.strictEqual(simplify('Bhool', null), 'Bhool');
  assert.strictEqual(simplify('   ', 'X'), '');
});
