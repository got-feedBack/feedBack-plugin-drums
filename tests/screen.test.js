'use strict';
// Coverage for pure helpers in screen.js: MIDI mapping, lane presets,
// drum-tab hit conversion, custom-mapping validation, arrangement matching.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = { addEventListener: () => {} };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

test('noteToMidi maps string/fret to a MIDI number (24 semitones per string)', () => {
    const mod = freshPlugin();
    assert.equal(mod.noteToMidi(0, 0), 0);
    assert.equal(mod.noteToMidi(1, 12), 36);
});

test('_rgbStr formats rgb()/rgba() from 0..1 channel floats', () => {
    const mod = freshPlugin();
    assert.equal(mod._rgbStr(1, 0, 0), 'rgb(255,0,0)');
    assert.equal(mod._rgbStr(1, 0, 0, 0.5), 'rgba(255,0,0,0.5)');
});

test('_validateCustomMapping keeps only in-range MIDI keys with known lane ids', () => {
    const mod = freshPlugin();
    const clean = mod._validateCustomMapping({ '38': 'snare', '200': 'kick', '40': 'nope-lane' });
    assert.deepEqual({ ...clean }, { 38: 'snare' }); // clean has a null prototype
});

test('_validateCustomMapping rejects non-objects, arrays, and prototype-poisoning keys', () => {
    const mod = freshPlugin();
    assert.equal(mod._validateCustomMapping(null), null);
    assert.equal(mod._validateCustomMapping('nope'), null);
    assert.equal(mod._validateCustomMapping([1, 2]), null);
    // Empty after filtering -> null, not {}.
    assert.equal(mod._validateCustomMapping({ '__proto__': 'kick' }), null);
    assert.equal(mod._validateCustomMapping({}), null);
});

test('_drumTabHitsToNotes converts known piece-ids to {t,s,f} and sorts by time', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([
        { p: 'snare', t: 1.0, v: 120 },
        { p: 'kick', t: 0.5, v: 80 },
    ]);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].t, 0.5);
    assert.equal(notes[0]._piece, 'kick');
    assert.equal(notes[0].ac, false); // v=80 < 100
    assert.equal(notes[1].ac, true);  // v=120 >= 100
});

test('_drumTabHitsToNotes drops unknown piece-ids and non-finite/negative timestamps', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([
        { p: 'cowbell', t: 1.0 },       // unknown piece
        { p: 'snare', t: -1 },           // negative time
        { p: 'snare', t: NaN },          // non-finite
        { p: 'snare', t: 2.0 },          // kept
    ]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].t, 2.0);
});

test('_drumTabHitsToNotes emits a leading grace note for flams', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([{ p: 'snare', t: 1.0, v: 100, f: true }]);
    assert.equal(notes.length, 2);
    const [grace, main] = notes;
    assert.equal(grace._noScore, true);
    assert.ok(grace.t < main.t);
    assert.equal(main.t, 1.0);
});

test('_drumTabHitsToNotes ignores a non-array payload', () => {
    const mod = freshPlugin();
    assert.deepEqual(mod._drumTabHitsToNotes(null), []);
    assert.deepEqual(mod._drumTabHitsToNotes('nope'), []);
});

test('lane preset switch rebuilds DRUM_LANES and the default map', () => {
    const mod = freshPlugin();
    mod._applyLanePreset('rb4');
    assert.deepEqual(mod.DRUM_LANES.map(l => l.id), ['hihat', 'snare', 'tom1', 'tom3', 'crash', 'ride', 'kick']);
    // In rb4, mid-tom notes 45/47 fold into tom1 (no separate tom2 lane).
    assert.equal(mod._midiToLaneIdx(45), mod.DRUM_LANES.findIndex(l => l.id === 'tom1'));

    mod._applyLanePreset('phase_shift_8');
    assert.deepEqual(mod.DRUM_LANES.map(l => l.id),
        ['hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick']);
});

test('_applyLanePreset falls back to phase_shift_8 for an unknown preset name', () => {
    const mod = freshPlugin();
    mod._applyLanePreset('not-a-real-preset');
    assert.deepEqual(mod.DRUM_LANES.map(l => l.id),
        ['hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick']);
});

test('_midiToLaneIdx/_songNoteToLaneIdx resolve unmapped notes to -1', () => {
    const mod = freshPlugin();
    assert.equal(mod._midiToLaneIdx(999), -1);
    assert.equal(mod._songNoteToLaneIdx(999), -1);
});

test('_midiResolveSaved matches by stored key first, falls back to legacy bare id', () => {
    const mod = freshPlugin();
    const sources = [{ id: 'dev1', key: 'webmidi:dev1' }];
    assert.equal(mod._midiResolveSaved('webmidi:dev1', sources), 'webmidi:dev1');
    assert.equal(mod._midiResolveSaved('dev1', sources), 'webmidi:dev1');
    assert.equal(mod._midiResolveSaved('nope', sources), null);
});

test('matchesArrangement trusts has_drum_tab regardless of arrangement name', () => {
    const mod = freshPlugin();
    assert.equal(mod.matchesArrangement({ has_drum_tab: true, arrangement: 'Lead' }), true);
});

test('matchesArrangement matches drum-pattern arrangement names', () => {
    const mod = freshPlugin();
    assert.equal(mod.matchesArrangement({ arrangement: 'Drums' }), true);
    assert.equal(mod.matchesArrangement({ arrangement: 'Lead Guitar' }), false);
});

test('matchesArrangement rejects falsy songInfo', () => {
    const mod = freshPlugin();
    assert.equal(mod.matchesArrangement(null), false);
});

test('PIECE_DEFAULT_MIDI covers the canonical piece set used by _drumTabHitsToNotes', () => {
    const mod = freshPlugin();
    assert.equal(mod.PIECE_DEFAULT_MIDI.kick, 36);
    assert.equal(mod.PIECE_DEFAULT_MIDI.snare, 38);
});

// ── scoring: drum_tab gameplay flags (feedpak 1.20.0) ──────────────────────

test('_drumTabHitsToNotes: authored accents (a) win over velocity; a hit without v is no accent', () => {
    const mod = freshPlugin();
    // pre-1.20.0 tab: written velocity >= 100 is the accent, missing v is not
    let notes = mod._drumTabHitsToNotes([{ p: 'snare', t: 1, v: 110 }, { p: 'snare', t: 2 }, { p: 'snare', t: 3, v: 120, g: true }]);
    assert.deepEqual(notes.map(n => [n.ac, n.mt]), [[true, false], [false, false], [false, true]], 'never accent + ghost');
    // a tab that marks accents: only `a` counts, whatever the velocity
    notes = mod._drumTabHitsToNotes([{ p: 'snare', t: 1, v: 127 }, { p: 'snare', t: 2, a: true }]);
    assert.deepEqual(notes.map(n => n.ac), [false, true]);
});

test('_drumTabHitsToNotes: a double kick (x2) becomes GM 35, the engine\'s Expert+ kick', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([{ p: 'kick', t: 1 }, { p: 'kick', t: 1.1, x2: true }, { p: 'snare', t: 1.2, x2: true }]);
    assert.deepEqual(notes.map(n => n.s * 24 + n.f), [36, mod.KICK2X_MIDI, 38], 'x2 only means something on a kick');
    assert.equal(mod.KICK2X_MIDI, 35);
});

test('drum_tab gameplay metadata plays through session.js: levels, Expert / Expert+, star power', () => {
    const mod = freshPlugin();
    const H = require(path.join(__dirname, '..', 'assets', 'session.js'));
    const tab = {
        hits: [{ t: 1, p: 'kick' }, { t: 1, p: 'crash_l', a: true }, { t: 1.25, p: 'kick', x2: true }, { t: 1.5, p: 'snare' }],
        star_power: [{ start_time: 1, end_time: 2 }],
        fills: [{ start_time: 6, end_time: 8 }],
        levels: { easy: { hits: [{ t: 1, p: 'crash_l' }], generated: true } },
    };
    const notes = mod._drumTabHitsToNotes(tab.hits);
    const meta = H.parseDrumTabMeta(tab, mod._drumTabHitsToNotes);
    assert.deepEqual(meta.starPower, [{ start: 1, end: 2 }]);
    const opts = H.difficultyOptions({ meta, has2x: H.hasKick2x(notes, []) });
    assert.deepEqual(opts.filter(o => o.available).map(o => o.id), ['easy', 'expert', 'expert_plus']);
    assert.equal(H.difficultyChart('expert', notes, [], meta).notes.length, 3, 'Expert drops the double kick');
    assert.equal(H.difficultyChart('expert_plus', notes, [], meta).notes.length, 4);
    assert.deepEqual(H.difficultyChart('easy', notes, [], meta).notes.map(n => n.s * 24 + n.f), [49]);
});

test('difficulty preference: drums_difficulty_v1, default Expert, junk ignored, same ids as session.js', () => {
    const H = require(path.join(__dirname, '..', 'assets', 'session.js'));
    let mod = freshPlugin();
    assert.deepEqual(mod.DIFFICULTY_IDS, Array.from(H.DIFFICULTIES));
    assert.deepEqual(mod.AUTO_LEVEL_IDS, Array.from(H.AUTO_LEVELS));
    assert.equal(mod.STORE_KEYS.difficulty, 'drums_difficulty_v1');
    assert.equal(mod._difficultyPref(), 'expert');
    const store = { drums_difficulty_v1: 'hard' };
    const load = () => {
        global.window = {};
        global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
        global.document = { addEventListener: () => {}, querySelectorAll: () => [] };
        const file = path.join(__dirname, '..', 'screen.js');
        delete require.cache[require.resolve(file)];
        return require(file);
    };
    mod = load();
    assert.equal(mod._difficultyPref(), 'hard');
    store.drums_difficulty_v1 = 'insane';
    assert.equal(load()._difficultyPref(), 'expert');
    mod = load();
    mod._setDifficulty('expert_plus');
    assert.equal(store.drums_difficulty_v1, 'expert_plus');
    mod._setDifficulty('<script>');
    assert.equal(store.drums_difficulty_v1, 'expert', 'invalid ids are not persisted');
});

test('assists: _autoAt follows the difficulty ceiling; _saveCfg validates the new settings', () => {
    const mod = freshPlugin();
    const cfg = mod._cfg();
    assert.equal(cfg.autoKick, 'off');
    assert.equal(cfg.timing, 'normal');
    assert.equal(cfg.proCymbals, true);
    assert.equal(cfg.inputOffsetMs, 0);
    mod._saveCfg('autoKick', 'medium');
    mod._saveCfg('autoCymbals', 'all');
    assert.deepEqual(mod._autoAt('easy'), { kick: true, cymbals: true });
    assert.deepEqual(mod._autoAt('hard'), { kick: false, cymbals: true });
    mod._saveCfg('autoKick', 'nonsense');
    mod._saveCfg('timing', 'turbo');
    mod._saveCfg('synthVolume', 7);
    mod._saveCfg('inputOffsetMs', 9000);
    assert.equal(cfg.autoKick, 'off');
    assert.equal(cfg.timing, 'normal');
    assert.equal(cfg.synthVolume, 1);
    assert.equal(cfg.inputOffsetMs, 250);
    assert.equal(mod._timingParams(), null);
    mod._saveCfg('timing', 'relaxed');
    assert.equal(mod._timingParams().hitWindow.maxWindow, 0.26);
    assert.deepEqual(mod.TIMING_IDS, Object.keys(mod.TIMING_PRESETS));
});

test('assists: _laneIsAuto maps 2D lanes (kick; hi-hat/crash/ride)', () => {
    const mod = freshPlugin();
    const idx = (id) => mod.DRUM_LANES.findIndex(l => l.id === id);
    const a = { kick: true, cymbals: false };
    assert.equal(mod._laneIsAuto(idx('kick'), a), true);
    assert.equal(mod._laneIsAuto(idx('hihat'), a), false);
    assert.equal(mod._laneIsAuto(idx('ride'), { cymbals: true }), true);
    assert.equal(mod._laneIsAuto(idx('snare'), { kick: true, cymbals: true }), false);
});

test('auto notes: _autoNotesBetween returns the auto kick / cymbal notes in (from, to] with velocities', () => {
    const mod = freshPlugin();
    const n = (t, midi, extra) => Object.assign({ t, s: Math.floor(midi / 24), f: midi % 24 }, extra || {});
    const notes = [n(1, 36), n(1, 42), n(1.5, 38), n(2, 36, { ac: true }), n(2, 49), n(3, 35, { mt: true }), n(3, 44)];
    const chords = [{ t: 2.5, notes: [{ s: 1, f: 12 }, { s: 1, f: 14 }] }];   // kick + snare
    const k = mod._autoNotesBetween(notes, chords, 1, 3, { kick: true });
    assert.deepEqual(k, [{ t: 2, midi: 36, vel: 118 }, { t: 3, midi: 35, vel: 55 }, { t: 2.5, midi: 36, vel: 100 }]);
    const c = mod._autoNotesBetween(notes, [], 0, 3, { cymbals: true });
    assert.deepEqual(c.map(x => x.midi), [42, 49], 'hat pedal 44 is not an auto note');
    assert.deepEqual(mod._autoNotesBetween(notes, chords, 0, 3, { kick: false, cymbals: false }), []);
    assert.deepEqual(mod._autoNotesBetween(notes, chords, 3, 3, { kick: true }), [], 'empty window');
    assert.equal(mod._cfg().autoVolume, 0.8);
});

// ── review fixes: velocity, script retry, input offset, star power pad ────

test('_engineVelocity: MIDI 1..127 -> 0..1, so velocity 1 is the softest hit (not full strength)', () => {
    const mod = freshPlugin();
    assert.equal(mod._engineVelocity(127), 1);
    assert.ok(Math.abs(mod._engineVelocity(1) - 1 / 127) < 1e-12);
    assert.ok(mod._engineVelocity(1) < 0.35, 'below the engine ghost threshold');
    assert.equal(mod._engineVelocity(64), 64 / 127);
    assert.equal(mod._engineVelocity(200), 1);
    assert.equal(mod._engineVelocity(undefined), undefined, 'no velocity -> no dynamics judgement');
});

// A tiny DOM for the script loader: <script> elements in <head>, found by src.
function fakeScriptDom() {
    const head = [];
    const doc = {
        addEventListener: () => {},
        querySelectorAll: (sel) => {
            const m = /^script\[src="(.*)"\]$/.exec(sel);
            return m ? head.filter(s => s.src === m[1]) : [];
        },
        querySelector: (sel) => doc.querySelectorAll(sel)[0] || null,
        createElement: () => {
            const el = { src: '', onload: null, onerror: null };
            el.remove = () => { const i = head.indexOf(el); if (i >= 0) head.splice(i, 1); };
            return el;
        },
        head: { appendChild: (el) => { head.push(el); } },
    };
    return { doc, head };
}

test('_loadScoring: a failed script load can be retried (the dead <script> element is removed)', async () => {
    const { doc, head } = fakeScriptDom();
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = doc;
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);

    // First try: engine.js loads, session.js fails (network error).
    const p1 = mod._loadScoring();
    assert.equal(head.length, 2);
    window.DrumsEngine = { fake: 'engine' };
    head[0].onload();
    head[1].onerror();
    await assert.rejects(p1, /Failed to load/);
    assert.equal(head.length, 1, 'the failed session.js element is gone');

    // Retry: session.js is requested again (not resolved on the stale tag).
    const p2 = mod._loadScoring();
    assert.equal(head.length, 2);
    assert.match(head[1].src, /session\.js/);
    window.DrumsSession = { fake: 'session' };
    head[1].onload();
    const r = await p2;
    assert.equal(r.E, window.DrumsEngine);
    assert.equal(r.H, window.DrumsSession);
});

test('_loadScoring: a script that loads but never registers is dropped so a retry reloads it', async () => {
    const { doc, head } = fakeScriptDom();
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = doc;
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    const p1 = mod._loadScoring();
    head[0].onload(); head[1].onload();            // e.g. an HTML error page served as JS
    await assert.rejects(p1, /did not register/);
    assert.equal(head.length, 0);
    const p2 = mod._loadScoring();
    assert.equal(head.length, 2, 'both files requested again');
    window.DrumsEngine = {}; window.DrumsSession = {};
    head[0].onload(); head[1].onload();
    await p2;
});

test('_setInputOffset saves, clamps and hands the offset to every live view', () => {
    const mod = freshPlugin();
    const seen = [];
    mod._instances().add({ _inputOffsetChanged: () => seen.push(mod._cfg().inputOffsetMs) });
    assert.equal(mod._setInputOffset(23), 23);
    assert.equal(mod._setInputOffset('-400'), -250);
    assert.deepEqual(seen, [23, -250]);
    mod._instances().clear();
});

test('star power pad: drums_sp_pad_v1, off by default, any MIDI note 0..127', () => {
    const mod = freshPlugin();
    assert.equal(mod.STORE_KEYS.spPad, 'drums_sp_pad_v1');
    assert.equal(mod._cfg().spPad, -1);
    assert.equal(mod._spPadName(), '');
    mod._saveCfg('spPad', '44');
    assert.equal(mod._cfg().spPad, 44);
    assert.equal(mod._spPadName(), 'hi-hat pedal');
    mod._saveCfg('spPad', 99);
    assert.equal(mod._spPadName(), 'MIDI note 99');
    mod._saveCfg('spPad', 300);
    assert.equal(mod._cfg().spPad, -1);
    mod._saveCfg('spPad', 'x');
    assert.equal(mod._cfg().spPad, -1);
    assert.equal(mod.SP_PAD_CHOICES[0][0], -1);
});

// ── drum view on a part that isn't drums ────────────────────────────────────

test('_isDrumsArrangement / _noDrumsMessage: refuse guitar parts, explain why', () => {
    const mod = freshPlugin();
    assert.equal(mod._isDrumsArrangement({ arrangement: 'Drums' }), true);
    assert.equal(mod._isDrumsArrangement({ arrangement_index: 2, arrangements: [{ index: 2, name: 'Percussion' }] }), true);
    assert.equal(mod._isDrumsArrangement({ arrangement: 'Lead' }), false);
    assert.equal(mod._isDrumsArrangement({ has_drum_tab: true, arrangement: 'Lead' }), false, 'the drum tab is checked separately');
    assert.equal(mod._isDrumsArrangement(null), false);
    assert.equal(mod._noDrumsMessage({ arrangement: 'Lead', arrangements: [{ name: 'Lead' }, { name: 'Drums' }] }),
        'Pick the Drums part: Lead is not drums');
    assert.equal(mod._noDrumsMessage({ arrangement: 'Lead', arrangements: [{ name: 'Lead' }, { name: 'Bass' }] }),
        'This song has no drums');
    assert.equal(mod._noDrumsMessage(undefined), 'This song has no drums');
});

// ── MIDI routing (splitscreen) ──────────────────────────────────────────────

test('_routeTarget: kit hits go to the focused drum view on screen, else the first one on screen', () => {
    const mod = freshPlugin();
    const hits = [];
    const view = (name, visible) => ({ name, _isVisible: () => visible, _handleDrumHit: (n, v, ts) => hits.push([name, n, v, ts]) });
    const hidden = view('hidden main player', false);
    const panel = view('panel 2', true);
    mod._instances().add(hidden);
    mod._instances().add(panel);
    assert.equal(mod._routeTarget(), panel, 'the hidden view does not swallow hits');
    mod._midiOnMessage({ data: [0x99, 38, 90], timeStamp: 1234.5 });
    mod._midiOnMessage({ data: [0x89, 38, 0] });    // note off: ignored
    mod._midiOnMessage({ data: [0x99, 38, 0] });    // note on velocity 0 = off
    assert.deepEqual(hits, [['panel 2', 38, 90, 1234.5]], 'the MIDI timestamp is passed on');
    mod._instances().clear();
    assert.equal(mod._routeTarget(), null);
});

// ── end-of-song results card ────────────────────────────────────────────────

function fakeCardDom() {
    const body = [];
    const listeners = [];
    global.performance = global.performance || { now: () => Date.now() };
    return {
        body,
        listeners,
        doc: {
            addEventListener: (type, fn) => listeners.push([type, fn]),
            removeEventListener: (type, fn) => { const i = listeners.findIndex(l => l[1] === fn); if (i >= 0) listeners.splice(i, 1); },
            querySelectorAll: () => [],
            createElement: () => {
                const el = { style: {}, attrs: {}, innerHTML: '', className: '', handlers: {} };
                el.setAttribute = (k, v) => { el.attrs[k] = v; };
                el.addEventListener = (t, fn) => { el.handlers[t] = fn; };
                el.remove = () => { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); };
                return el;
            },
            body: { appendChild: (el) => body.push(el) },
        },
    };
}

test('_drumsEndCard: total with bonuses, best score per song + difficulty, nothing when nothing was hit', () => {
    const dom = fakeCardDom();
    const store = {};
    const events = {};
    global.window = { feedBack: {
        currentSong: { filename: 'song.sloppak', title: 'Song <1>', artist: 'Band' },
        on: (n, fn) => { events[n] = fn; }, off: (n) => { delete events[n]; },
    } };
    global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    global.document = dom.doc;
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    const session = (st, bonus) => ({ getState: () => st, getBonus: () => bonus });
    const st = { notesHit: 90, notesMissed: 10, totalNotes: 100, score: 5000, starPowerScore: 600, stars: 4.2,
        maxCombo: 40, fullCombo: false, overhits: 2 };
    const bonus = { total: 250, timing: 150, perfect: 15, rolls: 100, runs: [{ h: 9, n: 10 }], solo: 0, solos: [] };
    const r = mod._drumsEndCard(session(st, bonus), { text: 'HARD' });
    assert.equal(r.total, 5250);
    assert.equal(r.best, true);
    assert.equal(store['drums.best:song.sloppak|HARD'], '5250');
    assert.equal(dom.body.length, 1);
    assert.match(dom.body[0].innerHTML, /Song &lt;1&gt;/, 'song title escaped');
    assert.match(dom.body[0].innerHTML, /90\.00%/);
    assert.ok(events['song:loading'], 'closes when the next song loads');
    r.close();
    assert.equal(dom.body.length, 0);
    assert.equal(dom.listeners.length, 0, 'key listener removed');
    // a second card right away (another view on the same song end) is skipped
    assert.equal(mod._drumsEndCard(session(st, bonus), { text: 'HARD' }), null);
    // nothing hit: no card
    const mod2 = (() => { delete require.cache[require.resolve(file)]; return require(file); })();
    assert.equal(mod2._drumsEndCard(session(Object.assign({}, st, { notesHit: 0 }), bonus), null), null);
    // a lower score keeps the best
    const r3 = mod2._drumsEndCard(session(Object.assign({}, st, { score: 100 }), { total: 0 }), { text: 'HARD' });
    assert.equal(r3.best, false);
    assert.equal(r3.previous, 5250);
    assert.equal(store['drums.best:song.sloppak|HARD'], '5250');
    r3.close();
});
