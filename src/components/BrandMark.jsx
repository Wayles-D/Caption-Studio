/**
 * The bhYnd mark, still — three translucent panes receding into depth, cut by
 * the playhead. Drawn from the SAME geometry as the animated intro
 * (src/js/brand/bhyndIntro.js), so the two can never drift apart.
 *
 * Monochrome by design: everything is `currentColor`, so the mark is white on
 * the dark theme and near-black on the light one with no second asset. The
 * panes are the colour at falling opacities — the frosted-glass look of the
 * brand artwork — and the playhead is the colour at full strength.
 *
 * Gradient ids are namespaced with useId(): fill="url(#…)" is document-global,
 * and the mark can be on screen more than once.
 */
import { useId } from 'react';
import { CARD_PATHS, TRIANGLE_PATH, STEM_RECT } from '../js/brand/bhyndIntro.js';

export function BrandMark({ className = '', title }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg
      className={className}
      viewBox="128 128 344 344"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${uid}-k1`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity=".92" />
          <stop offset="1" stopColor="currentColor" stopOpacity=".58" />
        </linearGradient>
        <linearGradient id={`${uid}-k2`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity=".42" />
          <stop offset=".75" stopColor="currentColor" stopOpacity=".18" />
        </linearGradient>
        <linearGradient id={`${uid}-k3`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity=".26" />
          <stop offset=".6" stopColor="currentColor" stopOpacity=".08" />
        </linearGradient>
      </defs>
      <path d={CARD_PATHS.k3} fill={`url(#${uid}-k3)`} stroke="currentColor" strokeOpacity=".14" strokeWidth="2" />
      <path d={CARD_PATHS.k2} fill={`url(#${uid}-k2)`} stroke="currentColor" strokeOpacity=".2" strokeWidth="2" />
      <path d={CARD_PATHS.k1} fill={`url(#${uid}-k1)`} stroke="currentColor" strokeOpacity=".3" strokeWidth="2" />
      <g fill="currentColor">
        <path d={TRIANGLE_PATH} />
        <rect {...STEM_RECT} />
      </g>
    </svg>
  );
}
