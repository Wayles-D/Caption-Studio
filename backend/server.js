import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import uploadRouter from './routes/uploadRoute.js';
import { cleanupJobAssets, runPeriodicCleanup } from './utils/cleanup.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS with support for local development environments and deployed production URL
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5001'];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or standard server-to-server calls)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    } else {
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

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
if (!fs.existsSync(transcriptsDir)) {
  fs.mkdirSync(transcriptsDir, { recursive: true });
}
if (!fs.existsSync(subtitlesDir)) {
  fs.mkdirSync(subtitlesDir, { recursive: true });
}

// Custom intercept handler for rendered video downloads to trigger cleanup on completion
app.get('/output/:filename', (req, res, next) => {
  const filename = req.params.filename;
  // Prevent directory traversal path injection by sanitizing basename
  const safeFilename = path.basename(filename);
  const filePath = path.join(outputDir, safeFilename);

  if (safeFilename.endsWith('_captioned.mp4')) {
    console.log(`[Server] Captioned video download requested: ${safeFilename}`);
    
    return res.sendFile(filePath, (err) => {
      if (err) {
        if (!res.headersSent) {
          console.error(`[Server] Error serving file ${safeFilename}: ${err.message}`);
          return next(err);
        }
        console.warn(`[Server] Download of ${safeFilename} was interrupted/aborted: ${err.message}`);
        return;
      }
      
      console.log(`[Server] Capture download SUCCESS: Completed serving ${safeFilename}. Running direct automatic cleanup.`);
      const baseName = safeFilename.replace('_captioned.mp4', '');
      cleanupJobAssets(baseName);
    });
  }

  // Pass-through to original express.static serving logic (e.g. WAV audio files)
  next();
});

// Serve output directory static files (allows playing/downloading extracted audio)
app.use('/output', express.static(outputDir));

// Serve subtitles directory static files (allows clients to download compiled ASS overlays)
app.use('/subtitles', express.static(subtitlesDir));

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
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`Caption Studio Backend running on port ${PORT}`);
    console.log(`Endpoints available:`);
    console.log(`  - Health Check:   GET  http://localhost:${PORT}/api/health`);
    console.log(`  - Video Upload:   POST http://localhost:${PORT}/api/upload`);
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
  });
}

export default app;
