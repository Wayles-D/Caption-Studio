/**
 * Runs the rhythm analyser (shared/rhythm/analyzer.js) off the main thread,
 * so analysing a long song never freezes the editor. Receives mono PCM,
 * returns the beat map — or the error, never a crash.
 */
import { analyzeRhythm } from '../../../shared/rhythm/analyzer.js';

self.onmessage = (e) => {
  const { id, samples, sampleRate, source } = e.data || {};
  try {
    const map = analyzeRhythm(samples, sampleRate, { source });
    self.postMessage({ id, map });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
