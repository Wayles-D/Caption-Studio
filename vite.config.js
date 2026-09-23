import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite previously ran with zero config (framework defaults only) — this file
// adds React (for the incremental UI migration — see the migration plan) and
// Tailwind (UI chrome only; canvas/video rendering CSS stays in plain
// stylesheets untouched by Tailwind's content scanning) without changing any
// existing dev-server behavior otherwise.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // The backend writes RUNTIME DATA inside this same project root, and the
      // dev server watches the root — so every file the backend produced was
      // treated as a source change and triggered a full page reload.
      //
      // Importing an audio track made this obvious: the upload succeeded, the
      // file landed in backend/audio/, Vite reloaded the page, and the whole
      // editing session was wiped. It read as "the app randomly restarts when I
      // upload audio". Confirmed directly against the running dev server — one
      // document unload, a navigation back to the same URL, and a `[vite]
      // connecting…` reconnect in the console immediately after the file
      // appeared.
      //
      // The export path is the worse case: rendering writes HUNDREDS of caption
      // PNGs into backend/output/<job>_graphics_frames/, so a single export
      // could storm the watcher for the entire render.
      //
      // None of these are source. They are uploads, renders, scratch frames and
      // job intermediates, and nothing in the browser bundle imports them, so
      // there is never a reason for a change here to touch the page.
      ignored: [
        '**/backend/audio/**',
        '**/backend/uploads/**',
        '**/backend/output/**',
        '**/backend/transcripts/**',
        '**/backend/subtitles/**',
        '**/*_graphics_frames/**',
        '**/private-notes/**',
        '**/test-results/**'
      ]
    }
  }
});
