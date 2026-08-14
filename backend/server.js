import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import uploadRouter from './routes/uploadRoute.js';
import { cleanupJobAssets, runPeriodicCleanup } from './utils/cleanup.js';
import { FONT_REGISTRY } from '../shared/fontRegistry.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS with support for local development environments and deployed production URL
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5001'];

console.log(`[CORS] Allowed origins: ${allowedOrigins.join(', ')}${process.env.FRONTEND_URL ? ' (from FRONTEND_URL env var)' : ' (FRONTEND_URL env var not set — using dev-only defaults)'}`);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or standard server-to-server calls)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    } else {
      // Logged server-side (not just thrown) so a rejected-origin mismatch
      // shows up directly in Render logs instead of only as an opaque
      // network/CORS failure in the browser — this is the single most useful
      // signal for telling "FRONTEND_URL doesn't match the deployed frontend"
      // apart from "the backend crashed mid-request" (see burnSubtitles'
      // memory logging for the latter).
      console.warn(`[CORS] Rejected request from origin "${origin}" — not in allowed list: [${allowedOrigins.join(', ')}]. If this is the current frontend deployment, update the FRONTEND_URL env var on the backend host.`);
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      return callback(new Error(msg), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Request parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create necessary folders programmatically on startup (Render Linux directories)
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
const transcriptsDir = path.join(__dirname, 'transcripts');
const subtitlesDir = path.join(__dirname, 'subtitles');
const fontsDir = path.join(__dirname, 'fonts');

[uploadsDir, outputDir, transcriptsDir, subtitlesDir, fontsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Dynamically rewrite fonts.conf with absolute fonts directory path and set env for libass
const fontsConfTemplate = path.join(__dirname, 'fonts.conf');
if (fs.existsSync(fontsConfTemplate)) {
  let confContent = fs.readFileSync(fontsConfTemplate, 'utf8');
  if (confContent.includes('FONTS_DIR_PLACEHOLDER')) {
    confContent = confContent.replace('FONTS_DIR_PLACEHOLDER', fontsDir.replace(/\\/g, '/'));
    fs.writeFileSync(fontsConfTemplate, confContent, 'utf8');
    console.log(`[Fonts] Configured fonts.conf with directory: ${fontsDir}`);
  }
}
process.env.FONTCONFIG_FILE = fontsConfTemplate;

// Serve output directory static files (allows playing/downloading extracted audio)
app.use('/output', express.static(outputDir));

// Serve subtitles directory static files (allows clients to download compiled ASS overlays)
app.use('/subtitles', express.static(subtitlesDir));

// Serve the bundled font files so the browser preview can self-host the exact
// same fonts (via @font-face) that FFmpeg/libass burns into the exported
// video — see shared/fontRegistry.js, the single source of truth both sides
// resolve font files/names from.
app.use('/fonts', express.static(fontsDir));

// Route Mounting
app.use('/api/upload', uploadRouter);

// Base route for connectivity check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    message: 'Caption Studio Audio Extraction Backend is running.'
  });
});

// Generic 404 Route handler
if (process.env.NODE_ENV !== 'test') {
  app.use((req, res, next) => {
    res.status(404).json({
      success: false,
      message: `Resource not found: ${req.originalUrl}`
    });
  });
}

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);

  // Handle Multer specific errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: 'File too large. Maximum allowed size is 500MB.'
      });
    }
    return res.status(400).json({
      success: false,
      message: `File upload error: ${err.message}`
    });
  }

  // Handle file validation errors thrown in fileFilter
  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }

  // Handle the cors() middleware's own rejection (see the origin callback
  // above) with a proper 403 instead of falling through to the generic 500
  // below — the request never reached a route handler, so this is a client/
  // config error, not a server fault.
  if (err.message && err.message.includes('CORS policy')) {
    return res.status(403).json({
      success: false,
      message: err.message
    });
  }

  // Handle FFmpeg or other system errors
  const isDevelopment = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    success: false,
    message: err.message || 'An internal server error occurred during processing.',
    error: isDevelopment ? err.stack : undefined
  });
});

// Bind server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, async () => {
    console.log(`===============================================`);
    console.log(`Caption Studio Backend running on port ${PORT}`);
    console.log(`Endpoints available:`);
    console.log(`  - Health Check:   GET  http://localhost:${PORT}/api/health`);
    console.log(`  - Video Upload:   POST http://localhost:${PORT}/api/upload`);
    console.log(`  - Regenerate:     POST http://localhost:${PORT}/api/upload/regenerate`);
    console.log(`===============================================`);
    
    // Start cleanup daemon to run every 5 minutes (300,000 ms)
    const DAEMON_INTERVAL_MS = 300000;
    setInterval(() => {
      console.log('[Cleanup Daemon] Periodic cleanup tick triggered.');
      runPeriodicCleanup();
    }, DAEMON_INTERVAL_MS);

    // Proactively run on startup to catch files left behind from previous crashes
    console.log('[Cleanup Daemon] Running startup cleanup check...');
    runPeriodicCleanup();

    // All fonts are bundled with the project (backend/fonts/, registered in
    // shared/fontRegistry.js) — no network fetch at boot, so rendering never
    // depends on GitHub/CDN availability. If a font is ever missing from
    // disk, run `node backend/scripts/download-fonts.js` manually to
    // re-fetch the curated set (dev/setup convenience only, not a runtime path).
    const missingFonts = Object.values(FONT_REGISTRY)
      .flatMap((entry) => Object.values(entry.faces))
      .filter((face) => !fs.existsSync(path.join(fontsDir, face.file)));
    if (missingFonts.length > 0) {
      console.warn(`[Fonts] ${missingFonts.length} registered font file(s) missing from ${fontsDir} — export will fall back to the registry's default font for those. Run backend/scripts/download-fonts.js to restore them.`);
    } else {
      console.log(`[Fonts] All ${Object.keys(FONT_REGISTRY).length} registered font families present in ${fontsDir}.`);
    }
  });
}

export default app;
