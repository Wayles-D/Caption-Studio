/**
 * Mount point for the timeline — the app's primary keyframe editing surface
 * (see src/js/components/timelinePanel.js, which owns all of the actual DOM/
 * interaction, same pattern as PreviewStage.jsx's initPreviewWorkspace()).
 * Lives in its own full-width row below the 3-column workspace — see
 * src/App.jsx's layout.
 */
import { useEffect, useRef } from 'react';
import { initTimelinePanel } from '../js/components/timelinePanel.js';

export function TimelinePanel() {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    return initTimelinePanel(containerRef.current);
  }, []);

  return (
    <div
      id="timeline-panel-container"
      className="w-full h-[232px] bg-[var(--bg-sidebar)] border-t border-[var(--border-color)] flex-shrink-0"
      ref={containerRef}
    />
  );
}
