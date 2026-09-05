# Caption Studio — UI color update (mint / black)

## Goal
Replace the app's current color theme with a near-black + spring-mint theme. Keep the existing layout, spacing, and components exactly as they are — this is a color-only change.

Do not touch caption/text styling in the video preview (Typography, Style & Colors panels) — this only affects the app's own UI chrome: backgrounds, panels, buttons, borders, badges, and status indicators.

## Color palette

Define these once (CSS custom properties, or a Tailwind theme extension) and reference them everywhere — do not hardcode hex values inline in components.

### Backgrounds
| Token | Hex | Used for |
|---|---|---|
| `--bg-page` | `#020202` | Outer app background, video preview canvas |
| `--bg-panel` | `#101010` | Sidebar panels (Caption Inspector, Video Inspector) |
| `--bg-elevated` | `#1B1B1B` | Hover states, input fields, active tab background |

### Text
| Token | Hex | Used for |
|---|---|---|
| `--text-primary` | `#FFFFFF` | Headings, primary labels, values |
| `--text-secondary` | `#9A9A9A` | Secondary labels, inactive tabs |
| `--text-muted` | `#5C5C5C` | Placeholder text, section eyebrows (e.g. "PRESET PROFILE") |

### Borders
| Token | Hex | Used for |
|---|---|---|
| `--border` | `#262626` | Default hairlines, unselected button/chip borders, dividers |
| `--border-strong` | `#333333` | Emphasized dividers |

### Accent — mint (replaces the previous blue)
| Token | Hex | Used for |
|---|---|---|
| `--accent` | `#00F6AC` | Primary button fill (Generate Video), selected preset border/text, active tab underline |
| `--accent-hover` | `#00D999` | Hover state for accent-filled buttons |
| `--text-on-accent` | `#020202` | Text/icon color sitting on top of a filled accent button |
| `--accent-wash-bg` | `#082A20` | Background for small badges (e.g. "PRO" tag, style tags) |
| `--accent-wash-text` | `#4FF0BE` | Text color on accent-wash backgrounds |

### Status
| Token | Hex | Used for |
|---|---|---|
| `--status` | `#00F6AC` (same as `--accent`) | "Ready" tag, "LIVE WYSIWYG" indicator dot/text |

Note: mint intentionally doubles as both the brand accent and the "ready/live" status color — green already reads as "go," so no separate status color is needed here (unlike a generic blue theme, where reusing one color for everything reads as lazy).

### Supplementary accents
These aren't used anywhere in the current UI yet, but the app will need them eventually — add them now so they exist when a feature needs them, rather than improvising a color later.
| Token | Hex | Used for |
|---|---|---|
| `--accent-secondary` | `#F2B84B` (amber) | A second badge/tag color, for when more than one tag type needs to be visually distinct from the mint accent |
| `--error` | `#FF5C5C` (red) | Destructive actions, delete confirmations, error/validation states |

## Element-by-element mapping
- **App background / video canvas** → `--bg-page`
- **Left sidebar & right sidebar panels** → `--bg-panel`
- **"Reset Style" / "Import Video" buttons** → transparent fill, `--border`, `--text-secondary`
- **"Generate Video" button** → fill `--accent`, hover `--accent-hover`, text `--text-on-accent`
- **Selected preset chip (e.g. "Yellow")** → border `--accent`, text `--accent`
- **Unselected preset chips** → border `--border`, text `--text-secondary`
- **"PRO" badge** → background `--accent-wash-bg`, text `--accent-wash-text`
- **Font/style tags (e.g. "Montserrat", "Karaoke")** → background `--bg-elevated`, text `--text-secondary`; the one meant to stand out uses `--accent-wash-bg` / `--accent-wash-text`
- **"Ready" status tag / "LIVE WYSIWYG" dot** → `--status`
- **Tooltips** → background `--bg-panel`, border `--border`, text `--text-secondary`
- **All dividers/hairlines** → `--border`
- **Any future delete/destructive action** → `--error`
- **Any future secondary tag/badge type** → `--accent-secondary`

## Implementation notes for Claude Code
1. Search the codebase for all current hardcoded color values (the old background and accent colors) and replace them with the tokens above — don't leave any old hex values behind.
2. Centralize the tokens (CSS custom properties on `:root`, or a Tailwind `theme.extend.colors` block) so future changes are a one-line edit, not a find-and-replace.
3. `--accent-secondary` and `--error` aren't used anywhere yet — just add them to the token set so they're available when a feature needs them. Don't force them onto existing UI.
4. Because this is a high-contrast palette (near-black base, one very bright accent), double-check that `--text-secondary` and `--text-muted` render clearly on both `--bg-page` and `--bg-panel` — those are the two grays doing the most work to keep the UI from feeling flat.
5. This is a palette swap only — no layout, spacing, or component structure changes.