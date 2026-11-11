import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeStatus, ExportPayload, PluginCommandName } from '../src/shared/protocol.js';
import { documentStatus } from './helpers/http';

const osState = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => osState.home,
}));

type ToolsModule = typeof import('../src/server/tools.js');

const TOKEN = '9'.repeat(64);
let registerTools: ToolsModule['registerTools'];
let saveExport: ToolsModule['saveExport'];
let validateExport: ToolsModule['validateExport'];
let exportDirectory: string;
let sandbox: string;

class FakeBridge {
  calls: Array<{ name: PluginCommandName; args: Record<string, unknown>; timeoutMs?: number }> = [];
  status: BridgeStatus = {
    ...documentStatus() as unknown as BridgeStatus,
    connected: true,
    lastSeen: new Date().toISOString(),
    queuedCommands: 0,
    activeCommands: 0,
  };
  result: unknown = {};
  error: Error | null = null;

  async getStatus(): Promise<BridgeStatus> {
    return this.status;
  }

  async call(name: PluginCommandName, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ name, args, timeoutMs });
    if (this.error) throw this.error;
    return this.result;
  }
}

let server: McpServer;
let client: Client;

async function connect(bridge: FakeBridge): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerTools(server, bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
}

interface ToolText {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

function parseText<T>(result: unknown): T {
  const payload = result as ToolText;
  expect(payload.content[0].type).toBe('text');
  return JSON.parse(payload.content[0].text as string) as T;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'figma-local-mcp-tools-'));
  osState.home = sandbox;
  await mkdir(join(sandbox, '.local', 'share', 'figma-local-mcp'), { recursive: true });
  await writeFile(
    join(sandbox, '.local', 'share', 'figma-local-mcp', 'config.json'),
    `${JSON.stringify({ port: 3846, token: TOKEN }, null, 2)}\n`,
  );
  const tools = await import('../src/server/tools.js');
  ({ registerTools, saveExport, validateExport } = tools);
  exportDirectory = join(sandbox, '.local', 'share', 'figma-local-mcp', 'exports');
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

afterEach(async () => {
  await client.close();
  await server.close();
});

function payload(overrides: Partial<ExportPayload>): ExportPayload {
  return {
    nodeId: '1:23',
    nodeName: '首页',
    format: 'PNG',
    mimeType: 'image/png',
    data: Buffer.from('hello').toString('base64'),
    byteLength: 5,
    scale: 1,
    ...overrides,
  };
}

describe('tool registration and status', () => {
  it('registers the six read-only tools', async () => {
    await connect(new FakeBridge());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'export_node',
      'get_design_context',
      'get_plugin_status',
      'get_screenshot',
      'get_selection',
      'get_variable_defs',
    ]);
  });

  it('get_plugin_status returns the bridge origin and status', async () => {
    const bridge = new FakeBridge();
    await connect(bridge);
    const status = parseText<{ bridge: string; connected: boolean; fileName: string }>(
      await client.callTool({ name: 'get_plugin_status', arguments: {} }),
    );
    expect(status.bridge).toBe('http://localhost:3846');
    expect(status.connected).toBe(true);
    expect(status.fileName).toBe('测试文件');
  });

  it('get_selection passes the plugin result through', async () => {
    const bridge = new FakeBridge();
    bridge.result = { selection: [{ id: '1:1' }] };
    await connect(bridge);
    const result = parseText<{ selection: unknown[] }>(
      await client.callTool({ name: 'get_selection', arguments: {} }),
    );
    expect(result.selection).toEqual([{ id: '1:1' }]);
    expect(bridge.calls[0].name).toBe('get_selection');
  });
});

describe('parameter validation and forwarding', () => {
  it('get_design_context applies defaults and forwards explicit args', async () => {
    const bridge = new FakeBridge();
    await connect(bridge);
    await client.callTool({ name: 'get_design_context', arguments: {} });
    expect(bridge.calls[0].args).toMatchObject({ maxDepth: 6, maxNodes: 300 });
    expect(bridge.calls[0].args.nodeId).toBeUndefined();

    await client.callTool({ name: 'get_design_context', arguments: { nodeId: '9:9', maxDepth: 3 } });
    expect(bridge.calls[1].args).toMatchObject({ nodeId: '9:9', maxDepth: 3, maxNodes: 300 });
  });

  it('out-of-range parameters are rejected by validation', async () => {
    await connect(new FakeBridge());
    const depth = (await client.callTool({ name: 'get_design_context', arguments: { maxDepth: 21 } })) as ToolText;
    expect(depth.isError).toBe(true);
    expect(depth.content[0].text).toContain('maxDepth');

    const variables = (await client.callTool({ name: 'get_variable_defs', arguments: { maxVariables: 0 } })) as ToolText;
    expect(variables.isError).toBe(true);

    const format = (await client.callTool({ name: 'export_node', arguments: { format: 'WEBP' } })) as ToolText;
    expect(format.isError).toBe(true);
  });

  it('returns isError with the original message when bridge.call throws', async () => {
    const bridge = new FakeBridge();
    bridge.error = new Error('插件执行失败：找不到节点');
    await connect(bridge);
    const result = (await client.callTool({ name: 'get_selection', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('插件执行失败：找不到节点');
  });
});

describe('export_node and get_screenshot', () => {
  it('saves exports into the export directory with sanitized file names', async () => {
    const bridge = new FakeBridge();
    bridge.result = payload({ nodeName: '组件/A<B>:"x"?.png' });
    await connect(bridge);
    const result = parseText<{ path: string; nodeName: string; nodeId: string; byteLength: number }>(
      await client.callTool({ name: 'export_node', arguments: { format: 'PNG', scale: 1 } }),
    );
    expect(result.nodeName).toBe('组件/A<B>:"x"?.png');
    expect(result.nodeId).toBe('1:23');
    expect(result.path.startsWith(exportDirectory)).toBe(true);
    const name = basename(result.path);
    expect(name).toMatch(/-1-23-组件_A_B___x__\.png\.png$/);
    expect(await readFile(result.path, 'utf8')).toBe('hello');
    expect(bridge.calls[0].timeoutMs).toBe(120_000);
  });

  it('clamps long node names by bytes; total file name stays within 255 bytes', async () => {
    const bridge = new FakeBridge();
    bridge.result = payload({ nodeName: '名'.repeat(120) });
    await connect(bridge);
    const result = parseText<{ path: string }>(
      await client.callTool({ name: 'export_node', arguments: {} }),
    );
    const name = basename(result.path).replace(/^[0-9]+-[0-9a-f]+-1-23-/, '').replace(/\.png$/, '');
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(basename(result.path), 'utf8')).toBeLessThanOrEqual(255);
    expect(name.length).toBe(40);
  });

  it('errors on invalid payloads, length mismatches and oversized results', async () => {
    const bridge = new FakeBridge();
    bridge.result = { nope: true };
    await connect(bridge);
    let result = (await client.callTool({ name: 'export_node', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid export result');

    bridge.result = payload({ byteLength: 999 });
    result = (await client.callTool({ name: 'export_node', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('length check');

    bridge.result = payload({ byteLength: 12 * 1024 * 1024 + 1 });
    result = (await client.callTool({ name: 'export_node', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exceeds the size limit');
  });

  it('get_screenshot returns a PNG image block via the export_node channel', async () => {
    const bridge = new FakeBridge();
    bridge.result = payload({ data: Buffer.from([1, 2, 3, 4]).toString('base64'), byteLength: 4 });
    await connect(bridge);
    const result = (await client.callTool({ name: 'get_screenshot', arguments: { maxDimension: 800 } })) as ToolText;
    expect(bridge.calls[0].name).toBe('export_node');
    expect(bridge.calls[0].args).toMatchObject({ format: 'PNG', scale: 1, maxDimension: 800 });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text as string)).toMatchObject({ nodeId: '1:23' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(result.content[1].data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('errors when a screenshot exceeds 8 MiB', async () => {
    const bridge = new FakeBridge();
    bridge.result = payload({ byteLength: 8 * 1024 * 1024 + 1 });
    await connect(bridge);
    const result = (await client.callTool({ name: 'get_screenshot', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exceeds 8 MiB');
  });
});

describe('saveExport / validateExport unit behavior', () => {
  it('saveExport writes to the given directory with matching content', async () => {
    const directory = join(sandbox, 'custom-exports');
    const path = await saveExport(payload({ nodeName: '干净名称' }), directory);
    expect(path.startsWith(directory)).toBe(true);
    expect(basename(path)).toMatch(/-1-23-干净名称\.png$/);
    expect(await readFile(path, 'utf8')).toBe('hello');
  });

  it('validateExport rejects non-objects and missing fields', () => {
    expect(() => validateExport(null)).toThrow(/invalid export result/);
    expect(() => validateExport({ data: 'xx' })).toThrow(/invalid export result/);
    expect(() => validateExport({ data: 'xx', byteLength: 12 * 1024 * 1024 + 1 })).toThrow(/exceeds the size limit/);
  });
});
