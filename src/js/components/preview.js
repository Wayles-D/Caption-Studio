/**
 * Center Preview Workspace Component for Caption Studio
 */
import { appState, subscribe, updateState, MOCK_SUBTITLES, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig, applyCaseTransform, resolveWordStyleMetadata, resolveWordTextCase, applyOpacityToColor } from '../../../shared/captionConfig.js';
import { resolveFontFace } from '../../../shared/fontRegistry.js';
import { resolveRollingStackFrame, chunkRawText, buildRollingStackChunks, resolveRollingStackWindow } from '../../../shared/rollingStack.js';
import { canDrawCaptionFrame, isGraphicsRendererDefault, drawCaptionFrame, drawRollingStackFrame, measureSentenceFrame, measureRollingStackFrame } from '../../../shared/captionGraphics.js';
import { initCanvasTransform, updateCanvasTransformOverlay, hideCanvasTransformOverlay } from './canvasTransform.js';
import { resolvePhraseParams } from '../../../shared/captionTransform.js';

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
 * Shared-graphics-renderer preview path (shared/captionGraphics.js). Live for
 * every mode/preset canDrawCaptionFrame() accepts (== isGraphicsRendererDefault,
 * see that function's doc comment) — the SAME renderer backend/utils/
 * graphicsFrameGenerator.js uses for actual video export, so preview and
 * export can never visually disagree. Selection/transform editing (see
 * src/js/components/canvasTransform.js) rides along automatically whenever
 * this path is live, since caption mode/preset only ever decides layout, not
 * editability. Only the remaining Unified-Shadow-in-sentence-mode gap still
 * falls through to the legacy CSS/DOM path below.
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

/**
 * Sizes the graphics canvas to the phone-frame's current on-screen box
 * (device pixels) and kicks off font-readiness loading for the base font —
 * shared prep step for both the sentence-mode and Rolling Stack canvas draw
 * paths below. Returns null when the phone-frame isn't laid out yet.
 */
function prepareGraphicsCanvas(canvas, fontFamily, fontWeight, fontSizePx) {
  const phoneFrame = document.querySelector('.phone-frame');
  if (!phoneFrame) return null;

  const rect = phoneFrame.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (targetW <= 0 || targetH <= 0) return null;
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;

  ensureCanvasFontReady(fontFamily, fontWeight, fontSizePx).then((justLoaded) => {
    if (justLoaded) syncVideoSubtitles();
  });

  return { ctx: canvas.getContext('2d'), targetW, targetH, cssPixelWidth: rect.width };
}

function drawGraphicsCanvasFrame(canvas, activePhrase, currentTime, cssConfig, params) {
  const fontFamily = cssConfig.text.fontFamily.replace(/'/g, '');
  const fontSizePx = parseFloat(cssConfig.text.fontSize) || 14;
  const prepped = prepareGraphicsCanvas(canvas, fontFamily, cssConfig.profile.fontWeight, fontSizePx);
  if (!prepped) return null;

  const drawOpts = {
    canvasWidth: prepped.targetW,
    canvasHeight: prepped.targetH,
    cssPixelWidth: prepped.cssPixelWidth,
    activePhrase,
    currentTime,
    cssConfig,
    params,
    // Unified shadow mode needs to composite the whole caption block
    // offscreen before applying one drop-shadow to it — see
    // renderResolvedFrame/paintSentenceComposite's doc comment. A plain
    // in-DOM <canvas> (never attached) works fine as a scratch surface here.
    createOffscreenCanvas: (w, h) => {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      return off;
    }
  };
  drawCaptionFrame(prepped.ctx, drawOpts);
  // Same ctx (fonts already loaded into it above) so measureText resolves
  // identically — see measureSentenceFrame's doc comment for the on-canvas
  // transform overlay this feeds (src/js/components/canvasTransform.js).
  return measureSentenceFrame(prepped.ctx, drawOpts);
}

/**
 * Rolling Stack's canvas draw path. `windowChunks` is already resolved (see
 * resolveRollingStackWindow in shared/rollingStack.js) — this only sizes the
 * canvas, makes sure the base font is loading, and hands off to the shared
 * graphics renderer's drawRollingStackFrame.
 */
function drawGraphicsRollingStackCanvasFrame(canvas, windowChunks, currentTime, cssConfig, params) {
  const fontFamily = cssConfig.text.fontFamily.replace(/'/g, '');
  const fontSizePx = parseFloat(cssConfig.text.fontSize) || 14;
  const prepped = prepareGraphicsCanvas(canvas, fontFamily, cssConfig.profile.fontWeight, fontSizePx);
  if (!prepped) return null;

  const drawOpts = {
    canvasWidth: prepped.targetW,
    canvasHeight: prepped.targetH,
    cssPixelWidth: prepped.cssPixelWidth,
    windowChunks,
    currentTime,
    cssConfig,
    params,
    alignment: params.rollingStackAlignment,
    // Unified shadow mode needs to composite the whole line stack offscreen
    // before applying one drop-shadow to it — see drawRollingStackFrame's
    // doc comment. A plain in-DOM <canvas> (never attached) works fine as a
    // scratch surface here.
    createOffscreenCanvas: (w, h) => {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      return off;
    }
  };
  drawRollingStackFrame(prepped.ctx, drawOpts);
  return measureRollingStackFrame(prepped.ctx, drawOpts);
}

// Guards against double-initialization — same reasoning as
// sidebarInspector.js's own `initialized` guard: this is meant to run once
// per page lifetime, called from PreviewStage.jsx's
// `useEffect(() => { initPreviewWorkspace(); }, [])`, but React/Vite Fast
// Refresh can remount PreviewStage.jsx (re-running that effect with no
// cleanup) whenever this file's own source changes during a dev session,
// silently attaching duplicate listeners (video timeupdate, play/pause,
// seek bar, and — via initCanvasTransform() — the on-canvas transform
// overlay's pointer handlers) on top of the still-live originals.
let initialized = false;

export function initPreviewWorkspace() {
  if (initialized) return;
  initialized = true;

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
  //
  // `timeupdate` alone is too coarse to drive smooth caption animations: per
  // spec browsers fire it roughly every 150-250ms (far below the ~16.7ms
  // frame budget a 60fps display needs), so a short entrance animation (the
  // default duration is 0.25s — see shared/captionAnimation.js) could get as
  // few as 1-3 redraws across its ENTIRE eased ramp, even though
  // getAnimationTransform's own progress/easing math is perfectly
  // continuous — the redraw SCHEDULING was the bottleneck, not the curve.
  // While the video is actually playing, a requestAnimationFrame loop
  // re-samples previewVideo.currentTime and re-renders every displayed
  // frame instead, so the same continuous animation math gets sampled
  // densely enough to read as real motion. `timeupdate` is kept as-is for
  // the paused-seek case (scrubbing the seek bar/dragging while paused only
  // ever fires `timeupdate`, never a rAF loop) and as a harmless redundant
  // safety net during playback.
  function updatePreviewFrame() {
    syncVideoSubtitles();
    if (videoSeekBar && previewVideo.duration) {
      const percent = (previewVideo.currentTime / previewVideo.duration) * 100;
      videoSeekBar.value = percent;
    }
    if (timeDisplayCurrent) {
      timeDisplayCurrent.textContent = formatTime(previewVideo.currentTime);
    }
  }

  // Dev-only test hook: counts how many times the preview actually redraws,
  // so an automated test can confirm the rAF loop below is sampling at
  // display-frame density during playback instead of timeupdate's coarse
  // ~150-250ms cadence. Never included in a production build (see
  // canvasTransform.js's identical guard).
  if (import.meta.env.DEV) window.__debugPreviewFrameCount = 0;

  let previewLoopRafId = null;
  function stepPreviewLoop() {
    updatePreviewFrame();
    if (import.meta.env.DEV) window.__debugPreviewFrameCount++;
    previewLoopRafId = requestAnimationFrame(stepPreviewLoop);
  }
  function startPreviewLoop() {
    if (previewLoopRafId != null) return;
    previewLoopRafId = requestAnimationFrame(stepPreviewLoop);
  }
  function stopPreviewLoop() {
    if (previewLoopRafId == null) return;
    cancelAnimationFrame(previewLoopRafId);
    previewLoopRafId = null;
  }

  if (previewVideo) {
    previewVideo.addEventListener('timeupdate', updatePreviewFrame);

    previewVideo.addEventListener('play', startPreviewLoop);
    previewVideo.addEventListener('pause', stopPreviewLoop);

    previewVideo.addEventListener('loadedmetadata', () => {
      if (timeDisplayDuration) {
        timeDisplayDuration.textContent = formatTime(previewVideo.duration);
      }
      appState.videoDuration = previewVideo.duration;
    });

    previewVideo.addEventListener('ended', () => {
      stopPreviewLoop();
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
  initCanvasTransform();

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
  // and Rolling Stack branches below (the two modes canDrawCaptionFrame
  // currently supports) re-activate it. Every other return path in this
  // function (demo fallback, Word Mode) leaves it hidden instead of showing
  // stale content from a previous mode.
  const captionsCanvas = document.getElementById('captions-canvas');
  if (captionsCanvas) captionsCanvas.classList.remove('active');
  captionsText.style.visibility = '';
  // Re-shown only by the two graphics-renderer branches below — every other
  // path (demo fallback, Word Mode, non-graphics-renderer CSS fallback)
  // leaves it hidden instead of showing a stale box over unrelated content.
  hideCanvasTransformOverlay();

  const currentTime = previewVideo.currentTime;

  const baseStyleParams = getStyleParams();
  const baseCssConfig = getCSSPreviewFromConfig(baseStyleParams);

  const activeHighlight = baseCssConfig.highlightColor || '#FEF08A';
  const inactiveColor = baseCssConfig.inactiveColor || '#FFFFFF';
  const mode = appState.animationMode || 'karaoke';

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

  // Per-caption transform overrides (see shared/captionTransform.js and
  // src/js/components/canvasTransform.js's "This Caption" scope) only ever
  // affect the phrase currently on screen — resolve them here, ONCE the real
  // active phrase is known, so every branch below (Word Mode, Rolling Stack,
  // Sentence graphics) renders from the SAME merged params the export
  // pipeline (backend/utils/graphicsFrameGenerator.js) already resolves
  // through resolvePhraseParams. Without this, a "This Caption" override
  // updates state correctly but the preview keeps drawing from the
  // unmerged global params, making the override invisible on screen even
  // though it's genuinely stored (and would show up correctly in export).
  const params = resolvePhraseParams(baseStyleParams, activePhrase);
  const cssConfig = params === baseStyleParams ? baseCssConfig : getCSSPreviewFromConfig(params);
  const wordSpacingPx = cssConfig.wordSpacingPx !== undefined ? cssConfig.wordSpacingPx : 4;

  // Word Mode: exactly one transcript word visible at a time, timed to its
  // own Whisper start/end within the already-found active phrase — only
  // reached once real phrase/word data exists (the demo fallback above is
  // shared with Sentence mode and unchanged). Everything else (colors,
  // opacity, shadow, blur, outline, font, position) still comes from the
  // same cssConfig/container styling applyCSSPreviewStyles already applied,
  // exactly like Sentence mode's word spans below — only the "how many
  // words are shown at once, and which text unit drives timing" differs.
  if (appState.captionMode === 'word') {
    // Reuses the SAME sentence-mode graphics renderer as a synthetic
    // "phrase" containing just the one word currently on screen — see
    // shared/captionGraphics.js's canDrawCaptionFrame SCOPE note. This is
    // what gives Word Mode the exact same selection/transform/word-edit/
    // keyword-scope UI as every other mode instead of a separate,
    // unimplemented code path; `activePhrase` (the real, full phrase) is
    // still what's passed to updateCanvasTransformOverlay so "This Caption"/
    // "All Captions" scope keys off the real caption, not the one-word
    // stand-in. The legacy CSS renderer below is now unreachable in practice
    // (canDrawCaptionFrame covers every mode/shadow combo) but stays as a
    // fallback if canDrawCaptionFrame's scope ever narrows again.
    const activeWord = activePhrase.words.find((w) => currentTime >= w.start && currentTime <= w.end);
    if (activeWord && canDrawCaptionFrame(cssConfig) && captionsCanvas) {
      const singleWordPhrase = { words: [activeWord], breakAfterIndices: [], start: activePhrase.start, end: activePhrase.end };
      const box = drawGraphicsCanvasFrame(captionsCanvas, singleWordPhrase, currentTime, cssConfig, params);
      captionsCanvas.classList.add('active');
      captionsText.style.visibility = 'hidden';
      updateCanvasTransformOverlay(box, activePhrase, 'sentence');
    } else {
      renderWordModeCaption(activePhrase, currentTime, cssConfig, captionsText);
    }
    return;
  }

  // Rolling Stack: a compact, bounded composition of up to
  // appState.rollingStackLayerCount stacked chunks (see
  // shared/rollingStack.js's resolveRollingStackWindow — Active-Word
  // Selection). Graphics-renderer path first (see canDrawCaptionFrame's
  // rolling-stack scope note); the legacy CSS renderer branch stays as a
  // fallback only.
  if (appState.captionMode === 'rolling-stack') {
    if (canDrawCaptionFrame(cssConfig) && captionsCanvas) {
      const chunks = buildRollingStackChunks(activePhrase.words);
      const windowChunks = resolveRollingStackWindow(chunks, currentTime, appState.rollingStackLayerCount);
      if (windowChunks.length) {
        const box = drawGraphicsRollingStackCanvasFrame(captionsCanvas, windowChunks, currentTime, cssConfig, params);
        captionsCanvas.classList.add('active');
        updateCanvasTransformOverlay(box, activePhrase, 'rolling-stack');
      }
      captionsText.style.visibility = 'hidden';
    } else {
      renderRollingStackCaption(activePhrase, currentTime, cssConfig, captionsText);
    }
    return;
  }

  // Graphics-renderer path — live for every preset now, including Unified
  // Shadow (see isGraphicsRendererDefault's doc comment); the CSS/DOM
  // rendering below stays as a fallback only.
  const useGraphicsRenderer = isGraphicsRendererDefault(cssConfig);
  if (useGraphicsRenderer && captionsCanvas) {
    const box = drawGraphicsCanvasFrame(captionsCanvas, activePhrase, currentTime, cssConfig, params);
    captionsCanvas.classList.add('active');
    captionsText.style.visibility = 'hidden';
    updateCanvasTransformOverlay(box, activePhrase, 'sentence');
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
