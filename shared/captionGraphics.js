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
 * SCOPE: only 'sentence' caption mode, non-keyword-driven presets, non-boxed
 * (BorderStyle 1, not 3), with the 'individual' or 'none' shadow system —
 * this currently covers 'bold-yellow' and 'caps-white'. Keyword-driven
 * presets (WAYLES family, Poppins + Editorial), boxed presets ('bg-black' —
 * no box-fill/padding drawing yet), Unified Shadow, Word Mode, and Rolling
 * Stack are intentionally NOT implemented yet — canDrawCaptionFrame() below
 * returns false for anything outside this scope so callers can fall back to
 * the existing CSS/ASS renderers untouched. Widen the scope incrementally,
 * preset family by preset family, per the migration plan — not by silently
 * guessing at unimplemented styling.
 */
import {
  applyCaseTransform,
  resolveWordTextCase,
  resolveShadowOutlineParams,
  resolveShadowMode,
  FONT_SIZE_ASS_SCALE
} from './captionConfig.js';
import { resolveFontFace } from './fontRegistry.js';

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
  if (cssConfig.captionMode !== 'sentence') return false;
  if (cssConfig.keywordDriven) return false;
  if (cssConfig.shadowMode === 'unified') return false;
  if (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') return false; // boxed presets (e.g. bg-black) — no box-fill drawing yet
  return true;
}

/**
 * Presets actually verified end-to-end (preview AND export, both driven by
 * this renderer, visually compared) — see the migration plan. This is
 * intentionally a separate, narrower gate than canDrawCaptionFrame(): that
 * function describes what the renderer's CODE currently supports in
 * principle (mode/keyword/shadow/box scope), this constant describes what's
 * actually been validated enough to turn on for real users by default.
 * Widening canDrawCaptionFrame's scope (e.g. adding box-fill support) does
 * NOT, by itself, enable a preset here — add it explicitly once verified.
 */
export const GRAPHICS_RENDERER_DEFAULT_PRESETS = ['bold-yellow', 'caps-white'];

/**
 * Whether this resolved style should use the graphics renderer BY DEFAULT
 * (no opt-in flag required) — canDrawCaptionFrame's scope check, narrowed to
 * only the presets in GRAPHICS_RENDERER_DEFAULT_PRESETS. Both the preview
 * (src/js/components/preview.js) and the export gate
 * (backend/utils/graphicsFrameGenerator.js's canGenerateGraphicsFrames) call
 * this exact function, so "which presets are live" can never drift between
 * the two — change the list above once, both sides pick it up.
 *
 * @param {object} cssConfig - Result of getCSSPreviewFromConfig(params).
 */
export function isGraphicsRendererDefaultForPreset(cssConfig) {
  return canDrawCaptionFrame(cssConfig) && GRAPHICS_RENDERER_DEFAULT_PRESETS.includes(cssConfig.profile?.id);
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

  return { fontSizePx, wordSpacingPx, maxWidthPx, lineHeightPx, outlineWidthPx, outlineColor, hasShadow, shadowBlurPx, shadowOffsetXPx, shadowOffsetYPx, shadowColor, anchorX, anchorY, yEdge };
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
function renderResolvedFrame(ctx, { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, geometry }) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (!activePhrase || !activePhrase.words || !activePhrase.words.length) return;

  const profile = cssConfig.profile;
  const mode = cssConfig.animationMode;
  const keywordsEnabled = !!params.enableKeywordHighlighting && params.enableKeywordHighlighting !== 'false';
  const keywordColor = cssConfig.keywordColor || '#EF4444';
  const activeHighlight = cssConfig.highlightColor || '#FEF08A';
  const inactiveColor = cssConfig.inactiveColor || '#FFFFFF';

  const {
    fontSizePx, wordSpacingPx, maxWidthPx, lineHeightPx,
    outlineWidthPx, outlineColor, hasShadow, shadowBlurPx, shadowOffsetXPx, shadowOffsetYPx, shadowColor,
    anchorX, anchorY, yEdge
  } = geometry;

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
  if (!lines.length) return;

  const totalHeight = lines.length * lineHeightPx;
  const blockTop = yEdge === 'top' ? anchorY : yEdge === 'center' ? anchorY - totalHeight / 2 : anchorY - totalHeight;

  lines.forEach((line, lineIdx) => {
    const lineY = blockTop + lineIdx * lineHeightPx + lineHeightPx * 0.8; // ~baseline within the line box
    let cursorX = anchorX - line.width / 2;

    line.words.forEach((word) => {
      const centerX = cursorX + word.width / 2;
      ctx.save();
      ctx.font = word.font;
      ctx.textAlign = 'center';

      if (word.scale !== 1) {
        ctx.translate(centerX, lineY);
        ctx.scale(word.scale, word.scale);
        ctx.translate(-centerX, -lineY);
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
      // the word's own fill color, drawn UNDER the fill) for a bold weight
      // this font has no real bold file for — thin enough to thicken the
      // glyph rather than distort it, same technique browsers use internally.
      const emboldenWidthPx = word.syntheticBold ? fontSizePx * 0.04 : 0;

      // The shadow is a single drop-shadow behind the glyph's full rendered
      // shape (fill + outline together), so it's only drawn on whichever pass
      // paints first — the other pass runs with shadow cleared, matching how
      // a single CSS text-shadow layer sits behind both simultaneously.
      if (outlineWidthPx > 0) {
        applyShadow();
        ctx.lineWidth = outlineWidthPx;
        ctx.strokeStyle = outlineColor;
        ctx.strokeText(word.text, centerX, lineY);
        clearShadow();
        if (emboldenWidthPx > 0) {
          ctx.lineWidth = emboldenWidthPx;
          ctx.strokeStyle = word.color;
          ctx.strokeText(word.text, centerX, lineY);
        }
        ctx.fillStyle = word.color;
        ctx.fillText(word.text, centerX, lineY);
      } else {
        applyShadow();
        if (emboldenWidthPx > 0) {
          ctx.lineWidth = emboldenWidthPx;
          ctx.strokeStyle = word.color;
          ctx.strokeText(word.text, centerX, lineY);
          clearShadow();
        }
        ctx.fillStyle = word.color;
        ctx.fillText(word.text, centerX, lineY);
        clearShadow();
      }

      ctx.restore();
      cursorX += word.width + wordSpacingPx;
    });
  });
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
