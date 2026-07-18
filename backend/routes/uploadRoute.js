import { Router } from 'express';
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
  // Multer middleware handles file upload, validation, and naming
  uploadVideo.single('video'),
  // Controller handles the FFmpeg audio extraction and cleanup
  uploadAndExtractAudio
);

export default router;
