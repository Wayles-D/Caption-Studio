import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import uploadRouter from './routes/uploadRoute.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS with support for local development environments
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Request parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create necessary folders programmatically on startup
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
const transcriptsDir = path.join(__dirname, 'transcripts');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
if (!fs.existsSync(transcriptsDir)) {
  fs.mkdirSync(transcriptsDir, { recursive: true });
}

// Serve output directory static files (allows playing/downloading extracted audio)
app.use('/output', express.static(outputDir));

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
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Resource not found: ${req.originalUrl}`
  });
});

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
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`Caption Studio Backend running on port ${PORT}`);
  console.log(`Endpoints available:`);
  console.log(`  - Health Check:   GET  http://localhost:${PORT}/api/health`);
  console.log(`  - Video Upload:   POST http://localhost:${PORT}/api/upload`);
  console.log(`===============================================`);
});

export default app;
