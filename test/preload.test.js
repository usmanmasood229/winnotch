'use strict';
// The notch's preload under a fake contextBridge/ipcRenderer: every push
// subscription hands back an unsubscribe that really removes its listener.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const SRC = process.env.WINNOTCH_SRC || path.join(__dirname, '..', 'src');

const ipcRenderer = new EventEmitter();
ipcRenderer.send = () => {};
ipcRenderer.invoke = async () => {};
const exposed = {};
const fakeElectron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer };

const realLoad = Module._load;
Module._load = function (request) {
  return request === 'electron' ? fakeElectron : realLoad.apply(this, arguments);
};
require(path.join(SRC, 'preload.js'));
Module._load = realLoad;
const api = exposed.api;

for (const [method, channel, payload] of [
  ['onAgents', 'agents', { at: 1, sessions: [] }],
  ['onPermissionGone', 'permission-gone', '7'],
  ['onPermission', 'permission', { id: '1' }],
  ['onCharging', 'charging-change', true],
  ['onHingeAngle', 'hinge-angle', 12.5],
  ['onHingeShot', 'hinge-shot', { dataUrl: 'x' }],
]) {
  test(method + ' delivers ' + channel + ' and its unsubscribe removes the listener', () => {
    const got = [];
    const off = api[method](v => got.push(v));
    assert.strictEqual(typeof off, 'function', method + ' returns an unsubscribe');
    assert.strictEqual(ipcRenderer.listenerCount(channel), 1);
    ipcRenderer.emit(channel, {}, payload);
    assert.deepStrictEqual(got, [payload], 'the payload, not the event');
    off();
    assert.strictEqual(ipcRenderer.listenerCount(channel), 0);
    ipcRenderer.emit(channel, {}, payload);
    assert.strictEqual(got.length, 1, 'nothing after unsubscribing');
  });
}

test('onAgents unsubscribe removes only its own listener', () => {
  const a = [], b = [];
  const offA = api.onAgents(v => a.push(v));
  const offB = api.onAgents(v => b.push(v));
  offA();
  ipcRenderer.emit('agents', {}, 'snap');
  assert.deepStrictEqual(a, []);
  assert.deepStrictEqual(b, ['snap']);
  offB();
});
