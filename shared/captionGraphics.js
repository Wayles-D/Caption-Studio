/**
 * Caption Studio Graphics Renderer.
 *
 * A single Canvas2D drawing engine meant to eventually replace BOTH the
 * HTML/CSS preview and the ASS/FFmpeg export as the one place that turns a
 * resolved caption style (shared/captionConfig.js) into actual pixels. It is
 * plain Canvas2D code with no DOM or Node dependency, so the exact same
 * word-layout/draw code runs from a browser <canvas> (live preview) and from
 * a node-canvas/@napi-rs/canvas context (server-side frame generation).
 *
 * GEOMETRY: both preview and export draw into the SAME conceptual space —
 * the preview's own fixed-size phone-frame box (330x586 CSS px, see
 * src/style.css's `.phone-frame`) — just at different final pixel
 * resolutions. resolveGeometry() below computes every px-domain quantity
 * (font size, word spacing, outline, shadow, wrap width) as a proportion of
 * that box, then both drawCaptionFrame (preview) and drawCaptionFrameForExport
 * (server) scale that SAME proportion up to their own canvas's actual pixel
 * dimensions — preview via devicePixelRatio against the box's live on-screen
 * size, export via the ratio between the output video's resolution and the
 * box's fixed 330px width. This is deliberately NOT the ASS/libass design
 * canvas (1080x1920, FONT_SIZE_ASS_SCALE, etc.) — those constants encode
 * libass's own font-metrics calibration, which is irrelevant once export
 * stops going through libass for a given preset; matching the CSS preview
 * (this renderer's other output) is what "preview equals export" requires.
 * Only presets/modes canDrawCaptionFrame() accepts render this way — see
 * shared/captionConfig.js's getASSStyleFromConfig for the still-authoritative
 * ASS-domain geometry every other preset continues to use unchanged.
 *
 * SCOPE: 'sentence' mode covers non-keyword-driven, non-boxed presets with
 * the 'individual'/'none' shadow system — currently 'bold-yellow' and
 * 'caps-white' (see GRAPHICS_RENDERER_DEFAULT_PRESETS). 'rolling-stack' mode
 * (see drawRollingStackFrame/drawRollingStackFrameForExport below) covers
 * ANY preset, including keyword-driven ones — Rolling Stack inherently needs
 * distinct normal/keyword typography, resolved through the same
 * resolveWordStyleMetadata every keyword-driven sentence-mode preset already
 * uses, independent of that preset's own keywordDriven flag. Boxed
 * backgrounds ('bg-black' — no box-fill/padding drawing yet), Unified
 * Shadow, and Word Mode are intentionally NOT implemented in EITHER mode —
 * canDrawCaptionFrame() below returns false for anything outside this scope
 * so callers can fall back to the existing CSS/ASS renderers untouched.
 * Widen the scope incrementally per the migration plan — not by silently
 * guessing at unimplemented styling.
 */
import {
  applyCaseTransform,
  resolveWordTextCase,
  resolveWordStyleMetadata,
  resolveShadowOutlineParams,
  resolveShadowMode,
  resolveUnifiedShadowParams,
  applyOpacityToColor,
  FONT_SIZE_ASS_SCALE
} from './captionConfig.js';
import { resolveFontFace } from './fontRegistry.js';
import { chunkRawText } from './rollingStack.js';
import { getAnimationTransform } from './captionAnimation.js';

/**
 * Whether the graphics engine currently knows how to render this resolved
 * cssConfig. Keeping this check explicit (rather than attempting a best
 * effort draw) means an unmigrated preset/mode silently keeps using the
 * existing, already-correct CSS/ASS renderers instead of showing a wrong
 * graphics render.
 *
 * @param {object} cssConfig - Result of getCSSPreviewFromConfig(params).
 */
export function canDrawCaptionFrame(cssConfig) {
  if (!cssConfig) return false;
  if (!['sentence', 'rolling-stack'].includes(cssConfig.captionMode)) return false;
  // Keyword-driven presets are out of scope for sentence mode (still on the
  // ASS path — see the migration plan), but Rolling Stack REQUIRES keyword
  // typography to differ from normal typography regardless of the base
  // preset's own keywordDriven flag, so it's never excluded on that basis.
  if (cssConfig.keywordDriven && cssConfig.captionMode !== 'rolling-stack') return false;
  // Unified shadow: sentence mode still defers to the ASS pipeline's own
  // offscreen-composited silhouette layer (unchanged, already correct — see
  // backend/utils/ffmpeg.js). Rolling Stack's graphics renderer implements
  // Unified mode itself (see renderRollingStackResolvedFrame's own
  // offscreen-composite technique), so it's never excluded on that basis.
  if (cssConfig.shadowMode === 'unified' && cssConfig.captionMode !== 'rolling-stack') return false;
  if (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') return false; // boxed presets (e.g. bg-black) — no box-fill drawing yet
  return true;
}

/**
 * Sentence-mode presets actually verified end-to-end (preview AND export,
 * both driven by this renderer, visually compared) — see the migration
 * plan. This is intentionally a separate, narrower gate than
 * canDrawCaptionFrame(): that function describes what the renderer's CODE
 * currently supports in principle (mode/keyword/shadow/box scope), this
 * constant describes which SENTENCE-mode presets have actually been
 * validated enough to turn on for real users by default. Widening
 * canDrawCaptionFrame's scope (e.g. adding box-fill support) does NOT, by
 * itself, enable a preset here — add it explicitly once verified. Rolling
 * Stack mode doesn't use this list at all — see isGraphicsRendererDefault.
 */
export const GRAPHICS_RENDERER_DEFAULT_PRESETS = ['bold-yellow', 'caps-white'];

/**
 * Whether this resolved style should use the graphics renderer BY DEFAULT
 * (no opt-in flag required). Rolling Stack mode is always default when in
 * scope — there is no legacy rendering worth preferring over it (the
 * previous CSS/ASS Rolling Stack positioned its two layers independently
 * rather than as one bounded composition), so it isn't gated by preset.
 * Sentence mode stays gated to GRAPHICS_RENDERER_DEFAULT_PRESETS. Both the
 * preview (src/js/components/preview.js) and the export gate
 * (backend/utils/graphicsFrameGenerator.js's canGenerateGraphicsFrames) call
 * this exact function, so "what's live" can never drift between the two.
 *
 * @param {object} cssConfig - Result of getCSSPreviewFromConfig(params).
 */
export function isGraphicsRendererDefault(cssConfig) {
  if (!canDrawCaptionFrame(cssConfig)) return false;
  if (cssConfig.captionMode === 'rolling-stack') return true;
  return GRAPHICS_RENDERER_DEFAULT_PRESETS.includes(cssConfig.profile?.id);
}

function toPx(cssLength, basisPx) {
  if (cssLength == null) return null;
  if (typeof cssLength === 'number') return cssLength;
  const trimmed = String(cssLength).trim();
  if (trimmed.endsWith('%')) return (parseFloat(trimmed) / 100) * basisPx;
  if (trimmed.endsWith('px')) return parseFloat(trimmed);
  if (trimmed === 'auto') return null;
  return parseFloat(trimmed) || 0;
}

/**
 * Browsers synthesize a heavier stroke for CSS `font-weight: 800` even when
 * only a Regular file is registered for that family; @napi-rs/canvas (like
 * libass) does not — it draws exactly the registered face and nothing
 * heavier. Rather than depend on that synthesis (which the preview's DOM/CSS
 * path still gets from the browser for free), this detects the same "no real
 * bold file bundled" case via the font registry and reports it so the paint
 * step can add its own explicit synthetic-bold stroke — keeping "which font
 * file actually got used" fully explicit either way, per this project's
 * font-handling rule of never leaning on a runtime's implicit substitution.
 */
function needsSyntheticBold(fontFamilyDisplayName, fontWeightNum) {
  if (!fontFamilyDisplayName || fontWeightNum < 600) return false;
  const bold = resolveFontFace(fontFamilyDisplayName, 'bold');
  const regular = resolveFontFace(fontFamilyDisplayName, 'regular');
  return bold.file === regular.file;
}

function buildFontString({ fontFamily, fontWeight, italic, fontSizePx }) {
  const weight = fontWeight || '400';
  const style = italic ? 'italic ' : '';
  return `${style}${weight} ${fontSizePx}px '${fontFamily}'`;
}

// The preview's #subtitles-overlay element carries a base `padding: 0 20px`
// in src/style.css that getCSSPreviewFromConfig's `overlay` object never
// overrides (only position/left/top/bottom/transform/width are set inline —
// see its own comment on why: that padding is deliberately left as a
// layout-only base style, not a themeable param). The graphics engine has no
// DOM/CSS to inherit that from, so it's re-declared here as an explicit
// constant instead of guessing — if that CSS rule's value ever changes, this
// must change with it, matching how the ASS-domain constants above are kept
// in one documented place.
const OVERLAY_HORIZONTAL_PADDING_PX = 20;

// The preview's phone-frame stage is a fixed-size box in CSS px (see
// src/style.css's `.phone-frame`), regardless of the actual uploaded video's
// real resolution — every preview px-domain value (font size, word spacing,
// outline, shadow, wrap width) is authored relative to THIS box. Export
// reuses the exact same resolveGeometry() below with this as the reference
// width instead of a live DOM measurement, so "how big is a word-space
// relative to the font" is provably the same number in both places.
const PHONE_FRAME_CSS_WIDTH = 330;

/**
 * Resolves every px-domain drawing quantity as a proportion of the preview's
 * phone-frame box, then scales that proportion to the caller's actual canvas
 * via pxScale = canvasWidth / referenceCssWidth. The preview passes the
 * phone-frame's live on-screen width (so this also absorbs devicePixelRatio);
 * export passes the fixed PHONE_FRAME_CSS_WIDTH constant. Both callers are
 * otherwise identical — this is the ONE place a caption's size/spacing/shadow
 * numbers are computed, so preview and export can't drift apart by having two
 * separately-maintained formulas.
 */
function resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, referenceCssWidth) {
  const profile = cssConfig.profile;
  const pxScale = canvasWidth / (referenceCssWidth || canvasWidth);

  const fontSizePx = (parseFloat(cssConfig.text.fontSize) || 14) * pxScale;
  const wordSpacingPx = (cssConfig.wordSpacingPx || 0) * pxScale;
  const maxWidthPx = (toPx(cssConfig.overlay.width, canvasWidth) || canvasWidth * 0.9) - (OVERLAY_HORIZONTAL_PADDING_PX * 2 * pxScale);
  const lineHeightPx = fontSizePx * (parseFloat(profile.lineSpacing) || 1.25);

  const shadowMode = resolveShadowMode(params);
  const shadowParams = resolveShadowOutlineParams(params, profile, false);
  const outlineWidthPx = (shadowParams.outlineSizeAss != null ? shadowParams.outlineSizeAss / FONT_SIZE_ASS_SCALE : 0) * pxScale;
  const outlineColor = params.outlineColor || profile.colors.outlineHex || '#000000';
  const hasShadow = shadowMode === 'individual' && shadowParams.shadowSizeAss > 0;
  const shadowBlurPx = (shadowParams.shadowSizeAss / FONT_SIZE_ASS_SCALE) * pxScale;
  const shadowOffsetXPx = (shadowParams.shadowOffsetXAss / FONT_SIZE_ASS_SCALE) * pxScale;
  const shadowOffsetYPx = (shadowParams.shadowOffsetYAss / FONT_SIZE_ASS_SCALE) * pxScale;
  const shadowColor = shadowParams.shadowColorHex || profile.colors.shadowHex || '#000000';

  // getCSSPreviewFromConfig's overlay anchors: translateX(-50%) on
  // top/bottom presets (block's TOP or BOTTOM edge fixed, grows the other
  // way) and translate(-50%,-50%) on center/manual (block's CENTER fixed).
  // Percentages, so this is already resolution-independent — no scaling needed.
  const overlay = cssConfig.overlay;
  const anchorX = toPx(overlay.left, canvasWidth) ?? canvasWidth / 2;
  const isCenterTransform = overlay.transform === 'translate(-50%, -50%)';
  let anchorY, yEdge;
  if (isCenterTransform) {
    anchorY = toPx(overlay.top, canvasHeight) ?? canvasHeight / 2;
    yEdge = 'center';
  } else {
    const topPx = toPx(overlay.top, canvasHeight);
    if (topPx != null) {
      anchorY = topPx;
      yEdge = 'top';
    } else {
      const bottomPx = toPx(overlay.bottom, canvasHeight);
      anchorY = canvasHeight - (bottomPx ?? 0);
      yEdge = 'bottom';
    }
  }

  // On-canvas transform (see src/js/components/canvasTransform.js): a plain
  // degrees value, applied as a canvas rotate() around the caption block's
  // own center (computed per-mode in renderResolvedFrame/
  // renderRollingStackResolvedFrame) — never around the anchor point itself,
  // since the anchor is often a block EDGE (e.g. bottom position), not its
  // visual center, and the feature spec requires rotation around center.
  const rotationDeg = parseFloat(params.rotation) || 0;

  return { pxScale, fontSizePx, wordSpacingPx, maxWidthPx, lineHeightPx, outlineWidthPx, outlineColor, hasShadow, shadowBlurPx, shadowOffsetXPx, shadowOffsetYPx, shadowColor, anchorX, anchorY, yEdge, rotationDeg };
}

/**
 * Resolves one word's draw-time style: fill color and pop-scale, in the same
 * raw units regardless of target (colors are plain hex/rgba strings valid in
 * any Canvas2D implementation). Only handles the base active/inactive
 * highlight model (karaoke/instant color swap, pop scale, typewriter
 * reveal) — the same three branches syncVideoSubtitles() implements for
 * non-keyword-driven presets; canDrawCaptionFrame excludes keyword-driven
 * presets, which use a different, not-yet-implemented model.
 */
function resolveWordDrawSpec(word, drawCtx) {
  const { currentTime, mode, keywordsEnabled, keywordColor, activeHighlight, inactiveColor, params, profile } = drawCtx;

  const isWordActive = currentTime >= word.start && currentTime <= word.end;
  const isPastWord = currentTime > word.end;
  const isActiveKeyword = keywordsEnabled && word.isKeyword && isWordActive;

  let color = inactiveColor;
  let visible = true;
  let scale = 1;

  if (mode === 'typewriter') {
    if (!isWordActive && !isPastWord) {
      visible = false;
    } else {
      color = isWordActive ? activeHighlight : inactiveColor;
    }
  } else if (mode === 'pop') {
    if (isWordActive) {
      color = isActiveKeyword ? keywordColor : activeHighlight;
      scale = (parseFloat(params.popScale || 118) || 118) / 100;
    } else {
      color = inactiveColor;
    }
  } else {
    color = isWordActive ? (isActiveKeyword ? keywordColor : activeHighlight) : inactiveColor;
  }

  const fontWeight = (keywordsEnabled && word.isKeyword) ? '900' : profile.fontWeight;

  return { visible, color, scale, fontWeight };
}

/**
 * Lays out an already case-transformed, spec-resolved word list into
 * center-aligned lines wrapped to maxWidthPx — the canvas equivalent of the
 * CSS preview's `display:inline-block; width:90%; text-align:center`
 * container — with manual line breaks at breakAfterIndices. Only visible
 * words (typewriter's not-yet-spoken words are dropped) occupy layout space.
 */
function layoutLines(ctx, wordUnits, { maxWidthPx, wordSpacingPx, breakAfterIndices }) {
  const lines = [];
  let current = [];
  let currentWidth = 0;

  const pushLine = () => {
    if (current.length) lines.push({ words: current, width: currentWidth });
    current = [];
    currentWidth = 0;
  };

  wordUnits.forEach((unit) => {
    if (!unit.visible) return;
    ctx.font = unit.font;
    const measuredWidth = ctx.measureText(unit.text).width * unit.scale;
    const spacing = current.length ? wordSpacingPx : 0;

    if (current.length && currentWidth + spacing + measuredWidth > maxWidthPx) {
      pushLine();
    }

    current.push({ ...unit, width: measuredWidth });
    currentWidth += (current.length > 1 ? wordSpacingPx : 0) + measuredWidth;

    if (breakAfterIndices.has(unit.originalIndex)) pushLine();
  });
  pushLine();

  return lines;
}

/**
 * Shared paint step: given fully-resolved geometry (in whichever unit space
 * the caller's canvas actually is), builds the word list, wraps lines, and
 * draws fill/outline/shadow — identical for preview and export.
 */
/**
 * Pure layout step for sentence mode: resolves every word's draw spec, wraps
 * into lines, and computes the block's bounding box — no painting. Shared by
 * renderResolvedFrame (paints it) and measureSentenceFrame (just reports the
 * box, for the on-canvas selection overlay — see canvasTransform.js).
 */
function computeSentenceLines(ctx, { activePhrase, currentTime, cssConfig, params, geometry }) {
  const profile = cssConfig.profile;
  const mode = cssConfig.animationMode;
  const keywordsEnabled = !!params.enableKeywordHighlighting && params.enableKeywordHighlighting !== 'false';
  const keywordColor = cssConfig.keywordColor || '#EF4444';
  const activeHighlight = cssConfig.highlightColor || '#FEF08A';
  const inactiveColor = cssConfig.inactiveColor || '#FFFFFF';

  const { fontSizePx, wordSpacingPx, maxWidthPx, lineHeightPx, anchorX, anchorY, yEdge } = geometry;

  const breakAfterIndices = new Set(activePhrase.breakAfterIndices || []);
  const drawCtx = { currentTime, mode, keywordsEnabled, keywordColor, activeHighlight, inactiveColor, params, profile };

  const resolvedFontFamily = cssConfig.text.fontFamily.replace(/'/g, '');
  const wordUnits = activePhrase.words.map((w, idx) => {
    const spec = resolveWordDrawSpec(w, drawCtx);
    const caseForWord = resolveWordTextCase(!!w.isKeyword, keywordsEnabled, params.textCase, cssConfig.keywordTextCase);
    const text = applyCaseTransform(w.word || w.text || '', caseForWord, idx === 0);
    return {
      originalIndex: idx,
      text,
      visible: spec.visible,
      color: spec.color,
      scale: spec.scale,
      syntheticBold: needsSyntheticBold(params.fontFamily, parseInt(spec.fontWeight, 10) || 0),
      font: buildFontString({ fontFamily: resolvedFontFamily, fontWeight: spec.fontWeight, italic: false, fontSizePx })
    };
  });

  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const lines = layoutLines(ctx, wordUnits, { maxWidthPx, wordSpacingPx, breakAfterIndices });
  if (!lines.length) return null;

  const totalHeight = lines.length * lineHeightPx;
  const blockTop = yEdge === 'top' ? anchorY : yEdge === 'center' ? anchorY - totalHeight / 2 : anchorY - totalHeight;
  const blockWidth = Math.max(...lines.map((l) => l.width));

  return { lines, lineHeightPx, totalHeight, blockTop, blockWidth, centerX: anchorX, centerY: blockTop + totalHeight / 2 };
}

function renderResolvedFrame(ctx, { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, geometry }) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (!activePhrase || !activePhrase.words || !activePhrase.words.length) return;

  const {
    fontSizePx, wordSpacingPx, outlineWidthPx, outlineColor, hasShadow,
    shadowBlurPx, shadowOffsetXPx, shadowOffsetYPx, shadowColor, anchorX, rotationDeg
  } = geometry;

  const computed = computeSentenceLines(ctx, { activePhrase, currentTime, cssConfig, params, geometry });
  if (!computed) return;
  const { lines, lineHeightPx, blockTop, centerX, centerY } = computed;

  // Entrance animation (shared/captionAnimation.js) — anchored to the whole
  // PHRASE's own [start,end), not any individual word's, so it fires once
  // when the caption block first appears, independent of animationMode's
  // per-word highlight timing. Resolves to the identity transform (no-op)
  // whenever captionAnimationType is 'none', reproducing prior output exactly.
  const anim = getAnimationTransform(params, currentTime, activePhrase.start, activePhrase.end);

  ctx.save();
  // Slide offset is applied in plain screen space, BEFORE rotation, so a
  // manually-rotated caption still slides in along a straight screen-space
  // line rather than along its own tilted axis (see this module's animation
  // integration notes).
  if (anim.offsetXRatio || anim.offsetYRatio) {
    ctx.translate(anim.offsetXRatio * canvasWidth, anim.offsetYRatio * canvasHeight);
  }
  if (rotationDeg || anim.scale !== 1) {
    ctx.translate(centerX, centerY);
    if (rotationDeg) ctx.rotate((rotationDeg * Math.PI) / 180);
    if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale);
    ctx.translate(-centerX, -centerY);
  }
  ctx.globalAlpha = anim.alpha;

  lines.forEach((line, lineIdx) => {
    const lineY = blockTop + lineIdx * lineHeightPx + lineHeightPx * 0.8; // ~baseline within the line box
    let cursorX = anchorX - line.width / 2;

    line.words.forEach((word) => {
      const wordCenterX = cursorX + word.width / 2;
      paintText(ctx, word.text, wordCenterX, lineY, {
        font: word.font,
        color: word.color,
        scale: word.scale,
        syntheticBold: word.syntheticBold,
        fontSizePx,
        outlineWidthPx,
        outlineColor,
        hasShadow,
        shadowBlurPx,
        shadowOffsetXPx,
        shadowOffsetYPx,
        shadowColor
      });
      cursorX += word.width + wordSpacingPx;
    });
  });

  ctx.restore();
}

/**
 * Reports the sentence-mode caption block's bounding box + rotation, in the
 * SAME pixel space as canvasWidth/canvasHeight (backing-store px for
 * preview, output px for export) — no painting. The on-canvas transform
 * overlay (canvasTransform.js) divides x/y/width/height by
 * canvasWidth/cssPixelWidth (the same pxScale resolveGeometry already
 * computes) to get CSS px for positioning its DOM handles; it never computes
 * geometry a second way.
 *
 * @returns {{x:number,y:number,width:number,height:number,centerX:number,centerY:number,rotationDeg:number}|null}
 */
export function measureSentenceFrame(ctx, opts) {
  const { canvasWidth, canvasHeight, cssPixelWidth, activePhrase, currentTime, cssConfig, params } = opts;
  if (!activePhrase || !activePhrase.words || !activePhrase.words.length) return null;
  const geometry = resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, cssPixelWidth);
  const computed = computeSentenceLines(ctx, { activePhrase, currentTime, cssConfig, params, geometry });
  if (!computed) return null;
  return {
    x: computed.centerX - computed.blockWidth / 2,
    y: computed.blockTop,
    width: computed.blockWidth,
    height: computed.totalHeight,
    centerX: computed.centerX,
    centerY: computed.centerY,
    rotationDeg: geometry.rotationDeg,
    pxScale: geometry.pxScale
  };
}

/**
 * Low-level paint step for one run of text at one point: outline (if any) +
 * synthetic-bold embolden (if any, see needsSyntheticBold) + fill, with an
 * optional drop-shadow applied to whichever pass paints first (so it reads
 * as one shadow behind the glyph's full rendered shape, matching a single
 * CSS text-shadow layer). Shared by the sentence-mode word loop above and
 * the Rolling Stack line loop below — this is the one place glyphs actually
 * get painted, so the two layouts can never visually diverge in HOW a piece
 * of text is drawn, only in where.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x - Anchor x per ctx.textAlign (set by the caller via `font`'s caller — textAlign itself is set here to 'center').
 * @param {number} y - Baseline y.
 * @param {object} style - { font, color, scale, syntheticBold, fontSizePx, outlineWidthPx, outlineColor, hasShadow, shadowBlurPx, shadowOffsetXPx, shadowOffsetYPx, shadowColor, textAlign? }
 */
function paintText(ctx, text, x, y, style) {
  const {
    font, color, scale = 1, syntheticBold, fontSizePx,
    outlineWidthPx = 0, outlineColor, hasShadow, shadowBlurPx, shadowOffsetXPx, shadowOffsetYPx, shadowColor,
    textAlign = 'center'
  } = style;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = textAlign;

  if (scale !== 1) {
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.translate(-x, -y);
  }

  const applyShadow = () => {
    if (!hasShadow) return;
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlurPx;
    ctx.shadowOffsetX = shadowOffsetXPx;
    ctx.shadowOffsetY = shadowOffsetYPx;
  };
  const clearShadow = () => { ctx.shadowColor = 'transparent'; };
  // See needsSyntheticBold's doc comment: an explicit stand-in stroke (in
  // the text's own fill color, drawn UNDER the fill) for a bold weight this
  // font has no real bold file for — thin enough to thicken the glyph
  // rather than distort it, same technique browsers use internally.
  const emboldenWidthPx = syntheticBold ? fontSizePx * 0.04 : 0;

  if (outlineWidthPx > 0) {
    applyShadow();
    ctx.lineWidth = outlineWidthPx;
    ctx.strokeStyle = outlineColor;
    ctx.strokeText(text, x, y);
    clearShadow();
    if (emboldenWidthPx > 0) {
      ctx.lineWidth = emboldenWidthPx;
      ctx.strokeStyle = color;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  } else {
    applyShadow();
    if (emboldenWidthPx > 0) {
      ctx.lineWidth = emboldenWidthPx;
      ctx.strokeStyle = color;
      ctx.strokeText(text, x, y);
      clearShadow();
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    clearShadow();
  }

  ctx.restore();
}

/**
 * Draws one caption frame into a browser <canvas>'s 2D context, in that
 * canvas's own on-screen pixel space (see resolveGeometry).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.canvasWidth - Backing-store pixel width (device pixels).
 * @param {number} opts.canvasHeight - Backing-store pixel height (device pixels).
 * @param {number} opts.cssPixelWidth - The canvas element's on-screen CSS width (for devicePixelRatio scaling).
 * @param {object} opts.activePhrase - { words: [{word|text, start, end, isKeyword?}], breakAfterIndices? }
 * @param {number} opts.currentTime - Seconds, same clock as word.start/end.
 * @param {object} opts.cssConfig - Result of getCSSPreviewFromConfig(params).
 * @param {object} opts.params - The same raw params object passed into getCSSPreviewFromConfig.
 */
export function drawCaptionFrame(ctx, opts) {
  const { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, cssPixelWidth } = opts;
  const geometry = resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, cssPixelWidth);
  renderResolvedFrame(ctx, { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, geometry });
}

/**
 * Draws one caption frame for server-side export. Uses the exact same
 * resolveGeometry() as drawCaptionFrame, evaluated at the phone-frame's fixed
 * on-screen width (PHONE_FRAME_CSS_WIDTH) instead of a live DOM measurement —
 * see this module's doc comment for why that (not the ASS/libass design
 * canvas) is the correct reference for a preset the graphics renderer now
 * owns end-to-end. Use this instead of drawCaptionFrame whenever ctx is NOT a
 * live browser <canvas> tied to an on-screen preview box.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.canvasWidth - Output video's pixel width.
 * @param {number} opts.canvasHeight - Output video's pixel height.
 * @param {object} opts.activePhrase
 * @param {number} opts.currentTime
 * @param {object} opts.cssConfig - Result of getCSSPreviewFromConfig(params).
 * @param {object} opts.params
 */
export function drawCaptionFrameForExport(ctx, opts) {
  const { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params } = opts;
  const geometry = resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, PHONE_FRAME_CSS_WIDTH);
  renderResolvedFrame(ctx, { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, geometry });
}

/* =========================================================================
 * ROLLING STACK
 *
 * A compact, bounded composition — not independently-positioned text boxes.
 * Callers resolve WHICH chunks are on screen (shared/rollingStack.js's
 * resolveRollingStackWindow/buildRollingStackWindowSlices — Active-Word
 * Selection) and pass that array in as `windowChunks` (oldest chunk first,
 * the currently-active chunk last); everything below is purely Layout +
 * Graphics: measure each chunk's own typography, size the shared invisible
 * container to fit the widest line, stack lines inside it, paint.
 *
 * Typography per chunk comes from resolveWordStyleMetadata — the SAME
 * function every keyword-driven preset's normal/keyword styling already
 * resolves through — so normal vs keyword font/size/color/shadow/outline
 * stay fully configurable via the existing style controls; nothing about a
 * specific font pairing is hard-coded here (see this module's SCOPE note).
 *
 * No animation: metadata.animation (a transient "pop" scale some keyword
 * tiers configure) is deliberately never read below — only the STATIC
 * fontScale (the real, permanent "keyword is bigger" ratio) is applied.
 * ======================================================================= */

// Fixed "soft emphasis" shadow/outline for a keyword tier that opts into
// them (tier.hasShadow/hasOutline) — same constants
// buildKeywordShadowMetadata/buildKeywordOutlineMetadata in
// captionConfig.js encode (assDepth 3 / assWidth 3, ASS-canvas-domain,
// converted the same way every other ASS-domain number in this file is:
// divide by FONT_SIZE_ASS_SCALE for the CSS-px equivalent, then by pxScale
// for the caller's actual canvas). Re-declared here rather than imported
// because captionConfig.js's versions build CSS strings, not raw numbers.
const KEYWORD_EMPHASIS_ASS_DEPTH = 3;
const KEYWORD_EMPHASIS_BLUR_RATIO = 1.3; // matches buildKeywordShadowMetadata's own blur-vs-depth ratio
const KEYWORD_EMPHASIS_SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)';
const KEYWORD_EMPHASIS_OUTLINE_COLOR = '#000000';

// Vertical gap between stacked layers and horizontal padding for the
// implicit safe area, both expressed as a fraction of the BASE (normal-word)
// font size — mirrors the previous CSS renderer's `gap: 0.15em`, which was
// relative to the container's own (base) font-size.
const ROLLING_STACK_LAYER_GAP_RATIO = 0.15;

/**
 * Resolves one chunk's full draw spec: text, font, size, color, shadow,
 * outline — everything paintText() needs — via resolveWordStyleMetadata,
 * exactly like a keyword-driven sentence-mode preset resolves a single
 * word's style, just applied to a chunk's joined text instead.
 *
 * Shadow/outline precedence matches the CSS/ASS sentence-mode renderer
 * exactly: the keyword tier's own fixed "soft emphasis" shadow/outline
 * (opt-in per preset/user via shadowByDefault/outlineByDefault or the
 * Keyword Shadow/Outline toggles — see resolveWordStyleMetadata) OVERRIDES
 * the real shadow/outline for that one chunk when present; every other
 * chunk uses the real, user-configurable Shadow/Outline sliders
 * (geometry.hasShadow/outlineWidthPx etc., resolved once for the whole
 * frame in resolveGeometry) — never a fixed value. This is what actually
 * wires the Shadow Mode/Size/Color/Offset controls into Rolling Stack;
 * emphasisOffsetPx below is ONLY the small fixed keyword-emphasis effect,
 * not a substitute for those controls.
 */
function resolveRollingStackChunkSpec(chunk, isCurrent, cssConfig, params, geometry) {
  const profile = cssConfig.profile;
  const keywordsEnabled = !!params.enableKeywordHighlighting && params.enableKeywordHighlighting !== 'false';
  const activeHighlight = cssConfig.highlightColor || '#FEF08A';
  const inactiveColor = cssConfig.inactiveColor || '#FFFFFF';

  const caseForChunk = resolveWordTextCase(chunk.type === 'keyword', keywordsEnabled, params.textCase, cssConfig.keywordTextCase);
  const text = applyCaseTransform(chunkRawText(chunk), caseForChunk, true);

  const metadata = resolveWordStyleMetadata(
    { isKeyword: chunk.type === 'keyword' },
    {
      keywordStyleConfig: cssConfig.keywordStyleConfig,
      keywordsEnabled,
      activeHighlightEnabled: cssConfig.activeHighlightEnabled,
      isWordActive: isCurrent,
      mode: 'karaoke', // never 'pop' — see this section's "No animation" note; metadata.animation is never read below regardless
      activeHighlightColorHex: activeHighlight,
      inactiveColorHex: inactiveColor,
      baseFontFamily: profile.fontFamily,
      baseFontWeight: profile.fontWeight
    }
  );

  // Matches the CSS Rolling Stack renderer's own opacity composition exactly
  // (see preview.js's buildRollingStackLineElement): global text opacity only
  // ever applies to keyword chunks, composed with the dedicated Keyword
  // Opacity control; normal chunks are unaffected by either.
  const opacity = metadata.isKeyword
    ? (params.textOpacity ?? 100) * (cssConfig.keywordStyleConfig.opacity ?? 100) / 100
    : 100;

  const fontFamily = (metadata.fontFamily || profile.fontFamily || 'Poppins').toString();
  const fontWeight = metadata.fontWeight || profile.fontWeight;
  const fontSizePx = geometry.fontSizePx * (metadata.fontScale || 1);

  const emphasisOffsetPx = (KEYWORD_EMPHASIS_ASS_DEPTH / FONT_SIZE_ASS_SCALE) * geometry.pxScale;

  const useEmphasisOutline = !!metadata.outline;
  const useEmphasisShadow = !!metadata.shadow;

  return {
    text,
    fontSizePx,
    font: buildFontString({ fontFamily, fontWeight, italic: metadata.italic, fontSizePx }),
    color: applyOpacityToColor(metadata.colorHex, opacity),
    syntheticBold: needsSyntheticBold(fontFamily, parseInt(fontWeight, 10) || 0),
    outlineWidthPx: useEmphasisOutline ? emphasisOffsetPx : geometry.outlineWidthPx,
    outlineColor: useEmphasisOutline ? KEYWORD_EMPHASIS_OUTLINE_COLOR : geometry.outlineColor,
    // geometry.hasShadow already reflects the real Shadow Mode (only true
    // when Individual mode + Shadow Size > 0 — see resolveGeometry) so this
    // naturally stays off in Unified/None mode unless the keyword-emphasis
    // override kicks in; Unified mode's own whole-composition shadow is
    // applied separately, once, by renderRollingStackResolvedFrame.
    hasShadow: useEmphasisShadow || geometry.hasShadow,
    shadowBlurPx: useEmphasisShadow ? emphasisOffsetPx * KEYWORD_EMPHASIS_BLUR_RATIO : geometry.shadowBlurPx,
    shadowOffsetXPx: useEmphasisShadow ? emphasisOffsetPx : geometry.shadowOffsetXPx,
    shadowOffsetYPx: useEmphasisShadow ? emphasisOffsetPx : geometry.shadowOffsetYPx,
    shadowColor: useEmphasisShadow ? KEYWORD_EMPHASIS_SHADOW_COLOR : geometry.shadowColor
  };
}

/**
 * Computes layout (line widths/heights, container size, per-line x/y) for a
 * window of chunks — pure math, no drawing, shared by both the direct-paint
 * path (None/Individual shadow mode) and the offscreen-composite path
 * (Unified mode, see renderRollingStackResolvedFrame).
 */
function layoutRollingStackLines(ctx, windowChunks, cssConfig, params, geometry, alignment) {
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  const layerGapPx = geometry.fontSizePx * ROLLING_STACK_LAYER_GAP_RATIO;

  const lines = windowChunks.map((chunk, idx) => {
    const isCurrent = idx === windowChunks.length - 1;
    const spec = resolveRollingStackChunkSpec(chunk, isCurrent, cssConfig, params, geometry);
    ctx.font = spec.font;
    const width = ctx.measureText(spec.text).width;
    const lineHeightPx = spec.fontSizePx * (parseFloat(cssConfig.profile.lineSpacing) || 1.25);
    return { ...spec, width, lineHeightPx };
  });

  const containerWidth = Math.max(...lines.map((l) => l.width));
  const totalHeight = lines.reduce((sum, l) => sum + l.lineHeightPx, 0) + layerGapPx * (lines.length - 1);

  const { anchorX, anchorY, yEdge } = geometry;
  const blockTop = yEdge === 'top' ? anchorY : yEdge === 'center' ? anchorY - totalHeight / 2 : anchorY - totalHeight;

  const textAlign = alignment === 'left' || alignment === 'right' ? alignment : 'center';
  const lineX = alignment === 'left' ? anchorX - containerWidth / 2
    : alignment === 'right' ? anchorX + containerWidth / 2
    : anchorX;

  let cursorY = blockTop;
  const positionedLines = lines.map((line) => {
    const lineY = cursorY + line.lineHeightPx * 0.8; // ~baseline within the line box
    cursorY += line.lineHeightPx + layerGapPx;
    return { ...line, x: lineX, y: lineY, textAlign };
  });

  // Horizontal bbox center is anchorX regardless of `alignment`: left/right
  // alignment offset lineX by +/- containerWidth/2 from anchorX specifically
  // so the CONTAINER (not the text-drawing anchor) stays centered on anchorX
  // — see this function's lineX branches. That's what makes a single
  // rotation-center formula correct for all three alignments.
  return {
    lines: positionedLines,
    blockWidth: containerWidth,
    blockTop,
    totalHeight,
    centerX: anchorX,
    centerY: blockTop + totalHeight / 2
  };
}

function paintRollingStackLines(ctx, positionedLines) {
  positionedLines.forEach((line) => {
    paintText(ctx, line.text, line.x, line.y, line);
  });
}

/**
 * Shared layout+paint step: given an already-resolved window of chunks
 * (oldest first, current last), lays them out as one bounded, top-aligned
 * stack — container width = the widest line, lines share a common left
 * edge/center/right edge per `alignment`, vertical position follows the
 * SAME anchor/yEdge geometry (position setting) sentence mode uses — then
 * paints each line via the shared paintText(). Nothing here decides WHICH
 * chunks are active; that's entirely the caller's job (Active-Word
 * Selection, see shared/rollingStack.js), keeping this purely Layout+Graphics.
 *
 * Unified shadow mode is handled here rather than per-line: the whole
 * composition is first painted onto an offscreen canvas with no shadow, then
 * that ONE offscreen image is drawn onto the real canvas with a single
 * drop-shadow — producing one combined silhouette-shaped shadow behind the
 * entire composition (not one blurred copy per line/word, which would show
 * visible gaps at larger blur radii — the same reason burnSubtitles' Unified
 * Shadow composites a whole silhouette track rather than per-glyph, see
 * backend/utils/ffmpeg.js). Requires `createOffscreenCanvas` — supplied by
 * the caller since this module has no DOM/Node canvas-construction of its
 * own (see this file's module doc). Falls back to drawing without a shadow
 * if it isn't provided, rather than silently guessing at one.
 */
function renderRollingStackResolvedFrame(ctx, { canvasWidth, canvasHeight, windowChunks, currentTime, cssConfig, params, geometry, alignment, createOffscreenCanvas }) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (!windowChunks || !windowChunks.length) return;

  const shadowMode = resolveShadowMode(params);

  const { rotationDeg } = geometry;
  const applyRotation = (targetCtx, centerX, centerY) => {
    if (!rotationDeg) return;
    targetCtx.translate(centerX, centerY);
    targetCtx.rotate((rotationDeg * Math.PI) / 180);
    targetCtx.translate(-centerX, -centerY);
  };

  // Entrance animation (shared/captionAnimation.js), anchored to the CURRENT
  // (last/active) chunk's own [start,end) — Rolling Stack's window changes
  // exactly when the active chunk changes (see shared/rollingStack.js), so
  // "this chunk's start" is the moment the composition now on screen first
  // appeared. Per this feature's spec, animation treats the whole composited
  // stack as ONE visual unit (Rolling Stack's own layout is never touched by
  // it) — it fires once per window change, not once per word/line.
  const activeChunk = windowChunks[windowChunks.length - 1];
  const anim = getAnimationTransform(params, currentTime, activeChunk.start, activeChunk.end);
  const animating = anim.alpha !== 1 || anim.scale !== 1 || anim.offsetXRatio !== 0 || anim.offsetYRatio !== 0;

  const paintComposite = (targetCtx, drawIntoCtx) => {
    const layout = layoutRollingStackLines(targetCtx, windowChunks, cssConfig, params, geometry, alignment);
    targetCtx.save();
    applyRotation(targetCtx, layout.centerX, layout.centerY);
    drawIntoCtx(targetCtx, layout);
    targetCtx.restore();
    return layout;
  };

  if (shadowMode === 'unified' && createOffscreenCanvas) {
    const offscreen = createOffscreenCanvas(canvasWidth, canvasHeight);
    const offCtx = offscreen.getContext('2d');
    const layout = paintComposite(offCtx, (c, l) => paintRollingStackLines(c, l.lines));

    // The offscreen canvas already contains the rotated composition (rotated
    // while painting, above) — drawImage below is a plain, unrotated pixel
    // copy, so the shadow/animation transform it casts/applies is the
    // correctly-rotated silhouette too.
    const uni = resolveUnifiedShadowParams(params);
    const textOpacity = params.textOpacity ?? 100;
    ctx.save();
    if (anim.offsetXRatio || anim.offsetYRatio) {
      ctx.translate(anim.offsetXRatio * canvasWidth, anim.offsetYRatio * canvasHeight);
    }
    if (anim.scale !== 1) {
      ctx.translate(layout.centerX, layout.centerY);
      ctx.scale(anim.scale, anim.scale);
      ctx.translate(-layout.centerX, -layout.centerY);
    }
    ctx.globalAlpha = anim.alpha;
    ctx.shadowColor = applyOpacityToColor(uni.colorHex, (uni.opacity * textOpacity) / 100);
    ctx.shadowBlur = (uni.blurAss / FONT_SIZE_ASS_SCALE) * geometry.pxScale;
    ctx.shadowOffsetX = (uni.offsetXAss / FONT_SIZE_ASS_SCALE) * geometry.pxScale;
    ctx.shadowOffsetY = (uni.offsetYAss / FONT_SIZE_ASS_SCALE) * geometry.pxScale;
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
    return;
  }

  if (animating && createOffscreenCanvas) {
    // Individual/None shadow mode: still composite to an offscreen canvas
    // while animating so the WHOLE stack (already-correct per-chunk
    // shadows/outlines included) moves/fades/scales as one unit rather than
    // each line independently — see this function's animation doc comment.
    // Skipped entirely when not animating (anim === identity), so the
    // ordinary direct-paint path below stays byte-for-byte the same as
    // before this feature existed whenever captionAnimationType is 'none'.
    const offscreen = createOffscreenCanvas(canvasWidth, canvasHeight);
    const offCtx = offscreen.getContext('2d');
    const layout = paintComposite(offCtx, (c, l) => paintRollingStackLines(c, l.lines));

    ctx.save();
    if (anim.offsetXRatio || anim.offsetYRatio) {
      ctx.translate(anim.offsetXRatio * canvasWidth, anim.offsetYRatio * canvasHeight);
    }
    if (anim.scale !== 1) {
      ctx.translate(layout.centerX, layout.centerY);
      ctx.scale(anim.scale, anim.scale);
      ctx.translate(-layout.centerX, -layout.centerY);
    }
    ctx.globalAlpha = anim.alpha;
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
    return;
  }

  paintComposite(ctx, (c, l) => paintRollingStackLines(c, l.lines));
}

/**
 * Reports the Rolling Stack composition's bounding box + rotation, in the
 * SAME pixel space as canvasWidth/canvasHeight — no painting. Counterpart to
 * measureSentenceFrame for the on-canvas transform overlay.
 */
export function measureRollingStackFrame(ctx, opts) {
  const { canvasWidth, canvasHeight, cssPixelWidth, windowChunks, cssConfig, params, alignment } = opts;
  if (!windowChunks || !windowChunks.length) return null;
  const geometry = resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, cssPixelWidth);
  const layout = layoutRollingStackLines(ctx, windowChunks, cssConfig, params, geometry, alignment);
  return {
    x: layout.centerX - layout.blockWidth / 2,
    y: layout.blockTop,
    width: layout.blockWidth,
    height: layout.totalHeight,
    centerX: layout.centerX,
    centerY: layout.centerY,
    rotationDeg: geometry.rotationDeg,
    pxScale: geometry.pxScale
  };
}

/**
 * Draws one Rolling Stack frame into a browser <canvas>, in that canvas's
 * own on-screen pixel space — preview counterpart to drawCaptionFrame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.canvasWidth
 * @param {number} opts.canvasHeight
 * @param {number} opts.cssPixelWidth
 * @param {Array} opts.windowChunks - Output of resolveRollingStackWindow (shared/rollingStack.js), oldest first, current last.
 * @param {number} opts.currentTime - Seconds; used to resolve the entrance-animation progress for the active chunk (see shared/captionAnimation.js).
 * @param {object} opts.cssConfig - Result of getCSSPreviewFromConfig(params).
 * @param {object} opts.params
 * @param {'left'|'center'|'right'} [opts.alignment='center']
 * @param {(w:number,h:number)=>*} [opts.createOffscreenCanvas] - Required for Unified shadow mode, and whenever an entrance animation is active; see renderRollingStackResolvedFrame.
 */
export function drawRollingStackFrame(ctx, opts) {
  const { canvasWidth, canvasHeight, cssPixelWidth, windowChunks, currentTime, cssConfig, params, alignment, createOffscreenCanvas } = opts;
  const geometry = resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, cssPixelWidth);
  renderRollingStackResolvedFrame(ctx, { canvasWidth, canvasHeight, windowChunks, currentTime, cssConfig, params, geometry, alignment, createOffscreenCanvas });
}

/**
 * Draws one Rolling Stack frame for server-side export — export counterpart
 * to drawCaptionFrameForExport, same PHONE_FRAME_CSS_WIDTH reference.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.canvasWidth
 * @param {number} opts.canvasHeight
 * @param {Array} opts.windowChunks - Output of resolveRollingStackWindow/buildRollingStackWindowSlices (shared/rollingStack.js).
 * @param {object} opts.cssConfig
 * @param {object} opts.params
 * @param {'left'|'center'|'right'} [opts.alignment='center']
 * @param {(w:number,h:number)=>*} [opts.createOffscreenCanvas] - Required for Unified shadow mode; see renderRollingStackResolvedFrame.
 */
export function drawRollingStackFrameForExport(ctx, opts) {
  const { canvasWidth, canvasHeight, windowChunks, currentTime, cssConfig, params, alignment, createOffscreenCanvas } = opts;
  const geometry = resolveGeometry(cssConfig, params, canvasWidth, canvasHeight, PHONE_FRAME_CSS_WIDTH);
  renderRollingStackResolvedFrame(ctx, { canvasWidth, canvasHeight, windowChunks, currentTime, cssConfig, params, geometry, alignment, createOffscreenCanvas });
}
