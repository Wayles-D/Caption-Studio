/**
 * Caption Studio Font Registry — the single source of truth for every font
 * bundled with the project. Both the HTML/CSS preview and the ASS/FFmpeg
 * export resolve fonts exclusively through this registry; neither renderer
 * hardcodes a font name or depends on a font already installed on the OS or
 * production server.
 *
 * The actual font files live flat inside backend/fonts/ (served statically
 * to the browser at /fonts/*, and pointed at by libass via the ASS
 * `fontsdir` option — see backend/utils/ffmpeg.js and backend/server.js).
 * Files MUST stay flat (no subdirectories): empirically verified that
 * libass's `fontsdir` loader does not recurse into subdirectories — it
 * calls fopen() directly on each directory entry, so a font placed in a
 * subfolder is silently never loaded. Per-family license/provenance docs can
 * still live in their own subfolder (see backend/fonts/PP-Editorial-New/);
 * only the font binaries themselves must be flat.
 *
 * `familyName` is the exact name that must resolve via the font's own
 * internal name-table metadata (verified per-file, not assumed from
 * filename) — this is what both the ASS `Fontname`/`\fn` value and the CSS
 * `font-family` value must be, with NO fallback list appended on either
 * side: ASS only supports a single family name, and preview must match
 * export exactly for WYSIWYG, so CSS intentionally does not append a
 * generic fallback stack either (a silent CSS-only substitution would look
 * like it "still works" while quietly breaking parity with the export).
 * "Never fail" is guaranteed by this registry's OWN resolution/fallback
 * logic always returning a bundled, real font — not by leaning on the
 * browser's or libass's own fallback behavior.
 *
 * To add a new font: drop the file flat into backend/fonts/ and add one
 * entry below. No renderer code needs to change.
 */

export const FONT_CATEGORY = {
  SANS: 'sans',
  SERIF: 'serif',
  DISPLAY: 'display',
  SCRIPT: 'script'
};

// Each font's supported "faces" (regular/italic/bold/...). Every face maps to
// one real bundled file and the exact family name that file's own metadata
// resolves under. A face's family name is NOT always the same as the font's
// displayName: some weight files register their OWN distinct legacy family
// (verified per-file via each file's name table), which is why every face
// needs its own explicit familyName rather than assuming one for the whole font.
export const FONT_REGISTRY = {
  poppins: {
    displayName: 'Poppins',
    category: FONT_CATEGORY.SANS,
    faces: {
      regular: { file: 'Poppins-Regular.ttf', familyName: 'Poppins' },
      italic: { file: 'Poppins-Italic.ttf', familyName: 'Poppins', italic: true },
      bold: { file: 'Poppins-Bold.ttf', familyName: 'Poppins', bold: true },
      medium: { file: 'Poppins-Medium.ttf', familyName: 'Poppins Medium' },
      semibold: { file: 'Poppins-SemiBold.ttf', familyName: 'Poppins SemiBold' }
    }
  },
  ppEditorialNew: {
    displayName: 'PP Editorial New',
    category: FONT_CATEGORY.SERIF,
    faces: {
      regular: { file: 'PPEditorialNew-Ultrabold-BF644b21500840c.otf', familyName: 'PP Editorial New Ultrabold' },
      italic: { file: 'PPEditorialNew-UltraboldItalic-BF644b214faef01.otf', familyName: 'PP Editorial New', italic: true },
      // No true Bold face is bundled for this family (only Ultrabold/Ultralight
      // weights exist) — Ultrabold is the closest heavier weight and, per its
      // own metadata, is a DISTINCT family ("PP Editorial New Ultrabold"), not
      // a Bold sub-style of "PP Editorial New", so it needs its own familyName
      // rather than a bold:true flag on the base family.
      bold: { file: 'PPEditorialNew-Ultrabold-BF644b21500840c.otf', familyName: 'PP Editorial New Ultrabold' }
    }
  },
  montserrat: {
    displayName: 'Montserrat',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'Montserrat.ttf', familyName: 'Montserrat' } }
  },
  bebasNeue: {
    displayName: 'Bebas Neue',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'BebasNeue-Regular.ttf', familyName: 'Bebas Neue' } }
  },
  inter: {
    displayName: 'Inter',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'Inter.ttf', familyName: 'Inter' } }
  },
  outfit: {
    displayName: 'Outfit',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'Outfit.ttf', familyName: 'Outfit' } }
  },
  plusJakartaSans: {
    displayName: 'Plus Jakarta Sans',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'PlusJakartaSans.ttf', familyName: 'Plus Jakarta Sans' } }
  },
  spaceGrotesk: {
    displayName: 'Space Grotesk',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'SpaceGrotesk.ttf', familyName: 'Space Grotesk' } }
  },
  anton: {
    displayName: 'Anton',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'Anton-Regular.ttf', familyName: 'Anton' } }
  },
  leagueSpartan: {
    displayName: 'League Spartan',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'LeagueSpartan.ttf', familyName: 'League Spartan' } }
  },
  archivoBlack: {
    displayName: 'Archivo Black',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'ArchivoBlack-Regular.ttf', familyName: 'Archivo Black' } }
  },
  lilitaOne: {
    displayName: 'Lilita One',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'LilitaOne-Regular.ttf', familyName: 'Lilita One' } }
  },
  lexend: {
    displayName: 'Lexend',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'Lexend.ttf', familyName: 'Lexend' } }
  },
  rubik: {
    displayName: 'Rubik',
    category: FONT_CATEGORY.SANS,
    faces: { regular: { file: 'Rubik.ttf', familyName: 'Rubik' } }
  },
  caveat: {
    displayName: 'Caveat',
    category: FONT_CATEGORY.SCRIPT,
    faces: { regular: { file: 'Caveat.ttf', familyName: 'Caveat' } }
  },
  kalam: {
    displayName: 'Kalam',
    category: FONT_CATEGORY.SCRIPT,
    faces: { regular: { file: 'Kalam-Regular.ttf', familyName: 'Kalam' } }
  },
  pacifico: {
    displayName: 'Pacifico',
    category: FONT_CATEGORY.SCRIPT,
    faces: { regular: { file: 'Pacifico-Regular.ttf', familyName: 'Pacifico' } }
  },
  greatVibes: {
    displayName: 'Great Vibes',
    category: FONT_CATEGORY.SCRIPT,
    faces: { regular: { file: 'GreatVibes-Regular.ttf', familyName: 'Great Vibes' } }
  },

  // Word Mode font curation: bold/tall single-word caption fonts. familyName
  // below is each file's OWN name-table Family record (verified per-file via
  // a binary 'name' table read — never assumed from the filename), per this
  // module's rule that the resolved family must be what the file itself
  // actually registers as.
  goldnic: {
    displayName: 'Goldnic',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'Goldnic-Regular.otf', familyName: 'Goldnic' } }
  },
  dominates: {
    displayName: 'Dominates',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'Dominates-Regular.otf', familyName: 'Dominates' } }
  },
  pocity: {
    displayName: 'Pocity',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'Pocity-Regular.otf', familyName: 'Pocity' } }
  },
  // NOTE: the only file added for this one is explicitly a TRIAL cut
  // ("DrukWide-Bold-Trial.otf") — its own name-table Family record is "Druk
  // Bold Trial" (Typographic Family "Druk Trial"), not "Druk Wide"; that's
  // the actual family baked into the file, so it's what familyName must be
  // (see the module-level rule above) even though the UI displayName below
  // reads "Druk Wide" per the original request. Trial cuts from foundries
  // are commonly restricted (limited weights/characters, evaluation-only
  // licensing) — swap in the licensed Druk Wide Bold file when available by
  // replacing the file and updating familyName/file below; no other code
  // needs to change.
  drukWide: {
    displayName: 'Druk Wide',
    category: FONT_CATEGORY.DISPLAY,
    faces: { regular: { file: 'DrukWide-Bold-Trial.otf', familyName: 'Druk Bold Trial' } }
  }
};

// Fallback order when a requested font isn't registered: Poppins is the true
// always-bundled terminal fallback. Export never fails and never silently
// substitutes an arbitrary system font.
export const DEFAULT_FONT_KEY = 'poppins';

function normalizeDisplayName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/['"]/g, '').split(',')[0].trim().toLowerCase();
}

/**
 * Finds a registry entry by its display name (case-insensitive, tolerant of
 * quoted/CSS-fallback-list strings — but the resolved value itself is always
 * a single bare name, never a list). Returns null if not registered.
 */
export function findFontByDisplayName(name) {
  const clean = normalizeDisplayName(name);
  if (!clean) return null;
  const key = Object.keys(FONT_REGISTRY).find((k) => FONT_REGISTRY[k].displayName.toLowerCase() === clean);
  return key ? { key, ...FONT_REGISTRY[key] } : null;
}

/**
 * Resolves a requested font-family display name + desired face ('regular',
 * 'italic', 'bold', 'medium', 'semibold', ...) to the exact bundled file and
 * resolvable family name, with graceful multi-level fallback:
 *   1. requested font's requested face
 *   2. requested font's 'regular' face (if the specific face isn't bundled)
 *   3. the default font's (Poppins) requested face
 *   4. the default font's 'regular' face
 * This never returns null and never points at a system font — the single
 * place both the CSS preview and ASS export resolve a font face from, so
 * they can never disagree.
 *
 * @param {string} requestedName - Display name as typed/selected by the user.
 * @param {string} [face='regular'] - Desired face key.
 * @returns {{key: string, displayName: string, familyName: string, file: string, italic: boolean, bold: boolean, usedFallback: boolean}}
 */
export function resolveFontFace(requestedName, face = 'regular') {
  const requested = findFontByDisplayName(requestedName);
  const fallbackFont = { key: DEFAULT_FONT_KEY, ...FONT_REGISTRY[DEFAULT_FONT_KEY] };

  const attempt = (fontEntry, faceKey) => (fontEntry?.faces ? fontEntry.faces[faceKey] : null);

  let fontEntry = requested;
  let usedFallback = !requested;
  let faceEntry = attempt(fontEntry, face);

  if (!faceEntry && fontEntry) {
    faceEntry = attempt(fontEntry, 'regular');
    usedFallback = usedFallback || face !== 'regular';
  }
  if (!faceEntry) {
    fontEntry = fallbackFont;
    usedFallback = true;
    faceEntry = attempt(fontEntry, face) || attempt(fontEntry, 'regular');
  }

  return {
    key: fontEntry.key,
    displayName: fontEntry.displayName,
    familyName: faceEntry.familyName,
    file: faceEntry.file,
    italic: !!faceEntry.italic,
    bold: !!faceEntry.bold,
    usedFallback
  };
}

/**
 * Resolves a requested font-family string to the exact CSS font-family value
 * to use — the bare registered family name only, deliberately with NO
 * fallback list appended (see module doc comment for why).
 */
export function resolveCssFontFamily(requestedName, face = 'regular') {
  const resolved = resolveFontFace(requestedName, face);
  return `'${resolved.familyName}'`;
}

/**
 * Every registered font as {value, label} pairs, in display order — the
 * single source the UI's font-family `<select>`s should be built from
 * instead of hardcoding `<option>` lists.
 */
export function listFontOptions(category) {
  return Object.entries(FONT_REGISTRY)
    .filter(([, entry]) => !category || entry.category === category)
    .map(([key, entry]) => ({ value: entry.displayName, label: entry.displayName, key }));
}
