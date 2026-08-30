/**
 * Reusable color-picker control: a swatch trigger button that opens a
 * shadcn/ui-style popover (Radix Popover + react-colorful, the same
 * underlying stack Kibo UI's own shadcn-registry color picker uses)
 * supporting a visual gradient/hue/alpha picker plus HEX/RGB/HSL tabs.
 *
 * Session lifecycle (Cancel/X/outside-click/switching-fields all discard;
 * Apply commits):
 *
 *   OPEN → snapshot the committed {hex, opacity} → seed temp value
 *   drag/type → live-write to appState (onChange) so the canvas preview
 *     updates instantly, same "LIVE WYSIWYG" behavior the rest of the
 *     sidebar's controls already have
 *   CANCEL / X / outside click / Escape / switching to a different field's
 *     picker → restore the snapshot (onChange back to the original values)
 *   APPLY → just close; the live-written value already IS the committed one
 *
 * All of this funnels through a single effect watching the `open` prop's
 * transitions (see below) rather than trying to special-case each dismissal
 * path separately — Radix's outside-click/Escape, the parent switching to a
 * different field, and this component's own Cancel/X button all look
 * identical from here: "open went from true to false, and it wasn't via
 * Apply." That uniformity is deliberate: the previous implementation's bugs
 * came from having outside-click, Escape, and the close button each wire up
 * their own dismissal path by hand.
 *
 * Opacity is intentionally NOT part of every field's session: the app's
 * existing state only has a genuine opacity concept for some color fields
 * (see SidebarInspector.jsx's FIELD_OPACITY_MAP) — passing `opacity={null}`
 * (the default) hides the alpha UI entirely and uses react-colorful's plain
 * HexColorPicker, so this component never invents a renderer behavior that
 * doesn't already exist.
 */
import { useEffect, useRef, useState } from 'react';
import { HexColorPicker, HexAlphaColorPicker, HexColorInput } from 'react-colorful';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs.jsx';
import {
  hexToRgb, rgbToHex, hexToHsl, hslToHex, clampOpacity,
  hex6AndOpacityToHex8, hex8ToHex6AndOpacity, normalizeHex6
} from '../lib/colorConversion.js';

const NUMBER_FIELD = 'w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] text-[13px] px-2 py-1.5 text-center outline-none focus:border-[var(--accent-color)]';
const NUMBER_LABEL = 'text-[10px] font-semibold text-[var(--text-muted)] text-center block mt-1';

export function ColorPickerField({
  label,
  triggerId,
  value,
  opacity = null,
  opacityLabel = 'Opacity',
  open,
  onOpenChange,
  onChange
}) {
  const [tempHex8, setTempHex8] = useState(() => hex6AndOpacityToHex8(value, opacity ?? 100));
  // The HEX tab's <HexColorInput> is controlled SEPARATELY from tempHex8/hex6
  // (see commitLive's own comment for why) — its `color` prop must always be
  // fed back EXACTLY what it last reported, never a re-normalized value.
  const [hexInputValue, setHexInputValue] = useState(() => normalizeHex6(value));
  const originalRef = useRef({ hex: value, opacity });
  const justAppliedRef = useRef(false);
  const wasOpenRef = useRef(open);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      // closed -> open: snapshot the committed value and seed the session
      originalRef.current = { hex: value, opacity };
      setTempHex8(hex6AndOpacityToHex8(value, opacity ?? 100));
      setHexInputValue(normalizeHex6(value));
    } else if (!open && wasOpenRef.current && !justAppliedRef.current) {
      // open -> closed via anything other than Apply (Cancel, X, outside
      // click, Escape, or the parent switching to a different field) —
      // restore exactly what was committed before this session began.
      onChange(originalRef.current.hex, originalRef.current.opacity);
    }
    justAppliedRef.current = false;
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { hex6: tempHex6, opacity: currentOpacity } = hex8ToHex6AndOpacity(tempHex8);
  // The swatch button is ALWAYS in the tree (only the popover CONTENT is
  // conditionally rendered), so it needs a value even while closed — and
  // while closed, that must be the actual committed `value`/`opacity` PROPS,
  // never the local tempHex8 session state. tempHex8 is only reset back in
  // sync with a reverted/committed value on the NEXT open (see the effect
  // above); reading it directly here while closed showed a stale in-session
  // color for a moment after Cancel/X/outside-click reverted appState —
  // confirmed directly: appState reverted correctly, but the swatch itself
  // kept displaying the cancelled color until the picker was reopened.
  const hex6 = open ? tempHex6 : normalizeHex6(value);
  const displayOpacity = open ? currentOpacity : (opacity ?? 100);
  const rgb = hexToRgb(hex6);
  const hsl = hexToHsl(hex6);
  const hasOpacity = opacity !== null;

  /**
   * Used by every source EXCEPT the HEX text input itself (RGB/HSL tabs,
   * preset/recent swatches, the visual gradient/hue/alpha area) — these all
   * produce a real, already-complete color, so re-syncing the HEX tab's own
   * display to match is exactly what the user would expect if they switch
   * to that tab afterward.
   */
  function commitLive(nextHex6, nextOpacity) {
    const normalized = normalizeHex6(nextHex6);
    setTempHex8(hasOpacity ? hex6AndOpacityToHex8(normalized, nextOpacity) : `${normalized}FF`);
    setHexInputValue(normalized);
    onChange(normalized, hasOpacity ? clampOpacity(nextOpacity) : null);
  }

  /**
   * The HEX text input's own onChange — deliberately does NOT reuse
   * commitLive's re-normalization for what gets fed back into the input's
   * OWN `color` prop. react-colorful's HexColorInput calls onChange the
   * moment its internal length-validator passes (3, 6, or with alpha 4/8
   * hex digits) — which happens naturally mid-typing (typing "2E8B57"
   * passes through the valid 3-digit shorthand "2E8" first). Feeding back
   * anything OTHER than that exact string (e.g. the 6-digit-expanded
   * "22EE88") makes react-colorful's own internal re-sync effect overwrite
   * what's displayed with a value the user didn't type, at a different
   * length than expected — confirmed directly: doing that silently dropped
   * every keystroke typed after that point. Echoing back the exact value
   * keeps the input's controlled round-trip a no-op, so typing continues
   * normally; normalization for the REST of the app (swatch color, appState)
   * still happens via commitLive below, just without touching what's shown
   * in this specific field.
   */
  function handleHexInputChange(rawHex) {
    setHexInputValue(rawHex);
    const normalized = normalizeHex6(rawHex);
    setTempHex8(hasOpacity ? hex6AndOpacityToHex8(normalized, currentOpacity) : `${normalized}FF`);
    onChange(normalized, hasOpacity ? clampOpacity(currentOpacity) : null);
  }

  function handleVisualChange(nextHex8) {
    setTempHex8(nextHex8);
    const { hex6: h, opacity: o } = hex8ToHex6AndOpacity(nextHex8);
    setHexInputValue(h);
    onChange(h, hasOpacity ? o : null);
  }

  function handleApply() {
    justAppliedRef.current = true;
    onOpenChange(false);
  }

  function handleCancel() {
    onOpenChange(false);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          className="color-swatch-trigger w-8 h-8 rounded-full border-2 border-[var(--border-color)] cursor-pointer p-0
            transition-[transform,border-color] duration-150 hover:scale-[1.08] hover:border-[var(--border-color-hover)]"
          style={{ background: hasOpacity ? tempHex8AsCss(hex6, displayOpacity) : hex6 }}
          aria-label={label}
        />
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="text-xs font-bold text-[var(--text-primary)]">{label}</div>
          <button
            type="button"
            aria-label="Cancel"
            onClick={handleCancel}
            className="shrink-0 w-5 h-5 leading-none flex items-center justify-center border-0 bg-transparent text-[var(--text-muted)] text-base cursor-pointer rounded-[var(--radius-sm)] p-0 hover:text-[var(--text-primary)] hover:bg-[var(--bg-input)]"
          >
            ×
          </button>
        </div>

        {hasOpacity ? (
          <HexAlphaColorPicker color={tempHex8} onChange={handleVisualChange} className="!w-full" />
        ) : (
          <HexColorPicker color={hex6} onChange={(h) => commitLive(h, null)} className="!w-full" />
        )}

        <Tabs defaultValue="hex" className="mt-2.5">
          <TabsList>
            <TabsTrigger value="hex">HEX</TabsTrigger>
            <TabsTrigger value="rgb">RGB</TabsTrigger>
            <TabsTrigger value="hsl">HSL</TabsTrigger>
          </TabsList>

          <TabsContent value="hex">
            <div className="flex gap-2 items-start">
              <div className="flex-1">
                <HexColorInput
                  color={hexInputValue}
                  onChange={handleHexInputChange}
                  prefixed
                  className={NUMBER_FIELD}
                />
                <span className={NUMBER_LABEL}>HEX</span>
              </div>
              {hasOpacity && (
                <div className="w-16">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={Math.round(currentOpacity)}
                    onChange={(e) => commitLive(hex6, Number(e.target.value))}
                    className={NUMBER_FIELD}
                  />
                  <span className={NUMBER_LABEL}>{opacityLabel}</span>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="rgb">
            <div className="flex gap-2">
              {['r', 'g', 'b'].map((channel) => (
                <div key={channel} className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={Math.round(rgb[channel])}
                    onChange={(e) => commitLive(rgbToHex({ ...rgb, [channel]: Number(e.target.value) }), currentOpacity)}
                    className={NUMBER_FIELD}
                  />
                  <span className={NUMBER_LABEL}>{channel.toUpperCase()}</span>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="hsl">
            <div className="flex gap-2">
              <div className="flex-1">
                <input
                  type="number"
                  min={0}
                  max={360}
                  value={Math.round(hsl.h)}
                  onChange={(e) => commitLive(hslToHex({ ...hsl, h: Number(e.target.value) }), currentOpacity)}
                  className={NUMBER_FIELD}
                />
                <span className={NUMBER_LABEL}>H</span>
              </div>
              <div className="flex-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(hsl.s)}
                  onChange={(e) => commitLive(hslToHex({ ...hsl, s: Number(e.target.value) }), currentOpacity)}
                  className={NUMBER_FIELD}
                />
                <span className={NUMBER_LABEL}>S</span>
              </div>
              <div className="flex-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(hsl.l)}
                  onChange={(e) => commitLive(hslToHex({ ...hsl, l: Number(e.target.value) }), currentOpacity)}
                  className={NUMBER_FIELD}
                />
                <span className={NUMBER_LABEL}>L</span>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={handleCancel}
            className="flex-1 h-8 text-xs font-semibold rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-transparent text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--bg-card-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="flex-1 h-8 text-xs font-bold rounded-[var(--radius-sm)] border-0 bg-[var(--accent-gradient)] text-[var(--text-on-accent)] cursor-pointer hover:bg-[var(--accent-hover)]"
          >
            Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function tempHex8AsCss(hex6, opacity) {
  const { r, g, b } = hexToRgb(hex6);
  return `rgba(${r}, ${g}, ${b}, ${clampOpacity(opacity) / 100})`;
}
