// The tool dock has two levels (see src/components/ToolDock.jsx): five
// section tabs, and the chosen section's tools. A tool is only on screen once
// its section is chosen — exactly as for a person — so tests open it the way
// a person does: section tab first, then the tool.
export const TOOL_SECTIONS = {
  Text: 'Captions', Style: 'Captions', Animate: 'Captions', Entrance: 'Captions', Position: 'Captions',
  Keywords: 'Words', Highlight: 'Words', Word: 'Words',
  Overlay: 'Add', Image: 'Add', Shape: 'Add', Audio: 'Add',
  Layers: 'Scene', Objects: 'Scene', Canvas: 'Scene',
  Video: 'Project', Transcript: 'Project'
};

/** The dock button for a tool, with its section showing. */
export async function toolButton(page, name) {
  const section = TOOL_SECTIONS[name];
  if (!section) throw new Error(`No dock tool called "${name}"`);
  const tab = page.getByRole('tab', { name: section, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  return page.locator('#dock-tools').getByRole('button', { name, exact: true });
}

/** Clicks a dock tool (opening its section first if needed). */
export async function openTool(page, name) {
  await (await toolButton(page, name)).click();
}

/**
 * Makes sure a tool's panel is OPEN: clicks it only when it isn't already.
 * (Since V2.3.1 selecting an audio clip or a caption opens its panel by
 * itself, and a dock button toggles its panel, so a blind click could close
 * the very panel a test wants to read.)
 */
export async function showTool(page, name) {
  const button = await toolButton(page, name);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
}
