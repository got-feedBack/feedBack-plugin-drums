// Drum Highway visualization plugin — lane-based scrolling drum
// renderer (Rock Band-style) with MIDI drum pad input, WebAudioFont
// drum kit sounds, and Rock Band-style scoring.
//
// Scoring: assets/engine.js (an LGPL-3.0 port of YARG.Core's drums
// engine, see NOTICE.md) driven through assets/session.js (difficulty
// levels, star power, assists, bonuses). Both load lazily as plain
// scripts on first use; this file only uses their public APIs.
//
// Views: each renderer instance is either the 2D lane view below or the
// Rock Band-style 3D drum track (assets/highway3d.js on core's vendored
// three.js), picked from the View setting when the instance is created
// (Auto = 3D with WebGL2). Both share the MIDI routing, keyboard input,
// synth, scoring session, difficulty UI and settings panel in this file.
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption. Wave C lifts that: rendering, scoring,
// held-pad state, settings UI, and listeners are now all
// per-instance (closured inside createFactory). Main-player usage
// keeps its single-instance fast path via the
// window.slopsmithSplitscreen helper surface — its absence OR
// isActive()===false means "we're the only instance, always
// focused."
//
// Under splitscreen (N panels, N simultaneous drum instances):
//   - each panel hosts its own overlay canvas, scoring, settings
//     panel + gear docked inside the panel's bar
//   - MIDI input is a browser singleton; one panel receives the
//     drum-pad note-on events: the focused one (clicked most
//     recently) if it is on screen, else the first drum panel on
//     screen (_routeTarget)
//   - focus-change clears held-pad / lane-flash state on the
//     outgoing panel
//   - _cfg.learnLane stays module-scope (per-user-intent — clicking
//     Learn in any panel assigns the next pad-hit-from-the-focused
//     device; the lane-row UI updates everywhere via class selector)
//
// song:ready event subscription is gone: each draw() edge-detects
// bundle.isReady false→true per-instance, which is correct for N
// panels without the cross-instance fan-out of the global bus.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

// Word-boundary match so unrelated arrangement names don't trigger
// Auto-drums via a substring hit — e.g. "Drumstick" (hypothetical)
// must NOT match "drums". The \b anchors still catch standard
// an arrangement labels cleanly: "Drums", "Drum Kit",
// "Percussion", "Electronic Drums", etc.
const DRUMS_PATTERNS = /\b(?:drums|percussion|drum\s*kit)\b/i;
// Smaller window = more vertical pixels per second = more space between
// consecutive hits. 2.0 leaves enough lookahead for fast metal (16ths at
// 170 BPM ≈ 11.3 hits/s gives 22+ visible notes ahead) while spreading
// each hit ~50% further apart than the old 3.0 default.
const VISIBLE_SECONDS = 2.0;
const NOW_LINE_Y_FRAC = 0.85;
const LANE_PAD = 1;
const KICK_LANE_EXTRA = 20;
const HIT_TOLERANCE = 0.05;        // seconds (drums need tighter timing than piano)

// ── Persisted settings ───────────────────────────────────────────────

const STORE_KEYS = {
    midiInputId:    'drums_midi_input',
    synthVolume:    'drums_synth_vol',
    midiChannel:    'drums_midi_ch',
    hitDetection:   'drums_hit_detect',
    showLaneLabels: 'drums_lane_labels',
    customMapping:  'drums_custom_map',
    // Lane preset — chooses which DRUM_LANES table the renderer uses.
    // 'phase_shift_8' (default) matches the legacy 8-lane HH/Sn/T1/T2/T3/
    // Cr/Ri/Ki layout. 'rb4' is a denser 7-lane Rock-Band-style preset.
    // Persisted via _saveCfg below.
    lanePreset:     'drums_lane_preset_v1',
    // Drum difficulty: easy | medium | hard | expert | expert_plus. Per
    // browser, so each player keeps their own; songs without that level
    // play Expert without overwriting the choice.
    difficulty:     'drums_difficulty_v1',
    // Pro cymbals: true = pro drums (cymbal and tom of a colour are
    // separate); false = non-pro, either pad of a colour hits its notes.
    proCymbals:     'drums_pro_cymbals_v1',
    // Accessibility: auto kick / auto cymbals are played for you up to a
    // difficulty ('off' | 'easy' | 'medium' | 'hard' | 'all').
    autoKick:       'drums_auto_kick_v1',
    autoCymbals:    'drums_auto_cymbals_v1',
    // Hit window preset (TIMING_PRESETS).
    timing:         'drums_timing_v1',
    // Volume of the notes the auto kick / auto cymbals play for you (0..1),
    // separate from the pad volume so pads can be silent (the kit module
    // makes the sound) while the auto notes still fill in for a muted drum
    // stem.
    autoVolume:     'drums_auto_volume_v1',
    // Subtracted from the song time of every scored hit, in ms (positive =
    // your hits register earlier; for audio / MIDI latency).
    inputOffsetMs:  'drums_input_offset_ms',
    // MIDI note of the pad that activates star power on charts without
    // drum fills (-1 = none; the Enter key always works).
    spPad:          'drums_sp_pad_v1',
    // View: 'auto' (3D when WebGL2 is available, else 2D) | '3d' | '2d'.
    view:           'drums_view_v1',
    // Keyboard drumming (B F J K L U I O), both views.
    keyboard:       'drums_kbd',
};

// Pads offered for star power activation: notes the engine does not score
// (hat pedal) or seldom-charted extras. Any other note can be stored too.
const SP_PAD_CHOICES = [
    [-1, 'Off (Enter key only)'],
    [44, 'Hi-hat pedal (44)'],
    [53, 'Ride bell (53)'],
    [55, 'Splash (55)'],
    [52, 'China (52)'],
];

// Valid preset ids — kept here so _saveCfg can validate before persisting
// (drums_lane_preset_v1 is user-controlled, like every other storage key
// in this plugin).
const _VALID_LANE_PRESETS = new Set(['phase_shift_8', 'rb4']);
const _VALID_VIEWS = new Set(['auto', '3d', '2d']);
// Same ids as DrumsSession.DIFFICULTIES (session.js loads lazily).
const DIFFICULTY_IDS = ['easy', 'medium', 'hard', 'expert', 'expert_plus'];
const DIFFICULTY_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', expert_plus: 'Expert+' };
const _VALID_DIFFICULTIES = new Set(DIFFICULTY_IDS);
// Same ids as DrumsSession.AUTO_LEVELS.
const AUTO_LEVEL_IDS = ['off', 'easy', 'medium', 'hard', 'all'];
const AUTO_LEVEL_NAMES = { off: 'Off', easy: 'Easy only', medium: 'Easy – Medium', hard: 'Easy – Hard', all: 'Every difficulty' };
const _VALID_AUTO_LEVELS = new Set(AUTO_LEVEL_IDS);

// Hit window presets for the engine (engine.js params.hitWindow).
// Normal = YARG's default 140 ms window (±70 ms).
const TIMING_PRESETS = {
    relaxed:   { name: 'Relaxed (±130 ms)', params: { hitWindow: { maxWindow: 0.26, minWindow: 0.26, isDynamic: false } } },
    forgiving: { name: 'Forgiving (±100 ms)', params: { hitWindow: { maxWindow: 0.20, minWindow: 0.20, isDynamic: false } } },
    normal:    { name: 'Normal (±70 ms)', params: null },
    precision: { name: 'Precision (tightens on fast notes)', params: { hitWindow: {
        maxWindow: 0.13, minWindow: 0.05, isDynamic: true, dynamicScale: 1, dynamicSlope: 0.60615, dynamicGamma: 2 } } },
};
const TIMING_IDS = ['relaxed', 'forgiving', 'normal', 'precision'];

// Safe localStorage reader — getItem can throw SecurityError in
// sandboxed iframes, under Safari on file://, or when storage is
// disabled for the origin. An unguarded throw during the _cfg
// initialiser would abort the IIFE and the plugin would never
// register its setRenderer factory. Return null on failure so the
// `|| default` fallthrough below still produces a usable value.
function _readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

// Numeric cfg normaliser — parseFloat/parseInt return NaN on junk
// like "foo" or "", which would propagate into AudioParam.gain.value
// (breaks playback) or MIDI channel filtering (misroutes events).
// Clamp to [min, max] when provided and fall back to the default on
// any non-finite result.
function _readNum(key, fallback, min, max) {
    const raw = _readStore(key);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

// Lane ids declared here so the customMapping validator below can
// shape-check persisted user mappings. The full DRUM_LANES table
// appears further down (with colors, symbols, MIDI-note lists); the
// ids are duplicated here once because _cfg initialises before the
// DRUM_LANES block runs.
const _VALID_LANE_IDS = new Set([
    'hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick',
]);

// Validate a customMapping object loaded from localStorage. Storage
// is user-controlled (manual edits, another plugin, synced profiles),
// so parsing the raw JSON is NOT enough — we need to reject
// non-object / array inputs, strip __proto__ / constructor /
// prototype keys to block prototype-pollution, and drop any
// (key, value) pair that isn't (MIDI note 0-127, known lane id).
// Returns a clean null-prototype object, or null if nothing survives.
function _validateCustomMapping(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clean = Object.create(null);
    let hasEntries = false;
    for (const key of Object.keys(raw)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const midi = parseInt(key, 10);
        if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
        const val = raw[key];
        if (typeof val !== 'string' || !_VALID_LANE_IDS.has(val)) continue;
        clean[midi] = val;
        hasEntries = true;
    }
    return hasEntries ? clean : null;
}

const _cfg = {
    midiInputId:    _readStore(STORE_KEYS.midiInputId) || '',
    synthVolume:    _readNum(STORE_KEYS.synthVolume, 0.7, 0, 1),
    // -1 = all, 0..15 are the 16 MIDI channels (9 = "ch10" Drums)
    midiChannel:    Math.round(_readNum(STORE_KEYS.midiChannel, -1, -1, 15)),
    hitDetection:   _readStore(STORE_KEYS.hitDetection) === 'true',
    showLaneLabels: _readStore(STORE_KEYS.showLaneLabels) !== 'false',
    customMapping:  (function () {
        try {
            const raw = JSON.parse(_readStore(STORE_KEYS.customMapping) || 'null');
            return _validateCustomMapping(raw);
        } catch (_) { return null; }
    })(),
    lanePreset:     (function () {
        const raw = _readStore(STORE_KEYS.lanePreset);
        return _VALID_LANE_PRESETS.has(raw) ? raw : 'phase_shift_8';
    })(),
    autoVolume:     _readNum(STORE_KEYS.autoVolume, 0.8, 0, 1),
    inputOffsetMs:  Math.round(_readNum(STORE_KEYS.inputOffsetMs, 0, -250, 250)),
    spPad:          Math.round(_readNum(STORE_KEYS.spPad, -1, -1, 127)),
    difficulty:     (function () {
        const raw = _readStore(STORE_KEYS.difficulty);
        return _VALID_DIFFICULTIES.has(raw) ? raw : 'expert';
    })(),
    proCymbals:     _readStore(STORE_KEYS.proCymbals) !== 'false',
    view:           (function () {
        const raw = _readStore(STORE_KEYS.view);
        return _VALID_VIEWS.has(raw) ? raw : 'auto';
    })(),
    keyboard:       _readStore(STORE_KEYS.keyboard) !== 'false',
    autoKick:       (function () {
        const raw = _readStore(STORE_KEYS.autoKick);
        return _VALID_AUTO_LEVELS.has(raw) ? raw : 'off';
    })(),
    autoCymbals:    (function () {
        const raw = _readStore(STORE_KEYS.autoCymbals);
        return _VALID_AUTO_LEVELS.has(raw) ? raw : 'off';
    })(),
    timing:         (function () {
        const raw = _readStore(STORE_KEYS.timing);
        return Object.prototype.hasOwnProperty.call(TIMING_PRESETS, raw) ? raw : 'normal';
    })(),
    // Transient: which lane is in learn mode. Module-scope across
    // panels — the Learn-mode UX is "click Learn in any panel, then
    // hit a pad on the focused MIDI device." The next focused-panel
    // drum-hit consumes the sentinel and remaps. Per-panel learnLane
    // would imply N independent in-flight remap operations, which is
    // surprising when there's only one user + one MIDI kit.
    learnLane:      null,
};

function _saveCfg(key, val) {
    // Apply the same shape validation the _cfg initialiser uses so
    // anything we write to localStorage is also trustworthy on next
    // load. Belt-and-suspenders — Learn-mode builds its map from
    // Object.assign({}, _getActiveDrumMap()) + a fresh midi+laneId
    // pair, so input is already well-formed, but routing through
    // the validator means any future caller can't accidentally
    // persist garbage.
    if (key === 'customMapping' && val !== null) {
        val = _validateCustomMapping(val);
    }
    if (key === 'lanePreset' && !_VALID_LANE_PRESETS.has(val)) {
        val = 'phase_shift_8';
    }
    if (key === 'view' && !_VALID_VIEWS.has(val)) {
        val = 'auto';
    }
    if (key === 'difficulty' && !_VALID_DIFFICULTIES.has(val)) {
        val = 'expert';
    }
    if ((key === 'autoKick' || key === 'autoCymbals') && !_VALID_AUTO_LEVELS.has(val)) {
        val = 'off';
    }
    if (key === 'timing' && !Object.prototype.hasOwnProperty.call(TIMING_PRESETS, val)) {
        val = 'normal';
    }
    if (key === 'autoVolume' || key === 'synthVolume') {
        const n = Number(val);
        val = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : (key === 'autoVolume' ? 0.8 : 0.7);
    }
    if (key === 'inputOffsetMs') {
        const n = Math.round(Number(val));
        val = Number.isFinite(n) ? Math.max(-250, Math.min(250, n)) : 0;
    }
    if (key === 'spPad') {
        const n = Math.round(Number(val));
        val = Number.isFinite(n) && n >= 0 && n <= 127 ? n : -1;
    }
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    const serialised = typeof val === 'object' && val !== null
        ? JSON.stringify(val) : String(val);
    try { localStorage.setItem(storeKey, serialised); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons (browser-unique resources)
// ═══════════════════════════════════════════════════════════════════════

// ── MIDI input ────────────────────────────────────────────────────────
// MIDI is sourced from the core `midi-input` capability domain
// (window.slopsmith.midiInput) rather than a private requestMIDIAccess() — one
// device-access boundary shared with piano/keys/onboarding.
let _midiReady = false;      // discover() has run
let _midiHandle = null;      // live domain session handle (addListener/removeListener)
let _midiListener = null;    // the addListener callback wrapping _midiOnMessage
let _midiStateSub = false;   // subscribed to midi-input:sources-changed
let _midiInput = null;       // selected source descriptor { id, name, key }
let _midiConnectSeq = 0;     // generation guard for async _midiConnect races
// Gates the live listener wiring. init() flips true via _midiResumeHandler
// and destroy() flips false via _midiPauseHandler. Because _midiConnect is
// async, an open() begun in init() can resolve AFTER destroy() has run — the
// resulting addListener would otherwise re-wire scoring/synth on a
// no-longer-visible renderer. Every callsite that would attach the listener
// consults this flag first.
let _midiActive = false;
// Wave C: routes incoming MIDI events to the currently-focused drum
// instance (null when no instance is active). Instances claim this
// on focus-change and release it on defocus / destroy.
let _activeInstance = null;
// Registry of live factory instances so module-level helpers (device-
// list refresh, shutdown-when-last-destroys) can iterate.
const _instances = new Set();
// Monotonic id for per-instance DOM tagging (useful for debugging).
let _nextInstanceId = 0;

// The host event bus (window.feedBack; window.slopsmith is its legacy alias).
function _bus() {
    const b = (typeof window !== 'undefined') && (window.feedBack || window.slopsmith);
    return b && typeof b.on === 'function' ? b : null;
}

// Save the drum difficulty (per browser) and apply it to every live
// instance: each one resolves it against its own chart (falling back to
// Expert for that song when the level is missing) and, mid-song, rebuilds
// its chart from the current position on its next frame.
function _setDifficulty(id) {
    _saveCfg('difficulty', id);
    try {
        document.querySelectorAll('.drums-difficulty-select').forEach((sel) => { sel.value = _cfg.difficulty; });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { inst._difficultyChanged(); } catch (e) { console.warn('[Drums] difficulty update failed:', e); }
    }
}

// Save "Pro cymbals" (per browser) and apply it to every live instance;
// mid-song, scoring restarts from the current position.
function _setProCymbals(on) {
    _saveCfg('proCymbals', !!on);
    try {
        document.querySelectorAll('.drums-chk-pro').forEach((chk) => { chk.checked = _cfg.proCymbals; });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { inst._proCymbalsChanged(); } catch (e) { console.warn('[Drums] pro cymbals update failed:', e); }
    }
}

// Save an assist setting (auto kick / auto cymbals / timing) and apply it
// to every live instance (mid-song, scoring restarts from the current
// position, like a difficulty change).
function _setAssist(key, val) {
    _saveCfg(key, val);
    const cls = { autoKick: '.drums-auto-kick', autoCymbals: '.drums-auto-cym', timing: '.drums-timing-select' }[key];
    try {
        if (cls) document.querySelectorAll(cls).forEach((sel) => { sel.value = _cfg[key]; });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { if (inst._assistsChanged) inst._assistsChanged(); } catch (e) { console.warn('[Drums] assist update failed:', e); }
    }
}

// Save the input offset (ms) and hand it to every live scoring session (the
// settings field, and the timing meter's Apply button).
function _setInputOffset(ms) {
    _saveCfg('inputOffsetMs', ms);
    try {
        document.querySelectorAll('.drums-offset-input').forEach((el) => { el.value = String(_cfg.inputOffsetMs); });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { if (inst._inputOffsetChanged) inst._inputOffsetChanged(); } catch (e) { console.warn('[Drums] input offset update failed:', e); }
    }
    return _cfg.inputOffsetMs;
}

// Save the star power pad (MIDI note, -1 = none).
function _setSpPad(note) {
    _saveCfg('spPad', note);
    try {
        document.querySelectorAll('.drums-sp-pad').forEach((sel) => { sel.innerHTML = _spPadOptions(_cfg.spPad); });
    } catch (_) { /* no DOM */ }
}

function _spPadOptions(current) {
    const list = SP_PAD_CHOICES.slice();
    if (current >= 0 && !list.some(([n]) => n === current)) list.push([current, 'MIDI note ' + current]);
    return list.map(([n, name]) => `<option value="${n}"${n === current ? ' selected' : ''}>${name}</option>`).join('');
}

// Short name of the star power pad for the HUD hint ('' = none).
function _spPadName() {
    if (_cfg.spPad < 0) return '';
    const c = SP_PAD_CHOICES.find(([n]) => n === _cfg.spPad);
    return c ? c[1].replace(/\s*\(\d+\)$/, '').toLowerCase() : 'MIDI note ' + _cfg.spPad;
}

// MIDI velocity (1..127) -> the engine's 0..1. The engine also accepts raw
// MIDI values, but reads anything <= 1 as already normalised, so velocity 1
// (the softest ghost note) would count as full strength.
function _engineVelocity(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, Math.min(1, n / 127));
}

// <option> lists for the settings selects (values are fixed ids; names are ours).
function _optList(ids, names, current) {
    return ids.map(id => `<option value="${id}"${id === current ? ' selected' : ''}>${names[id]}</option>`).join('');
}
function _autoOptions(current) { return _optList(AUTO_LEVEL_IDS, AUTO_LEVEL_NAMES, current); }
function _timingOptions(current) {
    const names = {};
    for (const id of TIMING_IDS) names[id] = TIMING_PRESETS[id].name;
    return _optList(TIMING_IDS, names, current);
}

const _SEL_CSS = 'background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:3px 6px;font-size:11px;color:#ccc;outline:none;';

// Auto lanes for a difficulty: each setting is a ceiling ('easy' = on at
// Easy only, 'hard' = Easy..Hard, 'all' = always). Mirrors
// DrumsSession.autoFor (kept here so it works before session.js loads).
function _autoAt(diffId) {
    const rank = (id) => DIFFICULTY_IDS.indexOf(id);
    const on = (lvl) => lvl === 'all' || (lvl !== 'off' && rank(diffId) >= 0 && rank(diffId) <= rank(lvl));
    return { kick: on(_cfg.autoKick), cymbals: on(_cfg.autoCymbals) };
}

// 2D lane ids played for the player by the auto settings.
function _laneIsAuto(laneIdx, auto) {
    const lane = DRUM_LANES[laneIdx];
    if (!lane || !auto) return false;
    if (lane.id === 'kick') return !!auto.kick;
    return !!auto.cymbals && (lane.id === 'hihat' || lane.id === 'crash' || lane.id === 'ride');
}

function _timingParams() {
    const p = TIMING_PRESETS[_cfg.timing];
    return p && p.params ? JSON.parse(JSON.stringify(p.params)) : null;
}

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthGain = null;
let _autoGain = null;        // bus for auto-played notes (its own volume)
let _synthLoading = false;
let _playerScriptLoaded = false;
const _drumPresets = {};           // midiNote -> preset

// ═══════════════════════════════════════════════════════════════════════
// MIDI / Drum Mapping
// ═══════════════════════════════════════════════════════════════════════

function noteToMidi(string, fret) { return string * 24 + fret; }

// ── Piece-id ↔ MIDI (mirrors lib/drums.py::PIECES) ──────────────────
//
// Default GM MIDI for each canonical piece-id. The mapped value is the
// "preferred" MIDI we synthesize when a drum_tab.json hit names this
// piece-id — it then flows through the legacy {string, fret}
// MIDI-encoding pipeline unchanged (`midi = string * 24 + fret`).
// Hi-hat openness is preserved as distinct piece-ids (hh_closed=42,
// hh_open=46, hh_pedal=44) so the renderer's open-vs-closed visual
// dispatch keeps working from the synthesised note's MIDI alone.
const PIECE_DEFAULT_MIDI = {
    kick:         36,
    snare:        38,
    snare_xstick: 37,
    tom_hi:       50,
    tom_mid:      47,
    tom_low:      43,
    tom_floor:    41,
    hh_closed:    42,
    hh_open:      46,
    hh_pedal:     44,
    crash_l:      49,
    crash_r:      57,
    splash:       55,
    china:        52,
    ride:         51,
    ride_bell:    53,
};

// Convert a drum_tab.hits[] payload into the legacy {t, s, f, ac, mt}
// note objects the renderer already understands. Accent (`ac`, renders
// larger + brighter, scores the dynamics bonus): the tab's authored `a`
// flag (feedpak 1.20.0) when the tab uses it anywhere, otherwise a written
// velocity ≥ 100 as before. A hit without `v` is not an accent. Ghost notes
// carry `mt: true`; a hit is never both. A double kick (`x2: true` on a
// kick) becomes GM 35 — the engine's Expert+ kick — so the Expert chart can
// drop it. Flams emit a small leading grace note 30 ms ahead so the user
// sees the characteristic two-tap shape. Unknown piece-ids are dropped —
// better silent than a mis-rendered piece on an outdated client.
const KICK2X_MIDI = 35;
function _drumTabHitsToNotes(hits) {
    if (!Array.isArray(hits)) return [];
    const authoredAccents = hits.some(h => h && h.a === true);
    const out = [];
    for (const h of hits) {
        const piece = h && h.p;
        // Use hasOwnProperty guard to prevent prototype-poisoning: if h.p is
        // '__proto__', 'constructor', etc., the plain-object lookup would
        // return an inherited value instead of undefined.
        if (!Object.prototype.hasOwnProperty.call(PIECE_DEFAULT_MIDI, piece)) continue;
        const midi = (piece === 'kick' && h.x2 === true) ? KICK2X_MIDI : PIECE_DEFAULT_MIDI[piece];
        const v = (typeof h.v === 'number') ? h.v : 100;
        const ghost = !!h.g;
        const accent = !ghost && (authoredAccents ? h.a === true : (typeof h.v === 'number' && h.v >= 100));
        const t = +h.t;
        // Skip hits with missing or non-finite timestamps — rendering at t=0
        // by default would score bogus notes at the song start.
        if (!Number.isFinite(t) || t < 0) continue;
        const note = {
            t,
            s: (midi / 24) | 0,
            f: midi % 24,
            ac: accent,
            mt: ghost,        // ghost — the engine scores it; the renderer draws it smaller
            _piece: piece,    // carried for future rendering/debug use
            _vel: v,
        };
        if (h.f) {
            // Leading flam grace note 30 ms ahead. mt:true and _vel carry
            // intent for a future smaller/dimmer rendering pass; currently
            // the note renders at normal size. _noScore:true is the only
            // active field — it excludes the grace from miss-counting and
            // from consuming the hit window (the player strikes the main hit).
            out.push({
                t: Math.max(0, t - 0.030),
                s: note.s, f: note.f,
                ac: false,
                mt: true,
                _piece: piece,
                _vel: Math.max(20, ((v * 0.5) | 0)),
                _noScore: true,
            });
        }
        out.push(note);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

function _noteKey(time, midi) {
    return time.toFixed(3) + '|' + midi;
}

// Lane preset table — the user picks via the settings panel (PR6). The
// `phase_shift_8` default matches v3's legacy 8-lane HH/Sn/T1/T2/T3/Cr/
// Ri/Ki layout so existing setups are untouched. `rb4` collapses to a
// 7-lane Rock-Band-style layout that several community members asked for
// (single tom-pair lane, merged cymbals, no x-stick / pedal-hat split).
const LANE_PRESETS = {
    phase_shift_8: [
        { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0], symbol: 'x'      },
        { id: 'snare',  label: 'Sn', midiNotes: [38, 40, 37], color: [1.0, 0.9, 0.2], symbol: 'circle' },
        { id: 'tom1',   label: 'T1', midiNotes: [48, 50],     color: [0.3, 1.0, 0.3], symbol: 'circle' },
        { id: 'tom2',   label: 'T2', midiNotes: [45, 47],     color: [1.0, 0.6, 0.1], symbol: 'circle' },
        { id: 'tom3',   label: 'T3', midiNotes: [41, 43, 58], color: [0.7, 0.4, 1.0], symbol: 'circle' },
        { id: 'crash',  label: 'Cr', midiNotes: [49, 57, 55, 52], color: [0.2, 0.9, 0.9], symbol: 'diamond' },
        { id: 'ride',   label: 'Ri', midiNotes: [51, 59, 53], color: [0.9, 0.9, 0.9], symbol: 'diamond' },
        { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3], symbol: 'bar'    },
    ],
    rb4: [
        { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0], symbol: 'x'      },
        { id: 'snare',  label: 'Sn', midiNotes: [38, 40, 37], color: [1.0, 0.9, 0.2], symbol: 'circle' },
        { id: 'tom1',   label: 'T',  midiNotes: [48, 50, 45, 47], color: [0.3, 1.0, 0.3], symbol: 'circle' },
        { id: 'tom3',   label: 'FT', midiNotes: [41, 43, 58], color: [0.7, 0.4, 1.0], symbol: 'circle' },
        { id: 'crash',  label: 'Cr', midiNotes: [49, 57, 55, 52], color: [0.2, 0.9, 0.9], symbol: 'diamond' },
        { id: 'ride',   label: 'Ri', midiNotes: [51, 59, 53], color: [0.9, 0.9, 0.9], symbol: 'diamond' },
        { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3], symbol: 'bar'    },
    ],
};

// Live lane table — mutated in place by _applyLanePreset so existing
// references (closures, _computeLaneLayout, _midiToLane builders) keep
// pointing at the same array object after a preset swap.
const DRUM_LANES = [];
const _midiToLane = {};

function _applyLanePreset(presetName) {
    const preset = LANE_PRESETS[presetName] || LANE_PRESETS.phase_shift_8;
    DRUM_LANES.length = 0;
    for (const lane of preset) DRUM_LANES.push(lane);
    for (const k of Object.keys(_midiToLane)) delete _midiToLane[k];
    DRUM_LANES.forEach((lane, idx) => {
        lane.midiNotes.forEach(n => { _midiToLane[n] = idx; });
    });
}
_applyLanePreset(_cfg.lanePreset);

function _getActiveDrumMap() {
    // For the settings mapping table and Learn-mode, return the custom map
    // when set, otherwise derive the default map from _midiToLane (which is
    // rebuilt by _applyLanePreset and is always preset-aware). This ensures
    // that in rb4 mode MIDI notes 45/47 show as mapping to 'tom1' (their
    // actual destination) rather than being omitted by a static map that
    // lists them as 'tom2' — a lane that doesn't exist in rb4.
    //
    // When a customMapping is present, filter out any lane IDs that are not
    // in the active preset so the mapping table and Learn-mode UI show the
    // same effective mapping that _midiToLaneIdx() produces (i.e. entries
    // that fall back to the preset-aware default are shown as unassigned
    // rather than pointing at a lane that doesn't exist).
    if (_cfg.customMapping) {
        const activeLaneIds = new Set(DRUM_LANES.map(l => l.id));
        const filtered = {};
        for (const [midi, laneId] of Object.entries(_cfg.customMapping)) {
            if (activeLaneIds.has(laneId)) filtered[midi] = laneId;
        }
        return filtered;
    }
    const result = {};
    for (const [midi, laneIdx] of Object.entries(_midiToLane)) {
        const lane = DRUM_LANES[laneIdx];
        if (lane) result[midi] = lane.id;
    }
    return result;
}

function _midiToLaneIdx(midiNote) {
    // When the user has a custom mapping, honour it (maps MIDI → lane id string).
    // When using the default, delegate to _midiToLane which is rebuilt by
    // _applyLanePreset() and already returns the correct index for the active
    // preset — avoiding stale lane-id references (e.g. 'tom2' in rb4 which
    // has no tom2 lane, causing findIndex to return -1 for mid-tom live hits).
    const custom = _cfg.customMapping;
    if (custom) {
        const laneId = custom[midiNote];
        if (laneId) {
            const idx = DRUM_LANES.findIndex(l => l.id === laneId);
            // If the custom-mapped lane is absent in the active preset (e.g. user
            // mapped a note to 'tom2' then switched to rb4 which has no tom2), fall
            // through to the preset-aware default rather than silently returning -1.
            if (idx >= 0) return idx;
        }
    }
    return _midiToLane[midiNote] !== undefined ? _midiToLane[midiNote] : -1;
}

function _songNoteToLaneIdx(midi) {
    return _midiToLane[midi] !== undefined ? _midiToLane[midi] : -1;
}

// ═══════════════════════════════════════════════════════════════════════
// Color helper
// ═══════════════════════════════════════════════════════════════════════

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// ═══════════════════════════════════════════════════════════════════════
// Script loader
// ═══════════════════════════════════════════════════════════════════════

// A failed load removes its <script> element, so a later call for the same
// URL loads it again instead of resolving at once on the dead tag.
function _loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => {
            try { s.remove(); } catch (_) { /* already gone */ }
            reject(new Error('Failed to load ' + url));
        };
        document.head.appendChild(s);
    });
}

// Remove the <script> element for `url` (a load that "succeeded" without
// registering its global, e.g. an error page served as JS).
function _dropScript(url) {
    try { document.querySelectorAll(`script[src="${url}"]`).forEach((el) => el.remove()); } catch (_) { /* no DOM */ }
}

// ═══════════════════════════════════════════════════════════════════════
// Scoring modules (engine.js + session.js, lazily loaded)
// ═══════════════════════════════════════════════════════════════════════
//
// plugin.json names one script, so the scoring files live in assets/ and
// load through core's sandboxed /api/plugins/<id>/assets/ route on first
// use. One shared promise, so N instances never race on the same tags.

const PLUGIN_ID = 'drums';
const ASSET_VERSION = '4.2.0';   // cache-buster for the lazily loaded files
const THREE_URL = '/static/vendor/three/three.module.min.js';
const PLUGIN_ASSETS = '/api/plugins/' + PLUGIN_ID + '/assets/';

let _scoringPromise = null;
function _loadScoring() {
    if (window.DrumsEngine && window.DrumsSession) {
        return Promise.resolve({ E: window.DrumsEngine, H: window.DrumsSession });
    }
    if (_scoringPromise) return _scoringPromise;
    const files = [['engine.js', 'DrumsEngine'], ['session.js', 'DrumsSession']];
    const url = (name) => PLUGIN_ASSETS + name + '?v=' + ASSET_VERSION;
    const want = (name, global) => (window[global] ? Promise.resolve() : _loadScript(url(name)));
    _scoringPromise = Promise.all(files.map(([name, global]) => want(name, global))).then(() => {
        if (!window.DrumsEngine || !window.DrumsSession) throw new Error('drums scoring modules did not register');
        return { E: window.DrumsEngine, H: window.DrumsSession };
    }).catch((e) => {
        // Allow a retry on the next init: drop the script elements of the
        // files that didn't register, or _loadScript would resolve on them.
        for (const [name, global] of files) if (!window[global]) _dropScript(url(name));
        _scoringPromise = null;
        throw e;
    });
    return _scoringPromise;
}

// highway3d.js (keyboard helpers + the 3D view; needs session.js). One
// shared promise: the 2D view loads it for the keyboard helpers and the 3D
// view for the scene, and _loadScript resolves early for a <script> tag
// that is already in the page, so two loaders must not race on it.
let _viewScriptPromise = null;
function _loadViewScript() {
    if (window.DrumsHighway3D) return Promise.resolve(window.DrumsHighway3D);
    if (_viewScriptPromise) return _viewScriptPromise;
    _viewScriptPromise = _loadScoring()
        .then(() => (window.DrumsHighway3D ? null : _loadScript(PLUGIN_ASSETS + 'highway3d.js?v=' + ASSET_VERSION)))
        .then(() => {
            if (!window.DrumsHighway3D) throw new Error('highway3d.js did not register');
            return window.DrumsHighway3D;
        })
        .catch((e) => {
            // Drop a highway3d.js element that loaded without registering,
            // so the retry loads it again (a failed load removes its own).
            if (!window.DrumsHighway3D) _dropScript(PLUGIN_ASSETS + 'highway3d.js?v=' + ASSET_VERSION);
            _viewScriptPromise = null;
            throw e;
        });
    return _viewScriptPromise;
}

// The 3D view: three.js (core's vendored ES module, the copy the bundled 3D
// guitar highway imports), the scoring modules and highway3d.js.
let _libsPromise = null;
function _load3DLibs() {
    if (_libsPromise) return _libsPromise;
    _libsPromise = Promise.all([import(THREE_URL), _loadScoring(), _loadViewScript()])
        .then(([THREE, sc, V]) => ({ THREE, E: sc.E, H: sc.H, V }))
        .catch((e) => {
            _libsPromise = null;   // allow a retry on the next init
            throw e;
        });
    return _libsPromise;
}

let _webgl2Probe = null;
function _canWebGL2() {
    if (_webgl2Probe !== null) return _webgl2Probe;
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        _webgl2Probe = !!gl;
        const ext = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
        if (ext && ext.loseContext) ext.loseContext();
    } catch (_) { _webgl2Probe = false; }
    return _webgl2Probe;
}

// Which view a new renderer instance uses: the setting, with '3d' and
// 'auto' falling back to 2D when WebGL2 is unavailable.
function _resolveView(view, canWebGL2) {
    if (view === '2d') return '2d';
    return canWebGL2 ? '3d' : '2d';
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont drum kit synthesizer (module-level — one audio context per tab)
// ═══════════════════════════════════════════════════════════════════════

const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF = 'JCLive_sf2_file';

// MIDI notes that the WebAudioFont synth preloads samples for. Includes
// all notes that appear in any LANE_PRESETS midiNotes array so that
// hits on cross-stick (37), china/splash cymbals (52/55), ride bell (53),
// and alternate tom3 (58) produce audio rather than scoring silently.
const DRUM_MIDI_NOTES = [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 59];

function _drumWafVar(note)  { return '_drum_' + note + '_0_' + WAF_SF; }
function _drumWafUrl(note)  { return WAF_BASE + '128' + note + '_0_' + WAF_SF + '.js'; }

async function _synthInit() {
    if (_synthPlayer) return;
    try {
        if (!_playerScriptLoaded) {
            await _loadScript(WAF_PLAYER_URL);
            _playerScriptLoaded = true;
        }
        if (typeof WebAudioFontPlayer === 'undefined') return;

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        _synthGain = _audioCtx.createGain();
        _synthGain.gain.value = _cfg.synthVolume;
        _synthGain.connect(_audioCtx.destination);
        _autoGain = _audioCtx.createGain();
        _autoGain.gain.value = _cfg.autoVolume;
        _autoGain.connect(_audioCtx.destination);
        _synthPlayer = new WebAudioFontPlayer();

        await _synthLoadDrumKit();
    } catch (e) {
        console.warn('[Drums] Synth init failed:', e);
    }
}

async function _synthLoadDrumKit() {
    if (!_synthPlayer || !_audioCtx) return;
    _synthLoading = true;

    const promises = DRUM_MIDI_NOTES.map(async (note) => {
        const varName = _drumWafVar(note);
        try {
            if (!window[varName]) {
                await _loadScript(_drumWafUrl(note));
            }
            const preset = window[varName];
            if (preset) {
                _synthPlayer.adjustPreset(_audioCtx, preset);
                _drumPresets[note] = preset;
            }
        } catch (e) {
            console.warn('[Drums] Failed to load drum note ' + note + ':', e);
        }
    });

    await Promise.all(promises);
    _synthLoading = false;
}

function _synthEnsureCtx() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
}

// One drum sound at `when` (AudioContext time; 0 = now). dest: the output
// bus (default: the pad bus _synthGain; _autoGain for auto-played notes).
// Returns the WebAudioFont envelope (so a scheduled note can be cancelled),
// or null.
function _synthPlayNote(midiNote, velocity, when, dest) {
    if (!_synthPlayer || !_audioCtx || !_synthGain) return null;
    const preset = _drumPresets[midiNote];
    if (!preset) return null;
    dest = dest || _synthGain;
    return _synthPlayer.queueWaveTable(_audioCtx, dest, preset, when || 0, midiNote, when ? 0.6 : 0.5,
        (velocity / 127) * (dest === _synthGain ? _cfg.synthVolume : 1)) || null;
}

function _synthDrumHit(midiNote, velocity) {
    if (!_synthPlayer || !_audioCtx || !_synthGain) return;
    _synthEnsureCtx();
    _synthPlayNote(midiNote, velocity, 0);
}

function _synthSetVolume(vol) {
    _saveCfg('synthVolume', vol);
    if (_synthGain) _synthGain.gain.value = _cfg.synthVolume;
    try {
        document.querySelectorAll('.drums-vol-slider').forEach((el) => { el.value = String(Math.round(_cfg.synthVolume * 100)); });
    } catch (_) { /* no DOM */ }
}

function _setAutoVolume(vol) {
    _saveCfg('autoVolume', vol);
    if (_autoGain) _autoGain.gain.value = _cfg.autoVolume;
    try {
        document.querySelectorAll('.drums-autovol-slider').forEach((el) => { el.value = String(Math.round(_cfg.autoVolume * 100)); });
    } catch (_) { /* no DOM */ }
}

// GM notes the auto settings play for the player (engine.js MIDI_MAP: kick
// pads and the yellow/blue/green cymbals; the hat pedal is never scored).
const _AUTO_KICK_MIDI = new Set([35, 36]);
const _AUTO_CYM_MIDI = new Set([42, 46, 49, 51, 52, 53, 55, 57, 59]);

function _isAutoMidi(midi, auto) {
    return !!auto && ((auto.kick && _AUTO_KICK_MIDI.has(midi)) || (auto.cymbals && _AUTO_CYM_MIDI.has(midi)));
}

// Velocity for an auto note: drum-tab velocity, else accent / ghost / normal.
function _autoVelocity(n) {
    if (Number.isFinite(n._vel)) return n._vel;
    return n.ac ? 118 : (n.mt ? 55 : 100);
}

// Auto notes with from < t <= to in a sorted wire list ({t, s, f}) and its
// chords, as [{t, midi, vel}]. Pure (tested).
function _autoNotesBetween(notes, chords, from, to, auto) {
    const out = [];
    if (!auto || (!auto.kick && !auto.cymbals) || !(to > from)) return out;
    const scan = (list, each) => {
        if (!Array.isArray(list)) return;
        let lo = 0, hi = list.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (!(list[m] && list[m].t > from)) lo = m + 1; else hi = m; }
        for (let i = lo; i < list.length && list[i] && list[i].t <= to; i++) each(list[i]);
    };
    scan(notes, (n) => {
        if (n._noScore) return;
        const midi = (n.s | 0) * 24 + (n.f | 0);
        if (_isAutoMidi(midi, auto)) out.push({ t: n.t, midi, vel: _autoVelocity(n) });
    });
    scan(chords, (c) => {
        for (const cn of (c.notes || [])) {
            const midi = (cn.s | 0) * 24 + (cn.f | 0);
            if (_isAutoMidi(midi, auto)) out.push({ t: c.t, midi, vel: _autoVelocity(cn) });
        }
    });
    return out;
}

// ── Auto-note scheduler ──
// Auto notes are timed from the song's audio clock, not the frame clock: a
// frame's song time is up to a frame old and jittery, which played the auto
// kick ~30 ms late with ±15 ms wobble, and a repeated or backward frame time
// restarted the window so a note now and then played twice. Here a note's
// song time maps to the stems plugin's AudioContext (when it is there: the
// stems playhead runs on that context's clock) and then to the drum context
// heard at the same moment (both contexts' getOutputTimestamp), so the two
// line up even when their output latencies differ. One schedule for all drum
// panels, and it only moves forward (no note is scheduled twice); a pause,
// seek or song change cancels the notes that haven't sounded yet.
const AUTO_LOOKAHEAD = 0.1;   // song seconds scheduled ahead of the playhead
const _autoSched = { key: null, owner: null, ownerWall: -1e9, to: NaN, last: NaN, offs: [], pending: [], hooked: null };

function _autoCancel() {
    const now = _audioCtx ? _audioCtx.currentTime : 0;
    for (const p of _autoSched.pending) {
        if (p.t0 <= now) continue;
        const src = p.env && p.env.audioBufferSourceNode;
        try { if (src) src.stop(); else if (p.env && p.env.cancel) p.env.cancel(); } catch (_) { /* not started / gone */ }
    }
    _autoSched.pending = [];
    _autoSched.to = NaN;
}

// The stems plugin's AudioContext (its gain nodes live in it), or null.
function _stemsCtx() {
    try {
        const st = window.stems && typeof window.stems.getState === 'function' ? window.stems.getState() : null;
        for (const s of (st || [])) if (s && s.gain && s.gain.context) return s.gain.context;
    } catch (_) { /* no stems */ }
    return null;
}

// Drum context time minus stems context time for sounds heard at the same
// moment (s). Median of recent frames (getOutputTimestamp is a little noisy).
function _autoCtxOffset(sctx) {
    let off = NaN;
    try {
        const od = _audioCtx.getOutputTimestamp(), os = sctx.getOutputTimestamp();
        if (od && os && od.performanceTime > 0 && os.performanceTime > 0) {
            off = (od.contextTime - os.contextTime) - (od.performanceTime - os.performanceTime) / 1000;
        }
    } catch (_) { /* older engine */ }
    if (!Number.isFinite(off)) {
        const lat = (c) => (+c.outputLatency || 0) + (+c.baseLatency || 0);
        off = (_audioCtx.currentTime - sctx.currentTime) - (lat(_audioCtx) - lat(sctx));
    }
    const o = _autoSched.offs;
    o.push(off);
    if (o.length > 31) o.shift();
    const sorted = o.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
}

// Called every frame by each drum view with the chart it plays. owner: the
// view's instance id (one view drives the schedule at a time). The song
// time comes from the player's <audio> element (chart offsets other than the
// loose-folder song offset are 0, so audio time = chart time).
function _autoSchedule(notes, chords, auto, owner) {
    const S = _autoSched;
    const wall = performance.now();
    if (S.owner !== owner) {
        if (wall - S.ownerWall < 300) return;   // another view is scheduling
        S.owner = owner;
    }
    S.ownerWall = wall;
    let a = null;
    try { a = document.getElementById('audio'); } catch (_) { /* no DOM */ }
    const on = !!auto && (auto.kick || auto.cymbals) && !!_audioCtx && !!_autoGain && _cfg.autoVolume > 0;
    if (!on || !a || a.paused) {
        if (S.pending.length || Number.isFinite(S.to)) _autoCancel();
        S.last = NaN;
        return;
    }
    if (S.hooked !== a) {
        // Pause / seek between frames: drop what's queued right away.
        S.hooked = a;
        try { a.addEventListener('pause', _autoCancel); a.addEventListener('seeking', _autoCancel); } catch (_) { /* shimmed element */ }
    }
    const t = +a.currentTime;
    if (!Number.isFinite(t)) return;
    const sctx = _stemsCtx();
    const sNow = sctx ? sctx.currentTime : NaN;
    const rate = Math.max(0.25, Math.min(2, +a.playbackRate || 1));
    if (S.key !== notes) { _autoCancel(); S.key = notes; }
    // A seek the events missed: the playhead went back or jumped ahead.
    if (Number.isFinite(S.last) && (t < S.last - 0.03 || t > S.last + 0.5)) _autoCancel();
    S.last = t;
    const off = sctx ? _autoCtxOffset(sctx) : 0;
    if (!Number.isFinite(S.to)) S.to = t;   // (re)start here: nothing already due is replayed
    const to = t + AUTO_LOOKAHEAD * rate;
    if (!(to > S.to)) return;
    // After a stall, notes more than 20 ms overdue are skipped, not played late.
    const due = _autoNotesBetween(notes, chords, Math.max(S.to, t - 0.02), to, auto);
    S.to = to;
    if (!due.length) return;
    _synthEnsureCtx();
    const now = _audioCtx.currentTime;
    // Drum context time at which song time t is heard.
    const base = sctx && Number.isFinite(sNow) ? sNow + off : now;
    S.pending = S.pending.filter((p) => p.t0 > now);
    for (const n of due) {
        const when = Math.max(now, base + (n.t - t) / rate);
        const env = _synthPlayNote(n.midi, n.vel, when, _autoGain);
        if (env) S.pending.push({ env, t0: when });
    }
}

// Stop scheduling for a view that goes away (its notes are no longer due).
function _autoRelease(owner) {
    if (_autoSched.owner !== owner) return;
    _autoCancel();
    _autoSched.owner = null;
    _autoSched.ownerWall = -1e9;
    _autoSched.key = null;
    _autoSched.last = NaN;
}

// ═══════════════════════════════════════════════════════════════════════
// Web MIDI input (module-level — one MIDI access per tab)
// ═══════════════════════════════════════════════════════════════════════

// The core midi-input domain, if present (it ships with core).
function _mi() {
    const m = window.slopsmith && window.slopsmith.midiInput;
    return (m && m.version === 1) ? m : null;
}

// Domain sources shaped like the old MIDIInput list: { id, name, key }.
// sourceId == the old MIDIInput.id, so stored `midiInputId` stays compatible.
function _midiSources() {
    const mi = _mi();
    if (!mi) return [];
    return mi.listSources().map(s => ({ id: s.sourceId, name: s.label, key: s.logicalSourceKey }));
}

// In-flight guard around discover(): Wave C calls _midiInit() once per init();
// N concurrent splitscreen instances would otherwise issue N discover() calls
// (each a requestMIDIAccess via the provider) before the first resolves.
let _midiInitPromise = null;

async function _midiInit() {
    const mi = _mi();
    if (!mi) return;
    // Already discovered: re-run auto-connect so a re-mount after a full release
    // (or a settings re-open) reconnects from the saved pick instead of no-opping.
    // Already discovered: only (re)connect when there's no live session. A
    // repeated _midiInit (settings panel open, extra splitscreen instance) must
    // NOT re-enter _midiConnect on an active handle — that tears down the live
    // session and releases held pads for no reason. After a full release the
    // handle is null, so reconnect happens then.
    if (_midiReady) { if (!_midiHandle) _midiAutoConnect(); return; }
    if (_midiInitPromise) return _midiInitPromise;
    _midiInitPromise = (async () => {
        try {
            const r = await mi.discover();  // permission boundary (requestMIDIAccess)
            // Only latch ready on a successful discovery — a denied/unavailable
            // outcome must NOT latch, or reopening the panel never retries.
            if (!r || r.outcome !== 'handled') return;
            _midiReady = true;
            // Refresh device lists on plug/unplug (replaces MIDIAccess.onstatechange).
            if (!_midiStateSub && window.slopsmith && typeof window.slopsmith.on === 'function') {
                _midiStateSub = true;
                window.slopsmith.on('midi-input:sources-changed', () => _midiReconcileSources());
            }
            _midiAutoConnect();
            // Populate whatever settings panels are open.
            _midiUpdateAllDeviceLists();
        } catch (e) {
            console.warn('[Drums] MIDI access denied:', e);
        } finally {
            // On success future calls short-circuit on `_midiReady`; on
            // rejection, releasing the slot lets a later init() retry.
            _midiInitPromise = null;
        }
    })();
    return _midiInitPromise;
}

// Plug/unplug reconciliation (midi-input:sources-changed). The domain closes +
// deletes a session when its device is unplugged, so refreshing the dropdown
// isn't enough: if OUR selected device vanished, drop the now-stale
// handle/selection (keeping _midiActive) and re-auto-connect — that reattaches
// the saved device when it's replugged, or falls back to another input. Then
// refresh the dropdowns. If the selected device is unaffected, just refresh.
function _midiReconcileSources() {
    if (_midiInput && !_midiSources().some(s => s.key === _midiInput.key)) {
        if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
        _midiHandle = null;
        _midiListener = null;
        _midiInput = null;
        // No note-off can arrive for pads that were down at unplug — clear any
        // sounding/lit state so a lane isn't stuck until the next hit.
        for (const inst of _instances) {
            if (inst && typeof inst._releaseAllSounding === 'function') inst._releaseAllSounding();
        }
    }
    // Reconnect ONLY to the saved device when it's (re)present. Don't fall back to
    // another input here: _midiConnect persists its id, so a fallback during a
    // transient unplug would overwrite the user's saved kit (the original returns
    // on replug and reconnects then). A deliberate device switch goes through the UI.
    if (!_midiInput) {
        const sources = _midiSources();
        const raw = _readStore(STORE_KEYS.midiInputId);
        if (raw === '') {
            // explicit None — stay disconnected.
        } else {
            const key = _midiResolveSaved(raw, sources);
            if (key) _midiConnect(key);                              // saved device present → reconnect
            else if (raw == null && sources.length) _midiConnect(sources[0].key);  // never picked → first-hotplug
            // else: a saved pick exists but is absent → preserve (reconnect on replug)
        }
    }
    _midiUpdateAllDeviceLists();
}

// Resolve a persisted selection to a current source's logicalSourceKey. Handles
// both the new logicalSourceKey storage AND legacy bare web-midi sourceId saves
// (pre-domain), returning the canonical key, or null when the device is absent.
function _midiResolveSaved(saved, sources) {
    if (!saved) return null;
    let m = sources.find(s => s.key === saved);    // new: stored logicalSourceKey
    if (!m) m = sources.find(s => s.id === saved);  // legacy: bare web-midi sourceId
    return m ? m.key : null;
}

function _midiAutoConnect() {
    const inputs = _midiSources();
    if (!inputs.length) return;

    // Distinguish "never picked a device" from "explicitly picked None".
    // _readStore returns null for the never-set case and '' for an explicit-None
    // save via _midiConnect. Only respect the explicit-None sentinel; otherwise
    // resolve the saved selection (logicalSourceKey, or a legacy sourceId) and
    // fall back to the first input when it's absent.
    const raw = _readStore(STORE_KEYS.midiInputId);
    if (raw === '') return;

    _midiConnect(_midiResolveSaved(raw, inputs) || inputs[0].key);
}

async function _midiConnect(key) {
    const myGen = ++_midiConnectSeq;
    const mi = _mi();
    // Tear down any existing live session.
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    if (mi && _midiInput) { try { mi.close({ requester: 'drums', logicalSourceKey: _midiInput.key }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;

    // Release anything currently sounding / held on the OLD device
    // before we swap. Drum notes are short (queueWaveTable duration
    // 0.5s) so hung tones are less likely than for piano, but
    // _heldPads drives on-screen lane pressed state and would
    // otherwise keep the prior hit animating after a device swap.
    // Iterate ALL live instances — _activeInstance can be null
    // (no panel focused yet) or stale (focus swapped between
    // device events). Iterating _instances guarantees no panel
    // shows "stuck" pressed lanes when it later becomes focused.
    for (const inst of _instances) {
        if (inst && typeof inst._releaseAllSounding === 'function') {
            inst._releaseAllSounding();
        }
    }
    // Learn-mode is a module-scope sentinel, so clear once and
    // refresh every panel's Learn UI to keep buttons in sync.
    _cfg.learnLane = null;
    _updateLearnUI();

    // Persist regardless of match. Empty key is the explicit "None" option and
    // must be saved so _midiAutoConnect respects the opt-out on next init instead
    // of auto-picking inputs[0] again. We store the globally-unique
    // logicalSourceKey (not the provider-local sourceId).
    _saveCfg('midiInputId', key || '');

    if (!key || !mi) {
        _midiUpdateAllDeviceLists();
        return;
    }
    const src = _midiSources().find(s => s.key === key);
    if (!src) { _midiUpdateAllDeviceLists(); return; }
    _midiInput = { id: src.id, name: src.name, key: src.key };   // selection descriptor for the UI
    // No live renderer to consume OR release a session — don't hold one open
    // (settings-only init, or the last instance was torn down during async
    // discovery). The pick is saved; a later renderer mount re-runs auto-connect
    // and opens for real, and its destroy() releases it.
    if (_instances.size === 0) { _midiUpdateAllDeviceLists(); return; }
    try {
        await mi.select(src.key);
        const res = await mi.open({ requester: 'drums', logicalSourceKey: src.key });
        // A newer _midiConnect (rapid device switch / None) superseded us while
        // we awaited — discard this open so we don't install a stale handle.
        if (myGen !== _midiConnectSeq) {
            if (!_midiInput || _midiInput.key !== src.key) { try { mi.close({ requester: 'drums', logicalSourceKey: src.key }); } catch (_) { /* best-effort */ } }
            return;
        }
        if (res && res.handle) {
            _midiHandle = res.handle;
            // The domain handle delivers raw MIDI data; adapt to the old
            // MIDIMessageEvent shape so _midiOnMessage stays unchanged. A
            // second argument, when a provider passes one, is the message's
            // timeStamp (performance.now() clock): hits are then timed when
            // the pad was struck rather than when this code ran.
            _midiListener = (data, timeStamp) => _midiOnMessage({ data, timeStamp });
            // Wire the listener only when at least one renderer is active. A
            // late open() from an async _midiInit that resolved post-destroy
            // would otherwise re-enable scoring/synth in the background.
            if (_midiActive) _midiHandle.addListener(_midiListener);
        } else {
            // Open yielded no live handle (device vanished post-discovery, or the
            // provider reported denied/unavailable). Clear the selection so the UI
            // doesn't show a phantom connected device and miss-counting stays off.
            _midiInput = null;
        }
    } catch (e) {
        console.warn('[Drums] MIDI open failed:', e);
        // Only clear if we're still the current connect — a stale older open's
        // rejection (rapid switch / autoconnect racing a manual pick) must not
        // wipe a newer connect's already-installed _midiInput/_midiHandle (which
        // would also leak the live handle, since closes are gated on _midiInput).
        if (myGen === _midiConnectSeq) _midiInput = null;
    }
    _midiUpdateAllDeviceLists();
}

function _midiPauseHandler() {
    // Called from destroy() when the LAST instance goes away —
    // detach the message handler so the connected kit stops firing
    // hits into a plugin no longer visible. Flipping _midiActive
    // BEFORE the detach also prevents a late-resolving _midiConnect
    // (from an in-flight _midiInit started in the most recent init())
    // from re-wiring the handler on an already-destroyed renderer.
    // Keep _midiInput so a future init() can reattach without the
    // user re-picking.
    _midiActive = false;
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    // Clear pending Learn-mode sentinel — leaving it set would
    // consume the first drum hit on the NEXT renderer lifetime
    // (user clicks Learn, closes the last drums panel before
    // tapping a pad, reopens drums later, hits a pad → silent
    // remap with no UI explaining why). _updateLearnUI() refreshes
    // any reopened settings panel; if no panel is open right now
    // the call is a cheap no-op.
    _cfg.learnLane = null;
    _updateLearnUI();
}

// Called when the LAST live instance is torn down. Builds on _midiPauseHandler
// (listener detach + Learn-sentinel clear) by also fully releasing the shared
// midi-input domain session, so the e-kit/provider session isn't held open after
// the visualization is gone and the core domain can close the device once other
// consumers release it too. Reset readiness so a later re-mount re-discovers and
// auto-connects from the saved pick.
function _midiReleaseSession() {
    _midiConnectSeq += 1;   // invalidate any in-flight _midiConnect open
    _midiPauseHandler();
    const mi = _mi();
    if (mi && _midiInput) { try { mi.close({ requester: 'drums', logicalSourceKey: _midiInput.key || ('web-midi::' + _midiInput.id) }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;
    // Intentionally leave _midiReady latched and _midiInitPromise alone: _midiInit
    // re-runs _midiAutoConnect on a ready re-mount (no re-discover needed), and
    // clearing the in-flight promise here would let a quick remount during a
    // pending discover() start a SECOND requestMIDIAccess, defeating the guard.
    // The in-flight init clears its own promise in its finally.
}

function _midiResumeHandler() {
    // Idempotent: a second instance init (splitscreen / re-init) calls this while
    // already active. The domain handle's addListener is Set-backed, but don't
    // rely on the provider de-duping — re-adding could double-deliver each MIDI
    // event to the focused instance, doubling note-ons/hits.
    if (_midiActive) return;
    // Called from init() — flip the gate first so an in-flight
    // _midiConnect that lands shortly after this returns wires the
    // handler too. If _midiInput is already populated from a prior
    // lifetime, restore the handler immediately.
    _midiActive = true;
    if (_midiHandle && _midiListener) { try { _midiHandle.addListener(_midiListener); } catch (_) { /* best-effort */ } }
}

// Which drum view gets kit hits: the focused one if it is on screen, else
// the first drum view on screen, else the focused one. Splitscreen focus
// starts on panel 1 and moves on click, so a drum panel that was never
// clicked (or a hidden main-player drum view holding focus) used to swallow
// every hit.
function _routeTarget() {
    const vis = [];
    for (const i of _instances) { try { if (i._isVisible && i._isVisible()) vis.push(i); } catch (_) { /* ignore */ } }
    if (_activeInstance && vis.includes(_activeInstance)) return _activeInstance;
    if (vis.length) return vis[0];
    return _activeInstance;
}

function _midiOnMessage(e) {
    // Hits go to one drum view (_routeTarget); none live -> dropped.
    const target = _routeTarget();
    if (!target) return;

    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;
    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    const cmd = status & 0xF0;
    if (cmd === 0x90 && velocity > 0) {
        target._handleDrumHit(note, velocity, e.timeStamp);
    }
    // Drums don't need note-off handling (one-shot hits)
}

function _midiUpdateAllDeviceLists() {
    const inputs = _midiSources();

    // Every instance's settings panel (if open) has a
    // `.drums-midi-select` node. Iterate all of them so a
    // device plug/unplug reflects everywhere simultaneously.
    const selects = document.querySelectorAll('.drums-midi-select');
    for (const sel of selects) {
        // Build <option> elements via the DOM API rather than
        // concatenating an HTML string. MIDI device names come from
        // attached hardware and can contain characters that would
        // otherwise inject markup ("<" in a vendor string or a
        // maliciously-named device) directly into the settings panel.
        // .value / .textContent escape both fields safely.
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        sel.appendChild(noneOpt);
        for (const inp of inputs) {
            const opt = document.createElement('option');
            opt.value = inp.key;
            // inp.name can be null / empty across browsers and devices
            // (Firefox historically, some class-compliant kits); fall
            // back through manufacturer → id so the dropdown never
            // literally says "null".
            opt.textContent = inp.name || inp.manufacturer || inp.id || 'Unknown device';
            if (_midiInput && _midiInput.key === inp.key) opt.selected = true;
            sel.appendChild(opt);
        }
    }
}

// Refresh every Learn button across every open settings panel so the
// "..." pending indicator and the active-lane highlight reflect the
// shared _cfg.learnLane sentinel.
function _updateLearnUI() {
    const learnBtns = document.querySelectorAll('.drums-learn-btn');
    learnBtns.forEach(btn => {
        const idx = parseInt(btn.dataset.lane);
        btn.textContent = _cfg.learnLane === idx ? '...' : 'Learn';
        btn.style.color = _cfg.learnLane === idx ? '#ff0' : '#aaa';
    });
}

// Build the mapping table rows from the active drum map. Module-scope
// because customMapping is module-shared state — every open settings
// panel (across N splitscreen drum instances) should render the same
// rows. References only module-scope identifiers (DRUM_LANES, _cfg,
// _getActiveDrumMap, _rgbStr).
function _buildMappingRows() {
    return DRUM_LANES.map((lane, idx) => {
        const map = _getActiveDrumMap();
        const assigned = Object.entries(map).filter(([_, v]) => v === lane.id).map(([k]) => k).join(', ');
        return `<tr>
            <td style="color:${_rgbStr(lane.color[0], lane.color[1], lane.color[2])};font-weight:bold;padding:2px 6px;">${lane.label}</td>
            <td style="color:#888;padding:2px 6px;font-size:10px;">${assigned || 'none'}</td>
            <td style="padding:2px 4px;"><button class="drums-learn-btn" data-lane="${idx}"
                style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:1px 6px;
                font-size:10px;color:${_cfg.learnLane === idx ? '#ff0' : '#aaa'};cursor:pointer;">${_cfg.learnLane === idx ? '...' : 'Learn'}</button></td>
        </tr>`;
    }).join('');
}

// Re-bind Learn-button onclicks within a freshly-rebuilt mapping
// table. Module-scope because the handler only mutates _cfg.learnLane
// (module-shared) and calls _updateLearnUI (also module-scope) —
// no per-instance closure needed.
function _wireLearnButtons(scope) {
    scope.querySelectorAll('.drums-learn-btn').forEach(btn => {
        btn.onclick = function () {
            const idx = parseInt(this.dataset.lane);
            _cfg.learnLane = _cfg.learnLane === idx ? null : idx;
            _updateLearnUI();
        };
    });
}

// Rebuild EVERY open mapping table after a customMapping change
// (Learn-mode assignment, Reset Map button). Iterating the DOM
// rather than _instances means we rebuild only the tables that
// actually exist in the document — instances whose settings panel
// was never opened simply don't have a `.drums-map-table` node yet,
// and they pick up the current state when the panel opens later.
function _refreshAllMappingTables() {
    const tables = document.querySelectorAll('.drums-map-table');
    if (!tables.length) return;
    const html = _buildMappingRows();
    tables.forEach(tbl => {
        tbl.innerHTML = html;
        _wireLearnButtons(tbl);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrappers
// ═══════════════════════════════════════════════════════════════════════
//
// Centralise the "am I in splitscreen?" / "which panel are my chrome
// anchors?" queries so instance code can read the runtime environment
// cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
// means "main-player, always focused" from the plugin's POV.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    // Validate the FULL surface this plugin consumes, not just
    // isActive(). If a future splitscreen build ships partial
    // helpers (or an older bundled splitscreen lacks one of the
    // newer methods), report "not active" so the wrappers fall
    // back to the main-player single-instance fast path rather
    // than reaching a half-broken splitscreen state where focus
    // never lands on any instance and MIDI routing dies.
    return typeof ss.isCanvasFocused === 'function'
        && typeof ss.panelChromeFor === 'function'
        && typeof ss.settingsAnchorFor === 'function'
        && typeof ss.onFocusChange === 'function'
        && typeof ss.offFocusChange === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.panelChromeFor === 'function')
        ? ss.panelChromeFor(highwayCanvas) : null;
}

function _ssSettingsAnchor(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.settingsAnchorFor === 'function')
        ? ss.settingsAnchorFor(highwayCanvas) : null;
}

function _ssIsCanvasFocused(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return true;  // main-player fast path
    return !!(ss && typeof ss.isCanvasFocused === 'function' &&
              ss.isCanvasFocused(highwayCanvas));
}

// ═══════════════════════════════════════════════════════════════════════
// Round rect helper (stateless)
// ═══════════════════════════════════════════════════════════════════════

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ═══════════════════════════════════════════════════════════════════════
// Lane geometry (vertical — lanes are columns, notes scroll top → bottom)
// ═══════════════════════════════════════════════════════════════════════

function _computeLaneLayout(W /* , H */) {
    const numLanes = DRUM_LANES.length;
    const padL = 10;
    const padR = 10;
    const availW = W - padL - padR;

    const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');
    const regularW = (availW - KICK_LANE_EXTRA) / numLanes;
    const kickW = regularW + KICK_LANE_EXTRA;

    const lanes = [];
    let x = padL;
    for (let i = 0; i < numLanes; i++) {
        const w = i === kickIdx ? kickW : regularW;
        lanes.push({
            idx: i,
            lane: DRUM_LANES[i],
            x: x,
            w: w,
            centerX: x + w / 2,
        });
        x += w + LANE_PAD;
    }
    return lanes;
}

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory(forceView) {
    const _instanceId = ++_nextInstanceId;

    // '2d' = the lane renderer, '3d' = the WebGL drum track from
    // highway3d.js. Fixed for this instance's lifetime because highway.js
    // reads contextType before init(); a View change installs a fresh
    // instance instead.
    const _view = (forceView === '2d' || forceView === '3d')
        ? (forceView === '3d' && !_canWebGL2() ? '2d' : forceView)
        : _resolveView(_cfg.view, _canWebGL2());

    // Lifecycle
    let _isReady = false;

    // Rendering state — _drumCanvas / _drumCtx point at the highway's own
    // canvas (passed to init by highway.js). We render directly onto it
    // instead of overlaying a separate canvas, matching the 3D Highway
    // plugin's pattern. The player-controls strip stays at the bottom
    // naturally because highway.js sizes the canvas to exclude it.
    let _drumCanvas = null;
    let _drumCtx = null;
    let _highwayCanvas = null;

    // Settings UI
    let _settingsPanel = null;
    let _settingsGear = null;
    let _settingsVisible = false;

    // Held / flash state — per-instance so each panel only shows the
    // pads ITS focused user is hitting.
    const _heldPads = new Map();          // midi note -> {velocity, wall}
    const _wrongFlashes = [];             // [{lane, wall}]
    const _laneFlashes = [];              // [{laneIdx, wall, color}]

    // Scoring
    let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
    const _hitNoteKeys = new Set();
    const _missedNoteKeys = new Set();

    // Latest bundle snapshot — cached each frame so MIDI handler
    // (async wrt draw) can score against the filter-aware chart
    // the user sees.
    let _latestNotes = null, _latestChords = null, _latestTime = 0;

    // Cached drum_tab → legacy-shape notes from the last frame. Memoised
    // on the drum_tab object identity so the conversion (kit walk + sort)
    // runs once per chart load, not per frame. Cleared on chart reset.
    let _drumTabCacheKey = null;
    let _drumTabCacheNotes = null;

    // Wave C: replace the module-level `song:ready` subscription
    // with a bundle.isReady edge-detect per-instance. The global
    // event fires N times under splitscreen (once per panel's
    // highway); edge-detecting locally scopes the reset correctly.
    let _lastBundleIsReady = false;

    // Wave C focus state
    let _isFocused = false;
    // Tracks whether we successfully subscribed to splitscreen
    // focus-change events. Necessary because subscribe is gated on
    // _ssActive() (full helper surface + isActive()===true) but
    // destroy() must still unsubscribe what was actually attached
    // — we can't re-derive "did we subscribe?" from a fresh
    // _ssActive() check at destroy time, since isActive() might
    // have flipped false (splitscreen toggled off) between init
    // and destroy. Without this flag a defensive offFocusChange
    // call against a subscription that never happened would be a
    // no-op for EventTarget but obscures intent; a missed
    // unsubscribe of one we DID register would leak the listener
    // closure across the destroy.
    let _focusSubscribed = false;

    // ── Scoring (engine.js via session.js) ──
    // The chart (drum tab hits, or the legacy notes) is the full Expert+
    // part; Easy/Medium/Hard come from the tab's `levels` (feedpak 1.20.0).
    let _h = null;                  // DrumsSession (helpers + session factory) once loaded
    let _E = null;                  // DrumsEngine once loaded
    let _session = null;            // _h.createSession(...) for this instance
    let _chartRefs = null;          // [notes, chords, beats] identities loaded into the session
    let _metaKey;                   // drum tab the metadata was parsed from (undefined = none yet)
    let _metaCache = null;          // _h.parseDrumTabMeta(...) for _metaKey (null = Expert only, no star power)
    let _diffOptions = null;        // _h.difficultyOptions(...) for the loaded chart
    let _diff = null;               // _h.resolveDifficulty(...) in use: {id, requested, fallback, reason}
    let _badge = null;              // _h.difficultyBadge(...) drawn in the HUD
    let _diffUiKey = '';            // last difficulty state written to the DOM
    let _lvlMemo = null;            // {notes, chords, id, src, chart}: chart for the difficulty
    let _has2xMemo = null;          // {notes, chords, val}
    let _badgeBtn = null;           // clickable button over the HUD badge
    let _badgeRectKey = '';
    let _diffMenu = null;           // difficulty pop-up menu
    let _onDiffKey = null, _onMenuOutside = null;
    let _onVisibility = null, _onCanvasReplaced = null, _onSongEnded = null;
    let _hwVisible = true;
    let _onKeyDown = null;
    let _V = null;                  // DrumsHighway3D (keyboard helpers + 3D view factory) once loaded

    // ── 3D view state (only used when _view === '3d') ──
    let _view3d = null;             // _V.createView(...)
    let _hudCanvas = null;          // 2D overlay (HUD + core draw hooks)
    let _initToken = 0;             // supersedes in-flight async inits
    let _renderScale = 1;
    let _lastHwW = 0, _lastHwH = 0;
    let _auto = { kick: false, cymbals: false };   // auto lanes for the difficulty in use
    // Auto notes (kick / cymbals) are played so a muted drum stem doesn't
    // leave holes: see _autoSchedule (module level, shared by all views).
    function _scheduleAutoSounds(notes, chords) { _autoSchedule(notes, chords, _auto, _instanceId); }

    // Smoothed highway clock (session.js createFrameClock): what this view
    // draws and scores with each frame, and the time of a pad hit between
    // frames. Created when session.js has loaded.
    let _frameClock = null;
    let _frameT = NaN;              // the clock's time at the last frame

    function _now() { return performance.now(); }

    // Highway time of a hit. ts: when the MIDI message arrived
    // (performance.now() clock), when the provider passes it; otherwise
    // now. The scoring session subtracts the input offset.
    function _inputTime(ts) {
        const nowW = _now();
        const at = (Number.isFinite(ts) && ts > 0 && ts <= nowW + 5 && nowW - ts < 250) ? ts : nowW;
        const t = _frameClock ? _frameClock.at(at) : NaN;
        if (Number.isFinite(t)) return t;
        return Number.isFinite(_frameT) ? _frameT : (+_latestTime || 0);
    }

    function _positionHud() {
        if (!_hudCanvas || !_highwayCanvas) return;
        _hudCanvas.style.left = _highwayCanvas.offsetLeft + 'px';
        _hudCanvas.style.top = _highwayCanvas.offsetTop + 'px';
    }

    function _resize3D() {
        if (!_view3d || !_highwayCanvas) return;
        const rect = _highwayCanvas.getBoundingClientRect();
        const w = rect.width || _highwayCanvas.clientWidth;
        const h = rect.height || _highwayCanvas.clientHeight;
        if (!w || !h) return;
        const base = Math.min(window.devicePixelRatio || 1, _ssActive() ? 1.25 : 2);
        _view3d.resize(w, h, base * (_renderScale || 1));
        _positionHud();
        _lastHwW = _highwayCanvas.width;
        _lastHwH = _highwayCanvas.height;
    }

    // Keyboard drumming (both views; capture phase, so drum keys don't
    // reach other shortcuts while this view is focused and Keys is on).
    // Space is deliberately not a drum key: it stays play/pause.
    function _wireKeyboard() {
        if (_onKeyDown) return;
        _loadViewScript().then((V) => { if (!_instanceDestroyed) _V = V; })
            .catch((e) => console.warn('[Drums] keyboard input unavailable:', e));
        _onKeyDown = (e) => {
            if (_instanceDestroyed || !_isReady || !_isFocused || !_hwVisible || !_cfg.keyboard) return;
            if (!_V || !_h || !_session) return;
            if (_h.isTypingTarget(e.target) || _h.isTypingTarget(document.activeElement)) return;
            const m = _V.keyToPad(e);
            // Enter: the star power key (_wireStarPowerKey), which only takes
            // it when star power can be activated by hand.
            if (!m || m.action === 'activate') return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            _synthInit();
            _synthDrumHit(_V.synthMidiForPad(m.pad, m.cymbal), 100);
            const r = _session.hit(_inputTime(), m.pad, { cymbal: m.cymbal });
            if (_view !== '3d' && r && r.type === 'overhit') {
                const lane = _padLane2D(m.pad, m.cymbal);
                if (lane >= 0) _wrongFlashes.push({ lane, wall: performance.now() });
            }
        };
        window.addEventListener('keydown', _onKeyDown, true);
    }

    // The 2D lane a keyboard pad lands in (for the wrong-hit flash).
    function _padLane2D(pad, cymbal) {
        const midi = _V ? _V.synthMidiForPad(pad, cymbal) : null;
        return midi == null ? -1 : _midiToLaneIdx(midi);
    }

    // 3D init: claim the webgl2 context and mount the HUD overlay
    // (synchronously), then load the modules and build the scene. Returns
    // the readyPromise, or null on failure.
    function _begin3D(canvas) {
        let gl = null;
        try { gl = canvas.getContext('webgl2', { antialias: true, alpha: false }); } catch (_) { gl = null; }
        if (!gl) return null;
        _hudCanvas = document.createElement('canvas');
        _hudCanvas.className = 'drums3d-hud';
        _hudCanvas.dataset.drumsInstance = String(_instanceId);
        _hudCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2;';
        if (canvas.parentNode) canvas.parentNode.insertBefore(_hudCanvas, canvas.nextSibling);
        _hwVisible = canvas.offsetParent !== null;
        _hudCanvas.style.display = _hwVisible ? '' : 'none';

        const token = ++_initToken;
        return _load3DLibs().then((libs) => {
            if (token !== _initToken || _instanceDestroyed) throw new Error('superseded');
            _V = libs.V;
            _view3d = libs.V.createView(libs.THREE, canvas, { hudCanvas: _hudCanvas, context: gl });
            _resize3D();
            if (!_lastHwW) {
                // Panel not laid out yet (splitscreen sizes after init).
                (function retry() {
                    if (token !== _initToken || _instanceDestroyed || !_view3d) return;
                    _resize3D();
                    if (!_lastHwW) requestAnimationFrame(retry);
                })();
            }
        });
    }

    function _teardown3D() {
        _initToken++;
        if (_view3d) { try { _view3d.dispose(); } catch (e) { console.warn('[Drums] 3D dispose failed:', e); } }
        _view3d = null;
        if (_hudCanvas) { _hudCanvas.remove(); _hudCanvas = null; }
        _lastHwW = _lastHwH = 0;
    }

    // t: this frame's highway time (_frameClock: smoothed between audio
    // samples, so gems move evenly). message: draw it instead of the chart
    // (not a drum part).
    function _draw3D(bundle, isReady, t, message) {
        if (!_view3d) return;   // modules still loading
        const nextScale = bundle.renderScale || 1;
        if (nextScale !== _renderScale) { _renderScale = nextScale; _resize3D(); }
        else if (_highwayCanvas && (_highwayCanvas.width !== _lastHwW || _highwayCanvas.height !== _lastHwH)) _resize3D();
        const wall = _now();
        if (message || !isReady || !_session) {
            _view3d.render({ time: t, session: null, wallNow: wall, message: message || 'Loading drums...' });
            _placeBadge(null);
            _placeTimingBtn(null);
            return;
        }
        const hint = _h.starPowerHint(_session.meta, _session.getState(), _spPadName());
        _view3d.render({ time: t, session: _session, wallNow: wall, hint, difficulty: _badge,
            inputOffsetMs: _cfg.inputOffsetMs });
        _placeBadge(_view3d.difficultyRect);
        _placeTimingBtn(_view3d.timingRect, _view3d.timingSuggest);
        const hctx = _view3d.hudContext;
        if (hctx && window.highway && typeof window.highway.fireDrawHooks === 'function') {
            const sz = _view3d.size;
            try { window.highway.fireDrawHooks(hctx, sz.w, sz.h); } catch (_) { /* hooks are best-effort */ }
        }
    }

    // Load engine.js + session.js and build this instance's scoring session.
    function _startScoring() {
        _loadScoring().then(({ E, H }) => {
            if (_instanceDestroyed || !_isReady) return;
            _E = E;
            _h = H;
            if (!_frameClock) _frameClock = H.createFrameClock();
            if (!_session) {
                _auto = _autoAt(_diff ? _diff.id : _cfg.difficulty);
                _session = H.createSession(E, { proDrums: _cfg.proCymbals, auto: _auto, params: _timingParams(),
                    inputOffsetMs: _cfg.inputOffsetMs });
                _chartRefs = null;
            }
        }).catch((e) => console.warn('[Drums] scoring unavailable (engine/session failed to load):', e));
    }

    // Shared bus wiring. The difficulty badge is sibling DOM, so hide it
    // with the highway canvas (splitscreen display:none's #highway). Filter
    // by canvas: every highway instance emits on the shared bus.
    function _wireBus() {
        const bus = _bus();
        if (!bus || typeof bus.off !== 'function') return;
        _onVisibility = (e) => {
            if (!e || !e.detail || e.detail.canvas !== _highwayCanvas) return;
            _hwVisible = e.detail.visible !== false;
            if (_hudCanvas) _hudCanvas.style.display = _hwVisible ? '' : 'none';
            if (!_hwVisible) { _placeBadge(null); _placeTimingBtn(null); _toggleDiffMenu(false); }
        };
        _onCanvasReplaced = (e) => {
            if (!e || !e.detail || e.detail.oldCanvas !== _highwayCanvas) return;
            _highwayCanvas = e.detail.newCanvas;
        };
        // End-of-song results card (single view; splitscreen panels skip it).
        _onSongEnded = () => {
            if (_instanceDestroyed || !_session || !_cfg.hitDetection || _ssActive() || !_isVisible()) return;
            _drumsEndCard(_session, _badge);
        };
        try { bus.on('highway:visibility', _onVisibility); } catch (_) { _onVisibility = null; }
        try { bus.on('highway:canvas-replaced', _onCanvasReplaced); } catch (_) { _onCanvasReplaced = null; }
        try { bus.on('song:ended', _onSongEnded); } catch (_) { _onSongEnded = null; }
    }

    // This view is on screen (splitscreen hides the panels it doesn't show).
    function _isVisible() {
        const c = _highwayCanvas;
        return !!(c && c.isConnected && c.getClientRects && c.getClientRects().length && _hwVisible !== false);
    }

    function _unwireBus() {
        const bus = _bus();
        if (bus && typeof bus.off === 'function') {
            if (_onVisibility) { try { bus.off('highway:visibility', _onVisibility); } catch (_) { /* ignore */ } }
            if (_onCanvasReplaced) { try { bus.off('highway:canvas-replaced', _onCanvasReplaced); } catch (_) { /* ignore */ } }
            if (_onSongEnded) { try { bus.off('song:ended', _onSongEnded); } catch (_) { /* ignore */ } }
        }
        _onVisibility = null;
        _onCanvasReplaced = null;
        _onSongEnded = null;
    }

    // Gameplay metadata (star power, fills, solos, difficulty levels)
    // rides on the drum tab core streams (feedpak 1.20.0). Parsed once per
    // tab: draw() only runs after `ready`, when every level chunk is in. A
    // legacy chart (GM-encoded notes, no tab) or a pre-1.20.0 tab has none:
    // Expert only, no star power.
    function _syncMeta(dt) {
        if (!_h || dt === _metaKey) return;
        _metaKey = dt;
        _metaCache = dt ? _h.parseDrumTabMeta(dt, _drumTabHitsToNotes) : null;
        if (_session && _chartRefs) _session.setMeta(_metaCache);
    }

    // ── Difficulty ──

    // Chart for the selected difficulty, memoised on the source arrays so
    // identities stay stable across frames (the session reloads only when
    // they change). Before session.js loads the chart plays as it is.
    function _applyDifficulty(bundle, notes, chords) {
        const H = _h;
        if (!H) return { notes, chords };
        const chordKey = (Array.isArray(chords) && chords.length) ? chords : null;
        if (!_has2xMemo || _has2xMemo.notes !== notes || _has2xMemo.chords !== chordKey) {
            _has2xMemo = { notes, chords: chordKey, val: H.hasKick2x(notes, chordKey) };
        }
        _diffOptions = H.difficultyOptions({ meta: _metaCache, has2x: _has2xMemo.val });
        _diff = H.resolveDifficulty(_cfg.difficulty, _diffOptions);
        const id = _diff.id;
        const src = _metaCache && _metaCache.levels ? (_metaCache.levels[id] || null) : null;
        const m = _lvlMemo;
        if (!m || m.notes !== notes || m.chords !== chordKey || m.id !== id || m.src !== src) {
            const switched = !!(m && m.notes === notes && m.chords === chordKey && m.id !== id);
            const chart = H.difficultyChart(id, notes, chordKey || chords, _metaCache);
            _lvlMemo = { notes, chords: chordKey, id, src, chart };
            // Same song, other difficulty: the session reloads (scoring
            // from the current time, like a seek); clear the hit marks.
            if (switched) _resetScoring();
        }
        _refreshDifficultyUI();
        _syncAuto();
        return _lvlMemo.chart;
    }

    // Auto kick / cymbals follow the difficulty being played.
    function _syncAuto() {
        const a = _autoAt(_diff ? _diff.id : _cfg.difficulty);
        if (a.kick !== _auto.kick || a.cymbals !== _auto.cymbals) {
            _auto = a;
            _resetScoring();
        }
        if (_session) _session.setAuto(_auto);
    }

    function _assistsChanged() {
        _syncAuto();
        if (_session) _session.setParams(_timingParams());
    }

    function _proCymbalsChanged() {
        if (_session) _session.setProDrums(_cfg.proCymbals);
    }

    function _inputOffsetChanged() {
        if (_session) _session.setInputOffset(_cfg.inputOffsetMs);
    }

    function _difficultyChanged() {
        if (_h && _diffOptions) _diff = _h.resolveDifficulty(_cfg.difficulty, _diffOptions);
        _refreshDifficultyUI(true);
    }

    function _optionsHtml() {
        const H = _h;
        const opts = _diffOptions || (H ? H.difficultyOptions({}) : null);
        const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        return DIFFICULTY_IDS.map((id) => {
            const o = opts ? opts.find(x => x.id === id) : null;
            const off = !!(o && !o.available);
            const text = DIFFICULTY_NAMES[id] + (o && o.generated ? ' (auto)' : '') + (off ? ' – n/a' : '');
            return `<option value="${id}"${id === _cfg.difficulty ? ' selected' : ''}${off ? ' disabled' : ''}`
                + `${off && o.reason ? ` title="${esc(o.reason)}"` : ''}>${esc(text)}</option>`;
        }).join('');
    }

    function _difficultyNote() {
        if (!_diff) return '';
        if (_diff.fallback) {
            return 'Playing Expert: ' + (_diff.reason || (DIFFICULTY_NAMES[_diff.requested] + ' is not available'));
        }
        const o = _diffOptions ? _diffOptions.find(x => x.id === _diff.id) : null;
        return o && o.generated ? DIFFICULTY_NAMES[_diff.id] + ' is auto-generated from Expert' : '';
    }

    // Push the difficulty state into the DOM (badge tooltip, settings
    // panel, open menu) when it changed.
    function _refreshDifficultyUI(force) {
        const H = _h;
        if (!H || !_diff || !_diffOptions) return;
        const key = _cfg.difficulty + '|' + _diff.id + '|' + _diff.fallback + '|'
            + _diffOptions.map(o => (o.available ? 1 : 0) + (o.generated ? 'g' : '') + o.reason).join(',');
        if (!force && key === _diffUiKey) return;
        _diffUiKey = key;
        _badge = H.difficultyBadge(_diff, _diffOptions);
        if (_badgeBtn) {
            _badgeBtn.title = _badge.title + '. Click, or press D / Shift+D, to change.';
            _badgeBtn.setAttribute('aria-label', 'Drum difficulty: ' + _badge.text
                + (_badge.sub ? ' ' + _badge.sub : '') + '. Change difficulty');
            _badgeBtn.dataset.difficulty = _badge.id;
            _badgeBtn.dataset.fallback = _badge.fallback ? '1' : '0';
        }
        if (_settingsPanel) {
            const sel = _settingsPanel.querySelector('.drums-difficulty-select');
            if (sel) { sel.innerHTML = _optionsHtml(); sel.value = _cfg.difficulty; }
            const note = _settingsPanel.querySelector('.drums-difficulty-note');
            if (note) note.textContent = _difficultyNote();
        }
        if (_diffMenu && _diffMenu.style.display !== 'none') _renderDiffMenu();
    }

    // Clickable (transparent) button over the HUD difficulty badge.
    function _ensureBadge() {
        if (_badgeBtn || !_highwayCanvas || !_highwayCanvas.parentNode) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'drums-diff-badge';
        b.dataset.drumsInstance = String(_instanceId);
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-label', 'Change drum difficulty');
        b.style.cssText = 'position:absolute;z-index:3;display:none;margin:0;padding:0;border:0;'
            + 'background:transparent;cursor:pointer;border-radius:999px;';
        b.onclick = (e) => {
            e.stopPropagation();
            b.blur();   // keep Space = play/pause rather than "click the badge again"
            _toggleDiffMenu();
        };
        const after = _hudCanvas || _highwayCanvas;
        after.parentNode.insertBefore(b, after.nextSibling);
        _badgeBtn = b;
        _diffUiKey = '';
        _refreshDifficultyUI();
    }

    // rect: the badge in canvas css px (from the 2D draw / 3D HUD), or null to hide.
    function _placeBadge(rect) {
        if (!_badgeBtn) return;
        if (!rect || !_hwVisible || !_highwayCanvas) {
            if (_badgeRectKey !== '') { _badgeBtn.style.display = 'none'; _badgeRectKey = ''; }
            return;
        }
        const x = Math.round(_highwayCanvas.offsetLeft + rect.x);
        const y = Math.round(_highwayCanvas.offsetTop + rect.y);
        const w = Math.round(rect.w), h = Math.round(rect.h);
        const key = x + '|' + y + '|' + w + '|' + h;
        if (key === _badgeRectKey) return;
        _badgeRectKey = key;
        const st = _badgeBtn.style;
        st.left = x + 'px'; st.top = y + 'px'; st.width = w + 'px'; st.height = h + 'px';
        st.display = '';
    }

    // The timing meter's Apply pill: a transparent button over it sets the
    // input offset to the suggested value (and restarts the meter).
    let _timingBtn = null, _timingRectKey = '', _timingWant = null;
    function _placeTimingBtn(rect, want) {
        if (!rect || !_hwVisible || !_highwayCanvas || !_highwayCanvas.parentNode) {
            if (_timingBtn && _timingRectKey !== '') { _timingBtn.style.display = 'none'; _timingRectKey = ''; }
            return;
        }
        if (!_timingBtn) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'drums-timing-apply';
            b.dataset.drumsInstance = String(_instanceId);
            b.setAttribute('aria-label', 'Apply the suggested input offset');
            b.style.cssText = 'position:absolute;z-index:3;display:none;margin:0;padding:0;border:0;'
                + 'background:transparent;cursor:pointer;border-radius:999px;';
            b.onclick = (e) => {
                e.stopPropagation();
                b.blur();   // keep Space = play/pause
                if (Number.isFinite(_timingWant)) _setInputOffset(_timingWant);
            };
            _highwayCanvas.parentNode.insertBefore(b, _highwayCanvas.nextSibling);
            _timingBtn = b;
        }
        _timingWant = want;
        _timingBtn.title = 'Set the input offset to ' + want + ' ms (now ' + _cfg.inputOffsetMs + ' ms)';
        const x = Math.round(_highwayCanvas.offsetLeft + rect.x), y = Math.round(_highwayCanvas.offsetTop + rect.y);
        const w = Math.round(rect.w), h = Math.round(rect.h);
        const key = x + '|' + y + '|' + w + '|' + h;
        if (key === _timingRectKey) return;
        _timingRectKey = key;
        const st = _timingBtn.style;
        st.left = x + 'px'; st.top = y + 'px'; st.width = w + 'px'; st.height = h + 'px';
        st.display = '';
    }

    function _renderDiffMenu() {
        const menu = _diffMenu;
        if (!menu) return;
        menu.textContent = '';
        const head = document.createElement('div');
        head.textContent = 'Difficulty';
        head.style.cssText = 'font:700 10px system-ui,sans-serif;color:#7a84a6;padding:2px 8px 4px;'
            + 'letter-spacing:0.08em;text-transform:uppercase;';
        menu.appendChild(head);
        const colors = (_h && _h.DIFFICULTY_COLORS) || {};
        for (const o of (_diffOptions || [])) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'drums-diff-option';
            item.dataset.diff = o.id;
            item.setAttribute('role', 'menuitemradio');
            const current = !!(_diff && _diff.id === o.id);
            item.setAttribute('aria-checked', current ? 'true' : 'false');
            item.disabled = !o.available;
            if (!o.available) item.title = o.reason;
            item.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:4px 8px;'
                + 'font:700 12px system-ui,sans-serif;background:' + (current ? 'rgba(255,255,255,0.09)' : 'transparent') + ';'
                + 'color:' + (o.available ? (colors[o.id] || '#ddd') : '#5a6078') + ';'
                + 'cursor:' + (o.available ? 'pointer' : 'not-allowed') + ';';
            const label = document.createElement('span');
            label.textContent = (current ? '▸ ' : ' ') + o.name;
            item.appendChild(label);
            const tag = (text) => {
                const g = document.createElement('span');
                g.textContent = ' ' + text;
                g.style.cssText = 'font:800 9px system-ui,sans-serif;color:#9aa4c4;';
                item.appendChild(g);
            };
            if (o.generated) tag('AUTO');
            if (_diff && _diff.fallback && _diff.requested === o.id) tag('(saved)');
            if (!o.available && o.reason) {
                const r = document.createElement('div');
                r.textContent = o.reason;
                r.style.cssText = 'font:400 10px system-ui,sans-serif;color:#5a6078;padding-left:1.3em;white-space:normal;';
                item.appendChild(r);
            }
            item.onclick = (e) => {
                e.stopPropagation();
                item.blur();
                _toggleDiffMenu(false);
                _setDifficulty(o.id);
            };
            menu.appendChild(item);
        }
    }

    function _toggleDiffMenu(open) {
        const isOpen = !!(_diffMenu && _diffMenu.style.display !== 'none');
        if (open === undefined) open = !isOpen;
        if (!open) {
            if (_diffMenu) _diffMenu.style.display = 'none';
            if (_onMenuOutside) { document.removeEventListener('pointerdown', _onMenuOutside, true); _onMenuOutside = null; }
            return;
        }
        if (!_badgeBtn || !_badgeBtn.parentNode) return;
        if (!_diffMenu) {
            const m = document.createElement('div');
            m.className = 'drums-diff-menu';
            m.dataset.drumsInstance = String(_instanceId);
            m.setAttribute('role', 'menu');
            m.style.cssText = 'position:absolute;z-index:26;display:none;min-width:150px;max-width:260px;padding:4px;'
                + 'background:rgba(8,10,24,0.96);border:1px solid #2a3150;border-radius:8px;'
                + 'box-shadow:0 6px 20px rgba(0,0,0,0.5);';
            _badgeBtn.parentNode.insertBefore(m, _badgeBtn.nextSibling);
            _diffMenu = m;
        }
        _renderDiffMenu();
        const bx = _badgeBtn.offsetLeft, by = _badgeBtn.offsetTop, bh = _badgeBtn.offsetHeight;
        _diffMenu.style.left = bx + 'px';
        _diffMenu.style.top = (by + bh + 4) + 'px';
        _diffMenu.style.display = '';
        // Open upward when it would run off the bottom of the highway.
        if (_highwayCanvas) {
            const mh = _diffMenu.offsetHeight;
            const bottom = _highwayCanvas.offsetTop + _highwayCanvas.offsetHeight;
            if (by + bh + 4 + mh > bottom && by - mh - 4 >= _highwayCanvas.offsetTop) {
                _diffMenu.style.top = (by - mh - 4) + 'px';
            }
        }
        if (!_onMenuOutside) {
            _onMenuOutside = (e) => {
                if (_diffMenu && _diffMenu.contains(e.target)) return;
                if (_badgeBtn && _badgeBtn.contains(e.target)) return;
                _toggleDiffMenu(false);
            };
            document.addEventListener('pointerdown', _onMenuOutside, true);
        }
    }

    function _removeDifficultyUI() {
        _toggleDiffMenu(false);
        if (_diffMenu) { _diffMenu.remove(); _diffMenu = null; }
        if (_badgeBtn) { _badgeBtn.remove(); _badgeBtn = null; }
        if (_timingBtn) { _timingBtn.remove(); _timingBtn = null; }
        _badgeRectKey = '';
        _timingRectKey = '';
        if (_onDiffKey) { window.removeEventListener('keydown', _onDiffKey, true); _onDiffKey = null; }
        if (_onSpKey) { window.removeEventListener('keydown', _onSpKey, true); _onSpKey = null; }
    }

    // D = harder, Shift+D = easier (focused, visible panel only; not while typing).
    function _wireDifficultyKey() {
        if (_onDiffKey) return;
        _onDiffKey = (e) => {
            if (_instanceDestroyed || !_isReady || !_isFocused || !_hwVisible || !_h) return;
            const H = _h;
            if (H.isTypingTarget(e.target) || H.isTypingTarget(document.activeElement)) return;
            const k = H.isDifficultyKey(e);
            if (!k) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            _setDifficulty(H.nextDifficulty(_diff ? _diff.id : _cfg.difficulty, _diffOptions, k.dir));
        };
        window.addEventListener('keydown', _onDiffKey, true);
    }

    // Enter = activate star power on charts without fills (with fills the
    // fill-end note activates it). Only when it can activate right now, so
    // Enter keeps its usual meaning otherwise.
    let _onSpKey = null;
    function _wireStarPowerKey() {
        if (_onSpKey) return;
        _onSpKey = (e) => {
            if (_instanceDestroyed || !_isReady || !_isFocused || !_hwVisible || !_h || !_session) return;
            if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.key !== 'Enter') return;
            if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
            const H = _h;
            if (H.isTypingTarget(e.target) || H.isTypingTarget(document.activeElement)) return;
            const ae = document.activeElement;
            if (ae && /^(BUTTON|A)$/.test(String(ae.tagName || '').toUpperCase())) return;
            const eng = _session.engine;
            const st = _session.getState();
            if (!eng || !eng.manualActivation || !st || !st.starPower || !st.starPower.canActivate || st.starPower.active) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            _session.activate(_inputTime());
        };
        window.addEventListener('keydown', _onSpKey, true);
    }

    // The badge is drawn on the lane canvas, top centre: left of the score
    // HUD when it shows (hudLeft), else on its own (the player's song title
    // overlay owns the top-left corner).
    function _drawDifficulty2D(ctx, W, hudLeft) {
        const b = _badge;
        if (!b) { _placeBadge(null); return; }
        const y = 8, h = 20, padX = 8, gap = 5;
        ctx.save();
        ctx.font = 'italic bold 11px sans-serif';
        const tw = ctx.measureText(b.text).width;
        ctx.font = 'bold 8px sans-serif';
        const sw = b.sub ? ctx.measureText(b.sub).width + gap : 0;
        const w = tw + sw + padX * 2;
        const x = Number.isFinite(hudLeft) ? Math.max(4, hudLeft - w - 6) : Math.round((W - w) / 2);
        ctx.fillStyle = 'rgba(8,8,20,0.8)';
        _roundRect(ctx, x, y, w, h, h / 2);
        ctx.fill();
        ctx.globalAlpha = b.fallback ? 0.55 : 1;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = 'italic bold 11px sans-serif';
        ctx.fillStyle = b.color;
        ctx.fillText(b.text, x + padX, y + h / 2 + 0.5);
        if (b.sub) {
            ctx.font = 'bold 8px sans-serif';
            ctx.fillStyle = '#9aa4c4';
            ctx.fillText(b.sub, x + padX + tw + gap, y + h / 2 + 0.5);
        }
        ctx.restore();
        _placeBadge({ x, y, w, h });
    }

    // ── Engine session ──

    // Load the difficulty's chart into the session when its arrays change
    // identity (new song / difficulty) and advance it to the playhead.
    // Empty chord lists compare as "none": the drum_tab path builds a fresh
    // [] every frame. A reload mid-song scores from the current time.
    // t: this frame's highway time (_frameClock). The session applies the
    // input offset to it, the same as to the hits.
    function _syncSession(bundle, notes, chords, t) {
        if (!_session) return;
        const chordKey = (Array.isArray(chords) && chords.length) ? chords : null;
        if (!_chartRefs || _chartRefs[0] !== notes || _chartRefs[1] !== chordKey || _chartRefs[2] !== bundle.beats) {
            _chartRefs = [notes, chordKey, bundle.beats];
            _session.load({ notes, chords, beats: bundle.beats });
            _session.setMeta(_metaCache);
            _resetScoring();
        }
        _session.update(t);
    }

    // Engine verdicts -> the lane view's hit / miss marks (keyed like the
    // drawn notes: time + GM note).
    function _drainSessionEvents() {
        if (!_session) return;
        for (const ev of _session.drainEvents()) {
            if (ev.type !== 'hit' && ev.type !== 'miss') continue;
            const info = _session.noteInfo(ev.id);
            if (!info) continue;
            (ev.type === 'hit' ? _hitNoteKeys : _missedNoteKeys).add(_noteKey(info.t, info.midi));
        }
    }

    // ── Listener refs (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _applyCanvasDims();
    const _onFocusChange = () => _updateFocusState();

    // ── Focus management ──
    //
    // _instanceDestroyed is a belt-and-suspenders gate: even if the
    // splitscreen helper ever ships without an unsubscribe (or a
    // future version renames offFocusChange), the focus-change
    // handler will no-op against a destroyed instance rather than
    // mutating torn-down state. Defensive because the helper's
    // unsubscribe pathway is the only thing standing between a
    // lingering listener and a stale closure.
    let _instanceDestroyed = false;

    function _updateFocusState() {
        if (_instanceDestroyed) return;
        // _highwayCanvas is nulled by _teardown; a focus-change
        // callback fired between destroy() and the handler
        // detaching would otherwise call isCanvasFocused(null).
        if (!_highwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_highwayCanvas);
        if (shouldFocus && !_isFocused) {
            _isFocused = true;
            _activeInstance = instance;
        } else if (!shouldFocus && _isFocused) {
            _isFocused = false;
            // Outgoing panel: stop showing pressed lanes / flashes
            // that originated from MIDI hits the panel was the
            // recipient of while focused.
            _releaseAllSounding();
            if (_activeInstance === instance) _activeInstance = null;
        }
    }

    // Per-instance cleanup: clear visual hit state. Module-level
    // `_cfg.learnLane` is NOT touched here — it's a shared sentinel,
    // and it gets cleared by _midiConnect on device swap (which
    // already iterates every live instance to call this).
    function _releaseAllSounding() {
        _heldPads.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    // ── MIDI event handler (called by _midiOnMessage via _activeInstance) ──

    // ts: when the MIDI message arrived (performance.now() clock), if known.
    function _handleDrumHit(midiNote, velocity, ts) {
        if (midiNote < 0 || midiNote > 127) return;

        // Learn mode: assign this MIDI note to the pending lane.
        // _cfg.learnLane is module-scope so the assignment + UI
        // refresh apply uniformly across every open settings panel.
        if (_cfg.learnLane !== null) {
            // Use the full customMapping (not the filtered active-only view) so
            // that inactive preset lane assignments (e.g. tom2 in rb4 mode) are
            // preserved — only the new assignment is added/overwritten.
            const map = Object.assign({}, _cfg.customMapping || _getActiveDrumMap());
            map[midiNote] = DRUM_LANES[_cfg.learnLane].id;
            _saveCfg('customMapping', map);
            _cfg.learnLane = null;
            _updateLearnUI();
            // Rebuild the "assigned" column on EVERY open settings
            // panel — customMapping is module-shared, so a Learn
            // assignment from the focused panel must also update
            // any other splitscreen panel's open settings table.
            _refreshAllMappingTables();
            return;
        }

        _heldPads.set(midiNote, { velocity, wall: performance.now() });
        _synthDrumHit(midiNote, velocity);
        _synthEnsureCtx();

        const laneIdx = _midiToLaneIdx(midiNote);
        if (laneIdx >= 0) {
            const lane = DRUM_LANES[laneIdx];
            _laneFlashes.push({
                laneIdx,
                wall: performance.now(),
                color: _rgbStr(lane.color[0], lane.color[1], lane.color[2], 0.6),
            });
        }

        if (_session && _h && _E) {
            // The star power pad (settings) activates star power instead of
            // scoring (charts without fills; with fills the fill-end note does).
            if (_cfg.spPad >= 0 && midiNote === _cfg.spPad) {
                _session.activate(_inputTime(ts));
                return;
            }
            // The engine scores: a Learn/custom mapping entry wins, else GM.
            // (The 3D view always uses the 4-lane pro layout; the 2D lane
            // presets only change how notes are drawn.)
            const m = _h.midiToPad(midiNote, _cfg.customMapping, _E.padFromMidi);
            if (m) {
                const r = _session.hit(_inputTime(ts), m.pad, { cymbal: m.cymbal, velocity: _engineVelocity(velocity) });
                if (_view !== '3d' && r && r.type === 'overhit' && laneIdx >= 0) _wrongFlashes.push({ lane: laneIdx, wall: performance.now() });
            }
            return;
        }

        if (_cfg.hitDetection) {
            _checkHit(midiNote);
        }
    }

    // ── Hit detection / accuracy scoring (against cached filter-aware arrays) ──

    function _checkHit(playedMidi) {
        const t = _latestTime;
        const notes = _latestNotes;
        const chords = _latestChords;

        // No chart cached yet (song-change reconnect window, or the
        // very first frame after init before draw has caught up). Skip
        // scoring entirely — counting a hit as a miss here would inflate
        // the miss counter every time the user noodles on the pad during
        // a song switch, with no matching notes to score against.
        const notesEmpty = !notes || notes.length === 0;
        const chordsEmpty = !chords || chords.length === 0;
        if (notesEmpty && chordsEmpty) return;

        const playedLane = _midiToLaneIdx(playedMidi);
        if (playedLane < 0) return;
        if (_laneIsAuto(playedLane, _auto)) return;   // played for you: no hit, no miss

        let foundHit = false;

        if (notes) {
            for (const n of notes) {
                if (n.t > t + HIT_TOLERANCE + 0.5) break;
                if (n.t < t - HIT_TOLERANCE - 0.5) continue;
                // Skip visual-only flam ghost notes — they must not consume the hit
                // window and prevent the main strike from registering.
                if (n._noScore) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const songLane = _songNoteToLaneIdx(songMidi);
                const key = _noteKey(n.t, songMidi);
                if (songLane === playedLane && Math.abs(n.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                    _hitNoteKeys.add(key);
                    foundHit = true;
                    break;
                }
            }
        }

        if (!foundHit && chords) {
            for (const c of chords) {
                if (c.t > t + HIT_TOLERANCE + 0.5) break;
                if (c.t < t - HIT_TOLERANCE - 0.5) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const songLane = _songNoteToLaneIdx(songMidi);
                    const key = _noteKey(c.t, songMidi);
                    if (songLane === playedLane && Math.abs(c.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                        _hitNoteKeys.add(key);
                        foundHit = true;
                        break;
                    }
                }
                if (foundHit) break;
            }
        }

        if (foundHit) {
            _hits++;
            _streak++;
            if (_streak > _bestStreak) _bestStreak = _streak;
        } else {
            _misses++;
            _streak = 0;
            _wrongFlashes.push({ lane: playedLane, wall: performance.now() });
        }
    }

    function _updateMissedNotes(t, notes, chords) {
        _expireFlashes();
        // With the engine loaded its verdicts mark the notes (_drainSessionEvents).
        if (!_cfg.hitDetection || _session) return;
        const cutoff = t - HIT_TOLERANCE - 0.05;

        if (notes) {
            for (const n of notes) {
                if (n.t > cutoff) break;
                if (n.t < cutoff - 2) continue;
                // Skip visual-only notes (e.g. flam leading ghost glyph) — the
                // user is expected to hit the main note, not the grace ornament.
                if (n._noScore) continue;
                const songMidi = noteToMidi(n.s, n.f);
                if (_laneIsAuto(_songNoteToLaneIdx(songMidi), _auto)) continue;
                const key = _noteKey(n.t, songMidi);
                if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && n.t < cutoff) {
                    _missedNoteKeys.add(key);
                }
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > cutoff) break;
                if (c.t < cutoff - 2) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    if (_laneIsAuto(_songNoteToLaneIdx(songMidi), _auto)) continue;
                    const key = _noteKey(c.t, songMidi);
                    if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && c.t < cutoff) {
                        _missedNoteKeys.add(key);
                    }
                }
            }
        }
    }

    function _expireFlashes() {
        const now = performance.now();
        while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
            _wrongFlashes.shift();
        }
        while (_laneFlashes.length && now - _laneFlashes[0].wall > 300) {
            _laneFlashes.shift();
        }
        for (const [midi, info] of _heldPads) {
            if (now - info.wall > 200) _heldPads.delete(midi);
        }
    }

    function _resetScoring() {
        _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
        _hitNoteKeys.clear();
        _missedNoteKeys.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    function _resetForNewChart() {
        _resetScoring();
        _heldPads.clear();
        _chartRefs = null;
        _metaKey = undefined;
        _metaCache = null;
        // Drop the drum_tab → notes memo so a song-change replay
        // doesn't keep showing the previous chart's drum hits while
        // the new bundle is still loading.
        _drumTabCacheKey = null;
        _drumTabCacheNotes = null;
        // Wave C: no _primeLatestSnapshot — we don't consult the
        // bare `window.highway` global anymore (it's the main-
        // player's highway, not ours under splitscreen). First
        // MIDI hits before the first draw() just don't score.
    }

    // ── Settings panel + gear button (per-instance) ──

    function _injectSettingsGear() {
        if (_settingsGear) return;
        const anchor = _ssSettingsAnchor(_highwayCanvas) ||
                       document.getElementById('player-controls');
        if (!anchor) return;

        const gear = document.createElement('button');
        gear.className = 'btn-drums-settings px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        gear.dataset.drumsInstance = String(_instanceId);
        gear.type = 'button';
        gear.title = 'Drum settings (MIDI, sounds, scoring)';
        // Accessible name for screen readers — title alone is announced
        // inconsistently, and the glyph itself would otherwise surface
        // as "black gear" or similar ambiguous text.
        gear.setAttribute('aria-label', 'Drum settings');
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = '⚙';
        gear.appendChild(glyph);
        gear.onclick = _toggleSettings;

        if (_ssActive()) {
            // Splitscreen: append to the panel bar.
            anchor.appendChild(gear);
        } else {
            // Main-player: insert before the close button. Scope the
            // selector to direct children — `button:last-child` alone
            // matches any descendant button that's its own parent's
            // last child, and #player-controls contains nested wrappers
            // (e.g. #mixer-anchor > #btn-mixer) whose lone button
            // qualifies and appears earlier in document order than the
            // real close button. insertBefore on a node that isn't a
            // direct child of `anchor` throws NotFoundError DOMException.
            const closeBtn = anchor.querySelector(':scope > button:last-of-type');
            if (closeBtn && closeBtn.parentNode === anchor) anchor.insertBefore(gear, closeBtn);
            else anchor.appendChild(gear);
        }
        _settingsGear = gear;
    }

    function _removeSettingsGear() {
        if (_settingsGear) {
            _settingsGear.remove();
            _settingsGear = null;
        }
    }

    function _toggleSettings() {
        _settingsVisible = !_settingsVisible;
        if (!_settingsPanel && _settingsVisible) _createSettingsPanel();
        if (_settingsPanel) _settingsPanel.style.display = _settingsVisible ? '' : 'none';
        if (_settingsVisible) {
            _midiInit();
            _synthInit();
            _midiUpdateAllDeviceLists();
        }
    }

    function _createSettingsPanel() {
        if (_settingsPanel) return;
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return;

        const panel = document.createElement('div');
        panel.className = 'drums-settings-panel';
        panel.dataset.drumsInstance = String(_instanceId);
        panel.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:25;' +
            'background:rgba(8,8,20,0.94);border-bottom:1px solid #222;padding:6px 12px;' +
            'font-family:system-ui,sans-serif;display:none;max-height:50%;overflow-y:auto;';

        const channelOpts = '<option value="-1"' + (_cfg.midiChannel === -1 ? ' selected' : '') + '>All</option>' +
            '<option value="9"' + (_cfg.midiChannel === 9 ? ' selected' : '') + '>10 (Drums)</option>' +
            Array.from({length: 16}, (_, i) =>
                i === 9 ? '' : `<option value="${i}"${_cfg.midiChannel === i ? ' selected' : ''}>${i + 1}</option>`
            ).join('');

        // All form controls use classes (not ids) so N panels don't
        // collide on getElementById lookups. Handlers bind via
        // panel.querySelector scoped to this specific panel.
        panel.innerHTML = `
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">MIDI</span>
                    <select class="drums-midi-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;max-width:180px;">
                        <option value="">None</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Vol</span>
                    <input type="range" class="drums-vol-slider" min="0" max="100"
                        value="${Math.round(_cfg.synthVolume * 100)}"
                        style="width:70px;accent-color:#ef4444;height:14px;">
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Ch</span>
                    <select class="drums-channel-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:72px;">
                        ${channelOpts}
                    </select>
                </div>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;">
                    Lanes
                    <select class="drums-lane-preset" aria-label="Lane preset"
                        style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:110px;">
                        <option value="phase_shift_8"${_cfg.lanePreset === 'phase_shift_8' ? ' selected' : ''}>Phase Shift 8</option>
                        <option value="rb4"${_cfg.lanePreset === 'rb4' ? ' selected' : ''}>Rock Band</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="drums-chk-labels" ${_cfg.showLaneLabels ? 'checked' : ''}
                        style="accent-color:#ef4444;"> Labels
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;"
                    title="Show the score: hit / miss marks on the notes, score, multiplier, streak and star power.">
                    <input type="checkbox" class="drums-chk-hits" ${_cfg.hitDetection ? 'checked' : ''}
                        style="accent-color:#22cc66;"> Score
                </label>
                <button class="drums-reset-map" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                    padding:2px 8px;font-size:10px;color:#aaa;cursor:pointer;">Reset Map</button>
            </div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="3D drum track (needs WebGL2) or the 2D lane view. Auto picks 3D when WebGL2 is available.">
                    View
                    <select class="drums-view-select" aria-label="Drum view" style="${_SEL_CSS}width:82px;">
                        <option value="auto"${_cfg.view === 'auto' ? ' selected' : ''}>Auto</option>
                        <option value="3d"${_cfg.view === '3d' ? ' selected' : ''}>3D</option>
                        <option value="2d"${_cfg.view === '2d' ? ' selected' : ''}>2D</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;"
                    title="Play with the keyboard: B kick, F red, J/K/L yellow/blue/green, Shift or U/I/O for cymbals, Enter = star power.">
                    <input type="checkbox" class="drums-chk-keys" ${_cfg.keyboard ? 'checked' : ''}
                        style="accent-color:#3b82f6;"> Keys
                </label>
                <span class="drums-view-note" style="font-size:10px;color:#666;">${_view === '3d' ? '3D view active' : '2D view active'}</span>
            </div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Drum difficulty, saved in this browser. Expert+ adds the double-kick notes. Easy/Medium/Hard need a chart that has them; otherwise the song plays Expert. While playing: click the difficulty badge, or press D (harder) / Shift+D (easier).">
                    Difficulty
                    <select class="drums-difficulty-select" aria-label="Drum difficulty" style="${_SEL_CSS}width:128px;">
                        ${_optionsHtml()}
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;"
                    title="On: pro drums, cymbals and toms of the same colour are separate notes. Off: either the cymbal or the tom of a colour hits that colour's notes.">
                    <input type="checkbox" class="drums-chk-pro" ${_cfg.proCymbals ? 'checked' : ''}
                        style="accent-color:#eab308;"> Pro cymbals
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="How early or late a hit can be and still count.">
                    Timing
                    <select class="drums-timing-select" aria-label="Hit timing window" style="${_SEL_CSS}width:150px;">${_timingOptions(_cfg.timing)}</select>
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Input offset in ms, subtracted from each hit's time (raise it if your hits register late). The timing meter under the score suggests a value: click Apply.">
                    Offset
                    <input type="number" class="drums-offset-input" min="-250" max="250" step="1"
                        value="${_cfg.inputOffsetMs}" style="${_SEL_CSS}width:58px;"> ms
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="On charts without drum fills, star power is activated with the Enter key or this pad (it then does not score as a note).">
                    SP pad
                    <select class="drums-sp-pad" aria-label="Star power pad" style="${_SEL_CSS}width:132px;">${_spPadOptions(_cfg.spPad)}</select>
                </label>
                <span class="drums-difficulty-note" style="font-size:10px;color:#a8946a;">${_difficultyNote()}</span>
            </div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Kick notes are played for you (no score, no misses) at the difficulties picked here.">
                    Auto kick
                    <select class="drums-auto-kick" aria-label="Auto kick" style="${_SEL_CSS}width:118px;">${_autoOptions(_cfg.autoKick)}</select>
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Cymbal notes (hi-hat, ride, crash) are played for you at the difficulties picked here.">
                    Auto cymbals
                    <select class="drums-auto-cym" aria-label="Auto cymbals" style="${_SEL_CSS}width:118px;">${_autoOptions(_cfg.autoCymbals)}</select>
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Volume of the kick / cymbal notes played for you (so a muted drum stem has no holes).">
                    Auto vol
                    <input type="range" class="drums-autovol-slider" min="0" max="100"
                        value="${Math.round(_cfg.autoVolume * 100)}" style="width:70px;accent-color:#ef4444;height:14px;">
                </label>
            </div>
            <details style="margin-top:2px;">
                <summary style="font-size:10px;color:#666;cursor:pointer;">MIDI Mapping</summary>
                <table class="drums-map-table" style="font-size:11px;margin-top:4px;">${_buildMappingRows()}</table>
            </details>`;

        if (panelChrome) {
            panelChrome.appendChild(panel);
        } else {
            const controls = document.getElementById('player-controls');
            if (controls && controls.parentNode === mount) mount.insertBefore(panel, controls);
            else mount.appendChild(panel);
        }
        _settingsPanel = panel;

        panel.querySelector('.drums-midi-select').onchange = function () {
            _midiConnect(this.value);
            _synthInit();
        };
        panel.querySelector('.drums-vol-slider').oninput = function () {
            _synthSetVolume(parseInt(this.value) / 100);
        };
        panel.querySelector('.drums-channel-select').onchange = function () {
            _saveCfg('midiChannel', parseInt(this.value));
        };
        panel.querySelector('.drums-lane-preset').onchange = function () {
            _saveCfg('lanePreset', this.value);
            // Rebuild DRUM_LANES + _midiToLane in place (mutated arrays,
            // not reassigned) so existing geometry closures keep their
            // references. _refreshAllMappingTables() re-renders every open
            // panel's lane rows so Learn-mode data-lane indexes stay correct
            // after the preset change; also sync all preset selectors so a
            // second open panel reflects the new choice.
            _applyLanePreset(_cfg.lanePreset);
            // Clear the Learn-mode lane sentinel: the lane count may have
            // changed, so a stale _cfg.learnLane could index beyond DRUM_LANES
            // bounds in _handleDrumHit() or remap into the wrong lane.
            _cfg.learnLane = null;
            document.querySelectorAll('.drums-lane-preset').forEach(sel => {
                sel.value = _cfg.lanePreset;
            });
            _refreshAllMappingTables();
        };
        panel.querySelector('.drums-chk-labels').onchange = function () {
            _saveCfg('showLaneLabels', this.checked);
        };
        panel.querySelector('.drums-chk-hits').onchange = function () {
            _saveCfg('hitDetection', this.checked);
            if (this.checked) _resetScoring();
        };
        panel.querySelector('.drums-reset-map').onclick = function () {
            _saveCfg('customMapping', null);
            // Rebuild the mapping table inline so the `<details>`
            // open state and panel scroll position survive the
            // reset. customMapping is module-shared, so refresh
            // EVERY open settings panel's table — not just this
            // one — to keep splitscreen UIs consistent.
            _refreshAllMappingTables();
            _midiUpdateAllDeviceLists();
        };

        panel.querySelector('.drums-view-select').onchange = function () {
            _saveCfg('view', this.value);
            document.querySelectorAll('.drums-view-select').forEach(sel => { sel.value = _cfg.view; });
            // Main player: swap in a renderer for the new view right away
            // (contextType is fixed per instance). Splitscreen panels pick
            // it up the next time their renderer is created.
            const want = _resolveView(_cfg.view, _canWebGL2());
            const hw = window.highway;
            if (want !== _view && !_ssActive() && _highwayCanvas && _highwayCanvas.id === 'highway'
                && hw && typeof hw.setRenderer === 'function') {
                setTimeout(() => {
                    if (_instances.has(instance)) hw.setRenderer(createFactory());
                }, 0);
            }
        };
        panel.querySelector('.drums-chk-keys').onchange = function () {
            _saveCfg('keyboard', this.checked);
            document.querySelectorAll('.drums-chk-keys').forEach(el => { el.checked = _cfg.keyboard; });
        };
        panel.querySelector('.drums-chk-pro').onchange = function () {
            _setProCymbals(this.checked);
        };
        panel.querySelector('.drums-difficulty-select').onchange = function () {
            _setDifficulty(this.value);
        };
        panel.querySelector('.drums-offset-input').onchange = function () {
            _setInputOffset(this.value);
        };
        panel.querySelector('.drums-sp-pad').onchange = function () { _setSpPad(this.value); };
        panel.querySelector('.drums-auto-kick').onchange = function () { _setAssist('autoKick', this.value); };
        panel.querySelector('.drums-auto-cym').onchange = function () { _setAssist('autoCymbals', this.value); };
        panel.querySelector('.drums-timing-select').onchange = function () { _setAssist('timing', this.value); };
        panel.querySelector('.drums-autovol-slider').oninput = function () { _setAutoVolume(parseInt(this.value, 10) / 100); };

        _wireLearnButtons(panel);
    }

    function _removeSettingsPanel() {
        if (_settingsPanel) {
            _settingsPanel.remove();
            _settingsPanel = null;
        }
        _settingsVisible = false;
    }

    // ── Canvas sizing ──
    //
    // Highway.js owns the canvas element and its CSS dimensions. It already
    // sizes the canvas to the highway area (viewport minus player-controls
    // height — see static/highway.js `resize()`), so we just need to scale
    // the backing store to DPR so 2D drawing stays crisp at HiDPI. Highway
    // calls our `resize(w, h)` callback after its own resize, which we use
    // to re-apply this — see the renderer contract below.

    function _applyCanvasDims() {
        if (_view === '3d') { _resize3D(); return; }
        if (!_drumCanvas || !_drumCtx) return;
        const rect = _drumCanvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        _drumCanvas.width = Math.round(w * dpr);
        _drumCanvas.height = Math.round(h * dpr);
        _drumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Drawing ──

    // message: text drawn over the empty lanes instead of the HUD (not a drum chart).
    function _draw(notes, chords, t, beats, message) {
        if (!_drumCanvas || !_drumCtx) return;

        // Update the MIDI-scoring snapshots FIRST — before the
        // no-chart-yet early return below. During a song change where
        // bundle.currentTime advances but notes/chords are still empty
        // (WS reconnect window), a drum hit between frames would
        // otherwise score against the PREVIOUS song's cached chart and
        // its stale t.
        _latestNotes = notes;
        _latestChords = chords;
        _latestTime = t;

        const W = _drumCanvas.width / (window.devicePixelRatio || 1);
        const H = _drumCanvas.height / (window.devicePixelRatio || 1);
        const ctx = _drumCtx;

        // Empty-but-loaded chart (e.g. arrangement filtered to nothing
        // by the difficulty slider, or a long rest). bundle.isReady is
        // already verified upstream in draw(); blank the overlay so
        // a previous chart's notes don't sit frozen on screen, but
        // the Wave B "treat empty as no chart and bail" early-return
        // is GONE — empty arrays during ready playback are still a
        // valid render path (paint backgrounds + lane labels even
        // without scrolling notes) so the kit lanes stay visible.
        _updateMissedNotes(t, notes, chords);

        const nowLineY = H * NOW_LINE_Y_FRAC;
        const topY = 0;
        const laneLayout = _computeLaneLayout(W, H);
        const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');

        // ── Background ──────────────────────────────────────────────────
        ctx.fillStyle = '#040408';
        ctx.fillRect(0, 0, W, H);

        const st = _session ? _session.getState() : null;
        const spActive = !!(st && st.starPower && st.starPower.active);
        const meta = _session ? _session.meta : null;

        // ── Lane backgrounds (vertical columns) ─────────────────────────
        for (let i = 0; i < laneLayout.length; i++) {
            const ll = laneLayout[i];
            const [r, g, b] = ll.lane.color;

            ctx.fillStyle = _rgbStr(r * 0.06, g * 0.06, b * 0.06, 0.5);
            ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);

            ctx.strokeStyle = _rgbStr(r * 0.15, g * 0.15, b * 0.15, 0.3);
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(ll.x + ll.w, topY);
            ctx.lineTo(ll.x + ll.w, nowLineY + 20);
            ctx.stroke();

            for (const flash of _laneFlashes) {
                if (flash.laneIdx === i) {
                    const age = (performance.now() - flash.wall) / 300;
                    if (age < 1) {
                        ctx.fillStyle = _rgbStr(r, g, b, 0.25 * (1 - age));
                        ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);
                    }
                }
            }
        }

        // Star power active: a blue wash over the lanes.
        if (spActive) {
            const last = laneLayout[laneLayout.length - 1];
            ctx.fillStyle = 'rgba(80,170,255,0.10)';
            ctx.fillRect(laneLayout[0].x, topY, last.x + last.w - laneLayout[0].x, nowLineY + 20);
        }
        // Fills (star power activation): a green band while star power is
        // ready; the fill ends on the note that activates it.
        if (meta && meta.activation.length && st && st.starPower && st.starPower.canActivate && !spActive) {
            const last = laneLayout[laneLayout.length - 1];
            for (const f of meta.activation) {
                if (f.end < t - 0.3 || f.start > t + VISIBLE_SECONDS) continue;
                const y0 = _timeToY(Math.min(f.end - t, VISIBLE_SECONDS), nowLineY, topY);
                const y1 = _timeToY(Math.max(f.start - t, -0.3), nowLineY, topY);
                ctx.fillStyle = 'rgba(56,255,168,0.10)';
                ctx.fillRect(laneLayout[0].x, y0, last.x + last.w - laneLayout[0].x, y1 - y0);
                ctx.fillStyle = 'rgba(56,255,168,0.7)';
                ctx.fillRect(laneLayout[0].x, y0 - 1, last.x + last.w - laneLayout[0].x, 2);
            }
        }

        // ── Kick lane separator ─────────────────────────────────────────
        if (kickIdx >= 0) {
            const kickLL = laneLayout[kickIdx];
            ctx.strokeStyle = 'rgba(255,80,80,0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(kickLL.x - 2, topY);
            ctx.lineTo(kickLL.x - 2, nowLineY + 20);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // ── Beat / measure lines ────────────────────────────────────────
        if (beats) {
            for (const b of beats) {
                const dt = b.time - t;
                if (dt < -0.1 || dt > VISIBLE_SECONDS) continue;
                const y = _timeToY(dt, nowLineY, topY);
                ctx.strokeStyle = b.measure > 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
                ctx.lineWidth = b.measure > 0 ? 1 : 0.5;
                ctx.beginPath();
                ctx.moveTo(laneLayout[0].x, y);
                ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, y);
                ctx.stroke();
            }
        }

        // ── Now line ────────────────────────────────────────────────────
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(laneLayout[0].x, nowLineY);
        ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, nowLineY);
        ctx.stroke();

        _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY, W, H);

        if (_cfg.showLaneLabels) {
            _drawLaneLabels(ctx, laneLayout, nowLineY, H);
        }

        if (message) {
            _drawMessage(ctx, W, nowLineY, message);
            return;
        }

        let hudLeft = null;
        if (_cfg.hitDetection && _session) hudLeft = _drawScoreHud(ctx, W);
        else {
            _placeTimingBtn(null);
            if (_cfg.hitDetection && (_hits + _misses) > 0) _drawAccuracyHUD(ctx, W, H);
        }

        // MIDI indicator — show on the focused panel only; non-focused
        // panels don't receive input so the dot would be misleading.
        if (_midiInput && _isFocused) {
            ctx.fillStyle = '#22cc66';
            ctx.beginPath();
            ctx.arc(W - 20, 16, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#22cc6688';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('MIDI', W - 28, 16);
        }

        _drawDifficulty2D(ctx, W, hudLeft);
    }

    function _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY /* , W, H */) {
        const allNotes = [];

        if (notes) {
            for (const n of notes) {
                const dt = n.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                allNotes.push({ midi: noteToMidi(n.s, n.f), t: n.t, ac: n.ac, mt: n.mt });
            }
        }
        if (chords) {
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                for (const cn of (c.notes || [])) {
                    allNotes.push({ midi: noteToMidi(cn.s, cn.f), t: c.t, ac: cn.ac, mt: cn.mt });
                }
            }
        }

        // Star power phrases still alive: their notes are drawn silver-white.
        // Resolved once per frame for the phrases on screen.
        const spRanges = (_session && _session.engine && _session.meta) ? _session.meta.starPower : null;
        const livePhrases = spRanges
            ? spRanges.filter(r => r.end > t - 1 && r.start < t + VISIBLE_SECONDS + 1 && !_spFailed(r)) : [];
        const inLivePhrase = (nt) => {
            for (const r of livePhrases) {
                if (nt >= r.start - 0.0001 && nt < r.end - 0.0001) return true;
            }
            return false;
        };

        for (const n of allNotes) {
            const laneIdx = _songNoteToLaneIdx(n.midi);
            if (laneIdx < 0 || laneIdx >= laneLayout.length) continue;

            const ll = laneLayout[laneIdx];
            const lane = ll.lane;
            const dt = n.t - t;
            const y = _timeToY(dt, nowLineY, topY);

            if (y < -20 || y > nowLineY + 30) continue;

            const isActive = Math.abs(dt) < 0.03;

            const nk = _noteKey(n.t, n.midi);
            let useHitColor = false, useMissColor = false;
            if (_cfg.hitDetection) {
                if (_hitNoteKeys.has(nk)) useHitColor = true;
                else if (_missedNoteKeys.has(nk)) useMissColor = true;
            }

            let [cr, cg, cb] = lane.color;
            if (useHitColor) { cr = 0; cg = 1; cb = 0.27; }
            else if (useMissColor) { cr = 0.33; cg = 0.33; cb = 0.4; }
            else if (inLivePhrase(n.t)) { cr = 0.86; cg = 0.95; cb = 1; }

            const velFactor = n.ac ? 1.3 : (n.mt ? 0.75 : 1.0);
            const cx = ll.centerX;

            if (lane.id === 'kick') {
                // Thin bar so 16th-note double-bass at 88 ms spacing
                // (≈ 26 px apart at default zoom) renders as distinct
                // bars instead of one merged strip. Previously barH=10
                // plus a 4-6 px glow on each side merged adjacent
                // kicks into a continuous block.
                const barH = Math.max(3, 4 * velFactor);
                const firstLane = laneLayout[0];
                const lastLane = laneLayout[laneLayout.length - 1];
                const fullLeft = firstLane.x;
                const fullRight = lastLane.x + lastLane.w;

                // Dim full-width underbar (replaces old wide glow — avoids
                // visibility clutter at fast rolls), then bright bar at the
                // kick lane only.
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.18 : 0.4);
                ctx.fillRect(fullLeft, y - barH / 2, fullRight - fullLeft, barH);

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.fillRect(ll.x + 2, y - barH / 2, ll.w - 4, barH);

                if (isActive && !useMissColor) {
                    ctx.fillStyle = _rgbStr(cr, cg, cb, 0.12);
                    ctx.fillRect(fullLeft, nowLineY - 5, fullRight - fullLeft, 10);
                }
            } else if (lane.symbol === 'diamond') {
                const size = (ll.w * 0.25) * velFactor;

                if (!useMissColor) {
                    const glowAlpha = isActive ? 0.5 : 0.2;
                    for (let i = 1; i >= 0; i--) {
                        const spread = (i + 1) * 2;
                        const a = glowAlpha * (0.15 + (1 - i) * 0.15);
                        ctx.strokeStyle = _rgbStr(cr, cg, cb, a);
                        ctx.lineWidth = spread;
                        ctx.beginPath();
                        ctx.moveTo(cx, y - size - spread);
                        ctx.lineTo(cx + size + spread, y);
                        ctx.lineTo(cx, y + size + spread);
                        ctx.lineTo(cx - size - spread, y);
                        ctx.closePath();
                        ctx.stroke();
                    }
                }

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.moveTo(cx, y - size);
                ctx.lineTo(cx + size, y);
                ctx.lineTo(cx, y + size);
                ctx.lineTo(cx - size, y);
                ctx.closePath();
                ctx.fill();
            } else if (lane.id === 'hihat') {
                const size = (ll.w * 0.22) * velFactor;
                const isOpen = n.midi === 46;
                const isPedal = n.midi === 44;
                const s = isPedal ? size * 0.6 : size;

                if (!useMissColor) {
                    const glowAlpha = isActive ? 0.5 : 0.2;
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, glowAlpha * 0.3);
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.moveTo(cx - s, y - s);
                    ctx.lineTo(cx + s, y + s);
                    ctx.moveTo(cx + s, y - s);
                    ctx.lineTo(cx - s, y + s);
                    ctx.stroke();
                }

                if (isOpen) {
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    ctx.arc(cx, y, s, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.font = `bold ${Math.max(8, s * 0.7)}px sans-serif`;
                    ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 0.8);
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('o', cx, y);
                } else {
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                    ctx.lineWidth = isPedal ? 1.5 : 2.5;
                    ctx.beginPath();
                    ctx.moveTo(cx - s, y - s);
                    ctx.lineTo(cx + s, y + s);
                    ctx.moveTo(cx + s, y - s);
                    ctx.lineTo(cx - s, y + s);
                    ctx.stroke();
                }
            } else {
                // Smaller radius (0.18 of lane vs 0.25) so 16th-note tom
                // rolls / fast snares render as distinct circles instead
                // of merging into one blob. Drop the wide glow rings for
                // the same reason — they add 4-6 px of visual bleed that
                // erases the gaps between fast hits.
                const radius = (ll.w * 0.18) * velFactor;

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.arc(cx, y, radius, 0, Math.PI * 2);
                ctx.fill();

                // Hard outline so adjacent circles are still individually
                // readable even when they're touching at very dense rolls.
                if (!useMissColor) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.stroke();
                }

                if (!useMissColor && radius > 4) {
                    const grad = ctx.createRadialGradient(cx - radius * 0.3, y - radius * 0.3, 0, cx, y, radius);
                    grad.addColorStop(0, _rgbStr(Math.min(cr + 0.3, 1), Math.min(cg + 0.3, 1), Math.min(cb + 0.3, 1), 0.4));
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    function _drawLaneLabels(ctx, laneLayout, nowLineY, H) {
        const labelY = nowLineY + 8;
        const labelH = H - labelY;

        ctx.fillStyle = 'rgba(8,8,20,0.85)';
        ctx.fillRect(0, labelY, laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelH);

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, labelY);
        ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelY);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const ll of laneLayout) {
            const [r, g, b] = ll.lane.color;
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = _rgbStr(r, g, b, 0.9);
            ctx.fillText(ll.lane.label, ll.centerX, labelY + labelH / 2);
        }
    }

    // A star power phrase the player already broke (a miss inside it).
    function _spFailed(range) {
        if (!_session || !_session.engine || !_session.gems.length) return false;
        const gems = _session.gems;
        const [i0, i1] = _h.visibleRange(gems, range.start - 0.0001, range.end - 0.0001);
        for (let i = i0; i < i1; i++) {
            // Auto notes and notes before a rebuild point aren't scored: skip them.
            const info = gems[i].auto ? null : _session.engine.noteInfo(gems[i].id);
            if (info) return !info.starPower;
        }
        return false;
    }

    // Engine HUD: score, multiplier, streak, stars and the star power bar
    // (top centre), plus the live drum-solo percentage.
    function _drawScoreHud(ctx, W) {
        const st = _session.getState();
        if (!st || !_h) return;
        const m = _h.hudModel(st);
        const bonus = _session.getBonus ? _session.getBonus() : null;
        const score = _h.formatScore((st.score || 0) + (bonus ? bonus.total : 0));
        ctx.save();
        const y = 6, h = 24;
        ctx.font = 'bold 13px sans-serif';
        const scoreW = Math.max(70, ctx.measureText(score).width + 16);
        const streakText = m.streakText + ' streak';
        ctx.font = 'bold 11px sans-serif';
        const streakW = ctx.measureText(streakText).width + 16;
        const multW = 34, spW = 80, starW = 66, gap = 6;
        const total = scoreW + streakW + multW + spW + starW + gap * 4;
        let x = Math.max(120, (W - total) / 2);
        const left = x;
        const box = (w) => { ctx.fillStyle = 'rgba(8,8,20,0.78)'; _roundRect(ctx, x, y, w, h, 6); ctx.fill(); };
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        // multiplier
        box(multW);
        ctx.font = 'italic bold 13px sans-serif';
        ctx.fillStyle = m.multiplierColor;
        ctx.fillText(m.multiplierText, x + multW / 2, y + h / 2);
        x += multW + gap;
        // score
        box(scoreW);
        ctx.font = 'bold 13px sans-serif';
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(score, x + scoreW / 2, y + h / 2);
        x += scoreW + gap;
        // streak
        box(streakW);
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = m.fullCombo && m.streak > 0 ? '#ffc531' : '#c8ccd8';
        ctx.fillText(streakText, x + streakW / 2, y + h / 2);
        x += streakW + gap;
        // stars
        box(starW);
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        for (let i = 0; i < 5; i++) {
            ctx.fillStyle = m.gold ? '#ffcf3a' : (i < m.stars ? '#f4f6ff' : '#3a4060');
            ctx.fillText('★', x + 5 + i * 12, y + h / 2);
        }
        ctx.textAlign = 'center';
        x += starW + gap;
        // star power bar
        box(spW);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x + 6, y + 9, spW - 12, 6);
        ctx.fillStyle = m.spActive ? '#7fe6ff' : (m.spReady ? '#bff3ff' : '#4aa8ff');
        ctx.fillRect(x + 6, y + 9, (spW - 12) * m.spAmount, 6);
        if (m.spReady && !m.spActive) {
            ctx.strokeStyle = 'rgba(191,243,255,0.8)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 5.5, y + 8.5, spW - 11, 7);
        }
        // Lines under the HUD: live drum solo, star power hint, timing meter.
        let ly = y + h + 6;
        const solo = bonus && bonus.soloLive && bonus.soloLive.active ? bonus.soloLive : null;
        if (solo) {
            const pct = solo.n ? Math.round(100 * solo.h / solo.n) : 100;
            const text = 'SOLO ' + pct + '%  ' + solo.h + '/' + solo.n;
            ctx.font = 'bold 12px sans-serif';
            const sw = ctx.measureText(text).width + 18;
            const sx = (W - sw) / 2;
            ctx.fillStyle = 'rgba(60,30,110,0.85)';
            _roundRect(ctx, sx, ly, sw, 20, 6);
            ctx.fill();
            ctx.fillStyle = '#e6dbff';
            ctx.fillText(text, W / 2, ly + 10);
            ly += 26;
        }
        const hint = _h.starPowerHint(_session.meta, st, _spPadName());
        if (hint) {
            ctx.font = 'bold 11px sans-serif';
            const hw = ctx.measureText(hint).width + 18;
            ctx.fillStyle = 'rgba(20,50,80,0.85)';
            _roundRect(ctx, (W - hw) / 2, ly, hw, 20, 6);
            ctx.fill();
            ctx.fillStyle = '#bff3ff';
            ctx.fillText(hint, W / 2, ly + 10);
            ly += 26;
        }
        ctx.restore();
        _drawTimingMeter2D(ctx, left, ly, bonus);
        return left;
    }

    // Early/late meter (2D view): the last hits as ticks on a ±100 ms bar
    // (blue early, orange late), their median, and the input offset that
    // would centre them with an Apply button (a DOM button over the pill).
    function _drawTimingMeter2D(ctx, x, y, bonus) {
        const offs = bonus && bonus.offsets ? bonus.offsets : [];
        if (!offs.length || !_h) { _placeTimingBtn(null); return; }
        const sum = _h.timingSummary(offs, _cfg.inputOffsetMs);
        const EARLY = '#66c7ff', LATE = '#ff9a40', OK = '#e5e7eb', RANGE = 100, DEAD = 10;
        const col = (ms) => (Math.abs(ms) < DEAD ? OK : ms < 0 ? EARLY : LATE);
        const h = 22, bw = 110, bh = 8;
        ctx.save();
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = 'bold 11px sans-serif';
        const word = sum.label;
        const ww = ctx.measureText(word).width;
        const applyText = sum.suggest != null ? 'Apply ' + sum.suggest + ' ms' : '';
        ctx.font = 'bold 10px sans-serif';
        const aw = applyText ? ctx.measureText(applyText).width + 16 : 0;
        const total = 52 + bw + 10 + ww + (aw ? 10 + aw : 0) + 12;
        ctx.fillStyle = 'rgba(8,8,20,0.78)';
        _roundRect(ctx, x, y, total, h, 6);
        ctx.fill();
        let cx = x + 8;
        ctx.font = 'bold 9px sans-serif';
        ctx.fillStyle = '#7a84a6';
        ctx.fillText('TIMING', cx, y + h / 2);
        cx += 44;
        const by = y + (h - bh) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(cx, by, bw, bh);
        ctx.fillStyle = 'rgba(160,170,200,0.5)';
        ctx.fillRect(cx + bw / 2 - 0.5, by, 1, bh);
        const px = (ms) => cx + bw / 2 + (bw / 2) * Math.max(-1, Math.min(1, ms / RANGE));
        offs.forEach((ms, i) => {
            ctx.globalAlpha = 0.25 + 0.75 * (i + 1) / offs.length;
            ctx.fillStyle = col(ms);
            ctx.fillRect(px(ms) - 1, by + 1, 2, bh - 2);
        });
        ctx.globalAlpha = 1;
        ctx.fillStyle = col(sum.median);
        ctx.fillRect(px(sum.median) - 1.5, by - 3, 3, bh + 6);
        cx += bw + 10;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(word, cx, y + h / 2);
        cx += ww + 10;
        if (aw) {
            const ph = 16, py = y + (h - ph) / 2;
            ctx.fillStyle = 'rgba(30,40,70,0.95)';
            _roundRect(ctx, cx, py, aw, ph, ph / 2);
            ctx.fill();
            ctx.strokeStyle = '#7f8cc0';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#f1f5f9';
            ctx.textAlign = 'center';
            ctx.font = 'bold 10px sans-serif';
            ctx.fillText(applyText, cx + aw / 2, y + h / 2 + 0.5);
            ctx.restore();
            _placeTimingBtn({ x: cx, y: py, w: aw, h: ph }, sum.suggest);
            return;
        }
        ctx.restore();
        _placeTimingBtn(null);
    }

    function _drawMessage(ctx, W, nowLineY, text) {
        ctx.save();
        ctx.font = 'bold 15px sans-serif';
        const tw = ctx.measureText(text).width + 32;
        const y = Math.max(40, nowLineY * 0.4);
        ctx.fillStyle = 'rgba(8,8,20,0.85)';
        _roundRect(ctx, (W - tw) / 2, y - 18, tw, 36, 8);
        ctx.fill();
        ctx.fillStyle = '#c8ccd8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, y);
        ctx.restore();
    }

    function _drawAccuracyHUD(ctx, W /* , H */) {
        const total = _hits + _misses;
        if (total === 0) return;

        const pct = Math.round((_hits / total) * 100);
        const text = `Accuracy: ${pct}%   Streak: ${_streak}   Best: ${_bestStreak}   ${_hits}/${total}`;

        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(text).width;
        const hudW = tw + 24;
        const hudH = 24;
        const hudX = (W - hudW) / 2;
        const hudY = 6;

        ctx.fillStyle = 'rgba(8,8,20,0.75)';
        _roundRect(ctx, hudX, hudY, hudW, hudH, 6);
        ctx.fill();

        ctx.fillStyle = pct >= 80 ? '#22cc66' : pct >= 50 ? '#ffcc33' : '#ff6644';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, hudY + hudH / 2);
    }

    // ── Teardown ──

    function _teardown() {
        // We render directly onto the canvas highway.js gives us — don't
        // remove or hide it (the next renderer needs the same element).
        // Clear our paint so a quick re-init doesn't show stale drums.
        if (_drumCanvas && _drumCtx) {
            try {
                _drumCtx.save();
                _drumCtx.setTransform(1, 0, 0, 1, 0, 0);
                _drumCtx.clearRect(0, 0, _drumCanvas.width, _drumCanvas.height);
                _drumCtx.restore();
            } catch (_) {}
        }
        _drumCanvas = null;
        _drumCtx = null;
        if (_onKeyDown) { window.removeEventListener('keydown', _onKeyDown, true); _onKeyDown = null; }
        _removeDifficultyUI();
        _unwireBus();
        _teardown3D();
        _highwayCanvas = null;
        _hwVisible = true;
        _session = null;
        _chartRefs = null;
        _metaKey = undefined;
        _metaCache = null;
        _diffOptions = null;
        _diff = null;
        _badge = null;
        _diffUiKey = '';
        _lvlMemo = null;
        _has2xMemo = null;
        _autoRelease(_instanceId);
        if (_frameClock) _frameClock.reset();
        _frameT = NaN;

        _removeSettingsPanel();
        _removeSettingsGear();

        _releaseAllSounding();

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }

    // ── Factory return: setRenderer contract ──

    const instance = {
        // highway.js reads this before init() and swaps the <canvas>
        // element when it differs from the current context type.
        contextType: _view === '3d' ? 'webgl2' : '2d',
        view: _view,
        init(canvas /* , bundle */) {
            // Defensive teardown if a prior init wasn't paired with
            // destroy. Remove listeners, restore canvas, release
            // held state — mirrors destroy() exactly, INCLUDING
            // removing from _instances and pausing MIDI if we're
            // the last live instance. Without the _instances
            // cleanup, a re-init that subsequently fails early
            // (no mount / null ctx) would leave the instance
            // orphaned in the set, making _instances.size checks
            // inaccurate and preventing _midiPauseHandler from
            // ever running.
            if (_drumCanvas || _hudCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                if (_focusSubscribed) {
                    const ss = window.slopsmithSplitscreen;
                    if (ss && typeof ss.offFocusChange === 'function') {
                        ss.offFocusChange(_onFocusChange);
                    }
                    _focusSubscribed = false;
                }
                _instances.delete(instance);
                if (_activeInstance === instance) _activeInstance = null;
                _teardown();
                _isReady = false;
                _isFocused = false;
                if (_instances.size === 0) _midiReleaseSession();
            }

            // Clear the destroyed sentinel so an init() following a
            // destroy() on the same factory object (e.g. highway
            // re-using a renderer across songs) re-enables focus
            // updates. Set to true in destroy() above — without this
            // reset, _updateFocusState would permanently no-op.
            _instanceDestroyed = false;

            // Use the canvas highway.js gives us directly — same pattern
            // as the 3D Highway plugin. Highway's CSS sizing already
            // excludes the player-controls strip, so the controls stay
            // visible at the bottom without us touching the layout. No
            // overlay, no display:none on the highway canvas, no
            // visibility-override workaround.
            _highwayCanvas = canvas;
            if (_view === '3d') {
                // Async-ready contract (feedBack#36 readyPromise): highway.js
                // reverts to its default renderer if this rejects.
                const ready = canvas ? _begin3D(canvas) : null;
                if (!ready) {
                    console.warn('[Drums] init: webgl2 context unavailable on highway canvas; aborting 3D view');
                    _teardown3D();
                    _highwayCanvas = null;
                    this.readyPromise = Promise.reject(new Error('webgl2 unavailable'));
                    this.readyPromise.catch(() => {});
                    return;
                }
                this.readyPromise = ready;
                ready.catch((e) => {
                    if (e && e.message === 'superseded') return;
                    console.error('[Drums] 3D view failed to start:', e);
                });
            } else {
                _drumCanvas = canvas;
                _drumCtx = canvas ? canvas.getContext('2d') : null;
                if (!_drumCanvas || !_drumCtx) {
                    console.warn('[Drums] init: 2D context unavailable on highway canvas; aborting');
                    _drumCanvas = null;
                    _drumCtx = null;
                    _highwayCanvas = null;
                    return;
                }
            }

            _injectSettingsGear();
            _applyCanvasDims();
            window.addEventListener('resize', _onWinResize);
            _wireBus();
            _ensureBadge();
            _wireDifficultyKey();
            _wireStarPowerKey();
            _wireKeyboard();

            const ss = window.slopsmithSplitscreen;
            // Subscribe only when splitscreen is FULLY supported and
            // active (matches the rest of the plugin's helper gating
            // through _ssActive). A partial helper that exposes
            // on/offFocusChange but lacks isCanvasFocused / panelChrome
            // / settingsAnchor would otherwise let us subscribe while
            // _ssIsCanvasFocused falls back to "always focused"
            // (main-player path), so every instance would race to
            // claim _activeInstance on every focus event and break
            // MIDI routing under the partial helper.
            if (_ssActive()) {
                ss.onFocusChange(_onFocusChange);
                _focusSubscribed = true;
            }

            _resetForNewChart();

            _instances.add(instance);

            // Kick off MIDI + synth. One-time init — subsequent
            // instances no-op out because the module singletons are
            // already populated.
            _midiInit();
            _synthInit();

            _isReady = true;
            _startScoring();

            // Determine focus BEFORE resuming the MIDI handler so
            // _activeInstance is populated when onmidimessage gets
            // wired. Otherwise a MIDI message arriving in the
            // window between _midiResumeHandler and the first
            // focus-change event would route through _midiOnMessage
            // → null _activeInstance → silently dropped. Main-player
            // fast path takes effect synchronously here too.
            _updateFocusState();
            _midiResumeHandler();
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Wave C: bundle.isReady edge detect in place of the
            // global song:ready subscription. Each panel's highway
            // emits song:ready independently; subscribing at module
            // scope would fire N×. Edge-detecting per-instance
            // correctly scopes the reset.
            const isReady = !!bundle.isReady;
            if (isReady && !_lastBundleIsReady) {
                _resetForNewChart();
            }
            _lastBundleIsReady = isReady;

            // Refresh the MIDI-scoring snapshot from the LATEST bundle
            // even on unready frames. Otherwise a pad hit during the
            // loading / reconnect window scores against the PREVIOUS
            // chart's _latestNotes (which still hold last song's data
            // until _draw refreshes them). After bundle.isReady falls
            // false the new song's notes/chords typically arrive as
            // [] until the chart loads — that's exactly what we want
            // here: _checkHit's `notesEmpty && chordsEmpty` guard
            // bails so unready hits neither score nor mis-score, and
            // the scoring resumes naturally on the first ready frame.
            //
            // drum_tab takes precedence over the standard notes stream.
            // When the active sloppak ships a `drum_tab:` manifest key,
            // the server suppresses irrelevant chord/handshape streams
            // for the drum view and the plugin renders + scores against
            // the canonical drum_tab hits via _drumTabHitsToNotes.
            let drumNotes = null;
            let drumChords = null;
            const dt = bundle.drumTab;
            if (dt && Array.isArray(dt.hits)) {
                if (_drumTabCacheKey !== dt) {
                    _drumTabCacheKey = dt;
                    _drumTabCacheNotes = _drumTabHitsToNotes(dt.hits);
                }
                drumNotes = _drumTabCacheNotes;
                drumChords = [];  // drum_tab carries no chord templates
            } else {
                // Legacy path: drums encoded as guitar notes
                // (`midi = string * 24 + fret`). The renderer's existing
                // _songNoteToLaneIdx already decodes them.
                drumNotes = bundle.notes;
                drumChords = bundle.chords;
            }
            // This highway's smoothed clock (falls back to the raw sample
            // until session.js has loaded).
            const t = _frameClock ? _frameClock.tick(+bundle.currentTime || 0, bundle.isPlaying, _now()) : (+bundle.currentTime || 0);
            _frameT = t;
            // Not a drum chart (no drum tab, and the arrangement isn't
            // Drums): e.g. a splitscreen panel left on the Drum Highway
            // falls back to Lead on a song without a Drums part. Guitar
            // notes read as drum notes (string * 24 + fret) gave a few
            // random gems to score; show a message and play / score nothing.
            const hasTab = !!(dt && Array.isArray(dt.hits));
            if (isReady && !hasTab && !_isDrumsArrangement(bundle.songInfo)) {
                _latestNotes = [];
                _latestChords = [];
                _latestTime = t;
                _autoRelease(_instanceId);
                _placeBadge(null);
                _placeTimingBtn(null);
                if (_view === '3d') _draw3D(bundle, isReady, t, _noDrumsMessage(bundle.songInfo));
                else _draw([], [], t, bundle.beats, _noDrumsMessage(bundle.songInfo));
                return;
            }
            if (isReady) {
                // Difficulty: Expert+ = the full chart, Expert drops the
                // double kicks, Easy/Medium/Hard come from the tab's levels.
                _syncMeta(hasTab ? dt : null);
                const lv = _applyDifficulty(bundle, drumNotes, drumChords);
                drumNotes = lv.notes;
                drumChords = lv.chords;
            }
            _latestNotes = drumNotes;
            _latestChords = drumChords;
            _latestTime = t;
            if (isReady) {
                _scheduleAutoSounds(drumNotes, drumChords);
                _syncSession(bundle, drumNotes, drumChords, t);
                // The 3D view reads the session's events itself (flashes, sparks).
                if (_view !== '3d') _drainSessionEvents();
            } else {
                _autoRelease(_instanceId);
            }

            if (_view === '3d') {
                _draw3D(bundle, isReady, t);
                return;
            }

            // Loading / reconnect window — chart isn't confirmed
            // yet. Paint the plugin's base background so the
            // previous chart's notes + HUD don't sit frozen on
            // screen. Once bundle.isReady flips true we hand off to
            // _draw which paints lanes + scrolling notes.
            if (!isReady) {
                if (_drumCanvas && _drumCtx) {
                    const W = _drumCanvas.width / (window.devicePixelRatio || 1);
                    const H = _drumCanvas.height / (window.devicePixelRatio || 1);
                    _drumCtx.fillStyle = '#040408';
                    _drumCtx.fillRect(0, 0, W, H);
                }
                _placeBadge(null);
                _placeTimingBtn(null);
                return;
            }

            _draw(drumNotes, drumChords, t, bundle.beats);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _applyCanvasDims();
        },
        destroy() {
            _isReady = false;
            // Set BEFORE attempting the (best-effort) unsubscribe so
            // the focus-change handler's _instanceDestroyed guard
            // catches any event that sneaks through a failed /
            // missing offFocusChange call.
            _instanceDestroyed = true;
            window.removeEventListener('resize', _onWinResize);
            if (_focusSubscribed) {
                const ss = window.slopsmithSplitscreen;
                if (ss && typeof ss.offFocusChange === 'function') {
                    ss.offFocusChange(_onFocusChange);
                }
                _focusSubscribed = false;
            }
            _instances.delete(instance);
            if (_activeInstance === instance) _activeInstance = null;
            _isFocused = false;
            // Pause the MIDI handler only if we're the last instance
            // standing. Otherwise other instances still need MIDI
            // events flowing into _midiOnMessage (which routes to the
            // currently-focused instance).
            if (_instances.size === 0) {
                _midiReleaseSession();
            }
            _teardown();
        },
        // Internal hooks used by module-level MIDI router + device-swap.
        _handleDrumHit,
        _releaseAllSounding,
        // Called by the module-level setters for every live instance.
        _difficultyChanged,
        _proCymbalsChanged,
        _assistsChanged,
        _inputOffsetChanged,
        _isVisible,
        // Read-only snapshots for debugging / tools: engine state
        // (DrumsEngine.getState()), the difficulty in use and auto lanes.
        _engineState() { return _session ? _session.getState() : null; },
        _difficulty() { return _diff ? Object.assign({ options: _diffOptions }, _diff) : null; },
        _autoLanes() { return Object.assign({}, _auto); },
    };

    return instance;
}

// The selected arrangement is a drum part (by name).
function _isDrumsArrangement(si) {
    if (!si) return false;
    if (si.arrangement && DRUMS_PATTERNS.test(si.arrangement)) return true;
    if (Array.isArray(si.arrangements)) {
        const arr = si.arrangements.find(a => a && a.index === si.arrangement_index);
        if (arr && DRUMS_PATTERNS.test(arr.name || '')) return true;
    }
    return false;
}

// What the drum view says on a part that is not drums.
function _noDrumsMessage(si) {
    si = si || {};
    const hasDrums = Array.isArray(si.arrangements)
        && si.arrangements.some((a) => a && DRUMS_PATTERNS.test(a.name || ''));
    return hasDrums ? 'Pick the Drums part: ' + (si.arrangement || 'this part') + ' is not drums'
        : 'This song has no drums';
}

// ── End-of-song results card ──────────────────────────────────────────
// Final score (engine score + session bonuses), stars, accuracy, best streak
// and where the points came from: notes x multiplier, star power, accents /
// ghosts, spot-on timing, rolls and drum solos. The best score per song and
// difficulty is kept in localStorage ("drums.best:<song>|<difficulty>").
// Shown once per song end, only when the player hit something.
let _endCardAt = -Infinity;
function _drumsEndCard(session, badge) {
    const st = session && session.getState ? session.getState() : null;
    if (!st || !(st.notesHit > 0)) return null;
    if (performance.now() - _endCardAt < 2000) return null;   // one card per song end
    _endCardAt = performance.now();
    const b = (session.getBonus && session.getBonus()) || { total: 0, timing: 0, rolls: 0, solo: 0, perfect: 0, runs: [], solos: [] };
    const bus = _bus();
    const cs = (bus && bus.currentSong) || {};
    const diff = badge && badge.text ? badge.text : 'EXPERT';
    const total = Math.round((st.score || 0) + (b.total || 0));
    const key = 'drums.best:' + (cs.filename || cs.title || '') + '|' + diff;
    let prev = null;
    try { prev = Number(localStorage.getItem(key)) || null; } catch (_) { /* storage blocked */ }
    const isBest = prev == null || total > prev;
    if (isBest) { try { localStorage.setItem(key, String(total)); } catch (_) { /* storage blocked */ } }
    const n = (x) => Math.round(x || 0).toLocaleString('en-US');
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const resolved = st.notesHit + st.notesMissed;
    const acc = resolved ? 100 * st.notesHit / resolved : 100;
    const stars = Math.floor(st.stars || 0), gold = (st.stars || 0) >= 6;
    const starHtml = Array.from({ length: 5 }, (_, i) =>
        `<span style="color:${gold ? '#ffcf3a' : i < stars ? '#f4f6ff' : '#3a4060'}">★</span>`).join('');
    const chip = (label, col) => `<span style="font-size:12px;padding:3px 9px;border-radius:10px;background:rgba(255,255,255,.06);color:${col}">${esc(label)}</span>`;
    const sp = st.starPowerScore || 0;
    const chips = [
        chip('notes × multiplier +' + n((st.score || 0) - sp), '#f1f5f9'),
        sp ? chip('star power +' + n(sp), '#8fe6ff') : '',
        (st.totalAccents || st.totalGhosts) ? chip('dynamics: ' + (st.accentsHit || 0) + '/' + (st.totalAccents || 0) + ' accents, '
            + (st.ghostsHit || 0) + '/' + (st.totalGhosts || 0) + ' ghosts', '#b77bff') : '',
        b.timing ? chip('spot-on timing +' + n(b.timing) + ' (' + b.perfect + ' hits)', '#ffc531') : '',
        b.rolls ? chip('rolls +' + n(b.rolls) + (b.runs && b.runs.length ? ' (' + b.runs.map((r) => r.h + '/' + r.n).join(', ') + ')' : ''), '#ff9a40') : '',
        b.solo ? chip('solos +' + n(b.solo), '#c9b6ff') : '',
    ].join('');
    const solos = (b.solos || []).map((x) => `<div style="color:#c9b6ff;font-size:13px">${esc(x.rating)} ${Number(x.pct).toFixed(2)}% (${x.h}/${x.n}) · +${n(x.bonus)}</div>`).join('');
    const ov = document.createElement('div');
    ov.className = 'drums-endcard';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Drums results');
    ov.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-family:system-ui,sans-serif';
    ov.innerHTML = `<div style="width:30rem;max-width:92vw;background:#0e1322;border:1px solid #2b3556;border-radius:14px;padding:22px 24px;color:#cbd5e1;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6)">
        <div style="font-size:12px;letter-spacing:3px;color:#8b95a5">DRUMS · ${esc(diff)}</div>
        ${cs.title ? `<div style="font-size:17px;color:#f1f5f9;margin-top:2px">${esc(cs.title)}${cs.artist ? `<span style="color:#8b95a5"> — ${esc(cs.artist)}</span>` : ''}</div>` : ''}
        <div style="font:900 46px/1.1 system-ui,sans-serif;color:${isBest ? '#ffc531' : '#f1f5f9'};margin-top:12px">${n(total)}</div>
        <div style="font-size:12px;color:#8b95a5">${isBest ? '<b style="color:#ffc531">NEW BEST SCORE</b>' + (prev != null ? ' · previous ' + n(prev) : '') : 'best ' + n(prev)}</div>
        <div style="font-size:26px;margin-top:6px;letter-spacing:4px">${starHtml}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:14px 0">
            <div><div style="font-weight:800;font-size:20px;color:#f1f5f9">${acc.toFixed(2)}%</div><div style="font-size:11px;color:#8b95a5">accuracy</div></div>
            <div><div style="font-weight:800;font-size:20px;color:#f1f5f9">${st.notesHit} / ${st.totalNotes}</div><div style="font-size:11px;color:#8b95a5">notes hit</div></div>
            <div><div style="font-weight:800;font-size:20px;color:${st.fullCombo ? '#ffc531' : '#f1f5f9'}">${st.fullCombo ? 'FC' : st.maxCombo}</div><div style="font-size:11px;color:#8b95a5">${st.fullCombo ? 'full combo!' : 'best streak'}</div></div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:8px">${chips}</div>
        ${solos}
        ${st.overhits ? `<div style="font-size:12px;color:#8b95a5;margin-top:4px">${st.overhits} overhit${st.overhits > 1 ? 's' : ''}</div>` : ''}
        <button type="button" class="drums-endcard-close" style="margin-top:14px;padding:6px 22px;border-radius:8px;border:1px solid #3a4670;background:#1b2440;color:#f1f5f9;cursor:pointer">Close</button>
    </div>`;
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
    function close() {
        ov.remove();
        document.removeEventListener('keydown', onKey, true);
        if (bus && typeof bus.off === 'function') { try { bus.off('song:loading', close); } catch (_) { /* ignore */ } }
    }
    ov.addEventListener('click', (e) => { if (e.target === ov || (e.target && e.target.closest && e.target.closest('.drums-endcard-close'))) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    if (bus) { try { bus.on('song:loading', close); } catch (_) { /* ignore */ } }
    return { total, best: isBest, previous: prev, accuracy: acc, element: ov, close };
}

createFactory.matchesArrangement = function (songInfo) {
    if (!songInfo) return false;
    // First-class signal: sloppaks with a top-level `drum_tab:` manifest
    // key ship a `has_drum_tab` flag on song_info regardless of which
    // guitar arrangement the user picked. The drum tab lives off to the
    // side of the arrangements list, so name-pattern matching alone
    // would miss it (a sloppak with a `Lead` arrangement + a drum_tab
    // is still drummable).
    if (songInfo.has_drum_tab) return true;
    if (songInfo.arrangement && DRUMS_PATTERNS.test(songInfo.arrangement)) return true;
    if (Array.isArray(songInfo.arrangements)) {
        const idx = songInfo.arrangement_index;
        const arr = songInfo.arrangements.find(a => a.index === idx);
        if (arr && DRUMS_PATTERNS.test(arr.name)) return true;
    }
    return false;
};

// The picker and Auto mode find one factory per plugin id
// (window.feedBackViz_<id>), so `drums` is the single entry for both
// views: each call builds a 3D or 2D renderer from the View setting
// (Auto = 3D when WebGL2 is available). No static `contextType` here on
// purpose: Auto skips factories that statically declare 'webgl2' on
// machines without WebGL2, and this one degrades to 2D by itself.
window.slopsmithViz_drums = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_drums = window.slopsmithViz_drums;
// Explicit per-view factories for hosts / tools that want one view
// regardless of the setting (not listed in the picker).
window.feedBackViz_drums3d = function () { return createFactory('3d'); };
window.feedBackViz_drums3d.contextType = 'webgl2';
window.feedBackViz_drums3d.matchesArrangement = createFactory.matchesArrangement;
window.feedBackViz_drums2d = function () { return createFactory('2d'); };
window.feedBackViz_drums2d.matchesArrangement = createFactory.matchesArrangement;

// Node-only export hook for tests; browsers keep the window.*Viz_drums wiring.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        noteToMidi, _rgbStr, _validateCustomMapping, _drumTabHitsToNotes,
        _applyLanePreset, _getActiveDrumMap, _midiToLaneIdx, _songNoteToLaneIdx,
        _midiResolveSaved, DRUM_LANES, PIECE_DEFAULT_MIDI, KICK2X_MIDI,
        matchesArrangement: createFactory.matchesArrangement,
        DIFFICULTY_IDS, STORE_KEYS, AUTO_LEVEL_IDS, TIMING_PRESETS, TIMING_IDS,
        _resolveView, _VALID_VIEWS,
        _difficultyPref: () => _cfg.difficulty, _cfg: () => _cfg,
        _setDifficulty, _setAssist, _saveCfg,
        _autoAt, _laneIsAuto, _timingParams, _autoNotesBetween, _isAutoMidi,
        _engineVelocity, _setInputOffset, _setSpPad, _spPadName, SP_PAD_CHOICES,
        _loadScoring, _routeTarget, _isDrumsArrangement, _noDrumsMessage, _drumsEndCard,
        _instances: () => _instances, _midiOnMessage,
    };
}

})();
