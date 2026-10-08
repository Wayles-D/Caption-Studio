/**
 * YOLOX (Megvii, Apache-2.0) — the model's own input and output conventions,
 * as pure functions, so the editor's Web Worker and the Node tests prepare
 * frames and read results identically. The runtime that executes the model
 * (onnxruntime-web) is outside this file.
 *
 * Matches YOLOX's reference ONNX demo (tools/onnx_inference.py with the
 * non-legacy preprocessing the released .onnx files expect):
 *   - input  [1, 3, S, S] float32, BGR, raw 0-255 (no /255, no mean/std);
 *            the frame is scaled to fit S×S keeping its shape, top-left
 *            aligned, the rest filled with 114;
 *   - output [1, N, 85]: per anchor point cx, cy, w, h (in grid units —
 *            decoded below over strides 8/16/32), objectness, 80 class
 *            scores. Score = objectness × class score.
 */

/** The 80 COCO classes, in the model's output order. */
export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
];

/** Human-readable names where COCO's own are terse. */
const LABELS = { 'cell phone': 'Phone', tv: 'TV / Monitor', 'dining table': 'Table', 'potted plant': 'Plant', 'sports ball': 'Ball' };
export function classLabel(cls) {
  return LABELS[cls] || cls.replace(/\b\w/g, (c) => c.toUpperCase());
}

const STRIDES = [8, 16, 32];
const PAD_VALUE = 114;

/**
 * An RGBA frame ({data, width, height}, like ImageData) → the model's input
 * tensor data, and the scale it was resized by.
 * @param {number} size - The model's square input (416 for nano/tiny).
 */
export function preprocess(frame, size) {
  const { data, width, height } = frame;
  const scale = Math.min(size / width, size / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const plane = size * size;
  const out = new Float32Array(3 * plane).fill(PAD_VALUE);
  // Area-ish sampling: each target pixel averages the source pixels it covers
  // (a plain nearest pick aliases badly when a 1080p frame shrinks to 416).
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.max(sy0 + 1, Math.min(height, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.max(sx0 + 1, Math.min(width, Math.floor((x + 1) / scale)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy += Math.max(1, Math.floor((sy1 - sy0) / 2))) {
        for (let sx = sx0; sx < sx1; sx += Math.max(1, Math.floor((sx1 - sx0) / 2))) {
          const i = (sy * width + sx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = y * size + x;
      out[o] = b / n; // B
      out[plane + o] = g / n; // G
      out[2 * plane + o] = r / n; // R
    }
  }
  return { input: out, scale };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * The model's raw output → detections, boxes normalized to the FRAME
 * (0-1, x/y top-left), sorted by confidence.
 * @param {Float32Array} output - [N × (5 + classes)].
 * @param {{size:number, scale:number, frameWidth:number, frameHeight:number, minScore?:number, nmsIou?:number, maxDetections?:number}} opts
 * @returns {{cls:string, confidence:number, box:{x:number,y:number,width:number,height:number}}[]}
 */
export function postprocess(output, opts) {
  const { size, scale, frameWidth, frameHeight } = opts;
  const minScore = opts.minScore ?? 0.25;
  const nmsIou = opts.nmsIou ?? 0.45;
  const maxDetections = opts.maxDetections ?? 100;
  const nc = COCO_CLASSES.length;
  const stride = 5 + nc;
  const candidates = [];
  let row = 0;
  for (const s of STRIDES) {
    const g = size / s;
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++, row++) {
        const o = row * stride;
        const obj = output[o + 4];
        if (obj < minScore) continue;
        let best = 0;
        let cls = 0;
        for (let c = 0; c < nc; c++) {
          const v = output[o + 5 + c];
          if (v > best) { best = v; cls = c; }
        }
        const score = obj * best;
        if (score < minScore) continue;
        const cx = (output[o] + gx) * s;
        const cy = (output[o + 1] + gy) * s;
        const w = Math.exp(output[o + 2]) * s;
        const h = Math.exp(output[o + 3]) * s;
        // Undo the resize: model pixels → frame pixels.
        candidates.push({
          cls, score,
          x1: (cx - w / 2) / scale, y1: (cy - h / 2) / scale,
          x2: (cx + w / 2) / scale, y2: (cy + h / 2) / scale
        });
      }
    }
  }
  // Per-class non-maximum suppression.
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of candidates) {
    if (kept.length >= maxDetections) break;
    if (kept.some((k) => k.cls === c.cls && iou(k, c) > nmsIou)) continue;
    kept.push(c);
  }
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return kept.map((k) => {
    const x1 = clamp01(k.x1 / frameWidth);
    const y1 = clamp01(k.y1 / frameHeight);
    const x2 = clamp01(k.x2 / frameWidth);
    const y2 = clamp01(k.y2 / frameHeight);
    return { cls: COCO_CLASSES[k.cls], confidence: k.score, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } };
  }).filter((d) => d.box.width > 0 && d.box.height > 0);
}
