/**
 * Center Preview Workspace Component for Caption Studio
 */
import { appState, subscribe, MOCK_SUBTITLES } from '../state.js';
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

  applyCSSPreviewStyles();
  syncVideoSubtitles();
}

/**
 * Applies active appState parameters to the DOM CSS overlay
 */
export function applyCSSPreviewStyles() {
  const subtitlesOverlay = document.getElementById('subtitles-overlay');
  const captionsText = document.getElementById('captions-text');

  if (!subtitlesOverlay || !captionsText) return;

  loadGoogleFont(appState.fontFamily);

  const cssConfig = getCSSPreviewFromConfig({
    preset: appState.currentPreset,
    fontFamily: appState.fontFamily,
    fontSize: appState.fontSize,
    wordSpacing: appState.wordSpacing,
    popScale: appState.popScale,
    activeWordColor: appState.activeWordColor,
    inactiveWordColor: appState.inactiveWordColor,
    outlineColor: appState.outlineColor,
    backgroundColor: appState.backgroundColor,
    textCase: appState.textCase,
    position: appState.position,
    animationMode: appState.animationMode
  });

  // Apply Overlay Styles
  Object.assign(subtitlesOverlay.style, cssConfig.overlay);

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

  const cssConfig = getCSSPreviewFromConfig({
    preset: appState.currentPreset,
    fontFamily: appState.fontFamily,
    fontSize: appState.fontSize,
    wordSpacing: appState.wordSpacing,
    popScale: appState.popScale,
    activeWordColor: appState.activeWordColor,
    inactiveWordColor: appState.inactiveWordColor,
    outlineColor: appState.outlineColor,
    backgroundColor: appState.backgroundColor,
    textCase: appState.textCase,
    position: appState.position,
    animationMode: appState.animationMode
  });

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
      captionsText.innerHTML = `<span class="word-unit" style="color: ${inactiveColor};">${text}</span>`;
    } else {
      captionsText.innerHTML = '';
    }
    return;
  }

  // Render active phrase words
  const isUppercase = appState.textCase === 'uppercase';
  const breakIndices = new Set(activePhrase.breakAfterIndices || []);

  const spanHtml = activePhrase.words.map((w, idx) => {
    const isWordActive = currentTime >= w.start && currentTime <= w.end;
    const isPastWord = currentTime > w.end;
    const wordText = isUppercase ? (w.word || w.text || '').toUpperCase() : (w.word || w.text || '');

    let color = inactiveColor;
    let extraClasses = ['word-unit'];

    if (mode === 'typewriter') {
      if (!isWordActive && !isPastWord) {
        extraClasses.push('anim-typewriter-hidden');
      } else {
        color = isWordActive ? activeHighlight : inactiveColor;
      }
    } else if (mode === 'pop') {
      if (isWordActive) {
        color = activeHighlight;
        extraClasses.push('anim-pop-active');
      } else {
        color = inactiveColor;
      }
    } else {
      color = isWordActive ? activeHighlight : inactiveColor;
    }

    const isLastInLine = breakIndices.has(idx) || idx === activePhrase.words.length - 1;
    const isLineBreak = breakIndices.has(idx - 1);
    const spacingStyle = isLastInLine ? '' : `margin-right: ${wordSpacingPx}px;`;
    const brTag = isLineBreak ? '<br/>' : '';

    return `${brTag}<span class="${extraClasses.join(' ')}" style="color: ${color}; ${spacingStyle}">${wordText}</span>`;
  }).join('');

  captionsText.innerHTML = spanHtml;
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
