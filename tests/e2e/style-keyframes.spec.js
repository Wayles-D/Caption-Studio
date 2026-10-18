import { test, expect } from '@playwright/test';
import { evaluatePropertyAtTime, STYLE_KEYFRAME_PROPERTIES, isSteppedProperty } from '../../shared/keyframes.js';
import { resolveTextElementParams } from '../../shared/textElement.js';

// STYLE KEYFRAMES: a font (or weight, casing, colour) that CHANGES part way
// through a clip. A font cannot be interpolated, so a style keyframe holds
// until the next one and then changes outright.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(400);
}

test('a style property holds between keyframes while a numeric one eases', () => {
  STYLE_KEYFRAME_PROPERTIES.forEach((p) => expect(isSteppedProperty(p), p).toBe(true));
  expect(isSteppedProperty('scale')).toBe(false);
  const kfs = [
    { t: 1, easing: 'ease-out', values: { fontFamily: 'Montserrat', scale: 1 } },
    { t: 2.5, easing: 'ease-out', values: { fontFamily: 'Anton', scale: 2 } }
  ];
  expect(evaluatePropertyAtTime(kfs, 'fontFamily', 0.5)).toBe('Montserrat');
  expect(evaluatePropertyAtTime(kfs, 'fontFamily', 2.49)).toBe('Montserrat');
  expect(evaluatePropertyAtTime(kfs, 'fontFamily', 2.5)).toBe('Anton');
  expect(evaluatePropertyAtTime(kfs, 'fontFamily', 9)).toBe('Anton');
  // ...and the scale is still easing across the same span.
  const mid = evaluatePropertyAtTime(kfs, 'scale', 1.75);
  expect(mid).toBeGreaterThan(1);
  expect(mid).toBeLessThan(2);
});

test('the renderers resolve the element to a different font before and after the keyframe', () => {
  const element = {
    id: 'txt1', kind: 'interlude', start: 1, end: 4, text: 'PROBLEM',
    style: { fontFamily: 'Montserrat' },
    keyframes: [
      { t: 1, easing: 'ease-out', values: { fontFamily: 'Montserrat' } },
      { t: 2.5, easing: 'ease-out', values: { fontFamily: 'Anton' } }
    ]
  };
  const base = { fontFamily: 'Poppins', fontSize: 14 };
  expect(resolveTextElementParams(base, element, 1.2).fontFamily).toBe('Montserrat');
  expect(resolveTextElementParams(base, element, 2.4).fontFamily).toBe('Montserrat');
  expect(resolveTextElementParams(base, element, 3.0).fontFamily).toBe('Anton');
  // No keyframes at all: the element's own style, untouched.
  const plain = { ...element, keyframes: [] };
  expect(resolveTextElementParams(base, plain, 3.0).fontFamily).toBe('Montserrat');
});

test('a cinematic card can be given a font that changes part way through', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__textElements.addInterlude({ start: 1 }).id);
  await page.evaluate((i) => {
    window.__textElements.selectTextElement(i);
    window.__textElements.updateTextElementStyle(i, { fontFamily: 'Montserrat' });
  }, id);

  // At 1s, pin the font it starts with; at 2.5s, change it.
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 1; });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__textElements.setTextElementStyleKeyframe('fontFamily', 'Montserrat'));
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 2.5; });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__textElements.setTextElementStyleKeyframe('fontFamily', 'Anton'));

  const times = await page.evaluate(() => window.__textElements.getTextElementStyleKeyframeTimes('fontFamily'));
  expect(times.length).toBe(2);
  expect(await page.evaluate(() => window.__textElements.hasTextElementStyleKeyframes('fontFamily'))).toBe(true);

  // What each renderer would draw, at each instant.
  const fontAt = (t) => page.evaluate(([i, time]) => {
    const el = window.__textElements.getTextElement(i);
    return window.__sharedTextElement
      ? window.__sharedTextElement.resolveTextElementParams(window.__getStyleParams(), el, time).fontFamily
      : null;
  }, [id, t]);
  // Fall back to reading the stored keyframes when the shared module isn't exposed.
  const stored = await page.evaluate((i) => window.__textElements.getTextElement(i).keyframes.map((k) => [k.t, k.values.fontFamily]), id);
  expect(stored).toEqual([[1, 'Montserrat'], [2.5, 'Anton']]);

  // Changing the font now routes into a keyframe at the playhead rather than
  // flattening the animation.
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 3.5; });
  await page.waitForTimeout(250);
  await page.evaluate((i) => window.__textElements.updateTextElementStyle(i, { fontFamily: 'Bebas Neue' }), id);
  const after = await page.evaluate((i) => window.__textElements.getTextElement(i).keyframes.map((k) => [k.t, k.values.fontFamily]), id);
  expect(after.length).toBe(3);
  expect(after[2]).toEqual([3.5, 'Bebas Neue']);

  // Clearing leaves one font for the whole clip.
  await page.evaluate(() => window.__textElements.clearTextElementStyleKeyframes('fontFamily'));
  expect(await page.evaluate(() => window.__textElements.getTextElementStyleKeyframeTimes('fontFamily'))).toEqual([]);
});
