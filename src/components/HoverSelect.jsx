/**
 * A dropdown that shows each option on the video while you hover it.
 *
 * WHY IT EXISTS. A native <select> hands its open list to the operating
 * system, and the browser never tells the page which item the pointer is over —
 * so "hover a font and see it" cannot be built on one. This draws its own list
 * (so it CAN be hovered) and looks like the select it replaces.
 *
 * TWO WAYS TO USE IT
 *
 *   Controlled — `value`, `options`, `onChange`: for the React-owned inspectors
 *   (text elements, per-word style).
 *
 *   Drop-in for a native <select> — pass the same `id`, `defaultValue` and
 *   <option> children. The real <select> is still rendered (hidden), so the
 *   imperative wiring in sidebarInspector.js that finds it by id, listens for
 *   its `change` and sets its `.value` keeps working untouched; choosing here
 *   sets that select's value and fires its `change`, and this control follows
 *   whatever value the legacy code puts there.
 *
 * `preview(value)` returns an appState patch to show while hovering that item
 * (applied through hoverPreview.previewState); or pass `onPreview(value)` to
 * preview something else (a text element, a word). Leaving the list, closing it
 * or choosing ends the preview — and a choice ends it BEFORE committing, which
 * is what keeps Undo working (see src/js/hoverPreview.js).
 */
import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { subscribe } from '../js/state.js';
import { previewState, endPreview } from '../js/hoverPreview.js';

const ITEM = `w-full text-left px-2.5 py-1.5 rounded-[var(--radius-sm)] border-0 bg-transparent cursor-pointer
  text-[13px] text-[var(--text-primary)] truncate`;

/** The text inside an <option>, whatever it is wrapped in. */
function textOf(node) {
  return Children.toArray(node)
    .map((child) => (isValidElement(child) ? textOf(child.props.children) : String(child)))
    .join('');
}

/**
 * The <option> children as a flat list — { value, label } for an option and
 * { group } for an <optgroup>'s heading (the font list is grouped). Works for
 * a mapped array of options too.
 */
function optionsFromChildren(children) {
  const out = [];
  const visit = (nodes) => {
    Children.toArray(nodes).forEach((child) => {
      if (!isValidElement(child)) return;
      if (child.type === 'optgroup') {
        out.push({ group: child.props.label });
        visit(child.props.children);
        return;
      }
      const label = textOf(child.props.children);
      out.push({ value: child.props.value != null ? String(child.props.value) : label, label });
    });
  };
  visit(children);
  return out;
}

export function HoverSelect({
  id,
  className = '',
  children,
  options: optionsProp,
  value: valueProp,
  defaultValue,
  onChange,
  preview,
  onPreview,
  'aria-label': ariaLabel
}) {
  const options = useMemo(() => optionsProp || optionsFromChildren(children), [optionsProp, children]);
  const nativeRef = useRef(null);
  const legacy = valueProp === undefined; // no `value` => a drop-in for an uncontrolled <select>
  const [legacyValue, setLegacyValue] = useState(defaultValue ?? options.find((o) => !o.group)?.value ?? '');
  const [open, setOpen] = useState(false);
  const current = legacy ? legacyValue : valueProp;

  // Follow whatever the legacy wiring sets on the hidden <select>. It writes
  // `.value` without an event, so the only way to see it is to look — after
  // each state change (that is when sidebarInspector.js's own sync runs) and a
  // couple of times at start-up, once it has initialised.
  const syncFromNative = useCallback(() => {
    const native = nativeRef.current;
    if (native && native.value !== legacyValue) setLegacyValue(native.value);
  }, [legacyValue]);
  useEffect(() => {
    if (!legacy) return undefined;
    const later = () => requestAnimationFrame(syncFromNative);
    const stop = subscribe('*', later);
    const timers = [0, 150, 600].map((ms) => setTimeout(later, ms));
    return () => { stop(); timers.forEach(clearTimeout); };
  }, [legacy, syncFromNative]);

  const showPreview = useCallback((value) => {
    if (preview) previewState(preview(value));
    else onPreview?.(value);
  }, [preview, onPreview]);

  // Closed without choosing (Escape, clicking away): the video goes back.
  const handleOpenChange = useCallback((next) => {
    setOpen(next);
    if (!next) endPreview();
  }, []);

  const choose = useCallback((value) => {
    // First, undo the hover. The real edit snapshots the state it finds for
    // Undo; with the hovered value still applied, that snapshot would already
    // hold the new value and Undo would do nothing.
    endPreview();
    if (legacy) {
      const native = nativeRef.current;
      if (native) {
        native.value = value;
        native.dispatchEvent(new Event('input', { bubbles: true }));
        native.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setLegacyValue(value);
    }
    onChange?.(value);
    setOpen(false);
  }, [legacy, onChange]);

  const currentLabel = options.find((o) => !o.group && o.value === current)?.label ?? current ?? '';

  return (
    <>
      {legacy && (
        <select ref={nativeRef} id={id} defaultValue={defaultValue} hidden tabIndex={-1} aria-hidden="true">
          {children}
        </select>
      )}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={legacy ? `${id}-trigger` : id}
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            className={`${className} flex items-center justify-between gap-2 text-left cursor-pointer`}
          >
            <span className="truncate">{currentLabel}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0 text-[var(--text-secondary)]">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          // The list is as wide as the control, and scrolls inside the viewport.
          className="p-1 w-[var(--radix-popover-trigger-width)] min-w-[160px] max-h-[min(320px,var(--radix-popover-content-available-height))] overflow-y-auto"
          // Leaving the list puts the video back, without closing it — moving
          // the pointer out and back in is a normal way to look around.
          onPointerLeave={() => endPreview()}
          // The trigger keeps focus semantics; no need to steal it to the list.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div role="listbox" aria-label={ariaLabel}>
            {options.map((option, index) => (option.group ? (
              // A heading, not an option: nothing to hover or choose.
              <div key={`group-${index}`} role="presentation" className="px-2.5 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--text-muted)]">
                {option.group}
              </div>
            ) : (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === current}
                data-hover-option={option.value}
                className={`${ITEM} ${option.value === current ? 'bg-[var(--bg-card)] text-[var(--accent-color)]' : 'hover:bg-[var(--bg-card-hover)]'}`}
                onPointerEnter={() => showPreview(option.value)}
                onFocus={() => showPreview(option.value)}
                onClick={() => choose(option.value)}
              >
                {option.label}
              </button>
            )))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
