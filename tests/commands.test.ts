import { describe, expect, it } from 'vitest';
import {
  executeCommand,
  readDocumentStatus,
  resolveSceneNode,
  type FigmaContext,
} from '../src/plugin/commands';
import type { PluginCommand } from '../src/shared/protocol';

const PLUGIN_VERSION = 'test-1.0.0';
const FILE_KEY = 'test-file-key';

function makeNode(overrides: Record<string, unknown> = {}): any {
  return {
    id: '1:1',
    name: '首页',
    type: 'FRAME',
    visible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
    exportAsync: async () => new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

interface CtxOptions {
  selection?: any[];
  nodes?: Record<string, any>;
  variables?: any[];
  collections?: any[];
  pages?: any[];
  paintStyles?: any[];
  textStyles?: any[];
  effectStyles?: any[];
  gridStyles?: any[];
}

function makeCtx(options: CtxOptions = {}): FigmaContext {
  return {
    root: {
      name: '测试文件',
      children: options.pages ?? [{
        id: '0:1',
        name: 'Page 1',
        loadAsync: async () => {},
        children: options.selection ?? [makeNode()],
      }],
    },
    getNodeByIdAsync: async (id: string) => options.nodes?.[id] ?? null,
    currentPage: {
      id: '0:1',
      name: 'Page 1',
      selection: options.selection ?? [makeNode()],
    },
    variables: {
      getLocalVariablesAsync: async () => options.variables ?? [],
      getLocalVariableCollectionsAsync: async () => options.collections ?? [],
    },
    getLocalPaintStylesAsync: async () => options.paintStyles ?? [],
    getLocalTextStylesAsync: async () => options.textStyles ?? [],
    getLocalEffectStylesAsync: async () => options.effectStyles ?? [],
    getLocalGridStylesAsync: async () => options.gridStyles ?? [],
  } as unknown as FigmaContext;
}

function command(name: string, args: Record<string, unknown> = {}): PluginCommand {
  return { id: 'cmd-1', name: name as PluginCommand['name'], args };
}

describe('readDocumentStatus', () => {
  it('returns the selected node with the plugin version for a single selection', () => {
    const status = readDocumentStatus(makeCtx({ selection: [makeNode({ id: '9:9', name: '首页' })] }), FILE_KEY, PLUGIN_VERSION);
    expect(status).toEqual({
      fileKey: FILE_KEY,
      fileName: '测试文件',
      pageId: '0:1',
      pageName: 'Page 1',
      selectionCount: 1,
      selectedNode: { id: '9:9', name: '首页', type: 'FRAME' },
      pluginVersion: PLUGIN_VERSION,
      locale: 'en',
    });
  });

  it('nulls selectedNode for empty and multi selection while keeping the count', () => {
    expect(readDocumentStatus(makeCtx({ selection: [] }), FILE_KEY, PLUGIN_VERSION).selectedNode).toBeNull();
    const multi = readDocumentStatus(makeCtx({ selection: [makeNode(), makeNode()] }), FILE_KEY, PLUGIN_VERSION);
    expect(multi.selectedNode).toBeNull();
    expect(multi.selectionCount).toBe(2);
  });
});

describe('resolveSceneNode', () => {
  it('errors for empty and multi selection when nodeId is omitted', async () => {
    await expect(resolveSceneNode(makeCtx({ selection: [] }))).rejects.toThrow(/Select a Frame or layer in Figma first/);
    await expect(resolveSceneNode(makeCtx({ selection: [makeNode(), makeNode()] }))).rejects.toThrow(/Select only one/);
  });

  it('uses the sole current selection when nodeId is omitted', async () => {
    const node = await resolveSceneNode(makeCtx({ selection: [makeNode({ id: '2:2' })] }));
    expect(node.id).toBe('2:2');
  });

  it('resolves by ID regardless of the current selection', async () => {
    const ctx = makeCtx({ selection: [], nodes: { '3:3': makeNode({ id: '3:3' }) } });
    const node = await resolveSceneNode(ctx, '3:3');
    expect(node.id).toBe('3:3');
  });

  it('errors when the node is missing or is a page/document', async () => {
    await expect(resolveSceneNode(makeCtx({ nodes: {} }), '4:4')).rejects.toThrow(/Node 4:4 not found/);
    const pageCtx = makeCtx({ nodes: { '0:2': { id: '0:2', type: 'PAGE', name: 'Page 2' } } });
    await expect(resolveSceneNode(pageCtx, '0:2')).rejects.toThrow(/not a page or document/);
  });
});

describe('executeCommand', () => {
  it('get_selection returns document status and selection summaries', async () => {
    const result = await executeCommand(makeCtx({ selection: [makeNode({ id: '5:5' })] }), FILE_KEY, PLUGIN_VERSION, 'en', command('get_selection')) as Record<string, any>;
    expect(result.document).toMatchObject({ fileName: '测试文件', selectionCount: 1 });
    expect(result.selection).toHaveLength(1);
    expect(result.selection[0]).toMatchObject({ id: '5:5', type: 'FRAME' });
  });

  it('get_design_context uses context document info and default options', async () => {
    const result = await executeCommand(makeCtx(), FILE_KEY, PLUGIN_VERSION, 'en', command('get_design_context')) as Record<string, any>;
    expect(result.document).toEqual({ fileName: '测试文件', pageId: '0:1', pageName: 'Page 1' });
    expect(result.maxDepth).toBe(6);
    expect(result.maxNodes).toBe(300);
    expect(result.root).toMatchObject({ id: '1:1' });
  });

  it('get_design_context supports nodeId and custom depth', async () => {
    const ctx = makeCtx({
      selection: [],
      nodes: { '7:7': makeNode({ id: '7:7', children: [makeNode({ id: '7:8' })] }) },
    });
    const result = await executeCommand(ctx, FILE_KEY, PLUGIN_VERSION, 'en', command('get_design_context', { nodeId: '7:7', maxDepth: 0 })) as Record<string, any>;
    expect(result.root).toMatchObject({ id: '7:7' });
    expect(result.root.childrenTruncated).toBe('maxDepth');
    expect(result.maxDepth).toBe(0);
  });

  it('get_variable_defs maps collections and variables with truncation', async () => {
    const variables = Array.from({ length: 5 }, (_, index) => ({
      id: `v${index}`,
      name: `变量${index}`,
      key: `key${index}`,
      variableCollectionId: 'c1',
      resolvedType: 'COLOR',
      valuesByMode: { m1: { r: index, g: 0, b: 0, a: 1 } },
      description: '',
      scopes: ['ALL_SCOPES'],
      hiddenFromPublishing: false,
      remote: false,
    }));
    const collections = [{
      id: 'c1',
      name: '集合',
      defaultModeId: 'm1',
      modes: [{ modeId: 'm1', name: '默认' }],
      variableIds: variables.map((v) => v.id),
      remote: false,
    }];
    const result = await executeCommand(
      makeCtx({ variables, collections }),
      FILE_KEY,
      PLUGIN_VERSION,
      'en',
      command('get_variable_defs', { maxVariables: 3 }),
    ) as Record<string, any>;

    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]).toMatchObject({ id: 'c1', name: '集合', defaultModeId: 'm1' });
    expect(result.variables).toHaveLength(3);
    expect(result.totalVariables).toBe(5);
    expect(result.returnedVariables).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('get_variable_defs defaults to 200 max and returns zero for empty sets', async () => {
    const result = await executeCommand(makeCtx({ variables: [], collections: [] }), FILE_KEY, PLUGIN_VERSION, 'en', command('get_variable_defs')) as Record<string, any>;
    expect(result.variables).toEqual([]);
    expect(result.collections).toEqual([]);
    expect(result.totalVariables).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('export_node returns base64 data with the right MIME type', async () => {
    const result = await executeCommand(
      makeCtx({ selection: [makeNode({ id: '8:8', name: '图标', exportAsync: async () => new Uint8Array([1, 2, 3]) })] }),
      FILE_KEY,
      PLUGIN_VERSION,
      'en',
      command('export_node', { format: 'PNG' }),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      nodeId: '8:8',
      nodeName: '图标',
      format: 'PNG',
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]).toString('base64'),
      byteLength: 3,
      scale: 1,
    });
  });

  it('export_node scales down by maxDimension and matches the SVG MIME type', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const node = makeNode({
      id: '8:9',
      exportAsync: async (settings: Record<string, unknown>) => {
        calls.push(settings);
        return new Uint8Array([9]);
      },
    });
    const result = await executeCommand(
      makeCtx({ selection: [node] }),
      FILE_KEY,
      PLUGIN_VERSION,
      'en',
      command('export_node', { format: 'SVG', maxDimension: 400 }),
    ) as Record<string, unknown>;
    expect(calls[0]).toEqual({ format: 'SVG', constraint: { type: 'SCALE', value: 0.5 } });
    expect(result.mimeType).toBe('image/svg+xml');
    expect(result.scale).toBe(0.5);
  });

  it('export_node errors above 12 MiB', async () => {
    const big = makeNode({ exportAsync: async () => new Uint8Array(12 * 1024 * 1024 + 1) });
    await expect(
      executeCommand(makeCtx({ selection: [big] }), FILE_KEY, PLUGIN_VERSION, 'en', command('export_node', {})),
    ).rejects.toThrow(/exceeding.*limit/);
  });

  it('errors on unknown commands', async () => {
    await expect(executeCommand(makeCtx(), FILE_KEY, PLUGIN_VERSION, 'en', command('run_js'))).rejects.toThrow(/Unsupported command: run_js/);
  });
});

describe('find_nodes', () => {
  const pages = [
    {
      id: '0:1',
      name: 'Page 1',
      loadAsync: async () => {},
      children: [
        {
          id: '1:1', name: '首页 Header', type: 'FRAME',
          children: [
            { id: '1:2', name: '标题文字', type: 'TEXT' },
            { id: '1:3', name: 'Header 组件', type: 'INSTANCE' },
          ],
        },
      ],
    },
    {
      id: '0:2',
      name: '组件库',
      loadAsync: async () => {},
      children: [
        { id: '2:1', name: 'Button/Main', type: 'COMPONENT' },
        { id: '2:2', name: 'Button/Second', type: 'COMPONENT' },
      ],
    },
  ];

  it('matches names case-insensitively across all pages', async () => {
    const result = await executeCommand(
      makeCtx({ pages }), FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', { query: 'button' }),
    ) as Record<string, any>;
    expect(result.matchCount).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.matches.map((match: any) => match.id)).toEqual(['2:1', '2:2']);
    expect(result.matches[0]).toMatchObject({
      id: '2:1', name: 'Button/Main', type: 'COMPONENT', pageId: '0:2', pageName: '组件库',
    });
  });

  it('filters by type (normalized) and combines with the query as AND', async () => {
    const ctx = makeCtx({ pages });
    const byType = await executeCommand(ctx, FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', { types: ['component'] })) as Record<string, any>;
    expect(byType.matchCount).toBe(2);
    const combined = await executeCommand(ctx, FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', { query: 'second', types: ['COMPONENT'] })) as Record<string, any>;
    expect(combined.matchCount).toBe(1);
    expect(combined.matches[0].id).toBe('2:2');
  });

  it('limits the search to one page and reports unknown pages', async () => {
    const ctx = makeCtx({ pages });
    const paged = await executeCommand(ctx, FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', { query: 'button', pageId: '0:2' })) as Record<string, any>;
    expect(paged.matchCount).toBe(2);
    await expect(executeCommand(ctx, FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', { query: 'x', pageId: '9:9' })))
      .rejects.toThrow(/Page 9:9 not found/);
  });

  it('truncates results while counting every match', async () => {
    const result = await executeCommand(
      makeCtx({ pages }), FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', { query: 'button', maxResults: 1 }),
    ) as Record<string, any>;
    expect(result.returned).toBe(1);
    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('requires a query and/or types', async () => {
    await expect(executeCommand(makeCtx({ pages }), FILE_KEY, PLUGIN_VERSION, 'en', command('find_nodes', {})))
      .rejects.toThrow(/query and\/or types/);
  });
});

describe('get_document', () => {
  it('lists pages with recursive node counts and resource counts', async () => {
    const pages = [{
      id: '0:1', name: 'Page 1', loadAsync: async () => {},
      children: [{ id: '1:1', name: 'F', type: 'FRAME', children: [{ id: '1:2', name: 'T', type: 'TEXT' }] }],
    }];
    const result = await executeCommand(
      makeCtx({
        pages,
        variables: [{ id: 'v1' }],
        collections: [{ id: 'c1' }],
        paintStyles: [{ id: 's1' }],
        textStyles: [{ id: 's2' }, { id: 's3' }],
      }),
      FILE_KEY, PLUGIN_VERSION, 'en', command('get_document'),
    ) as Record<string, any>;
    expect(result.fileName).toBe('测试文件');
    expect(result.fileKey).toBe(FILE_KEY);
    expect(result.pages).toEqual([{ id: '0:1', name: 'Page 1', nodeCount: 2 }]);
    expect(result.counts).toEqual({
      variables: 1,
      variableCollections: 1,
      paintStyles: 1,
      textStyles: 2,
      effectStyles: 0,
      gridStyles: 0,
    });
  });
});

describe('get_style_defs', () => {
  it('summarizes each style category with truncation and full definitions', async () => {
    const paintStyles = [
      { id: 's1', name: '主色', key: 'k1', description: '', remote: false, paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
      { id: 's2', name: '背景', key: 'k2', description: 'bg', remote: true, paints: [] },
    ];
    const textStyles = [{
      id: 't1', name: '标题', key: 'k3', description: '', remote: false,
      fontName: { family: 'Inter', style: 'Bold' }, fontSize: 16, fontWeight: 700,
      lineHeight: { value: 24, unit: 'PIXELS' }, letterSpacing: 0, paragraphSpacing: 0, paragraphIndent: 0,
    }];
    const effectStyles = [{ id: 'e1', name: '阴影', key: 'k4', description: '', remote: false, effects: [{ type: 'DROP_SHADOW' }] }];
    const gridStyles = [{ id: 'g1', name: '栅格', key: 'k5', description: '', remote: false, layoutGrids: [{ pattern: 'GRID' }] }];
    const result = await executeCommand(
      makeCtx({ paintStyles, textStyles, effectStyles, gridStyles }),
      FILE_KEY, PLUGIN_VERSION, 'en', command('get_style_defs', { maxStyles: 1 }),
    ) as Record<string, any>;

    expect(result.paintStyles.total).toBe(2);
    expect(result.paintStyles.returned).toBe(1);
    expect(result.paintStyles.truncated).toBe(true);
    expect(result.paintStyles.list[0]).toMatchObject({
      id: 's1', name: '主色', key: 'k1', remote: false,
      paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    });
    expect(result.textStyles.total).toBe(1);
    expect(result.textStyles.list[0]).toMatchObject({ fontName: { family: 'Inter', style: 'Bold' }, fontSize: 16 });
    expect(result.effectStyles.list[0]).toMatchObject({ effects: [{ type: 'DROP_SHADOW' }] });
    expect(result.gridStyles.list[0]).toMatchObject({ layoutGrids: [{ pattern: 'GRID' }] });
  });
});
