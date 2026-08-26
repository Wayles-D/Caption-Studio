/**
 * Center Preview Workspace Component for Caption Studio
 */
import { appState, subscribe, updateState, MOCK_SUBTITLES, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig, applyCaseTransform, resolveWordStyleMetadata, resolveWordTextCase, applyOpacityToColor } from '../../../shared/captionConfig.js';
import { resolveFontFace } from '../../../shared/fontRegistry.js';
import { resolveRollingStackFrame, chunkRawText } from '../../../shared/rollingStack.js';
import { canDrawCaptionFrame, isGraphicsRendererDefaultForPreset, drawCaptionFrame } from '../../../shared/captionGraphics.js';

// Self-hosted local font loader: fonts are bundled with the project (see
// backend/fonts/ + shared/fontRegistry.js) and served statically by the
// backend, instead of fetched from Google Fonts. This guarantees the preview
// renders with the EXACT same font file FFmpeg/libass burns into the
// exported video (see backend/utils/ffmpeg.js's `fontsdir` option) — no
// dependency on the OS or an external CDN either way.
const loadedFontFaces = new Set();
let localFontStyleEl = null;

function ensureLocalFontStyleEl() {
  if (!localFontStyleEl) {
    localFontStyleEl = document.createElement('style');
    localFontStyleEl.id = 'caption-studio-local-fonts';
    document.head.appendChild(localFontStyleEl);
  }
  return localFontStyleEl;
}

/**
 * Registers an @font-face rule for one resolved font face (regular/italic/
 * bold/...), resolved through the exact same Font Registry the ASS exporter
 * uses, so a requested display name always maps to the identical bundled
 * file on both sides.
 *
 * @param {string} displayName - Font family as selected in the UI.
 * @param {string} [face='regular'] - Registry face key.
 */
export function loadLocalFontFace(displayName, face = 'regular') {
  if (!displayName) return;
  const resolved = resolveFontFace(displayName, face);
  const cacheKey = `${resolved.familyName}::${resolved.file}`;
  if (loadedFontFaces.has(cacheKey)) return;
  loadedFontFaces.add(cacheKey);

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
  const fontUrl = `${apiBaseUrl}/fonts/${encodeURIComponent(resolved.file)}`;
  const weightDescriptor = resolved.bold ? '700' : '400';
  const styleDescriptor = resolved.italic ? 'italic' : 'normal';

  const rule = `@font-face { font-family: '${resolved.familyName}'; src: url('${fontUrl}'); font-weight: ${weightDescriptor}; font-style: ${styleDescriptor}; font-display: swap; }`;
  ensureLocalFontStyleEl().appendChild(document.createTextNode(rule));
}

/**
 * Loads whichever font face the current preset's keyword tier needs (the
 * base font is loaded separately in applyCSSPreviewStyles). Reads the same
 * user-override-or-preset-default precedence resolveKeywordStyleConfig uses,
 * so the exact face actually rendered is always the one loaded.
 */
function loadKeywordDrivenFontFaces(cssConfig) {
  const keywordStyle = cssConfig.profile?.keywordStyle;
  if (!cssConfig.keywordDriven || !keywordStyle) return;

  const font = appState.keywordFont || keywordStyle.fontFamily;
  if (font) loadLocalFontFace(font, keywordStyle.face || 'regular');
}

/**
 * Shared-graphics-renderer preview path (shared/captionGraphics.js). Live by
 * default for the presets in GRAPHICS_RENDERER_DEFAULT_PRESETS (currently
 * 'bold-yellow' and 'caps-white') — the SAME renderer backend/utils/
 * graphicsExport.js now uses for those presets' actual video export, so
 * preview and export can no longer visually disagree for them. Every other
 * preset still renders via the CSS/DOM path below unchanged.
 * window.__USE_GRAPHICS_CAPTIONS__ remains as a dev override to preview the
 * renderer on a preset/mode it technically supports (canDrawCaptionFrame)
 * but hasn't been promoted to the default list yet — that combination is
 * NOT wired to export, so it's for visual inspection only, never for real use.
 */
const canvasFontsReadyCache = new Set();

function ensureCanvasFontReady(fontFamily, fontWeight, fontSizePx) {
  const key = `${fontFamily}::${fontWeight}`;
  if (canvasFontsReadyCache.has(key)) return Promise.resolve(false);
  const fontStr = `${fontWeight || '400'} ${fontSizePx}px '${fontFamily}'`;
  return document.fonts.load(fontStr).then(() => {
    canvasFontsReadyCache.add(key);
    return true;
  }).catch(() => false);
}

function drawGraphicsCanvasFrame(canvas, activePhrase, currentTime, cssConfig, params) {
  const phoneFrame = document.querySelector('.phone-frame');
  if (!phoneFrame) return;

  const rect = phoneFrame.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (targetW <= 0 || targetH <= 0) return;
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;

  const fontFamily = cssConfig.text.fontFamily.replace(/'/g, '');
  const fontSizePx = parseFloat(cssConfig.text.fontSize) || 14;
  ensureCanvasFontReady(fontFamily, cssConfig.profile.fontWeight, fontSizePx).then((justLoaded) => {
    if (justLoaded) syncVideoSubtitles();
  });

  const ctx = canvas.getContext('2d');
  drawCaptionFrame(ctx, {
    canvasWidth: targetW,
    canvasHeight: targetH,
    cssPixelWidth: rect.width,
    activePhrase,
    currentTime,
    cssConfig,
    params
  });
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
        // play() returns a promise that rejects (AbortError) if the video's
        // src changes or load() is called before it resolves — expected
        // whenever a new upload/demo video replaces the current source
        // while this one was mid-play, not a real failure. Left unhandled,
        // that shows up as an "Uncaught (in promise) DOMException".
        previewVideo.play().catch(() => {});
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

  const cssConfig = getCSSPreviewFromConfig(getStyleParams());

  loadLocalFontFace(appState.fontFamily, 'regular');
  // The ASS export selects a font's real Bold face via fontconfig whenever
  // the resolved profile.fontWeight is heavy (see getASSStyleFromConfig's
  // `fontWeightNum >= 600 ? -1 : 0`) — mirror that here so the preview
  // registers that SAME real bold @font-face (e.g. Poppins-Bold.ttf) instead
  // of leaving the browser to synthesize/thicken the Regular face, which can
  // visibly differ from the genuine bold glyphs the export burns in. Safe
  // no-op for fonts without a distinct bold file: resolveFontFace's own
  // fallback just returns that font's 'regular' face again (already cached).
  if ((parseInt(cssConfig.profile?.fontWeight, 10) || 0) >= 600) {
    loadLocalFontFace(appState.fontFamily, 'bold');
  }
  loadKeywordDrivenFontFaces(cssConfig);

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

  // Default the graphics-renderer canvas to inert; only the sentence-mode
  // branch below (the sole mode canDrawCaptionFrame currently supports)
  // re-activates it. Every other return path in this function (demo
  // fallback, Word Mode, Rolling Stack) leaves it hidden instead of showing
  // stale content from a previous mode.
  const captionsCanvas = document.getElementById('captions-canvas');
  if (captionsCanvas) captionsCanvas.classList.remove('active');
  captionsText.style.visibility = '';

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
      const text = applyCaseTransform(demoItem.text, appState.textCase);
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

  // Word Mode: exactly one transcript word visible at a time, timed to its
  // own Whisper start/end within the already-found active phrase — only
  // reached once real phrase/word data exists (the demo fallback above is
  // shared with Sentence mode and unchanged). Everything else (colors,
  // opacity, shadow, blur, outline, font, position) still comes from the
  // same cssConfig/container styling applyCSSPreviewStyles already applied,
  // exactly like Sentence mode's word spans below — only the "how many
  // words are shown at once, and which text unit drives timing" differs.
  if (appState.captionMode === 'word') {
    renderWordModeCaption(activePhrase, currentTime, cssConfig, captionsText);
    return;
  }

  // Rolling Stack: a two-layer previous/active caption layout built around
  // detected keywords — see shared/rollingStack.js for the shared chunking/
  // framing logic this and the ASS exporter's generateRollingStackDialogueEvents
  // both call, so preview and export can never disagree on grouping or timing.
  if (appState.captionMode === 'rolling-stack') {
    renderRollingStackCaption(activePhrase, currentTime, cssConfig, captionsText);
    return;
  }

  // Graphics-renderer path — see drawGraphicsCanvasFrame's doc comment for
  // which presets this is live for by default, and the dev-flag override.
  // Falls straight through to the existing CSS/DOM rendering below whenever
  // neither applies.
  const useGraphicsRenderer = isGraphicsRendererDefaultForPreset(cssConfig)
    || (window.__USE_GRAPHICS_CAPTIONS__ && canDrawCaptionFrame(cssConfig));
  if (useGraphicsRenderer && captionsCanvas) {
    drawGraphicsCanvasFrame(captionsCanvas, activePhrase, currentTime, cssConfig, getStyleParams());
    captionsCanvas.classList.add('active');
    captionsText.style.visibility = 'hidden';
  }

  // Render active phrase words
  const breakIndices = new Set(activePhrase.breakAfterIndices || []);

  const keywordsEnabled = appState.enableKeywordHighlighting;
  const keywordColor = appState.keywordColor || '#EF4444';

  // Keyword-driven presets (e.g. WAYLES) derive a word's entire appearance
  // from resolveWordStyleMetadata instead of the active/inactive model below
  // — the exact same function the ASS exporter calls, so the two always
  // agree. Existing presets are untouched: they never set keywordDriven.
  const keywordDriven = !!cssConfig.keywordDriven;
  const keywordStyleConfig = cssConfig.keywordStyleConfig;
  const activeHighlightEnabled = cssConfig.activeHighlightEnabled;

  const wordElements = activePhrase.words.map((w, idx) => {
    const isWordActive = currentTime >= w.start && currentTime <= w.end;
    const isPastWord = currentTime > w.end;
    const caseForWord = resolveWordTextCase(!!w.isKeyword, keywordsEnabled, appState.textCase, cssConfig.keywordTextCase);
    const wordText = applyCaseTransform(w.word || w.text || '', caseForWord, idx === 0);

    const wordElement = document.createElement('span');

    if (keywordDriven) {
      const metadata = resolveWordStyleMetadata(w, {
        keywordStyleConfig,
        keywordsEnabled,
        activeHighlightEnabled,
        isWordActive,
        mode,
        activeHighlightColorHex: activeHighlight,
        inactiveColorHex: inactiveColor,
        baseFontFamily: cssConfig.profile?.fontFamily,
        baseFontWeight: cssConfig.profile?.fontWeight
      });

      const extraClasses = ['word-unit'];
      if (metadata.animation === 'pop') extraClasses.push('anim-pop-active');
      wordElement.className = extraClasses.join(' ');

      // Global Text Opacity is already baked into activeHighlight/inactiveColor
      // above, so it's a no-op (opacity=100 short-circuits) for non-keyword
      // words here. A keyword word's tier color is raw/unadjusted, so it needs
      // both the global opacity and the dedicated Keyword Opacity applied
      // fresh — composed exactly like the ASS exporter composes them.
      const wordOpacity = metadata.isKeyword
        ? (appState.textOpacity ?? 100) * (keywordStyleConfig.opacity ?? 100) / 100
        : 100;
      wordElement.style.color = applyOpacityToColor(metadata.colorHex, wordOpacity);
      if (metadata.fontFamily) wordElement.style.fontFamily = metadata.fontFamily;
      if (metadata.fontWeight) wordElement.style.fontWeight = metadata.fontWeight;
      wordElement.style.fontStyle = metadata.italic ? 'italic' : 'normal';
      if (metadata.fontScale && metadata.fontScale !== 1) {
        wordElement.style.transform = `scale(${metadata.fontScale})`;
      }
      if (metadata.shadow) wordElement.style.textShadow = metadata.shadow.css;
      if (metadata.outline) wordElement.style.webkitTextStroke = metadata.outline.css;
      // wordText was already case-transformed above via caseForWord — prevent
      // the container's own CSS text-transform (set from the global textCase)
      // from re-transforming it and silently overriding a per-word casing
      // override (e.g. a keyword forced lowercase while the caption is
      // otherwise uppercase) purely at paint time.
      wordElement.style.textTransform = 'none';
      wordElement.textContent = wordText;

      if (!breakIndices.has(idx) && idx !== activePhrase.words.length - 1) {
        wordElement.style.marginRight = `${wordSpacingPx}px`;
      }

      return { wordElement, isLineBreak: breakIndices.has(idx - 1) };
    }

    const isActiveKeyword = keywordsEnabled && w.isKeyword && isWordActive;

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

    wordElement.className = extraClasses.join(' ');
    wordElement.style.color = color;
    if (keywordsEnabled && w.isKeyword) {
      wordElement.style.fontWeight = '900';
    }
    wordElement.style.textTransform = 'none';
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

/**
 * Word Mode's render step: finds the single word within the active phrase
 * whose own [start, end] contains currentTime (Whisper's own timestamps,
 * untouched) and renders ONLY that word — every other word (past or
 * upcoming) is simply absent from the DOM, so it disappears instead of
 * lingering. In a gap between two words (end of one before the next
 * starts), no word qualifies and the caption is empty, matching the ASS
 * exporter's per-word Dialogue events (see assWriter.js's
 * generateWordModeDialogueEvents) exactly.
 *
 * The visible word always reads in the "active"/highlight color (mirroring
 * what Sentence mode already calls the active word's color) since it's the
 * one currently being spoken — there is no "inactive" word to contrast
 * against with only one word on screen. Keyword-driven presets (e.g.
 * WAYLES) and legacy keyword-color-swap presets both reuse the exact same
 * resolveWordStyleMetadata/keyword logic Sentence mode already uses below,
 * just with isWordActive always true.
 */
function renderWordModeCaption(activePhrase, currentTime, cssConfig, captionsText) {
  const activeWord = activePhrase.words.find(w => currentTime >= w.start && currentTime <= w.end);
  if (!activeWord) {
    captionsText.replaceChildren();
    return;
  }

  const activeHighlight = cssConfig.highlightColor || '#FEF08A';
  const keywordsEnabled = appState.enableKeywordHighlighting;
  const caseForWord = resolveWordTextCase(!!activeWord.isKeyword, keywordsEnabled, appState.textCase, cssConfig.keywordTextCase);
  const wordText = applyCaseTransform(activeWord.word || activeWord.text || '', caseForWord, true);

  const wordElement = document.createElement('span');
  wordElement.className = 'word-unit';

  if (cssConfig.keywordDriven) {
    const metadata = resolveWordStyleMetadata(activeWord, {
      keywordStyleConfig: cssConfig.keywordStyleConfig,
      keywordsEnabled,
      activeHighlightEnabled: cssConfig.activeHighlightEnabled,
      isWordActive: true,
      mode: appState.animationMode,
      activeHighlightColorHex: activeHighlight,
      inactiveColorHex: activeHighlight,
      baseFontFamily: cssConfig.profile?.fontFamily,
      baseFontWeight: cssConfig.profile?.fontWeight
    });

    const wordOpacity = metadata.isKeyword
      ? (appState.textOpacity ?? 100) * (cssConfig.keywordStyleConfig.opacity ?? 100) / 100
      : 100;
    wordElement.style.color = applyOpacityToColor(metadata.colorHex, wordOpacity);
    if (metadata.fontFamily) wordElement.style.fontFamily = metadata.fontFamily;
    if (metadata.fontWeight) wordElement.style.fontWeight = metadata.fontWeight;
    wordElement.style.fontStyle = metadata.italic ? 'italic' : 'normal';
    if (metadata.shadow) wordElement.style.textShadow = metadata.shadow.css;
    if (metadata.outline) wordElement.style.webkitTextStroke = metadata.outline.css;
  } else {
    const isActiveKeyword = keywordsEnabled && activeWord.isKeyword;
    const keywordColor = cssConfig.keywordColor || '#EF4444';
    wordElement.style.color = isActiveKeyword ? keywordColor : activeHighlight;
    if (isActiveKeyword) {
      wordElement.style.fontWeight = '900';
    }
  }

  wordElement.style.textTransform = 'none';
  wordElement.textContent = wordText;
  captionsText.replaceChildren(wordElement);
}

/**
 * Builds one Rolling Stack line (top/previous or bottom/active) from
 * resolveWordStyleMetadata's generic metadata — a chunk of one-or-more
 * consecutive words that share the same isKeyword value (see
 * shared/rollingStack.js), styled exactly like a keyword-driven word span
 * elsewhere in this file, just applied to the chunk's joined text instead of
 * a single word. `isActive` gates the pop-scale/active-highlight-color the
 * same way it does for individual words: true for the bottom chunk, false
 * for the top chunk, so only the currently-active line ever scales up.
 */
function buildRollingStackLineElement(chunk, cssConfig, isActive) {
  const keywordsEnabled = appState.enableKeywordHighlighting;
  const activeHighlight = cssConfig.highlightColor || '#FEF08A';
  const inactiveColor = cssConfig.inactiveColor || '#FFFFFF';

  const caseForChunk = resolveWordTextCase(chunk.type === 'keyword', keywordsEnabled, appState.textCase, cssConfig.keywordTextCase);
  const lineText = applyCaseTransform(chunkRawText(chunk), caseForChunk, true);

  const metadata = resolveWordStyleMetadata({ isKeyword: chunk.type === 'keyword' }, {
    keywordStyleConfig: cssConfig.keywordStyleConfig,
    keywordsEnabled,
    activeHighlightEnabled: cssConfig.activeHighlightEnabled,
    isWordActive: isActive,
    mode: appState.animationMode,
    activeHighlightColorHex: activeHighlight,
    inactiveColorHex: inactiveColor,
    baseFontFamily: cssConfig.profile?.fontFamily,
    baseFontWeight: cssConfig.profile?.fontWeight
  });

  const lineOpacity = metadata.isKeyword
    ? (appState.textOpacity ?? 100) * (cssConfig.keywordStyleConfig.opacity ?? 100) / 100
    : 100;

  const line = document.createElement('div');
  line.className = 'rolling-stack-line';
  line.style.color = applyOpacityToColor(metadata.colorHex, lineOpacity);
  if (metadata.fontFamily) line.style.fontFamily = metadata.fontFamily;
  if (metadata.fontWeight) line.style.fontWeight = metadata.fontWeight;
  line.style.fontStyle = metadata.italic ? 'italic' : 'normal';
  if (metadata.fontScale && metadata.fontScale !== 1) {
    line.style.transform = `scale(${metadata.fontScale})`;
  }
  if (metadata.shadow) line.style.textShadow = metadata.shadow.css;
  if (metadata.outline) line.style.webkitTextStroke = metadata.outline.css;
  // lineText was already case-transformed above via caseForChunk — same
  // reasoning as the sentence/word-mode word spans: prevent the container's
  // inherited CSS text-transform from silently re-uppercasing a keyword
  // chunk forced lowercase.
  line.style.textTransform = 'none';
  line.textContent = lineText;
  return line;
}

/**
 * Rolling Stack's render step: resolves the current two-layer frame (see
 * shared/rollingStack.js's resolveRollingStackFrame — the exact same
 * chunking/timing logic assWriter.js's generateRollingStackDialogueEvents
 * uses for export) and renders it as a small vertical stack — a real single
 * line when only one chunk is genuinely active right now, two lines only
 * when two chunks' own timestamps genuinely overlap, and nothing at all
 * during a genuine gap between words. Nothing is ever carried forward from a
 * previous tick: every render derives strictly from the current playback
 * time against each chunk's own start/end. The container is switched to a
 * column flex layout only while this mode is active; every other mode's
 * inline-block layout (set by applyCSSPreviewStyles) is left untouched.
 */
function renderRollingStackCaption(activePhrase, currentTime, cssConfig, captionsText) {
  const { top, bottom } = resolveRollingStackFrame(activePhrase.words, currentTime);

  if (!bottom) {
    captionsText.replaceChildren();
    return;
  }

  captionsText.style.display = 'flex';
  captionsText.style.flexDirection = 'column';
  captionsText.style.alignItems = 'center';
  captionsText.style.gap = '0.15em';

  const fragment = document.createDocumentFragment();
  if (top) fragment.append(buildRollingStackLineElement(top, cssConfig, false));
  fragment.append(buildRollingStackLineElement(bottom, cssConfig, true));
  captionsText.replaceChildren(fragment);
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
