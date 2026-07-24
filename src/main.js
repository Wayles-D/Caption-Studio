import { getCSSPreviewFromConfig } from '../backend/utils/captionConfig.js';

// Caption Studio Main Core Javascript Logic

// ==========================================================================
// 1. Data Store / State Configuration
// ==========================================================================
const MOCK_SUBTITLES = [
  { start: 0.0, end: 2.2, text: "WELCOME TO THE CAPTION STUDIO." },
  { start: 2.4, end: 5.2, text: "WE EXTRACT AUDIO AND GENERATE SPEECH-TO-TEXT AUTOMATICALLY." },
  { start: 5.5, end: 8.2, text: "THEN WE BURN STYLISH SUBTITLES RIGHT INTO YOUR SHORT-FORM VIDEOS." },
  { start: 8.5, end: 11.5, text: "CHANNELS THAT USE CAPTIONS SEE A 40% INCREASE IN WATCH TIME!" },
  { start: 11.8, end: 14.8, text: "TAILOR THE STYLES, COLORS, AND FONTS DIRECTLY FROM THE SIDE DRAWER." },
  { start: 15.1, end: 18.2, text: "READY TO EXPORT FOR TIKTOK, INSTAGRAM REELS, AND YOUTUBE SHORTS." },
  { start: 18.5, end: 21.5, text: "PREMIUM. UNDERSTATED. PROFESSIONAL CREATOR TOOLS." }
];

const DEFAULT_DEMO_VIDEO_URL = "https://assets.mixkit.co/videos/preview/mixkit-vertical-shot-of-a-beautiful-waterfall-in-a-forest-48990-large.mp4";

let appState = {
  isProcessing: false,
  isLoaded: false,
  currentStep: 0,
  uploadedFile: null,
  videoDuration: 0,
  currentPreset: "bold-yellow",
  fontFamily: "Montserrat",
  fontSize: 14,
  textCase: "uppercase",
  position: "bottom",
  baseName: null,
  words: []
};

// ==========================================================================
// 2. DOM Elements Selection
// ==========================================================================
// File Upload Elements
const dropZone = document.getElementById("drop-zone");
const filePicker = document.getElementById("file-picker");
const uploadTrigger = document.getElementById("upload-trigger");
const demoTrigger = document.getElementById("demo-trigger");
const uploadCard = document.getElementById("upload-card");

// Timeline Elements
const timelineCard = document.getElementById("timeline-card");
const globalProgressBar = document.getElementById("global-progress-bar");
const globalStatusText = document.getElementById("global-status-text");
const steps = document.querySelectorAll(".timeline-step");

// Preview & Mock Elements
const phoneScreen = document.getElementById("phone-screen");
const stateEmpty = document.getElementById("state-empty");
const stateProcessing = document.getElementById("state-processing");
const stateVideo = document.getElementById("state-video");
const previewVideo = document.getElementById("preview-video");
const captionsText = document.getElementById("captions-text");
const subtitlesOverlay = document.getElementById("subtitles-overlay");
const previewProcessingTitle = document.getElementById("preview-processing-title");

// Video Control Elements
const btnVideoPlay = document.getElementById("btn-video-play");
const iconPlayState = document.getElementById("icon-play-state");
const playPoly = iconPlayState.querySelector(".play-poly");
const pauseRects = iconPlayState.querySelectorAll(".pause-rects");

// Actions Panel Elements
const actionsPanel = document.getElementById("actions-panel");
const btnDownload = document.getElementById("btn-download");
const btnCopyTranscript = document.getElementById("btn-copy-transcript");
const btnReset = document.getElementById("btn-reset");

// Settings Sidebar Drawer Elements
const settingsToggle = document.getElementById("settings-toggle");
const settingsClose = document.getElementById("settings-close");
const settingsSidebar = document.getElementById("settings-sidebar");
const overlayBackdrop = document.getElementById("overlay-backdrop");

// Config Form Controllers
const presetButtons = document.querySelectorAll(".preset-btn");
const fontFamilySelect = document.getElementById("font-family-select");
const inputFontSize = document.getElementById("input-font-size");
const valFontSize = document.getElementById("val-font-size");
const textCaseRadios = document.getElementsByName("text-case");
const positionRadios = document.getElementsByName("sub-pos");
const appToast = document.getElementById("app-toast");

// Transcript Editor Elements
const transcriptCard = document.getElementById("transcript-card");
const transcriptWordsContainer = document.getElementById("transcript-words-container");
const transcriptWordCount = document.getElementById("transcript-word-count");
const btnApplyRender = document.getElementById("btn-apply-render");

// ==========================================================================
// 3. Application Initialization & Subtitle Settings Binding
// ==========================================================================
function init() {
  bindUploadEvents();
  bindSidebarEvents();
  bindInteractionEvents();
  bindTranscriptEvents();
  applySettingsState();
}

// Helper to display floating toast notifications
function showToast(message) {
  appToast.textContent = message;
  appToast.classList.add("show");
  setTimeout(() => {
    appToast.classList.remove("show");
  }, 2500);
}

// Dynamic Google Font Loader for WYSIWYG Preview
const loadedFonts = new Set();
function loadGoogleFont(fontName) {
  if (!fontName || loadedFonts.has(fontName)) return;
  loadedFonts.add(fontName);

  const cleanFont = fontName.replace(/['"]/g, '').split(',')[0].trim();
  const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(cleanFont).replace(/%20/g, '+')}:wght@400;600;700;800;900&display=swap`;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = fontUrl;
  document.head.appendChild(link);
}

// Binds controls on the settings panel sidebar with exact WYSIWYG CSS rendering
function applySettingsState() {
  loadGoogleFont(appState.fontFamily);

  const cssConfig = getCSSPreviewFromConfig({
    preset: appState.currentPreset,
    fontFamily: appState.fontFamily,
    fontSize: appState.fontSize,
    textCase: appState.textCase,
    position: appState.position
  });

  // Apply Overlay Styles
  Object.assign(subtitlesOverlay.style, cssConfig.overlay);

  // Apply Subtitle Text Styles
  Object.assign(captionsText.style, cssConfig.text);
}

// ==========================================================================
// 4. File Drag & Drop + Selection Handlers
// ==========================================================================
function bindUploadEvents() {
  // File Input picker triggers
  uploadTrigger.addEventListener("click", () => filePicker.click());
  filePicker.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  // Drag over states
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  // Try with Demo Video trigger
  demoTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    handleDemoVideoSelection();
  });
}

function handleDemoVideoSelection() {
  appState.uploadedFile = {
    name: "forest_waterfall_short.mp4",
    size: 4718592, // 4.5MB
    type: "video/mp4",
    demo: true
  };
  startProcessingTimeline();
}

function handleFileSelected(file) {
  // Validate type
  const allowedTypes = ["video/mp4", "video/quicktime", "video/webm"];
  if (!allowedTypes.includes(file.type) && !file.name.endsWith(".mov")) {
    showToast("Unsupported format. Use MP4, MOV, or WebM.");
    return;
  }
  // Validate size (100MB)
  if (file.size > 100 * 1024 * 1024) {
    showToast("File size expands past the 100MB constraint.");
    return;
  }

  appState.uploadedFile = file;
  startProcessingTimeline();
}

// ==========================================================================
// 5. Timeline Processing Orchestration
// ==========================================================================
function resetTimelineComponents() {
  globalProgressBar.style.width = "0%";
  globalStatusText.textContent = "Ready for file";
  globalStatusText.className = "status-indicator-text";
  
  steps.forEach(step => {
    step.className = "timeline-step pending";
  });
}

function startProcessingTimeline() {
  if (appState.isProcessing) return;
  appState.isProcessing = true;
  appState.isLoaded = false;
  appState.subtitles = [];
  appState.subtitlePath = null;
  
  // Disable reset / control actions during processing
  actionsPanel.classList.add("disabled");
  
  // Visual state updates: change preview pane to processing
  stateEmpty.classList.remove("active");
  stateVideo.classList.remove("active");
  stateProcessing.classList.add("active");
  
  resetTimelineComponents();

  // Retrieve Render API address from Vite environment, defaulting to standard dev port
  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
  
  // Helper to progress timeline steps
  function advanceTimelineUI(stepNum, statusHeader) {
    appState.currentStep = stepNum;
    globalStatusText.textContent = statusHeader;
    globalStatusText.className = "status-indicator-text processing";
    globalProgressBar.style.width = `${(stepNum / 6) * 100}%`;
    
    const targetStep = document.getElementById(getStepIdByNumber(stepNum));
    if (targetStep) {
      targetStep.className = "timeline-step active";
    }

    if (stepNum > 1) {
      const prevStep = document.getElementById(getStepIdByNumber(stepNum - 1));
      if (prevStep) {
        prevStep.className = "timeline-step completed";
      }
    }
    previewProcessingTitle.textContent = statusHeader + "...";
  }

  // Handle Demo Video simulation locally (retains original behavior for demo)
  if (appState.uploadedFile.demo) {
    console.log("Demo mode chosen. Simulating timeline processing...");
    advanceTimelineUI(1, "Preparing Upload");
    setTimeout(() => advanceTimelineUI(2, "Extracting audio"), 1000);
    setTimeout(() => advanceTimelineUI(3, "Generating transcript"), 2500);
    setTimeout(() => advanceTimelineUI(4, "Creating subtitles"), 4000);
    setTimeout(() => advanceTimelineUI(5, "Rendering final video"), 5500);
    setTimeout(() => advanceTimelineUI(6, "Ready"), 7000);
    setTimeout(() => {
      appState.subtitles = MOCK_SUBTITLES;
      completeProcessingTimeline();
    }, 7800);
    return;
  }

  // Execute a real POST upload to our Express backend
  const uploadUrl = `${apiBaseUrl}/api/upload`;
  console.log(`Starting production upload for ${appState.uploadedFile.name} to ${uploadUrl}`);

  advanceTimelineUI(1, "Uploading video");

  // Keep a background UI ticking progress indicators
  let simulatedTicks = 1;
  const timer = setInterval(() => {
    if (simulatedTicks === 1) {
      advanceTimelineUI(2, "Extracting audio");
    } else if (simulatedTicks === 2) {
      advanceTimelineUI(3, "Transcribing speech");
    } else if (simulatedTicks === 3) {
      advanceTimelineUI(4, "Compiling subtitles");
    } else if (simulatedTicks === 4) {
      advanceTimelineUI(5, "Formatting styling presets");
    }
    simulatedTicks++;
  }, 2500);

  const formData = new FormData();
  formData.append('video', appState.uploadedFile);

  fetch(uploadUrl, {
    method: 'POST',
    body: formData
  })
    .then(async (res) => {
      clearInterval(timer);
      if (!res.ok) {
        let errorDetail = 'Upload failed';
        try {
          const jsonErr = await res.json();
          errorDetail = jsonErr.message || errorDetail;
        } catch {
          errorDetail = await res.text() || errorDetail;
        }
        throw new Error(errorDetail);
      }
      return res.json();
    })
    .then((result) => {
      console.log('Backend pipeline response:', result);
      
      // Auto-complete progress
      advanceTimelineUI(5, "Finalizing package");
      setTimeout(() => {
        advanceTimelineUI(6, "Ready");
        
        // Parse and populate real Whisper transcripts in the player
        if (result.transcription && Array.isArray(result.transcription.segments)) {
          appState.subtitles = result.transcription.segments.map(seg => ({
            start: seg.start,
            end: seg.end,
            text: (seg.text || '').trim().toUpperCase()
          }));
        } else {
          appState.subtitles = MOCK_SUBTITLES;
        }

        // Store word-level data and baseName for transcript editing
        appState.baseName = result.baseName || null;
        appState.words = result.words || [];

        // Keep backend subtitle output URL and rendered video path
        appState.subtitlePath = result.subtitlePath;
        appState.renderedVideoPath = result.renderedVideoPath;
        completeProcessingTimeline();
      }, 500);
    })
    .catch((err) => {
      clearInterval(timer);
      console.error('Pipeline processing error occurred:', err);
      showToast(`Audit Failure: ${err.message}`);
      resetToLaunchApp();
    });
}

function getStepIdByNumber(num) {
  switch (num) {
    case 1: return "step-upload";
    case 2: return "step-audio";
    case 3: return "step-transcribe";
    case 4: return "step-captions";
    case 5: return "step-burn";
    case 6: return "step-ready";
  }
}

function completeProcessingTimeline() {
  appState.isProcessing = false;
  appState.isLoaded = true;

  // Complete final step check
  const readyStep = document.getElementById("step-ready");
  if (readyStep) readyStep.className = "timeline-step completed";

  globalStatusText.textContent = "Ready for download";
  globalStatusText.className = "status-indicator-text success";

  // Shift right preview pane to active video playback
  stateProcessing.classList.remove("active");
  stateVideo.classList.add("active");

  // Load video inside screen elements
  if (appState.uploadedFile.demo) {
    previewVideo.src = DEFAULT_DEMO_VIDEO_URL;
  } else {
    // Creating object URL for local drop files to render locally
    const objectURL = URL.createObjectURL(appState.uploadedFile);
    previewVideo.src = objectURL;
  }

  // Listen for video events
  previewVideo.addEventListener("timeupdate", syncVideoSubtitles);
  
  // Set play overlay states
  setVideoControlsUI(true); // State starts paused or play depending on browser policies
  
  // Auto play
  previewVideo.play().then(() => {
    setVideoControlsUI(false); // Playing
  }).catch(() => {
    setVideoControlsUI(true); // Autoplay blocked, remains paused
  });

  // Enable controls
  actionsPanel.classList.remove("disabled");
  showToast("Subtitles created successfully!");

  // Render editable transcript if words are available
  if (appState.words && appState.words.length > 0) {
    renderTranscriptEditor();
  }
}

// ==========================================================================
// 6. Subtitles Sync Logic
// ==========================================================================
function syncVideoSubtitles() {
  const currentTime = previewVideo.currentTime;
  let activeCaption = "";
  
  // Render real dynamic subtitles if present, otherwise fall back to MOCK
  const currentSubtitles = (appState.subtitles && appState.subtitles.length > 0)
    ? appState.subtitles
    : MOCK_SUBTITLES;

  for (let i = 0; i < currentSubtitles.length; i++) {
    const sub = currentSubtitles[i];
    if (currentTime >= sub.start && currentTime <= sub.end) {
      activeCaption = sub.text;
      break;
    }
  }

  captionsText.textContent = activeCaption;
}

// ==========================================================================
// 7. Video Playback Overlay Controls
// ==========================================================================
function bindInteractionEvents() {
  // Video overlay clicking plays/pauses
  const videoOverlay = document.querySelector(".video-overlay-controls");
  videoOverlay.addEventListener("click", toggleVideoPlayback);
  btnVideoPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleVideoPlayback();
  });

  // Action Panel buttons
  btnReset.addEventListener("click", resetToLaunchApp);
  btnCopyTranscript.addEventListener("click", copyTranscriptToClipboard);
  btnDownload.addEventListener("click", triggerMockVideoFormatExport);
}

function toggleVideoPlayback() {
  if (!appState.isLoaded) return;
  
  if (previewVideo.paused) {
    previewVideo.play();
    setVideoControlsUI(false);
  } else {
    previewVideo.pause();
    setVideoControlsUI(true);
  }
}

function setVideoControlsUI(isPaused) {
  if (isPaused) {
    playPoly.style.display = "block";
    pauseRects.forEach(r => r.style.display = "none");
  } else {
    playPoly.style.display = "none";
    pauseRects.forEach(r => r.style.display = "block");
  }
}

// Action Button Bindings
function resetToLaunchApp() {
  if (appState.isProcessing) return;
  
  // Pause video
  previewVideo.pause();
  previewVideo.src = "";
  previewVideo.removeEventListener("timeupdate", syncVideoSubtitles);
  captionsText.textContent = "";

  appState.isLoaded = false;
  appState.uploadedFile = null;
  appState.baseName = null;
  appState.words = [];

  // Toggle screens back to empty state
  stateVideo.classList.remove("active");
  stateProcessing.classList.remove("active");
  stateEmpty.classList.add("active");

  actionsPanel.classList.add("disabled");
  resetTimelineComponents();
  
  // Hide transcript card
  transcriptCard.style.display = "none";
  transcriptWordsContainer.innerHTML = "";
  
  // Clear file input picker
  filePicker.value = "";
  
  showToast("Workspace was reset.");
}

function copyTranscriptToClipboard() {
  if (!appState.isLoaded) return;
  
  const textStrings = MOCK_SUBTITLES.map(s => s.text).join("\n");
  navigator.clipboard.writeText(textStrings).then(() => {
    showToast("Transcript copied to clipboard!");
  }).catch(() => {
    showToast("Export formatting copy failed.");
  });
}

function triggerMockVideoFormatExport() {
  if (!appState.isLoaded) return;
  
  // If we have a rendered video file from Render backend, download the MP4 file!
  if (appState.renderedVideoPath) {
    showToast("Downloading captioned video...");
    const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
    const videoUrl = `${apiBaseUrl}/${appState.renderedVideoPath}`;
    
    const dlLink = document.createElement("a");
    dlLink.href = videoUrl;
    dlLink.download = appState.renderedVideoPath.split('/').pop();
    document.body.appendChild(dlLink);
    dlLink.click();
    document.body.removeChild(dlLink);
    return;
  }
  
  showToast("Rendering final build with captions burned-in...");
  
  setTimeout(() => {
    // Generate anchor linking download
    const dlLink = document.createElement("a");
    dlLink.href = previewVideo.src;
    dlLink.download = appState.uploadedFile.name.replace(/\.[^/.]+$/, "") + "_captioned.mp4";
    document.body.appendChild(dlLink);
    dlLink.click();
    document.body.removeChild(dlLink);
    showToast("Video downloaded successfully!");
  }, 1800);
}

// ==========================================================================
// 8. Sidebar Settings Toggle drawer and form binders
// ==========================================================================
function bindSidebarEvents() {
  // Opening/closing drawer
  settingsToggle.addEventListener("click", () => openDrawer(true));
  settingsClose.addEventListener("click", () => openDrawer(false));
  overlayBackdrop.addEventListener("click", () => openDrawer(false));

  // Style details presets
  presetButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      presetButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      appState.currentPreset = btn.getAttribute("data-preset");
      applySettingsState();
    });
  });

  // Typography select
  fontFamilySelect.addEventListener("change", (e) => {
    appState.fontFamily = e.target.value;
    applySettingsState();
  });

  // Sizing range
  inputFontSize.addEventListener("input", (e) => {
    const val = e.target.value;
    appState.fontSize = val;
    valFontSize.textContent = `${val}px`;
    applySettingsState();
  });

  // Checkbox radio alignments
  textCaseRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      appState.textCase = e.target.value;
      applySettingsState();
    });
  });

  positionRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      appState.position = e.target.value;
      applySettingsState();
    });
  });
}

function openDrawer(isOpen) {
  if (isOpen) {
    settingsSidebar.classList.add("open");
    overlayBackdrop.classList.add("open");
  } else {
    settingsSidebar.classList.remove("open");
    overlayBackdrop.classList.remove("open");
  }
}

// ==========================================================================
// 9. Transcript Editor Logic
// ==========================================================================
function bindTranscriptEvents() {
  btnApplyRender.addEventListener("click", triggerRegeneration);
}

function renderTranscriptEditor() {
  transcriptCard.style.display = "flex";
  transcriptWordsContainer.innerHTML = "";
  transcriptWordCount.textContent = `${appState.words.length} words`;

  appState.words.forEach((wordObj, idx) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.contentEditable = "true";
    chip.spellcheck = false;
    chip.textContent = wordObj.word || '';
    chip.dataset.index = idx;
    chip.dataset.originalText = wordObj.word || '';

    // Mark edited words visually
    chip.addEventListener("input", () => {
      const currentText = chip.textContent.trim();
      if (currentText !== chip.dataset.originalText) {
        chip.classList.add("edited");
      } else {
        chip.classList.remove("edited");
      }
    });

    // Prevent newlines inside the chip
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        chip.blur();
      }
    });

    transcriptWordsContainer.appendChild(chip);
  });
}

function collectEditedWords() {
  const chips = transcriptWordsContainer.querySelectorAll(".word-chip");
  return Array.from(chips).map((chip, idx) => {
    const originalWord = appState.words[idx];
    return {
      word: chip.textContent.trim(),
      start: originalWord.start,
      end: originalWord.end
    };
  });
}

async function triggerRegeneration() {
  if (!appState.baseName || appState.isProcessing) return;

  const editedWords = collectEditedWords();
  if (editedWords.length === 0) {
    showToast("No words to render.");
    return;
  }

  appState.isProcessing = true;
  btnApplyRender.disabled = true;
  showToast("Regenerating captions...");

  // Show processing state on preview
  stateVideo.classList.remove("active");
  stateProcessing.classList.add("active");
  previewProcessingTitle.textContent = "Re-rendering captions...";

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';

  try {
    const response = await fetch(`${apiBaseUrl}/api/upload/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseName: appState.baseName,
        words: editedWords,
        styles: {
          fontFamily: appState.fontFamily,
          fontSize: appState.fontSize.toString(),
          textCase: appState.textCase,
          position: appState.position,
          preset: appState.currentPreset
        }
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || 'Regeneration failed');
    }

    const result = await response.json();
    console.log('Regeneration result:', result);

    // Update the rendered video path
    appState.renderedVideoPath = result.renderedVideoPath;

    // Update local words state with edits
    appState.words = editedWords;

    // Mark all chips as no longer edited (they are now the source of truth)
    const chips = transcriptWordsContainer.querySelectorAll(".word-chip");
    chips.forEach(chip => {
      chip.dataset.originalText = chip.textContent.trim();
      chip.classList.remove("edited");
    });

    // Show video state again
    stateProcessing.classList.remove("active");
    stateVideo.classList.add("active");

    showToast("Captions regenerated successfully!");

  } catch (err) {
    console.error('Regeneration error:', err);
    showToast(`Regeneration failed: ${err.message}`);

    // Restore video preview
    stateProcessing.classList.remove("active");
    stateVideo.classList.add("active");
  } finally {
    appState.isProcessing = false;
    btnApplyRender.disabled = false;
  }
}

// Start Main App execution
document.addEventListener("DOMContentLoaded", init);
export default {};
