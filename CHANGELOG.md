# Changelog

All notable changes to the Drum Highway plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `plugin.json`.

## [Unreleased]

Version 4.1.0 in `plugin.json`.

### Added
- **Rock Band-style scoring** from a JavaScript port of YARG.Core's drums engine (`assets/engine.js`,
  LGPL-3.0, see `NOTICE.md`): ±70 ms hit window, multiplier up to x4 (x8 in star power), pro-drums
  cymbal/tom lanes, accent/ghost dynamics bonus, stars, and star power with fill activation. Driven
  through `assets/session.js`, which also adds spot-on timing, roll and drum-solo bonuses. The 2D view
  marks hits / misses from the engine and shows a score HUD when **Score** is on.
- **Difficulty per player** — Easy, Medium, Hard, Expert, Expert+ (`drums_difficulty_v1`), from the
  settings panel, the HUD badge or D / Shift+D; Expert drops the double-kick notes. Easier levels, star
  power, fills and solos come from the drum tab's feedpak 1.20.0 gameplay metadata; without it the song
  plays Expert (plus Expert+ when the chart has double-kick notes, e.g. a legacy chart with GM 35 kicks),
  without star power.
- **Assists** — auto kick / auto cymbals up to a chosen difficulty (played on the drum sound at their own
  volume), hit-timing presets (Relaxed / Forgiving / Normal / Precision), **Pro cymbals** toggle and an
  input **Offset** (ms) for audio / MIDI latency.
- **Timing meter** under the score: the last 24 hits early / late on a ±100 ms bar, their median, and the
  input offset that would centre them, with an **Apply** button.
- **Star power without fills**: on charts with star power phrases but no drum fills, press **Enter** or
  hit the **SP pad** (settings: off, hi-hat pedal, ride bell, splash or china; `drums_sp_pad_v1`) to
  activate it. With fills, the note that ends a fill activates it, as before.
- **Results card** at the end of the song (single view, Score on): total score with the bonuses, best
  score per song and difficulty (`drums.best:<song>|<difficulty>` in `localStorage`), stars, accuracy,
  notes hit, best streak / full combo and where the points came from.
- The drum view on a part that isn't drums (no drum tab, arrangement not named Drums / Percussion) shows
  "This song has no drums" or "Pick the Drums part" and plays / scores nothing, instead of reading guitar
  notes as drum notes.

### Changed
- Hit timing: the view draws and scores on a smoothed per-highway clock (interpolated between the
  player's audio samples, like core's 3D highway), a pad hit is timed when the MIDI message arrived
  (its timestamp, when the MIDI provider passes one) rather than at the last frame, and the engine runs
  60 ms behind the frame clock so a hit struck just before a frame is judged at its own time instead of
  being moved forward to the frame.
- The input offset applies to the engine's clock as well as to the hits, so a positive offset no longer
  leaves a late-registered hit facing a note the engine has already missed.
- MIDI velocity reaches the engine as 0..1 (velocity / 127); velocity 1 used to count as full strength.
- Auto kick / auto cymbals are timed from the audio clock (mapped to the stems plugin's audio context
  when it is there), scheduled 100 ms ahead by one forward-only schedule shared by all drum views and
  cancelled on pause / seek: no more late or doubled auto notes.
- Splitscreen: kit hits go to the focused drum view if it is on screen, else to the drum view that is,
  so a hidden main-player drum view no longer swallows them.
- A scoring file that failed to load is loaded again on the next try (its dead `<script>` element is
  removed).
- A drum-tab hit is an accent only when the tab marks it (`a`, feedpak 1.20.0) or, for older tabs, when it
  has a written velocity of 100 or more; a hit with no velocity is no longer drawn as an accent. A kick
  marked `x2` is a double kick (GM 35).
- The "Hits" checkbox is now **Score**.
