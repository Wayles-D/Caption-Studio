# Object-detection fixtures

Real footage for the object-detection tests (backend/test_objects.js,
tests/e2e/objects.spec.js): people in a crowd, several of the same class,
some leaving the frame, in a portrait video.

- `crowd.jpg` — one frame.
- `crowd-3s.mp4` — three seconds, 270×480 portrait, 30 fps, no audio.
- `crowd-3s-rotated.mp4` — the same three seconds, stored landscape (480×270)
  with display-rotation metadata (90°) so players show it portrait: checks
  that detections follow the video as displayed, not as stored.

All three are cut and re-encoded from **"Pyrkon 2026 - ambient flow of
people 1"** by its Wikimedia Commons author, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
https://commons.wikimedia.org/wiki/File:Pyrkon_2026_-_ambient_flow_of_people_1.webm
(trimmed, scaled to 480p by Commons' own transcode, re-encoded to H.264; the
rotated copy is also transposed).

## Tracking fixtures (V1.8)

All 640×360, 15 fps: real people walking known paths over a plain backdrop.
Built by `make-crossing.mjs`, which also exports the ground truth
(`truth(name, t, scene)`) the tests check against.

- `crossing.mp4` — 4s: two people cross, one passes behind a pillar and
  leaves the frame.
- `lookalike.mp4` — 4s: the same crossing with identical twins (one is the
  other's mirror image), so only motion can tell them apart.
- `reentry.mp4` — 4.5s: one person is wholly hidden behind a wall for ~1.2s
  (longer than the tracker coasts), comes out, and leaves; another stands
  on the left throughout.
- `person-white.png`, `person-green.png` — the two people, cut from a frame
  of **"Vespero en Hong Kong Island (2014) 02"** (Wikimedia Commons), licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/):
  https://commons.wikimedia.org/wiki/File:Vespero_en_Hong_Kong_Island_(2014)_02.webm
  — cropped; the three tracking videos are derivatives and share that license.

## Segmentation fixture (V2.0)

- `segment.mp4` — 640×360, 15 fps, 4.5s: two people with their REAL
  silhouettes walk a street; one crosses in front of the other, which then
  passes behind a pillar and leaves the frame. `make-crossing.mjs`'s
  `visibleMask(name, t, 'segment')` renders exactly the pixels of a person
  visible at any time — the ground truth segmentation is scored against.
- `person-olive.png`, `person-shirt.png` — two people with soft-edged alpha
  cut-outs; `street-bg.jpg` — an empty stretch of the same street. All from
  frames of the same clip (CC BY-SA 4.0, above): the cut-outs were made with
  MobileSAM and cleaned by hand (stray scene fragments removed); the
  background cropped. `segment.mp4` is a derivative and shares the license.

## Manual-selection fixture (V2.0.1)

- `custom.mp4` — 640×360, 15 fps, 4s: a patterned square BADGE (drawn by
  `make-crossing.mjs`; no class the detector knows — a round one was taken
  for a sports ball) drifts, grows ~40% and passes in front of a walking
  person, on the street while the camera pans; a still DECOY badge in other
  colours at the top right. `truth('badge' | 'decoy' | 'olive', t, 'custom')`.
  Used by backend/test_manual_objects.js and tests/e2e/manual-objects.spec.js.
  A derivative of the street and person above (CC BY-SA 4.0).
