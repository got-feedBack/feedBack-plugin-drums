'use strict';
// Unit tests for highway3d.js (keyboard input, the pieces the 3D view exports without WebGL) and
// screen.js view selection. The Three.js scene itself needs a browser (see README "3D view").
// Run: node tests/highway3d.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const H = require(path.join(__dirname, '..', 'assets', 'highway3d.js'));
const S = require(path.join(__dirname, '..', 'assets', 'session.js'));
const E = require(path.join(__dirname, '..', 'assets', 'engine.js'));

test('highway3d.js exports the view factory and keyboard helpers', () => {
    assert.equal(typeof H.createView, 'function');
    assert.equal(H.TRACK.lanes, S.LANE_NAMES.length);
    assert.throws(() => H.createView({}, { getContext: () => null }), /WebGL2/);
});

test('keyToPad: keyboard fallback layout (physical keys)', () => {
    const k = (code, extra) => H.keyToPad(Object.assign({ code, key: '' }, extra || {}));
    assert.equal(k('Space'), null, 'Space stays play/pause');
    assert.deepEqual(k('KeyB'), { pad: 0, cymbal: false });
    assert.deepEqual(k('KeyF'), { pad: 1, cymbal: false });
    assert.deepEqual(k('KeyJ'), { pad: 2, cymbal: false });
    assert.deepEqual(k('KeyK'), { pad: 3, cymbal: false });
    assert.deepEqual(k('KeyL'), { pad: 4, cymbal: false });
    assert.deepEqual(k('KeyJ', { shiftKey: true }), { pad: 2, cymbal: true });
    assert.deepEqual(k('KeyL', { shiftKey: true }), { pad: 4, cymbal: true });
    assert.deepEqual(k('KeyU'), { pad: 2, cymbal: true });
    assert.deepEqual(k('KeyI'), { pad: 3, cymbal: true });
    assert.deepEqual(k('KeyO'), { pad: 4, cymbal: true });
    assert.deepEqual(k('KeyF', { shiftKey: true }), { pad: 1, cymbal: false }, 'red has no cymbal');
    assert.deepEqual(k('KeyB', { shiftKey: true }), { pad: 0, cymbal: false });
    assert.deepEqual(k('Enter'), { action: 'activate' });
    assert.deepEqual(k('NumpadEnter'), { action: 'activate' });
});

test('keyToPad: falls back to e.key, ignores modifiers and unmapped keys', () => {
    assert.deepEqual(H.keyToPad({ key: 'K' }), { pad: 3, cymbal: false });
    assert.deepEqual(H.keyToPad({ key: 'b' }), { pad: 0, cymbal: false });
    assert.equal(H.keyToPad({ key: ' ' }), null);
    assert.deepEqual(H.keyToPad({ key: 'Enter' }), { action: 'activate' });
    assert.equal(H.keyToPad({ code: 'KeyF', ctrlKey: true }), null);
    assert.equal(H.keyToPad({ code: 'KeyJ', metaKey: true }), null);
    assert.equal(H.keyToPad({ code: 'KeyJ', altKey: true }), null);
    assert.equal(H.keyToPad({ code: 'KeyQ', key: 'q' }), null);
    assert.equal(H.keyToPad({ code: 'ArrowLeft', key: 'ArrowLeft' }), null);
    assert.equal(H.keyToPad(null), null);
});


test('synthMidiForPad picks a GM sound for keyboard hits', () => {
    assert.equal(H.synthMidiForPad(0, false), 36);
    assert.equal(H.synthMidiForPad(1, false), 38);
    assert.equal(H.synthMidiForPad(2, true), 42);
    assert.equal(H.synthMidiForPad(2, false), 48);
    assert.equal(H.synthMidiForPad(3, true), 51);
    assert.equal(H.synthMidiForPad(3, false), 45);
    assert.equal(H.synthMidiForPad(4, true), 49);
    assert.equal(H.synthMidiForPad(4, false), 41);
    assert.equal(H.synthMidiForPad(9, false), null);
    // every pad maps back to itself through GM
    for (const [pad, cym] of [[0, false], [1, false], [2, true], [2, false], [3, true], [3, false], [4, true], [4, false]]) {
        assert.deepEqual(E.padFromMidi(H.synthMidiForPad(pad, cym)), { pad, cymbal: cym });
    }
});


test('D is the difficulty key, never a drum key', () => {
    assert.equal(H.keyToPad({ code: 'KeyD', key: 'd' }), null);
    assert.deepEqual(S.isDifficultyKey({ code: 'KeyD', key: 'd' }), { dir: 1 });
    for (const code of ['KeyB', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO', 'Enter']) {
        assert.equal(S.isDifficultyKey({ code, key: code }), null, code);
        assert.notEqual(H.keyToPad({ code, key: '' }), null, code);
    }
});

// ── screen.js view selection ──────────────────────────────────────────────

test('screen.js _resolveView: 3D when WebGL2 is available unless 2D is chosen', () => {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = { addEventListener: () => {} };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    assert.equal(mod._resolveView('auto', true), '3d');
    assert.equal(mod._resolveView('auto', false), '2d');
    assert.equal(mod._resolveView('3d', true), '3d');
    assert.equal(mod._resolveView('3d', false), '2d');
    assert.equal(mod._resolveView('2d', true), '2d');
    assert.deepEqual([...mod._VALID_VIEWS].sort(), ['2d', '3d', 'auto']);
    assert.equal(typeof window.feedBackViz_drums, 'function');
    assert.equal(window.feedBackViz_drums.contextType, undefined, 'no static webgl2: Auto must not skip it without WebGL2');
    assert.equal(window.feedBackViz_drums3d.contextType, 'webgl2');
    assert.equal(typeof window.feedBackViz_drums.matchesArrangement, 'function');
    assert.equal(mod._cfg().view, 'auto');
    assert.equal(mod._cfg().keyboard, true);
    mod._saveCfg('view', 'vr');
    assert.equal(mod._cfg().view, 'auto', 'unknown views are not saved');
});
