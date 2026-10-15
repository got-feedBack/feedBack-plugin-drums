# Licensing notice for the drums plugin

Most of this plugin is original code under the **MIT** license (see `README.md`). That includes
`screen.js`, `assets/session.js`, `plugin.json`, the other assets and the tests other than
`tests/engine.test.js`.

Two files are ports of [YARG.Core](https://github.com/YARC-Official/YARG.Core) and are licensed under the
**GNU Lesser General Public License v3.0** (full text in [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0); the LGPL
builds on the GNU GPL v3.0, whose text is in [`LICENSE.GPL-3.0`](LICENSE.GPL-3.0)):

| File | Status |
|------|--------|
| `assets/engine.js` | LGPL-3.0. JavaScript port, with modifications, of YARG.Core's drums engine (`Engine/Drums/DrumsEngine.cs`, `Engine/Drums/Engines/YargDrumsEngine.cs`, `DrumsEngineParameters.cs`, `DrumsStats.cs`, `Engine/BaseEngine*.cs`, `BaseStats.cs`, `HitWindowSettings.cs`, `Chart/Notes/DrumNote.cs`, `Note.cs`, drum activation flags from `InstrumentDifficultyExtensions.cs`, and defaults from `Game/Presets/EnginePreset*.cs`). It also takes the drum star thresholds from YARG's `DrumsPlayer.cs` (LGPL-3.0). Copyright (c) YARC (YARG) contributors. |
| `tests/engine.test.js` | LGPL-3.0. Tests for `engine.js`, partly ported from `YARG.Core.UnitTests/Engine/DrumEngineTester.cs` and `DrumsStatsTests.cs`. |

`assets/engine.js` is a standalone, unminified script with no dependencies, shipped as its own file and
loaded at runtime. `screen.js` and `assets/session.js` only use it through its public API
(`window.DrumsEngine` / `require('./engine.js')`), so they remain separate MIT works that use the Library
as described in LGPL-3.0 section 4 ("Combined Works"). You may replace `assets/engine.js` with a modified
version. A modified `assets/engine.js` that you distribute is conveyed under LGPL-3.0 or, as LGPL-3.0
section 2(b) allows, under the GPL-3.0 (without the LGPL's additional permissions), with its source
available either way. Combining an LGPL-3.0 file with MIT code this way is permitted by both licenses, and
both are compatible with feedBack's AGPL-3.0.

The header of `assets/engine.js` lists every behaviour that deviates from YARG ("Deviations from YARG").
The scoring look and feel imitates rhythm-game drum tracks but uses no artwork, fonts or logos from them.
