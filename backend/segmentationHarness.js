/**
 * Runs object segmentation (shared/objects/segmentation.js) in Node on a real
 * video file: frames cropped by ffmpeg (rotation metadata applied, as the
 * browser does), MobileSAM by the same onnxruntime-web the editor's worker
 * uses (WebAssembly here; the editor uses WebGPU where it can) — so tests
 * exercise the editor's exact segmentation, minus the browser.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import * as ort from 'onnxruntime-web';
import { probe } from './trackingHarness.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let sessions = null;

/** The encoder and decoder, loaded once. Tests may use several threads (Node can; the editor's WebAssembly fallback cannot). */
export async function getSegmenter({ threads = 4 } = {}) {
  if (!sessions) {
    ort.env.wasm.numThreads = threads;
    const model = (f) => path.join(root, 'public', 'models', f);
    sessions = {
      encoder: await ort.InferenceSession.create(model('mobilesam-encoder.onnx'), { executionProviders: ['wasm'] }),
      decoder: await ort.InferenceSession.create(model('mobilesam-decoder.onnx'), { executionProviders: ['wasm'] })
    };
  }
  return sessions;
}

/** The encoder input for `crop` at `time`: the crop of the displayed frame, resized, as HWC RGB 0-255 floats. */
export function grabCrop(file, time, crop, info = probe(file)) {
  const at = Math.min(Math.max(0, time), Math.max(0, info.duration - 0.1));
  return new Promise((resolve, reject) => {
    const vf = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${crop.inputWidth}:${crop.inputHeight}:flags=bilinear`;
    const p = spawn(ffmpegPath, ['-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length !== crop.inputWidth * crop.inputHeight * 3) return reject(new Error(`no crop at ${time}`));
      const data = new Float32Array(buf.length);
      for (let i = 0; i < buf.length; i++) data[i] = buf[i];
      resolve({ data });
    });
  });
}

/** One MobileSAM pass: encoder on the crop, decoder with the box (and, if given, the previous mask). */
export async function segmentOnce({ image, width, height, coords, labels, maskInput, origWidth, origHeight, refine = true }) {
  const { encoder, decoder } = await getSegmenter();
  const { image_embeddings } = await encoder.run({ input_image: new ort.Tensor('float32', image, [height, width, 3]) });
  const decode = (mask, has) => decoder.run({
    image_embeddings,
    point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, coords.length / 2, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, labels.length]),
    mask_input: new ort.Tensor('float32', mask || new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([has ? 1 : 0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([origHeight, origWidth]), [2])
  });
/**
 * SAM REFINEMENT. The encoder is the expensive part and has already run for
 * this crop; the decoder is nearly free. Feeding the first mask BACK to the
 * decoder as its mask_input — the standard SAM refinement step — lets it
 * reconsider with a shape to work from, and is what recovers thin
 * extremities: an outstretched arm, fingers, a carried bag, which a single
 * box-prompted pass routinely leaves out (measured on real footage).
 *
 * The better of the two is kept, by the model's OWN predicted IoU, so a
 * refinement that made things worse is simply not used.
 */
  let out = await decode(maskInput, !!maskInput);
  if (refine) {
    const again = await decode(out.low_res_masks.data, true);
    if (again.iou_predictions.data[0] >= out.iou_predictions.data[0]) out = again;
  }
  return { logits: out.masks.data, lowRes: out.low_res_masks.data, iou: out.iou_predictions.data[0] };
}
