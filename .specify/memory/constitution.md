# Drum Highway — Plugin Constitution

This plugin replaces the guitar highway with a Rock-Band-style 8-lane drum view. It registers itself as a visualization renderer via Slopsmith core's `setRenderer` factory contract.

## Core Principles

### I. Auto-Activate for Drum Arrangements Only
The factory exposes `matchesArrangement(songInfo)` using the word-boundary regex `\b(?:drums|percussion|drum\s*kit)\b` so Auto mode picks Drums for "Drums", "Percussion", "Drum Kit", etc., never substrings like "Drumstick". Non-drum arrangements MUST fall through to the default highway.

### II. Per-Instance State Under Splitscreen (Wave C)
Rendering, scoring, held-pad state, settings UI, and listeners are closured inside `createFactory()`. N splitscreen panels can each pick "Drums" with independent state. `window.slopsmithSplitscreen` is the focus oracle; absence OR `isActive()===false` means single-instance fast path.

### III. MIDI Is a Browser Singleton — Focus Routes Events
Web MIDI has one global subscription. The currently-focused panel (most recent click) is the sole recipient of note-on events; focus change clears outgoing-panel held-pad and lane-flash state. `_cfg.learnLane` is module-scope intentionally — clicking "Learn" in any panel assigns the next pad hit globally, with class-selector UI sync.

### IV. Persisted Settings Are Hostile Input
`localStorage` reads are wrapped in `_readStore` (handles SecurityError in sandboxed iframes / Safari `file://` / disabled storage). Numeric settings flow through `_readNum` with NaN clamping. The `customMapping` validator strips `__proto__` / `constructor` / `prototype` keys and rejects non-(0-127, known-lane) entries to block prototype-pollution from synced profiles.

### V. Tight Timing Window for Hit Detection
Drums require tighter timing than guitar — `HIT_TOLERANCE = 0.05s` (50ms). Hit / miss / wrong-lane states drive lane flash, note color, and streak counters. The scoring loop is per-instance; under splitscreen only the focused panel scores.

## Inherits from Slopsmith Core Constitution

- **Vanilla JS, no bundler, no framework deps.**
- **Plugin isolation**: registers via `window.slopsmithViz_drums = createFactory` (slopsmith#36 setRenderer contract).
- **Manifest-driven loading**: `plugin.json` `id: "drums"`, `type: "visualization"`.
- **`bundle.stringCount` from core** (slopsmith#93) — falls back gracefully when missing.
- **WebAudioFont** is the in-tree drum-kit synth; no server round-trip for sound.
- **Chrome / Edge required for MIDI** (Web MIDI API). Plugin remains usable as a passive viewer in Firefox.

**Version**: 3.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
