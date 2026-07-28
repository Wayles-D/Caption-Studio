/**
 * Top Toolbar UI Component for Caption Studio
 */
import { undo, redo, resetStyles, subscribe, appState, updateState } from '../state.js';

export function initToolbar({ onImportVideo, onExportVideo }) {
  const btnUndo = document.getElementById('btn-toolbar-undo');
  const btnRedo = document.getElementById('btn-toolbar-redo');
  const btnReset = document.getElementById('btn-toolbar-reset');
  const btnImport = document.getElementById('btn-toolbar-import');
  const btnExport = document.getElementById('btn-toolbar-export');
  const themeToggle = document.getElementById('theme-toggle-checkbox');
  const projectTitleInput = document.getElementById('project-title-input');

  // Undo / Redo event listeners
  if (btnUndo) {
    btnUndo.addEventListener('click', () => undo());
  }

  if (btnRedo) {
    btnRedo.addEventListener('click', () => redo());
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      resetStyles();
    });
  }

  if (btnImport) {
    btnImport.addEventListener('click', () => {
      if (typeof onImportVideo === 'function') onImportVideo();
    });
  }

  if (btnExport) {
    btnExport.addEventListener('click', () => {
      if (typeof onExportVideo === 'function') onExportVideo();
    });
  }

  if (themeToggle) {
    themeToggle.addEventListener('change', (e) => {
      const newTheme = e.target.checked ? 'light' : 'dark';
      document.body.classList.toggle('light-theme', e.target.checked);
      updateState({ theme: newTheme }, { recordHistory: false });
    });
  }

  if (projectTitleInput) {
    projectTitleInput.addEventListener('change', (e) => {
      const newTitle = e.target.value.trim() || 'Untitled Project';
      updateState({ projectName: newTitle }, { recordHistory: false });
    });
  }

  // Subscribe to history changes to enable/disable undo & redo buttons
  subscribe('history', ({ canUndo, canRedo }) => {
    if (btnUndo) btnUndo.disabled = !canUndo;
    if (btnRedo) btnRedo.disabled = !canRedo;
  });
}
