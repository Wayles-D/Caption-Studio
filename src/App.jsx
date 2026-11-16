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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appState, updateState, subscribe, DEFAULT_DEMO_VIDEO_URL, getStyleParams } from './js/state.js';
import { fetchJson, describeFetchError } from './js/utils/apiRequest.js';
import { collectEditedWords } from './js/components/transcriptEditorState.js';
import { applySemanticEvents } from './js/components/audioTimeline.js';
import * as audioTimelineApi from './js/components/audioTimeline.js';
import * as textElementsApi from './js/components/textElements.js';
import { isTextElementRenderable } from '../shared/textElement.js';
import { startProjectAutosave, restoreSavedProject, startProjectWithVideo, ensureServerHasProjectFiles } from './js/projectPersistence.js';
import * as captionEventsApi from './js/components/captionEvents.js';
import { Toolbar } from './components/Toolbar.jsx';
import { SidebarInspector } from './components/SidebarInspector.jsx';
import { SoundLibraryPanel } from './components/SoundLibraryPanel.jsx';
import { SplashScreen, shouldShowSplash } from './components/SplashScreen.jsx';
import { PreviewStage } from './components/PreviewStage.jsx';
import { RightInspector } from './components/RightInspector.jsx';
import { AudioInspector } from './components/AudioInspector.jsx';
import { WordToolPanel } from './components/WordInspector.jsx';
import { ToolDock } from './components/ToolDock.jsx';
import { ExportDialog } from './components/ExportDialog.jsx';
import { initFollowAlongLayers } from './js/components/tamSegmentation.js';
import { useWorkspaceStore } from './store/workspaceStore.js';
import { ImageInspector } from './components/ImageInspector.jsx';
import { ShapeInspector } from './components/ShapeInspector.jsx';
import { CanvasInspector } from './components/CanvasInspector.jsx';
import { ObjectsInspector } from './components/ObjectsInspector.jsx';
import { LayersPanel } from './components/LayerControls.jsx';
import * as shapeLayersApi from './js/components/shapeLayers.js';
import * as layerStackApi from './js/components/layerStack.js';
import * as compositionApi from './js/components/composition.js';
import * as compositionViewApi from './js/components/compositionView.js';
import * as videoTransformApi from './js/components/videoTransform.js';
import * as rhythmApi from './js/components/rhythm.js';
import * as objectsApi from './js/components/objectDetection.js';
import * as trackingApi from './js/components/objectTracking.js';
import * as objectEffectsApi from './js/components/objectEffects.js';
import * as occlusionApi from './js/components/occlusion.js';
import { exportPayload, startBackgroundRender, backgroundRenderSettled } from './js/backgroundRender.js';
import * as segmentationApi from './js/components/objectSegmentation.js';
import * as tamSegmentationApi from './js/components/tamSegmentation.js';
import * as imageLayersApi from './js/components/imageLayers.js';
import { TextInspector } from './components/TextInspector.jsx';
import { setSelectionOptionsHost, selectionNeedsOptionsPanel, onSelectionChange } from './js/components/canvasTransform.js';
import { initHoverPreview } from './js/hoverPreview.js';
import { videoUploadProblem } from '../shared/uploadLimits.js';
import { followProxy, swapVideoSourceKeepingPlace, cancelProxyWait } from './js/proxyPlayback.js';
import { TimelinePanel, readStoredTimelineHeight } from './components/TimelinePanel.jsx';
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
    key: 'typography', label: 'Text', group: 'caption', section: 'Captions', title: 'Caption text',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
  },
  {
    key: 'style-colors', label: 'Style', group: 'caption', section: 'Captions', title: 'Caption style',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><circle cx="12" cy="12" r="9" /><path d="M12 3a13 13 0 000 18 13 13 0 000-18" /></svg>
  },
  {
    key: 'animation-mode', label: 'Animate', group: 'caption', section: 'Captions', title: 'Word animation',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="w-5 h-5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
  },
  {
    key: 'caption-animation', label: 'Entrance', group: 'caption', section: 'Captions', title: 'Caption entrance',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
  },
  {
    key: 'position-spacing', label: 'Position', group: 'caption', section: 'Captions', title: 'Position & spacing',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
  },
  {
    key: 'ai-keywords', label: 'Keywords', group: 'caption', section: 'Words', title: 'Keywords',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="w-5 h-5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
  },
  {
    key: 'keyword-style', label: 'Highlight', group: 'caption', section: 'Words', title: 'Keyword highlight',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><circle cx="11" cy="11" r="2" /></svg>
  },
  {
    // Per-word styling — the one tool whose panel edits a single selected
    // word rather than the caption as a whole (see WordInspector.jsx).
    key: 'word-style', label: 'Word', group: 'word', section: 'Words', title: 'Word',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M6 20h12" /><path d="M9 4h6" /><path d="M12 4v11" /><rect x="3" y="15" width="7" height="5" rx="1" /></svg>
  },
  {
    // Independent text placed over the video — NOT captions/subtitles, and
    // not tied to the transcript. Its own tool because it is its own kind of
    // timeline object (see shared/textElement.js), even though it renders
    // through the very same engine captions do.
    key: 'text-overlay', label: 'Overlay', group: 'textel', section: 'Add', title: 'Text & Cinematic',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 10h8M8 14h5" /></svg>
  },
  {
    // Pictures over the video (shared/imageLayer.js) — their own tool,
    // because they are their own kind of timeline object.
    key: 'image-layer', label: 'Image', group: 'image', section: 'Add', title: 'Image',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></svg>
  },
  {
    // Generated shapes over the video (shared/shapeLayer.js).
    key: 'shape-layer', label: 'Shape', group: 'shape', section: 'Add', title: 'Shape',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="3" width="10" height="10" rx="1" /><circle cx="16" cy="16" r="5" /></svg>
  },
  {
    // The one layer stack (shared/visualLayers.js): every visual object, top first.
    key: 'layers', label: 'Layers', group: 'layers', section: 'Scene', title: 'Layers',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="m12 3 9 5-9 5-9-5 9-5z" /><path d="m3 13 9 5 9-5" /></svg>
  },
  {
    // The composition (shared/composition.js): the canvas's shape and
    // background, and the video placed and styled inside it.
    key: 'objects', label: 'Objects', group: 'objects', section: 'Scene', title: 'Objects',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><circle cx="12" cy="10" r="2.5" /><path d="M8 17c.6-2.2 2.1-3.3 4-3.3s3.4 1.1 4 3.3" /></svg>
  },
  {
    // The composition (shared/composition.js): the canvas's shape and
    // background, and the video placed and styled inside it.
    key: 'canvas', label: 'Canvas', group: 'canvas', section: 'Scene', title: 'Canvas',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
  },
  {
    // Sound effects + audio tracks. One tool, because they are one panel
    // (see AudioInspector.jsx) — the two CONCEPTS stay separate everywhere it
    // matters: separate lanes on the timeline, separate lists here, separate
    // "+ Sound" / "+ Audio" actions.
    key: 'audio', label: 'Audio', group: 'audio', section: 'Add', title: 'Audio',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
  },
  {
    key: 'video-info', label: 'Video', group: 'video', section: 'Project', title: 'Project',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></svg>
  },
  {
    // On desktop (see isDesktop below) this specific tool's click routes to
    // the desktop side panel instead of the bottom sheet every other tool
    // uses — see DESKTOP_SIDE_PANEL_TOOL_KEYS.
    key: 'transcript', label: 'Transcript', group: 'video', section: 'Project', title: 'Transcript',
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
// 'text-overlay' (the Text / Cinematic panel) lives here too on desktop: it
// is what a selected cinematic interlude or overlay is edited in, and as a
// bottom sheet it covered the very timeline clip being edited.
// 'image-layer' (the Image panel) too, for the same reason.
// Since the redesign that is EVERY tool: on desktop there is one place
// settings appear — the panel on the right — instead of some opening there
// and others as a sheet over the timeline. Below the breakpoint every tool is
// still a bottom sheet.
const DESKTOP_SIDE_PANEL_TOOL_KEYS = new Set(MOBILE_TOOLS.map((t) => t.key));

// The dock's five sections — Captions, Words, Add, Scene, Project — each in
// the order its first tool appears in MOBILE_TOOLS.
const DOCK_SECTIONS = [...MOBILE_TOOLS.reduce((sections, tool) => {
  if (!sections.has(tool.section)) sections.set(tool.section, { name: tool.section, tools: [] });
  sections.get(tool.section).tools.push(tool);
  return sections;
}, new Map()).values()];

// The Captions section's tools (Caption text, Style, Animate, Entrance, Position).
const CAPTION_TOOL_KEYS = new Set(MOBILE_TOOLS.filter((t) => t.section === 'Captions').map((t) => t.key));

const PANEL_TITLES = { advanced: 'Keyframes', ...Object.fromEntries(MOBILE_TOOLS.map((t) => [t.key, t.title])) };

// Desktop panel views that stay mounted and are only shown/hidden (see the
// panel JSX) — every other tool's body mounts while it is open.
const PERMANENT_PANEL_KEYS = new Set(['video-info', 'transcript', 'advanced']);

const PANEL_CLOSE_BTN = `h-8 w-8 grid place-items-center rounded-lg border-0 bg-transparent text-[var(--text-secondary)]
  cursor-pointer transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]`;

// The desktop side panel's default/home content — always visible (an
// anchored sidebar, like the app's original layout), showing Video
// Inspector until the user opens Advanced or Transcript, which TEMPORARILY
// replace it there; closing either reverts to this rather than the panel
// itself disappearing.
const DESKTOP_SIDE_PANEL_DEFAULT = 'video-info';

// The dock's height is responsive (one row from tablet up, tools row + tab
// bar on phones), so it lives in ONE place — the --dock-h custom property in
// style.css — and everything that sits above the dock reads it from there.
const DOCK_HEIGHT = 'var(--dock-h)';
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

/**
 * Text overlays and cinematic interludes exist only in the advanced (graphics)
 * renderer. A render that falls back composites them on in a second pass
 * (see uploadController.js's addTextElementsToFallbackRender); only if THAT
 * failed are they missing, and the message has to say so rather than let the
 * file look complete. Empty when the project has none.
 */
function textLossNote() {
  const els = (appState.textElements || []).filter(isTextElementRenderable);
  if (!els.length) return '';
  const interludes = els.filter((el) => el.kind === 'interlude').length;
  return interludes
    ? ' — and your text overlays and cinematic text are NOT in this file'
    : ' — and your text overlays are NOT in this file';
}

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
  // The top bar — "inside" for every panel's click-outside check (see below).
  const headerRef = useRef(null);

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
    [mobileSheetRef, mobileToolbarRef, headerRef],
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

  // The selection's options (scope, animation, reset, rotation) used to float
  // over the video above whatever was selected, covering the text being edited.
  // On desktop they live in a card at the top of the right-hand panel instead:
  // canvasTransform.js moves its toolbar element into this host, and the card
  // is shown only while the current selection actually has such options.
  // Below the desktop breakpoint there is no side panel, so the toolbar stays
  // where it was.
  // Hovering a style option (a casing, a preset, a mode) previews it on the
  // video; see src/js/hoverPreview.js. Dropdowns do the same through
  // HoverSelect, which draws its own list because a native one cannot be hovered.
  useEffect(() => { initHoverPreview(); }, []);
  // "Behind someone" effects live as long as their layers: stretched or moved
  // on the timeline, the effect follows (see tamSegmentation.js).
  useEffect(() => { initFollowAlongLayers(); }, []);

  // While the video plays, the canvas frame's ring brightens (see
  // .phone-frame.is-playing). Media events don't bubble, so this listens in
  // the capture phase — one listener for whichever <video> is the preview.
  useEffect(() => {
    const sync = (e) => {
      if (e.target?.id !== 'preview-video') return;
      document.querySelector('.phone-frame')?.classList.toggle('is-playing', !e.target.paused && !e.target.ended);
    };
    const events = ['play', 'playing', 'pause', 'ended', 'emptied'];
    events.forEach((t) => document.addEventListener(t, sync, true));
    return () => events.forEach((t) => document.removeEventListener(t, sync, true));
  }, []);

  const selectionOptionsHostRef = useRef(null);
  const [selectionOptionsActive, setSelectionOptionsActive] = useState(false);
  useEffect(() => {
    if (!isDesktop) return undefined;
    setSelectionOptionsHost(selectionOptionsHostRef.current);
    const sync = () => setSelectionOptionsActive(selectionNeedsOptionsPanel());
    sync();
    const stop = onSelectionChange(sync);
    return () => {
      stop();
      setSelectionOptionsHost(null);
      setSelectionOptionsActive(false);
    };
  }, [isDesktop]);
  const [desktopSidePanel, setDesktopSidePanel] = useState(DESKTOP_SIDE_PANEL_DEFAULT);
  const dockSection = useWorkspaceStore((s) => s.dockSection);
  const setDockSection = useWorkspaceStore((s) => s.setDockSection);
  // When a tool's panel opens — from the dock, or because something was
  // selected on the video/timeline — the dock shows that tool's section, so
  // what is open is always in view. An effect because several of those opens
  // come from non-React subscriptions (see the selection effects below).
  const openToolKey = isDesktop ? desktopSidePanel : mobileActivePanel;
  useEffect(() => {
    const tool = MOBILE_TOOLS.find((t) => t.key === openToolKey);
    if (tool && tool.key !== DESKTOP_SIDE_PANEL_DEFAULT) setDockSection(tool.section);
  }, [openToolKey, setDockSection]);

  // The sound library (src/components/SoundLibraryPanel.jsx), opened from the
  // SFX lane's "+". Held here rather than inside timelinePanel.js because
  // that module no longer owns any picker DOM — it just reports the press and
  // React decides whether a panel is showing.
  // The welcome animation. Decided once, from the URL, on the first render
  // — not in an effect, so the editor is never briefly visible before the
  // splash lands on top of it.
  const [splashing, setSplashing] = useState(shouldShowSplash);
  // The timeline's height — the user drags its top edge to slide it up or
  // down (see TimelinePanel.jsx). The side panels end where it begins.
  const [timelineHeight, setTimelineHeight] = useState(readStoredTimelineHeight);

  const [soundLibraryOpen, setSoundLibraryOpen] = useState(false);
  // Which clip the library is REPLACING the sound on, or null when it is
  // simply browsing. One panel, two jobs — see SoundLibraryPanel for why that
  // is one surface rather than two.
  const [soundReplaceTargetId, setSoundReplaceTargetId] = useState(null);
  // Which text element (a cinematic interlude) the next pick is LINKED to, or
  // null when adding an ordinary effect at the playhead.
  const [soundAttachTargetId, setSoundAttachTargetId] = useState(null);
  // A transcript word's ♪: the exact time the next pick lands at (the word's
  // start), or null for "at the playhead". Pinned rather than read from the
  // playhead at pick time, so auditioning by scrubbing can't move it.
  const [soundPlaceAt, setSoundPlaceAt] = useState(null);
  // The whole WORD the ♪ was pressed on, so the library can offer to place
  // one sound per syllable of it (shared/syllables.js). Null when adding at
  // the playhead or to an interlude.
  const [soundPlaceWord, setSoundPlaceWord] = useState(null);
  const closeSoundLibrary = useCallback(() => {
    setSoundLibraryOpen(false);
    setSoundReplaceTargetId(null);
    setSoundAttachTargetId(null);
    setSoundPlaceAt(null);
    setSoundPlaceWord(null);
  }, []);
  const toggleSoundLibrary = useCallback(() => {
    // The "+" always means "add", so re-pressing it while a replace is open
    // drops the target rather than silently replacing with the next pick.
    setSoundReplaceTargetId(null);
    setSoundAttachTargetId(null);
    setSoundPlaceAt(null);
    setSoundLibraryOpen((open) => !open);
  }, []);
  // From the transcript (transcriptEditorState.js): a sound ON one word. The
  // playhead goes to the word's middle — its start is shared with the previous
  // word, which the canvas would show instead — and the pick lands at its start.
  useEffect(() => {
    const onAddSoundAt = (e) => {
      const word = e.detail?.word;
      if (!word || !Number.isFinite(word.start)) return;
      const end = Number.isFinite(word.end) ? Math.max(word.end, word.start) : word.start;
      const video = document.getElementById('preview-video');
      if (video) video.currentTime = word.start + (end - word.start) / 2;
      setSoundReplaceTargetId(null);
      setSoundAttachTargetId(null);
      setSoundPlaceAt(word.start);
      setSoundPlaceWord(word);
      setSoundLibraryOpen(true);
    };
    window.addEventListener('bhynd:add-sound-at', onAddSoundAt);
    return () => window.removeEventListener('bhynd:add-sound-at', onAddSoundAt);
  }, []);
  // An interlude's "+ Sound at start": the playhead goes to its first frame
  // (so what you hear while choosing is in context) and the ordinary library
  // opens; the pick lands at the interlude's start, LINKED to it.
  const openSoundLibraryAt = useCallback((time, attachToTextElementId = null) => {
    const video = document.getElementById('preview-video');
    if (video && Number.isFinite(time)) video.currentTime = time;
    setSoundReplaceTargetId(null);
    setSoundAttachTargetId(attachToTextElementId);
    setSoundPlaceAt(null);
    setSoundPlaceWord(null);
    setSoundLibraryOpen(true);
  }, []);
  const openSoundReplace = useCallback((clipId) => {
    setSoundReplaceTargetId(clipId);
    setSoundPlaceAt(null);
    setSoundLibraryOpen(true);
  }, []);
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

  // Creating or selecting a CINEMATIC TEXT interlude brings its settings up —
  // on desktop, in the side panel beside the preview, where it covers
  // nothing. (Below the desktop breakpoint the panel is a bottom sheet over
  // the timeline, so there it stays one tap away on the Overlay tool rather
  // than opening over the clip you were about to resize.)
  useEffect(() => {
    let lastId = appState.selectedTextElementId;
    return subscribe('selectedTextElementId', () => {
      const id = appState.selectedTextElementId;
      if (id === lastId) return;
      lastId = id;
      // ANY text element, not just a cinematic card: selecting a plain
      // overlay used to open nothing, so its own panel — and with it the
      // layer controls and "Behind a subject" — were unreachable without
      // going hunting, while an image or a shape brought its panel up at
      // once. Same rule for all three now.
      if (id && isDesktopRef.current && desktopSidePanelRef.current !== 'layers') setDesktopSidePanel('text-overlay');
    });
  }, []);

  // Selecting an IMAGE (on the video, on its lane, or by adding one) brings
  // its panel up on desktop — beside the preview, where it covers nothing.
  useEffect(() => {
    let lastId = appState.selectedImageLayerId;
    return subscribe('selectedImageLayerId', () => {
      const id = appState.selectedImageLayerId;
      if (id === lastId) return;
      lastId = id;
      if (id && isDesktopRef.current && desktopSidePanelRef.current !== 'layers') setDesktopSidePanel('image-layer');
    });
  }, []);

  // Selecting a SOUND EFFECT or an AUDIO clip (on its lane) brings up the
  // Audio panel, where it is edited — no hunting for it in the dock.
  useEffect(() => {
    let lastId = appState.selectedAudioClipId;
    return subscribe('selectedAudioClipId', () => {
      const id = appState.selectedAudioClipId;
      if (id === lastId) return;
      lastId = id;
      if (id && isDesktopRef.current && desktopSidePanelRef.current !== 'layers') setDesktopSidePanel('audio');
    });
  }, []);

  // Selecting a CAPTION on its lane brings up the Captions tools. A Captions
  // tool already open (Style, Animate...) stays — that is the one being used;
  // otherwise the first, Caption text.
  useEffect(() => {
    let lastId = appState.selectedCaptionEventId;
    return subscribe('selectedCaptionEventId', () => {
      const id = appState.selectedCaptionEventId;
      if (id === lastId) return;
      lastId = id;
      if (!id || !isDesktopRef.current || desktopSidePanelRef.current === 'layers') return;
      if (CAPTION_TOOL_KEYS.has(desktopSidePanelRef.current)) return;
      setDesktopSidePanel('typography');
    });
  }, []);

  // While the Text & Cinematic panel is open, two more surfaces count as
  // "inside": the sound library it opens itself ("+ Sound at start"), and the
  // video, where you drag and resize the very text you are editing. Pressing
  // either used to close the panel mid-edit. Read lazily: both mount later.
  const soundLibraryElRef = useMemo(() => ({ get current() { return document.getElementById('sound-library-panel'); } }), []);
  const previewElRef = useMemo(() => ({ get current() { return document.getElementById('state-video'); } }), []);
  // Every tool panel counts the video as inside too: picking a word or a
  // caption on the video is how most of them are used.
  // The top bar always counts as inside too: switching light/dark mode (or
  // anything else up there) changes nothing in the panel, so it must not close it.
  const sidePanelInsideRefs = useMemo(() => (desktopSidePanel !== 'advanced' && desktopSidePanel !== 'transcript'
    ? [desktopSidePanelElRef, timelinePanelRef, mobileToolbarRef, soundLibraryElRef, previewElRef, headerRef]
    : [desktopSidePanelElRef, timelinePanelRef, mobileToolbarRef, headerRef]), [desktopSidePanel, soundLibraryElRef, previewElRef]);
  useClickOutside(
    sidePanelInsideRefs,
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
      // Manual captions + text overlays (see shared/textElement.js), exposed
      // for the same reason __audioTimeline is: e2e drives real clip
      // create/move/trim without depending on pointer gymnastics.
      window.__textElements = textElementsApi;
      window.__imageLayers = imageLayersApi;
      window.__shapeLayers = shapeLayersApi;
      window.__layerStack = layerStackApi;
      // The video's own placement (videoTransform.js) rides along: it is the
      // composition object the panel and the on-video gestures move.
      window.__composition = { ...compositionApi, ...compositionViewApi, ...videoTransformApi };
      window.__rhythm = rhythmApi;
      window.__objects = objectsApi;
      window.__tracking = trackingApi;
      window.__objectEffects = objectEffectsApi;
      window.__occlusion = occlusionApi;
      window.__segmentation = segmentationApi;
      window.__tamSegmentation = tamSegmentationApi;
      window.__captionEvents = captionEventsApi;
    }
  }, []);

  const [viewState, setViewState] = useState('upload'); // 'upload' | 'processing' | 'video'

  // REOPEN THE LAST PROJECT. Everything is saved as it changes (see
  // src/js/projectPersistence.js) — the document, the original video and any
  // imported audio — so a reload, a closed tab or a crash reopens exactly
  // where it was. Uploading a new video starts a new project.
  useEffect(() => {
    startProjectAutosave();
    // The export renders in the background as the edits settle (V2.3.2).
    startBackgroundRender(API_BASE_URL);
    let cancelled = false;
    restoreSavedProject({ demoVideoUrl: DEFAULT_DEMO_VIDEO_URL }).then((restored) => {
      if (cancelled || !restored) return;
      setVideoSrc(restored.videoUrl);
      setViewState('video');
      showToast(`Reopened your last project${restored.name ? ' — ' + restored.name : ''}.`);
      // Reloaded before the editing proxy arrived: pick the wait back up, so
      // the reload ends on a playable video instead of the original the
      // browser may not decode (an iPhone's HEVC in Firefox).
      if (restored.awaitingProxy && restored.baseName) followProxyFor(restored.baseName);
    });
    return () => { cancelled = true; };
  }, []);
  const [processingTitle, setProcessingTitle] = useState('Transcribing Audio...');
  const [videoSrc, setVideoSrc] = useState(undefined);
  // The sentence over the video while the editing proxy is being prepared.
  const [previewNotice, setPreviewNotice] = useState(null);
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

  /**
   * Waits for this upload's editing proxy (src/js/proxyPlayback.js) and moves
   * the player onto it the moment it is saved — keeping the playhead where it
   * was. Used straight after an upload and again after a reload that came
   * before the proxy was ready. Editing never waits on it: captions, the
   * transcript and every panel work the whole time.
   */
  const followProxyFor = useCallback((baseName) => {
    setPreviewNotice('Preparing a smooth preview… you can keep editing meanwhile.');
    followProxy(API_BASE_URL, baseName, {
      onStatus: ({ status }) => {
        if (status === 'downloading') setPreviewNotice('Almost ready — loading the preview…');
        if (status === 'not-needed' || status === 'unavailable') setPreviewNotice(null);
        if (status === 'failed') {
          setPreviewNotice(null);
          showToast("The smooth preview couldn't be prepared — the original keeps playing where your browser can.");
        }
      }
    }).then((url) => {
      if (!url) return;
      swapVideoSourceKeepingPlace(document.getElementById('preview-video'), setVideoSrc, url);
      setPreviewNotice(null);
      showToast('Preview ready.');
    });
  }, [showToast]);

  // ...and selecting a SHAPE brings up the Shape panel, the same way.
  useEffect(() => {
    let lastId = appState.selectedShapeLayerId;
    return subscribe('selectedShapeLayerId', () => {
      const id = appState.selectedShapeLayerId;
      if (id === lastId) return;
      lastId = id;
      if (id && isDesktopRef.current && desktopSidePanelRef.current !== 'layers') setDesktopSidePanel('shape-layer');
    });
  }, []);

  // ...and selecting an OBJECT EFFECT (a clip on the Effects lane) brings up
  // the Objects panel, where effects are edited.
  useEffect(() => {
    let lastId = appState.selectedObjectEffectId;
    return subscribe('selectedObjectEffectId', () => {
      const id = appState.selectedObjectEffectId;
      if (id === lastId) return;
      lastId = id;
      if (id && isDesktopRef.current && desktopSidePanelRef.current !== 'layers') setDesktopSidePanel('objects');
    });
  }, []);

  // A failure the editor has to tell the user about from outside React (an
  // image that could not be imported — see imageLayers.js's promptForImageFile).
  useEffect(() => {
    const onToast = (e) => showToast(String(e.detail || ''));
    window.addEventListener('bhynd:toast', onToast);
    return () => window.removeEventListener('bhynd:toast', onToast);
  }, [showToast]);

  // A render PROBLEM is not a toast. When the advanced renderer falls back,
  // the exported file is genuinely missing effects the user asked for
  // (caption transform keyframes, text blend mode, text overlays), and the
  // reason is an ffmpeg error far too long to read — let alone remember — in
  // the 2.5 seconds a toast is on screen. Reported by a user who hit this
  // repeatedly and could only say "there's that error, but I can't remember
  // the error", which is exactly what a disappearing notice produces.
  //
  // So this one stays until it is dismissed, and can be copied in one click.
  const [renderIssue, setRenderIssue] = useState(null);
  const [renderIssueCopied, setRenderIssueCopied] = useState(false);

  const handleFileSelected = useCallback(async (file) => {
    // Checked here, before a byte leaves the machine: the old flow uploaded
    // the whole file and then relayed the server's 413 — with a big video,
    // minutes of waiting to be told no (shared/uploadLimits.js).
    const problem = videoUploadProblem(file);
    if (problem) {
      showToast(problem);
      return;
    }
    // A new video: the previous one's proxy is no longer wanted.
    cancelProxyWait();
    setPreviewNotice(null);

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

      // The handoff from "grouped automatically" to "owned by the user" —
      // see shared/captionEvent.js. `force` because this is a brand new
      // transcript: whatever caption list a previous video left behind
      // addresses word indices that no longer mean anything.
      captionEventsApi.captureCaptionEventsFromPhrases(data.phrases || [], { force: true });

      // A new project: keep THIS video (for reopening later) in place of the last one's.
      // Awaited: it CLEARS the files store before saving this video, and the
      // proxy saved shortly after must not land before that clear.
      await startProjectWithVideo(data.baseName, file);
      setVideoSrc(URL.createObjectURL(file));
      setViewState('video');
      // The browser-safe editing proxy, when this video needs one (an
      // iPhone's HEVC, 4K): playing the original until it arrives, then
      // switching to it in place.
      if (data.proxy && data.proxy.status !== 'not-needed') followProxyFor(data.baseName);

      // The SAME analysis pass that tagged the keywords also reported what the
      // speech is structurally doing (lists, reveals, transitions) and where a
      // visual would help. Semantic events are handed to the editor's own
      // mapping layer, which decides which sound — if any — each one means and
      // places it at the transcript's own word timing. Honours the Auto Sound
      // Effects switch: with it off, the analysis is still stored and
      // browsable, nothing is placed.
      updateState({ visualSuggestions: data.visualSuggestions || [] }, { recordHistory: false });
      const placed = applySemanticEvents(data.contentEvents || []);

      // Three different outcomes that used to share one message. A rate-limited
      // or failed analysis reported "Subtitles generated successfully!" — true,
      // and exactly as quiet as a video with no moments in it, so there was no
      // way to tell "BHYND found nothing" from "BHYND never looked".
      showToast(data.analysisError
        ? `Subtitles generated. Sound effects weren't placed — ${data.analysisError.message}`
        : placed.length > 0
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
  }, [showToast, followProxyFor]);

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

    cancelProxyWait();
    setPreviewNotice(null);
    startProjectWithVideo('demo', null);
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
  const renderCurrentEditsToServer = useCallback(async (exportSize = 'original') => {
    if (!appState.baseName || appState.isProcessing) {
      showToast("Please upload a video first.");
      return { ok: false, renderedWithEffects: true };
    }

    const editedWords = collectEditedWords(appState);
    // A video with no speech can still carry cinematic text and overlays,
    // which only need the render, not a transcript.
    if (editedWords.length === 0 && !(appState.textElements || []).some(isTextElementRenderable)) {
      showToast("No transcript words to render.");
      return { ok: false, renderedWithEffects: true };
    }

    updateState({ isProcessing: true }, { recordHistory: false });
    setProcessingTitle("Re-rendering video with custom captions...");
    setViewState('processing');

    try {
      // A reopened (or long-edited) project: the server may have purged its
      // copy of the video or of imported audio — send them back first.
      await ensureServerHasProjectFiles(API_BASE_URL);
      // The same payload the background render was sent (backgroundRender.js):
      // the server reuses its chunks only for the identical project.
      const result = await fetchJson(`${API_BASE_URL}/api/upload/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await exportPayload(exportSize))
      });
      console.log('Regeneration result:', result);

      updateState({
        renderedVideoPath: result.renderedVideoPath,
        phrases: result.phrases || appState.phrases,
        isProcessing: false
      }, { recordHistory: false });

      // NOT forced: a regenerate returns freshly grouped phrases, and
      // adopting them would silently undo every retime, split and merge the
      // user has made. captureCaptionEventsFromPhrases only fills an EMPTY
      // list, so this seeds captions for a project that predates caption
      // events and is a no-op for one that already has them. The edited list
      // is then re-projected so `phrases` reflects any transcript text edits.
      captionEventsApi.captureCaptionEventsFromPhrases(result.phrases || []);
      captionEventsApi.refreshPhrasesFromCaptionEvents();

      setViewState('video');
      if (result.renderedWithEffects === false) {
        // The backend now reports WHY it fell back (see graphicsExport.js's
        // recordFailure). Logged in full because this is the one place the
        // real cause is visible without server console access.
        console.error('[Export] Advanced renderer fell back to ASS:', result.graphicsFailureReason);
      }
      return { ok: true, renderedWithEffects: result.renderedWithEffects !== false, textElementsRendered: result.textElementsRendered !== false, graphicsFailureReason: result.graphicsFailureReason || null };
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
    const { ok, renderedWithEffects, textElementsRendered, graphicsFailureReason } = await renderCurrentEditsToServer();
    if (ok) {
      if (renderedWithEffects) {
        showToast('Render complete! Ready to download.');
        setRenderIssue(null);
      } else {
        setRenderIssue({
          stage: graphicsFailureReason?.stage || 'render',
          message: (graphicsFailureReason?.message || 'The advanced renderer could not run, and no reason was reported.') + (textElementsRendered ? '' : textLossNote()),
          detail: graphicsFailureReason?.stack || null
        });
        setRenderIssueCopied(false);
      }
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
  const handleDownloadVideo = useCallback(async (exportSize = 'original') => {
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
    const { ok, renderedWithEffects, textElementsRendered, graphicsFailureReason } = await renderCurrentEditsToServer(exportSize);
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
      : `Download started — but without some caption effects (position/rotation/blend)${textElementsRendered ? '' : textLossNote()}; the advanced renderer couldn't run this time.${graphicsFailureReason ? ` Reason: ${graphicsFailureReason.stage} — ${graphicsFailureReason.message}` : ""}`);
  }, [renderCurrentEditsToServer, videoSrc, showToast]);

  // EXPORT SIZE: asked at every export of a video bigger than 1080p (see
  // ExportDialog). The preview may be the 1080p editing proxy, so "bigger"
  // is read from what it is playing: a proxy means the original needed one.
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // The original's {width, height, duration} for the dialog's sizes — null
  // when the server could not say.
  const [exportSource, setExportSource] = useState(null);
  const closeExportDialog = useCallback(() => setExportDialogOpen(false), []);
  const requestExport = useCallback(async () => {
    if (appState.uploadedFile?.demo) { handleDownloadVideo(); return; }
    // The ORIGINAL's size, measured by the server from the uploaded file. The
    // preview cannot be trusted for this: it is often the 1080p proxy — and,
    // in a reopened project, under a blob: address that says nothing about
    // it — which is how a reopened 4K project skipped the question and
    // exported at 4K without asking.
    let info = null;
    try {
      const r = await fetchJson(`${API_BASE_URL}/api/upload/info/${encodeURIComponent(appState.baseName)}`);
      if (r?.width > 0 && r?.height > 0) {
        info = {
          width: r.width,
          height: r.height,
          duration: r.duration || appState.videoDuration || 0,
          // How far the background render has got — only meaningful when it
          // has the project as it is now.
          prerender: backgroundRenderSettled() ? r.prerender || null : null
        };
      }
    } catch { /* unknown: the choice is offered anyway */ }
    // Only a video KNOWN to be 1080p or smaller skips the question.
    if (info && Math.max(info.width, info.height) <= 1920) { handleDownloadVideo('original'); return; }
    setExportSource(info || { width: null, height: null, duration: appState.videoDuration || 0 });
    setExportDialogOpen(true);
  }, [handleDownloadVideo]);

  // One renderer for a tool's panel body, used by both the desktop panel and
  // the phone sheet, so the two can never drift apart.
  const renderToolBody = (tool) => {
    switch (tool.group) {
      case 'caption': return <SidebarInspector sectionFilter={tool.key} />;
      case 'audio': return <div className="p-4"><AudioInspector onNotify={showToast} /></div>;
      case 'textel': return <div className="p-4"><TextInspector onAddSoundAt={openSoundLibraryAt} /></div>;
      case 'image': return <div className="p-4"><ImageInspector /></div>;
      case 'shape': return <div className="p-4"><ShapeInspector /></div>;
      case 'layers': return <div className="p-4"><LayersPanel /></div>;
      case 'canvas': return <div className="p-4"><CanvasInspector /></div>;
      case 'objects': return <div className="p-4"><ObjectsInspector /></div>;
      case 'word': return <div className="p-4"><WordToolPanel /></div>;
      default: return <div className="p-4"><RightInspector sectionFilter={tool.key} onRegenerateCaptions={() => triggerRegeneration()} /></div>;
    }
  };
  const desktopTool = MOBILE_TOOLS.find((t) => t.key === desktopSidePanel) || null;
  // Project info is the desktop panel's resting view, not something opened,
  // so it never reads as an "open" tool.
  const isToolOpen = (key) => (isDesktop
    ? desktopSidePanel === key && key !== DESKTOP_SIDE_PANEL_DEFAULT
    : mobileActivePanel === key);

  return (
    <>
      {/* Last in the tree by z-index, first in the file by importance: the
          app mounts and lays out underneath this the whole time it is up,
          so dismissing it reveals a warm editor rather than starting one. */}
      {splashing && <SplashScreen onDone={() => setSplashing(false)} />}

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

      <header ref={headerRef} className="h-14 w-full bg-[var(--bg-toolbar)] backdrop-blur-xl border-b border-[var(--border-color)] flex items-center justify-between gap-3 px-3 sm:px-4 z-[100] relative">
        <Toolbar onExportVideo={requestExport} />
      </header>

      {/* Preview above, TIMELINE below — the timeline is a first-class
          editing surface (see src/components/TimelinePanel.jsx), not
          something tucked inside the canvas or a sidebar panel, so it gets
          its own full-width row. Both former side columns are gone: the
          preview is the one permanent panel, full width, exactly like the
          canvas in other editing apps — everything else docks at the
          bottom instead (see the sheet/dock below). The bottom padding
          reserves room for the fixed dock (--dock-h) so it never overlaps
          the timeline. */}
      <div className="flex flex-col h-[calc(100dvh-56px)] w-screen overflow-hidden pb-[var(--dock-h)]">
        {/* min-h-0 overrides the flex item's default min-height:auto, which
            otherwise refuses to shrink below the phone-frame's natural
            586px content size and silently overflows past the timeline
            panel below it (confirmed during testing — the phone-frame's
            bottom resize/rotate handles landed on top of the timeline
            instead of the video). Paired with .phone-frame's own
            max-height:100% (see style.css), this lets the preview shrink
            to whatever vertical space is actually available. */}
        {/* The stage: a quiet dotted ground the canvas floats on. On desktop it
            leaves room for the panel on the right, so the video is centred
            in what you can actually see rather than half under the panel. */}
        <main className="bhynd-stage flex-1 flex flex-col items-center justify-center relative p-5 min-h-0 overflow-hidden lg:pr-[380px]">
          <PreviewStage
            viewState={viewState}
            processingTitle={processingTitle}
            videoSrc={videoSrc}
            previewNotice={previewNotice}
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
          onSoundLibraryToggle={toggleSoundLibrary}
          onSoundLibraryClose={closeSoundLibrary}
          onSoundReplace={openSoundReplace}
          height={timelineHeight}
          onHeightChange={setTimelineHeight}
        />
      </div>

      {/* The sound library, on the LEFT — the one side of the workspace that
          was otherwise empty, so it opens without displacing the preview or
          the Video Inspector opposite it. Mirrors that panel's geometry so
          the two read as a pair, and spans only the preview's height so it
          never covers the timeline controls that opened it.

          Mounted only while open (unlike the right panel, which stays mounted
          so relocated DOM has a stable home) — it owns no relocated children,
          and unmounting is what lets its own outside-press and Escape
          listeners come and go with it. */}
      {soundLibraryOpen && (
        <div
          id="sound-library-panel"
          className="flex flex-col fixed top-14 left-0 z-40 w-[300px] bg-[var(--bg-sidebar)] border-r border-[var(--border-color)]"
          style={{ bottom: `calc(${DOCK_HEIGHT} + ${timelineHeight}px)` }}
        >
          <SoundLibraryPanel onClose={closeSoundLibrary} replaceTargetId={soundReplaceTargetId} attachToTextElementId={soundAttachTargetId} placeAt={soundPlaceAt} placeWord={soundPlaceWord} />
        </div>
      )}

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
      {/* The panel on the right (desktop) — the ONE place settings appear.
          Project info is its home view; a tool from the dock, or selecting
          something on the video or timeline, takes it over until closed.
          Spans only the preview's height, so it never covers the timeline's
          own controls. Gated on `isDesktop` itself (not just CSS): the
          phone sheet mounts the same inspectors with the same DOM ids, so
          both must never be mounted at once. Project info, the transcript and
          the keyframe fields stay permanently mounted (only `display`
          changes) — timelinePanel.js relocates live inputs into the keyframe
          body, and the word chips shouldn't be rebuilt on every switch. */}
      {isDesktop && (
        <aside
          ref={desktopSidePanelElRef}
          id="desktop-side-panel"
          aria-label={PANEL_TITLES[desktopSidePanel] || 'Project'}
          className="flex flex-col fixed top-14 right-0 z-40 w-[360px] bg-[var(--bg-sidebar)] border-l border-[var(--border-color)]"
          style={{ bottom: `calc(${DOCK_HEIGHT} + ${timelineHeight}px)` }}
        >
          <div className="flex items-center justify-between gap-2 h-12 pl-4 pr-2 border-b border-[var(--border-color)] shrink-0">
            <span className="flex items-center gap-2 min-w-0 text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {desktopTool && (
                <span className="text-[var(--accent-color)] shrink-0 [&_svg]:w-4 [&_svg]:h-4" aria-hidden="true">{desktopTool.icon}</span>
              )}
              <span className="truncate">{PANEL_TITLES[desktopSidePanel] || 'Project'}</span>
            </span>
            {desktopSidePanel !== DESKTOP_SIDE_PANEL_DEFAULT && (
              <button type="button" onClick={closeDesktopSidePanel} aria-label="Close panel" title="Close (back to Project)" className={PANEL_CLOSE_BTN}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {/* Where the selected word's options appear (see the effect above). Always
              mounted, so the toolbar always has a home to be moved into; only
              its visibility follows the selection. */}
          <div
            ref={selectionOptionsHostRef}
            id="selection-options-host"
            hidden={!selectionOptionsActive}
            className="selection-options-host shrink-0 px-4 py-3 border-b border-[var(--border-color)]"
          >
            <div className="selection-options-title">Selection options</div>
          </div>
          <div className="bhynd-panel-in overflow-y-auto flex-1 p-4" style={{ display: desktopSidePanel === 'video-info' ? 'block' : 'none' }}>
            <RightInspector sectionFilter="video-info" onRegenerateCaptions={() => triggerRegeneration()} />
          </div>
          <div className="bhynd-panel-in overflow-y-auto flex-1 p-4" style={{ display: desktopSidePanel === 'transcript' ? 'block' : 'none' }}>
            <RightInspector sectionFilter="transcript" active={desktopSidePanel === 'transcript'} onRegenerateCaptions={() => triggerRegeneration()} />
          </div>
          {/* Every other tool: mounted only while shown. */}
          {desktopTool && !PERMANENT_PANEL_KEYS.has(desktopSidePanel) && (
            <div key={desktopSidePanel} className="bhynd-panel-in overflow-y-auto flex-1 min-h-0">
              {renderToolBody(desktopTool)}
            </div>
          )}
          {/* Not conditionally rendered — see relocatePrecisionFields() in
              timelinePanel.js, which physically moves the SAME lane input
              elements in here rather than this being separate React-owned
              content. */}
          <div
            ref={advancedPanelBodyRef}
            className="bhynd-panel-in overflow-y-auto flex-1 p-4 flex flex-col gap-4"
            style={{ display: desktopSidePanel === 'advanced' ? 'flex' : 'none' }}
          />
        </aside>
      )}

      {/* Phone and tablet: a bottom sheet that rises above the dock, centred
          and width-capped on wide screens. Tapping the active tool again (or
          the X) closes it. Height is user-resizable (see sheetHeight/the
          grip), so a long panel leaves the preview visible by default. */}
      {mobileActivePanel && (() => {
        const tool = MOBILE_TOOLS.find((t) => t.key === mobileActivePanel);
        if (!tool) return null;
        return (
          <div
            ref={mobileSheetRef}
            className="bhynd-sheet-in flex flex-col fixed left-0 right-0 z-40 bg-[var(--bg-raised)]
              border-t border-[var(--border-color)] rounded-t-[20px] shadow-[var(--shadow-lg)]
              max-w-2xl mx-auto lg:border-x overflow-hidden"
            style={{ bottom: DOCK_HEIGHT, height: sheetHeight }}
          >
            <div
              onPointerDown={handleSheetGripPointerDown}
              className="flex items-center justify-center relative shrink-0 pt-2.5 pb-1 cursor-ns-resize touch-none"
              role="slider"
              aria-label="Resize panel"
              aria-orientation="vertical"
              aria-valuenow={sheetHeight}
              aria-valuemin={SHEET_MIN_HEIGHT_PX}
              aria-valuemax={Math.round(window.innerHeight * (SHEET_MAX_HEIGHT_VH / 100))}
            >
              <div className="w-10 h-1 rounded-full bg-[var(--border-color-hover)]" />
            </div>
            <div className="flex items-center justify-between pl-4 pr-2 py-1.5 shrink-0">
              <span className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                <span className="text-[var(--accent-color)] [&_svg]:w-4 [&_svg]:h-4" aria-hidden="true">{tool.icon}</span>
                {tool.title}
              </span>
              <button type="button" onClick={closeMobilePanel} aria-label="Close panel" className={PANEL_CLOSE_BTN}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4.5 h-4.5">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0 border-t border-[var(--border-subtle)]">
              {renderToolBody(tool)}
            </div>
          </div>
        );
      })()}

      {/* The dock: five sections, and the chosen section's tools — see
          ToolDock.jsx. On desktop every tool opens the right-hand panel;
          below it, the bottom sheet. */}
      <ToolDock
        ref={mobileToolbarRef}
        sections={DOCK_SECTIONS}
        activeSection={dockSection}
        onSectionChange={setDockSection}
        isToolOpen={isToolOpen}
        onToolClick={(tool) => (isDesktop && DESKTOP_SIDE_PANEL_TOOL_KEYS.has(tool.key)
          ? toggleDesktopSidePanel(tool.key)
          : toggleMobilePanel(tool.key))}
      />

      <ExportDialog
        open={exportDialogOpen}
        source={exportSource}
        onCancel={closeExportDialog}
        onExport={(size) => { setExportDialogOpen(false); handleDownloadVideo(size); }}
      />

      <div
        id="app-toast"
        role="status"
        aria-live="polite"
        // Above the dock on desktop; at the top on phones, where the bottom
        // is the sheet being worked in.
        className={`fixed left-1/2 bottom-[calc(var(--dock-h)+16px)] max-lg:bottom-auto max-lg:top-[68px] -translate-x-1/2 flex items-center gap-2.5 max-w-[min(560px,calc(100vw-32px))]
          bg-[var(--bg-raised)] border border-[var(--border-color)] text-[var(--text-primary)] pl-3.5 pr-4 py-2.5 rounded-xl
          text-[13px] font-medium leading-snug shadow-[var(--shadow-lg)] pointer-events-none
          transition-[opacity,translate] duration-[var(--dur-med)] ease-[var(--ease-out)] z-[1000]
          ${toastVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
      >
        <span className="w-2 h-2 rounded-full bg-[var(--accent-color)] shadow-[0_0_10px_var(--accent-glow)] shrink-0" aria-hidden="true" />
        <span>{toastMessage}</span>
      </div>

      {renderIssue && (
        <div
          id="render-issue-banner"
          className="fixed bottom-[calc(var(--dock-h)+16px)] right-6 max-w-[520px] bg-[var(--bg-card)] border border-[#ef4444]
            text-[var(--text-primary)] rounded-[var(--radius-md)] shadow-[var(--shadow-md)] z-[1001] p-4 flex flex-col gap-2"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="text-[12px] font-bold uppercase tracking-[0.05em] text-[#ef4444]">
              Exported without some effects
            </span>
            <button
              type="button"
              id="render-issue-dismiss"
              className="bg-transparent border-0 text-[var(--text-muted)] cursor-pointer text-[16px] leading-none p-0 hover:text-[var(--text-primary)]"
              onClick={() => setRenderIssue(null)}
              aria-label="Dismiss"
            >×</button>
          </div>
          <p className="text-[12px] m-0 text-[var(--text-secondary)]">
            The advanced renderer failed, so this file was produced by the fallback — caption
            position/rotation/scale keyframes, text blend mode and text overlays are missing from it.
          </p>
          <code
            id="render-issue-message"
            className="text-[11px] font-mono whitespace-pre-wrap break-words bg-[var(--bg-input)]
              border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 max-h-[160px] overflow-auto"
          >
            {renderIssue.stage}: {renderIssue.message}
          </code>
          <button
            type="button"
            id="render-issue-copy"
            className="h-8 self-start px-3 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)]
              font-bold text-[11px] rounded-[var(--radius-sm)] cursor-pointer hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]"
            onClick={() => {
              const full = `[${renderIssue.stage}] ${renderIssue.message}${renderIssue.detail ? `\n\n${renderIssue.detail}` : ''}`;
              navigator.clipboard?.writeText(full).then(
                () => setRenderIssueCopied(true),
                () => setRenderIssueCopied(false)
              );
            }}
          >
            {renderIssueCopied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      )}
    </>
  );
}
