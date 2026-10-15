/*
 * highway3d.js: Rock Band-style 3D drum highway for the feedBack drums plugin (MIT, original code).
 *
 * A perspective drum track in the style of the classic plastic-instrument drum games: four coloured
 * pad lanes (red, yellow, blue, green) plus a full-width kick bar, a strikeline with pad targets,
 * rounded-rectangle gems for pads/toms, raised domed gems for cymbals, star power and drum-fill
 * highlighting, hit sparks and a 2D HUD (score, multiplier, streak, star power meter, stars,
 * accuracy). It contains no ported game logic and no artwork from those games; scoring comes from
 * session.js / engine.js through their public APIs.
 *
 * Exported on window.DrumsHighway3D (browser) and module.exports (Node tests):
 *  - keyboard helpers (keyToPad, synthMidiForPad) used by screen.js in both views;
 *  - createView(THREE, canvas, opts): the Three.js scene that renders a session (session.js
 *    createSession) into the given webgl2 canvas plus a 2D HUD canvas. THREE is passed in
 *    (screen.js imports core's vendored three.module.min.js).
 * Needs session.js loaded first (window.DrumsSession, or require('./session.js') in Node).
 */
(function (root, factory) {
    'use strict';
    const S = (typeof module === 'object' && module && module.exports)
        ? require('./session.js')
        : (typeof window !== 'undefined' ? window.DrumsSession : root && root.DrumsSession);
    const api = factory(S);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.DrumsHighway3D = api;
    else if (root) root.DrumsHighway3D = api;
})(typeof self !== 'undefined' ? self : this, function (S) {
    'use strict';
    if (!S) throw new Error('highway3d.js needs session.js (window.DrumsSession)');
    const { PAD, LANE_NAMES, LANE_COLORS, COLORS, visibleRange, difficultyBadge, formatScore, hudModel, multiplierColor, timingSummary } = S;

    // Track geometry (world units). The strikeline is at z = 0 and notes approach from -z.
    const TRACK = Object.freeze({
        laneWidth: 1.0,
        lanes: 4,
        length: 30,             // strikeline -> far end
        behind: 2.0,            // visible track behind the strikeline (toward the camera)
        defaultLookahead: 1.9,  // seconds of chart visible on the track
        gemScale: 1.12,         // gem size relative to the 1-unit lane
    });

    // Representative GM notes for the synth when a hit has no MIDI note (keyboard input).
    const PAD_SYNTH_MIDI = Object.freeze({
        kick: 36, red: 38, yellowTom: 48, yellowCymbal: 42, blueTom: 45, blueCymbal: 51, greenTom: 41, greenCymbal: 49,
    });

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function defaultNow() {
        return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
            ? performance.now() : Date.now();
    }

    // ── Keyboard fallback ───────────────────────────────────────────────────

    const _KEY_CODES = {
        KeyB: { pad: PAD.KICK, cymbal: false },
        KeyF: { pad: PAD.RED, cymbal: false },
        KeyJ: { pad: PAD.YELLOW, cymbal: false },
        KeyK: { pad: PAD.BLUE, cymbal: false },
        KeyL: { pad: PAD.GREEN, cymbal: false },
        KeyU: { pad: PAD.YELLOW, cymbal: true },
        KeyI: { pad: PAD.BLUE, cymbal: true },
        KeyO: { pad: PAD.GREEN, cymbal: true },
    };
    const _KEY_CHARS = { b: 'KeyB', f: 'KeyF', j: 'KeyJ', k: 'KeyK', l: 'KeyL', u: 'KeyU', i: 'KeyI', o: 'KeyO' };

    /**
     * Keyboard fallback: B = kick (Space stays play/pause), F = red, J/K/L = yellow/blue/green pads (Shift+J/K/L or
     * U/I/O = the cymbal of that colour), Enter = activate star power. Matches the physical key
     * (e.code) first so it works on any layout. Returns {pad, cymbal}, {action:'activate'} or null.
     */
    function keyToPad(e) {
        if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
        const key = typeof e.key === 'string' ? e.key : '';
        const code = typeof e.code === 'string' ? e.code : '';
        if (code === 'Enter' || code === 'NumpadEnter' || key === 'Enter') return { action: 'activate' };
        let m = _KEY_CODES[code];
        if (!m) { const c = _KEY_CHARS[key.toLowerCase()]; if (c) m = _KEY_CODES[c]; }
        if (!m) return null;
        const cymbal = m.cymbal || (!!e.shiftKey && m.pad >= PAD.YELLOW);
        return { pad: m.pad, cymbal };
    }

    /** GM note for the synth when the hit came from the keyboard. */
    function synthMidiForPad(pad, cymbal) {
        switch (pad) {
            case PAD.KICK: return PAD_SYNTH_MIDI.kick;
            case PAD.RED: return PAD_SYNTH_MIDI.red;
            case PAD.YELLOW: return cymbal ? PAD_SYNTH_MIDI.yellowCymbal : PAD_SYNTH_MIDI.yellowTom;
            case PAD.BLUE: return cymbal ? PAD_SYNTH_MIDI.blueCymbal : PAD_SYNTH_MIDI.blueTom;
            case PAD.GREEN: return cymbal ? PAD_SYNTH_MIDI.greenCymbal : PAD_SYNTH_MIDI.greenTom;
            default: return null;
        }
    }

    // ── View: Three.js scene + HUD ──────────────────────────────────────────

    function _cssHex(hex) { return '#' + (hex >>> 0).toString(16).padStart(6, '0'); }

    function _radialTexture(T, size, stops) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        for (const [o, col] of stops) grad.addColorStop(o, col);
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        return tex;
    }

    function _trackTexture(T) {
        const w = 512, h = 64;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = _cssHex(COLORS.track);
        g.fillRect(0, 0, w, h);
        const lw = w / 4;
        for (let i = 0; i < 4; i++) {
            const col = LANE_COLORS[LANE_NAMES[i]];
            const r = (col >> 16) & 255, gg = (col >> 8) & 255, b = col & 255;
            const grad = g.createLinearGradient(i * lw, 0, (i + 1) * lw, 0);
            grad.addColorStop(0, `rgba(${r},${gg},${b},0.02)`);
            grad.addColorStop(0.5, `rgba(${r},${gg},${b},0.075)`);
            grad.addColorStop(1, `rgba(${r},${gg},${b},0.02)`);
            g.fillStyle = grad;
            g.fillRect(i * lw, 0, lw, h);
        }
        // faint scanline texture so the track reads as moving
        g.fillStyle = 'rgba(255,255,255,0.025)';
        for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 2);
        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        tex.wrapS = T.ClampToEdgeWrapping;
        tex.wrapT = T.RepeatWrapping;
        tex.anisotropy = 4;
        return tex;
    }

    // A rounded-rectangle Shape (w x h, corner radius r) centred on the origin; with hw/hh/hr it gets a
    // centred rounded-rectangle hole, which makes a frame.
    function _roundedRect(T, w, h, r, hw, hh, hr) {
        const path = (P, w, h, r) => {
            const x = -w / 2, y = -h / 2;
            r = Math.min(r, w / 2, h / 2);
            P.moveTo(x + r, y);
            P.lineTo(x + w - r, y);
            P.quadraticCurveTo(x + w, y, x + w, y + r);
            P.lineTo(x + w, y + h - r);
            P.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            P.lineTo(x + r, y + h);
            P.quadraticCurveTo(x, y + h, x, y + h - r);
            P.lineTo(x, y + r);
            P.quadraticCurveTo(x, y, x + r, y);
            return P;
        };
        const s = path(new T.Shape(), w, h, r);
        if (hw > 0 && hh > 0) s.holes.push(path(new T.Path(), hw, hh, hr));
        return s;
    }

    // Pixel-store state survives on a context shared by successive renderers (same <canvas>); three.js
    // assumes the defaults when it creates a renderer.
    function _resetPixelStore(gl) {
        try {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        } catch (_) { /* context lost */ }
    }

    function _seededRandom(seed) {
        let x = seed >>> 0 || 1;
        return function () {
            x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
            return x / 4294967296;
        };
    }

    /**
     * createView(THREE, canvas, {hudCanvas, context}) -> view.
     *   view.resize(cssW, cssH, pixelRatio)
     *   view.render({time, session, wallNow, lookahead, loading, message, hint, difficulty})
     *     difficulty: difficultyBadge() output, drawn as a pill in the HUD; view.difficultyRect is
     *     its css-px rect after the frame (screen.js overlays a clickable button there)
     *   view.dispose()
     */
    function createView(T, canvas, opts) {
        opts = opts || {};
        const gl = opts.context || canvas.getContext('webgl2', { antialias: true, alpha: false });
        if (!gl) throw new Error('WebGL2 is not available');
        const renderer = new T.WebGLRenderer({ canvas, context: gl, antialias: true });
        renderer.setClearColor(COLORS.background, 1);
        _resetPixelStore(gl);   // a previous renderer on this context may have left FLIP_Y set
        const hud = opts.hudCanvas || null;
        const hctx = hud ? hud.getContext('2d') : null;

        const disposables = [];
        const own = (x) => { disposables.push(x); return x; };

        const scene = new T.Scene();
        scene.background = new T.Color(COLORS.background);
        scene.fog = new T.Fog(COLORS.background, TRACK.length * 0.7, TRACK.length * 1.05);
        const camera = new T.PerspectiveCamera(52, 16 / 9, 0.1, 120);
        const CAM_POS = new T.Vector3(0, 4.4, 5.6);
        const CAM_LOOK = new T.Vector3(0, 0, -6);
        camera.position.copy(CAM_POS);
        camera.lookAt(CAM_LOOK);

        scene.add(new T.AmbientLight(0xffffff, 1.1));
        const key = new T.DirectionalLight(0xffffff, 2.4);
        key.position.set(1.5, 6, 5);
        scene.add(key);
        const rim = new T.DirectionalLight(0x9fc4ff, 0.9);
        rim.position.set(-3, 2, -6);
        scene.add(rim);

        const W4 = TRACK.laneWidth * TRACK.lanes;
        const laneX = (i) => (i - (TRACK.lanes - 1) / 2) * TRACK.laneWidth;
        const zSpan = TRACK.length + TRACK.behind;
        const zMid = (TRACK.behind - TRACK.length) / 2;

        // Textures
        const glowTex = own(_radialTexture(T, 128, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]));
        const softTex = own(_radialTexture(T, 64, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]));
        const ringTex = own(_radialTexture(T, 128, [[0, 'rgba(255,255,255,0)'], [0.62, 'rgba(255,255,255,0)'], [0.78, 'rgba(255,255,255,1)'], [0.9, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]));
        const trackTex = own(_trackTexture(T));
        trackTex.repeat.set(1, zSpan / 2);

        // ── Track ──
        const trackMat = own(new T.MeshBasicMaterial({ map: trackTex }));
        const trackGeo = own(new T.PlaneGeometry(W4 + 0.2, zSpan));
        const track = new T.Mesh(trackGeo, trackMat);
        track.rotation.x = -Math.PI / 2;
        track.position.set(0, -0.002, zMid);
        scene.add(track);

        // Star power wash over the whole track.
        const spWashMat = own(new T.MeshBasicMaterial({ color: COLORS.starPowerEdge, transparent: true, opacity: 0,
            blending: T.AdditiveBlending, depthWrite: false }));
        const spWash = new T.Mesh(trackGeo, spWashMat);
        spWash.rotation.x = -Math.PI / 2;
        spWash.position.set(0, 0.001, zMid);
        scene.add(spWash);
        // Drum solo: a violet wash over the track (star power keeps its blue).
        const soloWashMat = own(new T.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0,
            blending: T.AdditiveBlending, depthWrite: false }));
        const soloWash = new T.Mesh(trackGeo, soloWashMat);
        soloWash.rotation.x = -Math.PI / 2;
        soloWash.position.set(0, 0.0015, zMid);
        scene.add(soloWash);
        let soloIn = 0;

        // Lane dividers + side rails.
        const dividerMat = own(new T.MeshBasicMaterial({ color: 0x2a3456 }));
        const dividerGeo = own(new T.BoxGeometry(0.025, 0.01, zSpan));
        for (let i = 1; i < TRACK.lanes; i++) {
            const d = new T.Mesh(dividerGeo, dividerMat);
            d.position.set(laneX(i) - TRACK.laneWidth / 2, 0.004, zMid);
            scene.add(d);
        }
        const railMat = own(new T.MeshBasicMaterial({ color: COLORS.rail }));
        const railGeo = own(new T.BoxGeometry(0.09, 0.07, zSpan));
        const rails = [];
        for (const sx of [-1, 1]) {
            const r = new T.Mesh(railGeo, railMat);
            r.position.set(sx * (W4 / 2 + 0.11), 0.035, zMid);
            scene.add(r);
            rails.push(r);
        }
        const railGlowMat = own(new T.MeshBasicMaterial({ map: softTex, color: COLORS.starPowerEdge, transparent: true,
            opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
        const railGlowGeo = own(new T.PlaneGeometry(0.9, zSpan));
        for (const sx of [-1, 1]) {
            const g = new T.Mesh(railGlowGeo, railGlowMat);
            g.rotation.x = -Math.PI / 2;
            g.position.set(sx * (W4 / 2 + 0.11), 0.01, zMid);
            scene.add(g);
        }

        // ── Strikeline ──
        const kickLineMat = own(new T.MeshBasicMaterial({ color: COLORS.kick }));
        const kickLine = new T.Mesh(own(new T.BoxGeometry(W4 + 0.18, 0.03, 0.13)), kickLineMat);
        kickLine.position.set(0, 0.012, 0);
        scene.add(kickLine);
        const kickGlowMat = own(new T.MeshBasicMaterial({ map: softTex, color: COLORS.kick, transparent: true, opacity: 0.25,
            blending: T.AdditiveBlending, depthWrite: false }));
        const kickGlow = new T.Mesh(own(new T.PlaneGeometry(W4 + 1.2, 0.9)), kickGlowMat);
        kickGlow.rotation.x = -Math.PI / 2;
        kickGlow.position.set(0, 0.02, 0);
        scene.add(kickGlow);

        // Pad targets: a rounded-rectangle frame in the lane colour over a translucent pad face.
        const targetRingGeo = own(new T.ExtrudeGeometry(_roundedRect(T, 0.9, 0.4, 0.08, 0.76, 0.27, 0.05),
            { depth: 0.035, bevelEnabled: false, curveSegments: 6 }));
        const targetDiscGeo = own(new T.ShapeGeometry(_roundedRect(T, 0.8, 0.31, 0.06), 6));
        const targets = [];
        for (let i = 0; i < TRACK.lanes; i++) {
            const col = LANE_COLORS[LANE_NAMES[i]];
            const ringMat = own(new T.MeshBasicMaterial({ color: col }));
            const ring = new T.Mesh(targetRingGeo, ringMat);
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(laneX(i), 0.01, 0);
            scene.add(ring);
            const discMat = own(new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.92, depthWrite: false }));
            const disc = new T.Mesh(targetDiscGeo, discMat);
            disc.rotation.x = -Math.PI / 2;
            disc.position.set(laneX(i), 0.035, 0);
            scene.add(disc);
            targets.push({ ring, ringMat, disc, discMat, color: new T.Color(col), press: -1e9 });
        }
        const kickTarget = { press: -1e9 };

        // Lane tint overlays (press = lane colour, miss/overhit = red) near the strikeline.
        const tintGeo = own(new T.PlaneGeometry(TRACK.laneWidth * 0.98, 4.2));
        const laneTints = [];
        for (let i = 0; i < TRACK.lanes; i++) {
            const m = own(new T.MeshBasicMaterial({ color: COLORS.miss, transparent: true, opacity: 0,
                blending: T.AdditiveBlending, depthWrite: false }));
            const mesh = new T.Mesh(tintGeo, m);
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.set(laneX(i), 0.006, -1.6);
            scene.add(mesh);
            laneTints.push({ mesh, mat: m, red: -1e9, press: -1e9, color: new T.Color(LANE_COLORS[LANE_NAMES[i]]) });
        }
        const kickTintMat = own(new T.MeshBasicMaterial({ color: COLORS.miss, transparent: true, opacity: 0,
            blending: T.AdditiveBlending, depthWrite: false }));
        const kickTint = new T.Mesh(own(new T.PlaneGeometry(W4, 1.0)), kickTintMat);
        kickTint.rotation.x = -Math.PI / 2;
        kickTint.position.set(0, 0.007, -0.1);
        scene.add(kickTint);
        const kickTintState = { red: -1e9 };

        // ── Beat / measure lines ──
        const MAX_BEATS = 96;
        const beatMat = own(new T.MeshBasicMaterial({ color: COLORS.beat, transparent: true, opacity: 0.45, depthWrite: false }));
        const measureMat = own(new T.MeshBasicMaterial({ color: COLORS.measure, transparent: true, opacity: 0.85, depthWrite: false }));
        const beatLines = new T.InstancedMesh(own(new T.BoxGeometry(W4, 0.004, 0.05)), beatMat, MAX_BEATS);
        const measureLines = new T.InstancedMesh(own(new T.BoxGeometry(W4 + 0.18, 0.006, 0.075)), measureMat, MAX_BEATS);
        beatLines.frustumCulled = measureLines.frustumCulled = false;
        scene.add(beatLines, measureLines);

        // ── Fill (activation) highlight ──
        const MAX_FILLS = 4;
        const fillMat = own(new T.MeshBasicMaterial({ color: COLORS.fill, transparent: true, opacity: 0.16,
            blending: T.AdditiveBlending, depthWrite: false }));
        const fillEdgeMat = own(new T.MeshBasicMaterial({ color: COLORS.fill, transparent: true, opacity: 0.85,
            blending: T.AdditiveBlending, depthWrite: false }));
        const fillGeo = own(new T.PlaneGeometry(W4, 1));
        const fillEdgeGeo = own(new T.BoxGeometry(0.06, 0.02, 1));
        const fills = [];
        for (let i = 0; i < MAX_FILLS; i++) {
            const m = new T.Mesh(fillGeo, fillMat);
            m.rotation.x = -Math.PI / 2;
            m.visible = false;
            scene.add(m);
            const e1 = new T.Mesh(fillEdgeGeo, fillEdgeMat);
            const e2 = new T.Mesh(fillEdgeGeo, fillEdgeMat);
            e1.visible = e2.visible = false;
            scene.add(e1, e2);
            fills.push({ m, e1, e2 });
        }

        // ── Gems ──
        const MAX_GEMS = 384;
        const solidMat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.18,
            emissive: 0xffffff, emissiveIntensity: 0.0 }));
        const ghostMat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1,
            transparent: true, opacity: 0.42, depthWrite: false }));
        const capMat = own(new T.MeshBasicMaterial({ color: 0xffffff }));
        const glowMat = own(new T.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.85,
            blending: T.AdditiveBlending, depthWrite: false }));

        // Pad / tom: a wide rounded-rectangle block with a bevelled edge, a lighter inset top face and a
        // dark frame line between the two.
        const PAD_W = 0.76, PAD_D = 0.31, PAD_BEVEL = 0.03, PAD_H = 0.075 + 2 * PAD_BEVEL;
        const padGeo = own(new T.ExtrudeGeometry(_roundedRect(T, PAD_W - 2 * PAD_BEVEL, PAD_D - 2 * PAD_BEVEL, 0.05), {
            depth: PAD_H - 2 * PAD_BEVEL, bevelEnabled: true, bevelThickness: PAD_BEVEL, bevelSize: PAD_BEVEL,
            bevelSegments: 3, curveSegments: 6 }));
        padGeo.rotateX(-Math.PI / 2);
        padGeo.translate(0, PAD_BEVEL, 0);
        const padCapGeo = own(new T.ShapeGeometry(_roundedRect(T, PAD_W - 0.15, PAD_D - 0.12, 0.04), 6));
        padCapGeo.rotateX(-Math.PI / 2);
        padCapGeo.translate(0, PAD_H + 0.002, 0);
        const padRimGeo = own(new T.ShapeGeometry(_roundedRect(T, PAD_W - 0.1, PAD_D - 0.07, 0.055, PAD_W - 0.15, PAD_D - 0.12, 0.04), 6));
        padRimGeo.rotateX(-Math.PI / 2);
        padRimGeo.translate(0, PAD_H + 0.001, 0);
        // Cymbal: a raised conical dome with a bell on a thick ring, floating over a shadow on the track.
        const CYM_Y = 0.24;
        const domeGeo = own(new T.SphereGeometry(0.36, 36, 12, 0, Math.PI * 2, 0, Math.PI / 2));
        domeGeo.scale(1, 0.42, 1);
        domeGeo.translate(0, CYM_Y, 0);
        const bellGeo = own(new T.SphereGeometry(0.1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2));
        bellGeo.translate(0, CYM_Y + 0.135, 0);
        const cymRingGeo = own(new T.TorusGeometry(0.385, 0.05, 10, 44));
        cymRingGeo.rotateX(-Math.PI / 2);
        cymRingGeo.translate(0, CYM_Y, 0);
        const shadowGeo = own(new T.CircleGeometry(0.4, 32));
        shadowGeo.rotateX(-Math.PI / 2);
        shadowGeo.translate(0, 0.006, 0);
        const shadowMat = own(new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
        // Kick: a wide bar across the track; 2x kick adds a white centre stripe.
        const kickGeo = own(new T.BoxGeometry(W4 - 0.06, 0.045, 0.13));
        kickGeo.translate(0, 0.0225, 0);
        const stripeGeo = own(new T.BoxGeometry(W4 * 0.55, 0.05, 0.04));
        stripeGeo.translate(0, 0.025, 0);
        const glowGeo = own(new T.PlaneGeometry(1, 1));
        glowGeo.rotateX(-Math.PI / 2);
        glowGeo.translate(0, 0.01, 0);
        // Activator marker: a tall ring standing over the gem.
        const activatorGeo = own(new T.TorusGeometry(0.47, 0.035, 10, 48));
        const activatorMat = own(new T.MeshBasicMaterial({ color: COLORS.activator, transparent: true, opacity: 0.95,
            blending: T.AdditiveBlending, depthWrite: false }));

        function inst(geo, mat, n) {
            const m = new T.InstancedMesh(geo, mat, n);
            m.instanceMatrix.setUsage(T.DynamicDrawUsage);
            m.frustumCulled = false;
            m.count = 0;
            scene.add(m);
            return m;
        }
        const meshes = {
            pad: inst(padGeo, solidMat, MAX_GEMS),
            padGhost: inst(padGeo, ghostMat, MAX_GEMS),
            padCap: inst(padCapGeo, capMat, MAX_GEMS),
            padRim: inst(padRimGeo, capMat, MAX_GEMS),
            shadow: inst(shadowGeo, shadowMat, MAX_GEMS),
            dome: inst(domeGeo, solidMat, MAX_GEMS),
            domeGhost: inst(domeGeo, ghostMat, MAX_GEMS),
            bell: inst(bellGeo, capMat, MAX_GEMS),
            cymRing: inst(cymRingGeo, solidMat, MAX_GEMS),
            cymRingGhost: inst(cymRingGeo, ghostMat, MAX_GEMS),
            kick: inst(kickGeo, solidMat, 128),
            stripe: inst(stripeGeo, capMat, 128),
            glow: inst(glowGeo, glowMat, MAX_GEMS),
            activator: inst(activatorGeo, activatorMat, 16),
        };
        // Ensure instanceColor buffers exist.
        const _c = new T.Color(1, 1, 1);
        for (const k of Object.keys(meshes)) {
            const m = meshes[k];
            for (let i = 0; i < m.instanceMatrix.count; i++) m.setColorAt(i, _c);
            m.instanceColor.setUsage(T.DynamicDrawUsage);
        }

        // ── Hit flashes + sparks ──
        const MAX_FLASH = 24;
        const flashGeo = own(new T.PlaneGeometry(1, 1));
        flashGeo.rotateX(-Math.PI / 2);
        const flashes = [];
        for (let i = 0; i < MAX_FLASH; i++) {
            const ringMat = own(new T.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0,
                blending: T.AdditiveBlending, depthWrite: false }));
            const glowM = own(new T.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0,
                blending: T.AdditiveBlending, depthWrite: false }));
            const ring = new T.Mesh(flashGeo, ringMat);
            const flare = new T.Mesh(flashGeo, glowM);
            ring.visible = flare.visible = false;
            scene.add(ring, flare);
            flashes.push({ ring, ringMat, flare, glowM, born: -1e9, kick: false, x: 0 });
        }
        let flashNext = 0;

        const MAX_SPARKS = 480;
        const sparkPos = new Float32Array(MAX_SPARKS * 3);
        const sparkCol = new Float32Array(MAX_SPARKS * 3);
        const sparkVel = new Float32Array(MAX_SPARKS * 3);
        const sparkOrigin = new Float32Array(MAX_SPARKS * 3);
        const sparkBase = new Float32Array(MAX_SPARKS * 3);
        const sparkBorn = new Float64Array(MAX_SPARKS).fill(-1e9);
        const sparkLife = new Float32Array(MAX_SPARKS);
        const sparkGeo = own(new T.BufferGeometry());
        sparkGeo.setAttribute('position', new T.BufferAttribute(sparkPos, 3).setUsage(T.DynamicDrawUsage));
        sparkGeo.setAttribute('color', new T.BufferAttribute(sparkCol, 3).setUsage(T.DynamicDrawUsage));
        const sparkMat = own(new T.PointsMaterial({ size: 0.11, map: softTex, vertexColors: true, transparent: true,
            blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
        const sparks = new T.Points(sparkGeo, sparkMat);
        sparks.frustumCulled = false;
        scene.add(sparks);
        let sparkNext = 0;
        const rand = _seededRandom(0x5eed);

        // ── State ──
        const dummy = new T.Object3D();
        const tmpColor = new T.Color();
        const gemColor = new T.Color();
        const tmp2 = new T.Color();
        const white = new T.Color(1, 1, 1);
        const missedColor = new T.Color(COLORS.missedGem);
        const spColor = new T.Color(COLORS.starPowerGem);
        let wallLast = 0;
        let spActiveSince = -1e9;
        let spEndedAt = -1e9;
        let toast = null; // {text, color, born}
        let cssW = 1, cssH = 1, dpr = 1;
        let diffRect = null;    // css-px rect of the HUD difficulty badge (last frame), or null
        let timingRect = null, timingSuggest = null;   // the timing meter's Apply pill + its input offset

        function laneOf(pad) { return pad >= 1 && pad <= 4 ? pad - 1 : -1; }
        function padColor(pad, cymbal) {
            if (pad === PAD.KICK) return COLORS.kick;
            return LANE_COLORS[LANE_NAMES[pad - 1]];
        }

        function spawnFlash(pad, colorHex, wall, strong) {
            const f = flashes[flashNext];
            flashNext = (flashNext + 1) % MAX_FLASH;
            f.born = wall;
            f.kick = pad === PAD.KICK;
            f.x = f.kick ? 0 : laneX(pad - 1);
            f.strong = !!strong;
            f.ringMat.color.setHex(colorHex);
            f.glowM.color.setHex(colorHex);
            const n = f.kick ? 34 : 18;
            const c = tmpColor.setHex(colorHex);
            for (let k = 0; k < n; k++) {
                const i = sparkNext;
                sparkNext = (sparkNext + 1) % MAX_SPARKS;
                const x0 = f.kick ? (rand() - 0.5) * W4 : f.x + (rand() - 0.5) * 0.3;
                sparkOrigin[i * 3] = x0;
                sparkOrigin[i * 3 + 1] = 0.12;
                sparkOrigin[i * 3 + 2] = (rand() - 0.5) * 0.15;
                const a = rand() * Math.PI * 2;
                const sp = (f.kick ? 1.2 : 1.6) + rand() * 2.2;
                sparkVel[i * 3] = Math.cos(a) * sp * 0.55;
                sparkVel[i * 3 + 1] = 2.2 + rand() * 3.2;
                sparkVel[i * 3 + 2] = Math.sin(a) * sp * 0.45 + 0.6;
                const mix = rand() * 0.6;
                sparkBase[i * 3] = c.r + (1 - c.r) * mix;
                sparkBase[i * 3 + 1] = c.g + (1 - c.g) * mix;
                sparkBase[i * 3 + 2] = c.b + (1 - c.b) * mix;
                sparkBorn[i] = wall;
                sparkLife[i] = 0.35 + rand() * 0.35;
            }
        }

        function handleEvents(events, wall) {
            for (const ev of events) {
                const w = Number.isFinite(ev.wall) ? ev.wall : wall;
                const lane = laneOf(ev.pad);
                switch (ev.type) {
                    case 'press':
                        if (lane >= 0) { targets[lane].press = w; laneTints[lane].press = w; }
                        else kickTarget.press = w;
                        break;
                    case 'hit': {
                        const col = ev.sp ? COLORS.starPowerGem : padColor(ev.pad, ev.cymbal);
                        spawnFlash(ev.pad, col, w, ev.bonus);
                        break;
                    }
                    case 'miss':
                    case 'overhit':
                        if (lane >= 0) laneTints[lane].red = w;
                        else kickTintState.red = w;
                        break;
                    case 'sp-activate':
                        spActiveSince = w;
                        toast = { text: 'STAR POWER!', color: '#8fe6ff', born: w };
                        break;
                    case 'sp-end':
                        spEndedAt = w;
                        break;
                    case 'sp-phrase':
                        toast = { text: 'PHRASE COMPLETE', color: '#dff3ff', born: w };
                        break;
                    case 'sp-ready':
                        toast = { text: 'STAR POWER READY', color: '#8fe6ff', born: w };
                        break;
                    case 'solo-end':
                        toast = { text: ev.text, sub: ev.sub, color: ev.perfect ? '#ffc531' : '#c9b6ff', born: w, long: true };
                        break;
                    case 'bonus-pop':
                        toast = { text: ev.text, color: ev.color || '#ff9a40', born: w };
                        break;
                    default:
                        break;
                }
            }
        }

        function place(mesh, idx, x, y, z, sx, sy, sz, color) {
            dummy.position.set(x, y, z);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(sx, sy, sz);
            dummy.updateMatrix();
            mesh.setMatrixAt(idx, dummy.matrix);
            mesh.setColorAt(idx, color);
        }

        function project(x, y, z) {
            const v = new T.Vector3(x, y, z).project(camera);
            return { x: (v.x + 1) / 2 * cssW, y: (1 - v.y) / 2 * cssH };
        }

        function layoutCamera() {
            const aspect = cssW / Math.max(1, cssH);
            camera.aspect = aspect;
            // Keep the strikeline (plus HUD gutter) in view on narrow panels.
            const dist = CAM_POS.distanceTo(new T.Vector3(0, 0, 0));
            const needHalfW = aspect < 1.2 ? (W4 / 2 + 0.6) : (W4 / 2 + 2.2);
            const fovNeeded = 2 * Math.atan(needHalfW / (dist * aspect)) * 180 / Math.PI;
            camera.fov = clamp(Math.max(52, fovNeeded), 52, 95);
            camera.updateProjectionMatrix();
        }

        // ── HUD drawing ──
        const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

        function drawStar(ctx, cx, cy, r, fill, stroke) {
            ctx.beginPath();
            for (let i = 0; i < 10; i++) {
                const a = -Math.PI / 2 + i * Math.PI / 5;
                const rr = i % 2 === 0 ? r : r * 0.45;
                const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            if (fill) { ctx.fillStyle = fill; ctx.fill(); }
            if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
        }

        function _pill(ctx, x, y, w, h) {
            const r = Math.min(h / 2, w / 2);
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
            ctx.lineTo(x + r, y + h);
            ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
            ctx.closePath();
        }

        function drawHud(frame, state, wall) {
            if (!hctx) return;
            const ctx = hctx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, hud.width, hud.height);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const Wc = cssW, Hc = cssH;
            const m = hudModel(state);
            const bonus = frame.session && frame.session.getBonus ? frame.session.getBonus() : null;
            if (bonus && state) m.score = formatScore((state.score || 0) + bonus.total);
            const left = project(-W4 / 2 - 0.15, 0, 0);
            const right = project(W4 / 2 + 0.15, 0, 0);
            const strikeY = clamp(left.y, Hc * 0.4, Hc - 20);
            // Rock Band layout: score column right of the track, multiplier + streak left of it.
            const narrow = Wc - right.x < 190 || left.x < 150;
            const scale = clamp(Math.min(Wc, Hc * 1.6) / 1100, 0.6, 1.25);

            // Score column: star power meter, score, stars, accuracy.
            const lx = narrow ? 16 : right.x + 28 * scale;
            const align = 'left';
            const ly = narrow ? 24 * scale : strikeY - 150 * scale;
            ctx.textAlign = align;
            ctx.textBaseline = 'alphabetic';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 6;

            // star power meter
            const meterW = 190 * scale, meterH = 14 * scale;
            const mx = align === 'right' ? lx - meterW : lx;
            const my = ly;
            ctx.font = `700 ${11 * scale}px ${FONT}`;
            ctx.fillStyle = m.spActive ? '#8fe6ff' : (m.spReady ? '#bff0ff' : '#8a93b0');
            const label = m.spActive ? 'STAR POWER ACTIVE' : (m.spReady ? 'STAR POWER READY' : 'STAR POWER');
            ctx.fillText(label, align === 'right' ? lx : lx, my - 6 * scale);
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(10,14,30,0.85)';
            ctx.fillRect(mx, my, meterW, meterH);
            const pulse = m.spReady || m.spActive ? 0.75 + 0.25 * Math.sin(wall / 120) : 1;
            const fillW = meterW * m.spAmount;
            const grad = ctx.createLinearGradient(mx, 0, mx + meterW, 0);
            grad.addColorStop(0, `rgba(90,190,255,${pulse})`);
            grad.addColorStop(1, `rgba(225,245,255,${pulse})`);
            ctx.fillStyle = grad;
            ctx.fillRect(mx, my, fillW, meterH);
            ctx.strokeStyle = m.spReady || m.spActive ? '#bfefff' : '#3d4a70';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(mx + 0.5, my + 0.5, meterW - 1, meterH - 1);
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            for (let q = 1; q < 4; q++) {
                const x = mx + meterW * q / 4;
                ctx.beginPath(); ctx.moveTo(x, my + 1); ctx.lineTo(x, my + meterH - 1); ctx.stroke();
            }

            // score
            ctx.shadowColor = 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = 8;
            ctx.font = `italic 800 ${40 * scale}px ${FONT}`;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(m.score, lx, my + meterH + 46 * scale);
            // stars
            const sr = 11 * scale;
            const starY = my + meterH + 72 * scale;
            for (let i = 0; i < 5; i++) {
                const cx = align === 'right'
                    ? lx - sr - (4 - i) * (sr * 2.3)
                    : lx + sr + i * (sr * 2.3);
                const full = i < m.stars;
                const partial = i === m.stars ? m.starFrac : 0;
                drawStar(ctx, cx, starY, sr, 'rgba(40,44,64,0.9)', null);
                if (full) drawStar(ctx, cx, starY, sr, m.gold ? '#ffcf3a' : '#f4f6ff', null);
                else if (partial > 0) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(cx - sr, starY + sr - 2 * sr * partial, 2 * sr, 2 * sr * partial);
                    ctx.clip();
                    drawStar(ctx, cx, starY, sr, 'rgba(244,246,255,0.55)', null);
                    ctx.restore();
                }
                drawStar(ctx, cx, starY, sr, null, m.gold ? '#ffcf3a' : 'rgba(200,210,255,0.6)');
            }
            // accuracy
            ctx.font = `600 ${13 * scale}px ${FONT}`;
            ctx.fillStyle = '#c3cbe6';
            ctx.fillText('Accuracy ' + m.accuracy + '   ' + m.hitsText, lx, starY + 30 * scale);

            // difficulty badge (screen.js puts a clickable button over diffRect)
            diffRect = null;
            const d = frame.difficulty;
            if (d && d.text) {
                ctx.shadowBlur = 0;
                const fs = 12 * scale, subFs = 9 * scale, padX = 9 * scale, gap = 6 * scale;
                ctx.font = `italic 800 ${fs}px ${FONT}`;
                const tw = ctx.measureText(d.text).width;
                ctx.font = `800 ${subFs}px ${FONT}`;
                const sw = d.sub ? ctx.measureText(d.sub).width + gap : 0;
                const pw = tw + sw + padX * 2, ph = 21 * scale;
                const px = align === 'right' ? lx - pw : lx;
                const py = starY + 44 * scale;
                const col = d.color || '#c8ccd8';
                ctx.fillStyle = 'rgba(10,13,28,0.88)';
                _pill(ctx, px, py, pw, ph);
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = col;
                ctx.globalAlpha = d.fallback ? 0.55 : 1;
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.font = `italic 800 ${fs}px ${FONT}`;
                ctx.fillStyle = col;
                ctx.fillText(d.text, px + padX, py + ph / 2 + 0.5);
                if (d.sub) {
                    ctx.font = `800 ${subFs}px ${FONT}`;
                    ctx.fillStyle = '#9aa4c4';
                    ctx.fillText(d.sub, px + padX + tw + gap, py + ph / 2 + 0.5);
                }
                ctx.textBaseline = 'alphabetic';
                ctx.textAlign = align;
                diffRect = { x: px, y: py, w: pw, h: ph };
            }

            // Early/late meter (score column, under the difficulty badge): the last hits as
            // ticks on a ±100 ms bar (blue early, orange late), their median, and the input
            // offset that would centre them (Apply pill; screen.js puts a button over
            // timingRect). The numbers come from session.js timingSummary.
            timingRect = null; timingSuggest = null;
            if (frame.session && frame.session.getBonus) {
                const bl = frame.session.getBonus();
                const offs = bl && bl.offsets ? bl.offsets : [];
                const EARLY = '#66c7ff', LATE = '#ff9a40', OKC = '#e5e7eb', RANGE = 100;
                const ty = starY + (d && d.text ? 44 + 21 + 22 : 44 + 4) * scale;
                const bw = 190 * scale, bh = 10 * scale;
                const bx = align === 'right' ? lx - bw : lx;
                ctx.shadowBlur = 0;
                ctx.textAlign = 'left';
                ctx.font = `700 ${11 * scale}px ${FONT}`;
                if (!offs.length) {
                    ctx.fillStyle = '#7a84a6';
                    ctx.fillText('TIMING · waiting for hits', bx, ty);
                } else {
                    const cur = Number.isFinite(frame.inputOffsetMs) ? frame.inputOffsetMs : 0;
                    const sum = timingSummary(offs, cur);
                    const col = (ms) => (Math.abs(ms) < 10 ? OKC : ms < 0 ? EARLY : LATE);
                    ctx.fillStyle = '#7a84a6';
                    ctx.fillText('TIMING', bx, ty);
                    ctx.font = `800 ${13 * scale}px ${FONT}`;
                    ctx.fillStyle = col(sum.median);
                    ctx.fillText(sum.label, bx + 56 * scale, ty);
                    const by = ty + 6 * scale;
                    ctx.fillStyle = 'rgba(10,14,30,0.85)';
                    ctx.fillRect(bx, by, bw, bh);
                    ctx.fillStyle = 'rgba(160,170,200,0.5)';
                    ctx.fillRect(bx + bw / 2 - 0.5, by, 1, bh);
                    const px = (ms) => bx + bw / 2 + (bw / 2) * clamp(ms / RANGE, -1, 1);
                    offs.forEach((ms, i) => {
                        ctx.globalAlpha = 0.25 + 0.75 * (i + 1) / offs.length;
                        ctx.fillStyle = col(ms);
                        ctx.fillRect(px(ms) - 1, by + 1, 2, bh - 2);
                    });
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = col(sum.median);
                    ctx.fillRect(px(sum.median) - 1.5, by - 2 * scale, 3, bh + 4 * scale);
                    ctx.font = `600 ${10 * scale}px ${FONT}`;
                    ctx.fillStyle = EARLY; ctx.fillText('early', bx, by + bh + 11 * scale);
                    ctx.fillStyle = LATE; ctx.textAlign = 'right'; ctx.fillText('late', bx + bw, by + bh + 11 * scale);
                    ctx.textAlign = 'left';
                    const hy = by + bh + 27 * scale;
                    ctx.font = `600 ${11 * scale}px ${FONT}`;
                    if (sum.suggest != null) {
                        const txt = 'input offset ' + cur + ' → ' + sum.suggest + ' ms';
                        ctx.fillStyle = '#c3cbe6';
                        ctx.fillText(txt, bx, hy);
                        const tw = ctx.measureText(txt).width;
                        const pw = 46 * scale, ph = 17 * scale, ppx = bx + tw + 8 * scale, ppy = hy - 12.5 * scale;
                        ctx.fillStyle = 'rgba(30,40,70,0.95)';
                        _pill(ctx, ppx, ppy, pw, ph); ctx.fill();
                        ctx.strokeStyle = '#7f8cc0'; ctx.lineWidth = 1; ctx.stroke();
                        ctx.fillStyle = '#f1f5f9'; ctx.textAlign = 'center';
                        ctx.font = `700 ${10 * scale}px ${FONT}`;
                        ctx.fillText('Apply', ppx + pw / 2, ppy + ph / 2 + 3.5 * scale);
                        ctx.textAlign = 'left';
                        timingRect = { x: ppx, y: ppy, w: pw, h: ph };
                        timingSuggest = sum.suggest;
                    } else if (sum.count >= 6 && sum.state === 'ok') {
                        ctx.fillStyle = '#7a84a6';
                        ctx.fillText('input offset ' + cur + ' ms looks right', bx, hy);
                    }
                }
                ctx.textAlign = align;
            }

            // Multiplier badge + streak.
            const rx = narrow ? Wc - 16 - 40 * scale : left.x - 28 * scale - 40 * scale;
            const ry = narrow ? 104 * scale : strikeY - 70 * scale;
            const br = 34 * scale;
            ctx.shadowBlur = 14;
            ctx.shadowColor = m.multiplierColor;
            ctx.beginPath();
            ctx.arc(rx, ry, br, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(8,10,22,0.9)';
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.lineWidth = 4 * scale;
            ctx.strokeStyle = 'rgba(70,80,110,0.8)';
            ctx.beginPath(); ctx.arc(rx, ry, br - 3 * scale, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeStyle = m.multiplierColor;
            ctx.beginPath();
            ctx.arc(rx, ry, br - 3 * scale, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * m.multiplierProgress);
            ctx.stroke();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `italic 900 ${28 * scale}px ${FONT}`;
            ctx.fillStyle = m.multiplierColor;
            ctx.fillText(m.multiplierText, rx, ry + 1);
            ctx.textBaseline = 'alphabetic';
            ctx.shadowColor = 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = 8;
            ctx.font = `800 ${30 * scale}px ${FONT}`;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(m.streakText, rx, ry - br - 30 * scale);
            ctx.font = `700 ${10 * scale}px ${FONT}`;
            ctx.fillStyle = '#9aa4c4';
            ctx.fillText('NOTE STREAK', rx, ry - br - 14 * scale);
            if (m.fullCombo && state && state.notesHit > 0) {
                ctx.fillStyle = '#ffd23f';
                ctx.fillText('FULL COMBO', rx, ry + br + 18 * scale);
            }
            // Bonus feed + tags under the multiplier.
            if (bonus) {
                let fy = ry + br + 40 * scale;
                const tags = [];
                if (bonus.rollActive) tags.push(['ROLL', '#ff9a40']);
                if (bonus.soloLive && bonus.soloLive.active) tags.push(['SOLO', '#c9b6ff']);
                ctx.font = `800 ${11 * scale}px ${FONT}`;
                for (const [txt, col] of tags) { ctx.fillStyle = col; ctx.fillText(txt, rx, fy); fy += 16 * scale; }
                ctx.font = `700 ${12 * scale}px ${FONT}`;
                for (const f of bonus.feed) {
                    const age = wall - f.wall;
                    if (age > 2500) continue;
                    ctx.globalAlpha = clamp(1 - age / 2500, 0, 1);
                    ctx.fillStyle = f.color;
                    ctx.fillText(f.text, rx, fy);
                    fy += 15 * scale;
                }
                ctx.globalAlpha = 1;
            }
            // Live drum-solo meter (top centre).
            if (bonus && bonus.soloLive) {
                const sl = bonus.soloLive;
                const p = sl.n ? sl.h / sl.n : 1;
                const cy = Math.max(70 * scale, Hc * 0.2);
                ctx.textAlign = 'center';
                ctx.shadowColor = 'rgba(0,0,0,0.85)';
                ctx.shadowBlur = 10;
                ctx.font = `800 ${12 * scale}px ${FONT}`;
                ctx.fillStyle = '#c9b6ff';
                ctx.fillText('DRUM SOLO', Wc / 2, cy - 44 * scale);
                ctx.font = `900 ${46 * scale}px ${FONT}`;
                ctx.fillStyle = p >= 1 ? '#ffc531' : p >= 0.9 ? '#dccfff' : '#ffffff';
                ctx.fillText(Math.round(p * 100) + '%', Wc / 2, cy);
                ctx.shadowBlur = 0;
                const bw = 220 * scale, bh = 7 * scale;
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(Wc / 2 - bw / 2, cy + 8 * scale, bw, bh);
                ctx.fillStyle = '#9b7bff';
                ctx.fillRect(Wc / 2 - bw / 2, cy + 8 * scale, bw * p, bh);
                ctx.font = `600 ${11 * scale}px ${FONT}`;
                ctx.fillStyle = '#b3a6d9';
                ctx.fillText(sl.n ? sl.h + ' / ' + sl.n + ' notes' : 'get ready', Wc / 2, cy + 30 * scale);
            }

            // Centre toasts.
            let msg = null;
            if (frame.message) msg = { text: frame.message, color: '#c8d0ee', alpha: 1 };
            else if (toast && wall - toast.born < (toast.long ? 2800 : 1600)) {
                const life = toast.long ? 2800 : 1600;
                msg = { text: toast.text, sub: toast.sub, color: toast.color, alpha: clamp(1 - (wall - toast.born - (life - 500)) / 500, 0, 1) };
            } else if (m.spReady && !m.spActive && frame.hint) {
                msg = { text: frame.hint, color: '#9fe9ff', alpha: 0.6 + 0.4 * Math.sin(wall / 200) };
            }
            if (msg) {
                ctx.globalAlpha = msg.alpha;
                ctx.textAlign = 'center';
                ctx.font = `italic 800 ${26 * scale}px ${FONT}`;
                ctx.shadowColor = msg.color;
                ctx.shadowBlur = 16;
                ctx.fillStyle = msg.color;
                const my = narrow ? Math.max(150 * scale, Hc * 0.24) : Math.max(40 * scale, Hc * 0.12);
                ctx.fillText(msg.text, Wc / 2, my);
                if (msg.sub) {
                    ctx.font = `700 ${15 * scale}px ${FONT}`;
                    ctx.shadowBlur = 8;
                    ctx.fillText(msg.sub, Wc / 2, my + 24 * scale);
                }
                ctx.globalAlpha = 1;
            }
            ctx.shadowBlur = 0;
        }

        // ── Frame ──
        function render(frame) {
            frame = frame || {};
            const wall = Number.isFinite(frame.wallNow) ? frame.wallNow : defaultNow();
            wallLast = wall;
            const session = frame.session || null;
            const eng = session ? session.engine : null;
            const state = eng ? eng.getState() : null;
            const t = Number.isFinite(frame.time) ? frame.time : 0;
            const look = frame.lookahead > 0 ? frame.lookahead : TRACK.defaultLookahead;
            const speed = TRACK.length / look;
            const sp = state ? state.starPower : null;
            const spActive = !!(sp && sp.active);
            const canActivate = !!(sp && sp.canActivate);

            if (session) handleEvents(session.drainEvents(), wall);

            // Track motion.
            trackTex.offset.y = -((t * speed) / 2) % 1;

            // Star power glow.
            const spPulse = 0.5 + 0.5 * Math.sin(wall / 140);
            const spIn = spActive ? clamp((wall - spActiveSince) / 250, 0, 1) : clamp(1 - (wall - spEndedAt) / 400, 0, 1);
            spWashMat.opacity = 0.14 * spIn + 0.05 * spIn * spPulse;
            railGlowMat.opacity = spIn * (0.55 + 0.35 * spPulse) + (canActivate && !spActive ? 0.18 + 0.12 * spPulse : 0);
            railMat.color.setHex(COLORS.rail).lerp(tmpColor.setHex(COLORS.starPowerEdge), Math.max(spIn, canActivate ? 0.35 : 0));
            dividerMat.color.setHex(0x2a3456).lerp(tmpColor.setHex(COLORS.starPowerEdge), spIn * 0.6);
            // Drum solo: violet wash + rails.
            {
                const bl = session && session.getBonus ? session.getBonus() : null;
                const target = bl && bl.soloLive && bl.soloLive.active ? 1 : 0;
                soloIn += (target - soloIn) * 0.08;
                soloWashMat.opacity = 0.12 * soloIn;
                if (soloIn > 0.02 && !spActive) {
                    railMat.color.lerp(tmpColor.setHex(0x9b7bff), soloIn * 0.8);
                    dividerMat.color.lerp(tmpColor.setHex(0x9b7bff), soloIn * 0.5);
                }
            }

            // Beat lines.
            const beats = session ? session.beats : [];
            let nb = 0, nm = 0;
            if (beats.length) {
                const [b0, b1] = visibleRange(beats, t - TRACK.behind / speed, t + look);
                for (let i = b0; i < b1 && (nb < MAX_BEATS && nm < MAX_BEATS); i++) {
                    const z = -(beats[i].t - t) * speed;
                    dummy.position.set(0, 0.003, z);
                    dummy.rotation.set(0, 0, 0);
                    dummy.scale.set(1, 1, 1);
                    dummy.updateMatrix();
                    if (beats[i].measure) measureLines.setMatrixAt(nm++, dummy.matrix);
                    else beatLines.setMatrixAt(nb++, dummy.matrix);
                }
            }
            beatLines.count = nb; measureLines.count = nm;
            beatLines.instanceMatrix.needsUpdate = true;
            measureLines.instanceMatrix.needsUpdate = true;

            // Fill windows (shown while star power can be activated).
            let nf = 0;
            if (eng && canActivate && !spActive && Array.isArray(eng.activationWindows)) {
                for (const w of eng.activationWindows) {
                    if (nf >= MAX_FILLS) break;
                    const end = Math.max(w.end, w.chord ? w.chord.t : w.end);
                    if (end < t - 0.2 || w.start > t + look) continue;
                    const zA = -(Math.max(w.start, t - TRACK.behind / speed) - t) * speed;
                    const zB = -(Math.min(end, t + look) - t) * speed;
                    const len = Math.max(0.01, zA - zB);
                    const f = fills[nf++];
                    f.m.visible = f.e1.visible = f.e2.visible = true;
                    f.m.position.set(0, 0.008, (zA + zB) / 2);
                    f.m.scale.set(1, len, 1);
                    for (const [e, sx] of [[f.e1, -1], [f.e2, 1]]) {
                        e.position.set(sx * (W4 / 2 - 0.03), 0.012, (zA + zB) / 2);
                        e.scale.set(1, 1, len);
                    }
                }
            }
            for (let i = nf; i < MAX_FILLS; i++) fills[i].m.visible = fills[i].e1.visible = fills[i].e2.visible = false;
            fillMat.opacity = 0.10 + 0.08 * spPulse;

            // Gems.
            const cnt = { pad: 0, padGhost: 0, padCap: 0, padRim: 0, shadow: 0, dome: 0, domeGhost: 0, bell: 0, cymRing: 0, cymRingGhost: 0,
                kick: 0, stripe: 0, glow: 0, activator: 0 };
            const gems = session ? session.gems : [];
            if (gems.length) {
                const [g0, g1] = visibleRange(gems, t - TRACK.behind / speed, t + look);
                // Draw far -> near so additive glows layer sensibly.
                for (let i = g1 - 1; i >= g0; i--) {
                    const g = gems[i];
                    // Auto notes are played for you: gone once they reach the strikeline.
                    if (g.auto && g.t <= t) continue;
                    const st = eng ? eng.noteState(g.id) : null;
                    if (st === 'hit') continue;
                    const missed = st === 'miss';
                    const isSp = !!(eng && !missed && eng.isStarPowerNote(g.id));
                    const z = -(g.t - t) * speed;
                    const base = missed ? missedColor : (isSp ? spColor : tmpColor.setHex(g.color));
                    const col = gemColor.copy(base);
                    if (g.accent && !missed) col.lerp(white, 0.1);
                    if (g.auto) col.multiplyScalar(0.38);
                    const s = TRACK.gemScale * (g.ghost ? 0.74 : (g.accent ? 1.16 : 1));
                    if (g.kind === 'kick' || g.kind === 'kick2x') {
                        if (cnt.kick < 128) {
                            const sy = g.kick2x ? 1.35 : 1;
                            place(meshes.kick, cnt.kick++, 0, 0, z, 1, sy * (g.accent ? 1.2 : 1), g.accent ? 1.25 : 1, col);
                            if (g.kick2x && cnt.stripe < 128) place(meshes.stripe, cnt.stripe++, 0, 0.02, z, 1, sy, 1, white);
                        }
                        if (!missed && !g.auto && cnt.glow < MAX_GEMS) place(meshes.glow, cnt.glow++, 0, 0, z, W4 + 0.6, 1, 0.9, tmp2.copy(col).multiplyScalar(0.55));
                    } else {
                        const x = laneX(g.lane);
                        if (g.kind === 'cymbal') {
                            const dk = g.ghost ? 'domeGhost' : 'dome';
                            const rk = g.ghost ? 'cymRingGhost' : 'cymRing';
                            place(meshes[dk], cnt[dk]++, x, 0, z, s, s, s, col);
                            place(meshes[rk], cnt[rk]++, x, 0, z, s, s, s, col);
                            if (!g.ghost) place(meshes.bell, cnt.bell++, x, 0, z, s, s, s, tmp2.copy(col).lerp(white, 0.55));
                            place(meshes.shadow, cnt.shadow++, x, 0, z, s, 1, s, white);
                        } else {
                            const pk = g.ghost ? 'padGhost' : 'pad';
                            place(meshes[pk], cnt[pk]++, x, 0, z, s, s, s, col);
                            if (!g.ghost) {
                                place(meshes.padCap, cnt.padCap++, x, 0, z, s, s, s, tmp2.copy(col).lerp(white, 0.08));
                                place(meshes.padRim, cnt.padRim++, x, 0, z, s, s, s, tmp2.copy(col).multiplyScalar(0.22));
                            }
                        }
                        if (!missed && !g.auto) {
                            const gs = (g.ghost ? 0.9 : (g.accent ? 1.75 : 1.35));
                            place(meshes.glow, cnt.glow++, x, 0, z, gs, 1, g.kind === 'cymbal' ? gs : gs * 0.6,
                                tmp2.copy(col).multiplyScalar(g.ghost ? 0.3 : (g.accent ? 0.9 : 0.6)));
                        }
                        if (canActivate && !spActive && !missed && eng && eng.isActivatorNote(g.id) && cnt.activator < 16) {
                            dummy.position.set(x, 0.42, z);
                            dummy.rotation.set(0, wall / 400, 0);
                            const ps = 1 + 0.12 * spPulse;
                            dummy.scale.set(ps, ps, ps);
                            dummy.updateMatrix();
                            meshes.activator.setMatrixAt(cnt.activator, dummy.matrix);
                            meshes.activator.setColorAt(cnt.activator, tmpColor.setHex(COLORS.activator));
                            cnt.activator++;
                        }
                    }
                }
            }
            for (const k of Object.keys(meshes)) {
                const m = meshes[k];
                m.count = cnt[k];
                m.instanceMatrix.needsUpdate = true;
                if (m.instanceColor) m.instanceColor.needsUpdate = true;
            }

            // Strikeline targets.
            for (let i = 0; i < TRACK.lanes; i++) {
                const tg = targets[i];
                const k = clamp(1 - (wall - tg.press) / 140, 0, 1);
                const sc = 1 + 0.14 * k;
                tg.ring.scale.set(sc, sc, sc);
                tg.ringMat.color.copy(tg.color).lerp(white, 0.5 * k);
                tg.discMat.color.setHex(COLORS.track).lerp(tg.color, 0.16 + 0.66 * k);
                const lt = laneTints[i];
                const red = clamp(1 - (wall - lt.red) / 380, 0, 1);
                const press = clamp(1 - (wall - lt.press) / 160, 0, 1);
                if (red > 0) { lt.mat.color.setHex(COLORS.miss); lt.mat.opacity = 0.45 * red; }
                else { lt.mat.color.copy(lt.color); lt.mat.opacity = 0.16 * press; }
            }
            const kk = clamp(1 - (wall - kickTarget.press) / 160, 0, 1);
            kickLineMat.color.setHex(COLORS.kick).lerp(white, 0.45 * kk);
            kickGlowMat.opacity = 0.22 + 0.5 * kk;
            kickTintMat.opacity = 0.5 * clamp(1 - (wall - kickTintState.red) / 380, 0, 1);

            // Flashes.
            for (const f of flashes) {
                const age = (wall - f.born) / 1000;
                const life = f.kick ? 0.32 : 0.36;
                if (age < 0 || age > life) { f.ring.visible = f.flare.visible = false; continue; }
                const p = age / life;
                f.ring.visible = f.flare.visible = true;
                if (f.kick) {
                    f.ring.visible = false;
                    f.flare.position.set(0, 0.06, 0);
                    f.flare.scale.set(W4 + 1.6 + p * 1.2, 1, 1.2 + p * 1.5);
                    f.glowM.opacity = 0.95 * (1 - p);
                } else {
                    const rs = 0.8 + p * 1.3;
                    f.ring.position.set(f.x, 0.08, 0);
                    f.ring.scale.set(rs * 1.05, 1, rs * 0.55);
                    f.ringMat.opacity = (f.strong ? 1 : 0.9) * (1 - p);
                    const gs = 1.6 + p * 0.8;
                    f.flare.position.set(f.x, 0.09, 0);
                    f.flare.scale.set(gs * 1.1, 1, gs * 0.7);
                    f.glowM.opacity = 1.0 * (1 - p) * (1 - p);
                }
            }

            // Sparks.
            for (let i = 0; i < MAX_SPARKS; i++) {
                const age = (wall - sparkBorn[i]) / 1000;
                const life = sparkLife[i];
                if (age < 0 || age > life) {
                    sparkCol[i * 3] = sparkCol[i * 3 + 1] = sparkCol[i * 3 + 2] = 0;
                    sparkPos[i * 3 + 1] = -5;
                    continue;
                }
                const k = 1 - age / life;
                sparkPos[i * 3] = sparkOrigin[i * 3] + sparkVel[i * 3] * age;
                sparkPos[i * 3 + 1] = sparkOrigin[i * 3 + 1] + sparkVel[i * 3 + 1] * age - 9.0 * age * age;
                sparkPos[i * 3 + 2] = sparkOrigin[i * 3 + 2] + sparkVel[i * 3 + 2] * age;
                sparkCol[i * 3] = sparkBase[i * 3] * k;
                sparkCol[i * 3 + 1] = sparkBase[i * 3 + 1] * k;
                sparkCol[i * 3 + 2] = sparkBase[i * 3 + 2] * k;
            }
            sparkGeo.attributes.position.needsUpdate = true;
            sparkGeo.attributes.color.needsUpdate = true;

            renderer.render(scene, camera);
            drawHud(frame, state, wall);
        }

        function resize(w, h, pixelRatio) {
            if (!(w > 0) || !(h > 0)) return;
            cssW = w; cssH = h;
            dpr = pixelRatio > 0 ? pixelRatio : 1;
            renderer.setPixelRatio(dpr);
            renderer.setSize(w, h, false);
            if (hud) {
                hud.width = Math.round(w * dpr);
                hud.height = Math.round(h * dpr);
                hud.style.width = w + 'px';
                hud.style.height = h + 'px';
            }
            layoutCamera();
        }

        function dispose() {
            for (const d of disposables) { try { d.dispose(); } catch (_) { /* ignore */ } }
            for (const k of Object.keys(meshes)) { try { meshes[k].dispose(); } catch (_) { /* ignore */ } }
            try { beatLines.dispose(); measureLines.dispose(); } catch (_) { /* ignore */ }
            try { renderer.renderLists.dispose(); renderer.dispose(); } catch (_) { /* ignore */ }
            _resetPixelStore(gl);   // the canvas (and its context) is reused by the next renderer
            if (hctx && hud) { try { hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.clearRect(0, 0, hud.width, hud.height); } catch (_) { /* ignore */ } }
        }

        return {
            render, resize, dispose, project,
            get hudContext() { return hctx; },
            get size() { return { w: cssW, h: cssH, dpr }; },
            get lastWall() { return wallLast; },
            get difficultyRect() { return diffRect; },
            /** The timing meter's Apply pill (css px) and the input offset it applies, or null. */
            get timingRect() { return timingRect; },
            get timingSuggest() { return timingSuggest; },
        };
    }

    return {
        TRACK, PAD_SYNTH_MIDI,
        keyToPad, synthMidiForPad,
        createView,
    };
});
