/**
 * HEX/RGB/HSL conversion utilities for ColorPickerField.jsx.
 *
 * The graphics renderer (shared/captionGraphics.js) and every other consumer
 * only ever deal in plain 6-digit hex strings for color, plus separate
 * numeric 0-100 opacity fields for the handful of fields that have one (see
 * ColorPickerField.jsx's FIELD_OPACITY_MAP) — never a combined 8-digit
 * "#RRGGBBAA" or an {r,g,b,a} object. Those richer shapes exist ONLY inside
 * this picker's own UI/editing model (matching how the previous
 * implementation's HSV math was already picker-internal, never touching the
 * committed state's own shape) and get split back into that plain
 * hex+opacity pair the instant a value is committed.
 */

export function isValidHex6(value) {
  return /^#[0-9a-f]{6}$/i.test((value || '').trim());
}

/**
 * Normalizes to a real 6-digit "#RRGGBB" — including expanding CSS's
 * 3-digit shorthand (e.g. "2E8" -> "22EE88"). That expansion matters here
 * specifically because react-colorful's HexColorInput calls onChange the
 * MOMENT its internal length-validator passes (3, 6, or — with alpha — 4/8
 * hex digits), which happens naturally partway through normal character-by-
 * character typing (typing "2E8B57" passes through the valid 3-digit state
 * "2E8" first). Without expansion here, that intermediate value was being
 * treated as a complete-but-short 6-digit color, silently corrupting the
 * rest of the in-progress typing (confirmed directly: typing "2E8B57" one
 * keystroke at a time produced "#2E8FFB" instead, because the not-yet-
 * expanded "2E8" got concatenated with a trailing alpha byte and re-fed
 * back into the input as if it were already a valid 6-digit value).
 */
export function normalizeHex6(value) {
  const trimmed = (value || '').trim();
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const expanded = withoutHash.length === 3
    ? withoutHash.split('').map((c) => c + c).join('')
    : withoutHash;
  return `#${expanded}`.toUpperCase();
}

export function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return {
    r: parseInt(full.substring(0, 2), 16),
    g: parseInt(full.substring(2, 4), 16),
    b: parseInt(full.substring(4, 6), 16)
  };
}

export function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }) {
  const sn = s / 100, ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function hexToHsl(hex) {
  return rgbToHsl(hexToRgb(hex));
}

export function hslToHex(hsl) {
  return rgbToHex(hslToRgb(hsl));
}

/** Clamps to a valid 0-100 opacity, defaulting to 100 for anything invalid. */
export function clampOpacity(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 100;
  return Math.max(0, Math.min(100, n));
}

/** Combines a 6-digit hex + 0-100 opacity into react-colorful's own
 * "#RRGGBBAA" 8-digit format (its HexAlphaColorPicker/HexColorInput's native
 * value shape) — purely a UI-layer convenience, never stored in appState. */
export function hex6AndOpacityToHex8(hex6, opacity) {
  const alphaByte = Math.round((clampOpacity(opacity) / 100) * 255);
  return `${normalizeHex6(hex6)}${alphaByte.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Inverse of hex6AndOpacityToHex8 — splits react-colorful's 8-digit value
 * back into the plain 6-digit hex + 0-100 opacity pair the app's committed
 * state actually stores. */
export function hex8ToHex6AndOpacity(hex8) {
  const clean = (hex8 || '').replace('#', '');
  const hex6 = normalizeHex6(`#${clean.substring(0, 6)}`);
  const alphaHex = clean.substring(6, 8) || 'FF';
  const opacity = Math.round((parseInt(alphaHex, 16) / 255) * 100);
  return { hex6, opacity };
}
