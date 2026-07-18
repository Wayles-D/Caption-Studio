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
  fontFamily: "'Geist', sans-serif",
  fontSize: 14,
  textCase: "uppercase",
  position: "bottom"
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

// ==========================================================================
// 3. Application Initialization & Subtitle Settings Binding
// ==========================================================================
function init() {
  bindUploadEvents();
  bindSidebarEvents();
  bindInteractionEvents();
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

// Binds controls on the settings panel sidebar
function applySettingsState() {
  // Update local presets style class
  subtitlesOverlay.className = "burned-subtitles-overlay";
  subtitlesOverlay.classList.add(`pos-${appState.position}`);
  
  captionsText.className = "subtitles-text";
  captionsText.classList.add(`preset-${appState.currentPreset}`);
  
  // Style properties
  subtitlesOverlay.style.fontFamily = appState.fontFamily;
  subtitlesOverlay.style.fontSize = `${appState.fontSize}px`;
  captionsText.style.textTransform = appState.textCase;
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
  
  // Disable reset / control actions during processing
  actionsPanel.classList.add("disabled");
  
  // Visual state updates: change preview pane to processing
  stateEmpty.classList.remove("active");
  stateVideo.classList.remove("active");
  stateProcessing.classList.add("active");
  
  resetTimelineComponents();
  
  // Sequenced timeline simulation steps
  runTaskTimelineStep(1, "Upload Complete", "Video uploaded successfully", 200, 1000);
}

function runTaskTimelineStep(stepNum, statusHeader, prevMsg, progressVal, delay) {
  appState.currentStep = stepNum;
  
  // Set global status bar attributes
  globalStatusText.textContent = statusHeader;
  globalStatusText.className = "status-indicator-text processing";
  globalProgressBar.style.width = `${(stepNum / 6) * 100}%`;
  
  // Activate step classes
  const targetStep = document.getElementById(getStepIdByNumber(stepNum));
  if (targetStep) {
    targetStep.className = "timeline-step active";
  }

  // Auto-complete previous timeline step
  if (stepNum > 1) {
    const prevStep = document.getElementById(getStepIdByNumber(stepNum - 1));
    if (prevStep) {
      prevStep.className = "timeline-step completed";
    }
  }

  // Update preview notch loaders
  previewProcessingTitle.textContent = statusHeader + "...";

  setTimeout(() => {
    switch(stepNum) {
      case 1:
        runTaskTimelineStep(2, "Extracting audio", "Audio data stream processing", 33, 1600);
        break;
      case 2:
        runTaskTimelineStep(3, "Generating transcript", "Transcribing speech elements", 50, 1800);
        break;
      case 3:
        runTaskTimelineStep(4, "Creating subtitles", "Creating timed caption frames", 66, 1500);
        break;
      case 4:
        runTaskTimelineStep(5, "Rendering final video", "Rendering subtitles into core video codec", 83, 1700);
        break;
      case 5:
        // Set prior step complete
        const finalBurnStep = document.getElementById(getStepIdByNumber(5));
        if (finalBurnStep) finalBurnStep.className = "timeline-step completed";
        
        // Load Ready
        runTaskTimelineStep(6, "Ready", "Ready for download", 100, 800);
        break;
      case 6:
        completeProcessingTimeline();
        break;
    }
  }, delay);
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
  showToast("Burn-in captions generated!");
}

// ==========================================================================
// 6. Subtitles Sync Logic
// ==========================================================================
function syncVideoSubtitles() {
  const currentTime = previewVideo.currentTime;
  let activeCaption = "";

  for (let i = 0; i < MOCK_SUBTITLES.length; i++) {
    const sub = MOCK_SUBTITLES[i];
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

  // Toggle screens back to empty state
  stateVideo.classList.remove("active");
  stateProcessing.classList.remove("active");
  stateEmpty.classList.add("active");

  actionsPanel.classList.add("disabled");
  resetTimelineComponents();
  
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

// Start Main App execution
document.addEventListener("DOMContentLoaded", init);
export default {};
