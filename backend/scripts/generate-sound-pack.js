/**
 * Generates the BHYND sound pack into public/sounds/, and its manifest into
 * shared/soundPackManifest.js.
 *
 *   node backend/scripts/generate-sound-pack.js                 # everything
 *   node backend/scripts/generate-sound-pack.js pop-soft ...    # these ids
 *   node backend/scripts/generate-sound-pack.js --family=paper  # one family
 *   node backend/scripts/generate-sound-pack.js --verify-core   # check the approved 31
 *
 * The companion to generate-sounds.js, which makes the original placeholder
 * set from one-line FFmpeg expressions. That cannot do what an editing pack
 * needs, so this is real DSP in plain JavaScript (sound-pack/dsp.js), played
 * through reusable engines (sound-pack/instruments.js, engines.js) by recipes
 * grouped by domain (sound-pack/recipes/). No dependency beyond the
 * ffmpeg-static binary the project already has, used only to MEASURE.
 *
 * REPRODUCIBLE. Every random choice comes from a PRNG seeded by the sound's
 * id, so running this twice produces byte-identical files, and changing one
 * recipe changes one file.
 *
 * MASTERING, identical for every sound (sound-pack/master.js):
 *   1. DC removed (4 Hz pole, so sub-bass keeps its low end).
 *   2. Trimmed to its first audible sample (-60 dB) and to where its tail
 *      falls 50 dB below its peak — no leading silence, so a sound placed on
 *      a word starts ON the word.
 *   3. A 0.17 ms fade-in and a short fade-out, so trimming never clicks.
 *   4. Gained so that at the pack's default clip volume it reaches its
 *      family's EBU R128 momentary-loudness target plus the sound's own gain
 *      offset, unless that would take its true peak past -1 dBTP (the report
 *      marks those as peak-limited).
 *   5. Written as 16-bit 48 kHz WAV with TPDF dither.
 *
 * Every sound's metadata is authored beside its recipe. The manifest records
 * that metadata plus what was MEASURED from the file, so the app never
 * carries a hand-typed duration or level.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { mulberry32, seedFor } from './sound-pack/dsp.js';
import { master, OUT_DIR } from './sound-pack/master.js';
import { PACK_FAMILIES, PACK_TIERS, packFileName } from '../../shared/soundPack.js';
import { CORE_SOUNDS } from './sound-pack/recipes/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(__dirname, '../../shared/soundPackManifest.js');

// Recipe modules are loaded if present, so the pack can be grown one domain
// at a time without the generator failing on a module not yet written.
const MODULES = ['text', 'cinematic', 'ui', 'tech', 'motion', 'mood', 'foley'];
const ALL = [...CORE_SOUNDS];
for (const m of MODULES) {
  const file = path.join(__dirname, 'sound-pack/recipes', `${m}.js`);
  if (fs.existsSync(file)) ALL.push(...(await import(`./sound-pack/recipes/${m}.js`)).SOUNDS);
}

// ---- validation: a mistake in a recipe table fails loudly, before any audio ----
const families = new Map(PACK_FAMILIES.map((f) => [f.id, f]));
const tiers = new Set(PACK_TIERS.map((t) => t.id));
const seen = new Set();
const problems = [];
for (const s of ALL) {
  if (seen.has(s.id)) problems.push(`duplicate id ${s.id}`);
  seen.add(s.id);
  if (!families.has(s.family)) problems.push(`${s.id}: unknown family ${s.family}`);
  if (!tiers.has(s.tier)) problems.push(`${s.id}: unknown tier ${s.tier}`);
  if (typeof s.render !== 'function') problems.push(`${s.id}: no render function`);
  if (!s.label || !s.use || !Array.isArray(s.tags)) problems.push(`${s.id}: missing label/use/tags`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const args = process.argv.slice(2);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

// ---- --verify-core: the approved 31 must still build to the same bytes ------------
if (args.includes('--verify-core')) {
  let same = 0;
  const changed = [];
  for (const s of CORE_SOUNDS) {
    const file = path.join(OUT_DIR, packFileName(s.id));
    const before = fs.existsSync(file) ? md5(file) : null;
    const r = master(s.id, s.render(mulberry32(seedFor(s.id))), families.get(s.family).targetLufsM);
    (md5(r.file) === before ? same++ : changed.push(s.id));
  }
  console.log(`core: ${same} byte-identical, ${changed.length} changed${changed.length ? ': ' + changed.join(', ') : ''}`);
  process.exit(changed.length ? 1 : 0);
}

// ---- which sounds to render this run ------------------------------------------------
const familyArg = args.find((a) => a.startsWith('--family='))?.slice(9);
const ids = new Set(args.filter((a) => !a.startsWith('--')));
const selected = ALL.filter((s) => (!ids.size && !familyArg) || ids.has(s.id) || s.family === familyArg);

// Measurements from the previous manifest, so a partial run still writes a
// complete manifest.
let previous = new Map();
try {
  const rows = fs.readFileSync(MANIFEST, 'utf8').split('\n').filter((l) => l.trim().startsWith('{'));
  previous = new Map(rows.map((l) => { const o = JSON.parse(l.trim().replace(/,$/, '')); return [o.id, o]; }));
} catch { /* first run */ }

fs.mkdirSync(OUT_DIR, { recursive: true });
const measured = new Map();
const report = [];
for (const s of selected) {
  const target = families.get(s.family).targetLufsM + (s.gain || 0);
  const r = master(s.id, s.render(mulberry32(seedFor(s.id))), target);
  measured.set(s.id, { duration: +r.duration.toFixed(3), channels: r.channels, lufsM: +r.atDefault.toFixed(1), truePeak: +r.truePeak.toFixed(1) });
  report.push(r);
}

// ---- manifest ---------------------------------------------------------------------
const lines = [];
const missing = [];
for (const s of ALL) {
  const m = measured.get(s.id) || previous.get(s.id);
  if (!m || !fs.existsSync(path.join(OUT_DIR, packFileName(s.id)))) { missing.push(s.id); continue; }
  const entry = {
    id: s.id, label: s.label, family: s.family, tier: s.tier,
    ...(s.usage ? { usage: s.usage } : {}),
    tags: s.tags, use: s.use,
    ...(s.literal ? { literal: true } : {}),
    duration: m.duration, channels: m.channels, lufsM: m.lufsM, truePeak: m.truePeak
  };
  lines.push('  ' + JSON.stringify(entry));
}
fs.writeFileSync(MANIFEST, [
  '// GENERATED by backend/scripts/generate-sound-pack.js — do not edit by hand.',
  '// Metadata is authored beside each recipe in backend/scripts/sound-pack/recipes/;',
  '// duration, channels, lufsM (at the pack default volume) and truePeak are MEASURED.',
  'export const PACK_MANIFEST = [',
  lines.join(',\n'),
  '];',
  ''
].join('\n'));

// ---- report -------------------------------------------------------------------------
const pad = (v, n) => String(v).padStart(n);
if (report.length <= 80) {
  console.log('id'.padEnd(24), 'ch', '  dur ms', '  target', ' at 70%', '   dTP', ' note');
  for (const r of report) {
    console.log(r.id.padEnd(24), pad(r.channels, 2), pad((r.duration * 1000).toFixed(0), 8), pad(r.target.toFixed(1), 8),
      pad(r.atDefault.toFixed(1), 7), pad(r.truePeak.toFixed(1), 6), r.limited ? ' peak-limited' : '');
  }
}
const limited = report.filter((r) => r.limited).map((r) => r.id);
console.log(`\nrendered ${report.length} | manifest ${lines.length} sounds${missing.length ? ` | NOT YET RENDERED: ${missing.length} (${missing.join(", ")})` : ''}` +
  (limited.length ? `\npeak-limited (quieter than target to keep -1 dBTP): ${limited.join(', ')}` : ''));
