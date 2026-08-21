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

function isValidHex(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test((value || '').trim());
}

function normalizeHex(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed}`.toUpperCase();
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
  const recentColors = getRecentColors();

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
  hexInput.addEventListener('input', () => {
    const val = hexInput.value.trim();
    const candidate = val.startsWith('#') ? val : `#${val}`;
    if (isValidHex(candidate)) {
      previewSwatch.style.background = candidate;
      updateState({ [field.key]: normalizeHex(candidate) });
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
  previewRow.appendChild(hexInput);
  popoverEl.appendChild(previewRow);

  const paletteLabel = document.createElement('div');
  paletteLabel.className = 'color-picker-section-label';
  paletteLabel.textContent = 'Preset Palette';
  popoverEl.appendChild(paletteLabel);
  popoverEl.appendChild(buildSwatchGrid(PRESET_PALETTE, field.key, currentColor));

  if (recentColors.length > 0) {
    const recentLabel = document.createElement('div');
    recentLabel.className = 'color-picker-section-label';
    recentLabel.textContent = 'Recently Used';
    popoverEl.appendChild(recentLabel);
    popoverEl.appendChild(buildSwatchGrid(recentColors, field.key, currentColor));
  }
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
