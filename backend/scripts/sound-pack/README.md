# The BHYND sound pack

347 sound effects for short-form editing, synthesised locally in plain JavaScript
(no samples, no network, no dependencies beyond the `ffmpeg-static` binary the
project already has, used only to measure). The generated WAVs are in
`public/sounds/bh-*.wav`, and the generated manifest is `shared/soundPackManifest.js`.

Nothing in the pack is recorded or licensed. Every sound is procedural DSP, so
these are synthetic approximations of the real-world sounds they are named after.

## Regenerating

```sh
node backend/scripts/generate-sound-pack.js                 # everything (a few minutes)
node backend/scripts/generate-sound-pack.js pop-soft ...    # these ids
node backend/scripts/generate-sound-pack.js --family=paper  # one family
node backend/scripts/generate-sound-pack.js --verify-core   # the original 31 are byte-identical
```

Output is reproducible. Every random choice comes from a PRNG seeded by the
sound's id, so the same recipe always produces the same bytes, and editing one
recipe changes only that one file.

## Layout

| File | What it holds |
|---|---|
| `generate-sound-pack.js` | Entry point: loads recipes, validates metadata, masters, writes the manifest |
| `sound-pack/dsp.js` | Primitives: oscillators, biquads, envelopes, noise, reverb, pan |
| `sound-pack/instruments.js` | The engines the original 31 sounds are built on (bell, pop, impact, whoosh) |
| `sound-pack/engines.js` | Newer engines: `click`, `modal` (materials), `crackle`, `friction` (writing), `tones`, `varispeed`, `servo`, `buzz` |
| `sound-pack/master.js` | Mastering, identical for every sound |
| `sound-pack/recipes/*.js` | One module per section. Each sound's metadata sits beside its recipe |

## The system

**Sections → families → sounds.** The picker shows the same hierarchy
(`shared/soundRegistry.js` `listSoundSections`).

| Section | Families (count) |
|---|---|
| Text & Captions | Micro 11, Pop 7, Pluck 5, Blip 5, Caption Accents 7 |
| Cinematic & Impact | Cinematic 14, Sting 5, Impact 16, Drop 8, Low End 4 |
| UI & Digital | Interface 24, Digital 7, Success & Reward 8 |
| Tech, Electric & Glitch | Sci-Fi & AI 16, Electric & Light 14, Glitch 16 |
| Motion & Transitions | Whoosh 14, Movement 10, Transition 10, Rise & Reverse 12, Air 5 |
| Mood & Reaction | Chime 11, Shimmer & Sparkle 11, Tension 8, Comedy 14 |
| Foley | Writing & Drawing 23, Paper 11, Keyboard/Mouse/Phone 14, Objects 16, Camera & Video 12, Stop & Interrupt 9 |

**Tiers** (`tier` in the manifest): micro 74, subtle 94, medium 120, strong 35,
cinematic 10, comedic 14.

**Usage** (`usageFor`): `word` sounds (78) are dry and tail-free, so they are
safe on consecutive words ("five / home / office / hacks"). `moment` sounds carry
weight or a tail and are for the few beats that deserve one. A sound's tier sets
its usage, and a recipe can override it with `usage: 'word'`.

**Literal** (`literal: true`, 94 sounds): foley that depicts a specific thing
(a pencil, a shutter, a keyboard). These are the pack sounds the analysis model
is told about by id. It reaches the rest through sound categories
(`shared/soundProfiles.js`), because naming all 347 would cost more than the
model's token budget.

## Mastering

Every sound goes through the same steps (`master.js`):

1. Remove DC.
2. Trim to the first sample above −60 dB and the last above −50 dB.
3. Fade both edges.
4. Set the level so that, at the pack's default clip volume (0.7), the sound's
   EBU R128 max-momentary loudness hits its family's target
   (`shared/soundPack.js` `PACK_FAMILIES`), plus the sound's own `gain` offset.
   True peak stays at or below −1 dBTP. Sounds that would exceed that are held
   below target, and the report marks them `peak-limited`: very short clicks,
   whose loudness cannot reach target without clipping.
5. Write 16-bit/48 kHz WAV with TPDF dither.

The targets are calibrated against real speech: the test video's dialogue runs
at about −17 LUFS momentary, and every pack sound sits below that.

## QA gates the pack was built against

These tools are not in the repo. They were run during generation, and the
backend test suite (`backend/test_audio_pipeline.js`) checks the
manifest ↔ file ↔ registry contract on every run.

| Gate | Criterion | Result |
|---|---|---|
| Format audit | 16-bit/48 kHz WAV; no lead silence (−66 dB); no clipping; true peak ≤ −1 dBTP; no DC | 347/347 |
| Truncation clicks | HF (>8 kHz) spike with the full-band level dropping >6 dB within 5 ms (a cut, not an attack) | 0 |
| Near-duplicates | Close on brightness, pitch, attack, length, HF ratio and crest factor at once | 1 flagged, kept (see below) |
| Phone speaker | Level lost through HP 250 Hz ×2 + LP 12 kHz: ≤ 8 dB (≤ 12 dB for the low family) | Met, with 3 exceptions (below) |

Design rules the gates enforced, noted in the code where they apply:

- **Buffer sizing.** Buffers are sized with `span()` (to −50 dB) and every
  envelope ends at zero (`taperEnd`).
- **Crush order.** Bit-crushing happens before enveloping, not after.
- **Gate edges.** Gates have edges of at least 1.5–2 ms.
- **Low end.** Low sounds carry harmonics and a 250–450 Hz knock, so a phone
  reconstructs the missing fundamental.

## Known limits and gaps

**Phone-speaker exceptions.** These are low sounds, accepted as they are:

- `drop-sub` (8.9 dB loss) and `cinematic-pulse` (8.4 dB) are two of the
  original 31, left unchanged.
- `impact-sub` (9.7 dB) is a deliberately sub-heavy "felt" hit.

**Near-duplicate flag.** `writing-marker-stroke` and `writing-marker-cross`
measure alike. The cross is two strokes with a lift between them, which the
metric does not capture.

**Least certain.** The writing and paper families, `object-zipper`,
`stop-record-scratch`, and the comedy trombone and crickets. They are modelled
on the physics or the gesture, but they are furthest from a recording.

**Not generated.** These cannot be synthesised convincingly with this tooling,
so no substitutes were made:

- orchestral and emotional swells, and real strings;
- organic foley: cloth, cardboard, liquids, footsteps;
- a realistic wet paint brush;
- voices, crowd reactions and meme clips.

The Classic library already covers the last group with real recordings. The
registry takes a recorded or licensed file for any of these as a drop-in:
register it with a family and it appears in the right place.

**Repository size.** The pack's WAVs total about 38 MB. They are reproducible
from the recipes, so they could be generated at setup instead of committed.
