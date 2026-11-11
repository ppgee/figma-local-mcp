import type {
  ExportPayload,
  PluginCommand,
  PluginDocumentStatus,
  PluginResult,
  PluginSelectedNode,
} from '../shared/protocol';
import { cloneValue, createDesignContext, summarizeNode } from './serialize';

declare const __BRIDGE_ORIGIN__: string;
declare const __BRIDGE_TOKEN__: string;
declare const __PLUGIN_VERSION__: string;

const MAX_EXPORT_BYTES = 12 * 1024 * 1024;
const EXPANDED_SIZE = { width: 360, height: 476 };
const COLLAPSED_SIZE = { width: 328, height: 60 };
const VIEW_STORAGE_KEY = 'ui-collapsed';
let connected = false;
let polling = false;
let executing = false;
let collapsed = false;

figma.showUI(__html__, { ...EXPANDED_SIZE, title: 'Figma Local MCP', themeColors: true });

function documentStatus(): PluginDocumentStatus {
  const selection = figma.currentPage.selection;
  const selectedNode = selection.length === 1 ? selection[0] : null;
  return {
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionCount: selection.length,
    selectedNode: selectedNode ? {
      id: selectedNode.id,
      name: selectedNode.name,
      type: selectedNode.type,
    } : null,
    pluginVersion: __PLUGIN_VERSION__,
  };
}

function createNodePrompt(node: PluginSelectedNode): string {
  const name = node.name.replace(/\s+/g, ' ').trim() || '未命名节点';
  return `使用 figma-local 分析 Figma 节点「${name}」。\nnodeId: ${node.id}\n\n调用 get_design_context 和 get_screenshot，分析该节点的布局、文本、样式、组件和变量绑定。\n只读，不要修改 Figma 文件。`;
}

function emitStatus(): void {
  const status = documentStatus();
  figma.ui.postMessage({
    type: 'status',
    connected,
    ...status,
    prompt: status.selectedNode ? createNodePrompt(status.selectedNode) : '',
  });
}

async function restoreView(): Promise<void> {
  try {
    collapsed = await figma.clientStorage.getAsync(VIEW_STORAGE_KEY) === true;
  } catch {
    collapsed = false;
  }
  figma.ui.resize(
    collapsed ? COLLAPSED_SIZE.width : EXPANDED_SIZE.width,
    collapsed ? COLLAPSED_SIZE.height : EXPANDED_SIZE.height,
  );
  figma.ui.postMessage({ type: 'view', collapsed });
}

function setCollapsed(value: boolean): void {
  collapsed = value;
  figma.ui.resize(value ? COLLAPSED_SIZE.width : EXPANDED_SIZE.width, value ? COLLAPSED_SIZE.height : EXPANDED_SIZE.height);
  figma.ui.postMessage({ type: 'view', collapsed });
  void figma.clientStorage.setAsync(VIEW_STORAGE_KEY, collapsed).catch(() => {
    figma.ui.postMessage({ type: 'notice', message: '视图已切换，但无法保存窗口偏好。' });
  });
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${__BRIDGE_ORIGIN__}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${__BRIDGE_TOKEN__}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `本地服务返回 ${response.status}`);
  return payload;
}

async function resolveSceneNode(nodeId?: string): Promise<SceneNode> {
  const selection = figma.currentPage.selection;
  if (!nodeId && selection.length !== 1) {
    throw new Error(selection.length === 0 ? '请先在 Figma 中选中一个 Frame 或图层。' : '请只选中一个 Frame 或图层。');
  }
  const node = nodeId ? await figma.getNodeByIdAsync(nodeId) : selection[0];
  if (!node) throw new Error(`找不到节点 ${nodeId}。`);
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    throw new Error('请提供 Frame 或其他画布图层的节点 ID，而不是页面或文档。');
  }
  return node as SceneNode;
}

async function getVariableDefs(maxVariables: number): Promise<Record<string, unknown>> {
  const [variables, collections] = await Promise.all([
    figma.variables.getLocalVariablesAsync(),
    figma.variables.getLocalVariableCollectionsAsync(),
  ]);
  return {
    collections: collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      defaultModeId: collection.defaultModeId,
      modes: cloneValue(collection.modes),
      variableIds: cloneValue(collection.variableIds),
      remote: collection.remote,
    })),
    variables: variables.slice(0, maxVariables).map((variable) => ({
      id: variable.id,
      name: variable.name,
      key: variable.key,
      variableCollectionId: variable.variableCollectionId,
      resolvedType: variable.resolvedType,
      valuesByMode: cloneValue(variable.valuesByMode),
      description: variable.description,
      scopes: cloneValue(variable.scopes),
      hiddenFromPublishing: variable.hiddenFromPublishing,
      remote: variable.remote,
    })),
    totalVariables: variables.length,
    returnedVariables: Math.min(variables.length, maxVariables),
    truncated: variables.length > maxVariables,
  };
}

function base64Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    output += alphabet[(value >> 18) & 63];
    output += alphabet[(value >> 12) & 63];
    output += hasSecond ? alphabet[(value >> 6) & 63] : '=';
    output += hasThird ? alphabet[value & 63] : '=';
  }
  return output;
}

async function exportNode(args: Record<string, unknown>): Promise<ExportPayload> {
  const node = await resolveSceneNode(typeof args.nodeId === 'string' ? args.nodeId : undefined);
  const format = (typeof args.format === 'string' ? args.format : 'PNG') as ExportPayload['format'];
  let scale = typeof args.scale === 'number' ? args.scale : 1;
  if (typeof args.maxDimension === 'number') {
    const bounds = node.absoluteBoundingBox;
    if (bounds && Math.max(bounds.width, bounds.height) > 0) {
      scale = Math.min(scale, args.maxDimension / Math.max(bounds.width, bounds.height));
    }
  }
  scale = Math.max(0.01, Math.min(scale, 4));
  const bytes = await node.exportAsync({ format, constraint: { type: 'SCALE', value: scale } });
  if (bytes.length > MAX_EXPORT_BYTES) {
    throw new Error(`导出结果为 ${bytes.length} 字节，超过 ${MAX_EXPORT_BYTES} 字节限制；请缩小节点或降低导出倍率。`);
  }
  const mimeType = {
    PNG: 'image/png',
    SVG: 'image/svg+xml',
    JPG: 'image/jpeg',
    PDF: 'application/pdf',
  } as const;
  return {
    nodeId: node.id,
    nodeName: node.name,
    format,
    mimeType: mimeType[format],
    data: base64Encode(bytes),
    byteLength: bytes.length,
    scale,
  };
}

async function executeCommand(command: PluginCommand): Promise<unknown> {
  const { args } = command;
  switch (command.name) {
    case 'get_selection':
      return {
        document: documentStatus(),
        selection: figma.currentPage.selection.map(summarizeNode),
      };
    case 'get_design_context': {
      const node = await resolveSceneNode(typeof args.nodeId === 'string' ? args.nodeId : undefined);
      return createDesignContext(node, {
        maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : 6,
        maxNodes: typeof args.maxNodes === 'number' ? args.maxNodes : 300,
      });
    }
    case 'get_variable_defs':
      return getVariableDefs(typeof args.maxVariables === 'number' ? args.maxVariables : 200);
    case 'export_node':
      return exportNode(args);
    default:
      throw new Error(`不支持的命令：${String(command.name)}`);
  }
}

async function runCommand(command: PluginCommand): Promise<void> {
  if (executing) return;
  executing = true;
  try {
    const result = await executeCommand(command);
    await request<{ ok: boolean }>('/v1/plugin/result', { id: command.id, ok: true, result } satisfies PluginResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await request<{ ok: boolean }>('/v1/plugin/result', { id: command.id, ok: false, error: message } satisfies PluginResult);
    } catch {
      connected = false;
      emitStatus();
    }
  } finally {
    executing = false;
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const response = await request<{ command: PluginCommand | null }>('/v1/plugin/poll', documentStatus());
    if (!connected) {
      connected = true;
      emitStatus();
    }
    if (response.command) void runCommand(response.command);
  } catch {
    if (connected) {
      connected = false;
      emitStatus();
    }
  } finally {
    polling = false;
  }
}

figma.on('selectionchange', emitStatus);
figma.on('currentpagechange', emitStatus);
figma.ui.onmessage = (message: { type?: string; requestId?: number; collapsed?: boolean }) => {
  switch (message.type) {
    case 'ready':
      void restoreView();
      emitStatus();
      break;
    case 'copy-prompt': {
      const status = documentStatus();
      if (!status.selectedNode) {
        emitStatus();
        figma.ui.postMessage({
          type: 'prompt-error',
          requestId: message.requestId,
          message: status.selectionCount > 1 ? '请只选中一个图层后再复制。' : '请先在 Figma 中选中一个图层。',
        });
        break;
      }
      emitStatus();
      figma.ui.postMessage({
        type: 'prompt',
        requestId: message.requestId,
        node: status.selectedNode,
        prompt: createNodePrompt(status.selectedNode),
      });
      break;
    }
    case 'set-view':
      setCollapsed(message.collapsed === true);
      break;
    case 'retry':
      void poll().finally(emitStatus);
      break;
  }
};

emitStatus();
void poll();
setInterval(() => void poll(), 750);
