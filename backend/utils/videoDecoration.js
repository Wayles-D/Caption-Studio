/**
 * The COMPOSITION, prepared for one export (see shared/composition.js): the
 * canvas size the whole render happens at, its background, the video's
 * resting box inside it, and — when the video is decorated — the still images
 * its decoration is composited from:
 *
 *   mask   the box's own size; white where the video shows (rounded corners)
 *   under  the box plus `pad` all round; the shadow
 *   over   the same size; the border ring
 *
 * Drawn with shared/composition.js's drawVideoDecoration — the same metrics
 * the preview turns into CSS — once per export, not per frame: the
 * decoration is fixed relative to the video and travels with it through the
 * video's own transform (backend/utils/videoTransformFilter.js).
 */
import fs from 'fs';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import {
  resolveComposition,
  videoBaseBox,
  isPassthroughComposition,
  hasVideoDecoration,
  videoDecorationMetrics,
  drawVideoDecoration,
  normalizeComposition
} from '../../shared/composition.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * @returns {{width:number, height:number, background:string, boxWidth:number, boxHeight:number, pad:number,
 *   files:{mask?:string, under?:string, over?:string}, passthrough:boolean}}
 *   `passthrough`: the canvas is the source frame and the video is undecorated
 *   — the composition adds nothing, and the render is exactly what it was
 *   before V1.5.
 */
export function prepareVideoComposition({ composition, videoStyle, sourceWidth, sourceHeight, outDir }) {
  const comp = resolveComposition(composition, sourceWidth, sourceHeight);
  const sameCanvas = isPassthroughComposition(comp, sourceWidth, sourceHeight);
  const decorated = hasVideoDecoration(videoStyle);
  let boxWidth = sourceWidth;
  let boxHeight = sourceHeight;
  if (!sameCanvas) {
    const box = videoBaseBox(comp, sourceWidth, sourceHeight);
    boxWidth = Math.min(comp.width, even(box.width));
    boxHeight = Math.min(comp.height, even(box.height));
  }
  const result = {
    width: comp.width,
    height: comp.height,
    background: comp.background.color,
    boxWidth,
    boxHeight,
    pad: 0,
    files: {},
    passthrough: sameCanvas && !decorated
  };
  if (!decorated) return result;

  const m = videoDecorationMetrics(videoStyle, boxWidth, boxHeight, comp.width);
  result.pad = m.pad;
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, w, h, part) => {
    const canvas = createCanvas(w, h);
    drawVideoDecoration(canvas.getContext('2d'), part, m, boxWidth, boxHeight);
    const file = path.join(outDir, `video-${name}.png`);
    fs.writeFileSync(file, canvas.toBuffer('image/png'));
    return file;
  };
  const layerW = boxWidth + 2 * m.pad;
  const layerH = boxHeight + 2 * m.pad;
  if (m.radius > 0) result.files.mask = write('mask', boxWidth, boxHeight, 'mask');
  if (m.shadow) result.files.under = write('under', layerW, layerH, 'under');
  if (m.borderWidth > 0) result.files.over = write('over', layerW, layerH, 'over');
  return result;
}

/** Whether a project's canvas or video styling needs the graphics pipeline at all (decided without the source's size). */
export function compositionNeedsRender(params) {
  return normalizeComposition(params?.composition).aspectRatio !== 'original' || hasVideoDecoration(params?.videoStyle);
}
