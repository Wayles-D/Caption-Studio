/**
 * EdgeTAM — a VIDEO segmenter — run in Node on a real video file, so its
 * quality can be scored against the same ground truth the current pipeline is
 * scored against (backend/measure_occlusion_gap.js).
 *
 * WHY THIS EXISTS. The shipped pipeline segments with MobileSAM, which is a
 * STILL-IMAGE model: it has no memory, so every keyframe has to be told where
 * the object is by a separate box tracker, and the frames between keyframes
 * are a morph of two snapshots. Measured against the true pixels, that caps
 * the mask at ~0.88 IoU for a subject who crosses another (11.3% of the mask
 * lands on the wrong person) and ~0.95 for one in clear view — and the error
 * is flat with distance from a keyframe, so denser sampling does not fix it.
 *
 * EdgeTAM carries a MEMORY of the object from frame to frame. It is prompted
 * ONCE, with a box, and then every later frame is decoded with no prompt at
 * all: the memory says where the object is. That removes the box tracker (and
 * its 0.88 ceiling), the keyframe grid, and the morph between keyframes.
 *
 * The graphs are the browser export at public/models/edgetam (Apache-2.0, from
 * 6l3m/kairos-person-track, itself from jax-image-tools/edgetam-video-onnx).
 * Their interface is not documented anywhere, so it was read off the files and
 * confirmed by running them; the awkward parts are noted at each call below.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import * as ort from 'onnxruntime-web';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(root, 'public', 'models', 'edgetam');

/** The encoder's input square. Everything is resized to this, aspect ignored (as SAM 2 does). */
export const INPUT = 1024;
/** Each frame contributes this many memory tokens (EdgeTAM compresses 4096 -> 512; that is its trick). */
const TOKENS_PER_FRAME = 512;
/** An object pointer is 256 wide and enters the bank as four 64-wide tokens. */
const POINTER_TOKENS = 4;
/** The bank keeps the prompted frame plus this many recent ones (bank_params' temporal encoding has 7 slots). */
const MAX_RECENT = 6;
/** ImageNet normalization, which SAM 2 and EdgeTAM both expect. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * How old each memory is, as the model's own encoding of it (bank_params'
 * memory_temporal_positional_encoding, 7 slots). Added to a memory's position
 * encoding so the model can tell a memory from one frame ago apart from one
 * from six frames ago. Without it every memory looks equally recent, and the
 * object can be swapped for another that merely looks similar.
 */
let bankParams = null;
function temporalEncoding(ageSlot) {
  if (!bankParams) {
    bankParams = JSON.parse(fs.readFileSync(path.join(MODELS, 'bank_params.json'), 'utf8'));
  }
  const tpe = bankParams.memory_temporal_positional_encoding;
  const slots = tpe.shape[0];
  const width = tpe.shape[tpe.shape.length - 1];
  const i = Math.min(slots - 1, Math.max(0, ageSlot));
  return { data: tpe.data.slice(i * width, (i + 1) * width), width };
}

/** Adds a 64-wide temporal encoding to every token of a memory's position encoding. */
function withTemporal(pos, ageSlot) {
  const { data, width } = temporalEncoding(ageSlot);
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) out[i] = pos[i] + data[i % width];
  return out;
}

let sessions = null;

export async function getTam({ threads = 4 } = {}) {
  if (!sessions) {
    ort.env.wasm.numThreads = threads;
    ort.env.logLevel = 'error';
    const open = (f) => ort.InferenceSession.create(path.join(MODELS, f + '.onnx'), { executionProviders: ['wasm'] });
    sessions = {
      encoder: await open('vision_encoder'),
      decoder: await open('mask_decoder'),
      memoryEncoder: await open('memory_encoder'),
      memoryAttention: await open('memory_attention')
    };
  }
  return sessions;
}

const tensor = (data, dims, type = 'float32') => new ort.Tensor(type, data, dims);

/**
 * A CONTIGUOUS RUN of frames, decoded in one pass.
 *
 * Seeking per frame (-ss before -i) aliases on this fixture's 15fps timebase:
 * every third request came back one frame out, which scores ~0.58 against the
 * truth instead of ~0.94 and looks exactly like a bad mask. Decoding forward
 * from one seek removes the question.
 */
export function grabFrames(file, startTime, count, fps) {
  return new Promise((resolve, reject) => {
    const vf = `scale=${INPUT}:${INPUT}:flags=bilinear`;
    const p = spawn(ffmpegPath, ['-v', 'error', '-ss', Math.max(0, startTime - 0.5 / fps).toFixed(4), '-i', file,
      '-frames:v', String(count), '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => {
      const raw = Buffer.concat(chunks);
      const bytes = INPUT * INPUT * 3;
      if (raw.length < bytes) return reject(new Error('no frames decoded'));
      const plane = INPUT * INPUT;
      const frames = [];
      for (let f = 0; f * bytes + bytes <= raw.length && f < count; f++) {
        const at = f * bytes;
        const out = new Float32Array(3 * plane);
        for (let i = 0; i < plane; i++) {
          for (let c = 0; c < 3; c++) out[c * plane + i] = (raw[at + i * 3 + c] / 255 - MEAN[c]) / STD[c];
        }
        frames.push(out);
      }
      resolve(frames);
    });
  });
}

/** One whole frame at `time`, as the encoder wants it: 1024x1024, RGB, ImageNet-normalized, CHW. */
export function grabFrame(file, time) {
  return new Promise((resolve, reject) => {
    const vf = `scale=${INPUT}:${INPUT}:flags=bilinear`;
    const p = spawn(ffmpegPath, ['-v', 'error', '-ss', Math.max(0, time).toFixed(3), '-i', file,
      '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => {
      const raw = Buffer.concat(chunks);
      if (raw.length < INPUT * INPUT * 3) return reject(new Error(`short frame at ${time}s`));
      const out = new Float32Array(3 * INPUT * INPUT);
      const plane = INPUT * INPUT;
      for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) out[c * plane + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c];
      }
      resolve(out);
    });
  });
}

/** [1,C,H,W] -> [H*W,1,C]: the sequence layout memory_attention reads. */
function toSequence(t) {
  const [, C, H, W] = t.dims;
  const hw = H * W;
  const src = t.data;
  const dst = new Float32Array(hw * C);
  for (let c = 0; c < C; c++) for (let i = 0; i < hw; i++) dst[i * C + c] = src[c * hw + i];
  return tensor(dst, [hw, 1, C]);
}

/** [1,1,H*W,C] -> [1,C,H,W]: conditioned features, back in the shape the decoder wants. */
function toFeatureMap(t, C, H, W) {
  const hw = H * W;
  const src = t.data;
  const dst = new Float32Array(C * hw);
  for (let i = 0; i < hw; i++) for (let c = 0; c < C; c++) dst[c * hw + i] = src[i * C + c];
  return tensor(dst, [1, C, H, W]);
}

/** Concatenates tokens-first tensors along their token axis. */
function concatTokens(list, width) {
  const total = list.reduce((n, t) => n + t.length / width, 0);
  const out = new Float32Array(total * width);
  let at = 0;
  for (const t of list) { out.set(t, at); at += t.length; }
  return tensor(out, [total, 1, width]);
}

/**
 * Tracks ONE object through a video: prompted once with a box, then carried by
 * its own memory.
 *
 * The bank holds the prompted frame's memory permanently (it is the only frame
 * anyone vouched for) plus the most recent few, which is what lets the object
 * be re-found after something passes in front of it.
 */
export class TamTracker {
  constructor(s) {
    this.s = s;
    this.promptMemory = null;   // {tokens, pos} — the frame the user chose
    this.promptPointer = null;
    this.recent = [];           // [{tokens, pos}] most recent first
    this.pointers = [];         // object pointers, most recent first
  }

  async encode(pixels) {
    return this.s.encoder.run({ pixel_values: tensor(pixels, [1, 3, INPUT, INPUT]) });
  }

  /** Conditions this frame's features on everything remembered so far. */
  async condition(feats) {
    const banks = [this.promptMemory, ...this.recent].filter(Boolean);
    if (!banks.length) return feats.feats2;
    const cond = await this.s.memoryAttention.run({
      current_vision_features: toSequence(feats.feats2),
      current_vision_position_embeddings: toSequence(feats.pos2),
      spatial_memory: concatTokens(banks.map((b) => b.tokens), 64),
      // Slot 0 is the frame the user prompted — the one frame anyone vouched
      // for, and never forgotten. Slots 1.. are the recent frames by age.
      spatial_memory_position_embeddings: concatTokens(
        banks.map((b, i) => withTemporal(b.pos, i)), 64),
      pointer_memory: concatTokens(this.pointers, 64),
      // The pointers' own positions are supplied by the temporal encoding in
      // bank_params; zero here keeps them unordered, which is what the export
      // does when no pointer position is given.
      pointer_memory_position_embeddings: tensor(
        new Float32Array(this.pointers.length * POINTER_TOKENS * 64 / POINTER_TOKENS * POINTER_TOKENS),
        [this.pointers.length * POINTER_TOKENS, 1, 64])
    });
    const [, C, H, W] = feats.feats2.dims;
    return toFeatureMap(cond.conditioned_features, C, H, W);
  }

  async remember(feats, highResMask, fromPrompt) {
    const mem = await this.s.memoryEncoder.run({
      vision_features: feats.feats2,
      pred_masks_high_res: highResMask,
      is_mask_from_pts: tensor(Uint8Array.from([fromPrompt ? 1 : 0]), [1], 'bool')
    });
    // memory_tokens arrive [1, tokens, 64]; the bank is tokens-first.
    const entry = { tokens: mem.memory_tokens.data, pos: mem.memory_pos_enc.data };
    if (fromPrompt) this.promptMemory = entry;
    else {
      this.recent.unshift(entry);
      if (this.recent.length > MAX_RECENT) this.recent.pop();
    }
  }

  /**
   * The FIRST frame: here is the object, inside this box.
   * `box` is normalized {x, y, width, height} over the whole frame.
   */
  async prompt(pixels, box) {
    const feats = await this.encode(pixels);
    const x0 = box.x * INPUT; const y0 = box.y * INPUT;
    const x1 = (box.x + box.width) * INPUT; const y1 = (box.y + box.height) * INPUT;
    const out = await this.s.decoder.run({
      feats0: feats.feats0, feats1: feats.feats1, feats2: feats.feats2,
      // Labels 2 and 3 are a BOX's two corners. A single positive click tends
      // to take only part of a person (a shirt, a badge); the box takes all.
      input_points: tensor(Float32Array.from([x0, y0, x1, y1]), [1, 1, 2, 2]),
      input_labels: tensor(Int32Array.from([2, 3]), [1, 1, 2], 'int32')
    });
    this.pointers = [out.object_pointer.data];
    await this.remember(feats, out.high_res_masks, true);
    return out;
  }

  /** Every frame after: no prompt at all — the memory says where the object is. */
  async track(pixels) {
    const feats = await this.encode(pixels);
    const conditioned = await this.condition(feats);
    const out = await this.s.decoder.run({
      feats0: feats.feats0, feats1: feats.feats1, feats2: conditioned,
      // No points: an empty prompt, which is the whole point of propagation.
      input_points: tensor(new Float32Array(0), [1, 1, 0, 2]),
      input_labels: tensor(new Int32Array(0), [1, 1, 0], 'int32')
    });
    this.pointers.unshift(out.object_pointer.data);
    if (this.pointers.length > 16) this.pointers.pop();
    await this.remember(feats, out.high_res_masks, false);
    return out;
  }
}
