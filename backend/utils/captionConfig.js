/**
 * Caption Studio Central Shared Caption Configuration Schema
 * Single source of truth for caption presets, font scaling, positions, colors, and styling rules.
 */

export const CAPTION_PRESETS = {
  'bold-yellow': {
    name: 'Bold Yellow',
    fontFamily: 'Montserrat',
    fontWeight: '800',
    primaryColorHex: '#FEF08A',
    secondaryColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    backColorHex: 'transparent',
    assPrimaryColor: '&H0000FFFF',   // Yellow
    assSecondaryColor: '&H00FFFFFF', // White
    assOutlineColor: '&H00000000',   // Black
    assBackColor: '&H00000000',
    outlineSize: 6,
    shadowSize: 0,
    borderStyle: 1,
    cssTextStroke: '2px #000000',
    cssTextShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0px 3px 4px rgba(0,0,0,0.8)',
    cssBackground: 'transparent',
    cssPadding: '0',
    cssBorderRadius: '0',
    cssHighlightColor: '#FEF08A',    // Active Yellow Highlight
    cssInactiveColor: '#FFFFFF'     // Inactive White
  },
  'caps-white': {
    name: 'Caps White',
    fontFamily: 'Montserrat',
    fontWeight: '800',
    primaryColorHex: '#FFFFFF',
    secondaryColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    backColorHex: 'transparent',
    assPrimaryColor: '&H00FFFFFF',   // White
    assSecondaryColor: '&HFFFFFFFF', // Transparent
    assOutlineColor: '&H00000000',   // Black
    assBackColor: '&H00000000',
    outlineSize: 6,
    shadowSize: 0,
    borderStyle: 1,
    cssTextStroke: '1.5px #000000',
    cssTextShadow: '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0px 2px 3px rgba(0,0,0,0.7)',
    cssBackground: 'transparent',
    cssPadding: '0',
    cssBorderRadius: '0',
    cssHighlightColor: '#FFFFFF',    // Active White
    cssInactiveColor: 'rgba(255, 255, 255, 0.65)' // Soft White
  },
  'bg-black': {
    name: 'Boxed Black',
    fontFamily: 'Montserrat',
    fontWeight: '700',
    primaryColorHex: '#FFFFFF',
    secondaryColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    backColorHex: 'rgba(0, 0, 0, 0.75)',
    assPrimaryColor: '&H00FFFFFF',
    assSecondaryColor: '&HFFFFFFFF',
    assOutlineColor: '&H00000000',
    assBackColor: '&H90000000',      // Semi-transparent black box
    outlineSize: 0,
    shadowSize: 0,
    borderStyle: 3,
    cssTextStroke: 'none',
    cssTextShadow: '0 4px 6px rgba(0,0,0,0.2)',
    cssBackground: 'rgba(0, 0, 0, 0.75)',
    cssPadding: '6px 12px',
    cssBorderRadius: '6px',
    cssHighlightColor: '#FEF08A',    // Active Yellow Boxed Text
    cssInactiveColor: '#FFFFFF'     // White Inactive
  },
  'gradient-glow': {
    name: 'Gradient Glow',
    fontFamily: 'Bebas Neue',
    fontWeight: '900',
    primaryColorHex: '#38BDF8',
    secondaryColorHex: '#FFFFFF',
    outlineColorHex: '#3F003F',
    backColorHex: '#FF00FF',
    assPrimaryColor: '&H00FFFF00',   // Cyan
    assSecondaryColor: '&HFFFFFFFF', // Transparent
    assOutlineColor: '&H003F003F',   // Dark Purple
    assBackColor: '&H00FF00FF',      // Purple Glow
    outlineSize: 7,
    shadowSize: 3,
    borderStyle: 1,
    cssTextStroke: 'none',
    cssTextShadow: '0px 0px 10px rgba(129, 140, 248, 0.8), -2px -2px 0 #3f003f, 2px -2px 0 #3f003f, -2px 2px 0 #3f003f, 2px 2px 0 #3f003f',
    cssBackground: 'transparent',
    cssPadding: '0',
    cssBorderRadius: '0',
    cssHighlightColor: '#38BDF8',    // Active Cyan Glow
    cssInactiveColor: '#818CF8'     // Purple-Blue Inactive
  }
};

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

  const presetKey = params.preset && CAPTION_PRESETS[params.preset] ? params.preset : 'bold-yellow';
  const presetConfig = CAPTION_PRESETS[presetKey];

  return {
    fontName,
    fontSize,
    primaryColor: presetConfig.assPrimaryColor,
    secondaryColor: presetConfig.assSecondaryColor,
    outlineColor: presetConfig.assOutlineColor,
    backColor: presetConfig.assBackColor,
    bold: -1,
    outlineSize: presetConfig.outlineSize,
    shadowSize: presetConfig.shadowSize,
    alignment: 2,
    marginV,
    borderStyle: presetConfig.borderStyle
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

  const presetKey = params.preset && CAPTION_PRESETS[params.preset] ? params.preset : 'bold-yellow';
  const presetConfig = CAPTION_PRESETS[presetKey];

  const textTransform = params.textCase === 'uppercase' ? 'uppercase' : 'none';

  return {
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
      fontWeight: presetConfig.fontWeight,
      color: presetConfig.primaryColorHex,
      background: presetConfig.cssBackground,
      textShadow: presetConfig.cssTextShadow,
      webkitTextStroke: presetConfig.cssTextStroke,
      padding: presetConfig.cssPadding,
      borderRadius: presetConfig.cssBorderRadius,
      textTransform,
      lineHeight: '1.25',
      display: 'inline-block'
    },
    highlightColor: presetConfig.cssHighlightColor,
    inactiveColor: presetConfig.cssInactiveColor
  };
}
