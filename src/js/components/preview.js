/**
 * Center Preview Workspace Component for Caption Studio
 */
import { appState, subscribe, updateState, MOCK_SUBTITLES, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig } from '../../../shared/captionConfig.js';

// Dynamic Google Font Loader
const loadedFonts = new Set();
export function loadGoogleFont(fontName) {
  if (!fontName || loadedFonts.has(fontName)) return;
  loadedFonts.add(fontName);

  const cleanFont = fontName.replace(/['"]/g, '').split(',')[0].trim();
  const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(cleanFont).replace(/%20/g, '+')}:wght@400;600;700;800;900&display=swap`;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = fontUrl;
  document.head.appendChild(link);
}

export function initPreviewWorkspace() {
  const previewVideo = document.getElementById('preview-video');
  const subtitlesOverlay = document.getElementById('subtitles-overlay');
  const captionsText = document.getElementById('captions-text');
  const btnVideoPlay = document.getElementById('btn-video-play');
  const iconPlayState = document.getElementById('icon-play-state');
  const playPoly = iconPlayState?.querySelector('.play-poly');
  const videoSeekBar = document.getElementById('video-seek-bar');
  const timeDisplayCurrent = document.getElementById('time-display-current');
  const timeDisplayDuration = document.getElementById('time-display-duration');

  // Video Time Updates & Subtitle Synchronization
  if (previewVideo) {
    previewVideo.addEventListener('timeupdate', () => {
      syncVideoSubtitles();
      if (videoSeekBar && previewVideo.duration) {
        const percent = (previewVideo.currentTime / previewVideo.duration) * 100;
        videoSeekBar.value = percent;
      }
      if (timeDisplayCurrent) {
        timeDisplayCurrent.textContent = formatTime(previewVideo.currentTime);
      }
    });

    previewVideo.addEventListener('loadedmetadata', () => {
      if (timeDisplayDuration) {
        timeDisplayDuration.textContent = formatTime(previewVideo.duration);
      }
      appState.videoDuration = previewVideo.duration;
    });

    previewVideo.addEventListener('ended', () => {
      if (playPoly) playPoly.setAttribute('points', '5,3 19,12 5,21');
    });
  }

  // Play / Pause Toggle
  if (btnVideoPlay && previewVideo) {
    btnVideoPlay.addEventListener('click', () => {
      if (previewVideo.paused) {
        previewVideo.play();
        if (playPoly) playPoly.setAttribute('points', '5,3 9,3 9,21 5,21 15,3 19,3 19,21 15,21'); // Pause icon representation
      } else {
        previewVideo.pause();
        if (playPoly) playPoly.setAttribute('points', '5,3 19,12 5,21');
      }
    });
  }

  // Seek Bar Dragging
  if (videoSeekBar && previewVideo) {
    videoSeekBar.addEventListener('input', (e) => {
      if (previewVideo.duration) {
        const newTime = (e.target.value / 100) * previewVideo.duration;
        previewVideo.currentTime = newTime;
      }
    });
  }

  // Subscribe to global state changes for live CSS preview update
  subscribe('*', () => {
    applyCSSPreviewStyles();
    syncVideoSubtitles();
  });

  initManualDragPositioning();

  applyCSSPreviewStyles();
  syncVideoSubtitles();
}

/**
 * Enables dragging the caption overlay around the phone preview when
 * appState.position === 'manual'. Uses Pointer Events so a single set of
 * handlers covers both mouse and touch input. Stores the dragged position as
 * customPosX/customPosY percentages of the phone-frame canvas — the exact
 * same coordinate space getCSSPreviewFromConfig/getASSStyleFromConfig resolve
 * from, so preview and export always agree on where the caption sits.
 */
function initManualDragPositioning() {
  const subtitlesOverlay = document.getElementById('subtitles-overlay');
  const phoneFrame = document.querySelector('.phone-frame');
  if (!subtitlesOverlay || !phoneFrame) return;

  let isDragging = false;

  function updatePositionFromPointer(e) {
    const rect = phoneFrame.getBoundingClientRect();
    const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    updateState({ customPosX: xPct, customPosY: yPct }, { recordHistory: false });
  }

  subtitlesOverlay.addEventListener('pointerdown', (e) => {
    if (appState.position !== 'manual') return;
    isDragging = true;
    subtitlesOverlay.setPointerCapture(e.pointerId);
    updatePositionFromPointer(e);
  });

  subtitlesOverlay.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    updatePositionFromPointer(e);
  });

  function endDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    updatePositionFromPointer(e);
    // Commit the whole drag as a single undo step
    updateState({ customPosX: appState.customPosX, customPosY: appState.customPosY }, { recordHistory: true });
  }

  subtitlesOverlay.addEventListener('pointerup', endDrag);
  subtitlesOverlay.addEventListener('pointercancel', endDrag);
}

/**
 * Applies active appState parameters to the DOM CSS overlay
 */
export function applyCSSPreviewStyles() {
  const subtitlesOverlay = document.getElementById('subtitles-overlay');
  const captionsText = document.getElementById('captions-text');

  if (!subtitlesOverlay || !captionsText) return;

  loadGoogleFont(appState.fontFamily);

  const cssConfig = getCSSPreviewFromConfig(getStyleParams());

  // Apply Overlay Styles
  Object.assign(subtitlesOverlay.style, cssConfig.overlay);
  subtitlesOverlay.classList.toggle('manual-drag-mode', appState.position === 'manual');

  // Apply Text Styles
  Object.assign(captionsText.style, cssConfig.text);
  captionsText.style.setProperty('--pop-scale', ((appState.popScale || 118) / 100).toString());
}

/**
 * Word-by-word subtitle rendering for live HTML5 video timeline
 */
export function syncVideoSubtitles() {
  const previewVideo = document.getElementById('preview-video');
  const captionsText = document.getElementById('captions-text');

  if (!previewVideo || !captionsText) return;

  const currentTime = previewVideo.currentTime;

  const cssConfig = getCSSPreviewFromConfig(getStyleParams());

  const activeHighlight = cssConfig.highlightColor || '#FEF08A';
  const inactiveColor = cssConfig.inactiveColor || '#FFFFFF';
  const mode = appState.animationMode || 'karaoke';
  const wordSpacingPx = cssConfig.wordSpacingPx !== undefined ? cssConfig.wordSpacingPx : 4;

  // Search active phrase in backend generated phrase timing model
  let activePhrase = null;
  if (appState.phrases && appState.phrases.length > 0) {
    activePhrase = appState.phrases.find(p => currentTime >= p.start && currentTime <= p.end);
  }

  // Demo Subtitles Fallback
  if (!activePhrase) {
    const demoItem = MOCK_SUBTITLES.find(s => currentTime >= s.start && currentTime <= s.end);
    if (demoItem) {
      const text = appState.textCase === 'uppercase' ? demoItem.text.toUpperCase() : demoItem.text;
      const wordElement = document.createElement('span');
      wordElement.className = 'word-unit';
      wordElement.style.color = inactiveColor;
      wordElement.textContent = text;
      captionsText.replaceChildren(wordElement);
    } else {
      captionsText.replaceChildren();
    }
    return;
  }

  // Render active phrase words
  const isUppercase = appState.textCase === 'uppercase';
  const breakIndices = new Set(activePhrase.breakAfterIndices || []);

  const keywordsEnabled = appState.enableKeywordHighlighting;
  const keywordColorHigh = appState.keywordColorHigh || '#EF4444';
  const keywordColorMedium = appState.keywordColorMedium || '#FB923C';

  const wordElements = activePhrase.words.map((w, idx) => {
    const isWordActive = currentTime >= w.start && currentTime <= w.end;
    const isPastWord = currentTime > w.end;
    const wordText = isUppercase ? (w.word || w.text || '').toUpperCase() : (w.word || w.text || '');
    const isActiveKeyword = keywordsEnabled && w.isKeyword && isWordActive;
    const keywordColor = w.importance === 'high' ? keywordColorHigh : keywordColorMedium;

    let color = inactiveColor;
    let extraClasses = ['word-unit'];

    if (mode === 'typewriter') {
      // Typewriter's ASS export has no active/inactive color swap, so the
      // dedicated keyword color is intentionally not applied here either —
      // only the mode-agnostic bold/italic styling below stays in sync.
      if (!isWordActive && !isPastWord) {
        extraClasses.push('anim-typewriter-hidden');
      } else {
        color = isWordActive ? activeHighlight : inactiveColor;
      }
    } else if (mode === 'pop') {
      if (isWordActive) {
        color = isActiveKeyword ? keywordColor : activeHighlight;
        extraClasses.push('anim-pop-active');
      } else {
        color = inactiveColor;
      }
    } else {
      color = isWordActive ? (isActiveKeyword ? keywordColor : activeHighlight) : inactiveColor;
    }

    const wordElement = document.createElement('span');
    wordElement.className = extraClasses.join(' ');
    wordElement.style.color = color;
    if (keywordsEnabled && w.isKeyword) {
      wordElement.style.fontWeight = w.importance === 'high' ? '900' : '';
      wordElement.style.fontStyle = w.importance === 'medium' ? 'italic' : '';
    }
    wordElement.textContent = wordText;

    if (!breakIndices.has(idx) && idx !== activePhrase.words.length - 1) {
      wordElement.style.marginRight = `${wordSpacingPx}px`;
    }

    return { wordElement, isLineBreak: breakIndices.has(idx - 1) };
  });

  const fragment = document.createDocumentFragment();
  wordElements.forEach(({ wordElement, isLineBreak }) => {
    if (isLineBreak) {
      fragment.append(document.createElement('br'));
    }
    fragment.append(wordElement);
  });
  captionsText.replaceChildren(fragment);
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
