/**
 * The VIDEO segmenter (EdgeTAM via onnxruntime-web), off the main thread.
 *
 * Unlike the still-image segmenter beside it (segmenterWorker.js), this one is
 * STATEFUL: it is prompted ONCE with a box and then carries the object forward
 * by its own memory, frame after frame. That memory is the whole point — it is
 * what removes the box tracker (whose 0.88 IoU capped every mask it prompted),
 * the 0.4s keyframe grid, and the morph between keyframes.
 *
 * Measured against the true pixels on segment.mp4, propagating 24 frames from
 * a single box: mean IoU 0.929 against the old pipeline's 0.884, and worst
 * spill onto the wrong person 4.4% against 11.3%.
 *
 * Cost, measured on Intel gen-9 integrated graphics through WebGPU: ~2.6s a
 * frame, of which the vision encoder is ~1.2s. So this runs over the SPAN a
 * layer actually sits behind the subject, never a whole clip.
 *
 * Protocol — a session, not a request:
 *   {id, op:'prompt', models, pixels, box, grid, margin} -> the first mask
 *   {id, op:'track',  pixels, grid, margin}              -> the next mask
 *   {id, op:'reset'}                                     -> forget everything
 * Each reply carries a compact box-relative alpha grid rather than the raw
 * 1024x1024 logits: a megabyte and a half a frame of transfer saved, and it is
 * already the shape shared/objects/segmentation.js stores.
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

/** The encoder's input square. Everything is resized to this, aspect ignored (as SAM 2 does). */
const INPUT = 1024;
/** An object pointer is 256 wide and enters the bank as four 64-wide tokens. */
const POINTER_TOKENS = 4;
/** The bank keeps the prompted frame plus this many recent ones. */
const MAX_RECENT = 6;
/** How many object pointers the bank holds. */
const MAX_POINTERS = 16;

let sessions = null;
let backend = null;
let gpuNote = null;
let bankParams = null;

const T = (data, dims, type = 'float32') => new ort.Tensor(type, data, dims);

async function load(models) {
  if (sessions) return sessions;
  const open = (url, providers) => ort.InferenceSession.create(url, { executionProviders: providers });
  const all = async (providers) => ({
    encoder: await open(models.encoder, providers),
    decoder: await open(models.decoder, providers),
    memoryEncoder: await open(models.memoryEncoder, providers),
    memoryAttention: await open(models.memoryAttention, providers)
  });
  if (self.navigator?.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        sessions = await all(['webgpu']);
        backend = 'gpu';
      } else {
        gpuNote = 'no GPU adapter';
      }
    } catch (err) {
      gpuNote = err?.message || String(err);
    }
  } else {
    gpuNote = 'WebGPU is not available in this browser';
  }
  if (!sessions) {
    // The CPU can run this, but at several seconds a frame it is a last resort.
    sessions = await all(['wasm']);
    backend = 'cpu';
  }
  bankParams = await fetch(models.bankParams).then((r) => r.json());
  return sessions;
}

/** [1,C,H,W] -> [H*W,1,C]: the sequence layout memory_attention reads. */
function toSequence(t) {
  const [, C, H, W] = t.dims;
  const hw = H * W;
  const src = t.data;
  const dst = new Float32Array(hw * C);
  for (let c = 0; c < C; c++) for (let i = 0; i < hw; i++) dst[i * C + c] = src[c * hw + i];
  return T(dst, [hw, 1, C]);
}

/** [1,1,H*W,C] -> [1,C,H,W]: conditioned features, in the shape the decoder wants. */
function toFeatureMap(t, C, H, W) {
  const hw = H * W;
  const src = t.data;
  const dst = new Float32Array(C * hw);
  for (let i = 0; i < hw; i++) for (let c = 0; c < C; c++) dst[c * hw + i] = src[i * C + c];
  return T(dst, [1, C, H, W]);
}

function concatTokens(list, width) {
  const total = list.reduce((n, t) => n + t.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const t of list) { out.set(t, at); at += t.length; }
  return T(out, [total / width, 1, width]);
}

/**
 * How OLD a memory is, in the model's own encoding (bank_params' 7 slots).
 * Without it every memory reads as equally recent, and the object can be
 * swapped for another that merely looks similar — measured: the mask jumped to
 * the wrong person with 44% spill on the frame a crossing began.
 */
function withTemporal(pos, ageSlot) {
  const tpe = bankParams.memory_temporal_positional_encoding;
  const slots = tpe.shape[0];
  const width = tpe.shape[tpe.shape.length - 1];
  const i = Math.min(slots - 1, Math.max(0, ageSlot));
  const out = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k++) out[k] = pos[k] + tpe.data[i * width + (k % width)];
  return out;
}

/** The session's memory. Cleared by 'reset', and whenever a new object is prompted. */
let promptMemory = null;
let recent = [];
let pointers = [];

/**
 * The tight box around a mask, in normalized FRAME coordinates — the object's
 * own account of where it is, which is what replaces the tracker.
 */
function maskBoundsOf(logits, size) {
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (logits[y * size + x] <= 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    x: minX / size,
    y: minY / size,
    width: Math.max(1e-6, (maxX + 1 - minX) / size),
    height: Math.max(1e-6, (maxY + 1 - minY) / size)
  };
}

/**
 * Resamples the full-frame logits into the box-relative alpha grid the editor
 * stores: the mask's own box widened by `margin` each side, on a grid of
 * `gw` x `gh` cells. Soft at the edge (a logit either side of zero), which is
 * what keeps a cut-out from looking stepped.
 */
function toGrid(logits, size, box, margin, gw, gh) {
  const fx = box.x - margin * box.width;
  const fy = box.y - margin * box.height;
  const fw = box.width * (1 + 2 * margin);
  const fh = box.height * (1 + 2 * margin);
  const alpha = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const sy = Math.round((fy + ((y + 0.5) / gh) * fh) * size);
    if (sy < 0 || sy >= size) continue;
    for (let x = 0; x < gw; x++) {
      const sx = Math.round((fx + ((x + 0.5) / gw) * fw) * size);
      if (sx < 0 || sx >= size) continue;
      // A logit of 0 is the boundary; +-2 is comfortably inside/outside.
      const v = logits[sy * size + sx];
      alpha[y * gw + x] = v >= 2 ? 255 : v <= -2 ? 0 : Math.round(((v + 2) / 4) * 255);
    }
  }
  return alpha;
}

async function remember(s, feats, highResMask, fromPrompt) {
  const mem = await s.memoryEncoder.run({
    vision_features: feats.feats2,
    pred_masks_high_res: highResMask,
    is_mask_from_pts: T(Uint8Array.from([fromPrompt ? 1 : 0]), [1], 'bool')
  });
  const entry = { tokens: new Float32Array(mem.memory_tokens.data), pos: new Float32Array(mem.memory_pos_enc.data) };
  if (fromPrompt) promptMemory = entry;
  else {
    recent.unshift(entry);
    if (recent.length > MAX_RECENT) recent.pop();
  }
}

async function condition(s, feats) {
  // Slot 0 is the prompted frame — the only one anyone vouched for, never
  // forgotten. Slots 1.. are the recent frames, by age.
  const banks = [promptMemory, ...recent].filter(Boolean);
  if (!banks.length) return feats.feats2;
  const cond = await s.memoryAttention.run({
    current_vision_features: toSequence(feats.feats2),
    current_vision_position_embeddings: toSequence(feats.pos2),
    spatial_memory: concatTokens(banks.map((b) => b.tokens), 64),
    spatial_memory_position_embeddings: concatTokens(banks.map((b, i) => withTemporal(b.pos, i)), 64),
    pointer_memory: concatTokens(pointers, 64),
    pointer_memory_position_embeddings: T(
      new Float32Array(pointers.length * POINTER_TOKENS * 64),
      [pointers.length * POINTER_TOKENS, 1, 64])
  });
  const [, C, H, W] = feats.feats2.dims;
  return toFeatureMap(cond.conditioned_features, C, H, W);
}

self.onmessage = async (e) => {
  const { id, op, models, pixels, box, margin = 0.2, gridWidth = 256, gridHeight = 144 } = e.data || {};
  try {
    if (op === 'reset') {
      promptMemory = null; recent = []; pointers = [];
      self.postMessage({ id, ok: true });
      return;
    }
    const s = await load(models);
    const t0 = performance.now();
    const feats = await s.encoder.run({ pixel_values: T(pixels, [1, 3, INPUT, INPUT]) });

    let out;
    if (op === 'prompt') {
      promptMemory = null; recent = []; pointers = [];
      const x0 = box.x * INPUT, y0 = box.y * INPUT;
      const x1 = (box.x + box.width) * INPUT, y1 = (box.y + box.height) * INPUT;
      out = await s.decoder.run({
        feats0: feats.feats0, feats1: feats.feats1, feats2: feats.feats2,
        // Labels 2 and 3 are a BOX's corners. A single positive click tends to
        // take only part of a person (a shirt, a badge); a box takes all of them.
        input_points: T(Float32Array.from([x0, y0, x1, y1]), [1, 1, 2, 2]),
        input_labels: T(Int32Array.from([2, 3]), [1, 1, 2], 'int32')
      });
    } else {
      const conditioned = await condition(s, feats);
      out = await s.decoder.run({
        feats0: feats.feats0, feats1: feats.feats1, feats2: conditioned,
        // No prompt at all: the memory is what says where the object is.
        input_points: T(new Float32Array(0), [1, 1, 0, 2]),
        input_labels: T(new Int32Array(0), [1, 1, 0], 'int32')
      });
    }

    pointers.unshift(new Float32Array(out.object_pointer.data));
    if (pointers.length > MAX_POINTERS) pointers.pop();
    await remember(s, feats, out.high_res_masks, op === 'prompt');

    const logits = out.high_res_masks.data;
    const found = maskBoundsOf(logits, INPUT);
    const alpha = found ? toGrid(logits, INPUT, found, margin, gridWidth, gridHeight) : new Uint8Array(gridWidth * gridHeight);
    self.postMessage({
      id,
      box: found,
      alpha,
      grid: { width: gridWidth, height: gridHeight },
      iou: out.iou_scores.data[0],
      score: out.object_score_logits.data[0],
      backend,
      gpuNote,
      ms: Math.round(performance.now() - t0)
    }, [alpha.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
