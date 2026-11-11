import type {
  ExportPayload,
  PluginCommand,
  PluginDocumentStatus,
} from '../shared/protocol';
import { messages, type Locale } from '../shared/messages';
import { cloneValue, createDesignContext, summarizeNode } from './serialize';
import { base64Encode, computeExportScale } from './export';

const MAX_EXPORT_BYTES = 12 * 1024 * 1024;

/** Minimal structural view of a page for traversal and counting. */
export interface DocumentPage {
  id: string;
  name: string;
  /** Required by the dynamic-page document access mode before reading children. */
  loadAsync(): Promise<void>;
  children: ReadonlyArray<SceneNode>;
}

interface StyleBase {
  id: string;
  name: string;
  key: string;
  description: string;
  remote: boolean;
}

/**
 * Figma context required to execute plugin commands. Production passes the
 * global `figma`; tests inject a mock implementation.
 */
export interface FigmaContext {
  root: { name: string; children: ReadonlyArray<DocumentPage> };
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
  getLocalPaintStylesAsync(): Promise<Array<StyleBase & { paints: unknown }>>;
  getLocalTextStylesAsync(): Promise<Array<StyleBase & {
    fontName: unknown;
    fontSize: unknown;
    lineHeight: unknown;
    letterSpacing: unknown;
    paragraphSpacing: unknown;
    paragraphIndent: unknown;
    textCase: unknown;
    textDecoration: unknown;
  }>>;
  getLocalEffectStylesAsync(): Promise<Array<StyleBase & { effects: unknown }>>;
  getLocalGridStylesAsync(): Promise<Array<StyleBase & { layoutGrids: unknown }>>;
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

export async function findNodes(
  ctx: FigmaContext,
  args: Record<string, unknown>,
  locale: Locale = 'en',
): Promise<Record<string, unknown>> {
  const m = messages(locale);
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const types = new Set(
    Array.isArray(args.types)
      ? args.types
        .filter((type): type is string => typeof type === 'string')
        .map((type) => type.trim().toUpperCase())
        .filter(Boolean)
      : [],
  );
  if (!query && types.size === 0) throw new Error(m.findNodesCriteria);
  const maxResults = typeof args.maxResults === 'number' && Number.isInteger(args.maxResults)
    ? Math.max(1, Math.min(args.maxResults, 500))
    : 50;
  const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : '';
  const pages = pageId ? ctx.root.children.filter((page) => page.id === pageId) : ctx.root.children;
  if (pages.length === 0) throw new Error(m.pageNotFound(pageId));

  const matches: Array<Record<string, unknown>> = [];
  let matchCount = 0;
  let truncated = false;
  const visit = (node: SceneNode, page: DocumentPage): void => {
    if ((!query || node.name.toLowerCase().includes(query)) && (types.size === 0 || types.has(node.type.toUpperCase()))) {
      matchCount += 1;
      if (matches.length < maxResults) {
        matches.push({ id: node.id, name: node.name, type: node.type, pageId: page.id, pageName: page.name });
      } else {
        truncated = true;
      }
    }
    if ('children' in node) {
      for (const child of node.children) visit(child, page);
    }
  };
  for (const page of pages) {
    await page.loadAsync();
    for (const child of page.children) visit(child, page);
  }
  return {
    criteria: { query: query || null, types: [...types], pageId: pageId || null },
    matches,
    matchCount,
    returned: matches.length,
    truncated,
  };
}

function countDescendants(nodes: ReadonlyArray<SceneNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if ('children' in node) count += countDescendants(node.children);
  }
  return count;
}

export async function getDocument(ctx: FigmaContext, fileKey: string): Promise<Record<string, unknown>> {
  const [variables, collections, paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
    ctx.variables.getLocalVariablesAsync(),
    ctx.variables.getLocalVariableCollectionsAsync(),
    ctx.getLocalPaintStylesAsync(),
    ctx.getLocalTextStylesAsync(),
    ctx.getLocalEffectStylesAsync(),
    ctx.getLocalGridStylesAsync(),
  ]);
  const pages: Array<{ id: string; name: string; nodeCount: number }> = [];
  for (const page of ctx.root.children) {
    await page.loadAsync();
    pages.push({ id: page.id, name: page.name, nodeCount: countDescendants(page.children) });
  }
  return {
    fileName: ctx.root.name,
    fileKey,
    pages,
    counts: {
      variables: variables.length,
      variableCollections: collections.length,
      paintStyles: paintStyles.length,
      textStyles: textStyles.length,
      effectStyles: effectStyles.length,
      gridStyles: gridStyles.length,
    },
  };
}

export async function getStyleDefs(ctx: FigmaContext, maxStyles = 200): Promise<Record<string, unknown>> {
  const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
    ctx.getLocalPaintStylesAsync(),
    ctx.getLocalTextStylesAsync(),
    ctx.getLocalEffectStylesAsync(),
    ctx.getLocalGridStylesAsync(),
  ]);
  const limit = Math.max(1, Math.min(Math.floor(maxStyles), 2000));
  const summarize = <T extends StyleBase>(styles: T[], extra: (style: T) => Record<string, unknown>) => ({
    list: styles.slice(0, limit).map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      description: style.description,
      remote: style.remote,
      ...extra(style),
    })),
    total: styles.length,
    returned: Math.min(styles.length, limit),
    truncated: styles.length > limit,
  });
  return {
    paintStyles: summarize(paintStyles, (style) => ({ paints: cloneValue(style.paints) })),
    textStyles: summarize(textStyles, (style) => ({
      fontName: cloneValue(style.fontName),
      fontSize: cloneValue(style.fontSize),
      lineHeight: cloneValue(style.lineHeight),
      letterSpacing: cloneValue(style.letterSpacing),
      paragraphSpacing: cloneValue(style.paragraphSpacing),
      paragraphIndent: cloneValue(style.paragraphIndent),
      textCase: cloneValue(style.textCase),
      textDecoration: cloneValue(style.textDecoration),
    })),
    effectStyles: summarize(effectStyles, (style) => ({ effects: cloneValue(style.effects) })),
    gridStyles: summarize(gridStyles, (style) => ({ layoutGrids: cloneValue(style.layoutGrids) })),
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
    case 'find_nodes':
      return findNodes(ctx, args, locale);
    case 'get_document':
      return getDocument(ctx, fileKey);
    case 'get_style_defs':
      return getStyleDefs(ctx, typeof args.maxStyles === 'number' ? args.maxStyles : 200);
    case 'export_node':
      return exportNode(ctx, args, locale);
    default:
      throw new Error(m.unsupportedCommand(String(command.name)));
  }
}
