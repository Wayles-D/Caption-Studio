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
 * lives inside here. The four callback props are forwarded straight into
 * initTimelinePanel's options and let that DOM-driven module route its
 * "Advanced" button to React's desktop side panel instead of (or alongside)
 * its own inline mobile/tablet toggle — see timelinePanel.js's own doc
 * comments on relocatePrecisionFields for why this is a relocation of the
 * same fields rather than a second copy of them.
 */
import { useEffect, useRef } from 'react';
import { initTimelinePanel } from '../js/components/timelinePanel.js';

export function TimelinePanel({
  containerRef: externalContainerRef,
  isDesktopGetter,
  getAdvancedContainer,
  isAdvancedOpenGetter,
  onAdvancedToggle
}) {
  const internalContainerRef = useRef(null);
  const containerRef = externalContainerRef || internalContainerRef;

  useEffect(() => {
    if (!containerRef.current) return;
    return initTimelinePanel(containerRef.current, {
      isDesktopGetter,
      getAdvancedContainer,
      isAdvancedOpenGetter,
      onAdvancedToggle
    });
    // Mount-once, matching PreviewStage.jsx's initPreviewWorkspace() pattern
    // (a live drag/scrub rAF loop fighting React reconciliation has no
    // benefit) — every callback prop above is a stable identity (see
    // App.jsx's useCallback with empty deps) that reads current values via
    // refs at call time, so there's nothing stale to re-subscribe to here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      id="timeline-panel-container"
      className="w-full h-[232px] bg-[var(--bg-sidebar)] border-t border-[var(--border-color)] flex-shrink-0"
      ref={containerRef}
    />
  );
}
