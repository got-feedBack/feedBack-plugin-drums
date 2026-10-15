/*
 * engine.js: Rock Band-style drums hit detection and scoring for the feedBack drums plugin.
 *
 * Ported from YARG.Core (https://github.com/YARC-Official/YARG.Core):
 *   YARG.Core/Engine/Drums/DrumsEngine.cs
 *   YARG.Core/Engine/Drums/Engines/YargDrumsEngine.cs
 *   YARG.Core/Engine/Drums/DrumsEngineParameters.cs
 *   YARG.Core/Engine/Drums/DrumsStats.cs
 *   YARG.Core/Engine/BaseEngine.cs, BaseEngine.Generic.cs, BaseEngineParameters.cs, BaseStats.cs
 *   YARG.Core/Engine/HitWindowSettings.cs
 *   YARG.Core/Chart/Notes/DrumNote.cs, YARG.Core/Chart/Notes/Note.cs
 *   YARG.Core/Chart/Tracks/InstrumentDifficultyExtensions.cs (SetDrumActivationFlags)
 *   YARG.Core/Chart/Events/WaitCountdown.cs (MIN_SECONDS)
 *   YARG.Core/Game/Presets/EnginePreset.Instruments.cs and EnginePreset.Defaults.cs (default parameters)
 * and from the YARG game (https://github.com/YARC-Official/YARG, also LGPL-3.0):
 *   Assets/Script/Gameplay/Player/DrumsPlayer.cs (drum star score thresholds)
 *
 * Copyright (c) YARC (YARG) contributors
 * Licensed under the GNU Lesser General Public License v3.0
 * (see https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE, and LICENSE.LGPL-3.0 at the plugin root; LGPL-3.0 builds on the GPL-3.0 in LICENSE.GPL-3.0).
 *
 * Ported and modified to JavaScript for the feedBack drums plugin. This file is a derivative work of the
 * above files and stays under LGPL-3.0. The rest of the plugin is MIT (see NOTICE.md).
 * Modifications: rewritten as a dependency-free JavaScript module, uses an immediate hit()/update() API
 * in place of YARG's input queue, works in seconds/measures in place of chart ticks, and decodes feedBack
 * wire notes (General MIDI drum numbers). The deviations are listed below.
 *
 * -------------------------------------------------------------------------------------------------
 * Rules ported from YARG (defaults = EnginePreset.Default):
 *  - Hit window: 140 ms total, front/back ratio 1.0, so it runs from 70 ms early to 70 ms late. It is not
 *    dynamic by default. YARG's "Dark YARG" dynamic window is ported (params.hitWindow.isDynamic) along with
 *    the "Precision" preset (DrumsEngine.PRESETS.precision). The window scales with params.songSpeed.
 *    A note can still be hit exactly at the back edge. It is missed once time > t + backEnd.
 *  - Matching (YargDrumsEngine.CheckForNoteHit): scan from the oldest unresolved chord forward while the
 *    chords are inside the hit window, and hit the first note whose lane equals the input lane. Every note
 *    in a chord is hit separately. Hitting a later chord counts every unresolved note in earlier chords as
 *    a miss (SkipPreviousNotes). One input hits at most one note.
 *  - Lanes (FourLaneDrumPad): with pro drums, a yellow, blue or green cymbal is a separate lane from the tom
 *    of the same colour, so a cymbal hit on a tom note does not hit it and is an overhit. Non-pro drums map
 *    cymbal inputs onto the drum lanes. The engine has no cymbal/tom fallback.
 *  - Overhit (DrumsEngine.Overhit): a pad hit that hits no note resets the combo, adds 1 to overhits and
 *    fails the star power phrase in progress (unless the current note starts the phrase). It does not
 *    change the score. An overhit is ignored before the first note is resolved, after the last note, and
 *    during a WaitCountdown (a gap of 9 s or more between notes).
 *  - Combo: +1 for each note hit, so a chord adds 1 per note. Multiplier = min(floor(combo / 10) + 1, 4),
 *    doubled while star power is active (up to 8x). The multiplier updates before the note is scored, so
 *    the 10th note already scores at 2x.
 *  - Score: 60 points per note with pro drums, 50 without, times the multiplier. Dynamics: an accent or ghost
 *    note hit with the right velocity scores +25 x multiplier (ApplyVelocity, threshold 0.35, 1.5 s window
 *    for relative velocity). This only applies when hit() gets a velocity.
 *  - Star power: hitting every note of a phrase awards a quarter bar (2 measures). The bar holds 8 measures.
 *    Activation needs half a bar (4 measures). While active, the bar drains 1 measure per measure of song
 *    time, so a full bar lasts 8 measures. A phrase hit while star power is active adds to the bar and
 *    pushes the end time back (unless params.noStarPowerOverlap is set). A miss in a phrase fails it.
 *  - Drum fill activation (SetDrumActivationFlags + DrumsEngine.HitNote): the activation chord of a fill
 *    gets the "activator" flag. With YARG's default RightmostNote type, only the rightmost lane of that
 *    chord gets it. Hitting the activator when the bar is at least half full activates star power.
 *    If the player lets the activator pass while star power could activate, it is auto-hit: it scores and
 *    adds to the combo but does not activate star power and fires no 'hit' event.
 *  - Stars: BaseScore = the score of a full combo with no star power and no dynamics bonus, using the same
 *    pre-increment multiplier as CalculateChartScores. Thresholds come from DrumsPlayer.cs:
 *    [0.06, 0.12, 0.2, 0.45, 0.75, 1.09] x BaseScore for 1-5 stars and gold.
 *
 * Deviations from YARG:
 *  1. Time model: YARG runs a queued-input simulation in chart ticks. This engine uses seconds and a
 *     time->measure map built from opts.measures (barline times), opts.beats (numbers or {time, measure}
 *     objects, where a measure >= 0 marks a downbeat), or opts.tempo ([{t, bpm}] plus opts.beatsPerMeasure,
 *     default 4). The fallback is 120 BPM in 4/4, so 1 measure = 2 s. Star power is tracked as fractional
 *     measures rather than integer measure ticks, so there is no tick rounding.
 *  2. hit() and update() run immediately. Times earlier than the engine clock are clamped forward, as
 *     YARG's QueueInput does. Misses and the star power end are processed in time order inside each call.
 *  3. Not ported: trill/tremolo lanes, kick lanes and their lane leniency, BRE/coda, solos and solo bonus,
 *     band/unison bonus, revives, the Elite and 5-lane modes, bots, and replays. The wildcard pad is not
 *     reachable from this API.
 *  4. Chart import: notes less than 1 ms apart form a chord (YARG uses identical ticks). A second note on
 *     the same lane in one chord is dropped, like DrumNote.AddChildNote. With proDrums:false a yellow tom
 *     and a yellow cymbal in one chord collapse into one note, and noteState() of the dropped id reports
 *     the surviving note. 35 (kick 2x) is kept unless opts.kick2x === false, rather than YARG's
 *     Expert+ difficulty switch.
 *  5. Star power phrase membership: start - 0.1 ms <= chord.t < end - 0.1 ms (half-open, like tick ranges).
 *     Phrases that contain no notes are left out of phrasesTotal.
 *  6. Phrase failure is tracked per phrase. Missing any note of a phrase, including a child note of a
 *     chord, fails the whole phrase. YARG's StripStarPower only strips the child note in that case, which
 *     looks like a bug.
 *  7. Activation window -> activator chord: the last chord with start - 0.1 ms <= t <= end + 0.1 ms
 *     (Rock Band: the fill ends on the activation chord). If no chord falls in the window, YARG's rule is
 *     used: the first chord at or after `end`. Without opts.activation, eng.activateStarPower() works
 *     whenever the bar is half full. With fills, manual activation is off unless opts.manualActivation is
 *     true. YARG drums have no manual activation; it auto-generates fills.
 *  8. Hitting a pad that matches a chord note already hit is consumed with no effect, as in YARG. This
 *     engine returns {type:'ignored'} and, unlike YARG, does not run the velocity bonus again.
 *  9. Velocity comparison (ApplyVelocity): the comparison note is looked up across all notes of earlier
 *     chords on the same lane, not only parent notes. Velocities above 1 are read as MIDI 0-127.
 * 10. Reporting: getState().notesMissed counts notes actually missed so far (YARG reports
 *     TotalNotes - NotesHit). accuracy = hit / (hit + missed) so far, and percent = YARG's
 *     NotesHit / TotalNotes. maxMultiplier is the cap (params.maxMultiplier) and peakMultiplier is the
 *     highest multiplier reached. 'combo-break' fires only when a combo above 0 resets.
 * -------------------------------------------------------------------------------------------------
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.DrumsEngine = api;
    else if (typeof module !== 'object' && root) root.DrumsEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── Constants ───────────────────────────────────────────────────────────────

    // Plugin-facing pad colours (shared with screen.js).
    const PAD = Object.freeze({ KICK: 0, RED: 1, YELLOW: 2, BLUE: 3, GREEN: 4 });

    // YARG FourLaneDrumPad (DrumNote.cs). These are the engine's internal "lanes".
    const LANE = Object.freeze({
        KICK: 0, RED: 1, YELLOW_DRUM: 2, BLUE_DRUM: 3, GREEN_DRUM: 4,
        YELLOW_CYMBAL: 5, BLUE_CYMBAL: 6, GREEN_CYMBAL: 7,
    });

    // BaseEngine.cs
    const POINTS_PER_NOTE = 50;
    const POINTS_PER_PRO_NOTE = POINTS_PER_NOTE + 10;
    // YargDrumsEngine.CheckForNoteHit: velocityBonus = POINTS_PER_NOTE / 2
    const VELOCITY_BONUS = POINTS_PER_NOTE / 2;
    // BaseEngine.UpdateMultiplier: (Combo / 10) + 1
    const NOTES_PER_MULTIPLIER = 10;

    const CHORD_EPS = 0.001;   // notes closer than 1 ms form a chord
    const PHRASE_EPS = 0.0001; // tolerance for phrase/window boundaries
    const SP_EPS = 1e-9;

    // General MIDI drum number -> pad/cymbal (the drums wire encoding is midi = s*24 + f).
    const MIDI_MAP = Object.freeze({
        36: { pad: PAD.KICK, cymbal: false },
        35: { pad: PAD.KICK, cymbal: false, kick2x: true },
        38: { pad: PAD.RED, cymbal: false },     // acoustic snare
        37: { pad: PAD.RED, cymbal: false },     // side stick / cross-stick
        40: { pad: PAD.RED, cymbal: false },     // electric snare
        42: { pad: PAD.YELLOW, cymbal: true },   // closed hi-hat
        46: { pad: PAD.YELLOW, cymbal: true },   // open hi-hat
        44: { pad: PAD.YELLOW, cymbal: true, hatPedal: true }, // pedal hi-hat (opt-in)
        48: { pad: PAD.YELLOW, cymbal: false },  // hi-mid tom
        50: { pad: PAD.YELLOW, cymbal: false },  // high tom
        45: { pad: PAD.BLUE, cymbal: false },    // low tom
        47: { pad: PAD.BLUE, cymbal: false },    // low-mid tom
        41: { pad: PAD.GREEN, cymbal: false },   // low floor tom
        43: { pad: PAD.GREEN, cymbal: false },   // high floor tom
        58: { pad: PAD.GREEN, cymbal: false },   // vibraslap (some kits send it from the floor tom)
        51: { pad: PAD.BLUE, cymbal: true },     // ride
        53: { pad: PAD.BLUE, cymbal: true },     // ride bell
        59: { pad: PAD.BLUE, cymbal: true },     // ride 2
        49: { pad: PAD.GREEN, cymbal: true },    // crash
        57: { pad: PAD.GREEN, cymbal: true },    // crash 2
        55: { pad: PAD.GREEN, cymbal: true },    // splash
        52: { pad: PAD.GREEN, cymbal: true },    // china
    });

    // ── Default parameters ─────────────────────────────────────────────────────

    /**
     * YARG's default drum engine parameters. Sources:
     *  - hitWindow: EnginePreset.Instruments.cs DrumsPreset.HitWindow (MaxWindow 0.14, MinWindow 0.14,
     *    IsDynamic false, FrontToBackRatio 1.0, LaneAutohitWindow 0.160) plus HitWindowPreset defaults
     *    (DynamicScale 1.0, DynamicSlope 0.93, DynamicGamma 1.5, LaneProximityProtectionWindow 0.080).
     *  - maxMultiplier: EnginePreset.DEFAULT_MAX_MULTIPLIER = 4.
     *  - velocityThreshold 0.35, situationalVelocityWindow 1.5: DrumsEngineParameters constructor.
     *  - noStarPowerOverlap false: DrumsPreset.NoStarPowerOverlap.
     *  - starPowerMeasures 8: BaseEngine.STAR_POWER_MAX_MEASURES (TicksPerFullSpBar = 8 measures).
     *    A phrase gives TicksPerQuarterSpBar (2 measures), and activation needs TicksPerHalfSpBar (4 measures).
     *  - starMultiplierThresholds: YARG DrumsPlayer.cs StarMultiplierThresholds.
     *  - waitCountdownSeconds 9: WaitCountdown.MIN_SECONDS.
     *  - activationType 'rightmost': YargProfile default StarPowerActivationType.RightmostNote.
     *  - pointsPerNote/pointsPerProNote/velocityBonus/notesPerMultiplier: BaseEngine.cs constants.
     */
    function defaultParams() {
        return {
            hitWindow: {
                maxWindow: 0.14,
                minWindow: 0.14,
                isDynamic: false,
                frontToBackRatio: 1.0,
                dynamicScale: 1.0,
                dynamicSlope: 0.93,
                dynamicGamma: 1.5,
                laneAutohitWindow: 0.160,          // unused (lanes not ported); kept for parity
                laneProximityProtectionWindow: 0.080, // unused (lanes not ported); kept for parity
            },
            songSpeed: 1.0,
            maxMultiplier: 4,
            notesPerMultiplier: NOTES_PER_MULTIPLIER,
            pointsPerNote: POINTS_PER_NOTE,
            pointsPerProNote: POINTS_PER_PRO_NOTE,
            velocityBonus: VELOCITY_BONUS,
            velocityThreshold: 0.35,
            situationalVelocityWindow: 1.5,
            noStarPowerOverlap: false,
            starPowerMeasures: 8,
            starMultiplierThresholds: [0.06, 0.12, 0.2, 0.45, 0.75, 1.09],
            waitCountdownSeconds: 9,
            activationType: 'rightmost', // 'rightmost' (YARG default) | 'all' (old YARG style)
        };
    }

    // EnginePreset.Defaults.cs: overrides applied by YARG's built-in presets for drums.
    const PRESETS = Object.freeze({
        default: Object.freeze({}),
        casual: Object.freeze({ hitWindow: { laneAutohitWindow: 0.200, laneProximityProtectionWindow: 0.100 } }),
        precision: Object.freeze({
            hitWindow: {
                maxWindow: 0.13, minWindow: 0.05, isDynamic: true,
                dynamicScale: 1, dynamicSlope: 0.60615, dynamicGamma: 2,
                laneAutohitWindow: 0.160, laneProximityProtectionWindow: 0.080,
            },
        }),
    });

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    function mergeParams(over) {
        const p = defaultParams();
        if (!over || typeof over !== 'object') return finalizeParams(p);
        for (const k of Object.keys(over)) {
            if (k === 'hitWindow' && over.hitWindow && typeof over.hitWindow === 'object') {
                Object.assign(p.hitWindow, over.hitWindow);
            } else if (over[k] !== undefined) {
                p[k] = over[k];
            }
        }
        return finalizeParams(p);
    }

    // HitWindowSettings constructor normalisation.
    function finalizeParams(p) {
        const hw = p.hitWindow;
        if (hw.maxWindow < hw.minWindow) { const t = hw.maxWindow; hw.maxWindow = hw.minWindow; hw.minWindow = t; }
        hw.dynamicSlope = clamp(hw.dynamicSlope, 0, 1);
        hw.dynamicScale = clamp(hw.dynamicScale, 0.3, 3);
        hw.dynamicGamma = clamp(hw.dynamicGamma, 0.1, 10);
        if (!(p.songSpeed > 0)) p.songSpeed = 1;
        return p;
    }

    // HitWindowSettings.CalculateHitWindow (+ Dark_Yarg_Impl)
    function calculateHitWindow(hw, averageTimeDistance) {
        if (!hw.isDynamic) return hw.maxWindow;
        const x = averageTimeDistance * 1000;
        const minMs = hw.minWindow * 1000;
        const maxMs = hw.maxWindow * 1000;
        const maxMultiScale = maxMs * hw.dynamicScale;
        const gammaPow = Math.pow(x / maxMultiScale, hw.dynamicGamma);
        const minMultiSlope = minMs * hw.dynamicSlope;
        const result = (gammaPow * (maxMs - minMultiSlope) + minMultiSlope) / 1000;
        return clamp(result, hw.minWindow, hw.maxWindow);
    }
    // HitWindowSettings.GetFrontEnd / GetBackEnd (Scale = song speed)
    function frontEnd(hw, full, scale) { return -(Math.abs(full / 2) * hw.frontToBackRatio) * scale; }
    function backEnd(hw, full, scale) { return Math.abs(full / 2) * (2 - hw.frontToBackRatio) * scale; }

    // ── Chart decoding ─────────────────────────────────────────────────────────

    function padFromMidi(midi, opts) {
        const m = MIDI_MAP[midi];
        if (!m) return null;
        if (m.hatPedal && !(opts && opts.includeHatPedal)) return null;
        return { pad: m.pad, cymbal: m.cymbal };
    }

    function wireMidi(n) {
        if (n.midi != null && Number.isFinite(+n.midi)) return +n.midi;
        return ((n.s | 0) * 24) + (n.f | 0);
    }

    /**
     * Decode drums wire notes ({t, s, f, ac, mt}) into a drum chart.
     * opts.kick2x (default true): keep 35 (expert+ double bass).
     * opts.includeHatPedal (default false): keep 44 (pedal hi-hat) as a yellow cymbal.
     */
    function decodeNotes(wireNotes, opts) {
        opts = opts || {};
        const raw = [];
        const list = Array.isArray(wireNotes) ? wireNotes : [];
        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (!n || typeof n !== 'object') continue;
            const t = +n.t;
            if (!Number.isFinite(t)) continue;
            const midi = wireMidi(n);
            const m = MIDI_MAP[midi];
            if (!m) continue;
            if (m.hatPedal && !opts.includeHatPedal) continue;
            if (m.kick2x && opts.kick2x === false) continue;
            raw.push({
                t,
                pad: m.pad,
                cymbal: !!m.cymbal,
                kick2x: !!m.kick2x,
                dyn: n.ac ? 'accent' : (n.mt ? 'ghost' : null),
                midi,
                _order: i,
            });
        }
        raw.sort((a, b) => (a.t - b.t) || (a._order - b._order));

        const notes = [];
        const chords = [];
        let cur = null;
        for (const r of raw) {
            if (!cur || r.t - cur.t > CHORD_EPS) {
                cur = { t: r.t, notes: [] };
                chords.push(cur);
            } else if (cur.notes.some(x => x.pad === r.pad && x.cymbal === r.cymbal)) {
                continue; // DrumNote.AddChildNote ignores a duplicate pad in a chord
            }
            delete r._order;
            r.id = notes.length;
            r.chord = chords.length - 1;
            notes.push(r);
            cur.notes.push(r);
        }
        return { notes, chords };
    }

    function groupNotes(notes) {
        const sorted = notes.slice().sort((a, b) => a.t - b.t);
        const chords = [];
        let cur = null;
        for (const n of sorted) {
            if (!cur || n.t - cur.t > CHORD_EPS) { cur = { t: n.t, notes: [] }; chords.push(cur); }
            cur.notes.push(n);
        }
        return chords;
    }

    // Lane for a pad/cymbal pair (ConvertInputToPad). Pro drums keep cymbals separate on Y/B/G.
    function laneFor(pad, cymbal, proDrums) {
        if (proDrums !== false && cymbal) {
            if (pad === PAD.YELLOW) return LANE.YELLOW_CYMBAL;
            if (pad === PAD.BLUE) return LANE.BLUE_CYMBAL;
            if (pad === PAD.GREEN) return LANE.GREEN_CYMBAL;
        }
        return pad; // KICK/RED/drum lanes share numbers with PAD
    }

    // ── Time -> measure map (stands in for YARG's SyncTrack measure ticks) ─────

    function buildMeasureMap(opts) {
        const bpmDefault = 120;
        const bpmPerMeasure = (opts && opts.beatsPerMeasure > 0) ? opts.beatsPerMeasure : 4;
        let times = [];
        let pos = [];
        let slopeBefore = null;
        let slopeAfter = null;

        const pushKnot = (t, p) => {
            if (!Number.isFinite(t) || !Number.isFinite(p)) return;
            if (times.length && t <= times[times.length - 1]) return; // keep strictly increasing
            times.push(t); pos.push(p);
        };

        if (opts && Array.isArray(opts.measures) && opts.measures.length) {
            const ms = opts.measures.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            ms.forEach((t, i) => pushKnot(t, i));
        } else if (opts && Array.isArray(opts.beats) && opts.beats.length) {
            const beats = opts.beats;
            const isObj = typeof beats[0] === 'object' && beats[0] !== null;
            if (isObj) {
                const bt = beats.map(b => +(b.time != null ? b.time : b.t)).filter(Number.isFinite);
                const down = beats.filter(b => b && b.measure != null && +b.measure >= 0)
                    .map(b => +(b.time != null ? b.time : b.t)).filter(Number.isFinite).sort((a, b) => a - b);
                if (down.length >= 2) down.forEach((t, i) => pushKnot(t, i));
                else bt.sort((a, b) => a - b).forEach((t, i) => pushKnot(t, i / bpmPerMeasure));
            } else {
                beats.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
                    .forEach((t, i) => pushKnot(t, i / bpmPerMeasure));
            }
        } else if (opts && Array.isArray(opts.tempo) && opts.tempo.length) {
            const tempos = opts.tempo
                .map(x => ({ t: +x.t, bpm: +x.bpm }))
                .filter(x => Number.isFinite(x.t) && x.bpm > 0)
                .sort((a, b) => a.t - b.t);
            let p = 0;
            for (let i = 0; i < tempos.length; i++) {
                if (i > 0) p += (tempos[i].t - tempos[i - 1].t) * tempos[i - 1].bpm / 60 / bpmPerMeasure;
                pushKnot(tempos[i].t, p);
            }
            if (tempos.length) {
                slopeBefore = tempos[0].bpm / 60 / bpmPerMeasure;
                slopeAfter = tempos[tempos.length - 1].bpm / 60 / bpmPerMeasure;
            }
        }

        const fallbackSlope = bpmDefault / 60 / bpmPerMeasure; // 0.5 measures/s at 120 BPM 4/4
        if (times.length === 0) { times = [0]; pos = [0]; }
        if (times.length >= 2) {
            const n = times.length;
            if (slopeBefore == null) slopeBefore = (pos[1] - pos[0]) / (times[1] - times[0]);
            if (slopeAfter == null) slopeAfter = (pos[n - 1] - pos[n - 2]) / (times[n - 1] - times[n - 2]);
        }
        if (!(slopeBefore > 0)) slopeBefore = fallbackSlope;
        if (!(slopeAfter > 0)) slopeAfter = fallbackSlope;

        function upper(arr, v) { // first index with arr[i] > v
            let lo = 0, hi = arr.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] > v) hi = mid; else lo = mid + 1; }
            return lo;
        }
        function measureAt(t) {
            const n = times.length;
            if (t <= times[0]) return pos[0] - (times[0] - t) * slopeBefore;
            if (t >= times[n - 1]) return pos[n - 1] + (t - times[n - 1]) * slopeAfter;
            const i = upper(times, t) - 1;
            return pos[i] + (t - times[i]) * (pos[i + 1] - pos[i]) / (times[i + 1] - times[i]);
        }
        function timeAtMeasure(m) {
            const n = pos.length;
            if (m <= pos[0]) return times[0] - (pos[0] - m) / slopeBefore;
            if (m >= pos[n - 1]) return times[n - 1] + (m - pos[n - 1]) / slopeAfter;
            const i = upper(pos, m) - 1;
            return times[i] + (m - pos[i]) * (times[i + 1] - times[i]) / (pos[i + 1] - pos[i]);
        }
        return { measureAt, timeAtMeasure };
    }

    // ── Engine ──────────────────────────────────────────────────────────────────

    const EVENTS = ['hit', 'miss', 'overhit', 'combo-break', 'multiplier', 'sp-phrase', 'sp-phrase-fail',
        'sp-ready', 'sp-activate', 'sp-end'];

    function Engine(chart, opts) {
        opts = opts || {};
        if (Array.isArray(chart)) chart = decodeNotes(chart, opts);
        chart = chart || { notes: [], chords: [] };
        this.opts = opts;
        this.params = mergeParams(opts.params);
        this.proDrums = opts.proDrums !== false;
        this._tempo = buildMeasureMap(opts);
        this._listeners = Object.create(null);

        const p = this.params;
        const hw = p.hitWindow;
        const srcChords = Array.isArray(chart.chords) && chart.chords.length
            ? chart.chords.slice().sort((a, b) => a.t - b.t)
            : groupNotes(Array.isArray(chart.notes) ? chart.notes : []);

        // Build engine chords (YARG parent note + child notes).
        this.chords = [];
        this._byId = new Map();
        this._alias = new Map();
        let autoId = 0;
        for (const sc of srcChords) {
            if (!sc || !Array.isArray(sc.notes) || !sc.notes.length) continue;
            const t = Number.isFinite(+sc.t) ? +sc.t : +sc.notes[0].t;
            const ec = { index: this.chords.length, t, notes: [], phrase: null, front: 0, back: 0 };
            for (const sn of sc.notes) {
                const id = sn.id != null ? sn.id : ('n' + (autoId++));
                const pad = sn.pad | 0;
                if (pad < 0 || pad > 4) continue;
                const lane = laneFor(pad, !!sn.cymbal, this.proDrums);
                const dup = ec.notes.find(x => x.lane === lane);
                if (dup) { this._alias.set(id, dup.id); continue; }
                const en = {
                    id, src: sn, lane, pad, cymbal: !!sn.cymbal,
                    dyn: sn.dyn === 'accent' || sn.dyn === 'ghost' ? sn.dyn : null,
                    chord: ec, activator: false,
                    hit: false, missed: false, autoHit: false,
                    hitTime: null, offset: null, hitVelocity: null, bonus: false,
                };
                ec.notes.push(en);
                this._byId.set(id, en);
            }
            if (ec.notes.length) this.chords.push(ec);
        }

        // Hit window per chord (GetAverageNoteDistance + CalculateHitWindow).
        const ch = this.chords;
        for (let i = 0; i < ch.length; i++) {
            const c = ch[i];
            const currentToNext = i + 1 < ch.length ? (ch[i + 1].t - c.t) / 2 : hw.maxWindow / 2;
            const prevToCurrent = i > 0 ? (c.t - ch[i - 1].t) / 2 : currentToNext;
            const full = calculateHitWindow(hw, prevToCurrent + currentToNext);
            c.front = frontEnd(hw, full, p.songSpeed);
            c.back = backEnd(hw, full, p.songSpeed);
        }

        // Star power phrases.
        this.phrases = [];
        const sp = Array.isArray(opts.starPower) ? opts.starPower.slice() : [];
        sp.sort((a, b) => (+a.start) - (+b.start));
        for (const ph of sp) {
            const start = +ph.start, end = +ph.end;
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const members = ch.filter(c => !c.phrase && c.t >= start - PHRASE_EPS && c.t < end - PHRASE_EPS);
            if (!members.length) continue;
            const phrase = { index: this.phrases.length, start, end, first: members[0], last: members[members.length - 1],
                chords: members, failed: false, awarded: false };
            for (const c of members) c.phrase = phrase;
            this.phrases.push(phrase);
        }

        // Drum fill activation phrases (SetDrumActivationFlags).
        const act = Array.isArray(opts.activation) ? opts.activation : [];
        this.activationWindows = [];
        for (const w of act) {
            const start = +w.start, end = +w.end;
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            let target = null;
            for (const c of ch) {
                if (c.t >= start - PHRASE_EPS && c.t <= end + PHRASE_EPS) target = c;
                else if (c.t > end + PHRASE_EPS) break;
            }
            if (!target) target = ch.find(c => c.t >= end) || null; // YARG: first note at/after the fill end
            if (!target) continue;
            if (p.activationType === 'all') {
                for (const n of target.notes) n.activator = true;
            } else {
                let right = target.notes[0];
                for (const n of target.notes) if (n.lane > right.lane) right = n;
                right.activator = true;
            }
            this.activationWindows.push({ start, end, chord: target });
        }
        this.manualActivation = opts.manualActivation != null ? !!opts.manualActivation : act.length === 0;

        // Chart totals (SetInitialStats / DrumsEngine constructor).
        this.totalNotes = 0;
        this.totalAccents = 0;
        this.totalGhosts = 0;
        for (const c of ch) {
            this.totalNotes += c.notes.length;
            for (const n of c.notes) {
                if (n.dyn === 'accent') this.totalAccents++;
                else if (n.dyn === 'ghost') this.totalGhosts++;
            }
        }
        const scores = this._calculateChartScores();
        this.baseScore = scores.baseScore;
        this.baseNoteScore = scores.noteScore;
        this.starThresholds = (p.starMultiplierThresholds || []).map(x => Math.floor(this.baseScore * x));

        this.reset();
    }

    Engine.prototype._pointsPerNote = function () {
        return this.proDrums ? this.params.pointsPerProNote : this.params.pointsPerNote;
    };

    // DrumsEngine.CalculateChartScores
    Engine.prototype._calculateChartScores = function () {
        const p = this.params;
        let base = 0, noteScore = 0, combo = 0;
        for (const c of this.chords) {
            const mult = Math.min(Math.floor(combo / p.notesPerMultiplier) + 1, p.maxMultiplier);
            const s = this._pointsPerNote() * c.notes.length;
            base += mult * s;
            noteScore += s;
            combo += c.notes.length;
        }
        return { baseScore: Math.round(base), noteScore: Math.round(noteScore) };
    };

    Engine.prototype.reset = function () {
        this.noteIndex = 0;
        this.currentTime = -Infinity;
        this.stats = {
            score: 0, noteScore: 0, multiplierScore: 0, starPowerScore: 0,
            combo: 0, maxCombo: 0, multiplier: 1, peakMultiplier: 1,
            notesHit: 0, notesMissed: 0, overhits: 0, overhitsByLane: {},
            dynamicsBonus: 0, accentsHit: 0, ghostsHit: 0,
            totalOffset: 0, offsetSamples: 0,
            stars: 0, starIndex: 0,
        };
        this.sp = {
            amount: 0,           // measures (full bar = params.starPowerMeasures)
            active: false,
            phrasesHit: 0,
            activations: 0,
            activationTime: null,
            lastPos: 0,
            endTime: Infinity,
            timeInStarPower: 0,
            totalGained: 0,
        };
        for (const c of this.chords) {
            for (const n of c.notes) {
                n.hit = false; n.missed = false; n.autoHit = false;
                n.hitTime = null; n.offset = null; n.hitVelocity = null; n.bonus = false;
            }
        }
        for (const ph of this.phrases) { ph.failed = false; ph.awarded = false; }
        this._updateStars();
    };

    // ── Events ──

    Engine.prototype.on = function (name, cb) {
        if (typeof cb !== 'function') return () => {};
        (this._listeners[name] || (this._listeners[name] = [])).push(cb);
        return () => this.off(name, cb);
    };
    Engine.prototype.off = function (name, cb) {
        const l = this._listeners[name];
        if (!l) return;
        if (cb === undefined) { delete this._listeners[name]; return; }
        const i = l.indexOf(cb);
        if (i >= 0) l.splice(i, 1);
    };
    Engine.prototype._emit = function (name, payload) {
        const l = this._listeners[name];
        if (!l || !l.length) return;
        for (const cb of l.slice()) {
            try { cb(payload); } catch (e) {
                if (typeof console !== 'undefined' && console.error) console.error('[DrumsEngine] listener error', name, e);
            }
        }
    };

    // ── Helpers ──

    function chordResolved(c) { return c.notes.every(n => n.hit || n.missed); }
    function chordFullyHit(c) { return c.notes.every(n => n.hit); }
    function isSp(c) { return !!(c.phrase && !c.phrase.failed); }

    Engine.prototype._fullBar = function () { return this.params.starPowerMeasures; };
    Engine.prototype._halfBar = function () { return this.params.starPowerMeasures / 2; };
    Engine.prototype._quarterBar = function () { return this.params.starPowerMeasures / 4; };
    Engine.prototype._canActivate = function () { return this.sp.amount >= this._halfBar() - SP_EPS; };

    Engine.prototype._advanceIndex = function () {
        while (this.noteIndex < this.chords.length && chordResolved(this.chords[this.noteIndex])) this.noteIndex++;
    };

    // BaseEngine.UpdateMultiplier
    Engine.prototype._updateMultiplier = function (time) {
        const p = this.params;
        let m = Math.min(Math.floor(this.stats.combo / p.notesPerMultiplier) + 1, p.maxMultiplier);
        if (this.sp.active) m *= 2;
        const prev = this.stats.multiplier;
        this.stats.multiplier = m;
        if (m > this.stats.peakMultiplier) this.stats.peakMultiplier = m;
        if (m !== prev) this._emit('multiplier', { time, multiplier: m, previous: prev });
    };

    Engine.prototype._incrementCombo = function () {
        this.stats.combo++;
        if (this.stats.combo > this.stats.maxCombo) this.stats.maxCombo = this.stats.combo;
    };

    Engine.prototype._resetCombo = function (time, reason) {
        const prev = this.stats.combo;
        this.stats.combo = 0;
        if (prev > 0) this._emit('combo-break', { time, combo: prev, reason });
    };

    // BaseEngine.AddScore(int)
    Engine.prototype._addScore = function (points) {
        const s = this.stats;
        const scored = points * s.multiplier;
        s.score += scored;
        if (this.sp.active) {
            const spScore = Math.trunc(scored / 2);
            s.starPowerScore += spScore;
            s.multiplierScore += spScore - points;
        } else {
            s.multiplierScore += scored - points;
        }
        this._updateStars();
    };

    // BaseEngine.UpdateStars
    Engine.prototype._updateStars = function () {
        const s = this.stats;
        const th = this.starThresholds || [];
        while (s.starIndex < th.length && s.score > th[s.starIndex]) s.starIndex++;
        let progress = 0;
        if (s.starIndex < th.length) {
            const prev = s.starIndex > 0 ? th[s.starIndex - 1] : 0;
            const next = th[s.starIndex];
            progress = next === prev ? 0 : clamp((s.score - prev) / (next - prev), 0, 1);
        }
        s.stars = s.starIndex + progress;
    };

    // ── Star power ──

    Engine.prototype._drainTo = function (time) {
        const sp = this.sp;
        if (!sp.active) return;
        const pos = this._tempo.measureAt(time);
        const d = pos - sp.lastPos;
        if (d > 0) {
            sp.amount -= d;
            if (sp.amount < SP_EPS) sp.amount = 0;
            sp.lastPos = pos;
        }
    };

    Engine.prototype._recomputeSpEnd = function () {
        this.sp.endTime = this._tempo.timeAtMeasure(this.sp.lastPos + this.sp.amount);
    };

    // BaseEngine.GainStarPower
    Engine.prototype._gainStarPower = function (measures, time) {
        const sp = this.sp;
        const prev = sp.amount;
        if (!sp.active && prev < this._halfBar() - SP_EPS && prev + measures >= this._halfBar() - SP_EPS) {
            this._emit('sp-ready', { time, amount: (prev + measures) / this._fullBar() });
        }
        sp.amount = Math.min(this._fullBar(), sp.amount + measures);
        sp.totalGained += measures;
        if (sp.active) this._recomputeSpEnd();
    };

    // BaseEngine.ActivateStarPower
    Engine.prototype._activateStarPower = function (time) {
        const sp = this.sp;
        if (sp.active) return false;
        sp.active = true;
        sp.activationTime = time;
        sp.lastPos = this._tempo.measureAt(time);
        this._recomputeSpEnd();
        sp.activations++;
        this._updateMultiplier(time);
        this._emit('sp-activate', { time, amount: sp.amount / this._fullBar(), endTime: sp.endTime });
        return true;
    };

    // BaseEngine.ReleaseStarPower
    Engine.prototype._releaseStarPower = function (time) {
        const sp = this.sp;
        sp.active = false;
        sp.amount = 0;
        sp.timeInStarPower += time - sp.activationTime;
        sp.endTime = Infinity;
        this._updateMultiplier(time);
        this._emit('sp-end', { time });
    };

    // BaseEngine.StripStarPower: fail the whole phrase.
    Engine.prototype._failPhrase = function (phrase, time) {
        if (!phrase || phrase.failed || phrase.awarded) return;
        phrase.failed = true;
        this._emit('sp-phrase-fail', { time, phrase: phrase.index, start: phrase.start, end: phrase.end });
    };

    // BaseEngine.AwardStarPower
    Engine.prototype._awardPhrase = function (phrase, time) {
        phrase.awarded = true;
        this.sp.phrasesHit++;
        this._gainStarPower(this._quarterBar(), time);
        this._emit('sp-phrase', { time, phrase: phrase.index, start: phrase.start, end: phrase.end,
            amount: this.sp.amount / this._fullBar() });
    };

    // ── Clock ──

    // Process note misses and the star power end up to `time`, in time order.
    Engine.prototype._advance = function (time) {
        if (!(time >= this.currentTime)) return;
        for (;;) {
            const c = this.chords[this.noteIndex];
            const missAt = c ? c.t + c.back : Infinity;
            const spEnd = this.sp.active ? this.sp.endTime : Infinity;
            if (spEnd <= time && spEnd <= missAt) {
                this._drainTo(spEnd);
                this.currentTime = Math.max(this.currentTime, spEnd);
                this._releaseStarPower(spEnd);
                continue;
            }
            if (time > missAt) {
                this._drainTo(missAt);
                this.currentTime = Math.max(this.currentTime, missAt);
                this._missChord(c, missAt);
                continue;
            }
            break;
        }
        this._drainTo(time);
        this.currentTime = time;
    };

    // YargDrumsEngine.CheckForNoteHit: the first chord was missed out the back end.
    Engine.prototype._missChord = function (c, time) {
        for (const n of c.notes) {
            if (n.hit || n.missed) continue;
            // Players may skip SP activation notes without penalty.
            if (n.activator && this._canActivate()) {
                this._hitNote(n, time, true);
                continue;
            }
            this._missNote(n, time);
        }
        this._advanceIndex();
    };

    // DrumsEngine.MissNote
    Engine.prototype._missNote = function (n, time) {
        if (n.hit || n.missed) return;
        n.missed = true;
        n.hitTime = time;
        this.stats.notesMissed++;
        if (isSp(n.chord)) this._failPhrase(n.chord.phrase, time);
        this._resetCombo(time, 'miss');
        this._updateMultiplier(time);
        this._emit('miss', { time, id: n.id, note: n.src, lane: n.lane, pad: n.pad, cymbal: n.cymbal, noteTime: n.chord.t });
        this._advanceIndex();
    };

    // BaseEngine.SkipPreviousNotes
    Engine.prototype._skipPreviousNotes = function (c, time) {
        for (let i = c.index - 1; i >= 0; i--) {
            const prev = this.chords[i];
            if (chordResolved(prev)) break;
            for (const n of prev.notes) if (!n.hit && !n.missed) this._missNote(n, time);
        }
    };

    // DrumsEngine.HitNote
    Engine.prototype._hitNote = function (n, time, autoHit) {
        if (n.hit || n.missed) return false;
        const c = n.chord;
        n.hit = true;
        n.autoHit = !!autoHit;
        n.hitTime = time;
        n.offset = time - c.t;

        this._skipPreviousNotes(c, time);

        if (isSp(c)) {
            if (this.sp.active && this.params.noStarPowerOverlap) {
                this._failPhrase(c.phrase, time);
            } else if (c === c.phrase.last && chordFullyHit(c)) {
                this._awardPhrase(c.phrase, time);
            }
        }

        if (!autoHit && n.activator && this._canActivate() && c.notes.every(x => !x.activator || x.hit)) {
            this._activateStarPower(time);
        }

        this._incrementCombo();
        this.stats.notesHit++;
        if (!autoHit) { this.stats.totalOffset += n.offset; this.stats.offsetSamples++; }
        this._updateMultiplier(time);
        const pts = this._pointsPerNote();
        this._addScore(pts);
        this.stats.noteScore += pts;

        this._advanceIndex();
        return true;
    };

    // DrumsEngine.ApplyVelocity
    Engine.prototype._applyVelocity = function (n, velocity) {
        if (!n.dyn) return false;
        if (velocity == null) return false;
        n.hitVelocity = velocity;
        const p = this.params;
        let threshold = p.velocityThreshold;
        let compare = null;
        for (let i = n.chord.index - 1; i >= 0 && !compare; i--) {
            const pc = this.chords[i];
            if (n.chord.t - pc.t > p.situationalVelocityWindow) break;
            compare = pc.notes.find(x => x.lane === n.lane && x.hitVelocity != null) || null;
        }
        if (compare) {
            const rel = compare.dyn === n.dyn ? compare.hitVelocity : compare.hitVelocity - p.velocityThreshold;
            threshold = Math.max(threshold, rel != null ? rel : 0);
        }
        if (n.dyn === 'ghost') return velocity < threshold;
        if (n.dyn === 'accent') return velocity > (1 - threshold);
        return false;
    };

    function normVelocity(v) {
        if (v == null) return null;
        v = +v;
        if (!Number.isFinite(v)) return null;
        if (v > 1) v = v / 127;
        return clamp(v, 0, 1);
    }

    // BaseEngine.WaitCountdown: a gap of >= MIN_SECONDS between notes (or song start) and the next note.
    Engine.prototype._inWaitCountdown = function (time) {
        const ch = this.chords;
        let k = this.noteIndex;
        while (k < ch.length && ch[k].t <= time) k++;
        if (k >= ch.length) return false;
        const prevEnd = k > 0 ? ch[k - 1].t : 0;
        return ch[k].t - prevEnd >= this.params.waitCountdownSeconds && time >= prevEnd && time < ch[k].t;
    };

    // DrumsEngine.Overhit. Returns null if the overhit was counted, or the reason it was ignored.
    Engine.prototype._overhit = function (time, lane, pad, cymbal) {
        if (this.noteIndex === 0) return 'before-first-note';
        if (this.noteIndex > this.chords.length - 1) return 'after-last-note';
        if (this._inWaitCountdown(time)) return 'countdown';

        const c = this.chords[this.noteIndex];
        if (isSp(c) && c !== c.phrase.first) this._failPhrase(c.phrase, time);

        this._resetCombo(time, 'overhit');
        this.stats.overhits++;
        this.stats.overhitsByLane[lane] = (this.stats.overhitsByLane[lane] || 0) + 1;
        this._updateMultiplier(time);
        this._emit('overhit', { time, pad, cymbal, lane });
        return null;
    };

    // ── Public API ──

    Engine.prototype.update = function (time) {
        time = +time;
        if (!Number.isFinite(time)) return;
        this._advance(time);
    };

    /**
     * Register a pad hit. pad: DrumsEngine.PAD value. opts.cymbal: cymbal input (pro drums only).
     * opts.velocity: 0..1 (or MIDI 1..127). Returns {type:'hit'|'overhit'|'ignored', note?, offset?, bonus?, reason?}.
     */
    Engine.prototype.hit = function (time, pad, opts) {
        opts = opts || {};
        time = +time;
        if (!Number.isFinite(time)) return { type: 'ignored', reason: 'bad-time' };
        pad = pad | 0;
        if (pad < 0 || pad > 4) return { type: 'ignored', reason: 'bad-pad' };
        if (time < this.currentTime) time = this.currentTime; // QueueInput moves stale inputs forward
        this._advance(time);

        const cymbal = !!opts.cymbal;
        const lane = laneFor(pad, cymbal, this.proDrums);
        const velocity = normVelocity(opts.velocity);

        for (let i = this.noteIndex; i < this.chords.length; i++) {
            const c = this.chords[i];
            if (time < c.t + c.front || time > c.t + c.back) break; // you can't skip past a note outside the window
            for (const n of c.notes) {
                if (n.lane !== lane) continue;
                if (n.hit || n.missed) return { type: 'ignored', reason: 'already-hit', note: n.src };
                const bonus = this._applyVelocity(n, velocity);
                this._hitNote(n, time, false);
                if (bonus) {
                    this._addScore(this.params.velocityBonus);
                    this.stats.dynamicsBonus += this.params.velocityBonus;
                    if (n.dyn === 'accent') this.stats.accentsHit++;
                    else if (n.dyn === 'ghost') this.stats.ghostsHit++;
                }
                n.bonus = bonus;
                this._emit('hit', {
                    time, id: n.id, note: n.src, lane: n.lane, pad: n.pad, cymbal: n.cymbal,
                    noteTime: c.t, offset: n.offset, bonus, velocity,
                    combo: this.stats.combo, multiplier: this.stats.multiplier, score: this.stats.score,
                });
                return { type: 'hit', note: n.src, id: n.id, offset: n.offset, bonus };
            }
        }

        const reason = this._overhit(time, lane, pad, cymbal);
        if (reason === null) return { type: 'overhit' };
        return { type: 'ignored', reason };
    };

    Engine.prototype.activateStarPower = function (time) {
        time = +time;
        if (Number.isFinite(time)) {
            if (time < this.currentTime) time = this.currentTime;
            this._advance(time);
        } else {
            time = this.currentTime;
        }
        if (!this.manualActivation) return false;
        if (this.sp.active || !this._canActivate()) return false;
        return this._activateStarPower(time);
    };

    Engine.prototype.getState = function () {
        const s = this.stats;
        const sp = this.sp;
        const resolved = s.notesHit + s.notesMissed;
        return {
            score: s.score,
            combo: s.combo,
            maxCombo: s.maxCombo,
            multiplier: s.multiplier,
            maxMultiplier: this.params.maxMultiplier,
            peakMultiplier: s.peakMultiplier,
            notesHit: s.notesHit,
            notesMissed: s.notesMissed,
            totalNotes: this.totalNotes,
            overhits: s.overhits,
            accuracy: resolved > 0 ? s.notesHit / resolved : 1,
            percent: this.totalNotes === 0 ? 1 : s.notesHit / this.totalNotes,
            stars: s.stars,
            starThresholds: this.starThresholds.slice(),
            baseScore: this.baseScore,
            dynamicsBonus: s.dynamicsBonus,
            starPowerScore: s.starPowerScore,
            accentsHit: s.accentsHit,
            ghostsHit: s.ghostsHit,
            totalAccents: this.totalAccents,
            totalGhosts: this.totalGhosts,
            averageOffset: s.offsetSamples ? s.totalOffset / s.offsetSamples : 0,
            fullCombo: s.notesMissed === 0 && s.overhits === 0 && s.notesHit === this.totalNotes,
            time: this.currentTime,
            starPower: {
                amount: sp.amount / this._fullBar(),
                active: sp.active,
                canActivate: this._canActivate() && !sp.active,
                phrasesHit: sp.phrasesHit,
                phrasesTotal: this.phrases.length,
                activations: sp.activations,
                endTime: sp.active ? sp.endTime : null,
                timeInStarPower: sp.timeInStarPower + (sp.active ? Math.max(0, this.currentTime - sp.activationTime) : 0),
            },
        };
    };

    Engine.prototype._note = function (id) {
        if (this._alias.has(id)) id = this._alias.get(id);
        return this._byId.get(id) || null;
    };

    Engine.prototype.noteState = function (id) {
        const n = this._note(id);
        if (!n) return null;
        return n.hit ? 'hit' : (n.missed ? 'miss' : null);
    };

    Engine.prototype.noteInfo = function (id) {
        const n = this._note(id);
        if (!n) return null;
        return {
            state: n.hit ? 'hit' : (n.missed ? 'miss' : null),
            offset: n.hit ? n.offset : null,
            time: n.hitTime,
            velocity: n.hitVelocity,
            bonus: n.bonus,
            autoHit: n.autoHit,
            starPower: isSp(n.chord),
            activator: n.activator,
            lane: n.lane,
        };
    };

    Engine.prototype.isStarPowerNote = function (id) {
        const n = this._note(id);
        return !!(n && isSp(n.chord));
    };

    Engine.prototype.isActivatorNote = function (id) {
        const n = this._note(id);
        return !!(n && n.activator);
    };

    Engine.prototype.hitWindow = function () {
        const c = this.chords[this.noteIndex];
        if (c) return { front: c.front, back: c.back };
        const hw = this.params.hitWindow;
        return { front: frontEnd(hw, hw.maxWindow, this.params.songSpeed), back: backEnd(hw, hw.maxWindow, this.params.songSpeed) };
    };

    function create(chart, opts) { return new Engine(chart, opts); }

    return {
        PAD,
        LANE,
        MIDI_MAP,
        PRESETS,
        EVENTS,
        POINTS_PER_NOTE,
        POINTS_PER_PRO_NOTE,
        decodeNotes,
        padFromMidi,
        laneFor,
        create,
        defaultParams,
        calculateHitWindow,
        buildMeasureMap,
        Engine,
    };
});
