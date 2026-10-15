'use strict';
// Tests for engine.js (the LGPL-3.0 port of YARG.Core's drums engine).
// Some scenarios are ported from YARG.Core.UnitTests/Engine/DrumEngineTester.cs and DrumsStatsTests.cs.
// Copyright (c) YARC (YARG) contributors
// Licensed under the GNU Lesser General Public License v3.0
// (see https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE and ../LICENSE.LGPL-3.0).
// Ported and modified to JavaScript (node:test) for the feedBack drums plugin.
// Run: node tests/engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ENGINE_PATH = path.join(__dirname, '..', 'assets', 'engine.js');
const D = require(ENGINE_PATH);
const { PAD } = D;

const KICK = 36, SNARE = 38, HAT = 42, CRASH = 49, RIDE = 51, HI_TOM = 48, LOW_TOM = 45, FLOOR_TOM = 41;

function w(t, midi, extra) {
    return Object.assign({ t, s: (midi / 24) | 0, f: midi % 24 }, extra || {});
}
// N single snare notes starting at `start`, `gap` seconds apart.
function snares(n, start = 1, gap = 0.5) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(w(start + i * gap, SNARE));
    return out;
}
function engineFor(wire, opts) {
    return D.create(D.decodeNotes(wire, opts && opts.decode), opts);
}
function collect(eng, names) {
    const log = [];
    for (const n of names) eng.on(n, (p) => log.push([n, p]));
    return log;
}
// Hit every note of the chart on time.
function playAll(eng) {
    for (const c of eng.chords) for (const n of c.notes) eng.hit(c.t, n.pad, { cymbal: n.cymbal });
}

// ── decodeNotes / padFromMidi ──────────────────────────────────────────────

test('decodeNotes maps every General MIDI drum number to pad + cymbal', () => {
    const expected = {
        36: [PAD.KICK, false], 35: [PAD.KICK, false],
        38: [PAD.RED, false], 37: [PAD.RED, false], 40: [PAD.RED, false],
        42: [PAD.YELLOW, true], 46: [PAD.YELLOW, true],
        48: [PAD.YELLOW, false], 50: [PAD.YELLOW, false],
        45: [PAD.BLUE, false], 47: [PAD.BLUE, false],
        41: [PAD.GREEN, false], 43: [PAD.GREEN, false], 58: [PAD.GREEN, false],
        51: [PAD.BLUE, true], 53: [PAD.BLUE, true], 59: [PAD.BLUE, true],
        49: [PAD.GREEN, true], 57: [PAD.GREEN, true], 55: [PAD.GREEN, true], 52: [PAD.GREEN, true],
    };
    const midis = Object.keys(expected).map(Number);
    const chart = D.decodeNotes(midis.map((m, i) => w(i, m)));
    assert.equal(chart.notes.length, midis.length);
    for (const n of chart.notes) {
        assert.deepEqual([n.pad, n.cymbal], expected[n.midi], 'midi ' + n.midi);
        assert.equal(n.kick2x, n.midi === 35);
        const live = D.padFromMidi(n.midi);
        assert.deepEqual([live.pad, live.cymbal], expected[n.midi]);
    }
    // unknown numbers are dropped
    assert.equal(D.decodeNotes([w(0, 60), w(1, 39)]).notes.length, 0);
    assert.equal(D.padFromMidi(60), null);
});

test('decodeNotes: 44 hi-hat pedal dropped unless includeHatPedal', () => {
    assert.equal(D.decodeNotes([w(0, 44)]).notes.length, 0);
    const on = D.decodeNotes([w(0, 44)], { includeHatPedal: true });
    assert.equal(on.notes.length, 1);
    assert.deepEqual([on.notes[0].pad, on.notes[0].cymbal], [PAD.YELLOW, true]);
    assert.equal(D.padFromMidi(44), null);
    assert.deepEqual(D.padFromMidi(44, { includeHatPedal: true }), { pad: PAD.YELLOW, cymbal: true });
});

test('decodeNotes: kick 2x (35) kept by default, dropped with kick2x:false', () => {
    const wire = [w(0, KICK), w(0.5, 35)];
    assert.equal(D.decodeNotes(wire).notes.length, 2);
    const off = D.decodeNotes(wire, { kick2x: false });
    assert.equal(off.notes.length, 1);
    assert.equal(off.notes[0].midi, 36);
});

test('decodeNotes: accent / ghost dynamics', () => {
    const c = D.decodeNotes([w(0, SNARE, { ac: true }), w(1, SNARE, { mt: true }), w(2, SNARE)]);
    assert.deepEqual(c.notes.map(n => n.dyn), ['accent', 'ghost', null]);
});

test('decodeNotes: sorts by time, groups notes within 1ms into chords, assigns ids', () => {
    const c = D.decodeNotes([w(2, SNARE), w(1.0005, CRASH), w(1, KICK), w(1.01, HAT), w(1, KICK)]);
    assert.deepEqual(c.notes.map(n => n.t), [1, 1.0005, 1.01, 2]); // duplicate kick in chord dropped
    assert.deepEqual(c.notes.map(n => n.id), [0, 1, 2, 3]);
    assert.equal(c.chords.length, 3);
    assert.deepEqual(c.chords[0].notes.map(n => n.midi), [KICK, CRASH]);
    assert.equal(c.chords[0].t, 1);
    assert.deepEqual(c.notes.map(n => n.chord), [0, 0, 1, 2]);
    // tolerates junk
    assert.deepEqual(D.decodeNotes(null), { notes: [], chords: [] });
    assert.equal(D.decodeNotes([null, { t: 'x', s: 1, f: 14 }, w(0, SNARE)]).notes.length, 1);
});

// ── Hit window / matching ────────────────────────────────────────────────

test('defaultParams are YARG EnginePreset.Default drums values', () => {
    const p = D.defaultParams();
    assert.equal(p.hitWindow.maxWindow, 0.14);
    assert.equal(p.hitWindow.minWindow, 0.14);
    assert.equal(p.hitWindow.isDynamic, false);
    assert.equal(p.hitWindow.frontToBackRatio, 1.0);
    assert.equal(p.maxMultiplier, 4);
    assert.equal(p.velocityThreshold, 0.35);
    assert.equal(p.situationalVelocityWindow, 1.5);
    assert.equal(p.starPowerMeasures, 8);
    assert.deepEqual(p.starMultiplierThresholds, [0.06, 0.12, 0.2, 0.45, 0.75, 1.09]);
    const eng = engineFor(snares(1));
    const hw = eng.hitWindow();
    assert.ok(Math.abs(hw.front + 0.07) < 1e-12 && Math.abs(hw.back - 0.07) < 1e-12);
});

test('on-time hit scores 60 (pro), records offset and noteState', () => {
    const eng = engineFor(snares(1));
    const r = eng.hit(1, PAD.RED);
    assert.equal(r.type, 'hit');
    assert.equal(r.id, 0);
    assert.equal(r.offset, 0);
    const s = eng.getState();
    assert.equal(s.score, 60);
    assert.equal(s.combo, 1);
    assert.equal(s.notesHit, 1);
    assert.equal(eng.noteState(0), 'hit');
    assert.equal(eng.noteInfo(0).offset, 0);
});

test('early/late hits inside the 70ms window hit; outside do not', () => {
    for (const dt of [-0.069, 0.069, -0.07, 0.07]) {
        const eng = engineFor(snares(2, 1, 1));
        const r = eng.hit(1 + dt, PAD.RED);
        assert.equal(r.type, 'hit', 'offset ' + dt);
        assert.ok(Math.abs(r.offset - dt) < 1e-9);
    }
    // too early: nothing in window; before first note so overhit is suppressed (YARG Overhit: NoteIndex == 0)
    let eng = engineFor(snares(2, 1, 1));
    assert.deepEqual(eng.hit(1 - 0.071, PAD.RED), { type: 'ignored', reason: 'before-first-note' });
    assert.equal(eng.noteState(0), null);
    // too late: the note is missed first, then the hit becomes an overhit
    eng = engineFor([w(0.5, KICK), ...snares(2, 1, 1)]);
    eng.hit(0.5, PAD.KICK);
    assert.equal(eng.hit(1.071, PAD.RED).type, 'overhit');
    assert.equal(eng.noteState(1), 'miss');
    assert.equal(eng.getState().overhits, 1);
});

test('update() registers misses for notes past the back of the window', () => {
    const eng = engineFor(snares(3, 1, 1));
    const log = collect(eng, ['miss']);
    eng.update(1.07);
    assert.equal(eng.noteState(0), null); // exactly at back end is still hittable
    eng.update(1.0701);
    assert.equal(eng.noteState(0), 'miss');
    eng.update(10);
    assert.equal(log.length, 3);
    assert.equal(eng.getState().notesMissed, 3);
});

test('wrong pad inside the window = overhit (combo break, no score change)', () => {
    const eng = engineFor(snares(5, 1, 0.5));
    eng.hit(1, PAD.RED);
    eng.hit(1.5, PAD.RED);
    const log = collect(eng, ['overhit', 'combo-break']);
    const before = eng.getState().score;
    assert.equal(eng.hit(2, PAD.BLUE).type, 'overhit');
    const s = eng.getState();
    assert.equal(s.overhits, 1);
    assert.equal(s.combo, 0);
    assert.equal(s.score, before);
    assert.equal(eng.noteState(2), null); // note still hittable
    assert.equal(eng.hit(2.01, PAD.RED).type, 'hit');
    // YARG order: ResetCombo runs before OnOverhit
    assert.deepEqual(log.map(x => x[0]), ['combo-break', 'overhit']);
    assert.equal(log[0][1].reason, 'overhit');
    assert.equal(log[0][1].combo, 2);
});

test('pro drums: cymbal hit on a tom note (and tom on cymbal) is an overhit', () => {
    const wire = [w(0.5, KICK), w(1, HI_TOM), w(2, HAT), w(3, LOW_TOM), w(4, RIDE), w(5, FLOOR_TOM), w(6, CRASH)];
    const eng = engineFor(wire);
    eng.hit(0.5, PAD.KICK);
    assert.equal(eng.hit(1, PAD.YELLOW, { cymbal: true }).type, 'overhit');
    assert.equal(eng.hit(1.01, PAD.YELLOW).type, 'hit');
    assert.equal(eng.hit(2, PAD.YELLOW, { cymbal: false }).type, 'overhit');
    assert.equal(eng.hit(2.01, PAD.YELLOW, { cymbal: true }).type, 'hit');
    assert.equal(eng.hit(3, PAD.BLUE, { cymbal: true }).type, 'overhit');
    assert.equal(eng.hit(4, PAD.BLUE).type, 'overhit');
    assert.equal(eng.hit(5, PAD.GREEN, { cymbal: true }).type, 'overhit');
    assert.equal(eng.hit(6, PAD.GREEN).type, 'overhit');
    assert.equal(eng.getState().overhits, 6);
});

test('proDrums:false ignores the cymbal/tom distinction and scores 50 per note', () => {
    const wire = [w(1, HI_TOM), w(2, HAT), w(3, RIDE), w(4, CRASH)];
    const eng = engineFor(wire, { proDrums: false });
    assert.equal(eng.hit(1, PAD.YELLOW, { cymbal: true }).type, 'hit');
    assert.equal(eng.hit(2, PAD.YELLOW, { cymbal: false }).type, 'hit');
    assert.equal(eng.hit(3, PAD.BLUE).type, 'hit');
    assert.equal(eng.hit(4, PAD.GREEN, { cymbal: true }).type, 'hit');
    assert.equal(eng.getState().score, 200);
    assert.equal(eng.getState().overhits, 0);
});

test('proDrums:false collapses yellow tom + hat in one chord; dropped id aliases the kept note', () => {
    const chart = D.decodeNotes([w(1, HI_TOM), w(1, HAT)]);
    assert.equal(chart.notes.length, 2);
    const eng = D.create(chart, { proDrums: false });
    assert.equal(eng.getState().totalNotes, 1);
    eng.hit(1, PAD.YELLOW);
    assert.equal(eng.noteState(0), 'hit');
    assert.equal(eng.noteState(1), 'hit');
    assert.equal(eng.noteState(99), null);
});

test('chords: each note hit separately, partial chord -> unhit notes miss, combo per note', () => {
    const wire = [w(1, KICK), w(1, SNARE), w(1, CRASH), w(2, KICK), w(2, HAT)];
    const eng = engineFor(wire);
    assert.equal(eng.hit(1, PAD.KICK).type, 'hit');
    assert.equal(eng.hit(1.005, PAD.GREEN, { cymbal: true }).type, 'hit');
    assert.equal(eng.getState().combo, 2);
    // hitting the same pad again on the partially-hit chord is consumed (no overhit)
    assert.deepEqual(eng.hit(1.01, PAD.KICK).type, 'ignored');
    assert.equal(eng.getState().overhits, 0);
    eng.update(1.5);
    assert.equal(eng.noteState(1), 'miss');
    assert.equal(eng.getState().combo, 0);
    eng.hit(2, PAD.YELLOW, { cymbal: true });
    eng.hit(2, PAD.KICK);
    const s = eng.getState();
    assert.equal(s.notesHit, 4);
    assert.equal(s.notesMissed, 1);
    assert.equal(s.combo, 2);
    assert.equal(s.score, 4 * 60);
});

test('hitting a later chord inside the window skips (misses) unhit earlier notes', () => {
    const eng = engineFor([w(1, SNARE), w(1.04, KICK)]);
    assert.equal(eng.hit(1.03, PAD.KICK).type, 'hit');
    assert.equal(eng.noteState(0), 'miss');
    assert.equal(eng.noteState(1), 'hit');
    assert.equal(eng.getState().combo, 1);
});

test('one input hits only the oldest matching note in the window', () => {
    const eng = engineFor([w(1, SNARE), w(1.05, SNARE)]);
    eng.hit(1.02, PAD.RED);
    assert.equal(eng.noteState(0), 'hit');
    assert.equal(eng.noteState(1), null);
});

// ── Combo / multiplier / score ───────────────────────────────────────────

test('combo -> multiplier: +1x every 10 notes up to 4x; score totals', () => {
    const eng = engineFor(snares(40));
    const mults = [];
    eng.on('multiplier', (p) => mults.push([eng.getState().combo, p.multiplier]));
    for (let i = 0; i < 40; i++) eng.hit(1 + i * 0.5, PAD.RED);
    assert.deepEqual(mults, [[10, 2], [20, 3], [30, 4]]);
    const s = eng.getState();
    assert.equal(s.multiplier, 4);
    assert.equal(s.maxMultiplier, 4);
    assert.equal(s.peakMultiplier, 4);
    // 9x1 + 10x2 + 10x3 + 11x4 notes at 60 points
    assert.equal(s.score, 60 * (9 + 20 + 30 + 44));
    assert.equal(s.maxCombo, 40);
    assert.equal(s.fullCombo, true);

    const np = engineFor(snares(40), { proDrums: false });
    for (let i = 0; i < 40; i++) np.hit(1 + i * 0.5, PAD.RED);
    assert.equal(np.getState().score, 50 * (9 + 20 + 30 + 44));
});

test('a miss resets combo and multiplier', () => {
    const eng = engineFor(snares(15));
    for (let i = 0; i < 12; i++) eng.hit(1 + i * 0.5, PAD.RED);
    assert.equal(eng.getState().multiplier, 2);
    const log = collect(eng, ['combo-break', 'miss']);
    eng.update(1 + 12 * 0.5 + 0.2);
    const s = eng.getState();
    assert.equal(s.combo, 0);
    assert.equal(s.multiplier, 1);
    assert.equal(s.maxCombo, 12);
    assert.deepEqual(log.map(x => x[0]), ['combo-break', 'miss']); // YARG: ResetCombo before OnNoteMissed
});

test('an overhit resets combo and multiplier', () => {
    const eng = engineFor(snares(15));
    for (let i = 0; i < 12; i++) eng.hit(1 + i * 0.5, PAD.RED);
    eng.hit(1 + 12 * 0.5, PAD.KICK);
    assert.equal(eng.getState().combo, 0);
    assert.equal(eng.getState().multiplier, 1);
});

test('overhits are ignored before the first note, after the last, and during a wait countdown', () => {
    // YARG DrumEngineTester: Overhit_DoesNothingBeforeFirstNote / Overhit_DoesNothingAfterLastNote
    const eng = engineFor([w(1, SNARE), w(2, SNARE), w(20, SNARE)]);
    assert.deepEqual(eng.hit(0.5, PAD.BLUE), { type: 'ignored', reason: 'before-first-note' });
    eng.hit(1, PAD.RED);
    eng.hit(2, PAD.RED);
    // 18 s gap >= 9 s WaitCountdown.MIN_SECONDS
    assert.deepEqual(eng.hit(5, PAD.BLUE), { type: 'ignored', reason: 'countdown' });
    eng.hit(20, PAD.RED);
    assert.deepEqual(eng.hit(21, PAD.BLUE), { type: 'ignored', reason: 'after-last-note' });
    assert.equal(eng.getState().overhits, 0);
    assert.equal(eng.getState().combo, 3);
});

test('dynamics: correct-velocity accent/ghost hits earn +25 x multiplier', () => {
    const wire = [w(1, SNARE, { ac: true }), w(4, SNARE, { ac: true }), w(7, SNARE, { mt: true }),
        w(10, SNARE, { mt: true }), w(13, SNARE), w(16, SNARE, { ac: true })];
    const eng = engineFor(wire);
    assert.equal(eng.hit(1, PAD.RED, { velocity: 0.9 }).bonus, true);   // accent > 1 - 0.35
    assert.equal(eng.hit(4, PAD.RED, { velocity: 0.5 }).bonus, false);  // too soft
    assert.equal(eng.hit(7, PAD.RED, { velocity: 0.2 }).bonus, true);   // ghost < 0.35
    assert.equal(eng.hit(10, PAD.RED).bonus, false);                     // no velocity -> no bonus
    assert.equal(eng.hit(13, PAD.RED, { velocity: 1 }).bonus, false);   // neutral note
    assert.equal(eng.hit(16, PAD.RED, { velocity: 120 }).bonus, true);  // MIDI velocity normalised
    const s = eng.getState();
    assert.equal(s.dynamicsBonus, 75);
    assert.equal(s.accentsHit, 2);
    assert.equal(s.ghostsHit, 1);
    assert.equal(s.totalAccents, 3);
    assert.equal(s.totalGhosts, 2);
    assert.equal(s.score, 6 * 60 + 75);
});

test('dynamics: situational threshold compares against the previous dynamic note on the same pad', () => {
    // ghost hit at 0.3, then another ghost 0.5 s later: threshold = max(0.35, 0.3) -> 0.34 still a ghost
    const eng = engineFor([w(1, SNARE, { mt: true }), w(1.5, SNARE, { mt: true }), w(2, SNARE, { mt: true })]);
    eng.hit(1, PAD.RED, { velocity: 0.3 });
    assert.equal(eng.hit(1.5, PAD.RED, { velocity: 0.34 }).bonus, true);
    // ghost after a ghost hit at 0.34: threshold = max(0.35, 0.34) -> 0.36 is not soft enough
    assert.equal(eng.hit(2, PAD.RED, { velocity: 0.36 }).bonus, false);
});

test('stars: full combo without star power lands in the 5-star band', () => {
    const eng = engineFor(snares(50));
    playAll(eng);
    const s = eng.getState();
    // YARG's BaseScore uses the multiplier *before* each chord's combo increment, while live scoring
    // updates the multiplier first (the 10th note scores 2x), so a full combo slightly exceeds BaseScore.
    assert.ok(s.score > s.baseScore);
    assert.ok(s.stars >= 5 && s.stars < 6, 'stars ' + s.stars);
    assert.deepEqual(s.starThresholds, [0.06, 0.12, 0.2, 0.45, 0.75, 1.09].map(x => Math.floor(s.baseScore * x)));
});

// ── Star power ───────────────────────────────────────────────────────────

const SP_WIRE = snares(40, 1, 0.5); // notes at 1.0 .. 20.5
// phrases: notes 0-3 (1.0-2.5), 10-13 (6.0-7.5), 20-23 (11.0-12.5)
const PHRASES = [{ start: 0.9, end: 2.9 }, { start: 5.9, end: 7.9 }, { start: 10.9, end: 12.9 }];

test('star power: hitting every note of a phrase awards a quarter bar', () => {
    const eng = engineFor(SP_WIRE, { starPower: PHRASES });
    const log = collect(eng, ['sp-phrase', 'sp-ready']);
    assert.equal(eng.isStarPowerNote(0), true);
    assert.equal(eng.isStarPowerNote(4), false);
    for (let i = 0; i < 4; i++) eng.hit(1 + i * 0.5, PAD.RED);
    let s = eng.getState().starPower;
    assert.equal(s.amount, 0.25);
    assert.equal(s.phrasesHit, 1);
    assert.equal(s.phrasesTotal, 3);
    assert.equal(log.length, 1);
    assert.equal(log[0][0], 'sp-phrase');
    for (let i = 4; i < 14; i++) eng.hit(1 + i * 0.5, PAD.RED);
    s = eng.getState().starPower;
    assert.equal(s.amount, 0.5);
    assert.equal(s.canActivate, true);
    assert.deepEqual(log.map(x => x[0]), ['sp-phrase', 'sp-ready', 'sp-phrase']);
});

test('star power: one miss in a phrase fails it (no award)', () => {
    const eng = engineFor(SP_WIRE, { starPower: PHRASES });
    const log = collect(eng, ['sp-phrase', 'sp-phrase-fail']);
    eng.hit(1, PAD.RED);
    eng.hit(1.5, PAD.RED);
    eng.update(2.2); // note at 2.0 missed
    eng.hit(2.5, PAD.RED);
    assert.equal(eng.getState().starPower.amount, 0);
    assert.equal(eng.getState().starPower.phrasesHit, 0);
    assert.deepEqual(log.map(x => x[0]), ['sp-phrase-fail']);
    assert.equal(eng.isStarPowerNote(3), false);
});

test('star power: an overhit mid-phrase fails it, but not before the phrase starts', () => {
    const eng = engineFor([w(0.5, KICK), ...SP_WIRE], { starPower: PHRASES });
    eng.hit(0.5, PAD.KICK);
    eng.hit(0.8, PAD.BLUE); // overhit while next note is the phrase start -> phrase survives
    for (let i = 0; i < 4; i++) eng.hit(1 + i * 0.5, PAD.RED);
    assert.equal(eng.getState().starPower.phrasesHit, 1);
    for (let i = 4; i < 11; i++) eng.hit(1 + i * 0.5, PAD.RED); // first note of phrase 2 hit (6.0)
    eng.hit(6.25, PAD.BLUE); // overhit inside phrase 2
    for (let i = 11; i < 14; i++) eng.hit(1 + i * 0.5, PAD.RED);
    assert.equal(eng.getState().starPower.phrasesHit, 1);
    assert.equal(eng.getState().overhits, 2);
});

test('star power: activation needs half a bar', () => {
    const eng = engineFor(SP_WIRE, { starPower: PHRASES });
    for (let i = 0; i < 4; i++) eng.hit(1 + i * 0.5, PAD.RED);
    assert.equal(eng.activateStarPower(3), false);
    for (let i = 4; i < 14; i++) eng.hit(1 + i * 0.5, PAD.RED);
    assert.equal(eng.activateStarPower(7.6), true);
    assert.equal(eng.activateStarPower(7.7), false); // already active
    assert.equal(eng.getState().starPower.active, true);
});

test('star power: doubles the multiplier (8x max) and drains to the end (120 BPM default)', () => {
    const eng = engineFor(snares(80, 1, 0.25), { starPower: [{ start: 0, end: 2 }, { start: 2, end: 3 }] });
    const log = collect(eng, ['sp-activate', 'sp-end', 'multiplier']);
    for (let i = 0; i < 32; i++) eng.hit(1 + i * 0.25, PAD.RED); // to t=8.75, combo 32 -> 4x
    assert.equal(eng.getState().starPower.amount, 0.5);
    assert.equal(eng.getState().multiplier, 4);
    assert.equal(eng.activateStarPower(8.8), true);
    assert.equal(eng.getState().multiplier, 8);
    const before = eng.getState().score;
    eng.hit(9, PAD.RED);
    assert.equal(eng.getState().score - before, 60 * 8);
    // half bar = 4 measures = 8 s at 120 BPM 4/4
    assert.ok(Math.abs(eng.getState().starPower.endTime - 16.8) < 1e-9);
    for (let i = 33; i < 48; i++) eng.hit(1 + i * 0.25, PAD.RED); // up to t=12.75
    eng.update(12.8);
    assert.ok(Math.abs(eng.getState().starPower.amount - 0.25) < 1e-9); // 2 of 4 measures drained
    for (let i = 48; i < 80; i++) eng.hit(1 + i * 0.25, PAD.RED);
    const s = eng.getState();
    assert.equal(s.starPower.active, false);
    assert.equal(s.starPower.amount, 0);
    assert.equal(s.multiplier, 4);
    assert.ok(Math.abs(s.starPower.timeInStarPower - 8) < 1e-9);
    const ends = log.filter(x => x[0] === 'sp-end');
    assert.equal(ends.length, 1);
    assert.ok(Math.abs(ends[0][1].time - 16.8) < 1e-9);
    assert.deepEqual(log.filter(x => x[0] === 'multiplier').map(x => x[1].multiplier), [2, 3, 4, 8, 4]);
});

test('star power: drain follows the tempo map (tempo / beats / measures)', () => {
    const wire = snares(8, 1, 0.25);
    const opts = { starPower: [{ start: 0, end: 1.6 }, { start: 1.6, end: 3 }] };
    const run = (extra) => {
        const eng = engineFor(wire, Object.assign({}, opts, extra));
        for (let i = 0; i < 8; i++) eng.hit(1 + i * 0.25, PAD.RED);
        eng.activateStarPower(3);
        return eng.getState().starPower.endTime - 3;
    };
    assert.ok(Math.abs(run({ tempo: [{ t: 0, bpm: 60 }] }) - 16) < 1e-9);       // 4 measures x 4 s
    assert.ok(Math.abs(run({ tempo: [{ t: 0, bpm: 240 }] }) - 4) < 1e-9);
    assert.ok(Math.abs(run({ tempo: [{ t: 0, bpm: 120 }], beatsPerMeasure: 3 }) - 6) < 1e-9);
    const beats = [];
    for (let i = 0; i < 200; i++) beats.push({ time: i * 0.25, measure: i % 4 === 0 ? i / 4 + 1 : -1 });
    assert.ok(Math.abs(run({ beats }) - 4) < 1e-9);                               // 1 s measures
    assert.ok(Math.abs(run({ beats: beats.map(b => b.time) }) - 4) < 1e-9);       // plain beat times, 4/4
    assert.ok(Math.abs(run({ measures: [0, 3, 6, 9, 12, 15, 18, 21] }) - 12) < 1e-9);
    assert.ok(Math.abs(run({}) - 8) < 1e-9);                                      // 120 BPM fallback
});

test('star power: phrase hit while active extends the end time', () => {
    const eng = engineFor(snares(60, 1, 0.25), { starPower: [{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 4, end: 5 }] });
    for (let i = 0; i < 8; i++) eng.hit(1 + i * 0.25, PAD.RED);
    eng.activateStarPower(3);
    const end0 = eng.getState().starPower.endTime;
    for (let i = 8; i < 16; i++) eng.hit(1 + i * 0.25, PAD.RED); // phrase 3 (4.0-4.75) completes
    const end1 = eng.getState().starPower.endTime;
    assert.ok(Math.abs(end1 - end0 - 4) < 1e-9); // +2 measures = 4 s
});

test('drum fill activation: hitting the fill-ending activator activates SP', () => {
    // chord at 9.0 = kick + crash; rightmost lane (green cymbal) is the activator
    const wire = [...snares(8, 1, 0.25), w(9, KICK), w(9, CRASH), w(10, SNARE)];
    const opts = { starPower: [{ start: 0, end: 2 }, { start: 2, end: 3 }], activation: [{ start: 8, end: 9 }] };
    const eng = engineFor(wire, opts);
    assert.equal(eng.isActivatorNote(9), true);  // crash
    assert.equal(eng.isActivatorNote(8), false); // kick
    for (let i = 0; i < 8; i++) eng.hit(1 + i * 0.25, PAD.RED);
    assert.equal(eng.activateStarPower(5), false); // manual activation is off when fills are given
    eng.hit(9, PAD.KICK);
    assert.equal(eng.getState().starPower.active, false);
    eng.hit(9, PAD.GREEN, { cymbal: true });
    assert.equal(eng.getState().starPower.active, true);
});

test('drum fill activation: activator skipped while SP is ready is auto-hit (no penalty)', () => {
    const wire = [...snares(8, 1, 0.25), w(9, CRASH), w(10, SNARE)];
    const opts = { starPower: [{ start: 0, end: 2 }, { start: 2, end: 3 }], activation: [{ start: 8, end: 9 }] };
    const eng = engineFor(wire, opts);
    const log = collect(eng, ['hit', 'miss']);
    for (let i = 0; i < 8; i++) eng.hit(1 + i * 0.25, PAD.RED);
    eng.update(9.5);
    const s = eng.getState();
    assert.equal(eng.noteState(8), 'hit');
    assert.equal(eng.noteInfo(8).autoHit, true);
    assert.equal(s.combo, 9);
    assert.equal(s.starPower.active, false);
    assert.equal(log.filter(x => x[0] === 'miss').length, 0);
    assert.equal(log.filter(x => x[0] === 'hit').length, 8); // auto-hit fires no 'hit' event
});

test('drum fill activation: without enough SP the activator is an ordinary note', () => {
    const wire = [...snares(4, 1, 0.25), w(9, CRASH), w(10, SNARE)];
    const eng = engineFor(wire, { starPower: [{ start: 0, end: 2 }], activation: [{ start: 8, end: 9 }] });
    for (let i = 0; i < 4; i++) eng.hit(1 + i * 0.25, PAD.RED);
    eng.update(9.5);
    assert.equal(eng.noteState(4), 'miss');
    const eng2 = engineFor(wire, { starPower: [{ start: 0, end: 2 }], activation: [{ start: 8, end: 9 }] });
    for (let i = 0; i < 4; i++) eng2.hit(1 + i * 0.25, PAD.RED);
    eng2.hit(9, PAD.GREEN, { cymbal: true });
    assert.equal(eng2.getState().starPower.active, false);
    assert.equal(eng2.getState().starPower.amount, 0.25);
});

test('activationType "all" requires every note of the activation chord', () => {
    const wire = [...snares(8, 1, 0.25), w(9, KICK), w(9, CRASH)];
    const eng = engineFor(wire, { params: { activationType: 'all' },
        starPower: [{ start: 0, end: 2 }, { start: 2, end: 3 }], activation: [{ start: 8, end: 9 }] });
    for (let i = 0; i < 8; i++) eng.hit(1 + i * 0.25, PAD.RED);
    eng.hit(9, PAD.GREEN, { cymbal: true });
    assert.equal(eng.getState().starPower.active, false);
    eng.hit(9.01, PAD.KICK);
    assert.equal(eng.getState().starPower.active, true);
});

test('sp-activate fires and noStarPowerOverlap blocks gaining while active', () => {
    const eng = engineFor(snares(60, 1, 0.25), { params: { noStarPowerOverlap: true },
        starPower: [{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 4, end: 5 }] });
    const log = collect(eng, ['sp-activate', 'sp-phrase-fail']);
    for (let i = 0; i < 8; i++) eng.hit(1 + i * 0.25, PAD.RED);
    eng.activateStarPower(3);
    const end0 = eng.getState().starPower.endTime;
    for (let i = 8; i < 16; i++) eng.hit(1 + i * 0.25, PAD.RED);
    assert.equal(eng.getState().starPower.endTime, end0);
    assert.deepEqual(log.map(x => x[0]), ['sp-activate', 'sp-phrase-fail']);
});

// ── Misc API ─────────────────────────────────────────────────────────────

test('reset() clears runtime state but keeps chart totals (YARG Reset_ClearsRuntimeDrumStatsButPreservesChartTotals)', () => {
    const wire = [...snares(10), w(7, SNARE, { ac: true }), w(8, SNARE, { mt: true })];
    const eng = engineFor(wire, { starPower: [{ start: 0, end: 2 }] });
    playAll(eng);
    eng.hit(20, PAD.KICK);
    eng.update(30);
    const before = eng.getState();
    assert.ok(before.score > 0);
    eng.reset();
    const s = eng.getState();
    assert.equal(s.score, 0);
    assert.equal(s.combo, 0);
    assert.equal(s.notesHit, 0);
    assert.equal(s.notesMissed, 0);
    assert.equal(s.overhits, 0);
    assert.equal(s.dynamicsBonus, 0);
    assert.equal(s.multiplier, 1);
    assert.equal(s.starPower.amount, 0);
    assert.equal(s.starPower.phrasesHit, 0);
    assert.equal(s.totalNotes, before.totalNotes);
    assert.equal(s.totalAccents, 1);
    assert.equal(s.totalGhosts, 1);
    assert.equal(s.starPower.phrasesTotal, 1);
    assert.equal(eng.noteState(0), null);
    assert.equal(eng.isStarPowerNote(0), true);
    // replay works after reset (clock went back)
    assert.equal(eng.hit(1, PAD.RED).type, 'hit');
});

test('bot-style run hits all notes, no overhits, full combo, 100% (YARG BotRun_HitsAllNotes...)', () => {
    const wire = [];
    const kit = [KICK, SNARE, HAT, HI_TOM, LOW_TOM, RIDE, FLOOR_TOM, CRASH];
    for (let i = 0; i < 64; i++) {
        wire.push(w(1 + i * 0.2, kit[i % kit.length]));
        if (i % 4 === 0) wire.push(w(1 + i * 0.2, KICK));
    }
    const eng = engineFor(wire);
    playAll(eng);
    eng.update(100);
    const s = eng.getState();
    assert.equal(s.notesHit, s.totalNotes);
    assert.equal(s.overhits, 0);
    assert.equal(s.fullCombo, true);
    assert.equal(s.percent, 1);
    assert.equal(s.accuracy, 1);
});

test('matching input raises a hit event with velocity; mismatched raises overhit (YARG MatchingInput/MismatchedInput)', () => {
    const eng = engineFor([w(1, KICK), w(3, SNARE), w(5, SNARE)]);
    eng.hit(1, PAD.KICK);
    const log = collect(eng, ['hit', 'overhit']);
    eng.update(2.9);
    eng.hit(3, PAD.RED, { velocity: 0.9 });
    assert.equal(log.length, 1);
    assert.equal(log[0][0], 'hit');
    assert.equal(log[0][1].velocity, 0.9);
    assert.equal(log[0][1].bonus, false);
    assert.equal(log[0][1].id, 1);
    eng.hit(5, PAD.YELLOW, { cymbal: true, velocity: 0.8 });
    assert.equal(log[1][0], 'overhit');
    assert.equal(log[1][1].lane, D.LANE.YELLOW_CYMBAL);
    assert.equal(eng.noteState(2), null);
    assert.equal(eng.getState().overhits, 1);
    assert.equal(eng.stats.overhitsByLane[D.LANE.YELLOW_CYMBAL], 1);
});

test('precision preset uses YARG dynamic hit window (narrower for dense notes)', () => {
    const dense = engineFor(snares(10, 1, 0.05), { params: D.PRESETS.precision });
    const sparse = engineFor(snares(10, 1, 1), { params: D.PRESETS.precision });
    const dw = dense.hitWindow(), sw = sparse.hitWindow();
    assert.ok(dw.back - dw.front < sw.back - sw.front);
    assert.ok(sw.back - sw.front <= 0.13 + 1e-12);
    assert.ok(dw.back - dw.front >= 0.05 - 1e-12);
    // songSpeed scales the window like HitWindowSettings.Scale
    const slow = engineFor(snares(2), { params: { songSpeed: 0.5 } });
    assert.ok(Math.abs(slow.hitWindow().back - 0.035) < 1e-12);
});

test('on() returns an unsubscribe function; off() removes listeners', () => {
    const eng = engineFor(snares(3, 1, 1));
    let n = 0;
    const unsub = eng.on('hit', () => n++);
    eng.hit(1, PAD.RED);
    unsub();
    eng.hit(2, PAD.RED);
    const cb = () => n++;
    eng.on('hit', cb);
    eng.off('hit', cb);
    eng.hit(3, PAD.RED);
    assert.equal(n, 1);
    // a throwing listener does not break the engine
    const e2 = engineFor(snares(2, 1, 1));
    const origErr = console.error;
    console.error = () => {};
    try {
        e2.on('hit', () => { throw new Error('boom'); });
        assert.equal(e2.hit(1, PAD.RED).type, 'hit');
    } finally { console.error = origErr; }
    assert.equal(e2.getState().combo, 1);
});

test('create() accepts raw wire notes; bad input is ignored; stale times clamp forward', () => {
    const eng = D.create([w(1, SNARE), w(2, KICK)]);
    assert.equal(eng.getState().totalNotes, 2);
    assert.equal(eng.hit(1, 7).type, 'ignored');
    assert.equal(eng.hit(NaN, PAD.RED).type, 'ignored');
    eng.update(1.5);
    assert.equal(eng.noteState(0), 'miss');
    // hit stamped in the past is processed at the current clock (YARG QueueInput behaviour)
    // clamped to 1.5: the kick at 2.0 is not in its window yet, so this is an overhit
    assert.equal(eng.hit(1.0, PAD.KICK).type, 'overhit');
    assert.equal(eng.getState().time, 1.5);
    assert.equal(eng.hit(2, PAD.KICK).type, 'hit');
});

test('empty chart is safe', () => {
    const eng = D.create({ notes: [], chords: [] });
    eng.update(10);
    assert.equal(eng.hit(1, PAD.RED).type, 'ignored');
    const s = eng.getState();
    assert.equal(s.totalNotes, 0);
    assert.equal(s.accuracy, 1);
    assert.equal(s.percent, 1);
});

test('browser build: assigns window.DrumsEngine with no module system', () => {
    const src = fs.readFileSync(ENGINE_PATH, 'utf8');
    const win = {};
    vm.runInNewContext(src, { window: win, self: win, console });
    assert.equal(typeof win.DrumsEngine.create, 'function');
    assert.deepEqual({ ...win.DrumsEngine.PAD }, { KICK: 0, RED: 1, YELLOW: 2, BLUE: 3, GREEN: 4 });
});

// ── DrumsStatsTests-style: stats bookkeeping ─────────────────────────────

test('stats: overhitsByLane counts per lane and resets', () => {
    const eng = engineFor([w(1, KICK), w(3, SNARE), w(6, SNARE)]);
    eng.hit(1, PAD.KICK);
    eng.hit(2, PAD.BLUE);
    eng.hit(2.1, PAD.BLUE);
    eng.hit(2.2, PAD.GREEN, { cymbal: true });
    assert.equal(eng.stats.overhitsByLane[D.LANE.BLUE_DRUM], 2);
    assert.equal(eng.stats.overhitsByLane[D.LANE.GREEN_CYMBAL], 1);
    assert.equal(eng.getState().overhits, 3);
    eng.reset();
    assert.deepEqual(eng.stats.overhitsByLane, {});
});
