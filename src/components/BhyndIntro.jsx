/**
 * The bhYnd mark, animated.
 *
 * Geometry and the per-frame writer live in src/js/brand/bhyndIntro.js; this
 * file owns the markup, the refs and the rAF loop. See that module's header
 * for why the animation writes attributes directly instead of re-rendering.
 *
 * Two instances can be on screen at once (the splash and the processing
 * view), so every internal id is namespaced with useId(). The paint-server
 * references — fill="url(#…)" — are document-global; two instances sharing an
 * id would leave whichever mounted second pointing at the first one's
 * gradients, and those get removed when the first unmounts. That is exactly
 * the splash/processing sequence, so the namespacing is load-bearing, not
 * hygiene.
 */
import { useEffect, useId, useRef } from 'react';
import {
  CARD_PATHS, TRIANGLE_PATH, STEM_RECT,
  layoutWordmark, createIntroFrame,
  INTRO_SETTLED_SECONDS
} from '../js/brand/bhyndIntro.js';

const BRAND = '#00E599';
const BRAND_LIGHT = '#7dffd0';

// The mark is drawn in the system UI face, as the brand artwork specifies —
// deliberately not the app's Geist/Inter, which is for the product chrome.
const WORDMARK_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function BhyndIntro({
  // Where the clock starts. 0 plays the whole reveal; see INTRO_MORPH_SECONDS
  // for the shortened entry the processing view uses.
  startAt = 0,
  // Called once the mark has finished assembling. Fires on a settled frame,
  // not on a timer, so it cannot run ahead of what is on screen.
  onSettled,
  className = '',
  style
}) {
  // useId() produces ":r0:"-style values; the colons are legal in an id but
  // would need escaping inside url(#…), so they come out.
  const uid = useId().replace(/:/g, '');
  const svgRef = useRef(null);
  const nodes = {
    glow: useRef(null), k1: useRef(null), k2: useRef(null), k3: useRef(null),
    fin: useRef(null), tri: useRef(null), stem: useRef(null), poly: useRef(null),
    bh: useRef(null), nd: useRef(null)
  };
  // Held in a ref so a changing callback identity cannot restart the
  // animation — a splash that replays every time its parent re-renders is
  // the failure this avoids.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    const el = (r) => r.current;
    if (!el(nodes.bh) || !el(nodes.nd)) return undefined;

    const reducedMotion = prefersReducedMotion();
    let raf = 0;
    let cancelled = false;
    let settledFired = false;

    // The wordmark is laid out from getComputedTextLength(), i.e. the
    // LAID-OUT width of "bh" and "nd" — so a re-measure is needed if the face
    // changes under it. It is held in a box the frame writer reads each
    // frame rather than gating the animation on document.fonts.ready:
    // the mark is drawn in the SYSTEM font stack, which is never pending, so
    // waiting would trade a guaranteed-correct measurement for a splash that
    // does nothing until an unrelated webfont finishes loading.
    let wordmark = null;
    const measure = () => {
      if (cancelled || !el(nodes.bh)) return;
      wordmark = layoutWordmark(
        el(nodes.bh).getComputedTextLength(),
        el(nodes.nd).getComputedTextLength()
      );
      el(nodes.bh).setAttribute('x', wordmark.bhX);
      el(nodes.bh).setAttribute('y', wordmark.bhY);
      el(nodes.nd).setAttribute('x', wordmark.ndX);
      el(nodes.nd).setAttribute('y', wordmark.ndY);
    };

    const begin = () => {
      measure();

      const frame = createIntroFrame({
        glow: el(nodes.glow), k1: el(nodes.k1), k2: el(nodes.k2), k3: el(nodes.k3),
        fin: el(nodes.fin), poly: el(nodes.poly), bh: el(nodes.bh), nd: el(nodes.nd)
      }, () => wordmark, { reducedMotion });

      const settle = () => {
        if (settledFired) return;
        settledFired = true;
        onSettledRef.current?.();
      };

      if (reducedMotion) {
        // No motion at all: paint the finished mark and report it settled.
        frame(INTRO_SETTLED_SECONDS + 0.3);
        settle();
        return;
      }

      const t0 = performance.now();
      const loop = (now) => {
        const t = startAt + (now - t0) / 1000;
        frame(t);
        if (t >= INTRO_SETTLED_SECONDS) settle();
        raf = requestAnimationFrame(loop);
      };
      // Paint the first frame synchronously so the mark is never a blank
      // box for a frame, however briefly.
      frame(startAt);
      raf = requestAnimationFrame(loop);
    };

    begin();
    // If a font swap does land later, re-measure — the next frame picks it up.
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => { cancelled = true; cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt]);

  return (
    <svg
      ref={svgRef}
      className={className}
      style={style}
      viewBox="0 0 600 600"
      role="img"
      aria-label="bhYnd"
    >
      <defs>
        <radialGradient id={`${uid}-glow`}>
          <stop offset="0" stopColor={BRAND} stopOpacity=".22" />
          <stop offset="1" stopColor={BRAND} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-c1`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BRAND} stopOpacity=".62" />
          <stop offset="1" stopColor={BRAND} stopOpacity=".95" />
        </linearGradient>
        <linearGradient id={`${uid}-c2`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BRAND} stopOpacity=".34" />
          <stop offset=".38" stopColor={BRAND} stopOpacity=".42" />
          <stop offset=".72" stopColor={BRAND} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}-c3`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BRAND} stopOpacity=".2" />
          <stop offset=".3" stopColor={BRAND} stopOpacity=".28" />
          <stop offset=".55" stopColor={BRAND} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}-e2`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BRAND_LIGHT} stopOpacity=".3" />
          <stop offset=".4" stopColor={BRAND_LIGHT} stopOpacity=".22" />
          <stop offset=".72" stopColor={BRAND_LIGHT} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}-e3`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BRAND_LIGHT} stopOpacity=".26" />
          <stop offset=".3" stopColor={BRAND_LIGHT} stopOpacity=".2" />
          <stop offset=".55" stopColor={BRAND_LIGHT} stopOpacity="0" />
        </linearGradient>
      </defs>

      <circle ref={nodes.glow} cx="300" cy="300" r="270" fill={`url(#${uid}-glow)`} opacity="0" />
      {/* Back to front: the faintest card first. */}
      <path ref={nodes.k3} d={CARD_PATHS.k3} fill={`url(#${uid}-c3)`} stroke={`url(#${uid}-e3)`} strokeWidth="1.2" opacity="0" />
      <path ref={nodes.k2} d={CARD_PATHS.k2} fill={`url(#${uid}-c2)`} stroke={`url(#${uid}-e2)`} strokeWidth="1.2" opacity="0" />
      <path ref={nodes.k1} d={CARD_PATHS.k1} fill={`url(#${uid}-c1)`} stroke={BRAND_LIGHT} strokeOpacity=".3" strokeWidth="1.2" opacity="0" />
      {/* The settled mark, crossfaded in under the morph polygon. */}
      <g ref={nodes.fin} fill={BRAND} opacity="0">
        <path ref={nodes.tri} d={TRIANGLE_PATH} />
        <rect ref={nodes.stem} {...STEM_RECT} />
      </g>
      <polygon ref={nodes.poly} fill={BRAND} opacity="0" />
      <text
        ref={nodes.bh} textAnchor="end" opacity="0"
        style={{ fontFamily: WORDMARK_FONT, fontWeight: 800, fontSize: 120, letterSpacing: '-2px', fill: '#eafff5' }}
      >bh</text>
      <text
        ref={nodes.nd} textAnchor="start" opacity="0"
        style={{ fontFamily: WORDMARK_FONT, fontWeight: 800, fontSize: 120, letterSpacing: '-2px', fill: '#eafff5' }}
      >nd</text>
    </svg>
  );
}
