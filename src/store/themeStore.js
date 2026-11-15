/**
 * Light / dark mode — a viewer preference, not part of the project, so it
 * lives in its own small persisted store rather than in the document (where
 * Undo and project restore would drag it around).
 *
 * The class on <body> is what every colour token keys off (see style.css's
 * body.light-theme). applyStoredTheme() runs in main.jsx BEFORE React's first
 * render, so a light-mode user never sees a flash of dark first.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const STORAGE_KEY = 'bhynd-theme';

function applyThemeClass(theme) {
  document.body.classList.toggle('light-theme', theme === 'light');
  document.body.classList.toggle('dark-theme', theme !== 'light');
}

// Storage can be blocked (private mode, site data off): the app then simply
// opens dark each time instead of failing.
const safeStorage = createJSONStorage(() => ({
  getItem: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* not remembered */ } },
  removeItem: (k) => { try { window.localStorage.removeItem(k); } catch { /* nothing to forget */ } }
}));

export const useThemeStore = create(persist(
  (set) => ({
    theme: 'dark',
    setTheme: (theme) => { applyThemeClass(theme); set({ theme }); },
    toggleTheme: () => set((s) => {
      const theme = s.theme === 'light' ? 'dark' : 'light';
      applyThemeClass(theme);
      return { theme };
    })
  }),
  { name: STORAGE_KEY, storage: safeStorage, partialize: (s) => ({ theme: s.theme }) }
));

/** Puts the remembered mode on <body> synchronously, before the first paint. */
export function applyStoredTheme() {
  applyThemeClass(useThemeStore.getState().theme);
}
