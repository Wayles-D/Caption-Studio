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
    cssTextStroke: '2px #000000',
    cssTextShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0px 3px 4px rgba(0,0,0,0.8)',
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
    cssTextStroke: '1.5px #000000',
    cssTextShadow: '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0px 2px 3px rgba(0,0,0,0.7)',
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
    cssTextStroke: 'none',
    cssTextShadow: '0 4px 6px rgba(0,0,0,0.2)',
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
    cssTextStroke: 'none',
    cssTextShadow: '0px 0px 10px rgba(129, 140, 248, 0.8), -2px -2px 0 #3f003f, 2px -2px 0 #3f003f, -2px 2px 0 #3f003f, 2px 2px 0 #3f003f',
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

  const posKey = params.position && CAPTION_POSITIONS[params.position] ? params.position : 'bottom';
  const marginV = CAPTION_POSITIONS[posKey].marginV;

  const presetKey = params.preset && CREATOR_PROFILES[params.preset] ? params.preset : 'bold-yellow';
  const profile = CREATOR_PROFILES[presetKey];

  const animationMode = params.animationMode && ANIMATION_MODES[params.animationMode]
    ? params.animationMode
    : profile.defaultAnimationMode || 'karaoke';

  // Custom Color Overrides or Profile Defaults
  const primaryColor = params.activeWordColor 
    ? hexToASSColor(params.activeWordColor, profile.colors.primaryHex) 
    : profile.colors.assPrimary;

  const secondaryColor = params.inactiveWordColor 
    ? hexToASSColor(params.inactiveWordColor, profile.colors.secondaryHex) 
    : profile.colors.assSecondary;

  const outlineColor = params.outlineColor 
    ? hexToASSColor(params.outlineColor, profile.colors.outlineHex) 
    : profile.colors.assOutline;

  const backColor = params.backgroundColor
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
  // Outline field doubles as box padding under BorderStyle 3; otherwise it's real text-outline width.
  const outlineSize = isBoxed
    ? Math.round(boxPaddingPx * 1.5) // scaled to ASS canvas pixels, matching word spacing's scale factor
    : (params.outlineSize !== undefined ? parseInt(params.outlineSize, 10) : profile.outlineSize);

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
    bold,
    outlineSize,
    shadowSize: params.shadowSize !== undefined ? parseInt(params.shadowSize, 10) : profile.shadowSize,
    alignment: 2,
    marginV,
    borderStyle,
    spacing: assSpacing,
    popScale,
    animationMode,
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
  
  const posKey = params.position && CAPTION_POSITIONS[params.position] ? params.position : 'bottom';
  const posConfig = CAPTION_POSITIONS[posKey];

  const presetKey = params.preset && CREATOR_PROFILES[params.preset] ? params.preset : 'bold-yellow';
  const profile = CREATOR_PROFILES[presetKey];

  const animationMode = params.animationMode && ANIMATION_MODES[params.animationMode]
    ? params.animationMode
    : profile.defaultAnimationMode || 'karaoke';

  const textTransform = params.textCase === 'uppercase' ? 'uppercase' : 'none';

  // Custom Colors or Fallbacks
  const highlightColor = params.activeWordColor || profile.cssHighlightColor || profile.colors.primaryHex;
  const inactiveColor = params.inactiveWordColor || profile.cssInactiveColor || profile.colors.secondaryHex;
  const outlineColor = params.outlineColor || profile.colors.outlineHex || '#000000';
  const backgroundColor = params.backgroundColor || profile.cssBackground || 'transparent';

  // Text Stroke / Shadow Overrides if outlineColor specified
  const cssTextStroke = params.outlineColor ? `2px ${params.outlineColor}` : profile.cssTextStroke;
  const cssBackground = params.backgroundColor ? params.backgroundColor : profile.cssBackground;

  const numericWordSpacing = parseFloat(params.wordSpacing !== undefined ? params.wordSpacing : 4);
  const popScale = parseFloat(params.popScale || 118);

  // Box mode + padding: derived identically to getASSStyleFromConfig so the
  // preview's box always matches the exported video's box.
  const { isBoxed, boxPaddingPx } = resolveBoxState(params, profile);
  const cssPadding = isBoxed ? `${Math.round(boxPaddingPx / 2)}px ${boxPaddingPx}px` : '0';

  return {
    animationMode,
    profile,
    popScale,
    wordSpacingPx: numericWordSpacing,
    overlay: {
      position: 'absolute',
      left: '50%',
      top: posConfig.cssTop,
      bottom: posConfig.cssBottom,
      transform: posConfig.cssTransform,
      width: '90%',
      pointerEvents: 'none',
      textAlign: 'center',
      zIndex: '10'
    },
    text: {
      fontFamily: `'${fontName}', sans-serif`,
      fontSize: `${feSize}px`,
      fontWeight: profile.fontWeight,
      color: inactiveColor,
      background: cssBackground,
      textShadow: profile.cssTextShadow,
      webkitTextStroke: cssTextStroke,
      padding: cssPadding,
      borderRadius: profile.cssBorderRadius,
      textTransform,
      lineHeight: profile.lineSpacing || '1.25',
      display: 'inline-block'
    },
    highlightColor,
    inactiveColor,
    outlineColor,
    backgroundColor,
    wordSpacing: `${numericWordSpacing}px`
  };
}
