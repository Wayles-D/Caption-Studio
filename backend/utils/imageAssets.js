/**
 * Uploaded IMAGE assets (see shared/imageLayer.js) — where they are stored,
 * how a client-supplied asset id is turned into a path safely, and decoding
 * them once per export for the frame generator.
 *
 * The same arrangement imported audio uses (backend/utils/audioMixFilter.js's
 * AUDIO_UPLOADS_DIR / resolveAudioAssetPath): a directory of its own, so the
 * per-job cleanup sweep can never take a picture that is still on a timeline,
 * and UUID file names, never the user's.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadImage } from '@napi-rs/canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const IMAGE_UPLOADS_DIR = process.env.IMAGE_UPLOADS_DIR || path.join(__dirname, '..', 'images');

/** A stored image's id is a bare UUID file name with an image extension. */
export const IMAGE_ASSET_ID = /^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/i;

/** The file for an asset id, or null — validated, and kept inside the images directory. */
export function resolveImageAssetPath(assetId) {
  if (typeof assetId !== 'string' || !IMAGE_ASSET_ID.test(assetId)) return null;
  const filePath = path.join(IMAGE_UPLOADS_DIR, assetId);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(IMAGE_UPLOADS_DIR)) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Decodes every picture the given layers use, ONCE each (a picture used by
 * several layers is decoded a single time), for one export. Returns a Map of
 * assetId → decoded image. A missing or undecodable file is left out — its
 * layers are skipped, with a warning, rather than failing the whole render.
 */
export async function loadImageSources(layers) {
  const sources = new Map();
  const ids = [...new Set((layers || []).map((layer) => layer.assetId))];
  await Promise.all(ids.map(async (assetId) => {
    const file = resolveImageAssetPath(assetId);
    if (!file) {
      console.warn(`[ImageAssets] Image ${assetId} is not on the server; its layers are left out of this render.`);
      return;
    }
    try {
      sources.set(assetId, await loadImage(file));
    } catch (err) {
      console.warn(`[ImageAssets] Could not decode ${assetId}: ${err.message}`);
    }
  }));
  return sources;
}
