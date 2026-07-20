import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.resolve(__dirname, '../uploads');
const outputDir = path.resolve(__dirname, '../output');
const transcriptsDir = path.resolve(__dirname, '../transcripts');
const subtitlesDir = path.resolve(__dirname, '../subtitles');

/**
 * Cleans up all files generated for a specific job session.
 * Files are targeted using the session's base UUID.
 * @param {string} baseName - The UUID base name for the job files.
 */
export function cleanupJobAssets(baseName) {
  if (!baseName) return;
  console.log(`[Pipeline] [${baseName}] Stage: Cleanup Started`);
  const cleanupStart = Date.now();

  const filesToDelete = [
    path.join(outputDir, `${baseName}.wav`),
    path.join(transcriptsDir, `${baseName}.json`),
    path.join(subtitlesDir, `${baseName}.ass`),
    path.join(outputDir, `${baseName}_captioned.mp4`)
  ];

  // Try checking multiple extensions for the initial video video file.
  const videoExtensions = ['.mp4', '.mov', '.webm'];
  videoExtensions.forEach(ext => {
    filesToDelete.push(path.join(uploadsDir, `${baseName}${ext}`));
  });

  let deletedCount = 0;

  filesToDelete.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`[Pipeline] [${baseName}] Cleanup: Deleted ${path.basename(filePath)}`);
        deletedCount++;
      } catch (err) {
        console.error(`[Pipeline] [${baseName}] Cleanup: Failed to delete ${path.basename(filePath)} - ${err.message}`);
      }
    }
  });

  const duration = Date.now() - cleanupStart;
  console.log(`[Pipeline] [${baseName}] Stage: Cleanup Completed (Deleted ${deletedCount} files, Duration: ${duration}ms)`);
}

/**
 * Periodically searches application directories for orphaned/abandoned files
 * that exceed the target expiration age threshold and unlinks them.
 */
export function runPeriodicCleanup() {
  const timeoutMs = parseInt(process.env.CLEANUP_TIMEOUT_MS || '600000', 10); // Standard 10 minutes (600,000 ms) default
  const now = Date.now();
  const dirs = [uploadsDir, outputDir, transcriptsDir, subtitlesDir];

  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) return;

    fs.readdir(dir, (err, files) => {
      if (err) {
        console.error(`[Cleanup Daemon] Error reading directory ${dir}:`, err.message);
        return;
      }

      files.forEach(file => {
        // Skip hidden files to prevent deleting critical OS configs
        if (file.startsWith('.')) return;

        const filePath = path.join(dir, file);
        fs.stat(filePath, (statErr, stats) => {
          if (statErr) return;

          const age = now - stats.mtimeMs;
          if (age > timeoutMs) {
            fs.unlink(filePath, (unlinkErr) => {
              if (unlinkErr) {
                console.error(`[Cleanup Daemon] Failed to delete orphaned file ${file}:`, unlinkErr.message);
              } else {
                console.log(`[Cleanup Daemon] Purged idle orphaned file: ${file} (Age: ${Math.round(age / 1000)}s)`);
              }
            });
          }
        });
      });
    });
  });
}
