/**
 * Drives the video segmenter (tamWorker.js) over a span of the preview video,
 * so it can be watched working before any of it is wired into the editor.
 *
 * This is the bridge between "proven in Node" and "integrated": it does the
 * real browser work — pulling frames off the <video>, feeding the worker,
 * collecting masks — without touching the editor's own state. Whatever ends up
 * in the Objects panel will do exactly this underneath.
 *
 * DEV only. From the console:
 *   await __tamTry({ start: 1, seconds: 2, fps: 10, box: {x,y,width,height} })
 */

const INPUT = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let worker = null;
let seq = 0;

function getWorker() {
  if (!worker) worker = new Worker(new URL('../objects/tamWorker.js', import.meta.url), { type: 'module' });
  return worker;
}

function ask(message, transfer = []) {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, ...message }, transfer);
  });
}

const modelUrls = () => ({
  encoder: '/models/edgetam/vision_encoder.onnx',
  decoder: '/models/edgetam/mask_decoder.onnx',
  memoryEncoder: '/models/edgetam/memory_encoder.onnx',
  memoryAttention: '/models/edgetam/memory_attention.onnx',
  bankParams: '/models/edgetam/bank_params.json'
});

/** Seeks the video and waits for the frame to actually be there to read. */
function seek(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-3 && video.readyState >= 2) return resolve();
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** The current video frame as the encoder wants it: 1024x1024, CHW, ImageNet-normalized. */
function framePixels(video, scratch) {
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, INPUT, INPUT);
  const { data } = ctx.getImageData(0, 0, INPUT, INPUT);
  const plane = INPUT * INPUT;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

export async function tamTry({ start = 0, seconds = 2, fps = 10, box = null, onFrame = null } = {}) {
  const video = document.getElementById('preview-video');
  if (!video) throw new Error('no preview video');
  video.pause();

  // Default to the middle of the frame, which is where a talking head sits.
  const prompt = box || { x: 0.25, y: 0.1, width: 0.5, height: 0.85 };
  const scratch = document.createElement('canvas');
  scratch.width = INPUT; scratch.height = INPUT;

  await ask({ op: 'reset' });
  const count = Math.max(1, Math.round(seconds * fps));
  const results = [];
  const t0 = performance.now();

  for (let i = 0; i < count; i++) {
    const t = start + i / fps;
    if (t >= video.duration) break;
    await seek(video, t);
    const pixels = framePixels(video, scratch);
    const reply = await ask(
      i === 0
        ? { op: 'prompt', models: modelUrls(), pixels, box: prompt }
        : { op: 'track', pixels },
      [pixels.buffer]
    );
    let area = 0;
    for (let k = 0; k < reply.alpha.length; k++) if (reply.alpha[k] >= 128) area++;
    const row = {
      time: +t.toFixed(3),
      ms: reply.ms,
      backend: reply.backend,
      iou: +reply.iou.toFixed(3),
      score: +reply.score.toFixed(2),
      box: reply.box && Object.fromEntries(Object.entries(reply.box).map(([k, v]) => [k, +v.toFixed(3)])),
      filled: +(area / reply.alpha.length).toFixed(3)
    };
    results.push(row);
    onFrame?.(row, reply);
  }

  const total = Math.round(performance.now() - t0);
  return {
    backend: results[0]?.backend,
    frames: results.length,
    totalMs: total,
    msPerFrame: Math.round(total / Math.max(1, results.length)),
    results
  };
}
