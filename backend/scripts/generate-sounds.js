/**
 * Generates the bundled sound-effect assets in `public/sounds/` using nothing
 * but the FFmpeg binary this project already depends on (ffmpeg-static).
 *
 * WHY SYNTHESIZE rather than commit binaries or fetch a pack: a fresh clone is
 * immediately functional with no network, no licensing question, and no
 * multi-megabyte blobs in git history — and the whole sound set stays
 * reproducible. These are deliberately plain, synthetic placeholders; the
 * registry (shared/soundRegistry.js) is what the app actually talks to, so
 * dropping a real recording in over any of these files (same name) upgrades
 * the sound with zero code changes.
 *
 * Mirrors backend/scripts/download-fonts.js's role for fonts: a dev/setup
 * convenience, never a runtime path.
 *
 *   node backend/scripts/generate-sounds.js
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import { SOUND_REGISTRY } from '../../shared/soundRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOUNDS_DIR = path.join(__dirname, '../../public/sounds');

const SAMPLE_RATE = 48000;

/**
 * One synthesis recipe per registry ID. Each is a complete FFmpeg input spec
 * plus an optional post-filter chain.
 *
 * `aevalsrc` expressions are written so the waveform already decays to
 * silence within its own duration — no click at the tail, no separate fade
 * stage needed for the percussive ones.
 */
const RECIPES = {
  // Short, bright, dry — the list-beat workhorse.
  tick: {
    input: `aevalsrc=0.75*exp(-t*95)*sin(2*PI*1850*t):d=0.07:s=${SAMPLE_RATE}`,
    filters: 'highpass=f=400'
  },
  // Pitch drops fast as it decays — reads as something appearing.
  pop: {
    input: `aevalsrc=0.8*exp(-t*26)*sin(2*PI*(400+950*exp(-t*20))*t):d=0.18:s=${SAMPLE_RATE}`,
    filters: 'highpass=f=150'
  },
  // Filtered noise transient — a mechanical UI click rather than a tone.
  click: {
    input: `aevalsrc=0.5*exp(-t*220)*(random(0)*2-1):d=0.045:s=${SAMPLE_RATE}`,
    filters: 'highpass=f=900,lowpass=f=7000'
  },
  // Two-note rising chime.
  notification: {
    input: `aevalsrc=0.45*exp(-mod(t\\,0.18)*20)*sin(2*PI*(880+(440*gt(t\\,0.18)))*t):d=0.5:s=${SAMPLE_RATE}`,
    filters: 'highpass=f=250'
  },
  // Band-limited pink noise swelling in and out — a transition sweep.
  whoosh: {
    input: `anoisesrc=d=0.55:c=pink:a=0.55:r=${SAMPLE_RATE}`,
    filters: 'highpass=f=280,lowpass=f=3800,afade=t=in:st=0:d=0.28:curve=exp,afade=t=out:st=0.27:d=0.28:curve=exp'
  },
  // The same idea, shorter and brighter — a flick rather than a sweep.
  swipe: {
    input: `anoisesrc=d=0.3:c=white:a=0.4:r=${SAMPLE_RATE}`,
    filters: 'highpass=f=900,lowpass=f=7000,afade=t=in:st=0:d=0.12:curve=exp,afade=t=out:st=0.12:d=0.18:curve=exp'
  },
  // Low body with a fast pitch drop — weight, for a key statement.
  hit: {
    input: `aevalsrc=0.9*exp(-t*17)*sin(2*PI*(58+190*exp(-t*38))*t):d=0.35:s=${SAMPLE_RATE}`,
    filters: 'lowpass=f=2200'
  }
};

function renderSound(soundId, outputPath) {
  return new Promise((resolve, reject) => {
    const recipe = RECIPES[soundId];
    if (!recipe) return reject(new Error(`No synthesis recipe for sound id "${soundId}".`));

    const args = ['-y', '-f', 'lavfi', '-i', recipe.input];
    if (recipe.filters) args.push('-af', recipe.filters);
    // Mono at a modest bitrate: these are tiny percussive assets, and the mix
    // stage upconverts to the project's stereo layout anyway (see
    // backend/utils/audioMixFilter.js), so stereo here would only double the
    // file size for no audible gain.
    args.push('-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'libmp3lame', '-b:a', '128k', outputPath);

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`FFmpeg failed for "${soundId}" (exit ${code}):\n${stderr.slice(-800)}`));
    });
  });
}

async function main() {
  if (!ffmpegPath) throw new Error('FFmpeg static binary path could not be resolved.');
  fs.mkdirSync(SOUNDS_DIR, { recursive: true });

  // FILL IN WHAT'S MISSING — never clobber what's already there.
  //
  // This script exists so a fresh clone has a working sound set offline, not
  // to be the authority on what those files contain. Several registry entries
  // are now REAL RECORDINGS dropped in over (or alongside) the synthetic
  // placeholders, exactly as this file's own header invites. Unconditionally
  // re-rendering every ID would silently destroy them — running `npm run
  // sounds` once would swap a real mouse click back for a synthesized blip
  // with no warning and nothing in git to notice it by.
  //
  // An ID with no recipe is likewise not an error: it means that sound only
  // ever existed as a real recording, so there is nothing to synthesize.
  // Without this it would abort the whole run ("No synthesis recipe for...").
  //
  // `--force` re-renders the ones that DO have recipes, for deliberately
  // regenerating the placeholder set.
  const force = process.argv.includes('--force');
  const ids = Object.keys(SOUND_REGISTRY);
  console.log(`[Sounds] ${force ? 'Regenerating' : 'Filling in missing'} sound effect(s) in ${SOUNDS_DIR}`);

  let written = 0;
  let kept = 0;
  for (const id of ids) {
    const file = SOUND_REGISTRY[id].file;
    const outputPath = path.join(SOUNDS_DIR, file);
    const exists = fs.existsSync(outputPath);

    if (!RECIPES[id]) {
      console.log(`[Sounds]   ${file.padEnd(20)} ${exists ? 'kept (real recording, nothing to synthesize)' : 'MISSING — supply this file, it has no synthesis recipe'}`);
      exists ? kept++ : (process.exitCode = 1);
      continue;
    }
    if (exists && !force) {
      console.log(`[Sounds]   ${file.padEnd(20)} kept (already present — pass --force to re-render)`);
      kept++;
      continue;
    }

    await renderSound(id, outputPath);
    written++;
    const size = fs.statSync(outputPath).size;
    console.log(`[Sounds]   ${file.padEnd(20)} ${(size / 1024).toFixed(1)} KB`);
  }

  console.log(`[Sounds] Done. ${written} generated, ${kept} left untouched.`);
  console.log('[Sounds] Drop a real recording in over any file (same name) to upgrade it — it will not be overwritten.');
}

main().catch((err) => {
  console.error(`[Sounds] ${err.message}`);
  process.exit(1);
});
