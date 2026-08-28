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
import { useCallback, useRef, useState } from 'react';
import { appState, updateState, DEFAULT_DEMO_VIDEO_URL, getStyleParams } from './js/state.js';
import { fetchJson, describeFetchError } from './js/utils/apiRequest.js';
import { collectEditedWords } from './js/components/transcriptEditorState.js';
import { Toolbar } from './components/Toolbar.jsx';
import { SidebarInspector } from './components/SidebarInspector.jsx';
import { PreviewStage } from './components/PreviewStage.jsx';
import { RightInspector } from './components/RightInspector.jsx';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export function App() {
  const videoFileInputRef = useRef(null);

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
      if (value !== null && value !== undefined) {
        formData.append(key, value.toString());
      }
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

      showToast('Subtitles generated successfully!');
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

  const triggerRegeneration = useCallback(async () => {
    if (!appState.baseName || appState.isProcessing) {
      showToast("Please upload a video first.");
      return;
    }

    const editedWords = collectEditedWords(appState);
    if (editedWords.length === 0) {
      showToast("No transcript words to render.");
      return;
    }

    updateState({ isProcessing: true }, { recordHistory: false });
    showToast("Re-rendering captioned video...");

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
      showToast("Render complete! Ready to download.");
    } catch (err) {
      console.error("Regeneration Error:", err);
      setViewState('video');
      updateState({ isProcessing: false }, { recordHistory: false });
      showToast(`Render failed: ${describeFetchError(err)}`);
    }
  }, [showToast]);

  const handleDownloadVideo = useCallback(() => {
    if (appState.renderedVideoPath) {
      const videoUrl = `${API_BASE_URL}${appState.renderedVideoPath}`;
      const dlLink = document.createElement("a");
      dlLink.href = videoUrl;
      dlLink.download = appState.renderedVideoPath.split('/').pop();
      document.body.appendChild(dlLink);
      dlLink.click();
      document.body.removeChild(dlLink);
      return;
    }

    if (appState.uploadedFile && appState.uploadedFile.demo && videoSrc) {
      const dlLink = document.createElement("a");
      dlLink.href = videoSrc;
      dlLink.download = "captioned_demo_video.mp4";
      document.body.appendChild(dlLink);
      dlLink.click();
      document.body.removeChild(dlLink);
      showToast("Downloaded demo video!");
    }
  }, [videoSrc, showToast]);

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
        <Toolbar
          onImportVideo={() => videoFileInputRef.current?.click()}
          onExportVideo={() => triggerRegeneration()}
        />
      </header>

      <div className="grid grid-cols-[320px_1fr_340px] h-[calc(100vh-56px)] w-screen overflow-hidden
        max-lg:grid-cols-[280px_1fr_280px] max-md:grid-cols-1 max-md:h-auto max-md:overflow-y-auto">
        <aside className="bg-[var(--bg-sidebar)] border-r border-[var(--border-color)] overflow-y-auto flex flex-col max-md:h-auto">
          <SidebarInspector />
        </aside>

        <main className="bg-[radial-gradient(circle_at_center,rgba(30,41,59,0.3)_0%,rgba(8,12,20,1)_100%)] flex flex-col items-center justify-center relative p-5">
          <PreviewStage
            viewState={viewState}
            processingTitle={processingTitle}
            videoSrc={videoSrc}
            onSelectFileClick={() => videoFileInputRef.current?.click()}
            onUseDemo={() => handleDemoVideo()}
            onFilesDropped={(file) => handleFileSelected(file)}
            onDownloadVideo={() => handleDownloadVideo()}
          />
        </main>

        <aside className="bg-[var(--bg-sidebar)] border-l border-[var(--border-color)] overflow-y-auto p-4 flex flex-col gap-4 max-md:h-auto">
          <RightInspector onRegenerateCaptions={() => triggerRegeneration()} />
        </aside>
      </div>

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
