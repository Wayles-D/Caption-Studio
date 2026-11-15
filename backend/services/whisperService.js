import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { retryWithBackoff } from '../utils/retry.js';

/** Under this, the WAV goes as it is; over it, it is sent as lossless FLAC (see transcribeAudio). */
const SEND_AS_IS_MAX_BYTES = 20 * 1024 * 1024;

/** A lossless FLAC copy beside the WAV, for long audio. Removed with the job's other temporary files. */
function toFlac(wavPath) {
  const flacPath = wavPath.replace(/\.wav$/i, '') + '.flac';
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-c:a', 'flac', flacPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Could not compress the audio for transcription: ${stderr.slice(-300)}`));
      const mb = (fs.statSync(flacPath).size / 1024 / 1024).toFixed(2);
      console.log(`[Whisper API] Long audio sent as lossless FLAC (${mb} MB).`);
      resolve({ sendPath: flacPath, sendName: path.basename(flacPath), sendType: 'audio/flac' });
    });
  });
}

/**
 * Sends the audio WAV file to a Whisper-compatible endpoint.
 * Handles headers, request formatting, timeouts, parameter fallbacks,
 * and calls the retry utility.
 * 
 * @param {string} audioPath - Absolute file path to the mono 16kHz WAV file.
 * @returns {Promise<object>} Returns the verified JSON transcription payload.
 */
export async function transcribeAudio(audioPath) {
  const apiUrl = process.env.WHISPER_API_URL;
  const apiKey = process.env.WHISPER_API_KEY;
  const modelName = process.env.WHISPER_MODEL || 'whisper-large-v3';
  // WHISPER_TIMEOUT is the FLOOR, not the whole budget — see below, where it
  // grows with the audio's length once the file has been measured.
  const baseTimeoutMs = parseInt(process.env.WHISPER_TIMEOUT || '30000', 10);
  const maxRetries = parseInt(process.env.WHISPER_MAX_RETRIES || '3', 10);

  if (!apiUrl) {
    throw new Error('Configuration error: WHISPER_API_URL is not set.');
  }
  if (!apiKey) {
    throw new Error('Configuration error: WHISPER_API_KEY is not set.');
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file does not exist at path: ${audioPath}`);
  }

  // Validate format and size before sending
  const filename = path.basename(audioPath);
  const stats = fs.statSync(audioPath);
  console.log(`Preparing Whisper request for ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  // THE TIMEOUT SCALES WITH THE AUDIO. A single fixed limit gave a 10-second
  // clip and a 10-minute one the same 30 seconds. A 3.5-minute phone video
  // normally transcribes in ~23s — under the limit, until the API had a slow
  // moment: then every retry hit 30s and the upload failed ~2 minutes in, which
  // the user saw as the upload "cancelling". The audio here is always the
  // 16kHz mono 16-bit WAV extractAudio produces (32,000 bytes a second), so its
  // length is read straight off the file size. Half a second of patience per
  // second of audio on top of the configured floor, capped at 10 minutes.
  const audioSeconds = Math.max(0, (stats.size - 44) / 32000);
  const timeoutMs = Math.min(10 * 60 * 1000, Math.round(baseTimeoutMs + audioSeconds * 500));
  console.log(`[Whisper API] ${audioSeconds.toFixed(0)}s of audio — allowing ${Math.round(timeoutMs / 1000)}s per attempt.`);

  // LONG VIDEOS: the transcription service refuses files over its upload limit
  // (25MB on Groq's standard tier). This WAV is 1.92MB a minute, so anything
  // past ~13 minutes would be refused outright. FLAC is LOSSLESS — the model
  // hears exactly the same samples, so word timings cannot move — at about
  // half the size. Only used when needed: short videos send the WAV as before.
  const { sendPath, sendName, sendType } = stats.size > SEND_AS_IS_MAX_BYTES
    ? await toFlac(audioPath)
    : { sendPath: audioPath, sendName: filename, sendType: 'audio/wav' };

  // Helper function to perform a single fetch attempt
  async function performRequest(requestOptions = { requestWordTimestamps: true }) {
    const formData = new FormData();

    // Read local file into buffer, wrapped as a Blob for modern FormData mapping
    const fileBuffer = fs.readFileSync(sendPath);
    const audioBlob = new Blob([fileBuffer], { type: sendType });

    formData.append('file', audioBlob, sendName);
    formData.append('model', modelName);
    formData.append('response_format', 'verbose_json');

    if (requestOptions.requestWordTimestamps) {
      // Some API endpoints require 'timestamp_granularities[]' for word level
      formData.append('timestamp_granularities[]', 'word');
      formData.append('timestamp_granularities[]', 'segment');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[Whisper API] Request exceeded timeout of ${timeoutMs}ms. Aborting...`);
      controller.abort();
    }, timeoutMs);

    const headers = {
      'Authorization': `Bearer ${apiKey}`
    };

    try {
      console.log(`Sending upload to ${apiUrl} (Model: ${modelName}, Word Timestamps: ${requestOptions.requestWordTimestamps})`);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: formData,
        signal: controller.signal
      });

      if (!response.ok) {
        const errBodyText = await response.text();
        let errorDetails;
        try {
          errorDetails = JSON.parse(errBodyText);
        } catch {
          errorDetails = { message: errBodyText };
        }

        const statusText = response.statusText || '';
        const errMsg = errorDetails.error?.message || errorDetails.message || statusText;
        
        console.error(`[Whisper API] HTTP ${response.status} Error:`, errorDetails);

        // Check if error is related to unsupported timestamp parameters (e.g. invalid arguments in Groq / OpenAI)
        if (response.status === 400 && requestOptions.requestWordTimestamps && 
            (errMsg.includes('timestamp_granularities') || errMsg.includes('granularity') || errMsg.includes('parameter'))) {
          console.warn('[Whisper API] Word timestamps are apparently unsupported by this provider. Retrying request with segment-only default...');
          return performRequest({ requestWordTimestamps: false });
        }

        throw new Error(`Whisper API returned status ${response.status}: ${errMsg}`);
      }

      const responseData = await response.json();
      return responseData;

    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Whisper API request timed out after ${timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Wrapper function integrating the retry loop utility
  const executeWithRetry = () => {
    return retryWithBackoff(
      () => performRequest({ requestWordTimestamps: true }),
      maxRetries,
      1000,
      2
    );
  };

  let responseData;
  try {
    responseData = await executeWithRetry();
  } finally {
    // The FLAC copy (long audio only) is ours to remove; the WAV belongs to the pipeline.
    if (sendPath !== audioPath) {
      try { fs.unlinkSync(sendPath); } catch { /* already gone */ }
    }
  }

  // Validate response integrity
  validateWhisperResponse(responseData);

  return responseData;
}

/**
 * Validates the structure and presence of expected data inside Whisper's JSON payload.
 * Throws an error if required properties are missing.
 * 
 * @param {object} data - Transcription data returned by Whisper.
 */
function validateWhisperResponse(data) {
  if (!data) {
    throw new Error('Incomplete transcription: Received null or undefined response from API.');
  }

  // Check transcript text is a valid non-empty string
  if (typeof data.text !== 'string' || data.text.trim() === '') {
    throw new Error('Malformed transcription: Missing or empty transcript "text" field.');
  }

  // Verify that timestamps are present (in verbose_json this is mapped to "segments")
  if (!Array.isArray(data.segments)) {
    throw new Error('Malformed transcription: Missing "segments" list for timestamp tracking.');
  }

  // Validate structural content inside segments
  if (data.segments.length > 0) {
    const firstSegment = data.segments[0];
    if (typeof firstSegment.start !== 'number' || typeof firstSegment.end !== 'number') {
      throw new Error('Incomplete transcription: Segments are missing valid start or end numeric timestamps.');
    }
  }

  console.log(`[Whisper API] Transcription validated successfully:`);
  console.log(`  - Text characters: ${data.text.length}`);
  console.log(`  - Segments count: ${data.segments.length}`);
  if (data.duration) {
    console.log(`  - Estimated Audio Duration: ${data.duration} seconds`);
  }
}
