/**
 * Mount point for the timeline — the app's primary keyframe editing surface
 * (see src/js/components/timelinePanel.js, which owns all of the actual DOM/
 * interaction, same pattern as PreviewStage.jsx's initPreviewWorkspace()).
 * Lives in its own full-width row below the 3-column workspace — see
 * src/App.jsx's layout.
 *
 * `containerRef` is optional and lets App.jsx also treat this panel's DOM
 * node as an "outside click" exclusion zone for the desktop Advanced side
 * panel (see useClickOutside) — the Advanced button that opens/closes it
 * lives inside here. The callback props are forwarded straight into
 * initTimelinePanel's options: the Advanced ones let that DOM-driven module
 * route its "Advanced" button to React's desktop side panel instead of its
 * own inline mobile/tablet toggle (see timelinePanel.js's own doc comments
 * on relocatePrecisionFields for why this is a relocation of the same
 * fields rather than a second copy of them); getPlaybackRowContainer does
 * the same thing for the Play/Undo/Redo row on mobile/tablet, moving it
 * into App.jsx's own bar rendered directly above this panel instead of
 * leaving it inside this component's header.
 */
import { useEffect, useRef, useState } from 'react';
import { initTimelinePanel } from '../js/components/timelinePanel.js';

/** The panel's default height, and its limits: never so short the lanes vanish, never so tall the preview does. */
export const TIMELINE_DEFAULT_HEIGHT = 272;
const TIMELINE_MIN_HEIGHT = 140;
const PREVIEW_MIN_HEIGHT = 220;
const HEIGHT_STORAGE_KEY = 'bhynd.timeline.height';

function clampHeight(h) {
  const max = Math.max(TIMELINE_MIN_HEIGHT, window.innerHeight - 56 - 80 - PREVIEW_MIN_HEIGHT);
  return Math.round(Math.min(max, Math.max(TIMELINE_MIN_HEIGHT, h)));
}

/** The height the user last left the timeline at (an editor preference, kept per browser). */
export function readStoredTimelineHeight() {
  try {
    const v = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? clampHeight(v) : TIMELINE_DEFAULT_HEIGHT;
  } catch {
    return TIMELINE_DEFAULT_HEIGHT;
  }
}

export function TimelinePanel({
  containerRef: externalContainerRef,
  isDesktopGetter,
  getAdvancedContainer,
  isAdvancedOpenGetter,
  onAdvancedToggle,
  onSoundLibraryToggle,
  onSoundLibraryClose,
  onSoundReplace,
  getPlaybackRowContainer,
  height = TIMELINE_DEFAULT_HEIGHT,
  onHeightChange
}) {
  const internalContainerRef = useRef(null);
  const [resizing, setResizing] = useState(false);
  const containerRef = externalContainerRef || internalContainerRef;

  useEffect(() => {
    if (!containerRef.current) return;
    return initTimelinePanel(containerRef.current, {
      isDesktopGetter,
      getAdvancedContainer,
      isAdvancedOpenGetter,
      onAdvancedToggle,
      onSoundLibraryToggle,
      onSoundLibraryClose,
      onSoundReplace,
      getPlaybackRowContainer
    });
    // Mount-once, matching PreviewStage.jsx's initPreviewWorkspace() pattern
    // (a live drag/scrub rAF loop fighting React reconciliation has no
    // benefit) — every callback prop above is a stable identity (see
    // App.jsx's useCallback with empty deps) that reads current values via
    // refs at call time, so there's nothing stale to re-subscribe to here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dragging the top edge slides the timeline up or down: taller for more
  // lanes, shorter for a bigger preview. Double-click puts it back.
  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    setResizing(true);
    const move = (ev) => onHeightChange?.(clampHeight(startH + (startY - ev.clientY)));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      const final = clampHeight(startH + (startY - ev.clientY));
      onHeightChange?.(final);
      try { window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(final)); } catch { /* preference only */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const reset = () => {
    onHeightChange?.(clampHeight(TIMELINE_DEFAULT_HEIGHT));
    try { window.localStorage.removeItem(HEIGHT_STORAGE_KEY); } catch { /* preference only */ }
  };

  return (
    <div className="relative w-full flex-shrink-0">
      <div
        id="timeline-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        title="Drag to resize the timeline — double-click to reset"
        className={`absolute -top-[3px] left-0 right-0 h-[7px] z-20 cursor-ns-resize touch-none
          after:content-[''] after:absolute after:left-1/2 after:-translate-x-1/2 after:top-[2px] after:w-10 after:h-[3px]
          after:rounded-full after:bg-[var(--border-color-hover)] hover:after:bg-[var(--accent-color)]
          ${resizing ? 'after:bg-[var(--accent-color)]' : ''}`}
        onPointerDown={startResize}
        onDoubleClick={reset}
      />
      <div
        id="timeline-panel-container"
        className="w-full bg-[var(--bg-sidebar)] border-t border-[var(--border-color)]"
        style={{ height }}
        ref={containerRef}
      />
    </div>
  );
}
