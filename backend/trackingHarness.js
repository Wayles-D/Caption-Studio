/**
 * Runs the object tracker (shared/objects/tracking.js) in Node on a real
 * video file: frames decoded by ffmpeg (rotation metadata applied, as the
 * browser does), detections by the same YOLOX model and onnxruntime-web the
 * editor's worker uses, appearance from shared/objects/appearance.js, the
 * zoomed look and the camera-motion thumbnail from shared/objects/frames.js
 * — so tests exercise the editor's exact analysis, minus the browser.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import * as ort from 'onnxruntime-web';
import { preprocess, postprocess } from '../shared/objects/yolox.js';
import { makeFrameDetections, DETECTION_MODELS, DEFAULT_MODEL_ID, STORE_MIN_CONFIDENCE } from '../shared/objects/detections.js';
import { appearanceOf } from '../shared/objects/appearance.js';
import { cropFrame, fromRegion, thumbnail } from '../shared/objects/frames.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = DETECTION_MODELS[DEFAULT_MODEL_ID];
let session = null;

export async function getSession() {
  if (!session) session = await ort.InferenceSession.create(path.join(root, 'public', 'models', model.file), { executionProviders: ['wasm'] });
  return session;
}

export function probe(file) {
  const info = spawnSync(ffmpegPath, ['-i', file], { encoding: 'utf8' }).stderr;
  const rot = /rotation of -?90/.test(info);
  const [, w0, h0] = info.match(/, (\d{2,5})x(\d{2,5})/);
  const [h, m, s] = info.match(/Duration: (\d+):(\d+):([\d.]+)/).slice(1).map(Number);
  return { width: rot ? +h0 : +w0, height: rot ? +w0 : +h0, duration: h * 3600 + m * 60 + s };
}

/** The frame at `time` as RGBA, at most `maxSide` px on its long side (960: as the editor grabs it). */
export function frameAt(file, time, info = probe(file), maxSide = 960) {
  const scale = Math.min(1, maxSide / Math.max(info.width, info.height));
  const w = Math.round((info.width * scale) / 2) * 2;
  const h = Math.round((info.height * scale) / 2) * 2;
  // A seek exactly onto the end finds no frame: stay a hair inside, as the editor's grabber does.
  const at = Math.min(Math.max(0, time), Math.max(0, info.duration - 0.1));
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout.length) throw new Error(`no frame at ${time}`);
  return { data: new Uint8ClampedArray(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length), width: w, height: h };
}

/** frameAt, without blocking: the tracker's two directions decode side by side. */
function frameAtAsync(file, time, info, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(info.width, info.height));
  const w = Math.round((info.width * scale) / 2) * 2;
  const h = Math.round((info.height * scale) / 2) * 2;
  const at = Math.min(Math.max(0, time), Math.max(0, info.duration - 0.1));
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || !buf.length) reject(new Error(`no frame at ${time}`));
      else resolve({ data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), width: w, height: h });
    });
  });
}

/** Detections on a frame (or a crop of one — boxes then 0-1 of the crop). One run at a time, as in the editor's worker. */
let runs = Promise.resolve();
function detectOn(frame) {
  const job = runs.then(() => detectNow(frame));
  runs = job.catch(() => {});
  return job;
}

async function detectNow(frame) {
  const s = await getSession();
  const { input, scale } = preprocess(frame, model.inputSize);
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, model.inputSize, model.inputSize]) });
  return postprocess(out[s.outputNames[0]].data, { size: model.inputSize, scale, frameWidth: frame.width, frameHeight: frame.height, minScore: STORE_MIN_CONFIDENCE });
}

/**
 * A frame's detections (V1.7 shape), each with its appearance fingerprint,
 * and the frame's thumbnail. With `region` (0-1 of the frame), the detector
 * looks at that region alone, zoomed — from a sharper decode, as the editor
 * crops from the video at full resolution.
 */
export async function observe(file, time, info, { region = null } = {}) {
  const frame = await frameAtAsync(file, time, info, region ? 1920 : 960);
  const raw = region ? fromRegion(await detectOn(cropFrame(frame, region)), region) : await detectOn(frame);
  const detections = makeFrameDetections(time, raw);
  return { time, frame, thumb: thumbnail(frame), candidates: detections.map((d) => ({ ...d, appearance: appearanceOf(frame, d.box) })) };
}
