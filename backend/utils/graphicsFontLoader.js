/**
 * Registers every font bundled in backend/fonts/ (per shared/fontRegistry.js
 * — the SAME registry the CSS preview and ASS exporter already resolve fonts
 * through) with @napi-rs/canvas's global font store, so the shared Canvas2D
 * graphics renderer (shared/captionGraphics.js) can draw text server-side
 * with the exact bundled font file, the same way libass does today via the
 * `fontsdir` ASS filter option (see backend/utils/ffmpeg.js).
 *
 * Adding a new font stays a shared/fontRegistry.js entry — this file never
 * needs to change.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { GlobalFonts } from '@napi-rs/canvas';
import { FONT_REGISTRY } from '../../shared/fontRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(__dirname, '..', 'fonts');

let registered = false;

/**
 * Idempotent: safe to call multiple times (e.g. once at server boot, and
 * again defensively before any graphics export) — only registers once.
 */
export function registerBackendCanvasFonts() {
  if (registered) return;
  registered = true;

  const registeredFamilies = new Set();
  Object.values(FONT_REGISTRY).forEach((fontEntry) => {
    Object.values(fontEntry.faces).forEach((face) => {
      const key = `${face.familyName}::${face.file}`;
      if (registeredFamilies.has(key)) return;
      registeredFamilies.add(key);

      const filePath = path.join(FONTS_DIR, face.file);
      try {
        GlobalFonts.registerFromPath(filePath, face.familyName);
      } catch (err) {
        console.error(`[GraphicsFontLoader] Failed to register font "${face.familyName}" from ${filePath}: ${err.message}`);
      }
    });
  });

  console.log(`[GraphicsFontLoader] Registered ${registeredFamilies.size} font faces for the graphics renderer.`);
}
