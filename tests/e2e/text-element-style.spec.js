import { test, expect } from '@playwright/test';

// Full style parity for text overlays — the Overlay panel
// (src/components/TextInspector.jsx) writing into an element's sparse `style`
// bag, which the shared renderer merges over getStyleParams().
//
// The requirement this covers: "Normal Text should be able to do everything
// that Caption text can visually do." So every assertion here is about
// RENDERED PIXELS on the overlay layer, never about state alone — a style key
// the renderer quietly ignores would satisfy a state-only test while being
// completely dead on screen, which is exactly how per-word styling failed the
// first time.
//
// Three of these fields (weight, italic, underline) needed the shared config
// to grow block-level support: shared/captionConfig.js's params.fontWeight /
// params.italic / params.underline, read back by shared/captionGraphics.js's
// blockFontWeight / blockSyntheticItalic / blockUnderline.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only, and a
// CORS-blocked webfont renders as a silent fallback. Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  // A transcript caption on screen throughout, so every assertion can also
  // check that styling the overlay left the caption alone.
  await page.evaluate(() => {
    const words = [
      { word: 'I', start: 0, end: 2, wordIndex: 0 },
      { word: 'AM', start: 2, end: 5, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 5, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 3; });
  await page.waitForTimeout(400);
  await page.locator('#timeline-add-text-btn').click();
  await page.evaluate(() => {
    const el = window.__appState.textElements[0];
    window.__textElements.updateTextElement(el.id, { text: 'HELLO' });
  });
  // Open the Overlay panel — the real toolbar route to these controls.
  await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  await page.waitForTimeout(500);
}

/**
 * Pixel census of ONE canvas layer: how much is drawn, where its ink sits,
 * how big its bounding box is, and how much of it matches a colour probe.
 */
function layerStats(page, canvasId, probe) {
  return page.evaluate(({ id, probe }) => {
    const c = document.getElementById(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0, hits = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) {
        const p = i / 4;
        const px = p % c.width, py = Math.floor(p / c.width);
        n++; sx += px; sy += py;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (probe && Math.abs(d[i] - probe[0]) < 60 && Math.abs(d[i + 1] - probe[1]) < 60 && Math.abs(d[i + 2] - probe[2]) < 60) hits++;
      }
    }
    if (!n) return { drawn: 0, cx: 0, cy: 0, bw: 0, bh: 0, probeHits: 0, slant: 0 };

    // SLANT: how far the ink's top half sits to the right of its bottom half.
    // That is precisely what italic means geometrically — whether the browser
    // used a real italic face or the renderer drew the skew itself (see
    // captionGraphics.js's SYNTHETIC_ITALIC_SKEW) — and unlike a bounding-box
    // width it can't be satisfied by a stray pixel or two of antialiasing.
    const midY = (minY + maxY) / 2;
    let tn = 0, tsx = 0, bn = 0, bsx = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) {
        const q = i / 4;
        const px = q % c.width, py = Math.floor(q / c.width);
        if (py < midY) { tn++; tsx += px; } else { bn++; bsx += px; }
      }
    }
    const slant = (tn && bn) ? (tsx / tn) - (bsx / bn) : 0;
    return { drawn: n, cx: sx / n, cy: sy / n, bw: maxX - minX + 1, bh: maxY - minY + 1, probeHits: hits, slant };
  }, { id: canvasId, probe });
}

const textStats = (page, probe) => layerStats(page, 'text-elements-canvas', probe);
const captionStats = (page) => layerStats(page, 'captions-canvas');

/** Drags a range input to an exact value and lets the render land. */
async function setSlider(page, id, value) {
  await page.locator(`#${id}`).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(450);
}

const styleOf = (page) => page.evaluate(() => window.__appState.textElements[0].style);

test('weight, italic and underline each change the rendered overlay', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  // Sized up first, on purpose. At the inherited 14px the whole overlay is
  // ~127 canvas pixels, and a weight or slant change moves that by one or
  // two — a margin indistinguishable from antialiasing noise, which would
  // make this test pass whether or not the feature worked. At 60px the same
  // changes are unmistakable.
  await setSlider(page, 'textel-size', 60);
  const base = await textStats(page);
  expect(base.drawn).toBeGreaterThan(200);

  // --- WEIGHT: a heavier face lays down measurably more ink. ---
  await page.locator('#textel-weight').selectOption('900');
  await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 15000 });
  await page.waitForTimeout(700);
  const heavy = await textStats(page);
  console.log('drawn base/900:', base.drawn, heavy.drawn);
  expect((await styleOf(page)).fontWeight).toBe('900');
  expect(heavy.drawn).toBeGreaterThan(base.drawn * 1.05);

  // --- ITALIC: a slant widens the block without adding many glyph pixels. ---
  await page.locator('#textel-weight').selectOption('');
  await page.waitForTimeout(400);
  await page.locator('#textel-italic').click();
  await page.waitForTimeout(700);
  const italic = await textStats(page);
  console.log('upright slant', base.slant.toFixed(2), '-> italic slant', italic.slant.toFixed(2),
    '| footprint', `${base.bw}x${base.bh}`, '->', `${italic.bw}x${italic.bh}`);
  expect((await styleOf(page)).italic).toBe(true);
  // The ink genuinely leans right, and the block got wider for it.
  expect(italic.slant).toBeGreaterThan(base.slant + 1.5);
  expect(italic.bw).toBeGreaterThan(base.bw);

  // --- UNDERLINE: a drawn bar, so strictly more ink than without it. ---
  await page.locator('#textel-italic').click();
  await page.waitForTimeout(400);
  const upright = await textStats(page);
  await page.locator('#textel-underline').click();
  await page.waitForTimeout(700);
  const underlined = await textStats(page);
  console.log('drawn upright/underlined:', upright.drawn, underlined.drawn);
  expect((await styleOf(page)).underline).toBe(true);
  expect(underlined.drawn).toBeGreaterThan(upright.drawn);
  expect(underlined.bh).toBeGreaterThan(upright.bh);

  expect(errs).toEqual([]);
});

test('size, colour, outline and shadow all reach the pixels', async ({ page }) => {
  await setup(page);

  const base = await textStats(page);

  // --- SIZE ---
  await setSlider(page, 'textel-size', 40);
  const bigger = await textStats(page);
  console.log('drawn base/size40:', base.drawn, bigger.drawn);
  expect((await styleOf(page)).fontSize).toBe(40);
  expect(bigger.drawn).toBeGreaterThan(base.drawn * 1.5);

  // --- COLOUR: both colour keys, which is what the panel's single "Text"
  // swatch writes (see TextInspector's applyTextColor — an overlay's words
  // are always "active", so colouring only the inactive field leaves the
  // pixels white). Driving the popover itself is covered by
  // per-word-style.spec.js; what matters here is that the colour lands. ---
  await page.evaluate(() => {
    const id = window.__appState.textElements[0].id;
    window.__textElements.updateTextElementStyle(id, { inactiveWordColor: '#FF0000', activeWordColor: '#FF0000' });
  });
  await page.waitForTimeout(600);
  const red = await textStats(page, [255, 0, 0]);
  console.log('red pixels:', red.probeHits, 'of', red.drawn);
  expect(red.probeHits).toBeGreaterThan(red.drawn * 0.3);

  // --- OUTLINE: a stroke around every glyph is strictly more ink. ---
  const beforeOutline = await textStats(page);
  await setSlider(page, 'textel-outline-size', 30);
  const outlined = await textStats(page);
  console.log('drawn pre/post outline:', beforeOutline.drawn, outlined.drawn);
  expect((await styleOf(page)).outlineSize).toBe(30);
  expect(outlined.drawn).toBeGreaterThan(beforeOutline.drawn);

  // --- SHADOW ---
  await setSlider(page, 'textel-outline-size', 0);
  const beforeShadow = await textStats(page);
  await page.locator('#textel-shadow-mode').selectOption('individual');
  await page.waitForTimeout(300);
  await setSlider(page, 'textel-shadow-size', 60);
  await setSlider(page, 'textel-shadow-x', 40);
  const shadowed = await textStats(page);
  console.log('drawn pre/post shadow:', beforeShadow.drawn, shadowed.drawn);
  expect(shadowed.drawn).toBeGreaterThan(beforeShadow.drawn);

  // The caption underneath never entered into any of this.
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms || {}).length)).toBe(0);
});

test('styling one overlay leaves the caption and a second overlay untouched', async ({ page }) => {
  await setup(page);

  // A second overlay, overlapping the first in time but placed elsewhere.
  await page.evaluate(() => {
    const el = window.__textElements.addTextElement({ kind: 'overlay', text: 'OTHER', start: 3 });
    window.__textElements.updateTextElementStyle(el.id, { position: 'manual', customPosX: 50, customPosY: 80 });
  });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(2);

  const bothBefore = await textStats(page);
  const captionBefore = await captionStats(page);

  // Restyle ONLY the first one, via the store (the panel edits whatever is
  // selected, and the second is selected right now).
  await page.evaluate(() => {
    const first = window.__appState.textElements[0];
    window.__textElements.updateTextElementStyle(first.id, { fontSize: 44, inactiveWordColor: '#00FF00', activeWordColor: '#00FF00' });
  });
  await page.waitForTimeout(700);

  const styles = await page.evaluate(() => window.__appState.textElements.map((e) => e.style));
  console.log('styles:', JSON.stringify(styles));
  // The second element's bag is untouched — no shared mutation.
  expect(styles[1].fontSize).toBeUndefined();
  expect(styles[1].inactiveWordColor).toBeUndefined();

  const bothAfter = await textStats(page, [0, 255, 0]);
  expect(bothAfter.drawn).toBeGreaterThan(bothBefore.drawn);
  // Some of the layer is green (element one) and plenty is not (element two).
  expect(bothAfter.probeHits).toBeGreaterThan(0);
  expect(bothAfter.drawn - bothAfter.probeHits).toBeGreaterThan(0);

  const captionAfter = await captionStats(page);
  expect(captionAfter.drawn).toBe(captionBefore.drawn);
  expect(Math.abs(captionAfter.cx - captionBefore.cx)).toBeLessThan(1);
});

test('"Reset to caption style" returns the overlay to inheriting', async ({ page }) => {
  await setup(page);
  const base = await textStats(page);

  await setSlider(page, 'textel-size', 48);
  await page.locator('#textel-underline').click();
  await page.waitForTimeout(600);
  const styled = await textStats(page);
  expect(styled.drawn).toBeGreaterThan(base.drawn);

  await page.locator('#textel-reset-style').click();
  await page.waitForTimeout(700);

  const style = await styleOf(page);
  console.log('style after reset:', JSON.stringify(style));
  expect(Object.keys(style).length).toBe(0);

  const reset = await textStats(page);
  // Back to exactly the inherited look it started from.
  expect(reset.drawn).toBe(base.drawn);
  // ...and the text itself survived — this resets STYLE, not content.
  expect(await page.evaluate(() => window.__appState.textElements[0].text)).toBe('HELLO');
});
