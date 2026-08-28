import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite previously ran with zero config (framework defaults only) — this file
// adds React (for the incremental UI migration — see the migration plan) and
// Tailwind (UI chrome only; canvas/video rendering CSS stays in plain
// stylesheets untouched by Tailwind's content scanning) without changing any
// existing dev-server behavior otherwise.
export default defineConfig({
  plugins: [react(), tailwindcss()]
});
