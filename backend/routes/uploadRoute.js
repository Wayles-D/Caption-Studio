import { Router } from 'express';
import path from 'path';
import { uploadVideo } from '../utils/multerConfig.js';
import { uploadAndExtractAudio } from '../controllers/uploadController.js';

const router = Router();

/**
 * @route   POST /api/upload
 * @desc    Upload video file (MP4, MOV, WebM; max 500MB) and extract its audio to WAV
 * @access  Public
 */
router.post(
  '/',
  // Middleware 1: Log upload starts
  (req, res, next) => {
    req.uploadStartTime = Date.now();
    console.log(`[Pipeline] Stage: Video Upload Started...`);
    next();
  },
  // Multer middleware handles file upload, validation, and naming
  uploadVideo.single('video'),
  // Middleware 2: Log upload finishes
  (req, res, next) => {
    if (req.file) {
      const duration = Date.now() - req.uploadStartTime;
      console.log(`[Pipeline] [${path.parse(req.file.filename).name}] Stage: Video Upload Completed (Duration: ${duration}ms, Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);
    }
    next();
  },
  // Controller handles the FFmpeg audio extraction and cleanup
  uploadAndExtractAudio
);

export default router;
