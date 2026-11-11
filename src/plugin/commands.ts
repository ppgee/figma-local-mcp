import type {
  ExportPayload,
  PluginCommand,
  PluginDocumentStatus,
} from '../shared/protocol';
import { messages, type Locale } from '../shared/messages';
import { cloneValue, createDesignContext, summarizeNode } from './serialize';
import { base64Encode, computeExportScale } from './export';

const MAX_EXPORT_BYTES = 12 * 1024 * 1024;

/**
 * Figma context required to execute plugin commands. Production passes the
 * global `figma`; tests inject a mock implementation.
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

export function readDocumentStatus(
  ctx: FigmaContext,
  fileKey: string,
  pluginVersion: string,
  locale: Locale = 'en',
): PluginDocumentStatus {
  const selection = ctx.currentPage.selection;
  const selectedNode = selection.length === 1 ? selection[0] : null;
  return {
    fileKey,
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
    locale,
  };
}

export async function resolveSceneNode(ctx: FigmaContext, nodeId?: string, locale: Locale = 'en'): Promise<SceneNode> {
  const m = messages(locale);
  const selection = ctx.currentPage.selection;
  if (!nodeId && selection.length !== 1) {
    throw new Error(selection.length === 0 ? m.selectFrameFirst : m.selectOnlyOne);
  }
  const node = nodeId ? await ctx.getNodeByIdAsync(nodeId) : selection[0];
  if (!node) throw new Error(m.nodeNotFound(String(nodeId)));
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    throw new Error(m.notCanvasNode);
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

export async function exportNode(ctx: FigmaContext, args: Record<string, unknown>, locale: Locale = 'en'): Promise<ExportPayload> {
  const node = await resolveSceneNode(ctx, typeof args.nodeId === 'string' ? args.nodeId : undefined, locale);
  const format = (typeof args.format === 'string' ? args.format : 'PNG') as ExportPayload['format'];
  const scale = computeExportScale(
    node.absoluteBoundingBox,
    typeof args.scale === 'number' ? args.scale : 1,
    typeof args.maxDimension === 'number' ? args.maxDimension : undefined,
  );
  const bytes = await node.exportAsync({ format, constraint: { type: 'SCALE', value: scale } });
  if (bytes.length > MAX_EXPORT_BYTES) {
    throw new Error(messages(locale).exportTooLarge(bytes.length, MAX_EXPORT_BYTES));
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
  fileKey: string,
  pluginVersion: string,
  locale: Locale,
  command: PluginCommand,
): Promise<unknown> {
  const m = messages(locale);
  const { args } = command;
  switch (command.name) {
    case 'get_selection':
      return {
        document: readDocumentStatus(ctx, fileKey, pluginVersion, locale),
        selection: ctx.currentPage.selection.map(summarizeNode),
      };
    case 'get_design_context': {
      const node = await resolveSceneNode(ctx, typeof args.nodeId === 'string' ? args.nodeId : undefined, locale);
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
      return exportNode(ctx, args, locale);
    default:
      throw new Error(m.unsupportedCommand(String(command.name)));
  }
}
