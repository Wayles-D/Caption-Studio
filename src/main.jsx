/**
 * BHYND entry point (migration plan's Stage 4).
 *
 * All orchestration previously in main.js now lives in App.jsx as a single
 * React tree — this file only bootstraps the root.
 */
import { createRoot } from 'react-dom/client';

// Tailwind (theme + utilities only, no Preflight reset — see tailwind.css's
// own doc comment) for the incremental React/Tailwind UI migration. Inert
// until a component actually uses a utility class.
import './tailwind.css';
// Design tokens, global reset, and the protected canvas/video rendering CSS
// (see style.css's own header comment). Imported AFTER tailwind.css so its
// `@layer base { ... }` reset block joins Tailwind's `base` layer at a
// predictable position in the cascade — Tailwind utilities must always be
// able to override it.
import './style.css';

import { App } from './App.jsx';
import { applyStoredTheme } from './store/themeStore.js';

// The remembered light/dark mode, on <body> before anything paints.
applyStoredTheme();

// Dev only: names whatever is blocking the main thread, so a hang can be
// reported rather than guessed at. See src/js/debug/hangWatch.js.
if (import.meta.env.DEV) {
  import('./js/debug/hangWatch.js').then((m) => m.installHangWatch());
  // Gate 0 for the occlusion rebuild: window.__benchTam() reports what one
  // frame of the video segmenter costs on this machine's GPU.
  import('./js/debug/tamBench.js').then((m) => { window.__benchTam = m.benchTam; });
  // Drives the video segmenter over a span of the preview video, before any
  // of it is wired into the editor: await __tamTry({ start, seconds, fps }).
  import('./js/debug/tamTry.js').then((m) => { window.__tamTry = m.tamTry; });
}

createRoot(document.getElementById('app-root')).render(<App />);
