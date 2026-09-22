import { Router } from 'express';
import path from 'path';
import { uploadVideo, uploadAudio } from '../utils/multerConfig.js';
import { uploadAndExtractAudio, workspaceCleanup, regenerateCaptions, uploadAudioAsset, analyzeContent } from '../controllers/uploadController.js';

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

/**
 * @route   POST /api/upload/cleanup
 * @desc    Explicitly purge the active workspace job files
 * @access  Public
 */
router.post('/cleanup', workspaceCleanup);

/**
 * @route   POST /api/upload/regenerate
 * @desc    Regenerate ASS subtitles from edited words/styles and re-burn into video
 * @access  Public
 */
router.post('/regenerate', regenerateCaptions);

/**
 * @route   POST /api/upload/audio
 * @desc    Upload one audio file (MP3/WAV/M4A/AAC/OGG/FLAC; max 100MB) for the
 *          timeline's Audio lane, returning the assetId the export pipeline
 *          resolves it by. Required for a track to reach the exported video at
 *          all — the preview can play a local blob URL, the server-side mix
 *          cannot (see the controller's own doc comment).
 * @access  Public
 */
router.post('/audio', uploadAudio.single('audio'), uploadAudioAsset);

/**
 * @route   POST /api/upload/analyze-content
 * @desc    Re-run the transcript content analysis (the SAME single pass the
 *          upload pipeline runs) on demand, returning keyword tags, semantic
 *          events and visual suggestions. Lets a user ask for automatic sound
 *          effects on a project where the analysis had not run or had failed,
 *          without re-uploading the video.
 * @access  Public
 */
router.post('/analyze-content', analyzeContent);

export default router;

