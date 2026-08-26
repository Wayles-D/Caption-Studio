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
 * The one thing that legitimately differs between the two targets is UNIT
 * SCALE: the CSS preview renders directly into its own small on-screen
 * phone-frame box (values are literal CSS px in that box), while the export
 * frames render into the same 1080x1920 design canvas the ASS pipeline
 * already uses (values are ASS canvas units — see FONT_SIZE_ASS_SCALE /
 * WORD_SPACING_ASS_SCALE / ASS_PLAY_RES_X/Y in captionConfig.js). Rather than
 * guess a single conversion factor for both, drawCaptionFrame (preview) and
 * drawCaptionFrameForExport (server) each resolve an explicit `geometry`
 * object in their own native units, then hand off to the SAME internal
 * renderResolvedFrame() for actual layout/painting — so the part that
 * decides how pixels get drawn is truly shared, and only the part that
 * decides how big a pixel is differs.
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
  CAPTION_POSITIONS,
  FONT_SIZE_ASS_SCALE,
  WORD_SPACING_ASS_SCALE,
  ASS_PLAY_RES_X,
  ASS_PLAY_RES_Y,
  ASS_MARGIN_L,
  ASS_MARGIN_R
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

/**
 * Resolves preview geometry: the CSS preview's own box is the canvas — no
 * unit conversion beyond devicePixelRatio (canvasWidth/cssPixelWidth).
 */
function resolvePreviewGeometry(cssConfig, params, canvasWidth, canvasHeight, cssPixelWidth) {
  const profile = cssConfig.profile;
  const pxScale = canvasWidth / (cssPixelWidth || canvasWidth);

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
 * Resolves export geometry: draws into the SAME 1080x1920 design canvas
 * (ASS_PLAY_RES_X/Y) the ASS pipeline positions itself against, scaled by
 * canvasWidth/canvasHeight — the ACTUAL output video's pixel dimensions —
 * exactly like libass scales PlayResX/Y to the real decoded frame size, so a
 * 1080x1920 upload composites 1:1 and any other resolution scales
 * proportionally per axis (matching ASS's own independent X/Y scaling).
 *
 * All raw numbers come from resolveShadowOutlineParams/CAPTION_POSITIONS —
 * the exact same values getASSStyleFromConfig itself builds the burned-in
 * subtitle style from — so this is provably the same numbers, not a second
 * guess at them.
 */
function resolveExportGeometry(cssConfig, params, canvasWidth, canvasHeight) {
  const profile = cssConfig.profile;
  const scaleX = canvasWidth / ASS_PLAY_RES_X;
  const scaleY = canvasHeight / ASS_PLAY_RES_Y;

  const feSize = parseInt(params.fontSize || '14', 10);
  const fontSizePx = feSize * FONT_SIZE_ASS_SCALE * scaleY;
  const numericWordSpacing = parseFloat(params.wordSpacing !== undefined ? params.wordSpacing : 4);
  const wordSpacingPx = numericWordSpacing * WORD_SPACING_ASS_SCALE * scaleX;
  const maxWidthPx = (ASS_PLAY_RES_X - ASS_MARGIN_L - ASS_MARGIN_R) * scaleX;
  const lineHeightPx = fontSizePx * (parseFloat(profile.lineSpacing) || 1.25);

  const shadowMode = resolveShadowMode(params);
  const shadowParams = resolveShadowOutlineParams(params, profile, false);
  const outlineWidthPx = (shadowParams.outlineSizeAss || 0) * scaleY;
  const outlineColor = params.outlineColor || profile.colors.outlineHex || '#000000';
  const hasShadow = shadowMode === 'individual' && shadowParams.shadowSizeAss > 0;
  const shadowBlurPx = shadowParams.shadowSizeAss * scaleY;
  const shadowOffsetXPx = shadowParams.shadowOffsetXAss * scaleX;
  const shadowOffsetYPx = shadowParams.shadowOffsetYAss * scaleY;
  const shadowColor = shadowParams.shadowColorHex || profile.colors.shadowHex || '#000000';

  // getASSStyleFromConfig always emits Alignment 2 (bottom-center anchor) for
  // every non-manual position preset — MarginV just moves that anchor point
  // up/down the frame, text still stacks UPWARD from it regardless of which
  // preset is chosen (see CAPTION_POSITIONS' marginV values). Manual
  // placement instead emits \an5 (true center anchor) via \pos(). Replicating
  // both exactly, rather than the CSS preview's own top/bottom-edge anchor
  // logic, is deliberate: this geometry must match the CURRENT ASS EXPORT
  // (this milestone's comparison target), not the preview.
  let anchorX, anchorY, yEdge;
  if (params.position === 'manual') {
    anchorX = (parseFloat(params.customPosX ?? 50) / 100) * canvasWidth;
    anchorY = (parseFloat(params.customPosY ?? 85) / 100) * canvasHeight;
    yEdge = 'center';
  } else {
    const posKey = params.position && CAPTION_POSITIONS[params.position] ? params.position : 'bottom';
    anchorX = canvasWidth / 2;
    anchorY = canvasHeight - (CAPTION_POSITIONS[posKey].marginV * scaleY);
    yEdge = 'bottom';
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
 * container (or, for export, the ASS style's MarginL/MarginR-constrained
 * wrap width) with manual line breaks at breakAfterIndices. Only visible
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
 * canvas's own on-screen pixel space (see resolvePreviewGeometry).
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
  const geometry = resolvePreviewGeometry(cssConfig, params, canvasWidth, canvasHeight, cssPixelWidth);
  renderResolvedFrame(ctx, { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, geometry });
}

/**
 * Draws one caption frame for server-side export, into the SAME 1080x1920
 * ASS design-canvas unit space the burned-in subtitle pipeline positions
 * itself against, scaled to the actual output video's pixel dimensions (see
 * resolveExportGeometry). Use this instead of drawCaptionFrame whenever ctx
 * is NOT a live browser <canvas> tied to an on-screen preview box.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.canvasWidth - Output video's pixel width.
 * @param {number} opts.canvasHeight - Output video's pixel height.
 * @param {object} opts.activePhrase
 * @param {number} opts.currentTime
 * @param {object} opts.cssConfig - Result of getCSSPreviewFromConfig(params) — used for colors/profile/animation only, NOT geometry.
 * @param {object} opts.params
 */
export function drawCaptionFrameForExport(ctx, opts) {
  const { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params } = opts;
  const geometry = resolveExportGeometry(cssConfig, params, canvasWidth, canvasHeight);
  renderResolvedFrame(ctx, { canvasWidth, canvasHeight, activePhrase, currentTime, cssConfig, params, geometry });
}
