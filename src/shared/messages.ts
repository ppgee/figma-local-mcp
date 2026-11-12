export type Locale = 'zh' | 'en';

const en = {
  promptTemplate: (name: string, nodeId: string, fileKey: string): string =>
    `Use figma-local to analyze the Figma node "${name}".\nnodeId: ${nodeId}\nfileKey: ${fileKey}\n\nCall get_design_context and get_screenshot, then analyze this node's layout, text, styles, components and variable bindings.\nRead-only: do not modify the Figma file.`,
  promptErrorMulti: 'Select only one layer, then copy.',
  promptErrorNone: 'Select a layer in Figma first.',
  viewSaveNotice: 'View switched, but the preference could not be saved.',
  localeSaveNotice: 'Language switched, but the preference could not be saved.',
  selectFrameFirst: 'Select a Frame or layer in Figma first.',
  selectOnlyOne: 'Select only one Frame or layer.',
  findNodesCriteria: 'Provide a query and/or types to search for.',
  pageNotFound: (pageId: string): string => `Page ${pageId} not found.`,
  nodeNotFound: (nodeId: string): string => `Node ${nodeId} not found.`,
  notCanvasNode: 'Provide the node ID of a Frame or canvas layer, not a page or document.',
  exportTooLarge: (bytes: number, max: number): string =>
    `Export result is ${bytes} bytes, exceeding the ${max}-byte limit; shrink the node or lower the export scale.`,
  unsupportedCommand: (name: string): string => `Unsupported command: ${name}`,
  unauthorized: 'Unauthorized',
  requestTooLarge: 'Request body too large.',
  unknownEndpoint: 'Unknown endpoint',
  unknownPluginCommand: 'Unknown plugin command',
  unknownResult: 'Unknown or expired command result.',
  requestFailed: 'Request failed',
  pluginNotConnected: 'Figma plugin not connected. Run the Figma Local MCP Bridge plugin (the window can be collapsed) and make sure the local service is running.',
  commandTimeout: (name: string): string => `Plugin command ${name} timed out.`,
  shuttingDown: 'Local MCP service is shutting down.',
  portOccupied: (port: number): string => `Port ${port} is occupied by another service.`,
  existingBridge: (status: number): string => `Existing bridge returned ${status}`,
  pluginExecutionFailed: 'Plugin execution failed.',
  localServiceReturned: (status: number): string => `Local service returned ${status}`,
  invalidExport: 'The plugin returned an invalid export result.',
  exportSizeLimit: 'Export result exceeds the size limit.',
  exportLengthCheck: 'Export result failed the length check.',
  screenshotTooLarge: 'Screenshot exceeds 8 MiB; lower maxDimension, or use export_node to save a file instead.',
  missingFileKey: 'Rejected: fileKey is missing. Update the Figma plugin to the same version as the local service, then rerun it.',
  serviceUnreachable: 'Local service is not running yet.',
  fileNotConnected: (fileKey: string): string =>
    `No connected Figma file matches fileKey "${fileKey}". Call get_plugin_status to list connected files.`,
  fileDisconnected: (fileName: string): string =>
    `Figma file "${fileName}" disconnected before the command completed.`,
};

export type MessageCatalog = typeof en;

const zh: MessageCatalog = {
  promptTemplate: (name, nodeId, fileKey): string =>
    `使用 figma-local 分析 Figma 节点「${name}」。\nnodeId: ${nodeId}\nfileKey: ${fileKey}\n\n调用 get_design_context 和 get_screenshot，分析该节点的布局、文本、样式、组件和变量绑定。\n只读，不要修改 Figma 文件。`,
  promptErrorMulti: '请只选中一个图层后再复制。',
  promptErrorNone: '请先在 Figma 中选中一个图层。',
  viewSaveNotice: '视图已切换，但无法保存窗口偏好。',
  localeSaveNotice: '语言已切换，但无法保存偏好。',
  selectFrameFirst: '请先在 Figma 中选中一个 Frame 或图层。',
  selectOnlyOne: '请只选中一个 Frame 或图层。',
  findNodesCriteria: '请提供搜索条件：query 和/或 types。',
  pageNotFound: (pageId): string => `找不到页面 ${pageId}。`,
  nodeNotFound: (nodeId): string => `找不到节点 ${nodeId}。`,
  notCanvasNode: '请提供 Frame 或其他画布图层的节点 ID，而不是页面或文档。',
  exportTooLarge: (bytes, max): string =>
    `导出结果为 ${bytes} 字节，超过 ${max} 字节限制；请缩小节点或降低导出倍率。`,
  unsupportedCommand: (name): string => `不支持的命令：${name}`,
  unauthorized: '未授权',
  requestTooLarge: '请求体过大。',
  unknownEndpoint: '未知接口',
  unknownPluginCommand: '未知插件命令',
  unknownResult: '未知或已过期的命令结果。',
  requestFailed: '请求失败',
  pluginNotConnected: 'Figma 插件未连接。请运行 Figma Local MCP Bridge 插件（窗口可收起），并确认本地服务已启动。',
  commandTimeout: (name): string => `插件命令 ${name} 执行超时。`,
  shuttingDown: '本地 MCP 服务已关闭。',
  portOccupied: (port): string => `端口 ${port} 已被其他服务占用。`,
  existingBridge: (status): string => `已有桥接返回 ${status}`,
  pluginExecutionFailed: '插件执行失败。',
  localServiceReturned: (status): string => `本地服务返回 ${status}`,
  invalidExport: '插件返回了无效的导出结果。',
  exportSizeLimit: '导出结果超过大小限制。',
  exportLengthCheck: '导出结果的长度校验失败。',
  screenshotTooLarge: '截图超过 8 MiB，请降低 maxDimension，或改用 export_node 保存文件。',
  missingFileKey: '已拒绝：缺少 fileKey。请将 Figma 插件更新到与本地服务相同的版本后重新运行。',
  serviceUnreachable: '本地服务尚未启动。',
  fileNotConnected: (fileKey): string =>
    `没有已连接的文件匹配 fileKey「${fileKey}」，请调用 get_plugin_status 查看已连接文件。`,
  fileDisconnected: (fileName): string =>
    `Figma 文件「${fileName}」在命令完成前断开了连接。`,
};

/**
 * The single catalog of localized runtime strings. `zh` is type-checked
 * against `en`, so both tables always expose the same keys and signatures.
 * Falls back to English for unknown locales.
 */
export function messages(locale: Locale): MessageCatalog {
  return locale === 'zh' ? zh : en;
}
