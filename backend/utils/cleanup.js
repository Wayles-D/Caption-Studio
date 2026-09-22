import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.resolve(__dirname, '../uploads');
const outputDir = path.resolve(__dirname, '../output');
const transcriptsDir = path.resolve(__dirname, '../transcripts');
const subtitlesDir = path.resolve(__dirname, '../subtitles');
// User-imported audio tracks (see multerConfig.js's uploadAudio). Deliberately
// NOT in the `dirs` list the 30-minute sweep below walks: those directories
// hold per-job render intermediates, whereas an imported music bed stays
// referenced by the timeline for as long as the user is editing — a 30-minute
// sweep would delete it out from under a session still using it. It gets its
// own, far longer retention instead (see purgeExpiredAudioAssets).
const audioDir = path.resolve(__dirname, '../audio');

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

  // Graphics-renderer scratch PNGs (see graphicsExport.js's
  // graphicsFramesDirFor) — normally already removed by the render call
  // itself, but an early/aborted job may leave this behind.
  const graphicsFramesDir = path.join(outputDir, `${baseName}_graphics_frames`);
  if (fs.existsSync(graphicsFramesDir)) {
    try {
      fs.rmSync(graphicsFramesDir, { recursive: true, force: true });
      console.log(`[Pipeline] [${baseName}] Cleanup: Removed graphics frames directory`);
    } catch (err) {
      console.error(`[Pipeline] [${baseName}] Cleanup: Failed to remove graphics frames directory - ${err.message}`);
    }
  }

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
  const timeoutMs = parseInt(process.env.CLEANUP_TIMEOUT_MS || '1800000', 10); // Standard 30 minutes (1,800,000 ms) default
  const now = Date.now();
  const dirs = [uploadsDir, outputDir, transcriptsDir, subtitlesDir];

  purgeExpiredAudioAssets(now);

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
          if (age <= timeoutMs) return;

          // Graphics-renderer jobs (see graphicsExport.js) scratch their
          // per-slice caption PNGs into a `<baseName>_graphics_frames/`
          // directory inside outputDir, normally removed as soon as that
          // job's render finishes — this only ever fires as a safety net if
          // the process died mid-render before that cleanup ran.
          if (stats.isDirectory()) {
            fs.rm(filePath, { recursive: true, force: true }, (rmErr) => {
              if (rmErr) {
                console.error(`[Cleanup Daemon] Failed to remove orphaned directory ${file}:`, rmErr.message);
              } else {
                console.log(`[Cleanup Daemon] Purged idle orphaned directory: ${file} (Age: ${Math.round(age / 1000)}s)`);
              }
            });
            return;
          }

          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) {
              console.error(`[Cleanup Daemon] Failed to delete orphaned file ${file}:`, unlinkErr.message);
            } else {
              console.log(`[Cleanup Daemon] Purged idle orphaned file: ${file} (Age: ${Math.round(age / 1000)}s)`);
            }
          });
        });
      });
    });
  });
}

/**
 * Sweeps user-imported audio tracks that have gone stale.
 *
 * Separate from the sweep above, with a much longer default retention (24h vs
 * 30 minutes), because these files have a fundamentally different lifetime: a
 * render intermediate is dead the moment its job finishes, whereas an imported
 * music bed stays referenced by the editor's timeline for the whole editing
 * session and has to survive every re-render in between. Deleting one early
 * doesn't produce an error — it produces an export that is quietly missing its
 * music, which is exactly the failure this feature has to avoid.
 *
 * There is no server-side record of which tracks are still on someone's
 * timeline (the project lives in the browser), so age is the only signal
 * available; AUDIO_RETENTION_MS makes it tunable for longer editing sessions.
 */
export function purgeExpiredAudioAssets(now = Date.now()) {
  const retentionMs = parseInt(process.env.AUDIO_RETENTION_MS || '86400000', 10); // 24 hours
  if (!fs.existsSync(audioDir)) return;

  fs.readdir(audioDir, (err, files) => {
    if (err) {
      console.error(`[Cleanup Daemon] Error reading audio directory ${audioDir}:`, err.message);
      return;
    }

    files.forEach((file) => {
      if (file.startsWith('.')) return;
      const filePath = path.join(audioDir, file);
      fs.stat(filePath, (statErr, stats) => {
        if (statErr || !stats.isFile()) return;
        if (now - stats.mtimeMs <= retentionMs) return;
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) {
            console.error(`[Cleanup Daemon] Failed to delete expired audio asset ${file}:`, unlinkErr.message);
          } else {
            console.log(`[Cleanup Daemon] Purged expired audio asset: ${file}`);
          }
        });
      });
    });
  });
}
