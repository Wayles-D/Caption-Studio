import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate a unique filename using uuid v4 and maintain the original extension
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  }
});

// File filter validation
const fileFilter = (req, file, cb) => {
  // Allowed extensions
  const allowedExtensions = ['.mp4', '.mov', '.webm'];
  // Allowed mimetypes
  const allowedMimeTypes = ['video/mp4', 'video/quicktime', 'video/webm'];

  const fileExt = path.extname(file.originalname).toLowerCase();
  const fileMime = file.mimetype.toLowerCase();

  const isExtensionValid = allowedExtensions.includes(fileExt);
  const isMimeTypeValid = allowedMimeTypes.includes(fileMime);

  if (isExtensionValid && isMimeTypeValid) {
    // Accept the file
    cb(null, true);
  } else {
    // Reject the file with a helpful error
    const errorMsg = `Invalid file type. Only MP4, MOV, and WebM video formats are allowed. Received: extension "${fileExt}", mimetype "${fileMime}"`;
    cb(new Error(errorMsg), false);
  }
};

// 500MB limit in bytes (500 * 1024 * 1024)
const limits = {
  fileSize: 500 * 1024 * 1024
};

// Configure Multer middleware instance
export const uploadVideo = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: limits
});

// --- Imported audio tracks --------------------------------------------------
// Music/ambience/voiceover files the user drops onto the Audio lane. Stored in
// their own directory rather than alongside uploaded videos so the cleanup
// daemon's video-job sweep (which keys off a job's baseName — see
// backend/utils/cleanup.js) can never mistake one for an orphaned render
// intermediate and delete a track that is still on the timeline.
const audioDir = path.join(__dirname, '../audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, audioDir),
  filename: (req, file, cb) => {
    // A UUID name, never the user's own: the stored name is what the export
    // pipeline later resolves to a path (see audioMixFilter.js's
    // resolveAudioAssetPath), so it must not be attacker-influenced, and
    // uploading two files called "music.mp3" must not clobber the first.
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

// Kept in sync with the client's own file-picker filter (see
// src/js/components/audioImport.js's AUDIO_ACCEPT).
const allowedAudioExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.webm', '.flac'];

const audioFileFilter = (req, file, cb) => {
  const fileExt = path.extname(file.originalname).toLowerCase();
  const fileMime = (file.mimetype || '').toLowerCase();

  // Extension AND a plausible audio mimetype. Browsers are inconsistent about
  // the mimetype they attach to .m4a/.aac in particular (several report
  // `application/octet-stream`), so the extension is the load-bearing check
  // and the mimetype only has to not contradict it.
  const isExtensionValid = allowedAudioExtensions.includes(fileExt);
  const isMimePlausible = fileMime.startsWith('audio/')
    || fileMime === 'application/octet-stream'
    || fileMime === 'video/webm' // how some browsers label .webm audio
    || fileMime === '';

  if (isExtensionValid && isMimePlausible) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Supported audio formats: ${allowedAudioExtensions.join(', ')}. Received: extension "${fileExt}", mimetype "${fileMime}"`), false);
  }
};

export const uploadAudio = multer({
  storage: audioStorage,
  fileFilter: audioFileFilter,
  // 100MB — far more than any realistic music bed or voiceover for short-form
  // video, and a fifth of the video limit so a stray large file can't fill the
  // disk as easily.
  limits: { fileSize: 100 * 1024 * 1024 }
});
