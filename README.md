# Slopsmith Plugin: Drum Highway

![Drum Highway](screenshot.png)

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that replaces the guitar highway with a lane-based drum view, with MIDI drum pad input and a built-in drum kit synthesizer.

## Features

- **Lane-based drum highway** — 8 horizontal lanes (Hi-Hat, Snare, Tom 1-3, Crash, Ride, Kick) with notes scrolling right to left
- **Kick drum full-width bars** — kick hits render as wide horizontal bars spanning the highway, like open string notes on the guitar highway
- **Distinct note shapes** — circles for toms/snare, diamonds for cymbals, X shapes for hi-hat, full bars for kick
- **Hi-hat variations** — closed (filled X), pedal (small X at bottom), open (ring with "o" inside)
- **Neon glow effects** — each drum piece has a unique color with multi-layer glow
- **Velocity-based sizing** — louder hits are bigger, ghost notes are smaller
- **Auto-activate** — switches on automatically for Drums/Percussion arrangements
- **MIDI drum pad input** — connect any MIDI drum pad, electronic kit, or controller via Web MIDI API
- **Custom MIDI mapping** — "Learn" mode to assign any MIDI note to any lane, for non-standard drum pads
- **Built-in drum sounds** — WebAudioFont-powered GM drum kit playback on MIDI hit
- **Rock Band-style scoring** — score, multiplier, streak, stars and star power from a port of the YARG drums engine (`assets/engine.js`). See [Scoring](#scoring).
- **Difficulty** — Easy, Medium, Hard, Expert or Expert+ per player (browser), changeable mid-song. See [Difficulty](#difficulty).
- **Assists** — auto kick, auto cymbals (each up to a chosen difficulty) and hit-timing presets. See [Assists](#assists).
- **Inline settings** — MIDI device, volume, channel filter, lane labels, hit detection, and mapping table

## Drum Lanes

| Lane | Label | MIDI Notes | Color | Shape |
|------|-------|-----------|-------|-------|
| Hi-Hat | HH | 42, 44, 46 | Blue | X |
| Snare | Sn | 38, 40 | Yellow | Circle |
| Tom 1 | T1 | 48, 50 | Green | Circle |
| Tom 2 | T2 | 45, 47 | Orange | Circle |
| Tom 3 | T3 | 41, 43 | Purple | Circle |
| Crash | Cr | 49, 57 | Cyan | Diamond |
| Ride | Ri | 51, 59 | White | Diamond |
| Kick | Ki | 35, 36 | Red | Full-width bar |

## Scoring

Turn on **Score** in the settings panel (gear) to see the scoring HUD: multiplier, score, streak, stars
and the star power meter. Hit notes turn green, missed notes grey, and a pad hit on an empty lane flashes it
red.

Scoring is a JavaScript port of YARG.Core's drums engine (`assets/engine.js`, LGPL-3.0 — see
[License](#license)), used through `assets/session.js`:

- **Hit window** ±70 ms (see [Assists](#assists) for wider ones); one pad hit hits at most one note.
- **Multiplier** grows every 10 notes up to x4, doubled during star power (x8). 60 points per note (pro
  drums), plus a dynamics bonus for hitting an accent hard or a ghost note soft (needs a velocity-sensitive
  kit). Pro drums: a cymbal and the tom of the same colour are different notes; with **Pro cymbals** off
  either one hits that colour's notes.
- **Star power** — notes in a star power phrase are drawn silver-white; hitting every note of a phrase fills
  a quarter of the meter. With half a meter, the chart's **fills** are marked green: the hit that ends the
  fill activates star power. A chart with star power phrases but no fills activates it by hand: press
  **Enter** (drum view focused) or hit the **SP pad** chosen in the settings (`drums_sp_pad_v1`: off,
  hi-hat pedal 44, ride bell 53, splash 55 or china 52; that pad then activates star power instead of
  scoring as a note). The HUD says which when star power is ready.
- **Bonuses** (shown in the score) — +10 x multiplier for a hit within 25 ms, extra points for snare / tom
  rolls, and a drum-solo bonus (100 per note hit, doubled for a perfect solo) with a live percentage during
  a solo.
- **Offset** (ms) — subtracted from the time of every hit and from the engine's clock; raise it if your
  hits register late (audio or MIDI latency). The default is 0. The **timing meter** under the score
  shows the last 24 hits early (blue) / late (orange) on a ±100 ms bar and, after 6 hits that are off by
  10 ms or more, the offset that would centre them: click **Apply** to use it.
- **Hit timing** — the view runs a smoothed clock (interpolated between the player's audio samples), a pad
  hit is timed when its MIDI message arrived (when the MIDI provider passes the message's timestamp)
  rather than at the last frame, and the engine trails the frame clock by 60 ms so a hit struck just
  before a frame keeps its own time.
- **Results card** — when the song ends (single view, Score on): total score with the bonuses, best score
  per song and difficulty, stars, accuracy, notes hit, best streak and where the points came from.
- Seeking (or a loop jumping back) restarts scoring from the new position; skipped notes aren't misses.

The scoring files load on first use from core's plugin assets route (`/api/plugins/drums/assets/`). Until
they have loaded the view shows the chart as it is.

### Difficulty

Each player picks **Easy**, **Medium**, **Hard**, **Expert** or **Expert+**, stored per browser
(`localStorage` key `drums_difficulty_v1`, default Expert), so in splitscreen / multiplayer every player
keeps their own. Change it in the settings panel, by clicking the difficulty badge (top-left of the lanes),
or with **D** (harder) / **Shift+D** (easier) while the view is focused.

- **Expert+** is the drum part as charted, double kicks included; **Expert** drops the double-kick notes
  (`x2`). **Easy / Medium / Hard** come from the chart's own easier levels; the badge says **AUTO** when a
  level was reduced by software rather than hand-charted.
- A level the chart doesn't have is greyed out with the reason; a song without your saved level plays
  Expert (the badge is dimmed) and your choice is kept for the next song.
- Changing difficulty mid-song rebuilds the chart from the current position, like a seek.

### Where star power, fills and levels come from

They are part of the song's drum tab (`drum_tab.json`, feedpak 1.20.0 "drum gameplay metadata"): per-hit
`a` (accent) and `x2` (double kick) flags, `star_power` / `fills` / `solos` as `{start_time, end_time}`
ranges, and `levels.easy|medium|hard` with their own `hits` and a `generated` marker. feedBack's Rock Band /
Clone Hero / YARG chart importer writes them, and core streams them to the plugin with the tab
(`bundle.drumTab`). A tab without them — an older tab, a core that doesn't stream them yet, or drums encoded
as guitar notes — plays **Expert, without star power** (plus **Expert+** when the chart has double-kick
notes: a legacy chart's GM 35 kicks count); everything else works the same.

On a part that isn't drums (no drum tab and an arrangement not named Drums / Percussion, e.g. a
splitscreen panel left on the Drum Highway on a song without drums) the view says so and plays / scores
nothing.

### Assists

- **Auto kick / Auto cymbals** (`drums_auto_kick_v1`, `drums_auto_cymbals_v1`): `Off`, `Easy only`,
  `Easy – Medium`, `Easy – Hard` or `Every difficulty` — the assist is on at that difficulty and the ones
  below it. Those notes are left out of scoring, marked as played when they reach the now line, and pad hits
  on them are ignored. Cymbals = the chart's hi-hat, ride and crash notes. They are **played on the drum
  sound** (scheduled 100 ms ahead on the audio clock, mapped to the stems plugin's audio context when it is
  there; a pause or seek cancels what hasn't played) so muting the drum stem leaves no holes, at their own
  **Auto vol** (`drums_auto_volume_v1`, default 80%), so pads can stay silent when the kit module makes the
  sound.
- **Timing** (`drums_timing_v1`): Relaxed ±130 ms, Forgiving ±100 ms, Normal ±70 ms (YARG's default),
  Precision (YARG's dynamic window that tightens on fast notes).

## Requirements

- **Chrome or Edge** for MIDI drum pad input (Firefox does not support Web MIDI)
- MIDI features are optional — the drum view works without a MIDI controller

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/got-feedback/feedback-plugin-drums.git drums
docker compose restart
```

A "Drums" button will appear in the player controls when you play a song. Click the gear icon next to it to configure MIDI input and sound settings.

## How It Works

The plugin reads note data from the highway renderer and maps them to drum lanes. Notes use the MIDI encoding convention `midi = string * 24 + fret`, which the [editor plugin](https://github.com/got-feedback/feedback-plugin-editor) uses when importing drum tracks from Guitar Pro files.

### MIDI Drum Pad

Connect a USB MIDI drum pad or electronic kit and select it from the settings panel. Play along and get real-time visual feedback:

- **Lane flash** — the lane lights up when you hit the correct drum piece
- **Green notes** — correctly hit notes within the timing window
- **Red flash** — wrong drum piece or no matching note
- **Gray notes** — missed notes that passed the now line

### Custom Mapping

Different drum pads send different MIDI note numbers. Use the "Learn" mode in settings to remap:

1. Open settings and expand "MIDI Mapping"
2. Click "Learn" next to a lane (e.g., Snare)
3. Hit the pad you want to assign to that lane
4. The MIDI note is saved to that lane

Click "Reset Map" to return to standard GM mapping.

## Development

Tests run with plain Node (the org CI runs each `tests/*.test.js`): `node tests/engine.test.js`,
`node tests/session.test.js`, `node tests/screen.test.js`.

## License

MIT, except `assets/engine.js` and `tests/engine.test.js`: they are ports of
[YARG.Core](https://github.com/YARC-Official/YARG.Core) and are licensed under the **LGPL-3.0**
(`LICENSE.LGPL-3.0`, with the GPL-3.0 it builds on in `LICENSE.GPL-3.0`; LGPL-3.0 section 2(b) also allows
conveying a modified copy under the GPL-3.0). The engine is a separate,
replaceable file that the MIT code only calls through its public API. Details in [NOTICE.md](NOTICE.md).
