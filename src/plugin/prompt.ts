export function createNodePrompt(node: { id: string; name: string }): string {
  const name = node.name.replace(/\s+/g, ' ').trim() || '未命名节点';
  return `使用 figma-local 分析 Figma 节点「${name}」。\nnodeId: ${node.id}\n\n调用 get_design_context 和 get_screenshot，分析该节点的布局、文本、样式、组件和变量绑定。\n只读，不要修改 Figma 文件。`;
}
