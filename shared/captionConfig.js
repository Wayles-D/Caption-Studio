/**
 * Caption Studio Central Shared Caption Configuration Schema
 * Single source of truth for creator profiles, animation modes, font scaling, positions, colors, and styling rules.
 * Shared across both Frontend workspace preview and Backend ASS subtitle generator.
 */
import { resolveFontFace } from './fontRegistry.js';

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
  // Internal id kept generic (not the literal display name) so future
  // creator-style packs (e.g. a "V2") can be added as sibling presets without
  // renaming this one — see `name` below for the UI-facing label ("WAYLES").
  'signature-v1': {
    id: 'signature-v1',
    name: 'WAYLES',
    fontFamily: 'Poppins',
    fontWeight: '400',
    fontSize: 14,
    defaultAnimationMode: 'karaoke',
    colors: {
      primaryHex: '#FFFFFF',
      secondaryHex: '#FFFFFF',
      outlineHex: '#000000',
      backHex: 'transparent',
      shadowHex: '#000000',
      assPrimary: '&H00FFFFFF',
      assSecondary: '&H00FFFFFF',
      assOutline: '&H00000000',
      assBack: '&H00000000'
    },
    outlineSize: 0,
    shadowSize: 0,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    useNativeStroke: false,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#FFFFFF',
    cssInactiveColor: '#FFFFFF',
    // This preset is driven by keyword styling rather than active-word
    // highlighting — see resolveWordStyleMetadata. Any future preset can opt
    // into the same generic renderer by setting keywordDriven + keywordStyle;
    // no changes to preview.js/assWriter.js are needed to add one.
    keywordDriven: true,
    disableActiveHighlightByDefault: true,
    // The Font Family control is a global override independent of preset (an
    // existing, pre-WAYLES app characteristic — presets don't otherwise drive
    // it), so a preset can opt into auto-selecting its own base font the
    // moment it's picked, purely as a one-time convenience default; the user
    // can still override it afterward like any other font choice.
    autoFontFamilyOnSelect: 'Poppins',
    // Single keyword tier — every AI-tagged keyword word renders identically,
    // no medium/high importance split.
    keywordStyle: {
      fontFamily: 'Poppins',
      fontWeight: '700',
      fontScale: 1.2,
      colorMode: 'always',
      defaultColorHex: '#FFD60A',
      animation: 'pop',
      shadowByDefault: true,
      outlineByDefault: false
    }
  },
  // WAYLES Poppins: a single-family variant of the keyword-driven WAYLES
  // model — normal words use Poppins Regular, keywords swap to the bundled
  // Poppins Bold face. Both faces share one family ("Poppins"), so the ASS
  // Bold flag selects the right one within it — no font-swap tag needed
  // beyond what resolveKeywordStyleConfig/resolveWordStyleMetadata already do.
  'wayles-poppins': {
    id: 'wayles-poppins',
    name: 'WAYLES Poppins',
    fontFamily: 'Poppins',
    fontWeight: '400',
    fontSize: 14,
    defaultAnimationMode: 'karaoke',
    colors: {
      primaryHex: '#FFFFFF',
      secondaryHex: '#FFFFFF',
      outlineHex: '#000000',
      backHex: 'transparent',
      shadowHex: '#000000',
      assPrimary: '&H00FFFFFF',
      assSecondary: '&H00FFFFFF',
      assOutline: '&H00000000',
      assBack: '&H00000000'
    },
    outlineSize: 0,
    shadowSize: 0,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    useNativeStroke: false,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#FFFFFF',
    cssInactiveColor: '#FFFFFF',
    keywordDriven: true,
    disableActiveHighlightByDefault: true,
    autoFontFamilyOnSelect: 'Poppins',
    keywordStyle: {
      fontFamily: 'Poppins',
      face: 'bold',
      fontWeight: '700',
      fontScale: 1,
      colorMode: 'always',
      defaultColorHex: '#FFFFFF',
      animation: 'none',
      shadowByDefault: false,
      outlineByDefault: false
    }
  },
  // WAYLES PEN: same keyword-driven model as WAYLES Poppins, using the
  // bundled PP Editorial New family instead. Its keyword tier requests the
  // 'bold' face; PP Editorial New has no true Bold weight bundled, so the
  // registry resolves that face to the Ultrabold file/family instead (see
  // shared/fontRegistry.js) — the closest available heavier weight, not a
  // silent fallback to Poppins.
  'wayles-pen': {
    id: 'wayles-pen',
    name: 'WAYLES PEN',
    fontFamily: 'PP Editorial New',
    fontWeight: '700',
    fontSize: 20,
    defaultAnimationMode: 'karaoke',
    colors: {
      primaryHex: '#FFFFFF',
      secondaryHex: '#FFFFFF',
      outlineHex: '#000000',
      backHex: 'transparent',
      shadowHex: '#000000',
      assPrimary: '&H00FFFFFF',
      assSecondary: '&H00FFFFFF',
      assOutline: '&H00000000',
      assBack: '&H00000000'
    },
    outlineSize: 0,
    shadowSize: 0,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.2em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    useNativeStroke: false,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#FFFFFF',
    cssInactiveColor: '#FFFFFF',
    keywordDriven: true,
    disableActiveHighlightByDefault: true,
    autoFontFamilyOnSelect: 'PP Editorial New',
    keywordStyle: {
      fontFamily: 'PP Editorial New',
      face: 'bold',
      fontWeight: '700',
      fontScale: 1,
      colorMode: 'always',
      defaultColorHex: '#FFFFFF',
      animation: 'none',
      shadowByDefault: false,
      outlineByDefault: false
    }
  },
  // Poppins + Editorial: normal words render in genuine Poppins Bold; any
  // keyword switches to PP Editorial New's Ultra Bold Italic face — a single
  // keyword treatment, not a two-tier split. Unlike the WAYLES-family presets
  // above, disableActiveHighlightByDefault is NOT set: the base active/
  // inactive highlight system stays ON, so the currently-spoken word (not
  // just keywords) still gets the "pop" scale-up below — that's what gives
  // ordinary words their share of the layered/overlapping feel, with
  // keywords popping further via their own larger fontScale on top of it.
  // The overlap itself is just the existing `\fscx\fscy`/CSS `transform:
  // scale()` pop mechanism (already WYSIWYG-proven, unchanged) scaled up
  // enough that a popped glyph's rendered box visually encroaches into the
  // previous word's trailing space — since that word is painted later in
  // the text stream, it naturally renders on top of the overlap, with no
  // new z-order/positioning system needed in either renderer.
  'poppins-editorial': {
    id: 'poppins-editorial',
    name: 'Poppins + Editorial',
    fontFamily: 'Poppins',
    fontWeight: '700',
    fontSize: 14,
    defaultAnimationMode: 'pop',
    colors: {
      primaryHex: '#FFFFFF',
      secondaryHex: '#FFFFFF',
      outlineHex: '#000000',
      backHex: 'transparent',
      shadowHex: '#000000',
      assPrimary: '&H00FFFFFF',
      assSecondary: '&H00FFFFFF',
      assOutline: '&H00000000',
      assBack: '&H00000000'
    },
    outlineSize: 3,
    shadowSize: 4,
    borderStyle: 1,
    boxPaddingPx: 0,
    wordSpacing: '0.22em',
    lineSpacing: '1.25',
    phraseSpacing: '0 4px',
    useNativeStroke: true,
    cssBackground: 'transparent',
    cssBorderRadius: '0',
    cssHighlightColor: '#FFFFFF',
    cssInactiveColor: '#FFFFFF',
    keywordDriven: true,
    autoFontFamilyOnSelect: 'Poppins',
    // Keyword words always render lowercase on this preset, regardless of the
    // caption's global text-case setting — see resolveWordTextCase, which
    // both the CSS preview and the ASS exporter call per word so this can
    // never drift between the two.
    keywordTextCase: 'lowercase',
    keywordStyle: {
      fontFamily: 'PP Editorial New',
      face: 'ultraboldItalic',
      fontWeight: '800',
      fontScale: 1.22,
      colorMode: 'always',
      defaultColorHex: '#EF4444',
      animation: 'pop',
      shadowByDefault: false,
      outlineByDefault: false
    }
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
 * Resolves which text-case a single word should use, letting a preset force
 * its own casing for keyword words (e.g. Poppins + Editorial's keywords
 * always render lowercase) regardless of the caption's global text-case
 * setting. Single place both the CSS preview and the ASS exporter call this
 * from, per word, so the override can never drift between the two.
 *
 * @param {boolean} isKeyword - Whether this word is a keyword.
 * @param {boolean} keywordsEnabled - Whether AI keyword highlighting is on.
 * @param {string} textCase - The caption's global text-case setting.
 * @param {string|null} keywordTextCase - The active preset's own forced
 *   keyword case override (profile.keywordTextCase), if any.
 * @returns {string} The text-case to apply to this specific word.
 */
export function resolveWordTextCase(isKeyword, keywordsEnabled, textCase, keywordTextCase) {
  if (keywordsEnabled && isKeyword && keywordTextCase) return keywordTextCase;
  return textCase;
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

// getASSStyleFromConfig scales a CSS font-size (px) up to its ASS canvas-unit
// equivalent by this factor (see fontSize below). Outline width and shadow
// size/offset are drawn relative to the glyph, so they convert through this
// same ratio — using a canvas-position-based ratio there instead previously
// left the CSS preview's outline/shadow several times thicker relative to the
// font than the exported video's, occasionally thick enough for the outline
// to fully eclipse the text fill.
const FONT_SIZE_ASS_SCALE = 5.14;

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
 * Resolves which shadow system the caption currently renders with. Only one
 * is ever active at a time — selecting one is mutually exclusive with the
 * other (see sidebarInspector.js's mode toggle). Absent/unrecognized values
 * fall back to 'individual', matching every pre-existing project/preset that
 * predates this control and only ever authored the individual shadow sliders.
 *
 * @param {object} params - Client style params.
 * @returns {'none'|'individual'|'unified'}
 */
export function resolveShadowMode(params) {
  return params.shadowMode === 'unified' || params.shadowMode === 'none'
    ? params.shadowMode
    : 'individual';
}

/**
 * Resolves the caption display mode: 'sentence' (existing behavior — the
 * full phrase is shown, with per-word active/inactive highlighting) or
 * 'word' (exactly one transcript word visible at a time, timed to that
 * word's own Whisper start/end). Absent/unrecognized values fall back to
 * 'sentence', matching every existing project/preset that predates this
 * control. Both the CSS preview and the ASS exporter read this from the
 * same place so they can never disagree on which mode is active.
 *
 * @param {object} params - Client style params.
 * @returns {'sentence'|'word'}
 */
export function resolveCaptionMode(params) {
  return params.captionMode === 'word' ? 'word' : 'sentence';
}

// Subtle centered shadow with a small blur, per the Unified Shadow spec.
const UNIFIED_SHADOW_DEFAULTS = {
  colorHex: '#000000',
  opacity: 45,
  blurAss: 6,
  offsetXAss: 0,
  offsetYAss: 4
};

/**
 * Resolves the Unified Caption Shadow's own controls (color/opacity/blur/
 * offset) — independent of the individual-shadow sliders above, since the two
 * systems are mutually exclusive and each keeps its own settings so switching
 * modes back and forth doesn't clobber either one's configuration.
 *
 * @param {object} params - Client style params.
 */
export function resolveUnifiedShadowParams(params) {
  const opacity = params.unifiedShadowOpacity != null
    ? Math.max(0, Math.min(100, parseFloat(params.unifiedShadowOpacity)))
    : UNIFIED_SHADOW_DEFAULTS.opacity;

  return {
    colorHex: params.unifiedShadowColor || UNIFIED_SHADOW_DEFAULTS.colorHex,
    opacity,
    blurAss: params.unifiedShadowBlur != null ? parseFloat(params.unifiedShadowBlur) : UNIFIED_SHADOW_DEFAULTS.blurAss,
    offsetXAss: params.unifiedShadowOffsetX != null ? parseFloat(params.unifiedShadowOffsetX) : UNIFIED_SHADOW_DEFAULTS.offsetXAss,
    offsetYAss: params.unifiedShadowOffsetY != null ? parseFloat(params.unifiedShadowOffsetY) : UNIFIED_SHADOW_DEFAULTS.offsetYAss
  };
}

const DEFAULT_KEYWORD_TIER = {
  fontFamily: null,
  face: 'regular', // which registered face of fontFamily to use — see shared/fontRegistry.js
  fontWeight: null,
  fontScale: 1,
  colorMode: 'onlyWhenActive', // legacy presets only show the keyword color while the word is the active one
  defaultColorHex: null,
  animation: 'none',
  shadowByDefault: false,
  outlineByDefault: false
};

/**
 * Resolves the single keyword tier a preset renders keyword words with,
 * merging the active preset's own `keywordStyle` authoring with any client
 * overrides (the "Keyword Style" editor section). Single place both
 * getASSStyleFromConfig and getCSSPreviewFromConfig — and, per word,
 * resolveWordStyleMetadata — read this from, so a slider always produces the
 * same effective value in both renderers.
 *
 * @param {object} params - Client style params.
 * @param {object} profile - The resolved creator profile.
 */
export function resolveKeywordStyleConfig(params, profile) {
  const presetKeyword = { ...DEFAULT_KEYWORD_TIER, ...(profile.keywordStyle || {}) };

  // Font resolved exclusively through the Font Registry: the preset's own
  // authored `face` (e.g. 'bold'/'italic') always applies — it's the tier's
  // stylistic role — while WHICH font family fills that role can still be
  // swapped via the Keyword Style editor's font picker.
  const fontRequest = params.keywordFont || presetKeyword.fontFamily;
  const resolvedFont = fontRequest ? resolveFontFace(fontRequest, presetKeyword.face) : null;

  const keyword = {
    fontFamily: resolvedFont ? resolvedFont.familyName : null,
    fontItalic: resolvedFont ? resolvedFont.italic : false,
    fontWeight: params.keywordWeight || presetKeyword.fontWeight,
    fontScale: params.keywordScale != null ? parseFloat(params.keywordScale) : presetKeyword.fontScale,
    colorHex: params.keywordColor || presetKeyword.defaultColorHex || '#EF4444',
    colorMode: presetKeyword.colorMode,
    animation: params.keywordAnimation || presetKeyword.animation,
    hasShadow: params.keywordShadowEnabled != null ? (params.keywordShadowEnabled !== false && params.keywordShadowEnabled !== 'false') : presetKeyword.shadowByDefault,
    hasOutline: params.keywordOutlineEnabled != null ? (params.keywordOutlineEnabled !== false && params.keywordOutlineEnabled !== 'false') : presetKeyword.outlineByDefault
  };

  const opacity = params.keywordOpacity != null ? Math.max(0, Math.min(100, parseFloat(params.keywordOpacity))) : 100;

  return { keyword, opacity };
}

/**
 * Whether the base active/inactive word-highlight system is enabled. Most
 * presets want it on; a keyword-driven preset like WAYLES defaults it off
 * (keyword styling is the primary emphasis system instead) but the user can
 * still switch it back on manually.
 */
export function resolveActiveHighlightEnabled(params, profile) {
  if (params.enableActiveHighlight != null) {
    return params.enableActiveHighlight !== false && params.enableActiveHighlight !== 'false';
  }
  return !profile.disableActiveHighlightByDefault;
}

// Fixed "soft emphasis" effect strengths for the Keyword Shadow/Outline
// toggles — self-contained so the toggle always has a visible effect
// regardless of the caption's own (possibly zero) global outline/shadow
// sliders. Defined once here in both CSS px and ASS canvas units (via
// FONT_SIZE_ASS_SCALE, since these are glyph-relative like the base
// outline/shadow) so the two renderers can never drift apart.
const KEYWORD_SHADOW_ASS_DEPTH = 3;
const KEYWORD_SHADOW_COLOR_HEX = '#000000';
const KEYWORD_SHADOW_CSS_ALPHA = 0.45;
const KEYWORD_OUTLINE_ASS_WIDTH = 3;
const KEYWORD_OUTLINE_COLOR_HEX = '#000000';

function buildKeywordShadowMetadata() {
  const offsetCss = round2(KEYWORD_SHADOW_ASS_DEPTH / FONT_SIZE_ASS_SCALE);
  const blurCss = round2((KEYWORD_SHADOW_ASS_DEPTH * 1.3) / FONT_SIZE_ASS_SCALE);
  return {
    assDepth: KEYWORD_SHADOW_ASS_DEPTH,
    colorHex: KEYWORD_SHADOW_COLOR_HEX,
    css: `${offsetCss}px ${offsetCss}px ${blurCss}px rgba(0, 0, 0, ${KEYWORD_SHADOW_CSS_ALPHA})`
  };
}

function buildKeywordOutlineMetadata() {
  return {
    assWidth: KEYWORD_OUTLINE_ASS_WIDTH,
    colorHex: KEYWORD_OUTLINE_COLOR_HEX,
    css: `${round2(KEYWORD_OUTLINE_ASS_WIDTH / FONT_SIZE_ASS_SCALE)}px ${KEYWORD_OUTLINE_COLOR_HEX}`
  };
}

/**
 * Resolves the final per-word style metadata — the single generic model both
 * the CSS preview and the ASS exporter derive a word's appearance from.
 * Neither renderer hardcodes preset-specific logic: they just read this
 * metadata and translate it into their own native format (CSS px/rgba vs ASS
 * canvas units/BGR colors). A future preset only needs to supply its own
 * `keywordStyle` config on CREATOR_PROFILES — no renderer changes required.
 *
 * @param {object} word - The word unit (word/text, isKeyword).
 * @param {object} context - { keywordStyleConfig, keywordsEnabled, activeHighlightEnabled, isWordActive, mode, activeHighlightColorHex, inactiveColorHex, baseFontFamily, baseFontWeight }.
 * @returns {object} Unit-neutral metadata (fontScale as a ratio, colors as hex/rgba, shadow/outline pre-computed for both renderers).
 *   fontFamily/fontWeight are always a concrete value (never null) so a
 *   renderer that emits one override tag per word (ASS's \fn/\b) never leaks
 *   a keyword's font into the next, unrelated word.
 */
export function resolveWordStyleMetadata(word, context) {
  const { keywordStyleConfig, keywordsEnabled, activeHighlightEnabled, isWordActive, mode, activeHighlightColorHex, inactiveColorHex, baseFontFamily, baseFontWeight } = context;

  const isKeyword = !!(keywordsEnabled && word && word.isKeyword);
  const tier = isKeyword ? keywordStyleConfig.keyword : null;

  const showActiveHighlight = !!activeHighlightEnabled && isWordActive;
  const baseColorHex = showActiveHighlight ? activeHighlightColorHex : inactiveColorHex;

  if (!tier) {
    return {
      isKeyword: false,
      fontFamily: baseFontFamily || null,
      fontWeight: baseFontWeight || null,
      italic: false,
      fontScale: 1,
      colorHex: baseColorHex,
      shadow: null,
      outline: null,
      animation: (mode === 'pop' && showActiveHighlight) ? 'pop' : 'none'
    };
  }

  const showTierColor = tier.colorMode === 'always' || (tier.colorMode === 'onlyWhenActive' && isWordActive);

  return {
    isKeyword: true,
    fontFamily: tier.fontFamily || baseFontFamily || null,
    fontWeight: tier.fontWeight || baseFontWeight || null,
    italic: !!tier.fontItalic,
    fontScale: tier.fontScale || 1,
    colorHex: showTierColor ? tier.colorHex : baseColorHex,
    shadow: tier.hasShadow ? buildKeywordShadowMetadata() : null,
    outline: tier.hasOutline ? buildKeywordOutlineMetadata() : null,
    animation: (tier.animation === 'pop' && isWordActive) ? 'pop' : 'none'
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
  // Resolved exclusively through the Font Registry — never a hardcoded name,
  // never a font that isn't actually bundled in backend/fonts/. An
  // unrecognized/missing requested font transparently falls back to the
  // registry's default (Poppins) rather than failing or guessing.
  const baseFontFace = resolveFontFace(params.fontFamily, 'regular');
  const fontName = baseFontFace.familyName;

  const feSize = parseInt(params.fontSize || '14', 10);
  const fontSize = Math.round(feSize * FONT_SIZE_ASS_SCALE);

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

  // Plain-hex equivalents of the two colors above (mirroring getCSSPreviewFromConfig's
  // highlightColor/inactiveColor resolution exactly) — resolveWordStyleMetadata deals
  // only in hex, so keyword-driven presets resolve their base color identically in
  // both renderers instead of each parsing the other's native color format.
  const primaryColorHex = params.activeWordColor || profile.cssHighlightColor || profile.colors.primaryHex;
  const secondaryColorHex = params.inactiveWordColor || profile.cssInactiveColor || profile.colors.secondaryHex;

  // AI Keyword Highlighting: dedicated color for active keyword words.
  // Disabled by default resolution stays the same regardless — callers gate
  // on enableKeywordHighlighting before applying this.
  const enableKeywordHighlighting = params.enableKeywordHighlighting !== false && params.enableKeywordHighlighting !== 'false';
  let keywordColor = hexToASSColor(params.keywordColor || '#EF4444', '#EF4444');

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

  // Only one shadow system renders at a time. The Individual shadow's own
  // tags/Style-Shadow-depth are only emitted in 'individual' mode below; the
  // Unified shadow is a wholly separate offscreen-composited layer the caller
  // (subtitleService/ffmpeg) builds from unifiedShadow, so it never touches
  // this per-glyph ASS Shadow field at all — the two can never stack.
  const shadowMode = resolveShadowMode(params);
  const unifiedShadowParams = resolveUnifiedShadowParams(params);
  const unifiedShadow = {
    colorHex: unifiedShadowParams.colorHex,
    assColor: withAssAlpha(hexToASSColor(unifiedShadowParams.colorHex), opacityToAssAlpha(unifiedShadowParams.opacity)),
    opacity: unifiedShadowParams.opacity,
    blurAss: unifiedShadowParams.blurAss,
    offsetXAss: unifiedShadowParams.offsetXAss,
    offsetYAss: unifiedShadowParams.offsetYAss
  };

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
  keywordColor = withAssAlpha(keywordColor, textOpacityAlpha);

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

  // Keyword-driven styling (e.g. WAYLES) and whether the base active/inactive
  // highlight system runs at all — resolved once here so assWriter builds its
  // per-word override tags from the exact same config the CSS preview uses.
  const keywordStyleConfig = resolveKeywordStyleConfig(params, profile);
  const activeHighlightEnabled = resolveActiveHighlightEnabled(params, profile);

  return {
    fontName,
    fontSize,
    primaryColor,
    secondaryColor,
    primaryColorHex,
    secondaryColorHex,
    outlineColor,
    backColor,
    shadowColor,
    // Only emitted as inline \xshad\yshad override tags when explicitly set,
    // and only in 'individual' mode — 'none'/'unified' suppress this system
    // entirely so it can never stack with the Unified shadow layer.
    shadowOffsetX: (shadowMode === 'individual' && shadowParams.hasCustomShadowOffset) ? Math.round(shadowParams.shadowOffsetXAss) : null,
    shadowOffsetY: (shadowMode === 'individual' && shadowParams.hasCustomShadowOffset) ? Math.round(shadowParams.shadowOffsetYAss) : null,
    bold,
    outlineSize,
    shadowSize: shadowMode === 'individual' ? shadowParams.shadowSizeAss : 0,
    alignment: 2,
    marginV,
    borderStyle,
    spacing: assSpacing,
    popScale,
    animationMode,
    posOverrideTag,
    enableKeywordHighlighting,
    keywordColor,
    keywordDriven: !!profile.keywordDriven,
    keywordStyleConfig,
    keywordTextCase: profile.keywordTextCase || null,
    activeHighlightEnabled,
    textOpacity: shadowParams.textOpacity,
    shadowMode,
    unifiedShadow,
    captionMode: resolveCaptionMode(params),
    fontSizeAss: fontSize,
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
  // Resolved exclusively through the Font Registry, mirroring
  // getASSStyleFromConfig exactly — same font, same fallback behavior, so
  // preview and export can never disagree on which font is showing.
  const baseFontFace = resolveFontFace(params.fontFamily, 'regular');
  const fontName = baseFontFace.familyName;
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
  const outlineSizeCss = shadowParams.outlineSizeAss != null ? shadowParams.outlineSizeAss / FONT_SIZE_ASS_SCALE : 0;
  const shadowBlurCss = shadowParams.shadowSizeAss / FONT_SIZE_ASS_SCALE;
  const shadowOffsetXCss = shadowParams.shadowOffsetXAss / FONT_SIZE_ASS_SCALE;
  const shadowOffsetYCss = shadowParams.shadowOffsetYAss / FONT_SIZE_ASS_SCALE;

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

  // Only one shadow system renders at a time (see resolveShadowMode) — the
  // Individual shadow's own text-shadow layer below only appears in
  // 'individual' mode; the Unified shadow is a wholly separate `filter:
  // drop-shadow(...)` layer (see unifiedShadowFilter) so the two never stack.
  const shadowMode = resolveShadowMode(params);

  const shadowLayers = [];
  if (!profile.useNativeStroke && outlineSizeCss > 0) {
    const w = round2(outlineSizeCss);
    shadowLayers.push(`-${w}px -${w}px 0 ${outlineColorForLayers}`);
    shadowLayers.push(`${w}px -${w}px 0 ${outlineColorForLayers}`);
    shadowLayers.push(`-${w}px ${w}px 0 ${outlineColorForLayers}`);
    shadowLayers.push(`${w}px ${w}px 0 ${outlineColorForLayers}`);
  }
  if (shadowMode === 'individual' && shadowParams.shadowSizeAss > 0) {
    shadowLayers.push(`${round2(shadowOffsetXCss)}px ${round2(shadowOffsetYCss)}px ${round2(shadowBlurCss)}px ${shadowColorForLayer}`);
  }
  const cssTextShadow = shadowLayers.length ? shadowLayers.join(', ') : 'none';

  // Unified Caption Shadow: a single blurred/offset duplicate of the whole
  // rendered caption (glyphs + outline together), composited as one
  // continuous silhouette behind it — exactly what CSS's `filter:
  // drop-shadow()` produces natively, unlike `text-shadow` which draws an
  // independent copy per DOM word/span (visible gaps between words at larger
  // blur radii). Applied as a `filter` on the same element as the outline/
  // fill, so it wraps the true rendered shape (see preview.js).
  let unifiedShadowFilter = 'none';
  if (shadowMode === 'unified') {
    const uni = resolveUnifiedShadowParams(params);
    const dxCss = round2(uni.offsetXAss / FONT_SIZE_ASS_SCALE);
    const dyCss = round2(uni.offsetYAss / FONT_SIZE_ASS_SCALE);
    const blurCss = round2(uni.blurAss / FONT_SIZE_ASS_SCALE);
    const shadowColor = applyOpacityToColor(uni.colorHex, uni.opacity * textOpacity / 100);
    unifiedShadowFilter = `drop-shadow(${dxCss}px ${dyCss}px ${blurCss}px ${shadowColor})`;
  }

  const highlightColor = applyOpacityToColor(params.activeWordColor || profile.cssHighlightColor || profile.colors.primaryHex, textOpacity);
  const inactiveColor = applyOpacityToColor(params.inactiveWordColor || profile.cssInactiveColor || profile.colors.secondaryHex, textOpacity);
  const keywordColor = applyOpacityToColor(params.keywordColor || '#EF4444', textOpacity);

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

  // Keyword-driven styling (e.g. WAYLES) and whether the base active/inactive
  // highlight system runs at all — resolved identically to getASSStyleFromConfig
  // so the preview always matches the exported video.
  const keywordStyleConfig = resolveKeywordStyleConfig(params, profile);
  const activeHighlightEnabled = resolveActiveHighlightEnabled(params, profile);

  return {
    animationMode,
    profile,
    popScale,
    wordSpacingPx: numericWordSpacing,
    enableKeywordHighlighting,
    keywordColor,
    keywordDriven: !!profile.keywordDriven,
    keywordStyleConfig,
    keywordTextCase: profile.keywordTextCase || null,
    activeHighlightEnabled,
    overlay,
    text: {
      // No fallback list appended: ASS only supports a single font family
      // name, and the preview must match the export exactly for WYSIWYG, so
      // CSS deliberately doesn't lean on a browser-level fallback either —
      // resolveFontFace() above already guarantees a real, bundled font.
      fontFamily: `'${fontName}'`,
      fontSize: `${feSize}px`,
      fontWeight: profile.fontWeight,
      color: inactiveColor,
      background: cssBackground,
      textShadow: cssTextShadow,
      webkitTextStroke: cssTextStroke,
      filter: unifiedShadowFilter,
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
    shadowMode,
    captionMode: resolveCaptionMode(params),
    wordSpacing: `${numericWordSpacing}px`
  };
}
