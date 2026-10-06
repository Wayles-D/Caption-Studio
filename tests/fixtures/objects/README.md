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
