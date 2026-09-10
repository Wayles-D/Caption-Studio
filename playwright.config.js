import { defineConfig } from '@playwright/test';

// Frontend-only e2e suite: exercises the canvas/timeline/keyframe system
// directly in a real browser (jsdom can't drive <canvas> hit-testing), using
// the DEV-only window.__appState/__updateState/__debug* hooks (see App.jsx
// and canvasTransform.js) to inject deterministic transcript data instead of
// depending on real Whisper transcription or backend upload. No backend
// server is started — nothing here touches /api routes.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5202',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --port 5202 --strictPort',
    url: 'http://localhost:5202',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
