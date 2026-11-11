import type {
  ExportPayload,
  PluginCommand,
  PluginDocumentStatus,
} from '../shared/protocol';
import { cloneValue, createDesignContext, summarizeNode } from './serialize';
import { base64Encode, computeExportScale } from './export';

const MAX_EXPORT_BYTES = 12 * 1024 * 1024;

/**
 * 插件命令执行所需的 Figma 上下文。生产环境传入全局 `figma`，测试注入模拟实现。
 */
export interface FigmaContext {
  root: { name: string };
  getNodeByIdAsync(id: string): Promise<BaseNode | null>;
  currentPage: {
    id: string;
    name: string;
    selection: readonly SceneNode[];
  };
  variables: {
    getLocalVariablesAsync(): Promise<Variable[]>;
    getLocalVariableCollectionsAsync(): Promise<VariableCollection[]>;
  };
}

export function readDocumentStatus(ctx: FigmaContext, pluginVersion: string): PluginDocumentStatus {
  const selection = ctx.currentPage.selection;
  const selectedNode = selection.length === 1 ? selection[0] : null;
  return {
    fileName: ctx.root.name,
    pageId: ctx.currentPage.id,
    pageName: ctx.currentPage.name,
    selectionCount: selection.length,
    selectedNode: selectedNode ? {
      id: selectedNode.id,
      name: selectedNode.name,
      type: selectedNode.type,
    } : null,
    pluginVersion,
  };
}

export async function resolveSceneNode(ctx: FigmaContext, nodeId?: string): Promise<SceneNode> {
  const selection = ctx.currentPage.selection;
  if (!nodeId && selection.length !== 1) {
    throw new Error(selection.length === 0 ? '请先在 Figma 中选中一个 Frame 或图层。' : '请只选中一个 Frame 或图层。');
  }
  const node = nodeId ? await ctx.getNodeByIdAsync(nodeId) : selection[0];
  if (!node) throw new Error(`找不到节点 ${nodeId}。`);
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    throw new Error('请提供 Frame 或其他画布图层的节点 ID，而不是页面或文档。');
  }
  return node as SceneNode;
}

async function getVariableDefs(ctx: FigmaContext, maxVariables: number): Promise<Record<string, unknown>> {
  const [variables, collections] = await Promise.all([
    ctx.variables.getLocalVariablesAsync(),
    ctx.variables.getLocalVariableCollectionsAsync(),
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

export async function exportNode(ctx: FigmaContext, args: Record<string, unknown>): Promise<ExportPayload> {
  const node = await resolveSceneNode(ctx, typeof args.nodeId === 'string' ? args.nodeId : undefined);
  const format = (typeof args.format === 'string' ? args.format : 'PNG') as ExportPayload['format'];
  const scale = computeExportScale(
    node.absoluteBoundingBox,
    typeof args.scale === 'number' ? args.scale : 1,
    typeof args.maxDimension === 'number' ? args.maxDimension : undefined,
  );
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

export async function executeCommand(
  ctx: FigmaContext,
  pluginVersion: string,
  command: PluginCommand,
): Promise<unknown> {
  const { args } = command;
  switch (command.name) {
    case 'get_selection':
      return {
        document: readDocumentStatus(ctx, pluginVersion),
        selection: ctx.currentPage.selection.map(summarizeNode),
      };
    case 'get_design_context': {
      const node = await resolveSceneNode(ctx, typeof args.nodeId === 'string' ? args.nodeId : undefined);
      return createDesignContext(node, {
        maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : 6,
        maxNodes: typeof args.maxNodes === 'number' ? args.maxNodes : 300,
      }, {
        fileName: ctx.root.name,
        pageId: ctx.currentPage.id,
        pageName: ctx.currentPage.name,
      });
    }
    case 'get_variable_defs':
      return getVariableDefs(ctx, typeof args.maxVariables === 'number' ? args.maxVariables : 200);
    case 'export_node':
      return exportNode(ctx, args);
    default:
      throw new Error(`不支持的命令：${String(command.name)}`);
  }
}
