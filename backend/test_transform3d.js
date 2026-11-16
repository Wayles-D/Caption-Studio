/**
 * V2.4.0 UNIVERSAL 3D TRANSFORMS — the shared model and projection
 * (shared/transform3d.js), checked against the geometry it claims:
 *
 *  - no 3D → identity, and resolveTransform3d returns null (draw flat);
 *  - the pivot never moves; a floor tips its TOP away (shorter, narrower),
 *    a left wall swings its RIGHT side away;
 *  - the homography agrees with an independent CSS-style 3D projection;
 *  - the inverse round-trips; the CSS matrix3d maps like the homography;
 *  - projecting a real drawing on @napi-rs/canvas puts the pixels where the
 *    projected outline says they are.
 *
 *   node backend/test_transform3d.js
 */
import assert from 'assert';
import { createCanvas } from '@napi-rs/canvas';
import {
  normalizeTransform3d, resolveTransform3d, homographyFor, projectPoint, invertHomography, perspectiveDistance,
  pivotFor, projectedQuad, cssMatrix3d, drawWithTransform3d, matchTransform3dPreset, TRANSFORM_3D_PRESETS, transform3dField
} from '../shared/transform3d.js';

const W = 1080, H = 1920;
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// --- Model -----------------------------------------------------------------
assert.deepStrictEqual(transform3dField(undefined), {}, 'an object without 3D keeps its shape');
assert.strictEqual(resolveTransform3d(undefined), null, 'no 3D → draw flat');
assert.strictEqual(resolveTransform3d({ enabled: false, rotateX: 40 }), null, 'switched off → draw flat');
assert.strictEqual(resolveTransform3d({ enabled: true }), null, 'on but untilted → draw flat (exactly as before)');
assert.ok(resolveTransform3d(null, { motion: { rotateX: 30 } }), 'a 3D entrance tilts an object with no 3D settings');
assert.strictEqual(resolveTransform3d({ enabled: true, rotateX: 10 }, { keyframed: { rotateX: 25 } }).rotateX, 25, 'a keyframed tilt replaces the stored one');
assert.strictEqual(normalizeTransform3d({ rotateX: 500 }).rotateX, 80, 'tilt is limited');
assert.strictEqual(matchTransform3dPreset({ enabled: true, ...TRANSFORM_3D_PRESETS[1].values }), 'floor');
assert.strictEqual(matchTransform3dPreset({ enabled: true, rotateX: 13 }), 'custom');
console.log('✓ model: defaults, limits, presets, flat when nothing is tilted');

// --- Geometry --------------------------------------------------------------
const box = { centerX: 540, centerY: 1200, width: 600, height: 200, rotationDeg: 0 };
const flat = homographyFor(normalizeTransform3d({ enabled: true }), { x: 540, y: 1200 }, W);
[[0, 0], [100, 900], [1080, 1920]].forEach(([x, y]) => {
  const p = projectPoint(flat, x, y);
  assert.ok(near(p.x, x, 1e-6) && near(p.y, y, 1e-6), 'no tilt, no depth → identity');
});

const floor = normalizeTransform3d({ enabled: true, rotateX: 60, originX: 50, originY: 100 });
const floorPivot = pivotFor(floor, box);
assert.ok(near(floorPivot.y, 1300) && near(floorPivot.x, 540), 'origin at the bottom edge');
const hf = homographyFor(floor, floorPivot, W);
const pv = projectPoint(hf, floorPivot.x, floorPivot.y);
assert.ok(near(pv.x, floorPivot.x, 1e-6) && near(pv.y, floorPivot.y, 1e-6), 'the pivot stays put');
const [tl, tr, br, bl] = projectedQuad(hf, box);
assert.ok(near(br.y, 1300, 1e-6) && near(bl.y, 1300, 1e-6), 'a floor keeps its bottom edge where it was');
assert.ok(tr.x - tl.x < br.x - bl.x - 20, `the far (top) edge is narrower: ${(tr.x - tl.x).toFixed(1)} vs ${(br.x - bl.x).toFixed(1)}`);
assert.ok(br.y - tr.y < 200 * Math.cos(Math.PI / 3), 'and foreshortened more than a flat squash would');

const wall = normalizeTransform3d({ enabled: true, rotateY: 45, originX: 0, originY: 50 });
const hw = homographyFor(wall, pivotFor(wall, box), W);
const q = projectedQuad(hw, box);
assert.ok((q[2].y - q[1].y) < (q[3].y - q[0].y) - 20, 'a left wall: the right edge (far) is shorter than the left');

// Against an independent CSS-style 3D projection of the same point.
function cssProject(t, pivot, x, y) {
  const d = perspectiveDistance(t.perspective, W);
  const a = (t.rotateX * Math.PI) / 180, b = (t.rotateY * Math.PI) / 180;
  let X = x - pivot.x, Y = y - pivot.y, Z = 0;
  // rotateY then rotateX (CSS `rotateX(a) rotateY(b)` applies the right one first).
  [X, Z] = [X * Math.cos(b) + Z * Math.sin(b), -X * Math.sin(b) + Z * Math.cos(b)];
  [Y, Z] = [Y * Math.cos(a) - Z * Math.sin(a), Y * Math.sin(a) + Z * Math.cos(a)];
  Z -= (t.depth / 100) * W;
  const s = d / (d - Z);
  return { x: pivot.x + X * s, y: pivot.y + Y * s };
}
const mixed = normalizeTransform3d({ enabled: true, rotateX: 33, rotateY: -21, perspective: 80, depth: 20, originX: 30, originY: 70 });
const mp = pivotFor(mixed, { ...box, rotationDeg: 15 });
const hm = homographyFor(mixed, mp, W);
[[100, 200], [540, 1200], [900, 1700], [300, 1500]].forEach(([x, y]) => {
  const a = projectPoint(hm, x, y), b = cssProject(mixed, mp, x, y);
  assert.ok(near(a.x, b.x, 1e-6) && near(a.y, b.y, 1e-6), `homography = CSS 3D at (${x},${y}): ${a.x.toFixed(3)},${a.y.toFixed(3)} vs ${b.x.toFixed(3)},${b.y.toFixed(3)}`);
});
const inv = invertHomography(hm);
const back = projectPoint(inv, ...Object.values(projectPoint(hm, 700, 1400)));
assert.ok(near(back.x, 700, 1e-6) && near(back.y, 1400, 1e-6), 'the inverse round-trips');
console.log('✓ geometry: pivot fixed, floor and wall recede the right way, identical to a CSS 3D projection');

// --- CSS matrix3d ------------------------------------------------------------
{
  const k = 2.5; // canvas px per CSS px
  const O = { x: 540, y: 960 };
  const m = cssMatrix3d(hm, O.x, O.y, k).match(/matrix3d\((.*)\)/)[1].split(',').map(Number);
  // A point (ex, ey) in the element's frame (CSS px from its centre).
  [[-100, -50], [80, 120]].forEach(([ex, ey]) => {
    const w = m[3] * ex + m[7] * ey + m[15];
    const cssX = (m[0] * ex + m[4] * ey + m[12]) / w;
    const cssY = (m[1] * ex + m[5] * ey + m[13]) / w;
    const viaH = projectPoint(hm, O.x + ex * k, O.y + ey * k);
    assert.ok(near(O.x + cssX * k, viaH.x, 1e-4) && near(O.y + cssY * k, viaH.y, 1e-4), 'matrix3d maps like the homography');
  });
  console.log('✓ CSS: matrix3d projects the video exactly as the homography does');
}

// --- Real pixels ---------------------------------------------------------------
{
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const rect = { centerX: 540, centerY: 1200, width: 600, height: 300, rotationDeg: 0 };
  const t = normalizeTransform3d({ enabled: true, rotateX: 55, originX: 50, originY: 100 });
  const pivot = pivotFor(t, rect);
  const h = drawWithTransform3d(ctx, t, {
    pivot, bounds: { x: 240, y: 1050, width: 600, height: 300 }, canvasWidth: W, canvasHeight: H,
    createOffscreenCanvas: (w, hh) => createCanvas(w, hh)
  }, (c) => { c.fillStyle = '#FF0000'; c.fillRect(240, 1050, 600, 300); });
  const quad = projectedQuad(h, rect);
  const px = (x, y) => ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  const inside = px((quad[0].x + quad[2].x) / 2, (quad[0].y + quad[2].y) / 2);
  assert.ok(inside[0] > 240 && inside[3] > 240, 'the middle of the projected quad is red');
  assert.strictEqual(px(260, 1060)[3], 0, 'the flat rectangle\'s old top corner is now empty (it tipped away)');
  assert.ok(px(quad[3].x + 4, quad[3].y - 3)[3] > 200, 'the bottom edge is still there');
  assert.strictEqual(px(quad[0].x - 6, quad[0].y + 6)[3], 0, 'outside the far edge is empty');
  console.log(`✓ pixels: a red rectangle laid on the floor lands inside its projected outline (top edge ${(quad[1].x - quad[0].x).toFixed(0)}px, bottom ${(quad[2].x - quad[3].x).toFixed(0)}px)`);
}

console.log('\nAll 3D transform checks passed.');
