/*
 * session.js: chart model, difficulty levels and the scoring session for the feedBack drums plugin
 * (MIT, original code).
 *
 * Shared by both views (screen.js loads it lazily as a plain script). No DOM, no THREE. Exported on
 * window.DrumsSession (browser) and module.exports (Node tests):
 *  - Pure helpers: chart flattening, gem classification, drum_tab gameplay metadata (star power,
 *    fills, solos, difficulty levels: feedpak 1.20.0), difficulty availability / fallback / labels,
 *    auto lanes, HUD formatting, MIDI -> pad mapping, timing helpers.
 *  - createSession(DrumsEngine, opts): owns the engine (engine.js, LGPL-3.0, used only through its
 *    public API) for one chart. Builds it from wire notes, applies star power / fill metadata,
 *    rebuilds on seeks, adds the bonus score (spot-on timing, rolls, drum solos) and queues engine
 *    events for the view.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.DrumsSession = api;
    else if (root) root.DrumsSession = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── Constants ───────────────────────────────────────────────────────────

    // Engine pads (engine.js PAD). Lane index = pad - 1 for the four pad lanes; the kick has no lane.
    const PAD = Object.freeze({ KICK: 0, RED: 1, YELLOW: 2, BLUE: 3, GREEN: 4 });
    const LANE_NAMES = Object.freeze(['red', 'yellow', 'blue', 'green']);

    // Lane / gem colours (0xRRGGBB). One place to tweak the look (both views).
    const LANE_COLORS = Object.freeze({
        red: 0xff2b3d,
        yellow: 0xffcc1f,
        blue: 0x2b8bff,
        green: 0x27d65c,
    });
    const COLORS = Object.freeze({
        kick: 0xff8a14,
        kick2x: 0xff4fc8,
        starPowerGem: 0xdcf1ff,     // silver-white with a blue tint
        starPowerEdge: 0x86ddff,
        activator: 0x6dffb6,
        fill: 0x38ffa8,
        miss: 0xff2424,
        missedGem: 0x3b3b48,
        background: 0x05060c,
        track: 0x0c0f1c,
        rail: 0x3a4a78,
        beat: 0x8090c0,
        measure: 0xd0dcff,
        strike: 0xe8ecff,
    });

    // screen.js lane ids (Learn / custom mapping) -> engine pad.
    const LANE_ID_TO_PAD = Object.freeze({
        kick: { pad: PAD.KICK, cymbal: false },
        snare: { pad: PAD.RED, cymbal: false },
        hihat: { pad: PAD.YELLOW, cymbal: true },
        tom1: { pad: PAD.YELLOW, cymbal: false },
        tom2: { pad: PAD.BLUE, cymbal: false },
        tom3: { pad: PAD.GREEN, cymbal: false },
        ride: { pad: PAD.BLUE, cymbal: true },
        crash: { pad: PAD.GREEN, cymbal: true },
    });

    // Seeks: a jump larger than this (seconds) rebuilds the engine from the new position.
    const SEEK_BACK = 0.25;
    const SEEK_FORWARD = 1.5;
    // The engine runs this far (seconds) behind the frame clock, so a pad hit timestamped a little
    // before the latest frame is judged at its own time (see createSession update()).
    const INPUT_GRACE = 0.06;
    // Hits kept for the early/late timing meter.
    const TIMING_SAMPLES = 24;
    // Input offset range (ms), same as the settings panel.
    const INPUT_OFFSET_MIN = -250, INPUT_OFFSET_MAX = 250;

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function defaultNow() {
        return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
            ? performance.now() : Date.now();
    }

    // ── Pure helpers: chart ─────────────────────────────────────────────────

    /**
     * Flatten bundle.notes + bundle.chords into one wire-note list. Chord notes take the chord's
     * time. Visual-only notes (drum_tab flam graces, `_noScore`) are left out.
     */
    function collectWireNotes(notes, chords) {
        const out = [];
        if (Array.isArray(notes)) {
            for (const n of notes) if (n && typeof n === 'object' && !n._noScore) out.push(n);
        }
        if (Array.isArray(chords)) {
            for (const c of chords) {
                if (!c || !Array.isArray(c.notes)) continue;
                for (const cn of c.notes) {
                    if (!cn || typeof cn !== 'object' || cn._noScore) continue;
                    const t = Number.isFinite(+cn.t) ? +cn.t : +c.t;
                    out.push(cn.t === t ? cn : Object.assign({}, cn, { t }));
                }
            }
        }
        return out;
    }

    /**
     * Classify a decoded drum note (DrumsEngine.decodeNotes output: {pad, cymbal, kick2x, dyn}) into
     * its gem: kind 'kick' | 'kick2x' | 'pad' | 'cymbal', lane 0..3 (-1 for the kick), dynamics and
     * the base colour.
     */
    function classifyNote(n, opts) {
        if (!n || typeof n !== 'object') return null;
        const pro = !(opts && opts.pro === false);
        const pad = n.pad | 0;
        if (pad < 0 || pad > 4) return null;
        const accent = n.dyn === 'accent';
        const ghost = n.dyn === 'ghost';
        if (pad === PAD.KICK) {
            const kick2x = !!n.kick2x;
            return { kind: kick2x ? 'kick2x' : 'kick', lane: -1, cymbal: false, kick2x, accent, ghost,
                color: kick2x ? COLORS.kick2x : COLORS.kick };
        }
        const lane = pad - 1;
        // Non-pro drums (opts.pro === false): no cymbals, every Y/B/G note is a plain pad.
        const cymbal = pro && !!n.cymbal && pad !== PAD.RED;
        return { kind: cymbal ? 'cymbal' : 'pad', lane, cymbal, kick2x: false, accent, ghost,
            color: LANE_COLORS[LANE_NAMES[lane]] };
    }

    /**
     * Render model: one gem per decoded note, sorted by time, keyed by the engine note id.
     * opts.pro === false (non-pro drums) draws cymbals as pads and, like the engine, keeps one
     * gem when a tom and a cymbal of the same colour land together (< 1 ms apart).
     */
    function buildGems(decoded, opts) {
        const notes = decoded && Array.isArray(decoded.notes) ? decoded.notes : [];
        const pro = !(opts && opts.pro === false);
        const gems = [];
        for (const n of notes) {
            const c = classifyNote(n, opts);
            if (!c) continue;
            c.id = n.id;
            c.t = n.t;
            c.pad = n.pad | 0;
            c.chartCymbal = !!n.cymbal;   // the chart's cymbal marking, even when non-pro draws it as a pad
            c.auto = isAutoNote(c.pad, c.chartCymbal, opts && opts.auto);
            gems.push(c);
        }
        gems.sort((a, b) => a.t - b.t);
        if (pro) return gems;
        const out = [];
        for (const g of gems) {
            let dup = false;
            for (let i = out.length - 1; i >= 0 && g.t - out[i].t < 0.001; i--) {
                if (out[i].lane === g.lane && out[i].kind === g.kind) { dup = true; break; }
            }
            if (!dup) out.push(g);
        }
        return out;
    }

    /** [i0, i1) of the gems with t0 <= t < t1 (gems sorted by t). */
    function visibleRange(gems, t0, t1) {
        let lo = 0, hi = gems.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (gems[m].t < t0) lo = m + 1; else hi = m; }
        const i0 = lo;
        hi = gems.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (gems[m].t < t1) lo = m + 1; else hi = m; }
        return [i0, lo];
    }

    /** bundle.beats ([{time, measure}] or numbers) -> [{t, measure: bool}] sorted. */
    function normalizeBeats(beats) {
        if (!Array.isArray(beats)) return [];
        const out = [];
        for (const b of beats) {
            if (b == null) continue;
            if (typeof b === 'number') { if (Number.isFinite(b)) out.push({ t: b, measure: false }); continue; }
            const t = +(b.time != null ? b.time : b.t);
            if (!Number.isFinite(t)) continue;
            out.push({ t, measure: b.measure != null && +b.measure >= 0 });
        }
        out.sort((a, b) => a.t - b.t);
        return out;
    }

    // ── Pure helpers: auto lanes (accessibility) ────────────────────────────
    //
    // Auto kick / auto cymbals take those notes off the player: they are left out of the chart the
    // engine scores (YARG "no kicks" style, so score / accuracy / streak only count what you play),
    // still drawn (dimmed) and flash at the strikeline as if played, and pad hits on them are ignored.
    // The setting is a difficulty ceiling: 'off' | 'easy' | 'medium' | 'hard' | 'all' = on at that
    // difficulty and the ones below it.

    const AUTO_LEVELS = Object.freeze(['off', 'easy', 'medium', 'hard', 'all']);

    function normalizeAutoLevel(raw) {
        return typeof raw === 'string' && AUTO_LEVELS.includes(raw) ? raw : 'off';
    }

    /** Is an auto setting on at this difficulty? */
    function autoAppliesAt(level, difficultyId) {
        level = normalizeAutoLevel(level);
        if (level === 'off') return false;
        if (level === 'all') return true;
        return DIFFICULTIES.indexOf(normalizeDifficulty(difficultyId)) <= DIFFICULTIES.indexOf(level);
    }

    /** {kick, cymbals} booleans for the difficulty being played. */
    function autoFor(settings, difficultyId) {
        settings = settings || {};
        return {
            kick: autoAppliesAt(settings.kick, difficultyId),
            cymbals: autoAppliesAt(settings.cymbals, difficultyId),
        };
    }

    function normalizeAuto(auto) {
        return { kick: !!(auto && auto.kick), cymbals: !!(auto && auto.cymbals) };
    }

    /** A chart note (engine pad + the chart's cymbal marking) the player does not have to hit. */
    function isAutoNote(pad, cymbal, auto) {
        if (!auto) return false;
        if (auto.kick && pad === PAD.KICK) return true;
        return !!(auto.cymbals && cymbal && pad >= PAD.YELLOW);
    }

    /** First index of a gem with g.t > t (gems sorted by t). */
    function firstAfter(gems, t) {
        let lo = 0, hi = gems.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (gems[m].t <= t) lo = m + 1; else hi = m; }
        return lo;
    }

    // ── Pure helpers: drum_tab gameplay metadata (feedpak 1.20.0) ───────────

    /** A drum_tab range list ([{start_time, end_time}]) -> sorted [{start, end}], malformed entries dropped. */
    function _ranges(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const p of list) {
            if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
            const start = +p.start_time, end = +p.end_time;
            if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
            out.push({ start, end });
        }
        out.sort((a, b) => a.start - b.start);
        return out;
    }

    /**
     * The gameplay metadata of a drum tab (bundle.drumTab, as core streams it): star power, fills
     * (star power activation), solos and the easier difficulty levels. `toNotes` converts drum_tab
     * hits into wire notes (screen.js _drumTabHitsToNotes) so a level plays exactly like the Expert
     * chart. Returns null when the tab carries none of it (a pre-1.20.0 tab, or a core that does not
     * stream it yet): the song then plays Expert only, without star power.
     * Output is in DrumsEngine.create option shape: starPower / activation as [{start, end}].
     */
    function parseDrumTabMeta(tab, toNotes) {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return null;
        const starPower = _ranges(tab.star_power);
        const activation = _ranges(tab.fills);
        const solos = _ranges(tab.solos);
        let levels = null;
        const generated = [];
        const raw = tab.levels;
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof toNotes === 'function') {
            for (const id of LOWER_LEVELS) {
                const lv = Object.prototype.hasOwnProperty.call(raw, id) ? raw[id] : null;
                if (!lv || typeof lv !== 'object' || !Array.isArray(lv.hits)) continue;
                const notes = toNotes(lv.hits);
                if (!Array.isArray(notes) || !notes.length) continue;
                (levels || (levels = {}))[id] = notes;
                if (lv.generated === true) generated.push(id);
            }
        }
        if (!starPower.length && !activation.length && !solos.length && !levels) return null;
        return {
            pro: true,                    // drum_tab pieces always say cymbal vs tom
            starPower,
            activation,
            solos,
            levels,                       // {easy?, medium?, hard?}: wire notes, or null
            levelsGenerated: generated,   // lower levels reduced by software rather than hand-charted
        };
    }

    // ── Pure helpers: difficulty levels ─────────────────────────────────────
    //
    // The drum tab's `hits[]` (or the legacy GM-encoded notes) are the full chart. Expert+ = all of
    // it; plain Expert drops the double-kick notes (drum_tab `x2`, GM 35 on the wire). Easy / Medium /
    // Hard come from the tab's `levels` (parseDrumTabMeta) when the chart has them.

    const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'expert', 'expert_plus']);
    const LOWER_LEVELS = Object.freeze(['easy', 'medium', 'hard']);
    const DEFAULT_DIFFICULTY = 'expert';
    const DIFFICULTY_LABELS = Object.freeze({
        easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', expert: 'EXPERT', expert_plus: 'EXPERT+',
    });
    const DIFFICULTY_NAMES = Object.freeze({
        easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', expert_plus: 'Expert+',
    });
    const DIFFICULTY_COLORS = Object.freeze({
        easy: '#4be37a', medium: '#ffd23f', hard: '#ff8a3d', expert: '#ff4b5c', expert_plus: '#ff4fc8',
    });
    const KICK2X_MIDI = 35;

    /** A stored / user-supplied difficulty id, or the default ('expert') when it is not a known id. */
    function normalizeDifficulty(raw) {
        return typeof raw === 'string' && DIFFICULTIES.includes(raw) ? raw : DEFAULT_DIFFICULTY;
    }

    function _wireGm(n) {
        if (n.midi != null && Number.isFinite(+n.midi)) return +n.midi;
        return ((n.s | 0) * 24) + (n.f | 0);
    }

    /** True when the wire chart (notes + chords) has 2x kick (GM 35) notes. */
    function hasKick2x(notes, chords) {
        if (Array.isArray(notes)) {
            for (const n of notes) if (n && typeof n === 'object' && _wireGm(n) === KICK2X_MIDI) return true;
        }
        if (Array.isArray(chords)) {
            for (const c of chords) {
                if (!c || !Array.isArray(c.notes)) continue;
                for (const n of c.notes) if (n && typeof n === 'object' && _wireGm(n) === KICK2X_MIDI) return true;
            }
        }
        return false;
    }

    /** Notes / chords without the 2x kick notes. Returns the same arrays when there are none. */
    function stripKick2x(notes, chords) {
        if (!hasKick2x(notes, chords)) return { notes, chords };
        const keep = (n) => !(n && typeof n === 'object' && _wireGm(n) === KICK2X_MIDI);
        const outNotes = Array.isArray(notes) ? notes.filter(keep) : notes;
        let outChords = chords;
        if (Array.isArray(chords)) {
            outChords = [];
            for (const c of chords) {
                if (!c || !Array.isArray(c.notes)) { outChords.push(c); continue; }
                const cn = c.notes.filter(keep);
                if (cn.length === c.notes.length) outChords.push(c);
                else if (cn.length) outChords.push(Object.assign({}, c, { notes: cn }));
            }
        }
        return { notes: outNotes, chords: outChords };
    }

    /**
     * Which difficulties the loaded chart offers.
     *   ctx.meta   parseDrumTabMeta() output (or null)
     *   ctx.has2x  the full chart has double-kick notes (hasKick2x)
     * -> [{id, label, name, available, reason, generated}] in DIFFICULTIES order. Expert is always
     * available; Expert+ needs double-kick notes; Easy/Medium/Hard need the tab's levels.
     */
    function difficultyOptions(ctx) {
        ctx = ctx || {};
        const meta = ctx.meta || null;
        const levels = meta && meta.levels ? meta.levels : null;
        const gen = meta && Array.isArray(meta.levelsGenerated) ? meta.levelsGenerated : [];
        return DIFFICULTIES.map((id) => {
            const o = { id, label: DIFFICULTY_LABELS[id], name: DIFFICULTY_NAMES[id], available: true, reason: '', generated: false };
            if (id === 'expert') return o;
            if (id === 'expert_plus') {
                if (!ctx.has2x) {
                    o.available = false;
                    o.reason = 'No double-kick notes in this chart';
                }
                return o;
            }
            const lv = levels && Array.isArray(levels[id]) ? levels[id] : null;
            if (lv && lv.length) {
                o.generated = gen.includes(id);
                return o;
            }
            o.available = false;
            if (!levels) o.reason = 'This chart only has Expert';
            else o.reason = 'This chart has no ' + o.name + ' part';
            return o;
        });
    }

    /**
     * Pick the difficulty to play: the saved choice when the chart has it, otherwise Expert
     * (the saved preference itself is left alone). -> {id, requested, fallback, reason}.
     */
    function resolveDifficulty(saved, options) {
        const requested = normalizeDifficulty(saved);
        const opts = Array.isArray(options) ? options : [];
        const want = opts.find(o => o && o.id === requested);
        if (!want || want.available) return { id: requested, requested, fallback: false, reason: '' };
        return { id: DEFAULT_DIFFICULTY, requested, fallback: true, reason: want.reason || '' };
    }

    /** The next available difficulty up (dir > 0) or down (dir < 0), wrapping around. */
    function nextDifficulty(current, options, dir) {
        const avail = DIFFICULTIES.filter(id => {
            const o = Array.isArray(options) ? options.find(x => x && x.id === id) : null;
            return !o || o.available;
        });
        if (!avail.length) return normalizeDifficulty(current);
        const step = dir < 0 ? -1 : 1;
        let i = DIFFICULTIES.indexOf(normalizeDifficulty(current));
        for (let k = 0; k < DIFFICULTIES.length; k++) {
            i = (i + step + DIFFICULTIES.length) % DIFFICULTIES.length;
            if (avail.includes(DIFFICULTIES[i])) return DIFFICULTIES[i];
        }
        return normalizeDifficulty(current);
    }

    /** 'hard' -> 'HARD'; generated levels get an AUTO marker ('HARD · AUTO'). */
    function difficultyLabel(id, generated) {
        const base = DIFFICULTY_LABELS[normalizeDifficulty(id)];
        return generated ? base + ' · AUTO' : base;
    }

    /**
     * HUD badge for a resolved difficulty: {id, text, sub, color, title}. `sub` is 'AUTO' for an
     * auto-generated level; `title` explains a fallback.
     */
    function difficultyBadge(resolved, options) {
        const id = resolved ? normalizeDifficulty(resolved.id) : DEFAULT_DIFFICULTY;
        const o = Array.isArray(options) ? options.find(x => x && x.id === id) : null;
        const generated = !!(o && o.generated);
        let title = 'Drum difficulty: ' + DIFFICULTY_NAMES[id] + (generated ? ' (auto-generated from Expert)' : '');
        if (resolved && resolved.fallback) {
            title += '. ' + DIFFICULTY_NAMES[resolved.requested] + ' is not available for this song'
                + (resolved.reason ? ' (' + resolved.reason + ')' : '');
        }
        return {
            id,
            text: DIFFICULTY_LABELS[id],
            sub: generated ? 'AUTO' : null,
            color: DIFFICULTY_COLORS[id],
            fallback: !!(resolved && resolved.fallback),
            title,
        };
    }

    /**
     * Wire chart for a difficulty: Expert+ = the chart's notes/chords as they are, Expert = the same
     * without double-kick notes, Easy/Medium/Hard = the tab's level (no chords). Unknown /
     * unavailable lower levels fall back to Expert.
     */
    function difficultyChart(id, notes, chords, meta) {
        id = normalizeDifficulty(id);
        if (id === 'expert_plus') return { id, notes, chords };
        if (LOWER_LEVELS.includes(id)) {
            const lv = meta && meta.levels && Array.isArray(meta.levels[id]) ? meta.levels[id] : null;
            if (lv && lv.length) return { id, notes: lv, chords: [] };
            id = 'expert';
        }
        const s = stripKick2x(notes, chords);
        return { id, notes: s.notes, chords: s.chords };
    }

    // ── Pure helpers: input ─────────────────────────────────────────────────

    /**
     * Difficulty shortcut: D = next harder difficulty, Shift+D = next easier (both views). D is not a
     * drum key and not a core player shortcut. -> {dir: 1 | -1} or null.
     */
    function isDifficultyKey(e) {
        if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
        const code = typeof e.code === 'string' ? e.code : '';
        const key = typeof e.key === 'string' ? e.key : '';
        if (code !== 'KeyD' && !(code === '' && key.toLowerCase() === 'd')) return null;
        return { dir: e.shiftKey ? -1 : 1 };
    }

    /**
     * MIDI note -> engine pad. A Learn / custom mapping entry for the note wins (its lane id is
     * translated with LANE_ID_TO_PAD); otherwise the General MIDI map (DrumsEngine.padFromMidi).
     * The 2D lane preset is ignored on purpose: scoring always uses the 4-lane pro-drums layout.
     */
    function midiToPad(midi, customMapping, padFromMidi) {
        midi = midi | 0;
        if (midi < 0 || midi > 127) return null;
        if (customMapping && typeof customMapping === 'object'
            && Object.prototype.hasOwnProperty.call(customMapping, midi)) {
            const m = LANE_ID_TO_PAD[customMapping[midi]];
            if (m) return { pad: m.pad, cymbal: m.cymbal };
        }
        return typeof padFromMidi === 'function' ? (padFromMidi(midi) || null) : null;
    }

    /** True for elements that take typed text (keyboard drumming must not steal their keys). */
    function isTypingTarget(el) {
        if (!el || typeof el !== 'object') return false;
        if (el.isContentEditable) return true;
        const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') {
            const type = String(el.type || 'text').toLowerCase();
            return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(type);
        }
        return false;
    }

    /**
     * Song time of an input event that arrived between frames. bundle.currentTime only advances once
     * per frame, so extrapolate from the last two frames while playback is running (up to 60 ms).
     */
    function estimateTime(clock, nowWall) {
        if (!clock || !Number.isFinite(clock.time)) return NaN;
        const { time, wall, prevTime, prevWall } = clock;
        if (!Number.isFinite(prevTime) || !Number.isFinite(wall) || !Number.isFinite(prevWall)) return time;
        const dw = (wall - prevWall) / 1000;
        const dt = time - prevTime;
        if (!(dw > 0) || dw > 0.25 || !(dt > 0)) return time; // paused, stalled or seeking
        const rate = clamp(dt / dw, 0.1, 4);
        const ahead = clamp((nowWall - wall) / 1000, 0, 0.06);
        return time + ahead * rate;
    }

    /**
     * Smoothed song clock for one highway (the pattern core's 3D highway uses for its own clock).
     * bundle.currentTime is the audio time sampled by the player's tick, so it steps unevenly from
     * frame to frame and is up to a frame old by the time a pad hit is handled. The clock anchors on
     * every new sample, measures the playback rate between samples, and interpolates from there:
     *  - tick(raw, isPlaying, perfNow): the time to draw / score this frame;
     *  - at(perfNow): the song time at another moment (e.g. when a MIDI message arrived), extrapolated
     *    up to 100 ms forward or 250 ms back from the last sample; the raw time while paused.
     * isPlaying is core's bundle.isPlaying (false = paused / stalled / seeking; undefined on older
     * hosts, where a sample older than 100 ms counts as stalled).
     */
    function createFrameClock() {
        let anchorT = NaN, anchorP = NaN, rate = 1, raw = NaN, playing = false;
        function reset() { anchorT = anchorP = raw = NaN; rate = 1; playing = false; }
        function tick(rawTime, isPlaying, perfNow) {
            rawTime = +rawTime;
            const p = Number.isFinite(perfNow) ? perfNow : defaultNow();
            if (!Number.isFinite(rawTime)) return NaN;
            raw = rawTime;
            if (isPlaying === false) {
                anchorT = rawTime; anchorP = p; rate = 1; playing = false;
                return rawTime;
            }
            if (rawTime !== anchorT) {
                if (Number.isFinite(anchorP)) {
                    const dP = (p - anchorP) / 1000;
                    if (dP > 0.001 && dP < 0.5) {
                        const r = (rawTime - anchorT) / dP;
                        rate = (r > 0.05 && r < 5) ? r : 1;   // seek / loop: start over at 1x
                    } else if (dP >= 0.5) rate = 1;          // long gap (paused, tab hidden)
                }
                anchorT = rawTime; anchorP = p; playing = true;
                return rawTime;
            }
            // Same sample as last frame: interpolate, unless the clock has stalled.
            const dt = (p - anchorP) / 1000;
            if (dt > 0.1) { playing = false; return rawTime; }
            if (dt <= 0) return rawTime;
            return anchorT + rate * dt;
        }
        function at(perfNow) {
            if (!playing || !Number.isFinite(anchorT)) return raw;
            const p = Number.isFinite(perfNow) ? perfNow : defaultNow();
            return anchorT + rate * clamp((p - anchorP) / 1000, -0.25, 0.1);
        }
        reset();
        return { tick, at, reset, get rate() { return rate; }, get playing() { return playing; } };
    }

    /** True when the playhead jumped (seek, loop restart) and the engine must be rebuilt. */
    function isSeek(prevTime, time) {
        if (!Number.isFinite(prevTime) || !Number.isFinite(time)) return false;
        return time < prevTime - SEEK_BACK || time > prevTime + SEEK_FORWARD;
    }

    // ── Pure helpers: HUD ───────────────────────────────────────────────────

    function formatScore(n) {
        n = Math.max(0, Math.floor(+n || 0));
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatAccuracy(acc) {
        if (!Number.isFinite(+acc)) return '--';
        return (clamp(+acc, 0, 1) * 100).toFixed(1) + '%';
    }

    /** Multiplier badge colour: x1 grey, x2 yellow, x3 green, x4 violet, star power (x>4 or SP) cyan. */
    function multiplierColor(mult, spActive) {
        if (spActive || mult > 4) return '#7fe6ff';
        if (mult >= 4) return '#c77dff';
        if (mult === 3) return '#4be37a';
        if (mult === 2) return '#ffd23f';
        return '#c8ccd8';
    }

    /** Stars earned and progress toward the next one (0..1). 6 stars = gold. */
    function starProgress(state) {
        const th = state && Array.isArray(state.starThresholds) ? state.starThresholds : [];
        const score = state ? +state.score || 0 : 0;
        let count = 0;
        while (count < th.length && score >= th[count]) count++;
        if (count >= th.length) return { count, frac: 1, gold: th.length > 0 && count >= 6 };
        const prev = count > 0 ? th[count - 1] : 0;
        const next = th[count];
        const frac = next > prev ? clamp((score - prev) / (next - prev), 0, 1) : 0;
        return { count, frac, gold: false };
    }

    /** Strings + numbers the HUD draws, from DrumsEngine.getState() (null state -> zeros). */
    function hudModel(state) {
        const s = state || {};
        const sp = s.starPower || {};
        const mult = s.multiplier || 1;
        const notesPerMult = 10;
        const maxBase = s.maxMultiplier || 4;
        const baseMult = sp.active ? mult / 2 : mult;
        const progress = baseMult >= maxBase ? 1 : ((s.combo || 0) % notesPerMult) / notesPerMult;
        const stars = starProgress(s);
        return {
            score: formatScore(s.score),
            multiplier: mult,
            multiplierText: 'x' + mult,
            multiplierColor: multiplierColor(mult, !!sp.active),
            multiplierProgress: progress,
            streak: s.combo || 0,
            streakText: String(s.combo || 0),
            accuracy: formatAccuracy(s.accuracy != null ? s.accuracy : 1),
            hitsText: (s.notesHit || 0) + ' / ' + (s.totalNotes || 0),
            stars: stars.count,
            starFrac: stars.frac,
            gold: stars.gold,
            spAmount: clamp(+sp.amount || 0, 0, 1),
            spActive: !!sp.active,
            spReady: !!sp.canActivate,
            fullCombo: !!s.fullCombo,
        };
    }

    /**
     * Early/late timing meter model. offsets: hit time minus note time in ms (+ = late), oldest
     * first, as session.getBonus().offsets gives them; currentOffsetMs: the input offset in use.
     * -> {count, median, state: 'waiting'|'early'|'late'|'ok', label, suggest}. `suggest` is the
     * input offset that would centre the hits (after at least `minHits` hits and when the median is
     * at least `deadMs` off), else null. Hits are already offset-corrected, so a late median
     * raises the offset by that much.
     */
    function timingSummary(offsets, currentOffsetMs, o) {
        o = o || {};
        const minHits = o.minHits || 6, deadMs = o.deadMs != null ? o.deadMs : 10;
        const list = Array.isArray(offsets) ? offsets.filter(Number.isFinite) : [];
        const cur = Number.isFinite(+currentOffsetMs) ? Math.round(+currentOffsetMs) : 0;
        if (!list.length) return { count: 0, median: null, state: 'waiting', label: 'waiting for hits', suggest: null, current: cur };
        const srt = list.slice().sort((a, b) => a - b), mid = srt.length >> 1;
        const median = srt.length % 2 ? srt[mid] : (srt[mid - 1] + srt[mid]) / 2;
        const off = Math.abs(median) >= deadMs;
        const state = !off ? 'ok' : (median < 0 ? 'early' : 'late');
        const label = !off ? 'ON TIME' : (median > 0 ? '+' : '') + Math.round(median) + ' ms ' + (median < 0 ? 'EARLY' : 'LATE');
        const suggest = list.length >= minHits && off
            ? clamp(Math.round(cur + median), INPUT_OFFSET_MIN, INPUT_OFFSET_MAX) : null;
        return { count: list.length, median, state, label, suggest: suggest === cur ? null : suggest, current: cur };
    }

    /**
     * Star power hint for the HUD: how the player activates star power when it is ready, or null.
     * With fills in the chart the fill-end note activates it; without fills (manual activation) a
     * key / pad does. spPadName: the configured star power pad's name, or ''.
     */
    function starPowerHint(meta, state, spPadName) {
        const sp = state && state.starPower;
        if (!sp || !sp.canActivate || sp.active) return null;
        if (meta && Array.isArray(meta.activation) && meta.activation.length) return 'Hit the note at the end of the fill to activate';
        return 'Press Enter' + (spPadName ? ' or hit ' + spPadName : '') + ' to activate star power';
    }

    // ── Session: the engine for one chart ───────────────────────────────────

    function normalizeInputOffset(ms) {
        const n = Math.round(Number(ms));
        return Number.isFinite(n) ? clamp(n, INPUT_OFFSET_MIN, INPUT_OFFSET_MAX) : 0;
    }

    /**
     * createSession(DrumsEngine, {now, inputOffsetMs, ...}) -> session. load() a chart (wire notes
     * + beats), optionally setMeta() the drums block, then update(time) every frame and
     * hit()/activate() on input. drainEvents() hands queued visual events ({type, pad, cymbal, sp,
     * wall}) to the view.
     *
     * Times passed to update(), hit() and activate() are on the highway's clock (what the player
     * sees). The session subtracts the input offset from all of them alike, so with a positive
     * offset a hit that registers late is compared against an engine that has not yet moved past
     * its note.
     */
    function createSession(Engine, opts) {
        opts = opts || {};
        const now = typeof opts.now === 'function' ? opts.now : defaultNow;
        const MAX_EVENTS = 256;
        const s = {
            decoded: null, gems: [], beats: [], rawBeats: null, meta: null, engine: null,
            lastTime: null, lastFrame: null, events: [], builds: 0,
            proWanted: opts.proDrums !== false,   // the player's "Pro cymbals" setting
            auto: normalizeAuto(opts.auto),       // {kick, cymbals}: lanes played for the player
            params: opts.params || null,          // engine params override (hit window)
            bonus: null,                          // Rock Band-style extras on top of the engine score
            offset: normalizeInputOffset(opts.inputOffsetMs) / 1000,   // input offset (s)
            onHit: null,
        };
        // Highway time -> player time (the input offset applied).
        const playerTime = (t) => +t - s.offset;

        // ── Bonus score (on top of the engine's score) ──
        //  - timing: +10 x multiplier for a hit within 25 ms of the note;
        //  - rolls: snare/tom notes in a fast run (>= 4 within +-0.25 s, i.e. 8 per
        //    second) earn +25 x multiplier; a run of >= 8 pops "ROLL h/n +pts";
        //  - solos (meta.solos): live % of the solo's notes hit, and at the end
        //    100 per note hit (x2 when perfect) with a Rock Band-style rating.
        // The engine already scores dynamics (accent/ghost) and star power.
        const ROLL_WIN = 0.25, ROLL_N = 4, ROLL_MIN = 8, ROLL_GAP = 0.6;
        const noteKey = (t, pad) => Math.round(t * 1000) * 8 + (pad | 0);
        function newBonus() {
            const rolls = new Set();
            if (s.decoded) {
                const toms = s.decoded.notes.filter(n => n.pad >= 1 && n.pad <= 4 && !n.cymbal)
                    .map(n => ({ t: s.decoded.chords[n.chord].t, pad: n.pad })).sort((a, b) => a.t - b.t);
                for (let i = 0, lo = 0, hi = 0; i < toms.length; i++) {
                    while (toms[lo].t < toms[i].t - ROLL_WIN) lo++;
                    while (hi + 1 < toms.length && toms[hi + 1].t <= toms[i].t + ROLL_WIN) hi++;
                    if (hi - lo + 1 >= ROLL_N) rolls.add(noteKey(toms[i].t, toms[i].pad));
                }
            }
            const solos = ((s.meta && s.meta.solos) || []).map(r => ({ start: r.start, end: r.end, h: 0, n: 0, done: false }));
            return { total: 0, timing: 0, rolls: 0, solo: 0, perfect: 0, dynamics: 0, rollSet: rolls, run: null,
                runs: [], solos, soloDone: [], feed: [], offsets: (s.bonus && s.bonus.offsets) || [] };
        }
        function bonusFeed(text, color) {
            const b = s.bonus;
            b.feed.push({ text, color, wall: now() });
            if (b.feed.length > 4) b.feed.shift();
        }
        function soloOf(t) { return s.bonus.solos.find(x => t >= x.start - 0.05 && t < x.end); }
        function bonusHit(e) {
            const b = s.bonus;
            const mult = e.multiplier || 1;
            const nt = Number.isFinite(e.noteTime) ? e.noteTime : e.time;
            // Early/late meter: hit time minus note time (ms, + = late), the last TIMING_SAMPLES hits.
            b.offsets.push(Math.round((e.time - nt) * 1000) || 0);   // || 0: no -0
            if (b.offsets.length > TIMING_SAMPLES) b.offsets.shift();
            let pts = 0;
            if (Math.abs(e.time - nt) <= 0.025) { pts += 10 * mult; b.timing += 10 * mult; b.perfect++; }
            if (b.rollSet.has(noteKey(nt, e.pad))) {
                const r = 25 * mult;
                pts += r; b.rolls += r;
                if (!b.run || nt - b.run.last > ROLL_GAP) b.run = { h: 0, n: 0, pts: 0, last: nt };
                b.run.h++; b.run.n++; b.run.pts += r; b.run.last = nt;
            }
            if (e.bonus) { b.dynamics++; bonusFeed('+' + (e.velocityBonus || 25) * mult + ' dynamics', '#b77bff'); }
            const so = soloOf(nt);
            if (so && !so.done) { so.h++; so.n++; }
            b.total += pts;
        }
        function bonusMiss(e) {
            const b = s.bonus;
            const nt = Number.isFinite(e.noteTime) ? e.noteTime : e.time;
            if (b.rollSet.has(noteKey(nt, e.pad)) && b.run && nt - b.run.last <= ROLL_GAP) { b.run.n++; b.run.last = nt; }
            const so = soloOf(nt);
            if (so && !so.done) so.n++;
        }
        function bonusTick(time) {
            const b = s.bonus;
            if (!b) return;
            if (b.run && time - b.run.last > ROLL_GAP + 0.2) {
                const r = b.run; b.run = null;
                if (r.n >= ROLL_MIN) {
                    b.runs.push({ h: r.h, n: r.n, pts: r.pts });
                    push({ type: 'bonus-pop', text: 'ROLL ' + r.h + '/' + r.n + '  +' + formatScore(r.pts), color: r.h === r.n ? '#ffc531' : '#ff9a40' });
                }
            }
            for (const so of b.solos) {
                if (so.done || time < so.end + 0.3) continue;
                so.done = true;
                if (!so.n) continue;
                const pct = 100 * so.h / so.n, perfect = so.h === so.n;
                const pts = so.h * 100 * (perfect ? 2 : 1);
                b.solo += pts; b.total += pts;
                const rating = perfect ? 'PERFECT SOLO!' : pct >= 95 ? 'AWESOME SOLO!' : pct >= 90 ? 'GREAT SOLO!' : pct >= 80 ? 'GOOD SOLO!'
                    : pct >= 70 ? 'SOLID SOLO' : pct >= 60 ? 'OKAY SOLO' : 'MESSY SOLO';
                b.soloDone.push({ h: so.h, n: so.n, pct: Math.round(pct * 100) / 100, bonus: pts, rating });
                push({ type: 'solo-end', text: rating, sub: pct.toFixed(2) + '%  ·  solo bonus +' + formatScore(pts), perfect });
            }
        }

        function gemsFor() {
            return buildGems(s.decoded, { pro: effectivePro(), auto: s.auto });
        }

        // Pro drums only when the player wants it and the chart has cymbal markings.
        function effectivePro() {
            return s.proWanted && !(s.meta && s.meta.pro === false);
        }

        // Rebuild from where the song is now (mid-song changes keep the score from here on).
        function rebuildHere() {
            build(s.lastTime != null && s.lastTime > (s.gems.length ? s.gems[0].t - 0.5 : 0)
                ? s.lastTime : undefined);
        }

        function push(ev) {
            ev.wall = now();
            s.events.push(ev);
            if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
        }

        function build(fromTime) {
            if (!s.decoded) { s.engine = null; return; }
            let chart = s.decoded;
            const auto = s.auto.kick || s.auto.cymbals;
            if (Number.isFinite(fromTime) || auto) {
                // Auto lanes are left out of the scored chart (chords regroup from the notes).
                chart = { notes: s.decoded.notes.filter(n => (!Number.isFinite(fromTime) || n.t >= fromTime - 0.001)
                    && !(auto && isAutoNote(n.pad, n.cymbal, s.auto))), chords: [] };
            }
            const m = s.meta;
            const eopts = { beats: s.rawBeats || [], proDrums: effectivePro() };
            if (s.params) eopts.params = s.params;
            if (m) {
                eopts.starPower = m.starPower;
                eopts.activation = m.activation;
            }
            const eng = Engine.create(chart, eopts);
            s.bonus = newBonus();   // a new engine starts its score over, and so do the bonuses
            eng.on('hit', e => {
                push({ type: 'hit', pad: e.pad, cymbal: e.cymbal, id: e.id, sp: eng.isStarPowerNote(e.id), bonus: !!e.bonus, time: e.time });
                bonusHit(e);
                if (s.onHit) {
                    try { s.onHit({ time: e.time, noteTime: Number.isFinite(e.noteTime) ? e.noteTime : e.time, pad: e.pad }); } catch (_) { /* listener only */ }
                }
            });
            eng.on('miss', e => {
                push({ type: 'miss', pad: e.pad, cymbal: e.cymbal, id: e.id, time: e.time });
                bonusMiss(e);
            });
            eng.on('overhit', e => push({ type: 'overhit', pad: e.pad, cymbal: e.cymbal, time: e.time }));
            eng.on('sp-phrase', e => push({ type: 'sp-phrase', time: e.time }));
            eng.on('sp-phrase-fail', e => push({ type: 'sp-phrase-fail', time: e.time }));
            eng.on('sp-ready', e => push({ type: 'sp-ready', time: e.time }));
            eng.on('sp-activate', e => push({ type: 'sp-activate', time: e.time }));
            eng.on('sp-end', e => push({ type: 'sp-end', time: e.time }));
            eng.on('combo-break', e => push({ type: 'combo-break', combo: e.combo, time: e.time }));
            s.engine = eng;
            s.builds++;
        }

        const api = {
            /** Load a chart. notes/chords: wire arrays (drum_tab hits converted by screen.js, or legacy notes). */
            load(chart) {
                chart = chart || {};
                const wire = collectWireNotes(chart.notes, chart.chords);
                s.decoded = Engine.decodeNotes(wire, { kick2x: true });
                s.gems = gemsFor();
                s.rawBeats = Array.isArray(chart.beats) ? chart.beats : [];
                s.beats = normalizeBeats(s.rawBeats);
                s.lastTime = null;
                s.events.length = 0;
                build(undefined);
                return api;
            },
            /** Apply the gameplay metadata (parseDrumTabMeta output, or null). Rebuilds from the current time. */
            setMeta(meta) {
                s.meta = meta || null;
                if (s.decoded) {
                    s.gems = gemsFor();
                    rebuildHere();
                }
                return api;
            },
            /** Auto lanes ({kick, cymbals}); mid-song changes score from the current time. */
            setAuto(auto) {
                auto = normalizeAuto(auto);
                if (auto.kick === s.auto.kick && auto.cymbals === s.auto.cymbals) return api;
                s.auto = auto;
                if (s.decoded) {
                    s.gems = gemsFor();
                    rebuildHere();
                }
                return api;
            },
            /** Engine params override (e.g. {hitWindow: {...}}), or null for the defaults. */
            setParams(params) {
                params = params || null;
                if (JSON.stringify(params) === JSON.stringify(s.params)) return api;
                s.params = params;
                if (s.decoded) rebuildHere();
                return api;
            },
            /** The player's "Pro cymbals" setting. false = non-pro drums (no cymbal lanes). */
            setProDrums(on) {
                on = on !== false;
                if (on === s.proWanted) return api;
                s.proWanted = on;
                if (s.decoded) {
                    s.gems = gemsFor();
                    rebuildHere();
                }
                return api;
            },
            /** Advance to the highway time of this frame (the input offset is applied here too). */
            update(frameTime) {
                frameTime = +frameTime;
                if (!Number.isFinite(frameTime) || !s.engine) return;
                const time = playerTime(frameTime);
                if (s.lastTime != null) {
                    if (isSeek(s.lastTime, time)) build(time);
                    else if (s.lastFrame != null && frameTime > s.lastFrame && (s.auto.kick || s.auto.cymbals)) {
                        // Auto notes crossing the strikeline this frame flash as if played
                        // (on the highway clock: that is when the player sees them arrive).
                        for (let i = firstAfter(s.gems, s.lastFrame); i < s.gems.length && s.gems[i].t <= frameTime; i++) {
                            const g = s.gems[i];
                            if (g.auto) push({ type: 'hit', pad: g.pad, cymbal: g.cymbal, id: g.id, sp: false, auto: true, time: g.t });
                        }
                    }
                }
                // First frame after a load that starts mid-song (view switched while playing,
                // renderer installed late): score from here instead of missing everything before.
                else if (s.gems.length && time > s.gems[0].t - SEEK_BACK) build(time);
                // The engine runs INPUT_GRACE behind: pad hits are timed by when they were struck
                // (their MIDI timestamp), and the engine moves any input older than its own time
                // forward to it (YARG QueueInput). Advanced to the frame time, every hit that
                // arrived just after a frame would be judged late by up to a frame. Misses are
                // only final INPUT_GRACE later.
                s.engine.update(time - INPUT_GRACE);
                bonusTick(time);
                s.lastTime = time;
                s.lastFrame = frameTime;
            },
            /** A pad hit struck at highway time `time`. o: {cymbal, velocity (0..1)}. */
            hit(time, pad, o) {
                o = o || {};
                push({ type: 'press', pad: pad | 0, cymbal: !!o.cymbal });
                // Pads the game plays for you: no score, no overhit.
                if (isAutoNote(pad | 0, !!o.cymbal, s.auto)) return { type: 'ignored', reason: 'auto' };
                if (!s.engine || !Number.isFinite(+time)) return { type: 'ignored', reason: 'no-chart' };
                const t = playerTime(time);
                if (s.lastTime != null && isSeek(s.lastTime, t)) return { type: 'ignored', reason: 'seek' };
                return s.engine.hit(t, pad, { cymbal: !!o.cymbal, velocity: o.velocity });
            },
            /**
             * Activate star power at highway time `time` (the Enter key / star power pad). Only
             * works on charts without fills (with fills, the fill-end note activates it).
             */
            activate(time) {
                if (!s.engine || !Number.isFinite(+time)) return false;
                return s.engine.activateStarPower(playerTime(time));
            },
            /** Input offset in ms (subtracted from every time above; + = hits register earlier). */
            setInputOffset(ms) {
                const v = normalizeInputOffset(ms) / 1000;
                if (v === s.offset) return api;
                s.offset = v;
                if (s.bonus) s.bonus.offsets = [];   // the meter measured the old offset
                return api;
            },
            get inputOffsetMs() { return Math.round(s.offset * 1000); },
            /** Per-hit timing listener ({time, noteTime, pad}: player seconds) or null. */
            setOnHit(fn) { s.onHit = typeof fn === 'function' ? fn : null; return api; },
            /** Forget the early/late samples. */
            resetTiming() { if (s.bonus) s.bonus.offsets = []; return api; },
            drainEvents() {
                if (!s.events.length) return [];
                const out = s.events.slice();
                s.events.length = 0;
                return out;
            },
            getState() { return s.engine ? s.engine.getState() : null; },
            /** The chart note behind an event id: {t, midi, pad, cymbal}, or null. */
            noteInfo(id) {
                const n = s.decoded && Number.isInteger(id) ? s.decoded.notes[id] : null;
                return n ? { t: n.t, midi: n.midi, pad: n.pad, cymbal: n.cymbal } : null;
            },
            /** True when the note (event / gem id) belongs to a star power phrase still alive. */
            isStarPowerNote(id) { return !!(s.engine && s.engine.isStarPowerNote(id)); },
            /** Bonus score on top of the engine's: totals, recent feed, the live solo. */
            getBonus() {
                const b = s.bonus;
                if (!b) return null;
                const t = s.lastTime;
                const live = t == null ? null : b.solos.find(x => t >= x.start - 0.5 && t < x.end + 0.3);
                return { total: b.total, timing: b.timing, rolls: b.rolls, solo: b.solo, perfect: b.perfect, dynamics: b.dynamics,
                    feed: b.feed.slice(), rollActive: !!(b.run && b.run.n >= 3), runs: b.runs.slice(), solos: b.soloDone.slice(),
                    offsets: b.offsets.slice(),
                    soloLive: live ? { h: live.h, n: live.n, active: t >= live.start && t < live.end } : null };
            },
            get engine() { return s.engine; },
            get gems() { return s.gems; },
            get beats() { return s.beats; },
            get meta() { return s.meta; },
            get proDrums() { return effectivePro(); },
            get auto() { return { kick: s.auto.kick, cymbals: s.auto.cymbals }; },
            get builds() { return s.builds; },
            get lastTime() { return s.lastTime; },
        };
        return api;
    }

    return {
        PAD, LANE_NAMES, LANE_COLORS, COLORS, LANE_ID_TO_PAD, SEEK_BACK, SEEK_FORWARD, INPUT_GRACE, TIMING_SAMPLES,
        collectWireNotes, classifyNote, buildGems, visibleRange, normalizeBeats,
        AUTO_LEVELS, normalizeAutoLevel, autoAppliesAt, autoFor, isAutoNote,
        parseDrumTabMeta,
        DIFFICULTIES, LOWER_LEVELS, DEFAULT_DIFFICULTY, DIFFICULTY_LABELS, DIFFICULTY_NAMES, DIFFICULTY_COLORS,
        normalizeDifficulty, hasKick2x, stripKick2x, difficultyOptions,
        resolveDifficulty, nextDifficulty, difficultyLabel, difficultyBadge, difficultyChart, isDifficultyKey,
        midiToPad, isTypingTarget, estimateTime, createFrameClock, isSeek,
        formatScore, formatAccuracy, multiplierColor, starProgress, hudModel, timingSummary, starPowerHint,
        normalizeInputOffset,
        createSession,
    };
});
