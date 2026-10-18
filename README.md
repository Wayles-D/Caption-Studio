# BHYND — Caption Studio

A browser-based video caption and motion-graphics editor. You drop in a short
video, get a transcript, and then style, animate, cut and layer it — captions,
text cards, shapes, images, sound effects, tracked objects — and export a
finished file.

It is built around one rule: **the preview and the export are the same
renderer**. Everything in `shared/` is used verbatim by both the browser canvas
and the server-side exporter, so what you see on screen is what lands in the
file. Most of the architecture below exists to keep that promise.

---

## Running it

Requires Node 20+ and ffmpeg (bundled via `ffmpeg-static`).

```bash
npm install
npm install --prefix backend
npm run dev:all          # frontend on :5173, backend on :3001
```

`npm run dev` alone serves the UI, but caption fonts are served by the backend —
without it, text falls back to system faces.

```bash
npm run build            # production bundle into dist/
npm test                 # backend engine tests, then the Playwright e2e suite
```

---

## Layout

```
shared/        the rendering engine — used by BOTH preview and export
src/           the browser app (vanilla engine modules + React inspector panels)
backend/       Express server: transcription, font serving, ffmpeg export
tests/e2e/     Playwright specs that drive the real UI and read canvas pixels
```

### `shared/` — the part that must never diverge

| Module | What it owns |
|---|---|
| `captionGraphics.js` | Draws a caption frame. The single funnel both renderers call. |
| `captionTransform.js` | Per-caption and per-word overrides, resolved at a given instant. |
| `textElement.js` | Independent text: overlays and cinematic cards. |
| `keyframes.js` | Keyframe evaluation — interpolated for transforms, **stepped** for style. |
| `visualLayers.js` | The one layer stack: captions, text, images, shapes, objects. |
| `shapeLayer.js`, `annotationStrokes.js` | Shapes, and hand-drawn circles/underlines/arrows that draw themselves on. |
| `audioTimeline.js`, `soundRegistry.js`, `syllables.js` | Music, SFX, and per-syllable sound placement. |
| `objects/` | Object tracking, segmentation masks, subject isolation, occlusion. |
| `fontRegistry.js` | Font families and their real internal names, with licence notes. |

### `src/` — the app

`src/js/components/` holds the engine-facing modules (preview, timeline, canvas
transforms, audio, segmentation). `src/components/` holds the React inspector
panels. State lives in small stores under `src/store/`, surfaced to the engine
modules through `src/js/state.js`.

### `backend/` — export

`server.js` takes the project state and renders it through
`utils/graphicsFrameGenerator.js` — the same `shared/` code the preview uses —
then composites with ffmpeg (`utils/graphicsCompositor.js`,
`utils/audioMixFilter.js`). `backend/test_*.js` are engine-level harnesses that
render and measure real frames.

---

## What it can do

**Captions** — transcript-timed captions with presets, per-word styling,
keyword highlighting, rolling-stack and word-by-word modes, caption profiles,
and per-word transforms, animations and keyframes.

**Text** — independent overlays and cinematic cards with the full caption
styling model, their own timing, transforms and entrance animations. Fonts,
weight, case and colour can be **keyframed**: because there is no half-way
between two fonts, style keyframes hold and then change outright.

**Objects** — YOLO detection plus manual box-drawing for anything it misses,
NCC template tracking, MobileSAM pixel-level masks, object-aware effects that
follow the subject's exact shape, background replacement, and **dynamic
occlusion** so text and shapes can pass behind a moving person.

**Audio** — a music track and a sound-effects lane, trimmable and splittable
with waveforms, plus syllable-timed SFX driven from the transcript.

**Timeline** — layered tracks with live drag feedback, trim handles, split at
the playhead, zoom, and keyboard shortcuts.

---

## Testing

Two layers, and the second is the one that counts.

`npm run test:backend` renders frames through the shared engine and measures
them — fast, but it only proves the engine is right.

`npm run test:e2e` drives the actual application: real clicks on the real
canvas, real panels, then reads `#captions-canvas` pixels back. Features have
shipped looking perfect at the engine level and been completely broken in the
browser — an unloaded webfont falls back silently, a picker reverts its own
value on close. Those bugs only exist in the layer the engine tests skip.

When asserting pixels, compare against **ground truth** rather than "something
changed": render the same instant three ways — the feature, the inherited
baseline, and a statically configured equivalent — and require the feature to
match the static one exactly. A threshold like "the ink count moved by 3%"
passes just as happily when the result is wrong.

Dev-only hooks (`window.__appState`, `__updateState`, `__debug*`) let specs
inject deterministic transcripts and ask the app where a word actually is on
screen.

---

## Conventions

- Anything that affects what is drawn belongs in `shared/`, never in one renderer.
- A new visual feature is not done until it exports correctly, not just previews.
- Milestones are tagged `vX.Y.Z`.
