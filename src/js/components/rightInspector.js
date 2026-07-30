/**
 * Right Inspector Component for Caption Studio
 */
import { appState, subscribe } from '../state.js';

export function initRightInspector({ onRegenerateCaptions }) {
  const inspectorFileName = document.getElementById('inspector-file-name');
  const inspectorDuration = document.getElementById('inspector-duration');
  const badgeFont = document.getElementById('badge-font');
  const badgePreset = document.getElementById('badge-preset');
  const badgeAnimation = document.getElementById('badge-animation');

  const transcriptCard = document.getElementById('transcript-card');
  const transcriptWordsContainer = document.getElementById('transcript-words-container');
  const transcriptWordCount = document.getElementById('transcript-word-count');
  const btnApplyRender = document.getElementById('btn-apply-render');

  if (btnApplyRender) {
    btnApplyRender.addEventListener('click', () => {
      if (typeof onRegenerateCaptions === 'function') onRegenerateCaptions();
    });
  }

  // Subscribe to state changes to update stats & summary badges
  subscribe('*', () => {
    updateRightInspectorUI();
  });

  updateRightInspectorUI();
}

/**
 * Update metadata badges and transcript editor UI
 */
export function updateRightInspectorUI() {
  const inspectorFileName = document.getElementById('inspector-file-name');
  const inspectorDuration = document.getElementById('inspector-duration');
  const badgeFont = document.getElementById('badge-font');
  const badgePreset = document.getElementById('badge-preset');
  const badgeAnimation = document.getElementById('badge-animation');

  if (inspectorFileName) {
    inspectorFileName.textContent = appState.uploadedFile ? appState.uploadedFile.name : 'Demo Video';
  }

  if (inspectorDuration) {
    const mins = Math.floor(appState.videoDuration / 60);
    const secs = Math.floor(appState.videoDuration % 60);
    inspectorDuration.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  if (badgeFont) badgeFont.textContent = appState.fontFamily;
  if (badgePreset) badgePreset.textContent = (appState.currentPreset || '').toUpperCase();
  if (badgeAnimation) badgeAnimation.textContent = (appState.animationMode || '').toUpperCase();
}

/**
 * Render word chips in transcript editor
 */
export function renderTranscriptEditor() {
  const transcriptCard = document.getElementById('transcript-card');
  const transcriptWordsContainer = document.getElementById('transcript-words-container');
  const transcriptWordCount = document.getElementById('transcript-word-count');

  if (!transcriptCard || !transcriptWordsContainer) return;

  transcriptCard.style.display = 'flex';
  transcriptWordsContainer.innerHTML = '';

  if (transcriptWordCount) {
    transcriptWordCount.textContent = `${appState.words.length} words`;
  }

  appState.words.forEach((wordObj, idx) => {
    const chip = document.createElement('span');
    chip.className = 'word-chip';
    chip.contentEditable = 'true';
    chip.spellcheck = false;
    chip.textContent = wordObj.word || '';
    chip.dataset.index = idx;
    chip.dataset.originalText = wordObj.word || '';

    // Mark edited words visually
    chip.addEventListener('input', () => {
      const currentText = chip.textContent.trim();
      if (currentText !== chip.dataset.originalText) {
        chip.classList.add('edited');
      } else {
        chip.classList.remove('edited');
      }
    });

    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        chip.blur();
      }
    });

    transcriptWordsContainer.appendChild(chip);
  });
}

/**
 * Collect word objects from transcript editor chips
 */
export function collectEditedWords() {
  const transcriptWordsContainer = document.getElementById('transcript-words-container');
  if (!transcriptWordsContainer) return [];

  const chips = transcriptWordsContainer.querySelectorAll('.word-chip');
  return Array.from(chips).map((chip, idx) => {
    const originalWord = appState.words[idx];
    return {
      ...originalWord,
      word: chip.textContent.trim(),
      start: originalWord ? originalWord.start : 0,
      end: originalWord ? originalWord.end : 0
    };
  });
}
