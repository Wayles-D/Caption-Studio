/**
 * Per-viewer workspace preferences — how this person likes the editor laid
 * out, not part of any project (so Undo and project restore never touch it).
 * Persisted to localStorage; blocked storage just means defaults each visit.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const safeStorage = createJSONStorage(() => ({
  getItem: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* not remembered */ } },
  removeItem: (k) => { try { window.localStorage.removeItem(k); } catch { /* nothing to forget */ } }
}));

export const useWorkspaceStore = create(persist(
  (set) => ({
    // Which section of the tool dock is showing its tools.
    dockSection: 'Captions',
    setDockSection: (dockSection) => set({ dockSection }),
    // The last export size chosen ('hd' = 1080p, 'original'), preselected next time.
    exportSize: 'hd',
    setExportSize: (exportSize) => set({ exportSize: exportSize === 'original' ? 'original' : 'hd' })
  }),
  { name: 'bhynd-workspace', storage: safeStorage, partialize: (s) => ({ dockSection: s.dockSection, exportSize: s.exportSize }) }
));
