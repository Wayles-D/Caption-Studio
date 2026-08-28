/**
 * Caption Studio Main Core Javascript Logic (Modular Architecture)
 */

// Tailwind (theme + utilities only, no Preflight reset — see tailwind.css's
// own doc comment) for the incremental React/Tailwind UI migration. Inert
// until a component actually uses a utility class.
import './tailwind.css';

import { appState, updateState, DEFAULT_DEMO_VIDEO_URL, getStyleParams } from './js/state.js';
import { initToolbar } from './js/components/toolbar.js';
import { initSidebarInspector } from './js/components/sidebarInspector.js';
import { initPreviewWorkspace, applyCSSPreviewStyles } from './js/components/preview.js';
import { initRightInspector, renderTranscriptEditor, collectEditedWords } from './js/components/rightInspector.js';
import { fetchJson, describeFetchError } from './js/utils/apiRequest.js';

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const videoFileInput = document.getElementById('video-file-input');
const btnSelectFile = document.getElementById('btn-select-file');
const btnSelectFileDropzone = document.getElementById('btn-select-file-dropzone');
const btnUseDemo = document.getElementById('btn-use-demo');

const previewVideo = document.getElementById('preview-video');
const stateUpload = document.getElementById('state-upload');
const stateProcessing = document.getElementById('state-processing');
const stateVideo = document.getElementById('state-video');
const previewProcessingTitle = document.getElementById('preview-processing-title');
const btnDownloadVideo = document.getElementById('btn-download-video');
const btnApplyRender = document.getElementById('btn-apply-render');
const actionsPanel = document.getElementById('actions-panel');
const appToast = document.getElementById('app-toast');

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  init();
});

function init() {
  bindUploadEvents();

  initToolbar({
    onImportVideo: () => videoFileInput?.click(),
    onExportVideo: () => triggerRegeneration()
  });

  initSidebarInspector();
  initPreviewWorkspace();
  
  initRightInspector({
    onRegenerateCaptions: () => triggerRegeneration()
  });

  applyCSSPreviewStyles();
}

// Toast Notification helper
export function showToast(message) {
  if (!appToast) return;
  appToast.textContent = message;
  appToast.classList.add('show');
  setTimeout(() => {
    appToast.classList.remove('show');
  }, 2500);
}

// Upload & Demo Video Handlers
function bindUploadEvents() {
  if (btnSelectFile && videoFileInput) {
    btnSelectFile.addEventListener('click', () => videoFileInput.click());
    btnSelectFileDropzone?.addEventListener('click', () => videoFileInput.click());
    videoFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFileSelected(e.target.files[0]);
      }
    });
  }

  if (btnUseDemo) {
    btnUseDemo.addEventListener('click', () => {
      handleDemoVideo();
    });
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });
  }

  if (btnDownloadVideo) {
    btnDownloadVideo.addEventListener('click', handleDownloadVideo);
  }
}

async function handleFileSelected(file) {
  if (!file.type.startsWith('video/')) {
    showToast('Please select a valid video file.');
    return;
  }

  updateState({ uploadedFile: file, isProcessing: true }, { recordHistory: false });

  // Update UI step state
  stateUpload.classList.remove('active');
  stateProcessing.classList.add('active');

  const formData = new FormData();
  formData.append('video', file);
  Object.entries(getStyleParams()).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      formData.append(key, value.toString());
    }
  });

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';

  try {
    const data = await fetchJson(`${apiBaseUrl}/api/upload`, {
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

    // Set preview video source
    const localVideoUrl = URL.createObjectURL(file);
    previewVideo.src = localVideoUrl;

    stateProcessing.classList.remove('active');
    stateVideo.classList.add('active');

    if (actionsPanel) actionsPanel.classList.remove('disabled');
    showToast('Subtitles generated successfully!');

    renderTranscriptEditor();
  } catch (err) {
    console.error('Upload Error:', err);
    stateProcessing.classList.remove('active');
    stateUpload.classList.add('active');
    updateState({ isProcessing: false }, { recordHistory: false });
    showToast(`Upload failed: ${describeFetchError(err)}`);
  }
}

function handleDemoVideo() {
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

  previewVideo.src = DEFAULT_DEMO_VIDEO_URL;

  stateUpload.classList.remove('active');
  stateVideo.classList.add('active');

  if (actionsPanel) actionsPanel.classList.remove('disabled');
  showToast('Loaded demo video.');

  renderTranscriptEditor();
}

async function triggerRegeneration() {
  if (!appState.baseName || appState.isProcessing) {
    showToast("Please upload a video first.");
    return;
  }

  const editedWords = collectEditedWords();
  if (editedWords.length === 0) {
    showToast("No transcript words to render.");
    return;
  }

  updateState({ isProcessing: true }, { recordHistory: false });
  if (btnApplyRender) btnApplyRender.disabled = true;
  showToast("Re-rendering captioned video...");

  stateVideo.classList.remove("active");
  stateProcessing.classList.add("active");
  if (previewProcessingTitle) previewProcessingTitle.textContent = "Re-rendering video with custom captions...";

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';

  try {
    const result = await fetchJson(`${apiBaseUrl}/api/upload/regenerate`, {
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

    stateProcessing.classList.remove("active");
    stateVideo.classList.add("active");

    showToast("Render complete! Ready to download.");
  } catch (err) {
    console.error("Regeneration Error:", err);
    stateProcessing.classList.remove("active");
    stateVideo.classList.add("active");
    updateState({ isProcessing: false }, { recordHistory: false });
    showToast(`Render failed: ${describeFetchError(err)}`);
  } finally {
    if (btnApplyRender) btnApplyRender.disabled = false;
  }
}

function handleDownloadVideo() {
  if (appState.renderedVideoPath) {
    const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
    const videoUrl = `${apiBaseUrl}${appState.renderedVideoPath}`;
    const dlLink = document.createElement("a");
    dlLink.href = videoUrl;
    dlLink.download = appState.renderedVideoPath.split('/').pop();
    document.body.appendChild(dlLink);
    dlLink.click();
    document.body.removeChild(dlLink);
    return;
  }

  if (appState.uploadedFile && appState.uploadedFile.demo) {
    const dlLink = document.createElement("a");
    dlLink.href = previewVideo.src;
    dlLink.download = "captioned_demo_video.mp4";
    document.body.appendChild(dlLink);
    dlLink.click();
    document.body.removeChild(dlLink);
    showToast("Downloaded demo video!");
  }
}
