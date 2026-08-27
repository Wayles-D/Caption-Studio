/**
 * Custom Color Picker Component for Caption Studio
 * Replaces native <input type="color"> swatches with a popover offering a
 * curated preset palette, hex entry, live preview, and recently-used colors
 * (persisted in localStorage). Selections apply instantly to appState so the
 * preview updates live and the same value flows through to export.
 */
import { appState, updateState } from '../state.js';
import { registerDismissable } from '../utils/clickOutside.js';

const RECENT_COLORS_STORAGE_KEY = 'captionStudio.recentColors';
const MAX_RECENT_COLORS = 8;

const PRESET_PALETTE = [
  '#FFFFFF', '#000000', '#FEF08A', '#FACC15', '#FB923C', '#F87171',
  '#F472B6', '#C084FC', '#818CF8', '#38BDF8', '#2DD4BF', '#4ADE80'
];

const PICKER_FIELDS = [
  { key: 'activeWordColor', triggerId: 'color-active-word', label: 'Active Word Color' },
  { key: 'inactiveWordColor', triggerId: 'color-inactive-word', label: 'Inactive Word Color' },
  { key: 'outlineColor', triggerId: 'color-outline', label: 'Outline Color' },
  { key: 'backgroundColor', triggerId: 'color-background', label: 'Background Color' },
  { key: 'shadowColor', triggerId: 'color-shadow', label: 'Shadow Color' },
  { key: 'unifiedShadowColor', triggerId: 'color-unified-shadow', label: 'Unified Shadow Color' },
  { key: 'keywordColor', triggerId: 'color-keyword', label: 'Keyword Color' }
];

let popoverEl = null;
let activeFieldKey = null;
let isRenderingPopover = false;
// Set by renderPopoverContentInner each time it (re)builds the currently-open
// popover — lets the visual picker's onCommit (see buildVisualColorArea's
// call site) refresh just the preset/recents swatches without rebuilding the
// whole popover. Always non-null while a popover is open.
let refreshSwatchSections = null;

function isValidHex(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test((value || '').trim());
}

function normalizeHex(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed}`.toUpperCase();
}

// --- HSV <-> HEX conversion for the visual saturation/value area + hue strip.
// The graphics renderer and every other consumer only ever deal in hex (see
// this module's own commitColor/updateState calls) — HSV only exists
// transiently here, as the picker's own interaction model, matching how a
// standard visual color picker (Canva, Figma, etc.) works.

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return {
    r: parseInt(full.substring(0, 2), 16),
    g: parseInt(full.substring(2, 4), 16),
    b: parseInt(full.substring(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function rgbToHsv({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function hsvToRgb({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function hexToHsv(hex) {
  return rgbToHsv(hexToRgb(hex));
}

function hsvToHex(hsv) {
  return rgbToHex(hsvToRgb(hsv));
}

/**
 * Clamps a pointer event's position within `rect` to a 0-1 ratio on each axis.
 */
function pointerRatio(event, rect) {
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  return { x, y };
}

/**
 * The visual color-selection surface: a saturation/value area (drag to pick
 * saturation horizontally, brightness vertically, for the current hue) plus
 * a hue strip below it (drag to pick the hue itself) — the actual "visually
 * choose a color" experience the preset-swatches-and-hex-only picker didn't
 * have. Pure DOM/CSS (two stacked gradient layers over a solid hue color,
 * the standard technique — no canvas needed), driven by Pointer Events so
 * mouse and touch share one code path, matching how this codebase's other
 * drag interaction (preview.js's manual caption-position dragging) already
 * works.
 *
 * @param {string} initialHex
 * @param {(hex:string) => void} onLiveChange - Called continuously while dragging (and on every discrete click) — apply immediately, never re-render the popover from here.
 * @param {(hex:string) => void} onCommit - Called once when a drag ends (pointerup) — safe to do heavier work here (recents list, re-rendering swatch highlights).
 * @returns {{element: HTMLElement, setHex: (hex:string) => void}} `setHex` re-syncs the cursors when the color changes from elsewhere (e.g. the hex input, or a preset swatch), without feeding back into onLiveChange itself.
 */
function buildVisualColorArea(initialHex, onLiveChange, onCommit) {
  const container = document.createElement('div');
  container.className = 'color-picker-visual-area';

  const svArea = document.createElement('div');
  svArea.className = 'color-picker-sv-area';
  const svHueLayer = document.createElement('div');
  svHueLayer.className = 'color-picker-sv-hue-layer';
  const svWhiteLayer = document.createElement('div');
  svWhiteLayer.className = 'color-picker-sv-white-layer';
  const svBlackLayer = document.createElement('div');
  svBlackLayer.className = 'color-picker-sv-black-layer';
  const svCursor = document.createElement('div');
  svCursor.className = 'color-picker-sv-cursor';
  svArea.append(svHueLayer, svWhiteLayer, svBlackLayer, svCursor);

  const hueStrip = document.createElement('div');
  hueStrip.className = 'color-picker-hue-strip';
  const hueCursor = document.createElement('div');
  hueCursor.className = 'color-picker-hue-cursor';
  hueStrip.appendChild(hueCursor);

  container.append(svArea, hueStrip);

  let hsv = hexToHsv(initialHex);

  const paintCursors = () => {
    svHueLayer.style.background = `hsl(${hsv.h}, 100%, 50%)`;
    svCursor.style.left = `${hsv.s * 100}%`;
    svCursor.style.top = `${(1 - hsv.v) * 100}%`;
    hueCursor.style.left = `${(hsv.h / 360) * 100}%`;
  };
  paintCursors();

  const dragHandler = (moveEvent) => {
    const rect = svArea.getBoundingClientRect();
    const { x, y } = pointerRatio(moveEvent, rect);
    hsv = { ...hsv, s: x, v: 1 - y };
    paintCursors();
    onLiveChange(hsvToHex(hsv));
  };

  svArea.addEventListener('pointerdown', (e) => {
    svArea.setPointerCapture(e.pointerId);
    dragHandler(e);
    const onMove = (moveEvent) => dragHandler(moveEvent);
    const onUp = (upEvent) => {
      svArea.removeEventListener('pointermove', onMove);
      svArea.removeEventListener('pointerup', onUp);
      onCommit(hsvToHex(hsv));
    };
    svArea.addEventListener('pointermove', onMove);
    svArea.addEventListener('pointerup', onUp);
  });

  const hueDragHandler = (moveEvent) => {
    const rect = hueStrip.getBoundingClientRect();
    const { x } = pointerRatio(moveEvent, rect);
    hsv = { ...hsv, h: x * 360 };
    paintCursors();
    onLiveChange(hsvToHex(hsv));
  };

  hueStrip.addEventListener('pointerdown', (e) => {
    hueStrip.setPointerCapture(e.pointerId);
    hueDragHandler(e);
    const onMove = (moveEvent) => hueDragHandler(moveEvent);
    const onUp = () => {
      hueStrip.removeEventListener('pointermove', onMove);
      hueStrip.removeEventListener('pointerup', onUp);
      onCommit(hsvToHex(hsv));
    };
    hueStrip.addEventListener('pointermove', onMove);
    hueStrip.addEventListener('pointerup', onUp);
  });

  return {
    element: container,
    setHex(hex) {
      hsv = hexToHsv(hex);
      paintCursors();
    }
  };
}

function getRecentColors() {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isValidHex) : [];
  } catch {
    return [];
  }
}

function addRecentColor(hex) {
  const existing = getRecentColors().filter((c) => c.toLowerCase() !== hex.toLowerCase());
  existing.unshift(hex);
  const trimmed = existing.slice(0, MAX_RECENT_COLORS);
  try {
    localStorage.setItem(RECENT_COLORS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — recents just won't persist
  }
  return trimmed;
}

/**
 * Resolves the color currently shown on a swatch: the user's custom override
 * if set, otherwise the preset-resolved fallback passed in by the caller.
 */
function getEffectiveColor(fieldKey, fallback) {
  return appState[fieldKey] || fallback || '#FFFFFF';
}

function commitColor(fieldKey, hex) {
  if (!isValidHex(hex)) return;
  const normalized = normalizeHex(hex);
  updateState({ [fieldKey]: normalized });
  addRecentColor(normalized);
  renderPopoverContent(); // refresh recents list + swatch highlight in place (guarded against re-entrancy)
}

function ensurePopover() {
  if (popoverEl) return popoverEl;

  popoverEl = document.createElement('div');
  popoverEl.className = 'color-picker-popover';
  popoverEl.setAttribute('role', 'dialog');
  popoverEl.hidden = true;
  document.body.appendChild(popoverEl);

  popoverEl.addEventListener('click', (e) => e.stopPropagation());

  registerDismissable({
    getElement: () => popoverEl,
    isTrigger: (target) => !!target.closest?.('.color-swatch-trigger'),
    onDismiss: closePopover
  });

  return popoverEl;
}

function renderPopoverContent() {
  if (!popoverEl || !activeFieldKey || isRenderingPopover) return;
  isRenderingPopover = true;

  try {
    renderPopoverContentInner();
  } finally {
    isRenderingPopover = false;
  }
}

function renderPopoverContentInner() {
  const field = PICKER_FIELDS.find((f) => f.key === activeFieldKey);
  const currentColor = getEffectiveColor(field.key, popoverEl.dataset.fallback);

  popoverEl.innerHTML = '';

  const headerRow = document.createElement('div');
  headerRow.className = 'color-picker-header-row';

  const heading = document.createElement('div');
  heading.className = 'color-picker-heading';
  heading.textContent = field.label;
  headerRow.appendChild(heading);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'color-picker-close-btn';
  closeBtn.setAttribute('aria-label', 'Close color picker');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => closePopover());
  headerRow.appendChild(closeBtn);

  popoverEl.appendChild(headerRow);

  const previewRow = document.createElement('div');
  previewRow.className = 'color-picker-preview-row';

  const previewSwatch = document.createElement('span');
  previewSwatch.className = 'color-picker-live-preview';
  previewSwatch.style.background = isValidHex(currentColor) ? currentColor : '#000000';
  previewRow.appendChild(previewSwatch);

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'color-picker-hex-input';
  hexInput.value = currentColor;
  hexInput.spellcheck = false;
  hexInput.maxLength = 7;
  previewRow.appendChild(hexInput);

  // Visual saturation/value area + hue strip — a real color-selection
  // surface, not just presets+hex. Built before the preview row is appended
  // so its live-update callbacks can already reference previewSwatch/hexInput.
  const visualArea = buildVisualColorArea(
    isValidHex(currentColor) ? currentColor : '#000000',
    (hex) => {
      // Continuous update while dragging: apply immediately, never re-render
      // the popover mid-drag (that would tear down the very cursor the user
      // is dragging).
      previewSwatch.style.background = hex;
      hexInput.value = hex;
      updateState({ [field.key]: hex });
    },
    (hex) => {
      // On drag release: record the recent color and refresh just the
      // swatch sections — deliberately NOT the full commitColor()/
      // renderPopoverContent() path used by the hex input and preset clicks
      // below. Rebuilding the whole popover re-derives hue/saturation from
      // the committed HEX, which is lossy for achromatic colors (black/white/
      // gray have no defined hue) — that would silently reset the hue strip
      // to 0 the instant a user picks a hue while still at zero saturation,
      // breaking the natural "drag hue, then drag saturation" two-step
      // gesture. The visual area keeps its own live HSV state across commits
      // within one popover session; only a fresh open (or a discrete hex/
      // preset pick) re-seeds it from hex.
      addRecentColor(hex);
      refreshSwatchSections(hex);
    }
  );
  popoverEl.appendChild(visualArea.element);

  hexInput.addEventListener('input', () => {
    const val = hexInput.value.trim();
    const candidate = val.startsWith('#') ? val : `#${val}`;
    if (isValidHex(candidate)) {
      const normalized = normalizeHex(candidate);
      previewSwatch.style.background = normalized;
      visualArea.setHex(normalized);
      updateState({ [field.key]: normalized });
    }
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commitColor(field.key, hexInput.value);
    }
  });
  hexInput.addEventListener('blur', () => {
    if (isValidHex(hexInput.value)) {
      commitColor(field.key, hexInput.value);
    }
  });
  popoverEl.appendChild(previewRow);

  // Preset + recent swatches live in their own container so a color settled
  // from the visual picker (see above) can refresh just this section —
  // updating recency order and active-swatch highlighting — without
  // rebuilding the visual picker itself.
  const swatchSections = document.createElement('div');
  swatchSections.className = 'color-picker-swatch-sections';
  popoverEl.appendChild(swatchSections);

  const renderSwatchSections = (highlightColor) => {
    swatchSections.innerHTML = '';

    const paletteLabel = document.createElement('div');
    paletteLabel.className = 'color-picker-section-label';
    paletteLabel.textContent = 'Preset Palette';
    swatchSections.appendChild(paletteLabel);
    swatchSections.appendChild(buildSwatchGrid(PRESET_PALETTE, field.key, highlightColor));

    const recents = getRecentColors();
    if (recents.length > 0) {
      const recentLabel = document.createElement('div');
      recentLabel.className = 'color-picker-section-label';
      recentLabel.textContent = 'Recently Used';
      swatchSections.appendChild(recentLabel);
      swatchSections.appendChild(buildSwatchGrid(recents, field.key, highlightColor));
    }
  };

  renderSwatchSections(currentColor);

  // Exposed for the visual picker's onCommit above (module-scoped so it can
  // reach the section currently open — there is only ever one popover).
  refreshSwatchSections = renderSwatchSections;
}

function buildSwatchGrid(colors, fieldKey, currentColor) {
  const grid = document.createElement('div');
  grid.className = 'color-picker-swatch-grid';

  colors.forEach((hex) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-picker-swatch';
    swatch.style.background = hex;
    swatch.setAttribute('aria-label', hex);
    if (currentColor && hex.toLowerCase() === currentColor.toLowerCase()) {
      swatch.classList.add('active');
    }
    swatch.addEventListener('click', () => commitColor(fieldKey, hex));
    grid.appendChild(swatch);
  });

  return grid;
}

function openPopover(triggerEl, fieldKey, fallback) {
  const popover = ensurePopover();
  activeFieldKey = fieldKey;
  popover.dataset.fallback = fallback || '';

  renderPopoverContent();
  popover.hidden = false;

  const rect = triggerEl.getBoundingClientRect();
  const popoverWidth = 232; // matches CSS width; used to keep the popover on-screen
  const popoverHeight = popover.getBoundingClientRect().height;

  const left = Math.min(rect.left, window.innerWidth - popoverWidth - 16);

  // Flip above the trigger when there isn't enough room below the viewport,
  // and clamp so the panel never gets clipped off the top edge either.
  const fitsBelow = rect.bottom + 8 + popoverHeight <= window.innerHeight;
  const top = fitsBelow
    ? rect.bottom + 8
    : Math.max(8, rect.top - popoverHeight - 8);

  popover.style.top = `${top + window.scrollY}px`;
  popover.style.left = `${Math.max(16, left) + window.scrollX}px`;
}

function closePopover() {
  if (popoverEl) popoverEl.hidden = true;
  activeFieldKey = null;
}

/**
 * Wires up the four color swatch triggers. `getFallbackColor(fieldKey)` lets
 * the caller supply the current preset-resolved color to show when the user
 * hasn't picked a custom override yet.
 */
export function initColorPicker({ getFallbackColor }) {
  PICKER_FIELDS.forEach((field) => {
    const trigger = document.getElementById(field.triggerId);
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const fallback = getFallbackColor ? getFallbackColor(field.key) : undefined;
      if (activeFieldKey === field.key && popoverEl && !popoverEl.hidden) {
        closePopover();
      } else {
        openPopover(trigger, field.key, fallback);
      }
    });
  });
}

/**
 * Repaints each swatch trigger's background to reflect the currently
 * resolved color (custom override or preset default). Deliberately never
 * touches the open popover's own DOM — that would tear down the hex input
 * (and its focus) on every keystroke's state notification. The popover
 * rebuilds itself explicitly on open and after a committed selection.
 */
export function syncColorSwatches(getFallbackColor) {
  PICKER_FIELDS.forEach((field) => {
    const trigger = document.getElementById(field.triggerId);
    if (!trigger) return;
    const fallback = getFallbackColor ? getFallbackColor(field.key) : undefined;
    trigger.style.background = getEffectiveColor(field.key, fallback);
  });
}
