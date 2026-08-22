# Caption Studio — UI color update

## Goal
Replace the current dark-navy-and-blue theme (the default look most AI-generated apps ship with) with a warm charcoal-and-terracotta theme. Keep the existing layout, spacing, and components exactly as they are — this is a color-only change.

Do not touch caption/text styling in the video preview (Typography, Style & Colors panels) — this only affects the app's own UI chrome: backgrounds, panels, buttons, borders, badges, and status indicators.

## Color palette

Define these once (CSS custom properties, or a Tailwind theme extension) and reference them everywhere — do not hardcode hex values inline in components.

### Backgrounds
| Token | Hex | Used for |
|---|---|---|
| `--bg-page` | `#1A1613` | Outer app background, video preview canvas |
| `--bg-panel` | `#211C17` | Sidebar panels (Caption Inspector, Video Inspector) |
| `--bg-elevated` | `#2A241E` | Hover states, input fields, active tab background |

### Text
| Token | Hex | Used for |
|---|---|---|
| `--text-primary` | `#F0EAE1` | Headings, primary labels, values |
| `--text-secondary` | `#B8AC9C` | Secondary labels, inactive tabs |
| `--text-muted` | `#8A7F70` | Placeholder text, section eyebrows (e.g. "PRESET PROFILE") |

### Borders
| Token | Hex | Used for |
|---|---|---|
| `--border` | `#3A332B` | Default hairlines, unselected button/chip borders, dividers |
| `--border-strong` | `#4A4136` | Emphasized dividers |

### Accent — terracotta (replaces all current blue)
| Token | Hex | Used for |
|---|---|---|
| `--accent` | `#D97757` | Primary button fill (Generate Video), selected preset border/text, active tab underline |
| `--accent-hover` | `#C2653F` | Hover state for accent-filled buttons |
| `--text-on-accent` | `#1A1613` | Text/icon color sitting on top of a filled accent button |
| `--accent-wash-bg` | `#3A2A20` | Background for small badges (e.g. "PRO" tag, font/style tags) |
| `--accent-wash-text` | `#E8A587` | Text color on accent-wash backgrounds |

### Status (kept separate from the brand accent — do not reuse `--accent` for this)
| Token | Hex | Used for |
|---|---|---|
| `--status` | `#8FA876` | "Ready" tag, "LIVE WYSIWYG" indicator dot/text |

## Element-by-element mapping
- **App background / video canvas** → `--bg-page`
- **Left sidebar & right sidebar panels** → `--bg-panel`
- **"Reset Style" / "Import Video" buttons** → transparent fill, `--border`, `--text-secondary`
- **"Generate Video" button** → fill `--accent`, hover `--accent-hover`, text `--text-on-accent`
- **Selected preset chip (e.g. "Yellow")** → border `--accent`, text `--accent`
- **Unselected preset chips** → border `--border`, text `--text-secondary`
- **"PRO" badge** → background `--accent-wash-bg`, text `--accent-wash-text`
- **Font/style tags (e.g. "Montserrat", "Karaoke")** → background `--bg-elevated`, text `--text-secondary`; the one meant to stand out uses `--accent-wash-bg` / `--accent-wash-text`
- **"Ready" status tag / "LIVE WYSIWYG" dot** → `--status` (do not use `--accent` here)
- **Tooltips** → background `--bg-panel`, border `--border`, text `--text-secondary`
- **All dividers/hairlines** → `--border`

## Implementation notes for Claude Code
1. Search the codebase for all current hardcoded color values (the existing navy/slate background and blue accent, likely something close to `#0f1729` / `#3b82f6` or Tailwind `slate-900` / `blue-500`) and replace them with the tokens above — don't leave any old hex values behind.
2. Centralize the tokens (CSS custom properties on `:root`, or a Tailwind `theme.extend.colors` block) so future changes are a one-line edit, not a find-and-replace.
3. Keep `--status` reserved for "ready/live" type indicators only. Everything else that currently uses the old blue accent should move to `--accent`.
4. After the swap, do a quick visual pass to confirm text stays readable against every background layer (primary text on panel/elevated backgrounds, accent-on-fill text on the Generate Video button, wash text on badge backgrounds).
5. This is a palette swap only — no layout, spacing, or component structure changes.
