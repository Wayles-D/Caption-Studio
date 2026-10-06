/**
 * Runs the object detector (YOLOX via onnxruntime-web, CPU/WebAssembly) off
 * the main thread. The model is loaded once, on the first frame; every frame
 * after reuses the session. Receives an RGBA frame, returns raw detections
 * (shared/objects/yolox.js's postprocess) — or the error, never a crash.
 *
 * The runtime's WebAssembly ships with the app (imported as asset URLs, so
 * Vite bundles them) rather than being fetched from a CDN at run time.
 */
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { preprocess, postprocess } from '../../../shared/objects/yolox.js';

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
// Threads need cross-origin isolation the app doesn't have; one thread, in
// this worker, never blocks the editor anyway.
ort.env.wasm.numThreads = 1;

let session = null;
let sessionModel = null;

async function getSession(modelUrl) {
  if (session && sessionModel === modelUrl) return session;
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  sessionModel = modelUrl;
  return session;
}

self.onmessage = async (e) => {
  const { id, modelUrl, inputSize, frame, minScore } = e.data || {};
  try {
    const s = await getSession(modelUrl);
    const { input, scale } = preprocess(frame, inputSize);
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, inputSize, inputSize]) });
    const raw = out[s.outputNames[0]].data;
    const detections = postprocess(raw, { size: inputSize, scale, frameWidth: frame.width, frameHeight: frame.height, minScore });
    self.postMessage({ id, detections });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
