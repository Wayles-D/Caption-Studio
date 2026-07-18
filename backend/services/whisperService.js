import fs from 'fs';
import path from 'path';
import { retryWithBackoff } from '../utils/retry.js';

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
  const timeoutMs = parseInt(process.env.WHISPER_TIMEOUT || '30000', 10);
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

  // Helper function to perform a single fetch attempt
  async function performRequest(requestOptions = { requestWordTimestamps: true }) {
    const formData = new FormData();
    
    // Read local file into buffer, wrapped as a Blob for modern FormData mapping
    const fileBuffer = fs.readFileSync(audioPath);
    const audioBlob = new Blob([fileBuffer], { type: 'audio/wav' });
    
    formData.append('file', audioBlob, filename);
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

  const responseData = await executeWithRetry();

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
