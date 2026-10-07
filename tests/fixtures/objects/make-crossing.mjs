/**
 * Builds the tracking and segmentation fixtures — REAL people (cut from a
 * real street video, see README.md) walking known paths, so object tracking
 * and segmentation can be checked against ground truth no ordinary footage
 * provides.
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
 * segment.mp4 (4.5s) — SEGMENTATION ground truth: two people cut out with
 *   their real silhouettes (soft-edged alpha — person-olive.png,
 *   person-shirt.png) on a real street (street-bg.jpg). OLIVE walks right;
 *   SHIRT walks left and passes IN FRONT of him (~1.6-2.4s); OLIVE passes
 *   behind a pillar (~2.4-3.1s) and leaves the frame at the right (~3.8-4.1s).
 *   `visibleMask(name, t, 'segment')` renders exactly the pixels of that
 *   person that are visible at t — what a perfect segmentation would give.
 *
 * custom.mp4 (4s) — MANUAL SELECTION: a patterned square BADGE (no object class the
 *   detector knows) drifts right and down and grows ~40%, on a real street
 *   while the camera pans; a DECOY badge in other colours stands still at the
 *   top right; OLIVE walks left to right below it. `truth('badge', t, 'custom')`.
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
export const PILLAR = { x: 468, width: 36 };
export const WALL = { x: 330, width: 200 };

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');

const PEOPLE = {
  white: { file: 'person-white.png', size: [63, 188] },
  green: { file: 'person-green.png', size: [116, 486] },
  olive: { file: 'person-olive.png', size: [148, 460] },
  shirt: { file: 'person-shirt.png', size: [272, 460] }
};

/**
 * Who is in each scene: their look, start x (px), speed (px/s); drawn in
 * this order (later = in front). An occluder (pillar, wall) stands in front
 * of the person named in its `before`.
 */
export const SCENES = {
  crossing: {
    seconds: 4,
    people: { white: { look: 'white', from: 40, speed: 170 }, green: { look: 'green', from: 560, speed: -125 } },
    occluders: [{ ...PILLAR, before: 'white' }]
  },
  lookalike: {
    seconds: 4,
    people: { white: { look: 'white', from: 40, speed: 170 }, twin: { look: 'white', mirror: true, from: 560, speed: -125 } }
  },
  reentry: {
    seconds: 4.5,
    people: { green: { look: 'green', from: 20, speed: 13 }, white: { look: 'white', from: 200, speed: 110 } },
    occluders: [{ ...WALL, before: 'white' }]
  },
  segment: {
    seconds: 4.5,
    height: 230,
    top: 112,
    background: 'street-bg.jpg',
    people: { olive: { look: 'olive', from: 30, speed: 150 }, shirt: { look: 'shirt', from: 520, speed: -110 } },
    occluders: [{ x: 470, width: 30, before: 'olive' }]
  },
  custom: {
    seconds: 4,
    height: 200,
    top: 150,
    background: 'street-bg.jpg',
    // The camera pans: the street slides left 25px a second.
    pan: 25,
    people: { olive: { look: 'olive', from: 20, speed: 120 } },
    badges: {
      badge: { x: 70, y: 50, vx: 95, vy: 22, size: 60, grow: 0.1, colors: ['#e8452c', '#f5c518', '#1d5fd1'] },
      decoy: { x: 520, y: 30, vx: 0, vy: 0, size: 60, grow: 0, colors: ['#2bb673', '#f2f2f2', '#7a2bd1'] }
    }
  }
};

export function truth(name, t, scene = 'crossing') {
  const spec = SCENES[scene];
  const badge = spec.badges?.[name];
  if (badge) {
    const size = badge.size * (1 + badge.grow * t);
    const cx = badge.x + badge.size / 2 + badge.vx * t;
    const cy = badge.y + badge.size / 2 + badge.vy * t;
    return { x: (cx - size / 2) / W, y: (cy - size / 2) / H, width: size / W, height: size / H };
  }
  const p = spec.people[name];
  const s = PEOPLE[p.look];
  const height = spec.height || 190;
  const w = (s.size[0] * height) / s.size[1];
  const x = p.from + p.speed * t;
  return { x: x / W, y: (spec.top ?? 150) / H, width: w / W, height: height / H };
}

let canvasLib = null;
const images = new Map();
async function lib() {
  if (!canvasLib) canvasLib = await import(pathToFileURL(path.join(root, 'backend', 'node_modules', '@napi-rs', 'canvas', 'index.js')).href);
  return canvasLib;
}
async function image(file) {
  if (!images.has(file)) images.set(file, await (await lib()).loadImage(path.join(here, file)));
  return images.get(file);
}

function drawPerson(ctx, img, b, mirror) {
  const [x, y, w, h] = [b.x * W, b.y * H, b.width * W, b.height * H];
  if (mirror) {
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
}

/** One frame of a scene: the background, then each person — each followed by whatever stands in front of them. */
async function drawScene(ctx, scene, t) {
  const spec = SCENES[scene];
  if (spec.background && spec.pan) {
    ctx.drawImage(await image(spec.background), -spec.pan * t, -40, W * 1.25, H * 1.25);
  } else if (spec.background) {
    ctx.drawImage(await image(spec.background), 0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3b3a38');
    g.addColorStop(1, '#1d1c1b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  for (const [name, p] of Object.entries(spec.people)) {
    drawPerson(ctx, await image(PEOPLE[p.look].file), truth(name, t, scene), p.mirror);
    (spec.occluders || []).filter((o) => o.before === name).forEach((o) => {
      ctx.fillStyle = '#6f6d69';
      ctx.fillRect(o.x, 0, o.width, H);
    });
  }
  for (const [name, b] of Object.entries(spec.badges || {})) drawBadge(ctx, truth(name, t, scene), b.colors);
}

/**
 * A square plaque: a frame, stripes, a star — a pattern, and nothing the
 * detector has a class for. (A ROUND badge was taken for a sports ball.)
 */
function drawBadge(ctx, box, [a, b, c]) {
  const x = box.x * W;
  const y = box.y * H;
  const s = box.width * W;
  ctx.save();
  ctx.fillStyle = a;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = b;
  ctx.fillRect(x + s * 0.1, y + s * 0.1, s * 0.8, s * 0.8);
  ctx.fillStyle = a;
  for (let i = 0; i < 3; i++) ctx.fillRect(x + s * 0.1, y + s * (0.18 + i * 0.12), s * 0.8, s * 0.05);
  ctx.fillStyle = c;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? s * 0.11 : s * 0.25;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx[i ? 'lineTo' : 'moveTo'](x + s * 0.5 + rr * Math.cos(ang), y + s * 0.66 + rr * Math.sin(ang));
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

/**
 * The pixels of `name` VISIBLE at `t` — its own alpha, less whatever is drawn
 * over it (an occluder in front of it, anyone drawn after it) — as 0-255 per
 * pixel of the W×H frame. The ground truth a segmentation is scored against.
 */
export async function visibleMask(name, t, scene = 'segment') {
  const { createCanvas } = await lib();
  const spec = SCENES[scene];
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  const names = Object.keys(spec.people);
  const me = spec.people[name];
  drawPerson(ctx, await image(PEOPLE[me.look].file), truth(name, t, scene), me.mirror);
  ctx.globalCompositeOperation = 'destination-out';
  (spec.occluders || []).filter((o) => o.before === name).forEach((o) => { ctx.fillStyle = '#000'; ctx.fillRect(o.x, 0, o.width, H); });
  for (const other of names.slice(names.indexOf(name) + 1)) {
    const p = spec.people[other];
    drawPerson(ctx, await image(PEOPLE[p.look].file), truth(other, t, scene), p.mirror);
    (spec.occluders || []).filter((o) => o.before === other).forEach((o) => { ctx.fillStyle = '#000'; ctx.fillRect(o.x, 0, o.width, H); });
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

async function build(scene) {
  const spec = SCENES[scene];
  const { createCanvas } = await lib();
  const ffmpegPath = (await import(pathToFileURL(path.join(root, 'backend', 'node_modules', 'ffmpeg-static', 'index.js')).href)).default;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bhynd-${scene}-`));
  const frames = Math.round(spec.seconds * FPS);
  for (let i = 0; i < frames; i++) {
    await drawScene(ctx, scene, i / FPS);
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
