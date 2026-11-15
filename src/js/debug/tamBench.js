/**
 * GATE 0 — what one frame of EdgeTAM costs in THIS browser, on THIS machine.
 *
 * Everything in the occlusion rebuild depends on this number. The model is a
 * video segmenter: it is prompted once with a box and then carries the object
 * forward by memory, one frame at a time. That is only worth building if a
 * frame is affordable — at ~500ms a 35s clip is a minute or two, at 3s it is
 * half an hour and the work has to move to the server instead.
 *
 * Measured in Node on the CPU (WebAssembly) a frame costs about 5.5s, which
 * says nothing useful: the editor runs this on the GPU through WebGPU. The
 * published figure for this export is ~565ms/frame on Intel Iris Xe, which is
 * weak integrated graphics — so this is really asking whether that holds here.
 *
 * Reports the backend it ACTUALLY got, because a silent fall back to the CPU
 * would otherwise look like the GPU being slow.
 *
 * DEV only. Call window.__benchTam() from the console.
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const INPUT = 1024;
const BASE = '/models/edgetam';
const T = (data, dims, type = 'float32') => new ort.Tensor(type, data, dims);

/** [1,C,H,W] -> [H*W,1,C] */
function toSequence(t) {
  const [, C, H, W] = t.dims;
  const hw = H * W;
  const src = t.data;
  const dst = new Float32Array(hw * C);
  for (let c = 0; c < C; c++) for (let i = 0; i < hw; i++) dst[i * C + c] = src[c * hw + i];
  return T(dst, [hw, 1, C]);
}

export async function benchTam({ frames = 5 } = {}) {
  const report = { backend: null, note: null, load: null, perStage: {}, perFrame: null };

  // Which backend we actually get — asked the same way the segmenter worker asks.
  let providers = ['wasm'];
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) { providers = ['webgpu']; report.backend = 'webgpu'; }
      else { report.note = 'no GPU adapter'; report.backend = 'wasm'; }
    } catch (err) {
      report.note = 'requestAdapter failed: ' + err.message;
      report.backend = 'wasm';
    }
  } else {
    report.note = 'navigator.gpu missing';
    report.backend = 'wasm';
  }

  const t0 = performance.now();
  const open = (f, p = providers) => ort.InferenceSession.create(`${BASE}/${f}.onnx`, { executionProviders: p });
  const encoder = await open('vision_encoder');
  const decoder = await open('mask_decoder');
  const memoryEncoder = await open('memory_encoder');
  const memoryAttention = await open('memory_attention');
  report.load = Math.round(performance.now() - t0);

  // A real-sized frame of noise: the cost is in the shapes, not the content.
  const pixels = new Float32Array(3 * INPUT * INPUT);
  for (let i = 0; i < pixels.length; i += 97) pixels[i] = 0.5;

  const times = { encode: [], decode: [], memEncode: [], memAttend: [] };
  let bank = null; let bankPos = null; let pointer = null;
  const recent = []; const pointers = [];

  for (let f = 0; f < frames; f++) {
    let t = performance.now();
    const feats = await encoder.run({ pixel_values: T(pixels, [1, 3, INPUT, INPUT]) });
    times.encode.push(performance.now() - t);

    let decodeFeats = feats.feats2;
    if (bank) {
      t = performance.now();
      const cond = await memoryAttention.run({
        current_vision_features: toSequence(feats.feats2),
        current_vision_position_embeddings: toSequence(feats.pos2),
        spatial_memory: T(bank, [bank.length / 64, 1, 64]),
        spatial_memory_position_embeddings: T(bankPos, [bankPos.length / 64, 1, 64]),
        pointer_memory: T(pointer, [pointer.length / 64, 1, 64]),
        pointer_memory_position_embeddings: T(new Float32Array(pointer.length), [pointer.length / 64, 1, 64])
      });
      times.memAttend.push(performance.now() - t);
      const [, C, H, W] = feats.feats2.dims;
      const hw = H * W;
      const src = cond.conditioned_features.data;
      const dst = new Float32Array(C * hw);
      for (let i = 0; i < hw; i++) for (let c = 0; c < C; c++) dst[c * hw + i] = src[i * C + c];
      decodeFeats = T(dst, [1, C, H, W]);
    }

    t = performance.now();
    const out = await decoder.run({
      feats0: feats.feats0, feats1: feats.feats1, feats2: decodeFeats,
      input_points: f === 0 ? T(Float32Array.from([200, 150, 800, 900]), [1, 1, 2, 2]) : T(new Float32Array(0), [1, 1, 0, 2]),
      input_labels: f === 0 ? T(Int32Array.from([2, 3]), [1, 1, 2], 'int32') : T(new Int32Array(0), [1, 1, 0], 'int32')
    });
    times.decode.push(performance.now() - t);

    t = performance.now();
    const mem = await memoryEncoder.run({
      vision_features: feats.feats2,
      pred_masks_high_res: out.high_res_masks,
      is_mask_from_pts: T(Uint8Array.from([f === 0 ? 1 : 0]), [1], 'bool')
    });
    times.memEncode.push(performance.now() - t);

    // The REAL bank holds the prompted frame plus the recent few, so memory
    // attention sees ~7x this much. Benchmarking a single-frame bank reports a
    // cost the running editor would never see.
    recent.unshift({ tokens: mem.memory_tokens.data, pos: mem.memory_pos_enc.data });
    if (recent.length > 7) recent.pop();
    const join = (pick) => {
      const total = recent.reduce((n, r) => n + r[pick].length, 0);
      const out2 = new Float32Array(total);
      let at = 0;
      for (const r of recent) { out2.set(r[pick], at); at += r[pick].length; }
      return out2;
    };
    bank = join('tokens');
    bankPos = join('pos');
    pointers.unshift(out.object_pointer.data);
    if (pointers.length > 16) pointers.pop();
    pointer = (() => {
      const total = pointers.reduce((n, p2) => n + p2.length, 0);
      const out2 = new Float32Array(total);
      let at = 0;
      for (const p2 of pointers) { out2.set(p2, at); at += p2.length; }
      return out2;
    })();
  }

  // The first frame pays for warm-up, so report the median of the rest.
  const median = (a) => {
    const v = a.slice(1).sort((x, y) => x - y);
    return v.length ? Math.round(v[Math.floor(v.length / 2)]) : Math.round(a[0]);
  };
  report.perStage = {
    encode: median(times.encode),
    memAttend: times.memAttend.length ? median(times.memAttend) : 0,
    decode: median(times.decode),
    memEncode: median(times.memEncode)
  };
  report.perFrame = Object.values(report.perStage).reduce((a, b) => a + b, 0);
  report.secondsPer30sClipAt15fps = Math.round(report.perFrame * 15 * 30 / 1000);
  return report;
}
