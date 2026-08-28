/**
 * Caption Studio entry point (migration plan's Stage 4).
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

createRoot(document.getElementById('app-root')).render(<App />);
