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
