/**
 * Caption Studio Central Shared Caption Configuration Schema
 * Single source of truth for creator profiles, animation modes, font scaling, positions, colors, and styling rules.
 * Shared across both Frontend workspace preview and Backend ASS subtitle generator.
 */

export const ANIMATION_MODES = {
  karaoke: {
    id: 'karaoke',
    name: 'Progressive Karaoke',
    description: 'Words highlight progressively as they are spoken, remaining visible in secondary color.'
  },
  pop: {
    id: 'pop',
    name: 'Pop / Scale Highlight',
    description: 'Active word pops up with scale transformation and highlight color.'
  },
  instant: {
    id: 'instant',
    name: 'Instant CapCut Style',
    description: 'Full phrase renders immediately; active word swaps highlight color with sharp contrast.'
  },
  typewriter: {
    id: 'typewriter',
    name: 'Typewriter Reveal',
    description: 'Words reveal one by one as they are spoken; future words remain hidden.'
  }
};

export const CREATOR_PROFILES = {
  'bold-yellow': {
    id: 'bold-yellow',
    name: 'Bold Yellow',
    fontFamily: 'Montserrat',
    fontWeight: '800',
    fontSize: 14,
    defaultAnimationMode: 'karaoke',
    colors: {
      primaryHex: '#FEF08A',       // Active Yellow
      secondaryHex: '#FFFFFF',     // Inactive White
      outlineHex: '#000000',       // Black Outline
      backHex: 'transparent',
      shadowHex: '#000000',
      assPrimary: '&H0000FFFF',    // Yellow
      assSecondary: '&H00FFFFFF',  // White
      assOutline: '&H00000000',    // Black
      assBack: '&H00000000'
    },
    outlineSize: 6,
    shadowSize: 0,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    useNativeStroke: true,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#FEF08A',
    cssInactiveColor: '#FFFFFF'
  },
  'caps-white': {
    id: 'caps-white',
    name: 'Caps White',
    fontFamily: 'Montserrat',
    fontWeight: '800',
    fontSize: 14,
    defaultAnimationMode: 'pop',
    colors: {
      primaryHex: '#FFFFFF',
      secondaryHex: '#FFFFFF',
      outlineHex: '#000000',
      backHex: 'transparent',
      shadowHex: '#000000',
      assPrimary: '&H00FFFFFF',    // Active White
      assSecondary: '&H50FFFFFF',  // Semi-transparent White
      assOutline: '&H00000000',    // Black
      assBack: '&H00000000'
    },
    outlineSize: 6,
    shadowSize: 0,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    useNativeStroke: true,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#FFFFFF',
    cssInactiveColor: 'rgba(255, 255, 255, 0.65)'
  },
  'bg-black': {
    id: 'bg-black',
    name: 'Boxed Black',
    fontFamily: 'Montserrat',
    fontWeight: '700',
    fontSize: 14,
    defaultAnimationMode: 'instant',
    colors: {
      primaryHex: '#FFFFFF',
      secondaryHex: '#FFFFFF',
      outlineHex: '#000000',
      backHex: 'rgba(0, 0, 0, 0.75)',
      shadowHex: '#000000',
      assPrimary: '&H0000FFFF',    // Active Yellow
      assSecondary: '&H00FFFFFF',  // Inactive White
      assOutline: '&H00000000',    // Black Outline
      assBack: '&H90000000'       // Semi-transparent black box
    },
    outlineSize: 0,
    shadowSize: 0,
    borderStyle: 3,
    boxPaddingPx: 12,
    wordSpacing: '0.25em',
    lineSpacing: '1.3',
    phraseSpacing: '6px 12px',
    useNativeStroke: false,
    cssBackground: 'rgba(0, 0, 0, 0.75)',
    cssBorderRadius: '6px',
    cssHighlightColor: '#FEF08A',
    cssInactiveColor: '#FFFFFF'
  },
  'gradient-glow': {
    id: 'gradient-glow',
    name: 'Gradient Glow',
    fontFamily: 'Bebas Neue',
    fontWeight: '900',
    fontSize: 16,
    defaultAnimationMode: 'karaoke',
    colors: {
      primaryHex: '#38BDF8',
      secondaryHex: '#FFFFFF',
      outlineHex: '#3F003F',
      backHex: '#FF00FF',
      shadowHex: '#818CF8',
      assPrimary: '&H00FFFF00',    // Active Cyan
      assSecondary: '&H00F88C81',  // Inactive Soft Blue-Purple
      assOutline: '&H003F003F',    // Dark Purple
      assBack: '&H00FF00FF'       // Purple Glow
    },
    outlineSize: 7,
    shadowSize: 3,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.2em',
    lineSpacing: '1.2',
    phraseSpacing: '0 4px',
    useNativeStroke: false,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#38BDF8',
    cssInactiveColor: '#818CF8'
  }
};

// Backwards compatibility mapping for legacy code referencing CAPTION_PRESETS
export const CAPTION_PRESETS = CREATOR_PROFILES;

export const CAPTION_POSITIONS = {
  top: {
    marginV: 1600,
    cssTop: '10%',
    cssBottom: 'auto',
    cssTransform: 'translateX(-50%)'
  },
  center: {
    marginV: 960,
    cssTop: '50%',
    cssBottom: 'auto',
    cssTransform: 'translate(-50%, -50%)'
  },
  bottom: {
    marginV: 300,
    cssTop: 'auto',
    cssBottom: '12%',
    cssTransform: 'translateX(-50%)'
  }
};

/**
 * Applies the selected text-case transform to a single caption text unit
 * (a whole phrase or a single word). This is the single source of truth for
 * casing — both the live CSS/HTML preview and the ASS/FFmpeg export call
 * this exact function so a preset always exports with the same casing shown
 * on screen.
 *
 * @param {string} text - Raw text (word or full phrase), untransformed.
 * @param {string} textCase - 'uppercase' | 'lowercase' | anything else (sentence case).
 * @param {boolean} [isSentenceStart=true] - Whether this unit starts the sentence/phrase.
 *   Only relevant for sentence case: the sentence-starting word/phrase gets its
 *   first letter capitalized, every other unit is lowercased.
 * @returns {string} Transformed text.
 */
export function applyCaseTransform(text, textCase, isSentenceStart = true) {
  if (!text) return text;
  switch (textCase) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    default:
      return isSentenceStart
        ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
        : text.toLowerCase();
  }
}

/**
 * Converts a CSS Hex/RGBA color string to standard ASS BGR color format (&HAABBGGRR&).
 * Note: ASS uses BGR byte ordering and inverted alpha (00 = opaque, FF = transparent).
 * 
 * @param {string} hex - Hex color string (e.g. #FEF08A or #FEF08AFF).
 * @param {string} defaultHex - Fallback hex if input is invalid.
 * @returns {string} Formatted ASS BGR color string (e.g. &H008AF0FE).
 */
export function hexToASSColor(hex, defaultHex = '#FFFFFF') {
  if (!hex || typeof hex !== 'string') hex = defaultHex;
  let clean = hex.trim().replace(/^#/, '');

  // Transparent string check
  if (clean === 'transparent' || clean === 'none') {
    return '&HFF000000'; // 100% transparent
  }
  
  let r = 'FF', g = 'FF', b = 'FF', a = '00';
  
  if (clean.length === 3) {
    r = clean[0] + clean[0];
    g = clean[1] + clean[1];
    b = clean[2] + clean[2];
  } else if (clean.length === 6) {
    r = clean.substring(0, 2);
    g = clean.substring(2, 4);
    b = clean.substring(4, 6);
  } else if (clean.length === 8) {
    r = clean.substring(0, 2);
    g = clean.substring(2, 4);
    b = clean.substring(4, 6);
    const alphaHex = clean.substring(6, 8);
    const alphaNum = parseInt(alphaHex, 16);
    // ASS alpha is inverted: 0 = opaque, 255 = transparent
    const assAlpha = Math.max(0, Math.min(255, 255 - alphaNum));
    a = assAlpha.toString(16).padStart(2, '0').toUpperCase();
  }
  
  return `&H${a}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

// Matches the existing word-spacing/box-padding ASS<->CSS px conversion
// factor, reused here so outline/shadow size and offset sliders resolve to
// the same effective size in both the CSS preview and the ASS export.
const ASS_TO_CSS_SCALE = 1.5;

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Converts a 0-100 opacity percentage into an ASS alpha byte (2 hex digits).
 * ASS alpha is inverted vs CSS: 00 = fully opaque, FF = fully transparent.
 */
export function opacityToAssAlpha(opacityPercent = 100) {
  const clamped = Math.max(0, Math.min(100, parseFloat(opacityPercent)));
  const assAlphaNum = Math.round((100 - clamped) / 100 * 255);
  return assAlphaNum.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Overwrites the alpha byte of an already-resolved &HAABBGGRR ASS color
 * string, preserving its BGR channels. Lets text/background opacity apply on
 * top of a color that's already been through hexToASSColor.
 */
function withAssAlpha(assColorStr, alphaHex) {
  if (!assColorStr) return assColorStr;
  const clean = assColorStr.replace(/^&H/i, '').replace(/&$/, '').padStart(8, '0');
  const bgr = clean.substring(2, 8);
  return `&H${alphaHex}${bgr}`;
}

/**
 * Applies an opacity percentage to a CSS color (#hex or rgb()/rgba()),
 * multiplying into any alpha the color already carries. At 100% opacity the
 * input is returned completely untouched, so this is a no-op for every
 * existing preset/override until a caller actually moves an opacity slider
 * away from its default.
 */
export function applyOpacityToColor(color, opacityPercent = 100) {
  const clamped = Math.max(0, Math.min(100, parseFloat(opacityPercent)));
  if (!color || typeof color !== 'string' || clamped >= 100) return color;
  if (color === 'transparent' || color === 'none') return color;

  const alpha = clamped / 100;

  const rgbaMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((s) => s.trim());
    const [r, g, b] = parts;
    const existingAlpha = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
    return `rgba(${r}, ${g}, ${b}, ${round2(existingAlpha * alpha)})`;
  }

  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let clean = hexMatch[1];
    if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${round2(alpha)})`;
  }

  return color;
}

/**
 * Resolves outline width, shadow color/size/offset, and text/background
 * opacity from client params + the active preset — the single place both
 * getASSStyleFromConfig and getCSSPreviewFromConfig read these from, so a
 * slider always produces the same effective value in both renderers.
 *
 * @param {object} params - Client style params.
 * @param {object} profile - The resolved creator profile.
 * @param {boolean} isBoxed - Whether the caption currently renders as a box
 *   (see resolveBoxState) — box mode repurposes the ASS Outline field for
 *   padding, so a distinct text-outline width only applies when unboxed.
 */
function resolveShadowOutlineParams(params, profile, isBoxed) {
  const outlineSizeAss = isBoxed
    ? null
    : (params.outlineSize != null ? parseInt(params.outlineSize, 10) : profile.outlineSize);

  const shadowSizeAss = params.shadowSize != null ? parseInt(params.shadowSize, 10) : profile.shadowSize;
  const shadowColorHex = params.shadowColor || profile.colors.shadowHex || '#000000';

  // Undefined offsets default to a symmetric diagonal offset of shadowSizeAss
  // in both axes — exactly what ASS's native Shadow field already does with
  // no override tags, so an untouched caption needs no \xshad/\yshad emitted.
  const hasCustomOffsetX = params.shadowOffsetX != null;
  const hasCustomOffsetY = params.shadowOffsetY != null;
  const shadowOffsetXAss = hasCustomOffsetX ? parseFloat(params.shadowOffsetX) : shadowSizeAss;
  const shadowOffsetYAss = hasCustomOffsetY ? parseFloat(params.shadowOffsetY) : shadowSizeAss;

  const textOpacity = params.textOpacity != null ? Math.max(0, Math.min(100, parseFloat(params.textOpacity))) : 100;
  const backgroundOpacity = params.backgroundOpacity != null ? Math.max(0, Math.min(100, parseFloat(params.backgroundOpacity))) : null;

  return {
    outlineSizeAss,
    shadowSizeAss,
    shadowColorHex,
    shadowOffsetXAss,
    shadowOffsetYAss,
    hasCustomShadowOffset: hasCustomOffsetX || hasCustomOffsetY,
    textOpacity,
    backgroundOpacity
  };
}

/**
 * Maps input style parameters to resolved ASS style parameters.
 * Supports custom color overrides, wordSpacing, popScale, and animation settings.
 * 
 * @param {object} params - Options passed from client.
 * @returns {object} Resolved ASS parameters.
 */
export function getASSStyleFromConfig(params = {}) {
  let fontName = 'Montserrat SemiBold';
  if (params.fontFamily) {
    fontName = params.fontFamily.replace(/['"\r\n]/g, '').split(',')[0].trim();
  }

  const feSize = parseInt(params.fontSize || '14', 10);
  const fontSize = Math.round(feSize * 5.14);

  const posKey = params.position === 'manual' ? 'manual' : (params.position && CAPTION_POSITIONS[params.position] ? params.position : 'bottom');
  const marginV = posKey === 'manual' ? CAPTION_POSITIONS.bottom.marginV : CAPTION_POSITIONS[posKey].marginV;

  // Manual mode overrides both the alignment anchor and the position entirely
  // via an inline \pos() tag, matching the CSS preview's left/top % + centered
  // transform anchor point exactly (both anchor at the same relative point).
  const posOverrideTag = posKey === 'manual'
    ? `\\an5\\pos(${Math.round((parseFloat(params.customPosX ?? 50) / 100) * 1080)},${Math.round((parseFloat(params.customPosY ?? 85) / 100) * 1920)})`
    : null;

  const presetKey = params.preset && CREATOR_PROFILES[params.preset] ? params.preset : 'bold-yellow';
  const profile = CREATOR_PROFILES[presetKey];

  const animationMode = params.animationMode && ANIMATION_MODES[params.animationMode]
    ? params.animationMode
    : profile.defaultAnimationMode || 'karaoke';

  // Custom Color Overrides or Profile Defaults
  let primaryColor = params.activeWordColor
    ? hexToASSColor(params.activeWordColor, profile.colors.primaryHex)
    : profile.colors.assPrimary;

  let secondaryColor = params.inactiveWordColor
    ? hexToASSColor(params.inactiveWordColor, profile.colors.secondaryHex)
    : profile.colors.assSecondary;

  // AI Keyword Highlighting: dedicated colors for active high/medium importance
  // keyword words. Disabled by default resolution stays the same regardless —
  // callers gate on enableKeywordHighlighting before applying these.
  const enableKeywordHighlighting = params.enableKeywordHighlighting !== false && params.enableKeywordHighlighting !== 'false';
  let keywordHighColor = hexToASSColor(params.keywordColorHigh || '#EF4444', '#EF4444');
  let keywordMediumColor = hexToASSColor(params.keywordColorMedium || '#FB923C', '#FB923C');

  let outlineColor = params.outlineColor
    ? hexToASSColor(params.outlineColor, profile.colors.outlineHex)
    : profile.colors.assOutline;

  let backColor = params.backgroundColor
    ? hexToASSColor(params.backgroundColor, profile.colors.backHex)
    : profile.colors.assBack;

  // Word spacing conversion (scaled to 1080p canvas)
  const numericWordSpacing = parseFloat(params.wordSpacing !== undefined ? params.wordSpacing : 4);
  const assSpacing = Math.round(numericWordSpacing * 1.5); // Spacing in ASS canvas pixels

  // Advanced Animation Controls
  const popScale = parseFloat(params.popScale || 118);

  // Box mode + padding: single source of truth shared with getCSSPreviewFromConfig.
  // A custom background color always implies box mode, even on a preset that
  // doesn't box by default; the box padding then falls back to a sensible default.
  const { isBoxed, boxPaddingPx } = resolveBoxState(params, profile);
  const borderStyle = isBoxed ? 3 : profile.borderStyle;

  // Outline width, shadow color/size/offset, and opacity — resolved once,
  // shared with getCSSPreviewFromConfig so a slider always produces the same
  // effective value in both the ASS export and the CSS preview.
  const shadowParams = resolveShadowOutlineParams(params, profile, isBoxed);

  // Outline field doubles as box padding under BorderStyle 3; otherwise it's real text-outline width.
  const outlineSize = isBoxed
    ? Math.round(boxPaddingPx * 1.5) // scaled to ASS canvas pixels, matching word spacing's scale factor
    : shadowParams.outlineSizeAss;

  // Text opacity fades the glyph fill, outline, and keyword colors uniformly
  // (matching the CSS preview's per-word/text-layer opacity); background
  // opacity is independent so a boxed caption's fill can fade on its own.
  const textOpacityAlpha = opacityToAssAlpha(shadowParams.textOpacity);
  primaryColor = withAssAlpha(primaryColor, textOpacityAlpha);
  secondaryColor = withAssAlpha(secondaryColor, textOpacityAlpha);
  outlineColor = withAssAlpha(outlineColor, textOpacityAlpha);
  keywordHighColor = withAssAlpha(keywordHighColor, textOpacityAlpha);
  keywordMediumColor = withAssAlpha(keywordMediumColor, textOpacityAlpha);

  if (shadowParams.backgroundOpacity != null) {
    backColor = withAssAlpha(backColor, opacityToAssAlpha(shadowParams.backgroundOpacity));
  }

  // ASS has no dedicated shadow-color style column (the Shadow column is only
  // a depth/blur number) — shadow color is instead set per-Dialogue-event via
  // the \4a\4c override tags (see assWriter.js), so it stays independent of
  // BackColour (which the box-fill uses under BorderStyle 3).
  const shadowColor = withAssAlpha(
    hexToASSColor(shadowParams.shadowColorHex, profile.colors.shadowHex || '#000000'),
    textOpacityAlpha
  );

  // ASS only supports a boolean Bold flag (no numeric weight) — derive it from
  // the same fontWeight the CSS preview uses so both sides agree on bold-ness,
  // even though libass can't reproduce the exact numeric weight a browser can.
  const fontWeightNum = parseInt(profile.fontWeight, 10) || 700;
  const bold = fontWeightNum >= 600 ? -1 : 0;

  return {
    fontName,
    fontSize,
    primaryColor,
    secondaryColor,
    outlineColor,
    backColor,
    shadowColor,
    // Only emitted as inline \xshad\yshad override tags when explicitly set;
    // otherwise ASS's native symmetric Shadow-depth offset already applies.
    shadowOffsetX: shadowParams.hasCustomShadowOffset ? Math.round(shadowParams.shadowOffsetXAss) : null,
    shadowOffsetY: shadowParams.hasCustomShadowOffset ? Math.round(shadowParams.shadowOffsetYAss) : null,
    bold,
    outlineSize,
    shadowSize: shadowParams.shadowSizeAss,
    alignment: 2,
    marginV,
    borderStyle,
    spacing: assSpacing,
    popScale,
    animationMode,
    posOverrideTag,
    enableKeywordHighlighting,
    keywordHighColor,
    keywordMediumColor,
    profile
  };
}

/**
 * Determines whether the caption background renders as a solid box, and how
 * much padding that box has, from the same inputs used by both the ASS and
 * CSS builders — the two must never resolve this independently.
 *
 * @param {object} params - Client style params (may include a custom backgroundColor).
 * @param {object} profile - The resolved creator profile.
 * @returns {{isBoxed: boolean, boxPaddingPx: number}}
 */
function resolveBoxState(params, profile) {
  // profile.borderStyle === 3 is the preset's own authored box/no-box intent.
  // profile.colors.backHex isn't a reliable signal on its own: under
  // BorderStyle 1 that same color is used as the drop-shadow color, not a box fill.
  const isBoxed = params.backgroundColor
    ? params.backgroundColor !== 'transparent'
    : profile.borderStyle === 3;

  const boxPaddingPx = isBoxed ? (profile.boxPaddingPx || 12) : 0;

  return { isBoxed, boxPaddingPx };
}

/**
 * Returns matching CSS preview rules for frontend rendering.
 * Supports custom color overrides, wordSpacing, popScale, and animation settings.
 * 
 * @param {object} params - Options state from client.
 * @returns {object} Object with overlay, text, highlight, and spacing colors.
 */
export function getCSSPreviewFromConfig(params = {}) {
  const fontName = params.fontFamily ? params.fontFamily.replace(/['"]/g, '').split(',')[0].trim() : 'Montserrat';
  const feSize = parseInt(params.fontSize || '14', 10);
  
  const isManualPosition = params.position === 'manual';
  const posKey = isManualPosition ? 'manual' : (params.position && CAPTION_POSITIONS[params.position] ? params.position : 'bottom');
  const posConfig = isManualPosition ? null : CAPTION_POSITIONS[posKey];
  const customPosX = parseFloat(params.customPosX ?? 50);
  const customPosY = parseFloat(params.customPosY ?? 85);

  const presetKey = params.preset && CREATOR_PROFILES[params.preset] ? params.preset : 'bold-yellow';
  const profile = CREATOR_PROFILES[presetKey];

  const animationMode = params.animationMode && ANIMATION_MODES[params.animationMode]
    ? params.animationMode
    : profile.defaultAnimationMode || 'karaoke';

  // Word content is already case-transformed via applyCaseTransform before it
  // reaches the DOM (see preview.js), so this CSS textTransform is only a
  // backstop for any text rendered without going through that per-word path.
  const textTransform = params.textCase === 'uppercase' ? 'uppercase'
    : params.textCase === 'lowercase' ? 'lowercase'
    : 'none';

  // Custom Colors or Fallbacks
  const outlineColorBase = params.outlineColor || profile.colors.outlineHex || '#000000';
  const backgroundColorBase = params.backgroundColor || profile.cssBackground || 'transparent';
  const cssBackgroundBase = params.backgroundColor ? params.backgroundColor : profile.cssBackground;

  const numericWordSpacing = parseFloat(params.wordSpacing !== undefined ? params.wordSpacing : 4);
  const popScale = parseFloat(params.popScale || 118);

  // Box mode + padding: derived identically to getASSStyleFromConfig so the
  // preview's box always matches the exported video's box.
  const { isBoxed, boxPaddingPx } = resolveBoxState(params, profile);
  const cssPadding = isBoxed ? `${Math.round(boxPaddingPx / 2)}px ${boxPaddingPx}px` : '0';

  // AI Keyword Highlighting resolved colors (mirrors getASSStyleFromConfig).
  const enableKeywordHighlighting = params.enableKeywordHighlighting !== false && params.enableKeywordHighlighting !== 'false';

  // Outline width, shadow color/size/offset, and opacity — resolved once,
  // shared with getASSStyleFromConfig so a slider always produces the same
  // effective value in both renderers.
  const shadowParams = resolveShadowOutlineParams(params, profile, isBoxed);
  const textOpacity = shadowParams.textOpacity;

  // Box mode repurposes the outline slider for padding (matching ASS, where
  // the same Outline field is hijacked under BorderStyle 3), so no text
  // outline width applies while boxed.
  const outlineSizeCss = shadowParams.outlineSizeAss != null ? shadowParams.outlineSizeAss / ASS_TO_CSS_SCALE : 0;
  const shadowBlurCss = shadowParams.shadowSizeAss / ASS_TO_CSS_SCALE;
  const shadowOffsetXCss = shadowParams.shadowOffsetXAss / ASS_TO_CSS_SCALE;
  const shadowOffsetYCss = shadowParams.shadowOffsetYAss / ASS_TO_CSS_SCALE;

  const outlineColorForLayers = applyOpacityToColor(outlineColorBase, textOpacity);
  const shadowColorForLayer = applyOpacityToColor(shadowParams.shadowColorHex, textOpacity);

  // A preset only draws a real -webkit-text-stroke when it authored
  // useNativeStroke: true; the 4 offset copies below simulate the outline via
  // text-shadow for every preset whenever outlineSizeCss > 0 (the sole outline
  // mechanism for presets that opt out of the native stroke), so outline
  // width/color always come from one place regardless of technique.
  const cssTextStroke = (profile.useNativeStroke && outlineSizeCss > 0)
    ? `${round2(outlineSizeCss)}px ${outlineColorForLayers}`
    : 'none';

  const shadowLayers = [];
  if (outlineSizeCss > 0) {
    const w = round2(outlineSizeCss);
    shadowLayers.push(`-${w}px -${w}px 0 ${outlineColorForLayers}`);
    shadowLayers.push(`${w}px -${w}px 0 ${outlineColorForLayers}`);
    shadowLayers.push(`-${w}px ${w}px 0 ${outlineColorForLayers}`);
    shadowLayers.push(`${w}px ${w}px 0 ${outlineColorForLayers}`);
  }
  if (shadowParams.shadowSizeAss > 0) {
    shadowLayers.push(`${round2(shadowOffsetXCss)}px ${round2(shadowOffsetYCss)}px ${round2(shadowBlurCss)}px ${shadowColorForLayer}`);
  }
  const cssTextShadow = shadowLayers.length ? shadowLayers.join(', ') : 'none';

  const highlightColor = applyOpacityToColor(params.activeWordColor || profile.cssHighlightColor || profile.colors.primaryHex, textOpacity);
  const inactiveColor = applyOpacityToColor(params.inactiveWordColor || profile.cssInactiveColor || profile.colors.secondaryHex, textOpacity);
  const keywordColorHigh = applyOpacityToColor(params.keywordColorHigh || '#EF4444', textOpacity);
  const keywordColorMedium = applyOpacityToColor(params.keywordColorMedium || '#FB923C', textOpacity);

  // Background opacity is independent of text opacity: only applied when the
  // slider is explicitly touched, so every preset's own baked box alpha (or
  // lack thereof) is preserved until then.
  const backgroundColor = shadowParams.backgroundOpacity != null
    ? applyOpacityToColor(backgroundColorBase, shadowParams.backgroundOpacity)
    : backgroundColorBase;
  const cssBackground = shadowParams.backgroundOpacity != null
    ? applyOpacityToColor(cssBackgroundBase, shadowParams.backgroundOpacity)
    : cssBackgroundBase;

  const overlay = isManualPosition
    ? {
        position: 'absolute',
        left: `${customPosX}%`,
        top: `${customPosY}%`,
        bottom: 'auto',
        transform: 'translate(-50%, -50%)',
        width: '90%',
        pointerEvents: 'auto',
        textAlign: 'center',
        zIndex: '10'
      }
    : {
        position: 'absolute',
        left: '50%',
        top: posConfig.cssTop,
        bottom: posConfig.cssBottom,
        transform: posConfig.cssTransform,
        width: '90%',
        pointerEvents: 'none',
        textAlign: 'center',
        zIndex: '10'
      };

  return {
    animationMode,
    profile,
    popScale,
    wordSpacingPx: numericWordSpacing,
    enableKeywordHighlighting,
    keywordColorHigh,
    keywordColorMedium,
    overlay,
    text: {
      fontFamily: `'${fontName}', sans-serif`,
      fontSize: `${feSize}px`,
      fontWeight: profile.fontWeight,
      color: inactiveColor,
      background: cssBackground,
      textShadow: cssTextShadow,
      webkitTextStroke: cssTextStroke,
      padding: cssPadding,
      borderRadius: profile.cssBorderRadius,
      textTransform,
      lineHeight: profile.lineSpacing || '1.25',
      display: 'inline-block'
    },
    highlightColor,
    inactiveColor,
    outlineColor: outlineColorBase,
    backgroundColor,
    wordSpacing: `${numericWordSpacing}px`
  };
}
