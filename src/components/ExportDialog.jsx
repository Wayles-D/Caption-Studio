/**
 * EXPORT SIZE — asked at every export of a video bigger than 1080p, with the
 * last choice already selected (workspaceStore.exportSize):
 *
 *   1080p, fast — what TikTok, Instagram Reels and Shorts play back. The
 *     original is shrunk once, at high quality, on the GPU, and the export
 *     runs at a quarter of the pixels (about 3x faster on a laptop).
 *   Original (4K) — full resolution: YouTube, an archive, a master copy.
 *
 * The app's own dialog (never window.confirm): theme tokens throughout, so
 * light and dark both follow. Esc or Cancel closes without exporting.
 */
import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore.js';

// HOW BIG THE FILE WILL BE. Measured on real exports from this app: a 4K
// portrait phone video came out at ~3.4 MB per second (a 3½-minute export was
// 720 MB), the same video at 1080p at ~1.1 MB per second. Between them the
// size grows with the picture's pixels to the power ~0.81 — so one rule gives
// both, and a size in between. An estimate: busy footage runs larger.
const HD_PIXELS = 1080 * 1920;
const HD_MB_PER_SECOND = 1.11;

function estimateMB(pixels, seconds) {
  if (!(pixels > 0) || !(seconds > 0)) return null;
  return HD_MB_PER_SECOND * (pixels / HD_PIXELS) ** 0.81 * seconds;
}

function formatMB(mb) {
  if (mb == null) return null;
  if (mb >= 1000) return `about ${(mb / 1000).toFixed(1)} GB`;
  const step = mb < 100 ? 5 : 10;
  return `about ${Math.max(step, Math.round(mb / step) * step)} MB`;
}

/** "4K" for a 3840-long picture, else the short side ("1440p", "2.7K" for 2688). */
function resolutionName(width, height) {
  const long = Math.max(width, height);
  if (long >= 3800) return '4K';
  if (long >= 2600) return '2.7K';
  return `${Math.min(width, height)}p`;
}

/** The background render's line for the size it is preparing (backgroundRender.js). */
function prerenderLine(prerender, value) {
  if (!prerender || prerender.exportSize !== value || !(prerender.total > 0)) return null;
  if (prerender.upToDate && prerender.ready === prerender.total) return { ready: true, text: 'Ready — exports in seconds' };
  if (!prerender.ready) return prerender.rendering ? { ready: false, text: 'Preparing in the background — starting…' } : null;
  return { ready: false, text: `Preparing in the background — ${prerender.ready} of ${prerender.total} parts done` };
}

function choicesFor(source) {
  const seconds = source?.duration || 0;
  const known = source?.width > 0 && source?.height > 0;
  const hdPixels = known ? Math.min(source.width * source.height, HD_PIXELS) : HD_PIXELS;
  return [
    {
      value: 'hd',
      title: '1080p — Fast',
      detail: 'What TikTok, Instagram Reels and YouTube Shorts play. Exports about 3× faster.',
      size: formatMB(estimateMB(hdPixels, seconds)),
      prepared: prerenderLine(source?.prerender, 'hd')
    },
    {
      value: 'original',
      title: known ? `Original quality (${resolutionName(source.width, source.height)})` : 'Original quality',
      detail: 'Full resolution — for YouTube, a master copy or your archive. Takes noticeably longer.',
      size: known ? formatMB(estimateMB(source.width * source.height, seconds)) : null,
      prepared: prerenderLine(source?.prerender, 'original')
    }
  ];
}

export function ExportDialog({ open, source, onCancel, onExport }) {
  const remembered = useWorkspaceStore((s) => s.exportSize);
  const remember = useWorkspaceStore((s) => s.setExportSize);
  const [choice, setChoice] = useState(remembered);
  const exportRef = useRef(null);

  // Opening: start from the last choice, put focus on Export, Esc cancels.
  useEffect(() => {
    if (!open) return undefined;
    setChoice(useWorkspaceStore.getState().exportSize);
    exportRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const CHOICES = choicesFor(source);
  const go = () => {
    remember(choice);
    onExport(choice);
  };
  return (
    <div
      className="fixed inset-0 z-[1100] grid place-items-center bg-black/55 backdrop-blur-[2px] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        id="export-dialog"
        className="bhynd-pop w-full max-w-[420px] rounded-2xl border border-[var(--border-color)] bg-[var(--bg-raised)] shadow-[var(--shadow-lg)] p-5 flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <h2 id="export-dialog-title" className="m-0 text-[16px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">Export</h2>
          <p className="m-0 text-[12.5px] leading-snug text-[var(--text-secondary)]">Choose the size of the file. Your original stays as it is either way. File sizes are estimates.</p>
        </div>
        <div role="radiogroup" aria-label="Export size" className="flex flex-col gap-2">
          {CHOICES.map((c) => {
            const on = choice === c.value;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={on}
                id={`export-size-${c.value}`}
                onClick={() => setChoice(c.value)}
                className={`text-left flex gap-3 items-start rounded-xl border p-3.5 cursor-pointer transition-colors duration-[var(--dur-fast)]
                  ${on
                    ? 'border-[var(--accent-color)] bg-[var(--accent-wash-bg)]'
                    : 'border-[var(--border-color)] bg-transparent hover:bg-[var(--bg-hover)]'}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 grid place-items-center
                    ${on ? 'border-[var(--accent-color)]' : 'border-[var(--border-color-hover)]'}`}
                >
                  {on && <span className="w-2 h-2 rounded-full bg-[var(--accent-color)]" />}
                </span>
                <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">{c.title}</span>
                    {c.size && (
                      <span className="shrink-0 text-[12px] font-medium text-[var(--text-secondary)] font-[family-name:var(--font-mono)] tabular-nums" data-export-size={c.value}>
                        {c.size}
                      </span>
                    )}
                  </span>
                  <span className="text-[12px] leading-snug text-[var(--text-secondary)]">{c.detail}</span>
                  {c.prepared && (
                    <span className="mt-1 flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-primary)]" data-export-prepared={c.value}>
                      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.prepared.ready ? 'bg-[var(--text-primary)]' : 'border border-[var(--text-secondary)]'}`} />
                      {c.prepared.text}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            id="export-dialog-cancel"
            onClick={onCancel}
            className="h-9 px-3.5 rounded-lg border-0 bg-transparent text-[var(--text-secondary)] text-[13px] font-medium cursor-pointer hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            ref={exportRef}
            type="button"
            id="export-dialog-go"
            onClick={go}
            className="h-9 px-4 rounded-lg border-0 bg-[var(--accent-gradient)] text-[var(--text-on-accent)] text-[13px] font-semibold cursor-pointer shadow-[var(--shadow-glow)] hover:bg-[var(--accent-hover)]"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
