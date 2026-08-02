import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { FONT_REGISTRY } from '../../shared/fontRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Manual recovery/setup script — NOT run automatically at server boot.
 * All fonts are bundled with the project (committed under backend/fonts/),
 * so normal operation never needs this. It exists only to re-fetch a
 * Google Fonts (OFL-licensed) file if it's ever accidentally deleted from
 * disk, without hand-maintaining a second, separately-drifting font list —
 * the file names below are read directly from shared/fontRegistry.js, the
 * single source of truth.
 *
 * Known source URL per bundled file, keyed by exactly the `file` value used
 * in the registry. Files with no entry here aren't Google-Fonts-sourced
 * (e.g. PP Editorial New, a BEFonts-licensed family) and must be manually
 * re-placed into backend/fonts/ — this script only warns about those, it
 * cannot fetch them.
 */
const KNOWN_SOURCE_URLS = {
  'Poppins-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Regular.ttf',
  'Poppins-Medium.ttf': 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Medium.ttf',
  'Poppins-SemiBold.ttf': 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-SemiBold.ttf',
  'Poppins-Bold.ttf': 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf',
  'Poppins-Italic.ttf': 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Italic.ttf',
  'Montserrat.ttf': 'https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf',
  'BebasNeue-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf',
  'Inter.ttf': 'https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf',
  'Outfit.ttf': 'https://github.com/google/fonts/raw/main/ofl/outfit/Outfit%5Bwght%5D.ttf',
  'PlusJakartaSans.ttf': 'https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf',
  'SpaceGrotesk.ttf': 'https://github.com/google/fonts/raw/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf',
  'Anton-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf',
  'LeagueSpartan.ttf': 'https://github.com/google/fonts/raw/main/ofl/leaguespartan/LeagueSpartan%5Bwght%5D.ttf',
  'ArchivoBlack-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/archivoblack/ArchivoBlack-Regular.ttf',
  'LilitaOne-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/lilitaone/LilitaOne-Regular.ttf',
  'Lexend.ttf': 'https://github.com/google/fonts/raw/main/ofl/lexend/Lexend%5Bwght%5D.ttf',
  'Rubik.ttf': 'https://github.com/google/fonts/raw/main/ofl/rubik/Rubik%5Bwght%5D.ttf',
  'Caveat.ttf': 'https://github.com/google/fonts/raw/main/ofl/caveat/Caveat%5Bwght%5D.ttf',
  'Kalam-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/kalam/Kalam-Regular.ttf',
  'Pacifico-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/pacifico/Pacifico-Regular.ttf',
  'GreatVibes-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/greatvibes/GreatVibes-Regular.ttf'
};

const FONTS_DIR = path.join(__dirname, '../fonts');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    function get(requestUrl) {
      https.get(requestUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          get(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`Failed to download ${requestUrl}: HTTP Status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
    }

    get(url);
  });
}

function listRegisteredFiles() {
  const files = new Set();
  Object.values(FONT_REGISTRY).forEach((entry) => {
    Object.values(entry.faces).forEach((face) => files.add(face.file));
  });
  return Array.from(files);
}

export async function downloadFonts() {
  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
  }

  const registeredFiles = listRegisteredFiles();
  const missing = registeredFiles.filter((file) => !fs.existsSync(path.join(FONTS_DIR, file)));

  if (missing.length === 0) {
    console.log('[FontDownloader] All registered font files already present — nothing to do.');
    return;
  }

  console.log(`[FontDownloader] Target fonts directory: ${FONTS_DIR}`);
  console.log(`[FontDownloader] ${missing.length} registered font file(s) missing.`);

  await Promise.all(missing.map(async (file) => {
    const url = KNOWN_SOURCE_URLS[file];
    if (!url) {
      console.warn(`[FontDownloader] No known source URL for "${file}" (likely not Google-Fonts-sourced) — place it manually into ${FONTS_DIR}.`);
      return;
    }
    try {
      console.log(`[FontDownloader] Downloading: ${file}`);
      await downloadFile(url, path.join(FONTS_DIR, file));
      console.log(`[FontDownloader] Download completed: ${file}`);
    } catch (error) {
      console.error(`[FontDownloader] Error downloading ${file}: ${error.message}`);
    }
  }));

  console.log('[FontDownloader] Font library check completed.');
}

// Allow direct execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  downloadFonts()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
