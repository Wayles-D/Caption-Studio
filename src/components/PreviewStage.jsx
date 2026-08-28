/**
 * Center Workspace: phone-frame preview (upload dropzone / processing /
 * video + caption overlay), playback controls, and the on-canvas caption
 * transform overlay.
 *
 * React port of the corresponding index.html markup for the migration
 * plan's Stage 3a/3b — but, like SidebarInspector.jsx (Stage 2), this
 * component does NOT reimplement preview.js/canvasTransform.js as
 * idiomatic React state/effects. Both modules are an already-correct,
 * delicate pipeline: canvas sizing tied to devicePixelRatio and the
 * phone-frame's live layout, a font-loading race guard
 * (ensureCanvasFontReady), Pointer Events-based drag/resize/rotate with
 * window-scoped listeners, and a hand-verified This-Caption/All-Captions
 * transform scope system (see the earlier canvasTransform bug-fix pass).
 * None of that logic depends on React's component tree — it's pure
 * getElementById lookups against fixed DOM node ids and a
 * subscribe('*', ...) resync, so it works identically whether those nodes
 * were created by static HTML or by this component's render. Rewriting it
 * as controlled React state would risk exactly the pitfalls the migration
 * plan calls out (devicePixelRatio thrashing, stale font-load promises,
 * pointer-capture semantics) for zero behavioral benefit — so
 * initPreviewWorkspace() is still called, unchanged, once after mount
 * (it calls initCanvasTransform() internally, so Stages 3a/3b collapse
 * into one component with no separate wiring needed).
 *
 * What DOES belong in React (Stage 4): the outer upload/processing/video
 * view switching, the processing title text, the video's src, and the
 * upload/demo/download/drag-drop interactions — none of that touches the
 * caption-rendering pipeline, so App.jsx now owns it as plain state/props
 * instead of main.js reaching in via getElementById + classList.
 */
import { useEffect, useState } from 'react';
import { initPreviewWorkspace } from '../js/components/preview.js';

export function PreviewStage({
  viewState,
  processingTitle,
  videoSrc,
  onSelectFileClick,
  onUseDemo,
  onFilesDropped,
  onDownloadVideo
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    initPreviewWorkspace();
  }, []);

  return (
    <div className="preview-stage-container" id="preview-container">
      <div className="phone-frame">
        {/* Upload Dropzone View */}
        <div className={`view-state${viewState === 'upload' ? ' active' : ''}`} id="state-upload">
          <div
            className={`drop-zone${isDragOver ? ' dragover' : ''}`}
            id="drop-zone"
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              if (e.dataTransfer.files.length > 0) onFilesDropped?.(e.dataTransfer.files[0]);
            }}
          >
            <div className="drop-zone-content">
              <div className="upload-icon-circle">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V8M12 8L9 11M12 8L15 11" /><path d="M3 15v3c0 1.1.9 2 2 2h14a2 2 0 002-2v-3" /></svg>
              </div>
              <h3 className="drop-title font-geist">Upload Video</h3>
              <p className="drop-subtitle">Drag & drop or click to choose file</p>
              <button type="button" id="btn-select-file-dropzone" className="btn btn-primary btn-upload" onClick={() => onSelectFileClick?.()}>Select Video</button>
              <div className="demo-wrapper">
                <span className="text-muted">or</span>
                <button type="button" id="btn-use-demo" className="btn btn-link" onClick={() => onUseDemo?.()}>Try Demo Video</button>
              </div>
            </div>
          </div>
        </div>

        {/* Processing State View */}
        <div className={`view-state${viewState === 'processing' ? ' active' : ''}`} id="state-processing">
          <div className="processing-content">
            <div className="spinner-ring" />
            <h3 className="processing-title" id="preview-processing-title">{processingTitle}</h3>
            <p className="processing-text" id="preview-processing-text">Whisper AI extracting word timestamps</p>
          </div>
        </div>

        {/* Video Preview View */}
        <div className={`view-state${viewState === 'video' ? ' active' : ''}`} id="state-video">
          <video id="preview-video" src={videoSrc} playsInline preload="metadata" loop />
          <div className="subtitles-overlay" id="subtitles-overlay">
            <div className="captions-text" id="captions-text" />
          </div>
          {/* Shared Canvas2D graphics-renderer overlay (see shared/captionGraphics.js).
              Hidden/inert unless window.__USE_GRAPHICS_CAPTIONS__ is set — an internal
              dev flag for comparing the new renderer against the CSS overlay above
              during migration; it renders nothing by default and does not replace it. */}
          <canvas className="captions-canvas" id="captions-canvas" />
          {/* On-canvas caption transform overlay (editor-only UI — see
              src/js/components/canvasTransform.js). Never rendered into the
              exported video; populated/positioned entirely from JS. */}
          <div className="caption-transform-overlay" id="caption-transform-overlay">
            <div className="caption-transform-hit-area" id="caption-transform-hit-area" />
            <div className="caption-transform-box" id="caption-transform-box" hidden>
              <div className="caption-transform-toolbar" id="caption-transform-toolbar">
                <button type="button" className="caption-transform-scope-btn" data-scope="this" id="btn-transform-scope-this">This Caption</button>
                <button type="button" className="caption-transform-scope-btn" data-scope="all" id="btn-transform-scope-all">All Captions</button>
                <button type="button" className="caption-transform-reset-btn" id="btn-transform-reset">Reset</button>
                <span className="caption-transform-rotation-label" id="caption-transform-rotation-label" />
              </div>
              <div className="caption-transform-rotate-line" />
              <div className="caption-transform-handle rotate" id="caption-transform-handle-rotate" />
              <div className="caption-transform-handle tl" data-handle="tl" />
              <div className="caption-transform-handle tr" data-handle="tr" />
              <div className="caption-transform-handle bl" data-handle="bl" />
              <div className="caption-transform-handle br" data-handle="br" />
            </div>
          </div>
        </div>
      </div>

      {/* Floating Playback Controls Bar */}
      <div className="preview-controls-bar">
        <button type="button" id="btn-video-play" className="btn-play-toggle" aria-label="Play/Pause">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" id="icon-play-state">
            <polygon points="5,3 19,12 5,21" fill="currentColor" className="play-poly" />
          </svg>
        </button>
        <div className="timeline-seek-wrapper">
          <span className="time-stamp" id="time-display-current">0:00</span>
          <input type="range" id="video-seek-bar" min="0" max="100" defaultValue="0" className="video-seek-slider" />
          <span className="time-stamp" id="time-display-duration">0:00</span>
        </div>
        <button type="button" id="btn-download-video" className="btn-download-action" title="Download Captioned MP4" onClick={() => onDownloadVideo?.()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
        </button>
      </div>
    </div>
  );
}
