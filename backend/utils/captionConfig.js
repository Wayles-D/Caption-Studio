/**
 * Caption Studio Central Shared Caption Configuration Schema
 * Single source of truth for caption presets, font scaling, positions, colors, and styling rules.
 */

/**
 * Caption Studio Central Shared Caption Configuration Schema
 * Single source of truth for creator profiles, animation modes, font scaling, positions, colors, and styling rules.
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
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    cssTextStroke: '2px #000000',
    cssTextShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0px 3px 4px rgba(0,0,0,0.8)',
    cssBackground: 'transparent',
    cssPadding: '0',
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
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    cssTextStroke: '1.5px #000000',
    cssTextShadow: '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0px 2px 3px rgba(0,0,0,0.7)',
    cssBackground: 'transparent',
    cssPadding: '0',
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
    wordSpacing: '0.25em',
    lineSpacing: '1.3',
    phraseSpacing: '6px 12px',
    cssTextStroke: 'none',
    cssTextShadow: '0 4px 6px rgba(0,0,0,0.2)',
    cssBackground: 'rgba(0, 0, 0, 0.75)',
    cssPadding: '6px 12px',
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
    wordSpacing: '0.2em',
    lineSpacing: '1.2',
    phraseSpacing: '0 4px',
    cssTextStroke: 'none',
    cssTextShadow: '0px 0px 10px rgba(129, 140, 248, 0.8), -2px -2px 0 #3f003f, 2px -2px 0 #3f003f, -2px 2px 0 #3f003f, 2px 2px 0 #3f003f',
    cssBackground: 'transparent',
    cssPadding: '0',
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
 * Maps input style parameters to resolved ASS style parameters.
 * 
 * @param {object} params - Options passed from client.
 * @returns {object} Resolved ASS parameters.
 */
export function getASSStyleFromConfig(params = {}) {
  let fontName = 'Montserrat SemiBold';
  if (params.fontFamily) {
    fontName = params.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
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

  return {
    fontName,
    fontSize,
    primaryColor: profile.colors.assPrimary,
    secondaryColor: profile.colors.assSecondary,
    outlineColor: profile.colors.assOutline,
    backColor: profile.colors.assBack,
    bold: -1,
    outlineSize: profile.outlineSize,
    shadowSize: profile.shadowSize,
    alignment: 2,
    marginV,
    borderStyle: profile.borderStyle,
    animationMode,
    profile
  };
}

/**
 * Returns matching CSS preview rules for frontend rendering.
 * 
 * @param {object} params - Options state from client.
 * @returns {object} Object with overlay, text, and highlight colors.
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

  return {
    animationMode,
    profile,
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
      color: profile.colors.primaryHex,
      background: profile.cssBackground,
      textShadow: profile.cssTextShadow,
      webkitTextStroke: profile.cssTextStroke,
      padding: profile.cssPadding,
      borderRadius: profile.cssBorderRadius,
      textTransform,
      lineHeight: profile.lineSpacing || '1.25',
      display: 'inline-block'
    },
    highlightColor: profile.cssHighlightColor,
    inactiveColor: profile.cssInactiveColor,
    wordSpacing: profile.wordSpacing || '0.2em'
  };
}

