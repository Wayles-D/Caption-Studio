/**
 * The bhYnd brand intro — geometry and timeline, with no DOM of its own.
 *
 * Ported from public/bhynd_intro.html, which is a standalone page: it owns a
 * <body>, hard-codes element IDs, and starts a requestAnimationFrame loop on
 * load. None of that survives contact with an app that needs the mark in two
 * places at once (the splash overlay and the processing view), so the port
 * splits it in two:
 *
 *   - this module: the measured geometry and the frame(t) function, which
 *     touch only the nodes they are handed;
 *   - BhyndIntro.jsx: the markup, the refs, and the rAF loop.
 *
 * The animation is imperative on purpose. It writes eight SVG attributes per
 * frame at 60fps; routing that through React state would re-render the tree
 * sixty times a second to change numbers React does not otherwise care about.
 * So the component renders the nodes once and this module mutates them —
 * the same arrangement preview.js already uses for the caption canvas.
 *
 * Every number below is from the original file. The layout was traced from
 * the brand artwork (G.fit holds the measured edge lines of the three cards),
 * so it is not derivable and must not be "tidied".
 */

// Traced from the brand artwork: the playhead's key coordinates and, in
// `fit`, the top/bottom edge lines of the three trailing cards as
// [intercept, slope] pairs in artwork space.
const G = {
  tt: 25, sb: 412, tl: 216, tr: 272, sl: 238, sr: 251, jy: 71,
  fit: {
    top3: [125.49407114624502, 0.16374929418407844],
    bot3: [328.60159420289824, -0.1969565217391284],
    top2: [88.51545086119556, 0.2534737299174987],
    bot2: [358.7929411764708, -0.22823529411764878],
    top1: [35.2349176119725, 0.2808130895656505],
    bot1: [397.6205140091499, -0.20169456703310482],
    maxx: 392, minx: 15
  }
};
const F = G.fit;

// Artwork space -> the 600x600 viewBox.
const K = 350 / 407;
const X0 = 125;
const Y0 = (600 - 430 * K) / 2;
const T = (x, y) => [X0 + x * K, Y0 + y * K];

/** A closed polygon path with corners rounded to `r` (quadratic fillets). */
function roundedPolygon(points, r) {
  let d = '';
  points.forEach((b, i) => {
    const a = points[(i + points.length - 1) % points.length];
    const c = points[(i + 1) % points.length];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(r, la / 2, lc / 2);
    const p1 = [b[0] + (a[0] - b[0]) / la * rr, b[1] + (a[1] - b[1]) / la * rr];
    const p2 = [b[0] + (c[0] - b[0]) / lc * rr, b[1] + (c[1] - b[1]) / lc * rr];
    d += (i ? 'L' : 'M') + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2)
       + 'Q' + b[0].toFixed(2) + ' ' + b[1].toFixed(2)
       + ' ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
  });
  return d + 'Z';
}

// The cards, as clean trapezoids rebuilt from the measured edge lines rather
// than traced outlines — so they stay straight-edged at any scale.
const topEdge = (k, x) => F['top' + k][0] + F['top' + k][1] * x;
const botEdge = (k, x) => F['bot' + k][0] + F['bot' + k][1] * x;
const card = (k, L, R) => [
  T(L, topEdge(k, L)), T(R, topEdge(k, R)), T(R, botEdge(k, R)), T(L, botEdge(k, L))
];

export const CARD_PATHS = {
  k3: roundedPolygon(card(3, 15, 183), 18),
  k2: roundedPolygon(card(2, 66, 268), 18),
  k1: roundedPolygon(card(1, 143, 392), 18)
};

// The playhead, as a 9-point polygon so it can morph from the 9-point "Y"
// glyph below. The apex notch is collapsed onto the top edge — three
// coincident points — which is what lets a sharp triangle emerge from a
// letterform with the same vertex count.
const cxp = (G.sl + G.sr) / 2;
const PLAYHEAD_POLY = [
  T(G.tl, G.tt), T(cxp, G.tt), T(cxp, G.tt), T(cxp, G.tt), T(G.tr, G.tt),
  T(G.sr, G.jy), T(G.sr, G.sb), T(G.sl, G.sb), T(G.sl, G.jy)
];

// The final playhead is drawn as a proper rounded triangle + rounded stem
// rather than left as the morph polygon, which cannot have soft corners.
const apexY = G.tt + (cxp - G.tl) / ((G.sl - G.tl) / (G.jy - G.tt));
export const TRIANGLE_PATH = roundedPolygon(
  [T(G.tl, G.tt), T(G.tr, G.tt), T(cxp, apexY)], 5
);

const stemTopLeft = T(G.sl, G.jy - 14);
const stemBottomRight = T(G.sr, G.sb);
export const STEM_RECT = {
  x: stemTopLeft[0],
  y: stemTopLeft[1],
  width: stemBottomRight[0] - stemTopLeft[0],
  height: stemBottomRight[1] - stemTopLeft[1],
  rx: (stemBottomRight[0] - stemTopLeft[0]) / 2
};

// Wordmark metrics. The "Y" is not a glyph — it is a 9-point polygon sized to
// sit between "bh" and "nd", which is the whole trick: the same polygon is
// then tweened to PLAYHEAD_POLY.
const GLYPH_HEIGHT = 86;
const Y_WIDTH = 84;
const Y_ARM = 26;
const Y_STEM = 24;
const Y_TOP = 257;
const Y_GAP = 3;

/**
 * Lays the wordmark out around the measured widths of "bh" and "nd".
 *
 * Both widths come from getComputedTextLength(), so the text nodes have to be
 * in the document before this runs — laying the mark out for an unmeasured
 * or fallback face leaves the "Y" visibly off centre. BhyndIntro.jsx owns the
 * measuring; this function just takes the numbers.
 */
export function layoutWordmark(widthBh, widthNd) {
  const total = widthBh + Y_GAP + Y_WIDTH + Y_GAP + widthNd;
  const left = 300 - total / 2 + widthBh + Y_GAP;
  const right = left + Y_WIDTH;
  const cx = left + Y_WIDTH / 2;
  const cy = Y_TOP + GLYPH_HEIGHT / 2;
  const bottom = Y_TOP + GLYPH_HEIGHT;
  return {
    cx, cy,
    bhX: left - Y_GAP, bhY: bottom,
    ndX: right + Y_GAP, ndY: bottom,
    // The "Y", in the same vertex order as PLAYHEAD_POLY.
    glyph: [
      [left, Y_TOP], [left + Y_ARM, Y_TOP], [cx, Y_TOP + 0.4 * GLYPH_HEIGHT],
      [right - Y_ARM, Y_TOP], [right, Y_TOP],
      [cx + Y_STEM / 2, Y_TOP + 0.55 * GLYPH_HEIGHT], [cx + Y_STEM / 2, bottom],
      [cx - Y_STEM / 2, bottom], [cx - Y_STEM / 2, Y_TOP + 0.55 * GLYPH_HEIGHT]
    ]
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeBack = (t) => { const a = 1.70158, b = a + 1; return 1 + b * Math.pow(t - 1, 3) + a * Math.pow(t - 1, 2); };

/**
 * When the mark has finished assembling. Past this the only motion is the
 * glow's breathing pulse, so it is both the splash's cue to leave and the
 * point a looping instance can be said to be "idling".
 */
export const INTRO_SETTLED_SECONDS = 2.6;

/**
 * Where the processing view starts its clock.
 *
 * A caption job is the wrong moment for a three-second logo reveal, so it
 * skips the wordmark and joins at the morph — the mark is recognisable within
 * a few frames and idling within two seconds, while still arriving rather
 * than just appearing.
 */
export const INTRO_MORPH_SECONDS = 1.35;

/**
 * Builds the per-frame writer for one set of nodes.
 *
 * `nodes` are the live SVG elements (see BhyndIntro.jsx). Returns frame(t),
 * t in seconds from the start of the animation; it is a pure function of t,
 * so seeking is just calling it with a different number.
 *
 * `getWordmark` is read per frame rather than captured once, so a re-measure
 * after a font swap takes effect on the next frame instead of needing the
 * animation restarted mid-reveal.
 */
export function createIntroFrame(nodes, getWordmark, { reducedMotion = false } = {}) {
  const { glow, k1, k2, k3, fin, poly, bh, nd } = nodes;

  return function frame(t) {
    const seg = (a, b) => clamp01((t - a) / (b - a));
    const { cx, cy, glyph } = getWordmark();

    // "bh" and "nd" slide in from their own sides, then part again as the
    // "Y" between them takes over.
    const exit = seg(1.35, 1.65);
    const inBh = easeOut(seg(0.1, 0.55));
    const inNd = easeOut(seg(0.45, 0.9));
    bh.setAttribute('opacity', inBh * (1 - exit));
    bh.setAttribute('transform', `translate(${-14 * (1 - inBh) - 10 * exit} 0)`);
    nd.setAttribute('opacity', inNd * (1 - exit));
    nd.setAttribute('transform', `translate(${14 * (1 - inNd) + 10 * exit} 0)`);

    // The morph. Vertex i of the "Y" walks to vertex i of the playhead while
    // the whole shape overshoots up to full size.
    const morph = easeInOut(seg(1.45, 2.25));
    const scale = 0.5 + 0.5 * easeBack(seg(0.3, 0.75));
    poly.setAttribute('points', glyph.map((a, i) => {
      let x = a[0] + (PLAYHEAD_POLY[i][0] - a[0]) * morph;
      let y = a[1] + (PLAYHEAD_POLY[i][1] - a[1]) * morph;
      x = cx + (x - cx) * scale;
      y = cy + (y - cy) * scale;
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' '));

    // Once the morph lands, the polygon hands off to the rounded-corner
    // version underneath it — a crossfade, so the corners soften rather than
    // snapping.
    const handoff = seg(2.15, 2.4);
    poly.setAttribute('opacity', seg(0.3, 0.5) * (1 - handoff));
    fin.setAttribute('opacity', handoff);

    // The three cards fan in behind, furthest first.
    const cards = [[k3, 2.05], [k2, 2.15], [k1, 2.25]];
    for (const [node, at] of cards) {
      const q = easeOut(seg(at, at + 0.55));
      node.setAttribute('opacity', q);
      node.setAttribute('transform', `translate(${28 * (1 - q)} 0)`);
    }

    // The glow keeps breathing after everything else has settled, which is
    // what makes a held frame read as alive. Reduced motion pins it flat.
    const pulse = reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(Math.max(0, t - 2.9) * 2.4);
    glow.setAttribute('opacity', easeOut(seg(1.6, 2.6)) * pulse);
  };
}
