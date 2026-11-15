/**
 * The tool dock — two levels instead of one long strip.
 *
 *   Level 1: the five SECTIONS (Captions · Words · Add · Scene · Project), a
 *            proper tab bar.
 *   Level 2: only the chosen section's TOOLS — never more than five at once.
 *
 * So the eye meets at most ten targets, and a phone never needs to scroll
 * sideways to reach a tool. Layout is CSS (see .bhynd-dock in style.css):
 *   - compact (phones, folded foldables): tools row above a bottom tab bar,
 *     the way native mobile apps are laid out;
 *   - medium/expanded (tablets, unfolded foldables, laptops): one row —
 *     sections on the left, their tools to the right.
 *
 * The chosen section is a per-viewer preference (workspaceStore). When a
 * tool's panel opens by other means (selecting an overlay on the video, say),
 * App moves the dock to that tool's section, so what is open is always in
 * view.
 */
import { forwardRef, useRef } from 'react';

const SECTION_ICONS = {
  Captions: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6" /></svg>,
  Words: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18 8 6l5 12M4.9 13.5h6.2" /><circle cx="17.5" cy="15.5" r="2.5" /><path d="M20 13v5" /></svg>,
  Add: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8v8M8 12h8" /></svg>,
  Scene: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7.5 4 6v11l3 1.5" opacity=".55" /><path d="M11 8 8 6.5v11l3 1.5" opacity=".8" /><path d="m12 6 8 3v8l-8 3z" /></svg>,
  Project: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
};

export const ToolDock = forwardRef(function ToolDock({ sections, activeSection, onSectionChange, isToolOpen, onToolClick }, ref) {
  const tabRefs = useRef({});
  const current = sections.find((s) => s.name === activeSection) || sections[0];

  // Arrow keys move between sections, Home/End jump to the ends — the
  // standard tab-bar keyboard pattern.
  const onTabKeyDown = (e, index) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
    let next = null;
    if (step) next = (index + step + sections.length) % sections.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = sections.length - 1;
    if (next == null) return;
    e.preventDefault();
    const name = sections[next].name;
    onSectionChange(name);
    tabRefs.current[name]?.focus();
  };

  return (
    <nav ref={ref} aria-label="Tools" className="bhynd-dock">
      <div className="bhynd-dock-inner">
        <div className="bhynd-dock-tabs" role="tablist" aria-label="Tool sections">
          {sections.map((section, index) => {
            const selected = section.name === current.name;
            // A tool from a section that isn't showing is open: say so with a
            // dot, so the open panel can always be traced back to its tab.
            const hasOpen = !selected && section.tools.some((t) => isToolOpen(t.key));
            return (
              <button
                key={section.name}
                ref={(el) => { tabRefs.current[section.name] = el; }}
                type="button"
                role="tab"
                id={`dock-tab-${section.name.toLowerCase()}`}
                aria-selected={selected}
                aria-controls="dock-tools"
                tabIndex={selected ? 0 : -1}
                onClick={() => onSectionChange(section.name)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
                className={`bhynd-dock-tab${selected ? ' is-selected' : ''}`}
              >
                {SECTION_ICONS[section.name]}
                <span>{section.name}</span>
                {hasOpen && <i className="bhynd-dock-tab-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        <span className="bhynd-dock-divider" aria-hidden="true" />

        <div
          key={current.name}
          id="dock-tools"
          role="tabpanel"
          aria-labelledby={`dock-tab-${current.name.toLowerCase()}`}
          className="bhynd-dock-tools"
        >
          {current.tools.map((tool, index) => {
            const open = isToolOpen(tool.key);
            return (
              <button
                key={tool.key}
                type="button"
                aria-pressed={open}
                title={tool.title}
                onClick={() => onToolClick(tool)}
                className={`bhynd-dock-btn${open ? ' is-active' : ''}`}
                style={{ '--i': index }}
              >
                {tool.icon}
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
});
