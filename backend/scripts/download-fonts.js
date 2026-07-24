import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define curated creator fonts downloadable from Google Fonts GitHub OFL repo
const FONT_LIST = [
  { name: 'Inter.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf' },
  { name: 'Outfit.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/outfit/Outfit%5Bwght%5D.ttf' },
  { name: 'PlusJakartaSans.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf' },
  { name: 'Manrope.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/manrope/Manrope%5Bwght%5D.ttf' },
  { name: 'Anton.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf' },
  { name: 'BebasNeue.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf' },
  { name: 'LeagueSpartan.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/leaguespartan/LeagueSpartan%5Bwght%5D.ttf' },
  { name: 'ArchivoBlack.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/archivoblack/ArchivoBlack-Regular.ttf' },
  { name: 'BricolageGrotesque.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz%2Cwght%5D.ttf' },
  { name: 'Poppins.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf' },
  { name: 'SpaceGrotesk.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf' },
  { name: 'DMSans.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans%5Bopsz%2Cwdth%2Cwght%5D.ttf' },
  { name: 'IBMPlexSans.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/ibmplexsans/IBMPlexSans-Regular.ttf' },
  { name: 'SourceSans3.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/sourcesans3/SourceSans3%5Bwght%5D.ttf' },
  { name: 'InstrumentSans.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/instrumentsans/InstrumentSans%5Bwdth%2Cwght%5D.ttf' },
  { name: 'Montserrat.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf' },
  { name: 'LilitaOne.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/lilitaone/LilitaOne-Regular.ttf' },
  { name: 'Lexend.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/lexend/Lexend%5Bwght%5D.ttf' },
  { name: 'Rubik.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/rubik/Rubik%5Bwght%5D.ttf' },
  { name: 'Kanit.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/kanit/Kanit-Bold.ttf' },
  { name: 'Syne.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/syne/Syne%5Bwght%5D.ttf' },
  { name: 'Jost.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/jost/Jost%5Bwght%5D.ttf' }
];

const FONTS_DIR = path.join(__dirname, '../fonts');

// Helper function to download file with redirect support
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    function get(requestUrl) {
      https.get(requestUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // Follow redirect
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

        file.on('finish', () => {
          file.close(resolve);
        });
      }).on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
    }

    get(url);
  });
}

export async function downloadFonts() {
  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
  }

  console.log(`[FontDownloader] Target fonts directory: ${FONTS_DIR}`);
  console.log(`[FontDownloader] Fetching fonts library files (${FONT_LIST.length} total)...`);

  const downloadPromises = FONT_LIST.map(async (font) => {
    const fontPath = path.join(FONTS_DIR, font.name);
    if (fs.existsSync(fontPath)) {
      // Font already exists
      return;
    }

    try {
      console.log(`[FontDownloader] Downloading: ${font.name}`);
      await downloadFile(font.url, fontPath);
      console.log(`[FontDownloader] Download completed: ${font.name}`);
    } catch (error) {
      console.error(`[FontDownloader] Error downloading ${font.name}: ${error.message}`);
    }
  });

  await Promise.all(downloadPromises);
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
