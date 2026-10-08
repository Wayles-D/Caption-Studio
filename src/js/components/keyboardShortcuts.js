/**
 * KEYBOARD SHORTCUTS — the editor's keys, in one place:
 *
 *   Ctrl/⌘+Z            undo
 *   Ctrl/⌘+Shift+Z, Ctrl+Y   redo
 *   Space               play / pause
 *   ← / →               one frame back / forward (Shift: one second)
 *   Home / End          the start / the end
 *   Ctrl/⌘+D            duplicate the selected image or shape
 *   Esc                 deselect
 *   ?                   this list
 *
 * Delete / Backspace (delete the selection) stays where it is — the
 * timeline's own handler (timelinePanel.js), which knows the selection
 * precedence (a keyframe before its clip, and so on).
 *
 * A key typed INTO something — a text field, a select, an editable caption —
 * is that field's, never a shortcut (the same rule the Delete handler
 * learned the hard way: Backspace in an overlay's text deleted the overlay).
 * Every action is the one its button already performs, so a shortcut can
 * never do something its button doesn't.
 */
import { appState, updateState, undo, redo } from '../state.js';
import { duplicateImageLayer } from './imageLayers.js';
import { duplicateShapeLayer } from './shapeLayers.js';

/** One frame at the rate the editor steps by (the preview has no reliable frame rate to read). */
const FRAME = 1 / 30;

export const SHORTCUTS = [
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z  ·  Ctrl+Y', 'Redo'],
  ['Space', 'Play / pause'],
  ['←  →', 'Step one frame'],
  ['Shift+←  →', 'Step one second'],
  ['Home  ·  End', 'Go to the start / end'],
  ['Ctrl+D', 'Duplicate the selected image or shape'],
  ['Delete  ·  Backspace', 'Delete the selection'],
  ['Esc', 'Deselect'],
  ['?', 'Show these shortcuts']
];

function isTyping(target) {
  const el = target instanceof Element ? target : document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function video() {
  const v = document.getElementById('preview-video');
  return v && v.duration > 0 ? v : null;
}

function seekBy(seconds) {
  const v = video();
  if (!v) return;
  v.pause();
  v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + seconds));
}

function seekTo(time) {
  const v = video();
  if (!v) return;
  v.pause();
  v.currentTime = Math.min(v.duration, Math.max(0, time));
}

function togglePlay() {
  const v = video();
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function duplicateSelection() {
  if (appState.selectedImageLayerId) return !!duplicateImageLayer(appState.selectedImageLayerId);
  if (appState.selectedShapeLayerId) return !!duplicateShapeLayer(appState.selectedShapeLayerId);
  return false;
}

function deselect() {
  const ids = ['selectedImageLayerId', 'selectedShapeLayerId', 'selectedTextElementId', 'selectedAudioClipId', 'selectedObjectEffectId', 'selectedCaptionEventId'];
  const patch = Object.fromEntries(ids.filter((k) => appState[k]).map((k) => [k, null]));
  if (Object.keys(patch).length) updateState(patch, { recordHistory: false });
}

// --- The list ----------------------------------------------------------------------

let dialog = null;

export function isShortcutsOpen() {
  return !!dialog && !dialog.hidden;
}

export function toggleShortcutsDialog(open = !isShortcutsOpen()) {
  if (!dialog) {
    dialog = document.createElement('div');
    dialog.id = 'shortcuts-dialog';
    dialog.className = 'shortcuts-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Keyboard shortcuts');
    const card = document.createElement('div');
    card.className = 'shortcuts-card';
    const title = document.createElement('div');
    title.className = 'shortcuts-title';
    title.textContent = 'Keyboard shortcuts';
    card.appendChild(title);
    SHORTCUTS.forEach(([keys, what]) => {
      const row = document.createElement('div');
      row.className = 'shortcuts-row';
      const k = document.createElement('kbd');
      k.textContent = keys;
      const w = document.createElement('span');
      w.textContent = what;
      row.append(w, k);
      card.appendChild(row);
    });
    const note = document.createElement('div');
    note.className = 'shortcuts-note';
    note.textContent = 'On a Mac, ⌘ works wherever Ctrl is shown. Keys typed into a text field stay in the field.';
    card.appendChild(note);
    dialog.appendChild(card);
    // A press outside the card closes it.
    dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) toggleShortcutsDialog(false); });
    document.body.appendChild(dialog);
  }
  dialog.hidden = !open;
}

// --- The keys ----------------------------------------------------------------------

/** What a keydown does — or null when it is not a shortcut here. Exported for tests. */
export function shortcutFor(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (key === 'z' && !e.shiftKey) return 'undo';
    if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)) return 'redo';
    if (key === 'd' && !e.shiftKey) return 'duplicate';
    return null;
  }
  if (e.altKey || mod) return null;
  if (key === ' ' || e.code === 'Space') return 'play';
  if (key === 'ArrowLeft') return e.shiftKey ? 'back-second' : 'back-frame';
  if (key === 'ArrowRight') return e.shiftKey ? 'forward-second' : 'forward-frame';
  if (key === 'Home') return 'start';
  if (key === 'End') return 'end';
  if (key === 'Escape') return 'escape';
  if (key === '?') return 'help';
  return null;
}

let started = false;

export function initKeyboardShortcuts() {
  if (started) return;
  started = true;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || isTyping(e.target)) return;
    const action = shortcutFor(e);
    if (!action) return;
    // The list is open: Esc or ? closes it, and nothing else happens behind it.
    if (isShortcutsOpen()) {
      if (action === 'escape' || action === 'help') { e.preventDefault(); toggleShortcutsDialog(false); }
      return;
    }
    switch (action) {
      case 'undo': e.preventDefault(); undo(); break;
      case 'redo': e.preventDefault(); redo(); break;
      // Space must not also "click" whatever button has focus, or scroll the page.
      case 'play': e.preventDefault(); togglePlay(); break;
      case 'back-frame': e.preventDefault(); seekBy(-FRAME); break;
      case 'forward-frame': e.preventDefault(); seekBy(FRAME); break;
      case 'back-second': e.preventDefault(); seekBy(-1); break;
      case 'forward-second': e.preventDefault(); seekBy(1); break;
      case 'start': e.preventDefault(); seekTo(0); break;
      case 'end': e.preventDefault(); seekTo(video()?.duration ?? 0); break;
      // Ctrl+D is also the browser's "bookmark this page": taken only when there is something to duplicate.
      case 'duplicate': if (duplicateSelection()) e.preventDefault(); break;
      // Esc stays everyone's too (menus and dialogs close on it): this only adds deselecting.
      case 'escape': deselect(); break;
      case 'help': e.preventDefault(); toggleShortcutsDialog(true); break;
      default: break;
    }
  });
}
