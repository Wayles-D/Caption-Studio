/**
 * Top-level application shell (migration plan's Stage 4).
 *
 * Owns the single React root and the upload/drag-drop/demo-video/regenerate
 * orchestration that used to live as imperative getElementById + classList
 * code in main.js. Toolbar/SidebarInspector/PreviewStage/RightInspector are
 * now plain child components instead of four separately createRoot()-mounted
 * subtrees — each still reads/writes the same src/js/state.js appState (via
 * updateState/appState) and the same Zustand stores under the hood, so
 * behavior is unchanged; only who owns the DOM changed.
 *
 * The upload view's three states (upload / processing / video) and the
 * processing title are now React state instead of manual classList/
 * textContent mutation — everything downstream of "a video is loaded"
 * (transcript sync, style edits, canvas rendering, on-canvas transforms)
 * is still the untouched appState + preview.js/canvasTransform.js pipeline
 * this state simply gates visibility for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { appState, updateState, DEFAULT_DEMO_VIDEO_URL, getStyleParams } from './js/state.js';
import { fetchJson, describeFetchError } from './js/utils/apiRequest.js';
import { collectEditedWords } from './js/components/transcriptEditorState.js';
import { applySemanticEvents } from './js/components/audioTimeline.js';
import * as audioTimelineApi from './js/components/audioTimeline.js';
import { Toolbar } from './components/Toolbar.jsx';
import { SidebarInspector } from './components/SidebarInspector.jsx';
import { PreviewStage } from './components/PreviewStage.jsx';
import { RightInspector } from './components/RightInspector.jsx';
import { AudioInspector } from './components/AudioInspector.jsx';
import { TimelinePanel } from './components/TimelinePanel.jsx';
import { useClickOutside } from './hooks/useClickOutside.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

// On every screen size — not just phones/tablets — both side inspectors
// live in this CapCut/Premiere-style bottom dock instead of as permanent
// columns: every individual tool section gets its own icon in a slim,
// always-visible bottom toolbar that scrolls/swipes horizontally, and
// tapping one opens a bottom sheet above itself showing just that section's
// controls (full-size, never shrunk to fit). The only thing left in a
// sidebar-shaped position is the preview itself, full-width/full-height —
// matching how these apps keep the canvas as the one permanent panel and
// dock every properties/effects panel at the bottom instead. `group` picks
// which component renders it, `key` is passed straight through as that
// component's sectionFilter prop (see SidebarInspector.SIDEBAR_SECTION_KEYS /
// RightInspector.RIGHT_INSPECTOR_SECTION_KEYS).
const MOBILE_TOOLS = [
  {
    key: 'typography', label: 'Text', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
  },
  {
    key: 'style-colors', label: 'Style', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><circle cx="12" cy="12" r="9" /><path d="M12 3a13 13 0 000 18 13 13 0 000-18" /></svg>
  },
  {
    key: 'animation-mode', label: 'Animate', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="w-5 h-5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
  },
  {
    key: 'caption-animation', label: 'Entrance', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
  },
  {
    key: 'position-spacing', label: 'Position', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
  },
  {
    key: 'ai-keywords', label: 'Keywords', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="w-5 h-5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
  },
  {
    key: 'keyword-style', label: 'Kw Style', group: 'caption',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><circle cx="11" cy="11" r="2" /></svg>
  },
  {
    // Sound effects + audio tracks. One tool, because they are one panel
    // (see AudioInspector.jsx) — the two CONCEPTS stay separate everywhere it
    // matters: separate lanes on the timeline, separate lists here, separate
    // "+ Sound" / "+ Audio" actions.
    key: 'audio', label: 'Audio', group: 'audio',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
  },
  {
    key: 'video-info', label: 'Video', group: 'video',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></svg>
  },
  {
    // On desktop (see isDesktop below) this specific tool's click routes to
    // the desktop side panel instead of the bottom sheet every other tool
    // uses — see DESKTOP_SIDE_PANEL_TOOL_KEYS.
    key: 'transcript', label: 'Transcript', group: 'video',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M4 6h16M4 12h10M4 18h7" /></svg>
  }
];

// Bottom-toolbar tool keys that, on desktop, open the right-side panel
// (shared with the timeline's own "Advanced" button) instead of the bottom
// sheet every other tool uses — there's finally enough width beside the
// preview for a real contextual side panel there, matching how Premiere/
// DaVinci/CapCut Desktop keep certain properties panels docked to a side
// rather than as a bottom sheet. Below the desktop breakpoint this key
// behaves exactly like every other MOBILE_TOOLS entry (bottom sheet).
const DESKTOP_SIDE_PANEL_TOOL_KEYS = new Set(['video-info', 'transcript']);

// The desktop side panel's default/home content — always visible (an
// anchored sidebar, like the app's original layout), showing Video
// Inspector until the user opens Advanced or Transcript, which TEMPORARILY
// replace it there; closing either reverts to this rather than the panel
// itself disappearing.
const DESKTOP_SIDE_PANEL_DEFAULT = 'video-info';

const MOBILE_TOOLBAR_HEIGHT = 80; // px — kept in sync with the `h-20` toolbar below
const TIMELINE_HEIGHT = 272; // px — kept in sync with TimelinePanel.jsx's `h-[272px]` (grew to fit the SFX + Audio lanes)
const DESKTOP_BREAKPOINT_QUERY = '(min-width: 1024px)'; // Tailwind's `lg`

// Bottom-sheet resize: the sheet used to always render at `max-h-[65vh]`
// content-fit — fine for a short panel, but a content-heavy one (Audio, with
// its own Sound Effects + Audio Tracks lists) reliably grows tall enough to
// bury the preview behind it, with no way to see what you're editing while
// the sheet is open. DEFAULT_HEIGHT_VH is deliberately smaller than the old
// static cap so the preview stays visible OUT OF THE BOX; the grip handle
// (previously a purely decorative pill — see the sheet JSX) is now a real
// drag target between MIN_HEIGHT and MAX_HEIGHT_VH, and the dragged-to
// height is kept in `sheetHeight` state (below) rather than reset back to
// the default on every open/close or tool switch, so a size the user picks
// "sticks" for the rest of the session, matching how a real native bottom
// sheet's resize handle behaves.
const SHEET_DEFAULT_HEIGHT_VH = 34;
const SHEET_MIN_HEIGHT_PX = 160;
const SHEET_MAX_HEIGHT_VH = 85;

export function App() {
  const videoFileInputRef = useRef(null);
  // null = no sheet open (matches CapCut's default: full preview, nothing
  // docked open until a tool icon is tapped). Tapping the already-active
  // icon again closes its sheet.
  const [mobileActivePanel, setMobileActivePanel] = useState(null);
  // Excluded from the "outside" check below so clicking a DIFFERENT tool
  // icon while a sheet is open just switches sheets (that button's own
  // onClick) instead of first closing via the outside-click handler and
  // then immediately reopening.
  const mobileSheetRef = useRef(null);
  const mobileToolbarRef = useRef(null);

  const toggleMobilePanel = useCallback((key) => {
    setMobileActivePanel((current) => (current === key ? null : key));
  }, []);

  const closeMobilePanel = useCallback(() => setMobileActivePanel(null), []);

  // Bottom-sheet height: lazy-initialized once from the viewport (a real
  // `useState` initializer, not a render-time computation, so it isn't
  // re-derived — and doesn't fight a user's own drag — on every re-render).
  // Persists across different tools' sheets and across close/reopen, exactly
  // like a native bottom sheet's own resize handle would, until the user
  // drags it again.
  const [sheetHeight, setSheetHeight] = useState(
    () => Math.round(window.innerHeight * (SHEET_DEFAULT_HEIGHT_VH / 100))
  );
  const sheetDragRef = useRef(null); // { startY, startHeight } while a drag is in progress; null otherwise

  const clampSheetHeight = useCallback((px) => {
    const max = window.innerHeight * (SHEET_MAX_HEIGHT_VH / 100);
    return Math.min(max, Math.max(SHEET_MIN_HEIGHT_PX, px));
  }, []);

  const handleSheetGripPointerMove = useCallback((e) => {
    const drag = sheetDragRef.current;
    if (!drag) return;
    // Dragging the grip UP (smaller clientY) should grow the sheet — the
    // sheet's own height grows opposite to pointer movement since it's
    // anchored to the bottom of the screen, hence the negated delta.
    setSheetHeight(clampSheetHeight(drag.startHeight + (drag.startY - e.clientY)));
  }, [clampSheetHeight]);

  const handleSheetGripPointerUp = useCallback((e) => {
    sheetDragRef.current = null;
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', handleSheetGripPointerMove);
    window.removeEventListener('pointerup', handleSheetGripPointerUp);
  }, [handleSheetGripPointerMove]);

  const handleSheetGripPointerDown = useCallback((e) => {
    // Not draggable-until-registered as a real pointer capture: using plain
    // window listeners (rather than setPointerCapture on the handle itself)
    // so the drag keeps tracking correctly even if the pointer briefly
    // leaves the small grip hit-area during a fast drag.
    sheetDragRef.current = { startY: e.clientY, startHeight: sheetHeight };
    document.body.style.userSelect = 'none'; // prevents text selection while dragging
    window.addEventListener('pointermove', handleSheetGripPointerMove);
    window.addEventListener('pointerup', handleSheetGripPointerUp);
    e.preventDefault();
  }, [sheetHeight, handleSheetGripPointerMove, handleSheetGripPointerUp]);

  useClickOutside(
    [mobileSheetRef, mobileToolbarRef],
    closeMobilePanel,
    mobileActivePanel !== null
  );

  // Desktop-only right side panel — an always-visible anchored sidebar
  // (like the app's original layout), not a toggle-it-open-and-it-vanishes
  // panel. 'video-info' | 'advanced' | 'transcript' — defaults to Video
  // Inspector and never goes back to "nothing"; opening Advanced (the
  // timeline's own button — see TimelinePanel's isAdvancedOpenGetter/
  // onAdvancedToggle props) or Transcript (the bottom toolbar tool — see
  // DESKTOP_SIDE_PANEL_TOOL_KEYS) temporarily REPLACES what's shown there,
  // and closing either reverts to Video Inspector rather than hiding the
  // panel itself.
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const [desktopSidePanel, setDesktopSidePanel] = useState(DESKTOP_SIDE_PANEL_DEFAULT);
  const desktopSidePanelElRef = useRef(null);
  const advancedPanelBodyRef = useRef(null);
  const timelinePanelRef = useRef(null);
  // Play/Undo/Redo relocate here (see timelinePanel.js's
  // relocatePlaybackRow) on mobile/tablet: a thin bar sitting directly
  // above the timeline's own bordered box, rather than inside its header
  // where they'd be too many controls to fit on a phone width. Desktop
  // never uses this — those controls stay put in the timeline header there.
  const mobilePlaybackRowRef = useRef(null);

  // timelinePanel.js's Advanced button is DOM-driven (not React) and keeps
  // its own long-lived rAF loop running rather than re-subscribing on every
  // render (see its own doc comments) — these refs let its stable-identity
  // getter callbacks (below) always read the CURRENT isDesktop/
  // desktopSidePanel value without needing TimelinePanel to re-mount
  // whenever either changes.
  const isDesktopRef = useRef(isDesktop);
  useEffect(() => { isDesktopRef.current = isDesktop; }, [isDesktop]);

  // Stray file drops must never navigate the page away.
  //
  // A browser's DEFAULT action for a file dropped on a document is to OPEN
  // that file, replacing the SPA — which reads as "the whole app restarted and
  // everything got deleted". The upload dropzone (PreviewStage.jsx) does call
  // preventDefault, but it lives inside `.view-state`, which is
  // `display: none` once a video is loaded. So in the editor there was no
  // guard at all: importing audio via the file picker worked, while DRAGGING
  // the same file in destroyed the session — the same action with two
  // completely different outcomes, which is why it looked intermittent.
  //
  // This only suppresses the navigation. It does not stop propagation, so the
  // real dropzone still receives and handles its own drops exactly as before.
  useEffect(() => {
    const swallowStrayDrop = (e) => e.preventDefault();
    window.addEventListener("dragover", swallowStrayDrop);
    window.addEventListener("drop", swallowStrayDrop);
    return () => {
      window.removeEventListener("dragover", swallowStrayDrop);
      window.removeEventListener("drop", swallowStrayDrop);
    };
  }, []);
  const desktopSidePanelRef = useRef(desktopSidePanel);
  useEffect(() => { desktopSidePanelRef.current = desktopSidePanel; }, [desktopSidePanel]);

  const toggleDesktopSidePanel = useCallback((key) => {
    setDesktopSidePanel((current) => (current === key ? DESKTOP_SIDE_PANEL_DEFAULT : key));
  }, []);

  // "Close" now means "revert to the home view", not "hide the sidebar" —
  // the sidebar itself is always visible on desktop.
  const closeDesktopSidePanel = useCallback(() => setDesktopSidePanel(DESKTOP_SIDE_PANEL_DEFAULT), []);

  useClickOutside(
    [desktopSidePanelElRef, timelinePanelRef, mobileToolbarRef],
    closeDesktopSidePanel,
    isDesktop && desktopSidePanel !== DESKTOP_SIDE_PANEL_DEFAULT
  );

  const isDesktopGetter = useCallback(() => isDesktopRef.current, []);
  const getAdvancedContainer = useCallback(() => advancedPanelBodyRef.current, []);
  const isAdvancedOpenGetter = useCallback(() => desktopSidePanelRef.current === 'advanced', []);
  const onAdvancedToggle = useCallback(() => toggleDesktopSidePanel('advanced'), [toggleDesktopSidePanel]);
  const getPlaybackRowContainer = useCallback(() => mobilePlaybackRowRef.current, []);

  // Crossing the desktop breakpoint while a NON-default bottom-sheet tool
  // (Transcript) is open moves it to the sidebar instead of leaving it open
  // in a spot that no longer makes sense; leaving desktop resets the
  // sidebar back to its home view (its value is irrelevant while
  // unmounted, but starting fresh avoids re-entering desktop later on
  // whatever Advanced/Transcript state happened to be active last).
  useEffect(() => {
    if (isDesktop) {
      if (mobileActivePanel && DESKTOP_SIDE_PANEL_TOOL_KEYS.has(mobileActivePanel)) {
        setMobileActivePanel(null);
        setDesktopSidePanel(mobileActivePanel);
      }
    } else if (desktopSidePanel !== DESKTOP_SIDE_PANEL_DEFAULT) {
      setDesktopSidePanel(DESKTOP_SIDE_PANEL_DEFAULT);
    }
  }, [isDesktop, mobileActivePanel, desktopSidePanel]);

  // Dev-only test hook: lets automated (Playwright) tests inject deterministic
  // phrases/words without depending on the real Whisper transcription result
  // or an externally-hosted demo video — never included in a production build
  // (import.meta.env.DEV is statically false there, so bundlers dead-code-
  // eliminate this whole block).
  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__appState = appState;
      window.__updateState = updateState;
      // The audio timeline's own write API (see
      // src/js/components/audioTimeline.js), so e2e tests can drive the
      // semantic-event -> sound mapping without a live backend or a real
      // model call — the same reason __updateState exists for transcripts.
      window.__audioTimeline = audioTimelineApi;
      // The exact snapshot the export is driven from — lets a test assert
      // preview/export parity on the payload itself rather than inferring it.
      window.__getStyleParams = getStyleParams;
    }
  }, []);

  const [viewState, setViewState] = useState('upload'); // 'upload' | 'processing' | 'video'
  const [processingTitle, setProcessingTitle] = useState('Transcribing Audio...');
  const [videoSrc, setVideoSrc] = useState(undefined);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);

  // Matches the original showToast(message) exactly: no debounce/clearTimeout
  // guard against overlapping calls — a second call within 2.5s of the first
  // still overwrites the text and re-shows it, but the FIRST call's own timer
  // still fires on schedule and can hide the toast early. Preserved as-is
  // rather than "fixed", per the migration plan's zero-behavior-change rule.
  const showToast = useCallback((message) => {
    setToastMessage(message);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2500);
  }, []);

  const handleFileSelected = useCallback(async (file) => {
    if (!file.type.startsWith('video/')) {
      showToast('Please select a valid video file.');
      return;
    }

    updateState({ uploadedFile: file, isProcessing: true }, { recordHistory: false });
    setViewState('processing');

    const formData = new FormData();
    formData.append('video', file);
    Object.entries(getStyleParams()).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      // Multipart form fields are strings, so a structured value (the audio
      // timeline, caption transforms, the video transform) has to be JSON —
      // `.toString()` on an object yields the literal "[object Object]", which
      // the backend can only discard. The /regenerate path sends real JSON and
      // is unaffected either way; this makes the two transports carry the same
      // information instead of one silently losing it.
      formData.append(key, typeof value === 'object' ? JSON.stringify(value) : value.toString());
    });

    try {
      const data = await fetchJson(`${API_BASE_URL}/api/upload`, {
        method: 'POST',
        body: formData
      });
      console.log('Upload success response:', data);

      updateState({
        baseName: data.baseName,
        words: data.words || [],
        phrases: data.phrases || [],
        renderedVideoPath: data.renderedVideoPath,
        isProcessing: false,
        isLoaded: true
      }, { recordHistory: false });

      setVideoSrc(URL.createObjectURL(file));
      setViewState('video');

      // The SAME analysis pass that tagged the keywords also reported what the
      // speech is structurally doing (lists, reveals, transitions) and where a
      // visual would help. Semantic events are handed to the editor's own
      // mapping layer, which decides which sound — if any — each one means and
      // places it at the transcript's own word timing. Honours the Auto Sound
      // Effects switch: with it off, the analysis is still stored and
      // browsable, nothing is placed.
      updateState({ visualSuggestions: data.visualSuggestions || [] }, { recordHistory: false });
      const placed = applySemanticEvents(data.contentEvents || []);

      showToast(placed.length > 0
        ? `Subtitles generated — and ${placed.length} sound effect${placed.length === 1 ? '' : 's'} placed from the transcript.`
        : 'Subtitles generated successfully!');
      // Transcript chips rebuild reactively inside RightInspector's own
      // effect (keyed on the `words` field this updateState call just set).
    } catch (err) {
      console.error('Upload Error:', err);
      setViewState('upload');
      updateState({ isProcessing: false }, { recordHistory: false });
      showToast(`Upload failed: ${describeFetchError(err)}`);
    }
  }, [showToast]);

  const handleDemoVideo = useCallback(() => {
    updateState({
      uploadedFile: { name: 'Demo Waterfall Video.mp4', demo: true },
      isProcessing: false,
      isLoaded: true,
      baseName: 'demo',
      words: [
        { word: "WELCOME", start: 0.0, end: 0.6 },
        { word: "TO", start: 0.65, end: 0.9 },
        { word: "CAPTION", start: 0.95, end: 1.5 },
        { word: "STUDIO", start: 1.55, end: 2.2 }
      ]
    }, { recordHistory: false });

    setVideoSrc(DEFAULT_DEMO_VIDEO_URL);
    setViewState('video');
    showToast('Loaded demo video.');
  }, [showToast]);

  /**
   * THE single render step — POSTs the current canonical editor snapshot
   * (getStyleParams()/collectEditedWords(), the SAME state the live preview
   * already renders from) to the backend and updates appState.renderedVideoPath
   * with the result. This is the ONLY place that talks to
   * /api/upload/regenerate; both "Generate Video" (an explicit pre-render/
   * preview-of-export-readiness action) and the Download button (below) call
   * this directly rather than each keeping their own copy of this logic —
   * one canonical path from "current editor state" to "server-rendered file."
   *
   * Returns `{ ok, renderedWithEffects }` — `ok` false on failure/no-op
   * (nothing to render), callers decide what to do next (Generate just
   * reports success; Download only proceeds to serve the file when `ok` is
   * true, so a failed render can never result in a stale/wrong file being
   * downloaded instead). `renderedWithEffects` is false when the backend
   * silently fell back to the ASS/libass pipeline (see
   * backend/utils/graphicsExport.js) — that fallback can't reproduce
   * caption transform keyframes (position/rotation/scale) or text blend
   * mode at all, so the export would otherwise look "broken" with zero
   * indication why. Returned (not shown as its own toast here) so callers
   * can fold the warning into whatever toast they show LAST — showToast has
   * no queue, so a toast shown here would just get clobbered a moment later
   * by triggerRegeneration's/handleDownloadVideo's own follow-up toast.
   */
  const renderCurrentEditsToServer = useCallback(async () => {
    if (!appState.baseName || appState.isProcessing) {
      showToast("Please upload a video first.");
      return { ok: false, renderedWithEffects: true };
    }

    const editedWords = collectEditedWords(appState);
    if (editedWords.length === 0) {
      showToast("No transcript words to render.");
      return { ok: false, renderedWithEffects: true };
    }

    updateState({ isProcessing: true }, { recordHistory: false });
    setProcessingTitle("Re-rendering video with custom captions...");
    setViewState('processing');

    try {
      const result = await fetchJson(`${API_BASE_URL}/api/upload/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseName: appState.baseName,
          words: editedWords,
          styles: getStyleParams()
        })
      });
      console.log('Regeneration result:', result);

      updateState({
        renderedVideoPath: result.renderedVideoPath,
        phrases: result.phrases || appState.phrases,
        isProcessing: false
      }, { recordHistory: false });

      setViewState('video');
      if (result.renderedWithEffects === false) {
        // The backend now reports WHY it fell back (see graphicsExport.js's
        // recordFailure). Logged in full because this is the one place the
        // real cause is visible without server console access.
        console.error('[Export] Advanced renderer fell back to ASS:', result.graphicsFailureReason);
      }
      return { ok: true, renderedWithEffects: result.renderedWithEffects !== false, graphicsFailureReason: result.graphicsFailureReason || null };
    } catch (err) {
      console.error("Regeneration Error:", err);
      setViewState('video');
      updateState({ isProcessing: false }, { recordHistory: false });
      showToast(`Render failed: ${describeFetchError(err)}`);
      return { ok: false, renderedWithEffects: true };
    }
  }, [showToast]);

  const triggerRegeneration = useCallback(async () => {
    showToast("Re-rendering captioned video...");
    const { ok, renderedWithEffects, graphicsFailureReason } = await renderCurrentEditsToServer();
    if (ok) {
      showToast(renderedWithEffects
        ? "Render complete! Ready to download."
        : `Rendered, but without some caption effects (position/rotation/blend) — the advanced renderer couldn't run this time.${graphicsFailureReason ? ` Reason: ${graphicsFailureReason.stage} — ${graphicsFailureReason.message}` : ""}`);
    }
  }, [renderCurrentEditsToServer, showToast]);

  /**
   * Download used to just serve whatever `appState.renderedVideoPath`
   * already pointed at — a file from whenever "Generate Video" was last
   * clicked (or never, if it hadn't been). Any edit made AFTER that render
   * (a Rolling Stack switch, a keyword style, an animation, a keyframe, a
   * video transform — all of which only ever touched the CLIENT-SIDE
   * preview) had no way to reach the downloaded file, so Download could
   * silently serve an arbitrarily stale — or entirely default — render
   * while the on-screen preview looked completely correct. Download now
   * ALWAYS renders the CURRENT editor state fresh (via the same
   * renderCurrentEditsToServer() "Generate Video" already uses) immediately
   * before serving the file, so there is no longer a path from clicking
   * Download to receiving anything other than what the preview shows.
   */
  const handleDownloadVideo = useCallback(async () => {
    // The "Use Demo Video" shortcut never uploads anything to the backend
    // (see handleDemoVideo) — there is no server-side job to re-render, so
    // this is the one case where "download current edits" is genuinely not
    // possible server-side. Preserve the previous (honest, explicitly
    // labeled) behavior of downloading the raw, unedited sample clip rather
    // than silently pretending it reflects the session's edits.
    if (appState.uploadedFile?.demo) {
      if (videoSrc) {
        const dlLink = document.createElement("a");
        dlLink.href = videoSrc;
        dlLink.download = "demo_video.mp4";
        document.body.appendChild(dlLink);
        dlLink.click();
        document.body.removeChild(dlLink);
        showToast("Downloaded the raw demo clip — demo sessions aren't rendered on the server, so caption/animation/transform edits aren't included. Upload a real video to export your edits.");
      }
      return;
    }

    showToast("Rendering your latest edits before download...");
    const { ok, renderedWithEffects, graphicsFailureReason } = await renderCurrentEditsToServer();
    if (!ok || !appState.renderedVideoPath) return;

    // Cache-bust: the backend writes every regenerate to the SAME
    // deterministic filename (`${baseName}_captioned.mp4` — see
    // uploadController.js), so this exact URL was very likely already
    // fetched earlier in the session (e.g. a prior download, or the initial
    // upload's own first render). Without a query param forcing it to be
    // treated as a distinct resource, the browser can serve its cached copy
    // of the OLD render instead of fetching the just-regenerated file —
    // invisible for edits the cached copy already reflected, but exactly
    // reproduces "the download keeps showing an old style/font choice" for
    // any edit made after that copy was cached.
    const videoUrl = `${API_BASE_URL}${appState.renderedVideoPath}?t=${Date.now()}`;
    const dlLink = document.createElement("a");
    dlLink.href = videoUrl;
    dlLink.download = appState.renderedVideoPath.split('/').pop();
    document.body.appendChild(dlLink);
    dlLink.click();
    document.body.removeChild(dlLink);
    showToast(renderedWithEffects
      ? "Download started!"
      : `Download started — but without some caption effects (position/rotation/blend); the advanced renderer couldn't run this time.${graphicsFailureReason ? ` Reason: ${graphicsFailureReason.stage} — ${graphicsFailureReason.message}` : ""}`);
  }, [renderCurrentEditsToServer, videoSrc, showToast]);

  return (
    <>
      <input
        type="file"
        id="video-file-input"
        ref={videoFileInputRef}
        accept="video/mp4,video/x-m4v,video/quicktime,video/webm"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files.length > 0) handleFileSelected(e.target.files[0]);
        }}
      />

      <header className="h-14 w-full bg-[var(--bg-toolbar)] backdrop-blur-lg border-b border-[var(--border-color)] flex items-center justify-between px-5 z-[100] relative">
        <Toolbar onExportVideo={() => handleDownloadVideo()} />
      </header>

      {/* Preview above, TIMELINE below — the timeline is a first-class
          editing surface (see src/components/TimelinePanel.jsx), not
          something tucked inside the canvas or a sidebar panel, so it gets
          its own full-width row. Both former side columns are gone: the
          preview is the one permanent panel, full width, exactly like the
          canvas in other editing apps — everything else docks at the
          bottom instead (see the sheet/toolbar below). `pb-20` reserves
          room for the fixed bottom toolbar (h-20 below) so it never
          overlaps the timeline. */}
      <div className="flex flex-col h-[calc(100vh-56px)] w-screen overflow-hidden pb-20">
        {/* min-h-0 overrides the flex item's default min-height:auto, which
            otherwise refuses to shrink below the phone-frame's natural
            586px content size and silently overflows past the timeline
            panel below it (confirmed during testing — the phone-frame's
            bottom resize/rotate handles landed on top of the timeline
            instead of the video). Paired with .phone-frame's own
            max-height:100% (see style.css), this lets the preview shrink
            to whatever vertical space is actually available. */}
        <main className="flex-1 bg-[radial-gradient(circle_at_center,rgba(30,41,59,0.3)_0%,rgba(8,12,20,1)_100%)] flex flex-col items-center justify-center relative p-5 min-h-0 overflow-hidden">
          <PreviewStage
            viewState={viewState}
            processingTitle={processingTitle}
            videoSrc={videoSrc}
            onSelectFileClick={() => videoFileInputRef.current?.click()}
            onUseDemo={() => handleDemoVideo()}
            onFilesDropped={(file) => handleFileSelected(file)}
          />
        </main>

        {/* Play/Undo/Redo land here on mobile/tablet — a thin bar sitting
            directly ON the timeline (immediately above its bordered box),
            not inside it. Empty on desktop; timelinePanel.js's
            relocatePlaybackRow leaves those controls in its own header
            there instead (see getPlaybackRowContainer below) and this div
            simply renders nothing. */}
        <div
          ref={mobilePlaybackRowRef}
          className="hidden max-lg:flex items-center px-3 py-1.5 bg-[var(--bg-toolbar)] border-t border-[var(--border-color)] empty:hidden"
        />

        <TimelinePanel
          containerRef={timelinePanelRef}
          isDesktopGetter={isDesktopGetter}
          getAdvancedContainer={getAdvancedContainer}
          getPlaybackRowContainer={getPlaybackRowContainer}
          isAdvancedOpenGetter={isAdvancedOpenGetter}
          onAdvancedToggle={onAdvancedToggle}
        />
      </div>

      {/* Desktop-only right side panel — an always-visible anchored sidebar
          (Video Inspector by default; Advanced/Transcript temporarily take
          over, then it reverts). Spans only the PREVIEW's height (top-14
          down to just above the timeline), not the full column, so it sits
          beside the preview the way a real sidebar would rather than
          covering the timeline's own header controls (including the very
          "Advanced" button that opens one of its views). Gated on
          `isDesktop` itself (not just CSS) — the mobile bottom sheet mounts
          its OWN <RightInspector sectionFilter="transcript"/"video-info">
          with the same internal DOM ids, so both must never be mounted at
          once. Within that, the panel div and all three content blocks stay
          permanently mounted (only `display` changes) so
          timelinePanel.js's Advanced fields have a stable container to
          relocate into and the transcript word-chips/video info don't get
          rebuilt every time the view switches. */}
      {isDesktop && (
        <div
          ref={desktopSidePanelElRef}
          className="flex flex-col fixed top-14 right-0 z-40 w-[340px] bg-[var(--bg-sidebar)] border-l border-[var(--border-color)]"
          style={{ bottom: MOBILE_TOOLBAR_HEIGHT + TIMELINE_HEIGHT }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] shrink-0">
            <span className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
              {desktopSidePanel === 'advanced' ? 'Keyframe Advanced' : desktopSidePanel === 'transcript' ? 'Transcript Editor' : 'Video Inspector'}
            </span>
            {desktopSidePanel !== DESKTOP_SIDE_PANEL_DEFAULT && (
              <button
                type="button"
                onClick={closeDesktopSidePanel}
                aria-label="Back to Video Inspector"
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4.5 h-4.5">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <div className="overflow-y-auto flex-1 p-4" style={{ display: desktopSidePanel === 'video-info' ? 'block' : 'none' }}>
            <RightInspector sectionFilter="video-info" onRegenerateCaptions={() => triggerRegeneration()} />
          </div>
          <div className="overflow-y-auto flex-1 p-4" style={{ display: desktopSidePanel === 'transcript' ? 'block' : 'none' }}>
            <RightInspector sectionFilter="transcript" onRegenerateCaptions={() => triggerRegeneration()} />
          </div>
          {/* Not conditionally rendered — see relocatePrecisionFields() in
              timelinePanel.js, which physically moves the SAME lane input
              elements in here rather than this being separate React-owned
              content. */}
          <div
            ref={advancedPanelBodyRef}
            className="overflow-y-auto flex-1 p-4 flex flex-col gap-4"
            style={{ display: desktopSidePanel === 'advanced' ? 'flex' : 'none' }}
          />
        </div>
      )}

      {/* Bottom sheet — slides up to sit directly above the fixed toolbar,
          centered and width-capped on wide screens rather than stretching
          edge to edge. Tapping the active tool's icon again (or the X here)
          closes it. Height is user-resizable (see sheetHeight/the grip
          handle below) rather than a fixed content-fit max-height, so a
          content-heavy panel (e.g. Audio) defaults to leaving the preview
          visible instead of burying it. */}
      {mobileActivePanel && (() => {
        const tool = MOBILE_TOOLS.find((t) => t.key === mobileActivePanel);
        if (!tool) return null;
        return (
          <div
            ref={mobileSheetRef}
            className="flex flex-col fixed left-0 right-0 z-40 bg-[var(--bg-sidebar)]
              border-t border-[var(--border-color)] rounded-t-2xl shadow-[0_-8px_24px_rgba(0,0,0,0.45)]
              max-w-2xl mx-auto lg:border-x overflow-hidden"
            style={{ bottom: MOBILE_TOOLBAR_HEIGHT, height: sheetHeight }}
          >
            <div
              onPointerDown={handleSheetGripPointerDown}
              className="flex items-center justify-center relative shrink-0 pt-2 pb-1.5 cursor-ns-resize touch-none"
              role="slider"
              aria-label="Resize panel"
              aria-orientation="vertical"
              aria-valuenow={sheetHeight}
              aria-valuemin={SHEET_MIN_HEIGHT_PX}
              aria-valuemax={Math.round(window.innerHeight * (SHEET_MAX_HEIGHT_VH / 100))}
            >
              <div className="w-9 h-1 rounded-full bg-[var(--border-color)]" />
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 shrink-0">
              <span className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wide text-[var(--text-primary)]">
                {tool.icon}
                {tool.label}
              </span>
              <button
                type="button"
                onClick={closeMobilePanel}
                aria-label="Close panel"
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4.5 h-4.5">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0 border-t border-[var(--border-color)]">
              {tool.group === 'caption' ? (
                <SidebarInspector sectionFilter={tool.key} />
              ) : tool.group === 'audio' ? (
                <div className="p-4">
                  <AudioInspector onNotify={showToast} />
                </div>
              ) : (
                <div className="p-4">
                  <RightInspector sectionFilter={tool.key} onRegenerateCaptions={() => triggerRegeneration()} />
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Fixed bottom toolbar — a slim, always-visible icon+label strip, one
          per tool section, on every screen size. overflow-x-auto makes it
          scrollable/swipeable instead of squeezing icons to fit; centered
          via mx-auto once the strip is narrower than the viewport. */}
      <nav
        ref={mobileToolbarRef}
        className="flex fixed bottom-0 left-0 right-0 z-50 h-20 bg-[var(--bg-toolbar)]
          border-t border-[var(--border-color)] overflow-x-auto justify-center items-center"
      >
        <div className="flex h-full items-center gap-2.5 min-w-max mx-auto px-4">
          {MOBILE_TOOLS.map((tool) => {
            // On desktop, a DESKTOP_SIDE_PANEL_TOOL_KEYS tool routes to the
            // right side panel instead of the bottom sheet — see the panel
            // JSX above and the isDesktop breakpoint-migration effect.
            const usesDesktopPanel = isDesktop && DESKTOP_SIDE_PANEL_TOOL_KEYS.has(tool.key);
            const isActive = usesDesktopPanel
              ? desktopSidePanel === tool.key
              : mobileActivePanel === tool.key;
            return (
              <button
                key={tool.key}
                type="button"
                onClick={() => (usesDesktopPanel ? toggleDesktopSidePanel(tool.key) : toggleMobilePanel(tool.key))}
                className={`flex flex-col items-center justify-center gap-1.5 min-w-[68px] px-3.5 py-2.5 rounded-xl
                  bg-black border transition-colors duration-150 text-[10px] font-semibold cursor-pointer
                  hover:border-[var(--accent-color)]
                  [&_svg]:text-[var(--accent-color)]
                  ${isActive
                    ? 'border-[var(--accent-color)] text-[var(--accent-color)]'
                    : 'border-[var(--accent-color)]/40 text-[var(--text-secondary)]'}`}
              >
                {tool.icon}
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div
        id="app-toast"
        className={`fixed bottom-6 right-6 bg-[var(--bg-card)] border border-[var(--accent-color)] text-[var(--text-primary)]
          px-[18px] py-2.5 rounded-[var(--radius-md)] text-[13px] font-semibold shadow-[var(--shadow-md)] pointer-events-none
          transition-all duration-[250ms] [transition-timing-function:cubic-bezier(0.175,0.885,0.32,1.275)] z-[1000]
          ${toastVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}
      >
        {toastMessage}
      </div>
    </>
  );
}
