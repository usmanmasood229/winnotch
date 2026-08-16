'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { create } = require('../src/lid-motion.js');

const FRAME = 1000 / 60;
const DEG = Math.PI / 180;

// Drives the model like the renderer: a frame every ~16ms, sensor samples at
// `sensorHz` from angleAt(ms), whole degrees like the real sensor. Returns tilt
// per frame.
function run(m, ms, angleAt, sensorHz = 30) {
  const out = [];
  const every = 1000 / sensorHz;
  let nextSample = 0;
  for (let t = 0; t < ms; t += FRAME) {
    if (t >= nextSample) { m.sample(Math.round(angleAt(t))); nextSample += every; }
    m.step(FRAME);
    out.push(m.tilt());
  }
  return out;
}

// Lid parked at 80, but the sensor keeps reporting 78-82 at 10Hz.
const RATTLE = [0, 2, -1, 1, -2, 0, 2, -2, 1, -1];
const parkedWithRattle = t => 80 + RATTLE[Math.floor(t / 100) % RATTLE.length];

function closeTo80(m) {
  m.reset(120, 120);
  return run(m, 300, t => 120 - Math.min(t / 300, 1) * 40, 10);
}

test('lid at rest never tilts and goes idle', () => {
  const m = create();
  m.reset(110, 110);
  const s = run(m, 1000, () => 110);
  assert.ok(s.every(v => v === 0));
  assert.ok(m.idle());
});

test('sensor rattle at rest never tilts', () => {
  const m = create();
  m.reset(80, 80);
  const s = run(m, 3000, parkedWithRattle, 10);
  assert.strictEqual(Math.max(...s.map(Math.abs)), 0);
  assert.ok(m.idle());
});

test('non-finite samples and bad frame times are ignored', () => {
  const m = create();
  m.reset(110, 110);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null]) m.sample(bad);
  run(m, 500, () => 110);
  m.step(0); m.step(-5); m.step(NaN);
  assert.strictEqual(m.tilt(), 0);
});

test('closing tilts forward, opening tilts back', () => {
  const close = create(); close.reset(110, 110);
  run(close, 400, t => 110 - Math.min(t / 300, 1) * 30);
  assert.ok(close.tilt() > 20 * DEG, `close tilt ${close.tilt() / DEG}°`);

  const open = create(); open.reset(100, 100);
  run(open, 400, t => 100 + Math.min(t / 300, 1) * 30);
  assert.ok(open.tilt() < -20 * DEG, `open tilt ${open.tilt() / DEG}°`);
});

test('a fast close is followed closely', () => {
  const m = create();
  m.reset(110, 110);
  const s = run(m, 300, t => 110 - Math.min(t / 300, 1) * 30, 30);
  assert.ok(s[s.length - 1] > 16 * DEG, `lagging: ${s[s.length - 1] / DEG}° of 30°`);
});

test('speed changes gradually even when samples arrive in big steps', () => {
  const m = create();
  m.reset(120, 120);
  // 60 degrees in 400ms, reported only 10 times a second: 6° jumps per sample.
  const s = run(m, 700, t => 120 - Math.min(t / 400, 1) * 60, 10);
  for (let i = 2; i < s.length; i++) {
    const speedChange = Math.abs(s[i] - 2 * s[i - 1] + s[i - 2]);
    assert.ok(speedChange < 1.5 * DEG, `lurched ${speedChange / DEG}°/frame² at frame ${i}`);
  }
  for (let i = 1; i < Math.floor(400 / FRAME); i++) assert.ok(s[i] >= s[i - 1] - 1e-9, `reversed at frame ${i}`);
});

test('tilt never overshoots the actual travel', () => {
  const m = create();
  m.reset(120, 120);
  const s = run(m, 1500, t => (t < 50 ? 120 : 40));
  assert.ok(Math.max(...s) <= 80 * DEG + 1e-9, `overshot to ${Math.max(...s) / DEG}°`);
  assert.ok(s.every(Number.isFinite));
});

test('sensor rattle after the lid stops never makes the blur stutter', () => {
  const m = create();
  closeTo80(m);
  const s = run(m, 3000, parkedWithRattle, 10);
  const peak = s.indexOf(Math.max(...s));
  // A settling rattle can nudge the angle a hair; anything under 0.05° is far
  // below what the overlay can show (it's all but transparent under 2°).
  for (let i = peak + 1; i < s.length; i++) {
    assert.ok(s[i] - s[i - 1] < 0.05 * DEG, `blur grew again at frame ${i}: ${s[i - 1] / DEG}° -> ${s[i] / DEG}°`);
  }
  assert.ok(m.idle(), 'never finished despite the lid being parked');
});

test('once the lid stops, blur holds briefly then eases away', () => {
  const m = create();
  closeTo80(m);
  const s = run(m, 2500, parkedWithRattle, 10);
  assert.ok(s[Math.floor(100 / FRAME)] > 20 * DEG, 'released before the hold');
  const goneAt = s.findIndex(v => Math.abs(v) < 2 * DEG) * FRAME;
  assert.ok(goneAt > 0 && goneAt < 1000, `still visible after ${goneAt}ms`);
  assert.ok(m.idle());
});

test('moving again mid-retract picks up without a jump', () => {
  const m = create();
  closeTo80(m);
  run(m, 350, parkedWithRattle, 10);                   // hold passes, retract starts
  const s = run(m, 400, t => 80 - Math.min(t / 300, 1) * 30, 10);  // close further
  for (let i = 2; i < s.length; i++) {
    assert.ok(Math.abs(s[i] - 2 * s[i - 1] + s[i - 2]) < 1.5 * DEG, `lurched at frame ${i}`);
  }
  assert.ok(s[s.length - 1] > Math.min(...s) + 5 * DEG, 'did not pick back up');
  assert.ok(!m.idle());
});

test('stiff tunings stay numerically stable', () => {
  const m = create({ tiltHz: 40, settleHz: 40, smoothMs: 1 });
  m.reset(120, 120);
  const s = run(m, 1500, t => (t < 100 ? 120 : 40), 30);
  assert.ok(s.every(Number.isFinite), 'produced a non-finite tilt');
});
