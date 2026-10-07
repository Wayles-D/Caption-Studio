/**
 * Builds the tracking fixtures — REAL people (cut from a real street video,
 * see README.md) walking known paths over a plain backdrop, so object
 * tracking can be checked against ground truth no ordinary footage provides.
 *
 * crossing.mp4 (4s)
 *   0.0s  WHITE (white shirt) at the left, GREEN (green shirt) at the right
 *   ~1.8s they cross — GREEN passes IN FRONT, hiding WHITE (same-class occlusion)
 *   ~2.7s WHITE passes behind a grey pillar (partial occlusion by a non-person)
 *   ~3.6s WHITE walks out of the frame at the right; GREEN is still in it
 *
 * lookalike.mp4 (4s) — the same crossing, but the other person is WHITE's
 *   mirror image ("TWIN"): identical colours, so appearance cannot tell them
 *   apart and only motion can. TWIN passes in front.
 *
 * reentry.mp4 (4.5s)
 *   WHITE walks right behind a wide wall — wholly hidden ~1.2-2.4s, longer
 *   than the tracker coasts — comes out the other side, and leaves the frame
 *   at the right (~3.7s). GREEN stands about on the left the whole time, a
 *   person who is NOT him.
 *
 * Exported `truth(name, t, scene)` gives each person's box (0-1 of the frame)
 * at any time — the same function the frames were drawn with.
 *
 * Run from the repo root:  node tests/fixtures/objects/make-crossing.mjs [scene ...]
 * (no scene: all of them)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

export const W = 640;
export const H = 360;
export const FPS = 15;
export const SECONDS = 4;
const HEIGHT = 190;
const TOP = 150;
export const PILLAR = { x: 468, width: 36 };
export const WALL = { x: 330, width: 200 };

const PEOPLE = {
  white: { file: 'person-white.png', size: [63, 188] },
  green: { file: 'person-green.png', size: [116, 486] }
};

/** Who is in each scene: their look, start x (px), speed (px/s); drawn in this order (later = in front). */
export const SCENES = {
  crossing: {
    seconds: 4,
    people: { white: { look: 'white', from: 40, speed: 170 }, green: { look: 'green', from: 560, speed: -125 } },
    pillar: PILLAR
  },
  lookalike: {
    seconds: 4,
    people: { white: { look: 'white', from: 40, speed: 170 }, twin: { look: 'white', mirror: true, from: 560, speed: -125 } }
  },
  reentry: {
    seconds: 4.5,
    people: { green: { look: 'green', from: 20, speed: 13 }, white: { look: 'white', from: 200, speed: 110 } },
    wall: WALL
  }
};

export function truth(name, t, scene = 'crossing') {
  const p = SCENES[scene].people[name];
  const s = PEOPLE[p.look];
  const w = (s.size[0] * HEIGHT) / s.size[1];
  const x = p.from + p.speed * t;
  return { x: x / W, y: TOP / H, width: w / W, height: HEIGHT / H };
}

async function build(scene) {
  const spec = SCENES[scene];
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..', '..');
  const { createCanvas, loadImage } = await import(pathToFileURL(path.join(root, 'backend', 'node_modules', '@napi-rs', 'canvas', 'index.js')).href);
  const ffmpegPath = (await import(pathToFileURL(path.join(root, 'backend', 'node_modules', 'ffmpeg-static', 'index.js')).href)).default;
  const imgs = { white: await loadImage(path.join(here, PEOPLE.white.file)), green: await loadImage(path.join(here, PEOPLE.green.file)) };
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bhynd-${scene}-`));
  const frames = Math.round(spec.seconds * FPS);
  for (let i = 0; i < frames; i++) {
    const t = i / FPS;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3b3a38');
    g.addColorStop(1, '#1d1c1b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const [name, p] of Object.entries(spec.people)) {
      const b = truth(name, t, scene);
      const [x, y, w, h] = [b.x * W, b.y * H, b.width * W, b.height * H];
      if (p.mirror) {
        ctx.save();
        ctx.translate(x + w, y);
        ctx.scale(-1, 1);
        ctx.drawImage(imgs[p.look], 0, 0, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(imgs[p.look], x, y, w, h);
      }
      // The pillar and the wall stand in front of WHITE only.
      if (name === 'white') {
        ctx.fillStyle = '#6f6d69';
        if (spec.pillar) ctx.fillRect(spec.pillar.x, 0, spec.pillar.width, H);
        if (spec.wall) ctx.fillRect(spec.wall.x, 0, spec.wall.width, H);
      }
    }
    fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.png`), canvas.toBuffer('image/png'));
  }
  const out = path.join(here, `${scene}.mp4`);
  const r = spawnSync(ffmpegPath, ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(tmp, 'f%03d.png'), '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const scenes = process.argv.slice(2);
  for (const s of scenes.length ? scenes : Object.keys(SCENES)) await build(s);
}
