'use strict';
// Unit tests for session.js: chart -> render model, gem classification, drum_tab gameplay metadata
// (feedpak 1.20.0), difficulty levels, auto lanes, MIDI mapping, timing and HUD helpers, and the engine
// session. No DOM needed.
// Run: node tests/session.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const H = require(path.join(__dirname, '..', 'assets', 'session.js'));
const E = require(path.join(__dirname, '..', 'assets', 'engine.js'));

const w = (t, midi, extra) => Object.assign({ t, s: Math.floor(midi / 24), f: midi % 24 }, extra || {});

// Minimal drum_tab hits -> wire notes converter (screen.js _drumTabHitsToNotes does the full job).
const GM = { kick: 36, snare: 38, hh_closed: 42, crash_l: 49, ride: 51, tom_hi: 48 };
const toNotes = (hits) => hits.filter(h => GM[h.p]).map(h => w(h.t, h.p === 'kick' && h.x2 ? 35 : GM[h.p],
    h.a ? { ac: true } : (h.g ? { mt: true } : {})));
const tabMeta = (tab) => H.parseDrumTabMeta(tab, toNotes);

// ── chart -> render model ──────────────────────────────────────────────────

test('collectWireNotes flattens chords with the chord time and drops visual-only notes', () => {
    const notes = [w(1, 38), w(0.5, 36), Object.assign(w(0.97, 38), { _noScore: true }), null];
    const chords = [{ t: 2, notes: [{ s: 1, f: 12 }, { s: 1, f: 18 }] }, { t: 3 }, null];
    const out = H.collectWireNotes(notes, chords);
    assert.equal(out.length, 4);
    assert.deepEqual(out.slice(2).map(n => [n.t, n.s * 24 + n.f]), [[2, 36], [2, 42]]);
    assert.deepEqual(H.collectWireNotes(null, undefined), []);
    // the chord's own note objects are not mutated
    assert.equal(chords[0].notes[0].t, undefined);
});

test('classifyNote: pads, cymbals, kick and 2x kick, with dynamics and lane colours', () => {
    assert.deepEqual(H.classifyNote({ pad: 0 }), { kind: 'kick', lane: -1, cymbal: false, kick2x: false, accent: false, ghost: false, color: H.COLORS.kick });
    assert.equal(H.classifyNote({ pad: 0, kick2x: true }).kind, 'kick2x');
    assert.equal(H.classifyNote({ pad: 0, kick2x: true }).color, H.COLORS.kick2x);
    const red = H.classifyNote({ pad: 1, dyn: 'accent' });
    assert.deepEqual([red.kind, red.lane, red.accent, red.color], ['pad', 0, true, H.LANE_COLORS.red]);
    assert.equal(H.classifyNote({ pad: 1, cymbal: true }).kind, 'pad', 'there is no red cymbal');
    const hat = H.classifyNote({ pad: 2, cymbal: true, dyn: 'ghost' });
    assert.deepEqual([hat.kind, hat.lane, hat.ghost, hat.color], ['cymbal', 1, true, H.LANE_COLORS.yellow]);
    assert.equal(H.classifyNote({ pad: 3 }).color, H.LANE_COLORS.blue);
    assert.equal(H.classifyNote({ pad: 4, cymbal: true }).lane, 3);
    assert.equal(H.classifyNote({ pad: 7 }), null);
    assert.equal(H.classifyNote(null), null);
});

test('buildGems maps General MIDI wire notes to gems keyed by engine note id', () => {
    const wire = [w(1, 42), w(1, 36), w(1.5, 48), w(2, 51), w(2, 45), w(2.5, 49, { ac: true }), w(2.5, 41),
        w(3, 35), w(3.25, 38, { mt: true })];
    const decoded = E.decodeNotes(wire);
    const gems = H.buildGems(decoded);
    const desc = gems.map(g => `${g.t}:${g.kind}:${g.lane}`);
    assert.deepEqual(desc, ['1:cymbal:1', '1:kick:-1', '1.5:pad:1', '2:cymbal:2', '2:pad:2', '2.5:cymbal:3', '2.5:pad:3',
        '3:kick2x:-1', '3.25:pad:0']);
    assert.ok(gems.find(g => g.t === 2.5 && g.cymbal).accent);
    assert.ok(gems[gems.length - 1].ghost);
    for (const g of gems) assert.equal(decoded.notes[g.id].t, g.t, 'gem id is the decoded/engine note id');
    // the engine knows every gem id
    const eng = E.create(decoded);
    for (const g of gems) assert.equal(eng.noteState(g.id), null);
});

test('visibleRange returns the half-open index range of gems in [t0, t1)', () => {
    const gems = [0, 1, 1, 2, 3, 5].map(t => ({ t }));
    assert.deepEqual(H.visibleRange(gems, 1, 3), [1, 4]);
    assert.deepEqual(H.visibleRange(gems, -5, 0), [0, 0]);
    assert.deepEqual(H.visibleRange(gems, 4, 10), [5, 6]);
    assert.deepEqual(H.visibleRange([], 0, 1), [0, 0]);
});

test('normalizeBeats keeps finite times, marks downbeats (measure >= 0) and sorts', () => {
    const out = H.normalizeBeats([{ time: 1, measure: -1 }, { time: 0.5, measure: 1 }, { t: 1.5 }, 2, { time: 'x' }, null]);
    assert.deepEqual(out, [{ t: 0.5, measure: true }, { t: 1, measure: false }, { t: 1.5, measure: false }, { t: 2, measure: false }]);
    assert.deepEqual(H.normalizeBeats(undefined), []);
});

// ── drums metadata (star power / fills) ───────────────────────────────────

test('parseDrumTabMeta reads drum_tab star power / fills / solos into engine option shape', () => {
    const tab = { version: 1, hits: [],
        star_power: [{ start_time: 10, end_time: 14 }, { start_time: 2, end_time: 4.5 }],
        fills: [{ start_time: 20, end_time: 22 }], solos: [{ start_time: 30, end_time: 40 }] };
    assert.deepEqual(tabMeta(tab), { pro: true,
        starPower: [{ start: 2, end: 4.5 }, { start: 10, end: 14 }], activation: [{ start: 20, end: 22 }],
        solos: [{ start: 30, end: 40 }], levels: null, levelsGenerated: [] });
});

test('parseDrumTabMeta drops malformed ranges; a tab without metadata gives null', () => {
    const m = tabMeta({ hits: [], star_power: [{ start_time: 5, end_time: 1 }, { start_time: 'a', end_time: 2 },
        [1, 2], { end_time: 3 }, { start_time: 3, end_time: 4 }, 7], fills: 'nope' });
    assert.deepEqual(m.starPower, [{ start: 3, end: 4 }]);
    assert.deepEqual(m.activation, []);
    assert.equal(tabMeta({ version: 1, hits: [{ t: 1, p: 'kick' }] }), null, 'pre-1.20.0 tab');
    assert.equal(tabMeta({ hits: [], star_power: [] }), null);
    assert.equal(tabMeta(null), null);
    assert.equal(tabMeta([1, 2]), null);
});

// ── difficulty levels ─────────────────────────────────────────────────────

const LEVELS_TAB = {
    version: 1, hits: [], star_power: [{ start_time: 1, end_time: 2 }],
    levels: {
        easy: { hits: [{ t: 2, p: 'kick' }, { t: 1, p: 'snare' }, { t: 1, p: 'kick' }], generated: true },
        medium: { hits: [{ t: 1, p: 'kick' }, { t: 1, p: 'hh_closed' }, { t: 1.5, p: 'snare', a: true }, { t: 2, p: 'hh_closed', g: true }], generated: true },
        hard: { hits: [{ t: 1, p: 'kick' }, { t: 2, p: 'snare' }] },
        expert: { hits: [{ t: 0, p: 'kick' }] },          // not a lower level: ignored
    },
};

test('parseDrumTabMeta reads the levels as wire notes, with the generated marker per level', () => {
    const m = tabMeta(LEVELS_TAB);
    assert.deepEqual(Object.keys(m.levels).sort(), ['easy', 'hard', 'medium']);
    assert.deepEqual(m.levels.hard.map(n => [n.t, n.s * 24 + n.f]), [[1, 36], [2, 38]]);
    assert.equal(m.levels.medium[2].ac, true);
    assert.equal(m.levels.medium[3].mt, true);
    assert.deepEqual(m.levelsGenerated, ['easy', 'medium']);
    // a tab with only levels is accepted; odd / empty levels are dropped
    assert.ok(tabMeta({ levels: { easy: { hits: [{ t: 1, p: 'kick' }] } } }).levels.easy);
    assert.equal(tabMeta({ levels: [1, 2] }), null);
    assert.equal(tabMeta({ levels: { easy: 'x', medium: { hits: [] }, hard: { hits: [{ t: 1, p: 'cowbell' }] } } }), null);
    assert.equal(H.parseDrumTabMeta(LEVELS_TAB).levels, null, 'no converter: no levels');
    // the engine decodes a level like the main chart: one chord at t=1 (kick + hat), accent kept
    const dec = E.decodeNotes(m.levels.medium);
    assert.equal(dec.chords[0].notes.length, 2);
    assert.equal(dec.notes.find(n => n.pad === 1).dyn, 'accent');
});

test('hasKick2x / stripKick2x: 2x kick (GM 35) in notes and chords; same arrays when there is none', () => {
    const notes = [w(1, 36), w(1.5, 35), w(2, 38)];
    const chords = [{ t: 3, notes: [{ s: 1, f: 11 }, { s: 1, f: 14 }] }, { t: 4, notes: [{ s: 1, f: 11 }] }, { t: 5, notes: [{ s: 1, f: 12 }] }];
    assert.equal(H.hasKick2x(notes, null), true);
    assert.equal(H.hasKick2x([w(1, 36)], chords), true);
    assert.equal(H.hasKick2x([{ t: 1, midi: 35 }], null), true);
    assert.equal(H.hasKick2x([w(1, 36)], [chords[2]]), false);
    const s = H.stripKick2x(notes, chords);
    assert.deepEqual(s.notes.map(n => n.s * 24 + n.f), [36, 38]);
    assert.equal(s.chords.length, 2, 'a chord of only 2x kicks disappears');
    assert.deepEqual(s.chords[0].notes.map(n => n.s * 24 + n.f), [38]);
    assert.equal(s.chords[1], chords[2], 'untouched chords are kept as they are');
    assert.equal(chords[0].notes.length, 2, 'input not mutated');
    const plain = [w(1, 36)], plainChords = [chords[2]];
    const same = H.stripKick2x(plain, plainChords);
    assert.ok(same.notes === plain && same.chords === plainChords);
});

test('difficultyOptions: Expert always, Expert+ with double kicks, lower levels from the tab', () => {
    const byId = (opts) => Object.fromEntries(opts.map(o => [o.id, o]));
    // pre-1.20.0 tab / legacy chart: no levels
    let o = byId(H.difficultyOptions({ meta: null, has2x: false }));
    assert.deepEqual(H.DIFFICULTIES.filter(id => o[id].available), ['expert']);
    assert.match(o.easy.reason, /only has Expert/);
    assert.match(o.expert_plus.reason, /double-kick/);
    o = byId(H.difficultyOptions({ meta: tabMeta({ star_power: [{ start_time: 1, end_time: 2 }] }), has2x: true }));
    assert.deepEqual(H.DIFFICULTIES.filter(id => o[id].available), ['expert', 'expert_plus']);
    // levels present: available, generated marker
    const meta = tabMeta({ levels: { easy: LEVELS_TAB.levels.easy } });
    o = byId(H.difficultyOptions({ meta, has2x: true }));
    assert.deepEqual([o.easy.available, o.easy.generated, o.easy.label, o.easy.name], [true, true, 'EASY', 'Easy']);
    assert.deepEqual([o.medium.available, o.hard.available], [false, false]);
    assert.match(o.hard.reason, /no Hard part/);
    assert.equal(o.expert.generated, false);
});

test('resolveDifficulty falls back to Expert for unavailable levels without changing the request', () => {
    const opts = H.difficultyOptions({ meta: null, has2x: false });
    assert.deepEqual(H.resolveDifficulty('expert', opts), { id: 'expert', requested: 'expert', fallback: false, reason: '' });
    const r = H.resolveDifficulty('hard', opts);
    assert.deepEqual([r.id, r.requested, r.fallback], ['expert', 'hard', true]);
    assert.match(r.reason, /only has Expert/);
    assert.equal(H.resolveDifficulty('expert_plus', opts).id, 'expert');
    assert.equal(H.resolveDifficulty('expert_plus', H.difficultyOptions({ has2x: true })).id, 'expert_plus');
    // junk / missing preference -> Expert, no fallback flagged
    assert.deepEqual(H.resolveDifficulty('insane', opts), { id: 'expert', requested: 'expert', fallback: false, reason: '' });
    assert.equal(H.resolveDifficulty(undefined, null).id, 'expert');
    assert.equal(H.normalizeDifficulty('easy'), 'easy');
    assert.equal(H.normalizeDifficulty({}), 'expert');
});

test('nextDifficulty steps through the available levels and wraps', () => {
    const all = H.difficultyOptions({ meta: tabMeta(LEVELS_TAB), has2x: true });
    assert.equal(H.nextDifficulty('easy', all, 1), 'medium');
    assert.equal(H.nextDifficulty('expert_plus', all, 1), 'easy');
    assert.equal(H.nextDifficulty('easy', all, -1), 'expert_plus');
    const few = H.difficultyOptions({ meta: null, has2x: false });
    assert.equal(H.nextDifficulty('expert', few, 1), 'expert');
    const two = H.difficultyOptions({ meta: null, has2x: true });
    assert.equal(H.nextDifficulty('expert', two, 1), 'expert_plus');
    assert.equal(H.nextDifficulty('expert_plus', two, 1), 'expert');
    assert.equal(H.nextDifficulty('expert', two, -1), 'expert_plus');
});

test('difficultyLabel / difficultyBadge: HUD text, AUTO marker for generated levels, fallback tooltip', () => {
    assert.equal(H.difficultyLabel('hard'), 'HARD');
    assert.equal(H.difficultyLabel('expert_plus'), 'EXPERT+');
    assert.equal(H.difficultyLabel('easy', true), 'EASY · AUTO');
    const meta = tabMeta(LEVELS_TAB);
    const opts = H.difficultyOptions({ meta, has2x: true });
    let b = H.difficultyBadge(H.resolveDifficulty('medium', opts), opts);
    assert.deepEqual([b.id, b.text, b.sub, b.fallback, b.color], ['medium', 'MEDIUM', 'AUTO', false, H.DIFFICULTY_COLORS.medium]);
    assert.match(b.title, /auto-generated/);
    b = H.difficultyBadge(H.resolveDifficulty('hard', opts), opts);
    assert.deepEqual([b.text, b.sub], ['HARD', null]);
    const none = H.difficultyOptions({ meta: null });
    b = H.difficultyBadge(H.resolveDifficulty('hard', none), none);
    assert.deepEqual([b.id, b.text, b.fallback], ['expert', 'EXPERT', true]);
    assert.match(b.title, /Hard is not available for this song/);
    assert.equal(H.difficultyBadge(null, null).text, 'EXPERT');
});

test('difficultyChart: Expert+ as is, Expert without double kicks, lower levels from the tab', () => {
    const notes = [w(1, 36), w(1, 42), w(1.25, 35), w(1.5, 38)];
    const chords = [];
    const meta = tabMeta(LEVELS_TAB);
    const xp = H.difficultyChart('expert_plus', notes, chords, meta);
    assert.ok(xp.notes === notes && xp.chords === chords && xp.id === 'expert_plus');
    const ex = H.difficultyChart('expert', notes, chords, meta);
    assert.deepEqual(ex.notes.map(n => n.s * 24 + n.f), [36, 42, 38]);
    const plain = [w(1, 36)];
    assert.equal(H.difficultyChart('expert', plain, null, null).notes, plain, 'no 2x kick: the same array');
    const md = H.difficultyChart('medium', notes, chords, meta);
    assert.equal(md.id, 'medium');
    assert.deepEqual(md.notes.map(n => [n.t, n.s * 24 + n.f, !!n.ac, !!n.mt]),
        [[1, 36, false, false], [1, 42, false, false], [1.5, 38, true, false], [2, 42, false, true]]);
    assert.deepEqual(md.chords, []);
    // a level the chart lacks plays Expert
    const fb = H.difficultyChart('hard', notes, chords, null);
    assert.equal(fb.id, 'expert');
    assert.deepEqual(fb.notes.map(n => n.s * 24 + n.f), [36, 42, 38]);
});

test('isDifficultyKey: D harder, Shift+D easier; never a drum key', () => {
    assert.deepEqual(H.isDifficultyKey({ code: 'KeyD', key: 'd' }), { dir: 1 });
    assert.deepEqual(H.isDifficultyKey({ code: 'KeyD', key: 'D', shiftKey: true }), { dir: -1 });
    assert.deepEqual(H.isDifficultyKey({ key: 'd' }), { dir: 1 });
    assert.equal(H.isDifficultyKey({ code: 'KeyD', key: 'd', ctrlKey: true }), null);
    assert.equal(H.isDifficultyKey({ code: 'KeyF', key: 'f' }), null);
    assert.equal(H.isDifficultyKey(null), null);
    for (const code of ['KeyB', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO', 'Enter', 'Space', 'ShiftLeft']) {
        assert.equal(H.isDifficultyKey({ code, key: code }), null, code);
    }
});

test('session: a level chart plays like any chart; switching level mid-song scores from the current time', () => {
    const hit = (t, p) => ({ t, p });
    const meta = tabMeta({ levels: {
        easy: { hits: [hit(1, 'kick'), hit(2, 'snare'), hit(3, 'kick'), hit(4, 'snare')] },
        hard: { hits: [hit(1, 'kick'), hit(1, 'hh_closed'), hit(2, 'snare'), hit(2, 'hh_closed'),
            hit(3, 'kick'), hit(3, 'hh_closed'), hit(4, 'snare'), hit(4, 'hh_closed')] },
    } });
    const s = H.createSession(E, { now: () => 0 });
    s.load({ notes: H.difficultyChart('easy', [], [], meta).notes, chords: [], beats: [] });
    s.setMeta(meta);
    s.update(0);
    for (const g of s.gems.filter(g => g.t < 2.5)) { s.update(g.t); s.hit(g.t, g.pad, { cymbal: g.cymbal }); }
    s.update(2.5);
    assert.equal(s.getState().notesHit, 2);
    // switch to Hard at t=2.5 (what screen.js does: load the other chart, keep the meta)
    s.load({ notes: H.difficultyChart('hard', [], [], meta).notes, chords: [], beats: [] });
    s.setMeta(meta);
    s.update(2.5);
    const st = s.getState();
    assert.equal(st.totalNotes, 4, 'only the Hard notes from 2.5 s on');
    assert.equal(st.notesMissed, 0);
    for (const g of s.gems.filter(g => g.t > 2.5)) { s.update(g.t); s.hit(g.t, g.pad, { cymbal: g.cymbal }); }
    s.update(5);
    assert.deepEqual([s.getState().notesHit, s.getState().notesMissed, s.getState().overhits], [4, 0, 0]);
});

// ── input mapping ─────────────────────────────────────────────────────────

test('midiToPad: Learn/custom mapping wins, otherwise General MIDI', () => {
    const gm = E.padFromMidi;
    assert.deepEqual(H.midiToPad(38, null, gm), { pad: 1, cymbal: false });
    assert.deepEqual(H.midiToPad(42, null, gm), { pad: 2, cymbal: true });
    assert.deepEqual(H.midiToPad(48, null, gm), { pad: 2, cymbal: false });
    assert.deepEqual(H.midiToPad(51, null, gm), { pad: 3, cymbal: true });
    assert.deepEqual(H.midiToPad(49, null, gm), { pad: 4, cymbal: true });
    assert.deepEqual(H.midiToPad(35, null, gm), { pad: 0, cymbal: false });
    assert.equal(H.midiToPad(44, null, gm), null, 'hi-hat pedal is not a hit');
    assert.equal(H.midiToPad(60, null, gm), null);
    const custom = { 60: 'snare', 61: 'crash', 62: 'tom2', 63: 'hihat', 64: 'ride', 65: 'kick', 66: 'tom1', 67: 'tom3',
        38: 'kick', 68: 'not-a-lane' };
    assert.deepEqual(H.midiToPad(60, custom, gm), { pad: 1, cymbal: false });
    assert.deepEqual(H.midiToPad(61, custom, gm), { pad: 4, cymbal: true });
    assert.deepEqual(H.midiToPad(62, custom, gm), { pad: 3, cymbal: false });
    assert.deepEqual(H.midiToPad(63, custom, gm), { pad: 2, cymbal: true });
    assert.deepEqual(H.midiToPad(64, custom, gm), { pad: 3, cymbal: true });
    assert.deepEqual(H.midiToPad(65, custom, gm), { pad: 0, cymbal: false });
    assert.deepEqual(H.midiToPad(66, custom, gm), { pad: 2, cymbal: false });
    assert.deepEqual(H.midiToPad(67, custom, gm), { pad: 4, cymbal: false });
    assert.deepEqual(H.midiToPad(38, custom, gm), { pad: 0, cymbal: false }, 'a remapped GM note follows the custom map');
    assert.equal(H.midiToPad(68, custom, gm), null, 'unknown lane id falls back to GM (68 is unmapped)');
    assert.deepEqual(H.midiToPad(42, custom, gm), { pad: 2, cymbal: true }, 'notes missing from the custom map use GM');
    assert.equal(H.midiToPad(200, null, gm), null);
    assert.equal(H.midiToPad(-1, null, gm), null);
    // a null-prototype map (screen.js _validateCustomMapping output) works too
    const np = Object.assign(Object.create(null), { 70: 'snare' });
    assert.deepEqual(H.midiToPad(70, np, gm), { pad: 1, cymbal: false });
});

test('isTypingTarget: text inputs, textareas, selects and contenteditable', () => {
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'input' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'number' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'range' }), false);
    assert.equal(H.isTypingTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'SELECT' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(H.isTypingTarget({ tagName: 'CANVAS' }), false);
    assert.equal(H.isTypingTarget(null), false);
});

// ── timing ────────────────────────────────────────────────────────────────

test('estimateTime extrapolates between frames only while playing', () => {
    const playing = { time: 10, wall: 1000, prevTime: 9.984, prevWall: 984 };
    assert.ok(Math.abs(H.estimateTime(playing, 1010) - 10.01) < 1e-9);
    assert.ok(Math.abs(H.estimateTime(playing, 1500) - 10.06) < 1e-9, 'capped at 60 ms ahead');
    assert.equal(H.estimateTime(playing, 990), 10, 'never before the frame time');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: 10, prevWall: 984 }, 1010), 10, 'paused');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: 30, prevWall: 984 }, 1010), 10, 'seek back');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: 9, prevWall: 500 }, 1010), 10, 'stalled frames');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: NaN, prevWall: NaN }, 1010), 10);
    assert.ok(Number.isNaN(H.estimateTime({ time: NaN }, 0)));
    // half-speed playback extrapolates at half speed
    const slow = { time: 10, wall: 1000, prevTime: 9.992, prevWall: 984 };
    assert.ok(Math.abs(H.estimateTime(slow, 1020) - 10.01) < 1e-9);
});

test('isSeek flags backward jumps and large forward jumps', () => {
    assert.equal(H.isSeek(10, 10.016), false);
    assert.equal(H.isSeek(10, 11), false);
    assert.equal(H.isSeek(10, 12), true);
    assert.equal(H.isSeek(10, 9.9), false);
    assert.equal(H.isSeek(10, 9.5), true);
    assert.equal(H.isSeek(NaN, 3), false);
    assert.equal(H.isSeek(null, 3), false);
});

// ── HUD ───────────────────────────────────────────────────────────────────

test('formatScore / formatAccuracy', () => {
    assert.equal(H.formatScore(0), '0');
    assert.equal(H.formatScore(999), '999');
    assert.equal(H.formatScore(1000), '1,000');
    assert.equal(H.formatScore(1234567.9), '1,234,567');
    assert.equal(H.formatScore(-5), '0');
    assert.equal(H.formatScore(undefined), '0');
    assert.equal(H.formatAccuracy(1), '100.0%');
    assert.equal(H.formatAccuracy(0.9567), '95.7%');
    assert.equal(H.formatAccuracy(2), '100.0%');
    assert.equal(H.formatAccuracy(NaN), '--');
});

test('multiplierColor: x1..x4 and star power', () => {
    const set = new Set([1, 2, 3, 4].map(m => H.multiplierColor(m, false)));
    assert.equal(set.size, 4);
    assert.equal(H.multiplierColor(8, true), H.multiplierColor(2, true));
    assert.equal(H.multiplierColor(6, false), H.multiplierColor(8, true));
});

test('starProgress: stars earned and progress to the next threshold', () => {
    const th = [100, 200, 400, 800, 1600, 2400];
    assert.deepEqual(H.starProgress({ score: 0, starThresholds: th }), { count: 0, frac: 0, gold: false });
    assert.deepEqual(H.starProgress({ score: 50, starThresholds: th }), { count: 0, frac: 0.5, gold: false });
    assert.deepEqual(H.starProgress({ score: 300, starThresholds: th }), { count: 2, frac: 0.5, gold: false });
    assert.deepEqual(H.starProgress({ score: 2400, starThresholds: th }), { count: 6, frac: 1, gold: true });
    assert.deepEqual(H.starProgress(null), { count: 0, frac: 1, gold: false });
});

test('hudModel turns DrumsEngine.getState() into HUD values', () => {
    const eng = E.create(E.decodeNotes([w(1, 38), w(2, 38)]));
    const m0 = H.hudModel(eng.getState());
    assert.equal(m0.score, '0');
    assert.equal(m0.multiplierText, 'x1');
    assert.equal(m0.streakText, '0');
    assert.equal(m0.accuracy, '100.0%');
    assert.equal(m0.hitsText, '0 / 2');
    assert.equal(m0.spActive, false);
    const st = { score: 12345, combo: 37, multiplier: 8, maxMultiplier: 4, accuracy: 0.5, notesHit: 37, totalNotes: 74,
        starThresholds: [1, 2, 3, 4, 5, 99999], starPower: { amount: 0.625, active: true, canActivate: false } };
    const m = H.hudModel(st);
    assert.equal(m.score, '12,345');
    assert.equal(m.multiplierText, 'x8');
    assert.equal(m.multiplierProgress, 1, 'base x4 is maxed');
    assert.equal(m.multiplierColor, H.multiplierColor(8, true));
    assert.equal(m.spAmount, 0.625);
    assert.equal(m.spActive, true);
    assert.equal(m.stars, 5);
    assert.equal(m.accuracy, '50.0%');
    assert.equal(H.hudModel({ combo: 13, multiplier: 2, maxMultiplier: 4 }).multiplierProgress, 0.3);
    assert.equal(H.hudModel(null).score, '0');
});

// ── session ───────────────────────────────────────────────────────────────

function chart() {
    // 4/4 at 120 BPM: beats every 0.5 s. Snare + kick on every beat from t=1 to t=12.5.
    const notes = [];
    const beats = [];
    for (let i = 0; i < 40; i++) beats.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 + 1 : -1 });
    for (let t = 1; t <= 12.5; t += 0.5) notes.push(w(t, 38), w(t, 36));
    return { notes, chords: [], beats };
}

function playPerfect(s, from, to) {
    for (const g of s.gems) {
        if (g.t < from || g.t > to) continue;
        s.update(g.t);
        s.hit(g.t + 0.005, g.pad, { cymbal: g.cymbal });
    }
    s.update(to);
}

test('session: load builds the engine and render model; perfect play scores and queues hit events', () => {
    let wall = 0;
    const s = H.createSession(E, { now: () => wall });
    s.load(chart());
    assert.equal(s.gems.length, 48);
    assert.equal(s.getState().totalNotes, 48);
    assert.equal(s.beats.length, 40);
    playPerfect(s, 0, 5.2);
    const st = s.getState();
    assert.equal(st.notesHit, 18);
    assert.equal(st.combo, 18);
    assert.equal(st.multiplier, 2);
    const ev = s.drainEvents();
    assert.equal(ev.filter(e => e.type === 'hit').length, 18);
    assert.equal(ev.filter(e => e.type === 'press').length, 18);
    assert.equal(s.drainEvents().length, 0, 'drain empties the queue');
    assert.ok(ev.every(e => e.wall === 0));
});

test('session bonus: perfect timing, snare roll, drum solo bonus and rating', () => {
    let wall = 0;
    const s = H.createSession(E, { now: () => wall });
    // 16 snare notes 0.1 s apart from 1.0 s (the 14 with >= 4 neighbours within 0.25 s form the roll), inside a drum solo 0.9-3.0 s; a kick at 4 s.
    const notes = [];
    for (let i = 0; i < 16; i++) notes.push({ t: 1 + i * 0.1, s: 1, f: 14 });
    notes.push({ t: 4, s: 1, f: 12 });
    const beats = [];
    for (let i = 0; i < 12; i++) beats.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 : -1 });
    s.load({ notes, chords: [], beats });
    s.setMeta(tabMeta({ solos: [{ start_time: 0.9, end_time: 3.0 }] }));
    playPerfect(s, 0, 3.5);
    const b = s.getBonus();
    assert.equal(b.perfect, 16, 'every hit within 25 ms');
    assert.ok(b.rolls > 0, 'roll bonus');
    assert.equal(b.solos.length, 1);
    assert.equal(b.solos[0].rating, 'PERFECT SOLO!');
    assert.equal(b.solos[0].bonus, 16 * 100 * 2);
    assert.equal(b.total, b.timing + b.rolls + b.solo);
    const ev = s.drainEvents();
    assert.ok(ev.some(e => e.type === 'solo-end'));
    assert.ok(ev.some(e => e.type === 'bonus-pop' && /^ROLL 14\/14 /.test(e.text)));
    // a seek rebuilds the engine: score and bonuses start over
    s.update(0.2);
    assert.equal(s.getBonus().total, 0);
});

test('session: misses and overhits queue events for the view', () => {
    const s = H.createSession(E);
    s.load(chart());
    s.update(1); s.hit(1, 1); s.hit(1, 0);   // hit both notes at t=1
    s.update(1.4); s.hit(1.4, 3);            // blue overhit
    s.update(2);                             // t=1.5 notes missed
    const types = s.drainEvents().map(e => e.type + (e.pad != null ? ':' + e.pad : ''));
    assert.ok(types.includes('overhit:3'));
    assert.ok(types.includes('miss:1') && types.includes('miss:0'));
    assert.ok(types.includes('combo-break'));
});

test('session: a backward seek rebuilds the engine from the new position', () => {
    const s = H.createSession(E);
    s.load(chart());
    playPerfect(s, 0, 6);
    const before = s.builds;
    assert.ok(s.getState().score > 0);
    s.update(3);                             // seek back
    assert.equal(s.builds, before + 1);
    const st = s.getState();
    assert.equal(st.score, 0);
    assert.equal(st.totalNotes, 40, 'notes before the seek point are left out');
    playPerfect(s, 3, 4);
    assert.equal(s.getState().notesHit, 6);
    s.update(4.016);
    assert.equal(s.builds, before + 1, 'normal playback does not rebuild');
    s.update(9);                             // big forward jump
    assert.equal(s.builds, before + 2);
    assert.equal(s.getState().notesMissed, 0, 'skipped notes are not counted as misses');
});

test('session: a chart loaded mid-song scores from the first frame, not from the song start', () => {
    const s = H.createSession(E);
    s.load(chart());
    s.update(6.2);
    const st = s.getState();
    assert.equal(st.notesMissed, 0);
    assert.equal(st.totalNotes, 26);
    const s2 = H.createSession(E);
    s2.load(chart());
    s2.update(0);                            // normal start: nothing rebuilt
    assert.equal(s2.builds, 1);
    assert.equal(s2.getState().totalNotes, 48);
});

test('session: setMeta applies star power phrases and drum fills (activation by the fill-end note)', () => {
    const s = H.createSession(E);
    s.load(chart());
    // phrases: two 2-beat phrases -> half a bar; fill ending at t=8 activates star power
    s.setMeta(tabMeta({ star_power: [{ start_time: 1, end_time: 2 }, { start_time: 3, end_time: 4 }],
        fills: [{ start_time: 7, end_time: 8 }] }));
    assert.ok(s.engine.isStarPowerNote(s.gems[0].id));
    playPerfect(s, 0, 7.9);
    let st = s.getState();
    assert.equal(st.starPower.phrasesHit, 2);
    assert.equal(st.starPower.canActivate, true);
    assert.equal(s.activate(7.9), false, 'fills disable manual activation');
    const ev1 = s.drainEvents();
    assert.ok(ev1.some(e => e.type === 'hit' && e.sp));
    assert.ok(ev1.some(e => e.type === 'sp-phrase'));
    assert.ok(ev1.some(e => e.type === 'sp-ready'));
    playPerfect(s, 7.95, 8.2);
    st = s.getState();
    assert.equal(st.starPower.active, true);
    assert.ok(s.drainEvents().some(e => e.type === 'sp-activate'));
    assert.equal(st.multiplier, 8, 'x4 doubled by star power');
});

test('session: without gameplay metadata there is no star power and manual activation is allowed', () => {
    const s = H.createSession(E);
    s.load(chart());
    s.setMeta(null);
    assert.equal(s.getState().starPower.phrasesTotal, 0);
    assert.equal(s.engine.manualActivation, true);
    assert.equal(s.activate(1), false, 'empty bar');
});

test('session: setMeta mid-song rebuilds from the current time; hits during a seek are ignored', () => {
    const s = H.createSession(E);
    s.load(chart());
    playPerfect(s, 0, 4.2);
    const b = s.builds;
    s.setMeta(tabMeta({ star_power: [{ start_time: 6, end_time: 7 }] }));
    assert.equal(s.builds, b + 1);
    assert.equal(s.getState().totalNotes, 34);
    assert.equal(s.getState().starPower.phrasesTotal, 1);
    assert.deepEqual(s.hit(1, 1), { type: 'ignored', reason: 'seek' });
    assert.deepEqual(H.createSession(E).hit(1, 1), { type: 'ignored', reason: 'no-chart' });
});

// ── non-pro drums ("Pro cymbals" off) ──────────────────────────────────────

test('classifyNote / buildGems with pro:false draw cymbals as pads and merge a same-colour tom+cymbal', () => {
    assert.equal(H.classifyNote({ pad: 2, cymbal: true }, { pro: false }).kind, 'pad');
    assert.equal(H.classifyNote({ pad: 2, cymbal: true }, { pro: false }).cymbal, false);
    // yellow tom (48) + hi-hat (42) together, then a ride (51) alone
    const decoded = E.decodeNotes([w(1, 48), w(1, 42), w(2, 51)], { kick2x: true });
    const pro = H.buildGems(decoded);
    assert.deepEqual(pro.map(g => g.kind), ['pad', 'cymbal', 'cymbal']);
    const plain = H.buildGems(decoded, { pro: false });
    assert.deepEqual(plain.map(g => [g.t, g.kind, g.lane]), [[1, 'pad', 1], [2, 'pad', 2]]);
});

test('session: setProDrums(false) lets a cymbal input hit a tom note and redraws without cymbals', () => {
    const notes = [w(1, 48), w(2, 51)];         // yellow tom, blue cymbal (ride)
    const pro = H.createSession(E).load({ notes });
    pro.update(1); const r1 = pro.hit(1, 2, { cymbal: true });   // hi-hat on a yellow tom note
    assert.notEqual(r1.type, 'hit', 'pro drums: wrong pad type');
    assert.equal(pro.proDrums, true);

    const s = H.createSession(E, { proDrums: false }).load({ notes });
    assert.equal(s.proDrums, false);
    assert.ok(s.gems.every(g => g.kind === 'pad'));
    s.update(1); assert.equal(s.hit(1, 2, { cymbal: true }).type, 'hit');
    s.update(2); assert.equal(s.hit(2, 3).type, 'hit', 'blue tom pad hits the (non-pro) ride note');
    assert.equal(s.getState().notesHit, 2);

    // switching mid-song rebuilds from the current position, and back again
    const m = H.createSession(E).load({ notes });
    m.update(1.5);
    m.setProDrums(false);
    assert.ok(m.gems.every(g => g.kind === 'pad'));
    m.update(2); assert.equal(m.hit(2, 3).type, 'hit');
    m.setProDrums(true);
    assert.equal(m.gems.filter(g => g.kind === 'cymbal').length, 1);
});

test('session: a chart marked non-pro stays non-pro even with Pro cymbals on', () => {
    const s = H.createSession(E).load({ notes: [w(1, 42)] });
    s.setMeta({ pro: false, starPower: [], activation: [], solos: [], levels: null, levelsGenerated: [] });
    assert.equal(s.proDrums, false);
    assert.equal(s.gems[0].kind, 'pad');
});

// ── auto kick / auto cymbals ───────────────────────────────────────────────

test('autoAppliesAt / autoFor: each setting is a difficulty ceiling', () => {
    assert.equal(H.autoAppliesAt('off', 'easy'), false);
    assert.equal(H.autoAppliesAt('all', 'expert_plus'), true);
    assert.equal(H.autoAppliesAt('easy', 'easy'), true);
    assert.equal(H.autoAppliesAt('easy', 'medium'), false);
    assert.equal(H.autoAppliesAt('hard', 'medium'), true);
    assert.equal(H.autoAppliesAt('hard', 'expert'), false);
    assert.equal(H.autoAppliesAt('bogus', 'easy'), false);
    assert.deepEqual(H.autoFor({ kick: 'medium', cymbals: 'off' }, 'easy'), { kick: true, cymbals: false });
    assert.deepEqual(H.autoFor(null, 'easy'), { kick: false, cymbals: false });
});

test('isAutoNote: kick by pad, cymbals by the chart marking (never red)', () => {
    const a = { kick: true, cymbals: true };
    assert.equal(H.isAutoNote(H.PAD.KICK, false, a), true);
    assert.equal(H.isAutoNote(H.PAD.YELLOW, true, a), true);
    assert.equal(H.isAutoNote(H.PAD.YELLOW, false, a), false);
    assert.equal(H.isAutoNote(H.PAD.RED, true, a), false);
    assert.equal(H.isAutoNote(H.PAD.KICK, false, { kick: false, cymbals: true }), false);
    assert.equal(H.isAutoNote(H.PAD.KICK, false, null), false);
});

test('session: auto kick leaves kicks out of scoring, ignores kick input and flashes them as played', () => {
    // kick+hi-hat, snare, kick+hi-hat
    const notes = [w(1, 36), w(1, 42), w(2, 38), w(3, 36), w(3, 42)];
    const s = H.createSession(E, { auto: { kick: true } }).load({ notes });
    assert.equal(s.getState().totalNotes, 3, 'kicks are not scored');
    assert.equal(s.gems.filter(g => g.auto).length, 2, 'kicks are still drawn, marked auto');
    assert.deepEqual(s.auto, { kick: true, cymbals: false });
    s.update(0.5); s.drainEvents();
    s.update(1);
    const ev = s.drainEvents();
    assert.ok(ev.some(e => e.type === 'hit' && e.auto && e.pad === H.PAD.KICK), 'kick flashes at the strikeline');
    assert.equal(s.hit(1, H.PAD.KICK).reason, 'auto', 'kick pedal is ignored');
    assert.equal(s.hit(1, H.PAD.YELLOW, { cymbal: true }).type, 'hit');
    s.update(2); assert.equal(s.hit(2, H.PAD.RED).type, 'hit');
    s.update(3); assert.equal(s.hit(3, H.PAD.YELLOW, { cymbal: true }).type, 'hit');
    s.update(4);
    const st = s.getState();
    assert.equal(st.notesHit, 3);
    assert.equal(st.notesMissed, 0);
    assert.equal(st.overhits, 0);
});

test('session: auto cymbals; setAuto mid-song rescoring from the current time', () => {
    const notes = [w(1, 42), w(1, 38), w(2, 49), w(2, 36), w(3, 51), w(3, 38)];
    const s = H.createSession(E).load({ notes });
    assert.equal(s.getState().totalNotes, 6);
    s.update(1.5);
    s.setAuto({ cymbals: true });
    assert.equal(s.gems.filter(g => g.auto).length, 3);
    assert.equal(s.hit(2, H.PAD.GREEN, { cymbal: true }).reason, 'auto', 'cymbal pads are ignored');
    s.update(2); assert.equal(s.hit(2, H.PAD.KICK).type, 'hit');
    s.update(3); assert.equal(s.hit(3, H.PAD.RED).type, 'hit');
    s.update(4);
    assert.equal(s.getState().notesMissed, 0, 'the auto ride is not missed');
    // unchanged setting -> no rebuild
    const b = s.builds;
    s.setAuto({ cymbals: true, kick: false });
    assert.equal(s.builds, b);
});

test('session: setParams widens the hit window', () => {
    const notes = [w(1, 38)];
    const n = H.createSession(E).load({ notes });
    n.update(0.5); n.update(1.09); assert.notEqual(n.hit(1.09, H.PAD.RED).type, 'hit', 'normal window is +-70 ms');
    const r = H.createSession(E, { params: { hitWindow: { maxWindow: 0.26, minWindow: 0.26 } } }).load({ notes });
    r.update(0.5); r.update(1.09); assert.equal(r.hit(1.09, H.PAD.RED).type, 'hit', 'relaxed window is +-130 ms');
    const m = H.createSession(E).load({ notes });
    m.update(0.5);
    m.setParams({ hitWindow: { maxWindow: 0.26, minWindow: 0.26 } });
    m.update(1.09); assert.equal(m.hit(1.09, H.PAD.RED).type, 'hit');
});

// ── hit timing: input offset, engine grace, timing meter, frame clock ─────

test('session: a positive input offset delays the engine too, so a late-registered hit still counts', () => {
    // Note at t=1.0. The player's hits register 200 ms late (input offset +200 ms):
    // the pad is struck on the beat but the hit arrives at highway time 1.2.
    const s = H.createSession(E, { inputOffsetMs: 200 });
    s.load({ notes: [w(1, 38)], chords: [], beats: [] });
    s.update(0.9);
    s.update(1.25);            // the frame drawn before the late hit arrives
    const r = s.hit(1.2, H.PAD.RED);
    assert.equal(r.type, 'hit', 'the engine has not moved past the note yet');
    assert.ok(Math.abs(r.offset) < 0.001, 'judged on time once the offset is applied');
    s.update(2);
    assert.equal(s.getState().notesMissed, 0);
    assert.equal(s.inputOffsetMs, 200);

    // An engine advanced on the raw frame time (the old behaviour: offset 0 for the frame
    // clock) has already missed the note when the same late hit arrives.
    const s0 = H.createSession(E);
    s0.load({ notes: [w(1, 38)], chords: [], beats: [] });
    s0.update(0.9); s0.update(1.25);
    assert.notEqual(s0.hit(1.2 - 0.2, H.PAD.RED).type, 'hit');
    assert.equal(s0.getState().notesMissed, 1);
});

test('session: setInputOffset applies to later frames and hits, and restarts the timing meter', () => {
    const s = H.createSession(E);
    s.load({ notes: [w(1, 38), w(2, 38)], chords: [], beats: [] });
    s.update(0.95); s.hit(1.03, H.PAD.RED);   // 30 ms late
    assert.deepEqual(s.getBonus().offsets, [30]);
    s.setInputOffset(30);
    assert.deepEqual(s.getBonus().offsets, [], 'samples measured with the old offset are dropped');
    s.update(1.95); s.hit(2.03, H.PAD.RED);
    assert.deepEqual(s.getBonus().offsets, [0]);
    s.setInputOffset('junk');
    assert.equal(s.inputOffsetMs, 0);
    s.setInputOffset(999);
    assert.equal(s.inputOffsetMs, 250, 'clamped like the settings field');
});

test('session: a hit timestamped before the latest frame keeps its own time (not moved to the frame)', () => {
    const s = H.createSession(E);
    s.load({ notes: [w(1, 38)], chords: [], beats: [] });
    const seen = [];
    s.setOnHit((h) => seen.push(h));
    s.update(0.9);
    s.update(1.016);           // the frame after the note at t=1 was drawn...
    s.hit(1.004, H.PAD.RED);   // ...then a hit struck at 1.004 arrives (MIDI timestamp)
    assert.equal(seen.length, 1);
    assert.ok(Math.abs(seen[0].time - 1.004) < 1e-9, 'judged at the strike, not at the frame time 1.016');
    assert.equal(seen[0].noteTime, 1);
    s.update(1.5);
    assert.equal(s.getState().notesHit, 1);
    // misses are still found, INPUT_GRACE later
    const m = H.createSession(E);
    m.load({ notes: [w(1, 38)], chords: [], beats: [] });
    m.update(0.9); m.update(1.08);
    assert.equal(m.getState().notesMissed, 0, 'still inside the window + grace');
    m.update(1.2);
    assert.equal(m.getState().notesMissed, 1);
});

test('session: MIDI velocity normalised to 0..1 decides the dynamics bonus (soft hit on an accent gets none)', () => {
    const play = (vel) => {
        const s = H.createSession(E);
        s.load({ notes: [w(1, 38, { ac: true })], chords: [], beats: [] });
        s.update(0.95);
        const r = s.hit(1.0, H.PAD.RED, { velocity: vel });
        s.update(1.5);
        return { r, st: s.getState() };
    };
    const soft = play(1 / 127);   // screen.js passes velocity / 127
    assert.equal(soft.r.type, 'hit');
    assert.equal(soft.r.bonus, false, 'velocity 1 is the softest hit, not full strength');
    const hard = play(127 / 127);
    assert.equal(hard.r.bonus, true);
    assert.ok(hard.st.score > soft.st.score);
});

test('session: activate() uses the input offset and works on a chart without fills', () => {
    const s = H.createSession(E, { inputOffsetMs: 40 });
    s.load(chart());
    s.setMeta(tabMeta({ star_power: [{ start_time: 1, end_time: 2 }, { start_time: 3, end_time: 4 }] }));
    playPerfect(s, 0, 5);
    const st = s.getState();
    assert.equal(st.starPower.canActivate, true);
    assert.equal(s.engine.manualActivation, true, 'no fills: manual activation');
    assert.equal(H.starPowerHint(s.meta, st, 'hi-hat pedal'), 'Press Enter or hit hi-hat pedal to activate star power');
    assert.equal(s.activate(5.05), true);
    assert.equal(s.getState().starPower.active, true);
    assert.equal(H.starPowerHint(s.meta, s.getState(), ''), null, 'no hint while active');
    assert.equal(s.activate(NaN), false);
});

test('starPowerHint: fills say how they activate; nothing while not ready', () => {
    const ready = { starPower: { canActivate: true, active: false } };
    assert.equal(H.starPowerHint({ activation: [{ start: 1, end: 2 }] }, ready, ''), 'Hit the note at the end of the fill to activate');
    assert.equal(H.starPowerHint(null, ready, ''), 'Press Enter to activate star power');
    assert.equal(H.starPowerHint(null, { starPower: { canActivate: false } }, ''), null);
    assert.equal(H.starPowerHint(null, null, ''), null);
});

test('timingSummary: median, early / late label and the suggested input offset', () => {
    assert.deepEqual(H.timingSummary([], 0), { count: 0, median: null, state: 'waiting', label: 'waiting for hits', suggest: null, current: 0 });
    const late = H.timingSummary([20, 25, 30, 28, 22, 35, 400], 10);
    assert.equal(late.median, 28);
    assert.equal(late.state, 'late');
    assert.equal(late.label, '+28 ms LATE');
    assert.equal(late.suggest, 38, 'current offset + median');
    const early = H.timingSummary([-30, -30, -30, -30, -30, -30], 0);
    assert.equal(early.label, '-30 ms EARLY');
    assert.equal(early.suggest, -30);
    const ok = H.timingSummary([4, -3, 5, -6, 2, 0], 12);
    assert.equal(ok.state, 'ok');
    assert.equal(ok.label, 'ON TIME');
    assert.equal(ok.suggest, null);
    assert.equal(H.timingSummary([40, 40, 40], 0).suggest, null, 'needs 6 hits before suggesting');
    assert.equal(H.timingSummary([200, 200, 200, 200, 200, 200], 200).suggest, 250, 'clamped to the field range');
});

test('session: the timing meter keeps the last 24 hits and survives a seek', () => {
    const s = H.createSession(E);
    const notes = [];
    for (let i = 0; i < 30; i++) notes.push(w(1 + i * 0.5, 38));
    s.load({ notes, chords: [], beats: [] });
    for (const n of notes) { s.update(n.t - 0.01); s.hit(n.t + 0.012, H.PAD.RED); }
    const offs = s.getBonus().offsets;
    assert.equal(offs.length, H.TIMING_SAMPLES);
    assert.ok(offs.every(v => v === 12));
    s.update(2);   // seek back: the score restarts, the timing samples stay
    assert.equal(s.getBonus().total, 0);
    assert.equal(s.getBonus().offsets.length, H.TIMING_SAMPLES);
    s.resetTiming();
    assert.deepEqual(s.getBonus().offsets, []);
});

test('createFrameClock: interpolates between audio samples, holds while paused, times past input', () => {
    const c = H.createFrameClock();
    assert.ok(Number.isNaN(c.at(0)));
    assert.equal(c.tick(10, true, 1000), 10);
    assert.equal(c.tick(10.02, true, 1020), 10.02);           // new sample: rate 1
    assert.ok(Math.abs(c.tick(10.02, true, 1030) - 10.03) < 1e-9, 'same sample: interpolated');
    assert.ok(Math.abs(c.at(1025) - 10.025) < 1e-9, 'a hit between frames');
    assert.ok(Math.abs(c.at(1010) - 10.01) < 1e-9, 'a hit timestamped before the last sample');
    assert.ok(Math.abs(c.at(1500) - 10.12) < 1e-9, 'capped 100 ms ahead');
    // paused (core's bundle.isPlaying false): no interpolation
    assert.equal(c.tick(10.5, false, 2000), 10.5);
    assert.equal(c.tick(10.5, false, 2050), 10.5);
    assert.equal(c.at(2060), 10.5);
    // older hosts (isPlaying undefined): a stalled sample stops interpolating after 100 ms
    const d = H.createFrameClock();
    d.tick(5, undefined, 0); d.tick(5.016, undefined, 16);
    assert.ok(d.tick(5.016, undefined, 30) > 5.016);
    assert.equal(d.tick(5.016, undefined, 200), 5.016);
    assert.equal(d.at(210), 5.016);
    // half speed: the rate is measured
    const e = H.createFrameClock();
    e.tick(1, true, 0); e.tick(1.01, true, 20);
    assert.ok(Math.abs(e.tick(1.01, true, 30) - 1.015) < 1e-9);
    c.reset();
    assert.ok(Number.isNaN(c.at(0)));
});
