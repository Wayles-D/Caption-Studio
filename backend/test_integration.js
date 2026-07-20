import './test_env.js';
import express from 'express';
import fs from 'fs';
import url from 'url';
import nodePath from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import http from 'http';

// Load our server app
import app from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

const PORT = 5045; // Test port
const testVideoPath = nodePath.join(__dirname, 'test-source.mp4');

// Define Mock Whisper Route
app.post('/mock/whisper', (req, res) => {
  console.log('[Mock Whisper] Received request at endpoint.');

  // Validate Authorization Header
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== 'Bearer mock_api_key_for_testing') {
    return res.status(401).json({ error: { message: 'Unauthorized API Key.' } });
  }

  // Simulate a correct Whisper response
  return res.status(200).json({
    text: "Hello world. This is a Whisper transcription mock test.",
    segments: [
      {
        id: 0,
        start: 0.0,
        end: 2.0,
        text: "Hello world.",
        words: [
          { word: "Hello", start: 0.0, end: 0.8 },
          { word: "world.", start: 0.8, end: 2.0 }
        ]
      },
      {
        id: 1,
        start: 2.0,
        end: 3.0,
        text: "This is a Whisper transcription mock test.",
        words: [
          { word: "This", start: 2.0, end: 2.4 },
          { word: "is", start: 2.4, end: 2.6 },
          { word: "a", start: 2.6, end: 2.7 },
          { word: "Whisper", start: 2.7, end: 2.8 },
          { word: "test.", start: 2.8, end: 3.0 }
        ]
      }
    ],
    duration: 3.0
  });
});

// Utility to generate a test MP4 file with video and audio using FFmpeg
function generateTestVideo(outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
      '-c:v', 'mpeg4',
      '-c:a', 'aac',
      outputPath
    ];

    console.log(`Generating dummy test video: ${ffmpegPath} ${args.join(' ')}`);
    const proc = spawn(ffmpegPath, args);
    let stderr = '';

    proc.stdout.on('data', (d) => {});
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('Dummy test video generated successfully.');
        resolve();
      } else {
        reject(new Error(`Failed to generate test video. Exit code: ${code}. Error: ${stderr}`));
      }
    });
  });
}

// Function to construct and send multipart file uploads
function uploadFile(host, port, filePath, fieldName, filename) {
  return new Promise((resolve, reject) => {
    const boundary = `----TestBoundary${Math.random().toString(16).slice(2)}`;
    const fileStream = fs.createReadStream(filePath);
    const stat = fs.statSync(filePath);

    const header = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
      `Content-Type: video/mp4`,
      '',
      ''
    ].join('\r\n');

    const footer = `\r\n--${boundary}--\r\n`;

    const contentLength = Buffer.byteLength(header) + stat.size + Buffer.byteLength(footer);

    const req = http.request({
      host,
      port,
      path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': contentLength
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch {
          reject(new Error(`Failed to parse response JSON: ${data}`));
        }
      });
    });

    req.on('error', (e) => reject(e));

    // Stream the multipart payload
    req.write(header);
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => {
      req.write(footer);
      req.end();
    });
  });
}

// Run integration tests
async function runTests() {
  console.log('Starting Step 4: ASS Subtitle validation tests...');
  let serverInstance;

  try {
    // 1. Generate test video
    await generateTestVideo(testVideoPath);

    // 2. Start Express Server
    serverInstance = app.listen(PORT, async () => {
      console.log(`Test server running on port ${PORT}`);

      try {
        // --- Test 1: Upload and check (.ass) creation ---
        console.log('\n--- Test 1: Uploading Valid Video for Conversion + Subtitle Compile ---');
        const uploadResult = await uploadFile('localhost', PORT, testVideoPath, 'video', 'test-source.mp4');
        
        if (uploadResult.statusCode !== 200 || !uploadResult.body.success) {
          throw new Error(`Pipeline processing failed: Status code: ${uploadResult.statusCode}`);
        }

        const body = uploadResult.body;
        console.log('Server response summary:', {
          success: body.success,
          message: body.message,
          videoPath: body.videoPath,
          audioPath: body.audioPath,
          transcriptPath: body.transcriptPath,
          subtitlePath: body.subtitlePath
        });

        // Verify subtitle path returned
        if (!body.subtitlePath) {
          throw new Error('Verify Failed: Response body does not contain a subtitlePath field.');
        }

        const absoluteSubtitlePath = nodePath.join(__dirname, body.subtitlePath);
        console.log(`Reading generated ASS file at: ${absoluteSubtitlePath}`);

        if (!fs.existsSync(absoluteSubtitlePath)) {
          throw new Error(`Write Failed: The local ASS subtitle file was not found at: ${absoluteSubtitlePath}`);
        }

        const assContent = fs.readFileSync(absoluteSubtitlePath, 'utf8');

        // Assert standard ASS headers exist
        if (!assContent.includes('[Script Info]') || !assContent.includes('[V4+ Styles]')) {
          throw new Error('Verify Failed: Generated file is missing standard ASS section tags.');
        }

        // Assert style properties exist
        if (!assContent.includes('Montserrat SemiBold')) {
          throw new Error('Style Failed: Montserrat SemiBold is not specified in styles configuration.');
        }
        if (!assContent.includes('PlayResX: 1080') || !assContent.includes('PlayResY: 1920')) {
          throw new Error('Style Failed: Resolution should match vertical layout coordinates (1080x1920).');
        }

        // Assert Dialogue events exist
        if (!assContent.includes('Dialogue:')) {
          throw new Error('Format Failed: Subtitle file is missing dialogue event tags.');
        }

        // Assert Karaoke tags exist
        if (!assContent.includes('\\kf')) {
          throw new Error('Format Failed: Dialogue track is missing karaoke timing (\\kf) events.');
        }
        
        console.log('ASS Subtitle structure verification: SUCCESS.');

        // Verify rendered video path returned
        if (!body.renderedVideoPath) {
          throw new Error('Verify Failed: Response body does not contain a renderedVideoPath field.');
        }

        const absoluteRenderedVideoPath = nodePath.join(__dirname, body.renderedVideoPath);
        console.log(`Verifying rendered captioned video exists at: ${absoluteRenderedVideoPath}`);

        if (!fs.existsSync(absoluteRenderedVideoPath)) {
          throw new Error(`Write Failed: The local rendered video file was not found at: ${absoluteRenderedVideoPath}`);
        }

        // Verify that temporary files were deleted (since KEEP_TEMP_FILES=false)
        const absoluteVideoPath = nodePath.join(__dirname, body.videoPath);
        const absoluteAudioPath = nodePath.join(__dirname, body.audioPath);

        if (fs.existsSync(absoluteVideoPath)) {
          throw new Error(`Cleanup Failed: Temporary video file at ${absoluteVideoPath} was not unlinked.`);
        }
        if (fs.existsSync(absoluteAudioPath)) {
          throw new Error(`Cleanup Failed: Temporary audio file at ${absoluteAudioPath} was not unlinked.`);
        }
        console.log('Cleanup Success: Both temporary video and audio WAV files were successfully deleted.');

        // Clean up generated artifacts
        const absoluteTranscriptPath = nodePath.join(__dirname, body.transcriptPath);
        fs.unlinkSync(absoluteTranscriptPath);
        fs.unlinkSync(absoluteSubtitlePath);
        fs.unlinkSync(absoluteRenderedVideoPath);
        console.log('Cleaned up integration test generated transcript, subtitle, and rendered video files.');

        // --- Test 2: Uploading an invalid extension file (should fail validation) ---
        console.log('\n--- Test 2: Uploading Invalid extension ---');
        const invalidFilePath = nodePath.join(__dirname, 'test-invalid.txt');
        fs.writeFileSync(invalidFilePath, 'This is a test block of text, not a video.');

        const invalidResult = await uploadFile('localhost', PORT, invalidFilePath, 'video', 'test-invalid.txt');
        console.log('Response for invalid upload:', invalidResult.statusCode, invalidResult.body.message);

        fs.unlinkSync(invalidFilePath);

        if (invalidResult.statusCode !== 400 || invalidResult.body.success) {
          throw new Error(`Expected error code 400 for invalid upload, got status ${invalidResult.statusCode}`);
        }
        console.log('Rejection Success: server rejected invalid file type with 400.');

        console.log('\n=== ALL ASS SUBTITLE INTEGRATION TESTS PASSED SUCCESSFULLY! ===');
        exit(0);

      } catch (err) {
        console.error('\n*** TEST FAILURE ERROR ***');
        console.error(err);
        exit(1);
      }
    });

  } catch (setupErr) {
    console.error('Test Setup Failed:', setupErr);
    exit(1);
  }

  function exit(code) {
    if (fs.existsSync(testVideoPath)) {
      try { fs.unlinkSync(testVideoPath); } catch {}
    }
    if (serverInstance) {
      serverInstance.close(() => {
        console.log('Test Server closed. Exiting with code', code);
        process.exit(code);
      });
    } else {
      process.exit(code);
    }
  }
}

runTests();
