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
