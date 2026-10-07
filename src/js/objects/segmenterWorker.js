/**
 * Runs the object SEGMENTER (MobileSAM via onnxruntime-web) off the main
 * thread: the GPU through WebGPU where the browser has it, otherwise the CPU
 * (WebAssembly, one thread — far slower; see private-notes/object-segmentation.md).
 * The encoder and decoder load once, on the first request; every keyframe
 * after reuses them. Receives one crop (the encoder input) and its prompt,
 * returns the mask logits — or the error, never a crash.
 *
 * The runtime ships with the app (its WebGPU build's .wasm — the 'asyncify'
 * one that build loads; the 'jsep' files are another build's — is imported as an
 * asset URL, so Vite bundles it); the models are the app's own
 * (public/models). Nothing is fetched from a CDN.
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;
// The runtime notes, as console ERRORS, that a few shape ops stay on the CPU
// under WebGPU — normal, and noise in a console kept for real problems.
ort.env.logLevel = 'error';

let sessions = null;
let backend = null;
// Why the GPU was not used, when it was not — reported with every result.
let gpuNote = null;

async function load(encoderUrl, decoderUrl) {
  if (sessions) return sessions;
  const tryCreate = async (providers) => ({
    encoder: await ort.InferenceSession.create(encoderUrl, { executionProviders: providers }),
    // The decoder is small and runs fine on the CPU either way.
    decoder: await ort.InferenceSession.create(decoderUrl, { executionProviders: ['wasm'] })
  });
  if (self.navigator?.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        sessions = await tryCreate(['webgpu']);
        backend = 'gpu';
        return sessions;
      }
      gpuNote = 'no GPU adapter';
    } catch (err) {
      // No usable GPU: the CPU it is.
      gpuNote = err?.message || String(err);
    }
  } else {
    gpuNote = 'WebGPU is not available in this browser';
  }
  sessions = await tryCreate(['wasm']);
  backend = 'cpu';
  return sessions;
}

self.onmessage = async (e) => {
  const { id, encoderUrl, decoderUrl, image, width, height, coords, labels, maskInput, origWidth, origHeight } = e.data || {};
  try {
    const { encoder, decoder } = await load(encoderUrl, decoderUrl);
    const t0 = performance.now();
    const { image_embeddings } = await encoder.run({ input_image: new ort.Tensor('float32', image, [height, width, 3]) });
    // The embeddings come back to the CPU for the decoder.
    const embeddings = image_embeddings.location && image_embeddings.location !== 'cpu'
      ? new ort.Tensor('float32', await image_embeddings.getData(true), image_embeddings.dims)
      : image_embeddings;
    const out = await decoder.run({
      image_embeddings: embeddings,
      point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, coords.length / 2, 2]),
      point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, labels.length]),
      mask_input: new ort.Tensor('float32', maskInput || new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', new Float32Array([maskInput ? 1 : 0]), [1]),
      orig_im_size: new ort.Tensor('float32', new Float32Array([origHeight, origWidth]), [2])
    });
    // Copies: an output may be a view into the runtime's own memory, which must not be transferred away.
    const logits = new Float32Array(out.masks.data);
    const lowRes = new Float32Array(out.low_res_masks.data);
    self.postMessage({ id, logits, lowRes, iou: out.iou_predictions.data[0], backend, gpuNote, ms: Math.round(performance.now() - t0) }, [logits.buffer, lowRes.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
