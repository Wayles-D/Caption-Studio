/**
 * Left Sidebar Inspector UI Component for BHYND
 */
import { appState, updateState, subscribe, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig, resolveUnifiedShadowParams } from '../../../shared/captionConfig.js';
import { initNumericControl } from './numericControl.js';
import { getCurrentProfile } from '../utils/colorFallbacks.js';

/**
 * Outline/shadow size sliders are null by default (meaning "use the active
 * preset's own value"), mirroring the color pickers' override-or-fallback
 * pattern — so the slider always shows a meaningful number even before the
 * user ever touches it, and switching presets updates the displayed default.
 */
function getFallbackOutlineSize() {
  return getCurrentProfile().outlineSize;
}

function getFallbackShadowSize() {
  return getCurrentProfile().shadowSize;
}

function getFallbackShadowOffset() {
  // Matches the shared engine's own default: a symmetric offset equal to the
  // current shadow size (ASS's native Shadow-field behavior with no override).
  return appState.shadowSize ?? getFallbackShadowSize();
}

const DEFAULT_KEYWORD_TIER_FALLBACK = { fontFamily: '', fontWeight: '', fontScale: 1, animation: 'none', shadowByDefault: false, outlineByDefault: false };

function getFallbackKeywordTier() {
  return getCurrentProfile().keywordStyle || DEFAULT_KEYWORD_TIER_FALLBACK;
}

function getFallbackActiveHighlightEnabled() {
  return !getCurrentProfile().disableActiveHighlightByDefault;
}

// Unified Shadow sliders are null by default too, meaning "use the built-in
// subtle-centered-shadow default" — same override-or-fallback pattern as the
// Individual shadow's own sliders above, just backed by a fixed default
// rather than a per-preset one (Unified Shadow isn't preset-specific).
function getFallbackUnifiedShadow() {
  return resolveUnifiedShadowParams({});
}

/**
 * Every numeric slider's `.sync` handle (see numericControl.js), keyed by
 * the same name syncSidebarUI() already uses to look up its appState value —
 * populated once in initSidebarInspector, read every time syncSidebarUI()
 * runs. Ranges here are the single source of truth for each property's
 * min/max/step: audited per-property rather than one blanket range (see the
 * editor-controls upgrade) — e.g. Shadow Blur and Font Size intentionally
 * allow much larger values than Word Spacing or Pop Scale do.
 */
const numeric = {};

// Guards the ONE subscribe('*', ...) call at the end of initSidebarInspector
// so it registers exactly once for the page's lifetime, however many times
// that function itself gets called — see its own doc comment there.
let subscribedToStateChanges = false;

// NOTE: this used to guard against double-initialization with a permanent
// `if (initialized) return` — correct back when SidebarInspector.jsx was a
// single always-mounted sidebar, but WRONG now that it's shown one section
// at a time in a bottom-sheet/side-panel (see its `sectionFilter` prop):
// switching tools directly (e.g. Style -> Text -> Style, without closing in
// between) does NOT unmount/remount this component — React reuses the SAME
// instance across different `sectionFilter` props, since neither the
// component type nor its position in the tree changes, only which
// section's DOM its render produces. A permanent "only ever wire once"
// guard (or even just calling this from a mount-only effect — see
// SidebarInspector.jsx) meant whichever section happened to be visible the
// FIRST time this ran got its listeners attached, and every OTHER section
// shown afterward via a direct tool switch (e.g. Rolling Stack's
// caption-mode radios, or the preset buttons) got fresh DOM nodes with NO
// listeners ever attached to them. SidebarInspector.jsx now calls this
// again every time `sectionFilter` changes, so re-querying and
// re-attaching on every call here is exactly correct — there's nothing
// stale left over to double-bind, since each call targets whatever's
// CURRENTLY in the DOM.
export function initSidebarInspector() {
  // 1. Accordion Header Toggle Binding
  const accordionHeaders = document.querySelectorAll('.accordion-header');
  accordionHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.accordion-item');
      item.classList.toggle('collapsed');
    });
  });

  // 2. Preset Selection Buttons — now a real React component
  // (SidebarInspector.jsx's PRESET_BUTTONS/applyPresetSelection), reading
  // currentPreset from useEditorStore and re-rendering on change instead of
  // a manually-toggled `.active` class here. See that file's own comment
  // for why: "one state, several DOM effects" is exactly the shape that
  // made the OLD imperative wiring here fragile (a section re-wired on the
  // wrong mount silently never got its listeners at all).

  // 3. Typography Inputs
  const fontFamilySelect = document.getElementById('font-family-select');
  const textCaseRadios = document.getElementsByName('text-case');

  // Caption Mode radios — now a real React component (SidebarInspector.jsx's
  // handleCaptionModeChange), same reasoning as the preset buttons above:
  // this control's own cascading side effects (the Rolling Stack settings
  // group's visibility, and the one-time preset+font auto-switch) are
  // exactly the "one state affects multiple things" shape that a DOM-query-
  // based sync function keeps getting subtly out of step with.

  // Rolling Stack: words-per-layer (2/3, user-controlled, never auto-decided)
  // and layer alignment — only meaningful while Rolling Stack is selected;
  // visibility toggled in syncSidebarUI.
  document.getElementsByName('rolling-stack-layer-count').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      updateState({ rollingStackLayerCount: parseInt(e.target.value, 10) });
    });
  });
  document.getElementsByName('rolling-stack-alignment').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      updateState({ rollingStackAlignment: e.target.value });
    });
  });

  if (fontFamilySelect) {
    fontFamilySelect.addEventListener('change', (e) => {
      updateState({ fontFamily: e.target.value });
    });
  }

  // Font size: previously capped at 24px — far too small for a real caption
  // editor (cover-text-sized captions routinely run well past 100px). 8-120px
  // covers legible fine print through oversized cover text.
  numeric.fontSize = initNumericControl({
    sliderId: 'input-font-size', badgeId: 'val-font-size',
    min: 8, max: 120, step: 1, unit: 'px',
    onChange: (v) => updateState({ fontSize: v })
  });

  numeric.wordSpacing = initNumericControl({
    sliderId: 'input-word-spacing', badgeId: 'val-word-spacing',
    min: 0, max: 60, step: 1, unit: 'px',
    onChange: (v) => updateState({ wordSpacing: v })
  });

  textCaseRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateState({ textCase: e.target.value });
    });
  });

  // 4. Custom Color Picker Popovers — now real React <ColorPickerField>
  // components rendered directly in SidebarInspector.jsx's JSX (see the
  // shadcn/ui + react-colorful replacement), reading/writing useEditorStore
  // directly instead of being wired up here via getElementById.

  // 4b. Outline, Shadow & Opacity Controls
  numeric.outlineSize = initNumericControl({
    sliderId: 'input-outline-size', badgeId: 'val-outline-size',
    min: 0, max: 50, step: 1, unit: 'px',
    onChange: (v) => updateState({ outlineSize: v })
  });

  // Shadow Intensity/Blur: previously capped at 20px. Raised to 100px so
  // extreme, intentional styling is reachable without artificial clamping.
  numeric.shadowSize = initNumericControl({
    sliderId: 'input-shadow-size', badgeId: 'val-shadow-size',
    min: 0, max: 100, step: 1, unit: 'px',
    onChange: (v) => updateState({ shadowSize: v })
  });

  numeric.shadowOffsetX = initNumericControl({
    sliderId: 'input-shadow-offset-x', badgeId: 'val-shadow-offset-x',
    min: -100, max: 100, step: 1, unit: 'px',
    onChange: (v) => updateState({ shadowOffsetX: v })
  });

  numeric.shadowOffsetY = initNumericControl({
    sliderId: 'input-shadow-offset-y', badgeId: 'val-shadow-offset-y',
    min: -100, max: 100, step: 1, unit: 'px',
    onChange: (v) => updateState({ shadowOffsetY: v })
  });

  numeric.textOpacity = initNumericControl({
    sliderId: 'input-text-opacity', badgeId: 'val-text-opacity',
    min: 0, max: 100, step: 1, unit: '%',
    onChange: (v) => updateState({ textOpacity: v })
  });

  numeric.backgroundOpacity = initNumericControl({
    sliderId: 'input-background-opacity', badgeId: 'val-background-opacity',
    min: 0, max: 100, step: 1, unit: '%',
    onChange: (v) => updateState({ backgroundOpacity: v })
  });

  // 4c. Shadow Mode (None / Individual / Unified) — now a real React
  // component (SidebarInspector.jsx), same "one state, several DOM
  // effects" reasoning as the preset buttons/caption mode above: it drives
  // its own selected tab AND which of three settings groups (Individual's
  // sliders, its own color swatch, Unified's controls) is visible.

  // Text Blend Mode: 'normal' is stored as null ("unset, defer to the active
  // preset's own textBlendMode" — same convention activeWordColor/shadowColor
  // etc. already use), so a preset's own blend mode (e.g. Chrome Blend's
  // 'screen') still shows through until the user explicitly picks something
  // here. See resolveTextBlendMode in shared/captionConfig.js.
  const textBlendModeSelect = document.getElementById('text-blend-mode-select');
  if (textBlendModeSelect) {
    textBlendModeSelect.addEventListener('change', (e) => {
      updateState({ textBlendMode: e.target.value === 'normal' ? null : e.target.value });
    });
  }

  numeric.unifiedShadowOpacity = initNumericControl({
    sliderId: 'input-unified-shadow-opacity', badgeId: 'val-unified-shadow-opacity',
    min: 0, max: 100, step: 1, unit: '%',
    onChange: (v) => updateState({ unifiedShadowOpacity: v })
  });

  // Matches Individual mode's own Shadow Blur range (see above) for consistency.
  numeric.unifiedShadowBlur = initNumericControl({
    sliderId: 'input-unified-shadow-blur', badgeId: 'val-unified-shadow-blur',
    min: 0, max: 100, step: 1, unit: 'px',
    onChange: (v) => updateState({ unifiedShadowBlur: v })
  });

  numeric.unifiedShadowOffsetX = initNumericControl({
    sliderId: 'input-unified-shadow-offset-x', badgeId: 'val-unified-shadow-offset-x',
    min: -100, max: 100, step: 1, unit: 'px',
    onChange: (v) => updateState({ unifiedShadowOffsetX: v })
  });

  numeric.unifiedShadowOffsetY = initNumericControl({
    sliderId: 'input-unified-shadow-offset-y', badgeId: 'val-unified-shadow-offset-y',
    min: -100, max: 100, step: 1, unit: 'px',
    onChange: (v) => updateState({ unifiedShadowOffsetY: v })
  });

  // 5. Animation Mode & Pop Scale Inputs
  const animModeRadios = document.getElementsByName('anim-mode');

  animModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateState({ animationMode: e.target.value });
    });
  });

  // Pop Scale: previously capped at 150% (1.5x). Raised to 300% for more
  // dramatic pop emphasis when intentionally wanted.
  numeric.popScale = initNumericControl({
    sliderId: 'input-pop-scale', badgeId: 'val-pop-scale',
    min: 100, max: 300, step: 1, unit: '%',
    onChange: (v) => updateState({ popScale: v })
  });

  // 5b. Caption Entrance Animation (shared/captionAnimation.js) — a separate
  // concept from Animation Mode/popScale above (per-word highlight timing);
  // this controls how the whole caption block enters.
  const captionAnimationTypeSelect = document.getElementById('caption-animation-type-select');
  if (captionAnimationTypeSelect) {
    captionAnimationTypeSelect.addEventListener('change', (e) => {
      updateState({ captionAnimationType: e.target.value });
    });
  }

  // Duration is authored in whole milliseconds in the UI (matches every
  // other ms-domain slider in this file) but stored/consumed in seconds
  // (matches word.start/end's own unit) — converted at this one boundary.
  numeric.captionAnimationDuration = initNumericControl({
    sliderId: 'input-caption-animation-duration', badgeId: 'val-caption-animation-duration',
    min: 50, max: 1000, step: 10, unit: 'ms',
    onChange: (v) => updateState({ captionAnimationDuration: v / 1000 })
  });

  const captionAnimationEasingSelect = document.getElementById('caption-animation-easing-select');
  if (captionAnimationEasingSelect) {
    captionAnimationEasingSelect.addEventListener('change', (e) => {
      updateState({ captionAnimationEasing: e.target.value });
    });
  }

  // 6. Subtitle Position & Spacing Inputs
  const positionRadios = document.getElementsByName('sub-pos');

  positionRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const newPosition = e.target.value;
      if (newPosition === 'manual') {
        updateState({ position: newPosition });
      } else {
        // Switching back to a preset resets the dragged custom position, so
        // re-entering Manual mode later always starts from the same default
        // spot rather than a stale dragged one.
        updateState({ position: newPosition, customPosX: 50, customPosY: 85 });
      }
    });
  });

  // Margin V is a position offset within the 1080x1920 export canvas —
  // widened to the full 0-1900 range so the caption can be pushed all the
  // way to either edge, not just the middle band the old 50-800 cap allowed.
  numeric.marginV = initNumericControl({
    sliderId: 'input-margin-v', badgeId: 'val-margin-v',
    min: 0, max: 1900, step: 1, unit: 'px',
    onChange: (v) => updateState({ marginV: v })
  });

  // 7. AI Keyword Highlighting Toggle
  const toggleKeywordHighlighting = document.getElementById('toggle-keyword-highlighting');
  if (toggleKeywordHighlighting) {
    toggleKeywordHighlighting.addEventListener('change', (e) => {
      updateState({ enableKeywordHighlighting: e.target.checked });
    });
  }

  // 8. Keyword Style Section (keyword-driven presets, e.g. WAYLES)
  const toggleActiveHighlight = document.getElementById('toggle-active-highlight');
  const selectKeywordFont = document.getElementById('select-keyword-font');
  const selectKeywordWeight = document.getElementById('select-keyword-weight');
  const selectKeywordAnimation = document.getElementById('select-keyword-animation');
  const toggleKeywordShadow = document.getElementById('toggle-keyword-shadow');
  const toggleKeywordOutline = document.getElementById('toggle-keyword-outline');

  if (toggleActiveHighlight) {
    toggleActiveHighlight.addEventListener('change', (e) => {
      updateState({ enableActiveHighlight: e.target.checked });
    });
  }

  if (selectKeywordFont) {
    selectKeywordFont.addEventListener('change', (e) => {
      updateState({ keywordFont: e.target.value || null });
    });
  }

  if (selectKeywordWeight) {
    selectKeywordWeight.addEventListener('change', (e) => {
      updateState({ keywordWeight: e.target.value || null });
    });
  }

  // Keyword Scale: state stores a 1.0-3.0 ratio (appState.keywordScale),
  // displayed/edited as 100-300%. Raised from the old 100-150% cap for
  // consistency with Pop Scale above, and to let the keyword layer read as
  // genuinely much larger than normal text where that's the intended effect
  // (see Rolling Stack's "keyword occupies more visual space" typography).
  numeric.keywordScale = initNumericControl({
    sliderId: 'input-keyword-scale', badgeId: 'val-keyword-scale',
    min: 100, max: 300, step: 1, unit: '%',
    onChange: (v) => updateState({ keywordScale: v }),
    toState: (displayValue) => displayValue / 100,
    fromState: (stateValue) => stateValue * 100
  });

  if (selectKeywordAnimation) {
    selectKeywordAnimation.addEventListener('change', (e) => {
      updateState({ keywordAnimation: e.target.value || null });
    });
  }

  if (toggleKeywordShadow) {
    toggleKeywordShadow.addEventListener('change', (e) => {
      updateState({ keywordShadowEnabled: e.target.checked });
    });
  }

  if (toggleKeywordOutline) {
    toggleKeywordOutline.addEventListener('change', (e) => {
      updateState({ keywordOutlineEnabled: e.target.checked });
    });
  }

  numeric.keywordOpacity = initNumericControl({
    sliderId: 'input-keyword-opacity', badgeId: 'val-keyword-opacity',
    min: 0, max: 100, step: 1, unit: '%',
    onChange: (v) => updateState({ keywordOpacity: v })
  });

  // 9. Subscribe to global state changes to synchronize UI controls — only
  // ONCE ever (unlike everything above, which re-runs per call — see this
  // function's own doc comment): syncSidebarUI() re-queries the DOM fresh
  // every time it fires (querySelectorAll/getElementById, not a captured
  // reference), so it stays correct regardless of which section is
  // currently visible. Subscribing again on every call would leak one more
  // duplicate subscription per tool switch for the lifetime of the page —
  // still correct (each would just redundantly re-run the same sync), but
  // needlessly growing memory/work over a long editing session.
  if (!subscribedToStateChanges) {
    subscribedToStateChanges = true;
    subscribe('*', () => {
      syncSidebarUI();
    });
  }

  syncSidebarUI();
}

/**
 * Synchronize input controls with global appState values
 */
function syncSidebarUI() {
  // Preset Buttons and Caption Mode are now real React components
  // (SidebarInspector.jsx's PRESET_BUTTONS/handleCaptionModeChange) reading
  // directly from useEditorStore — nothing to sync here anymore, including
  // the Rolling Stack settings group's visibility, which used to be derived
  // from captionMode right here too.
  document.getElementsByName('rolling-stack-layer-count').forEach((r) => {
    r.checked = parseInt(r.value, 10) === (appState.rollingStackLayerCount ?? 2);
  });
  document.getElementsByName('rolling-stack-alignment').forEach((r) => {
    r.checked = r.value === (appState.rollingStackAlignment || 'center');
  });

  // Font Family
  const fontFamilySelect = document.getElementById('font-family-select');
  if (fontFamilySelect && fontFamilySelect.value !== appState.fontFamily) {
    fontFamilySelect.value = appState.fontFamily;
  }

  numeric.fontSize?.sync(appState.fontSize);
  numeric.wordSpacing?.sync(appState.wordSpacing);

  // Colors: each <ColorPickerField> now reads directly from useEditorStore
  // via SidebarInspector.jsx's own subscription, so there's nothing to sync
  // here anymore.

  // Outline, Shadow & Opacity
  numeric.outlineSize?.sync(appState.outlineSize ?? getFallbackOutlineSize());
  numeric.shadowSize?.sync(appState.shadowSize ?? getFallbackShadowSize());
  numeric.shadowOffsetX?.sync(appState.shadowOffsetX ?? getFallbackShadowOffset());
  numeric.shadowOffsetY?.sync(appState.shadowOffsetY ?? getFallbackShadowOffset());
  numeric.textOpacity?.sync(appState.textOpacity ?? 100);
  numeric.backgroundOpacity?.sync(appState.backgroundOpacity ?? 100);

  // Shadow Mode + Unified Shadow controls are now a real React component
  // (SidebarInspector.jsx) — nothing to sync here anymore.

  // Text Blend Mode: reflects the user's own override if set, else the
  // active preset's own textBlendMode, else 'normal' — mirrors
  // resolveTextBlendMode's exact fallback order.
  const textBlendModeSelect = document.getElementById('text-blend-mode-select');
  if (textBlendModeSelect) {
    const effectiveBlendMode = appState.textBlendMode || getCurrentProfile().textBlendMode || 'normal';
    if (textBlendModeSelect.value !== effectiveBlendMode) {
      textBlendModeSelect.value = effectiveBlendMode;
    }
  }

  const fallbackUnified = getFallbackUnifiedShadow();
  numeric.unifiedShadowOpacity?.sync(appState.unifiedShadowOpacity ?? fallbackUnified.opacity);
  numeric.unifiedShadowBlur?.sync(appState.unifiedShadowBlur ?? fallbackUnified.blurAss);
  numeric.unifiedShadowOffsetX?.sync(appState.unifiedShadowOffsetX ?? fallbackUnified.offsetXAss);
  numeric.unifiedShadowOffsetY?.sync(appState.unifiedShadowOffsetY ?? fallbackUnified.offsetYAss);

  // Animation Mode
  const animModeRadios = document.getElementsByName('anim-mode');
  animModeRadios.forEach(r => {
    r.checked = r.value === appState.animationMode;
  });

  numeric.popScale?.sync(appState.popScale);

  // Caption Entrance Animation
  const captionAnimationTypeSelect = document.getElementById('caption-animation-type-select');
  if (captionAnimationTypeSelect && captionAnimationTypeSelect.value !== appState.captionAnimationType) {
    captionAnimationTypeSelect.value = appState.captionAnimationType || 'none';
  }
  numeric.captionAnimationDuration?.sync(Math.round((appState.captionAnimationDuration ?? 0.25) * 1000));
  const captionAnimationEasingSelect = document.getElementById('caption-animation-easing-select');
  if (captionAnimationEasingSelect && captionAnimationEasingSelect.value !== appState.captionAnimationEasing) {
    captionAnimationEasingSelect.value = appState.captionAnimationEasing || 'ease-out';
  }

  // Position & Margin
  const positionRadios = document.getElementsByName('sub-pos');
  positionRadios.forEach(r => {
    r.checked = r.value === appState.position;
  });

  const manualPosHint = document.getElementById('manual-pos-hint');
  if (manualPosHint) manualPosHint.hidden = appState.position !== 'manual';

  numeric.marginV?.sync(appState.marginV || 300);

  // AI Keyword Highlighting Toggle
  const toggleKeywordHighlighting = document.getElementById('toggle-keyword-highlighting');
  if (toggleKeywordHighlighting) toggleKeywordHighlighting.checked = !!appState.enableKeywordHighlighting;

  // Keyword Style Section (keyword-driven presets, e.g. WAYLES)
  const toggleActiveHighlight = document.getElementById('toggle-active-highlight');
  if (toggleActiveHighlight) {
    toggleActiveHighlight.checked = appState.enableActiveHighlight ?? getFallbackActiveHighlightEnabled();
  }

  const selectKeywordFont = document.getElementById('select-keyword-font');
  if (selectKeywordFont) selectKeywordFont.value = appState.keywordFont || '';

  const selectKeywordWeight = document.getElementById('select-keyword-weight');
  if (selectKeywordWeight) selectKeywordWeight.value = appState.keywordWeight || '';

  numeric.keywordScale?.sync(appState.keywordScale ?? getFallbackKeywordTier().fontScale);

  const selectKeywordAnimation = document.getElementById('select-keyword-animation');
  if (selectKeywordAnimation) {
    selectKeywordAnimation.value = appState.keywordAnimation || getFallbackKeywordTier().animation || 'none';
  }

  const toggleKeywordShadow = document.getElementById('toggle-keyword-shadow');
  if (toggleKeywordShadow) {
    toggleKeywordShadow.checked = appState.keywordShadowEnabled ?? getFallbackKeywordTier().shadowByDefault;
  }

  const toggleKeywordOutline = document.getElementById('toggle-keyword-outline');
  if (toggleKeywordOutline) {
    toggleKeywordOutline.checked = appState.keywordOutlineEnabled ?? getFallbackKeywordTier().outlineByDefault;
  }

  numeric.keywordOpacity?.sync(appState.keywordOpacity ?? 100);
}
