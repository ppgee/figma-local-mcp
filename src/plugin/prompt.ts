export function createNodePrompt(node: { id: string; name: string }): string {
  const name = node.name.replace(/\s+/g, ' ').trim() || 'Untitled node';
  return `Use figma-local to analyze the Figma node "${name}".\nnodeId: ${node.id}\n\nCall get_design_context and get_screenshot, then analyze this node's layout, text, styles, components and variable bindings.\nRead-only: do not modify the Figma file.`;
}
