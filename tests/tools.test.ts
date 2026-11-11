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

describe('工具注册与状态读取', () => {
  it('注册 6 个只读工具', async () => {
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

  it('get_plugin_status 返回桥接地址与状态', async () => {
    const bridge = new FakeBridge();
    await connect(bridge);
    const status = parseText<{ bridge: string; connected: boolean; fileName: string }>(
      await client.callTool({ name: 'get_plugin_status', arguments: {} }),
    );
    expect(status.bridge).toBe('http://localhost:3846');
    expect(status.connected).toBe(true);
    expect(status.fileName).toBe('测试文件');
  });

  it('get_selection 透传插件结果', async () => {
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

describe('参数校验与转发', () => {
  it('get_design_context 应用默认参数并透传指定参数', async () => {
    const bridge = new FakeBridge();
    await connect(bridge);
    await client.callTool({ name: 'get_design_context', arguments: {} });
    expect(bridge.calls[0].args).toMatchObject({ maxDepth: 6, maxNodes: 300 });
    expect(bridge.calls[0].args.nodeId).toBeUndefined();

    await client.callTool({ name: 'get_design_context', arguments: { nodeId: '9:9', maxDepth: 3 } });
    expect(bridge.calls[1].args).toMatchObject({ nodeId: '9:9', maxDepth: 3, maxNodes: 300 });
  });

  it('越界参数被校验层拒绝', async () => {
    await connect(new FakeBridge());
    const depth = (await client.callTool({ name: 'get_design_context', arguments: { maxDepth: 21 } })) as ToolText;
    expect(depth.isError).toBe(true);
    expect(depth.content[0].text).toContain('maxDepth');

    const variables = (await client.callTool({ name: 'get_variable_defs', arguments: { maxVariables: 0 } })) as ToolText;
    expect(variables.isError).toBe(true);

    const format = (await client.callTool({ name: 'export_node', arguments: { format: 'WEBP' } })) as ToolText;
    expect(format.isError).toBe(true);
  });

  it('bridge.call 抛错时返回 isError 与原始消息', async () => {
    const bridge = new FakeBridge();
    bridge.error = new Error('插件执行失败：找不到节点');
    await connect(bridge);
    const result = (await client.callTool({ name: 'get_selection', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('插件执行失败：找不到节点');
  });
});

describe('export_node 与 get_screenshot', () => {
  it('导出结果落盘到导出目录并消毒文件名', async () => {
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

  it('超长节点名截断到 80 字符', async () => {
    const bridge = new FakeBridge();
    bridge.result = payload({ nodeName: '名'.repeat(120) });
    await connect(bridge);
    const result = parseText<{ path: string }>(
      await client.callTool({ name: 'export_node', arguments: {} }),
    );
    const name = basename(result.path).replace(/^[0-9]+-[0-9a-f]+-1-23-/, '').replace(/\.png$/, '');
    expect(name.length).toBe(80);
  });

  it('无效导出结果、长度不符与超限时返回错误', async () => {
    const bridge = new FakeBridge();
    bridge.result = { nope: true };
    await connect(bridge);
    let result = (await client.callTool({ name: 'export_node', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('无效的导出结果');

    bridge.result = payload({ byteLength: 999 });
    result = (await client.callTool({ name: 'export_node', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('长度校验失败');

    bridge.result = payload({ byteLength: 12 * 1024 * 1024 + 1 });
    result = (await client.callTool({ name: 'export_node', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('超过大小限制');
  });

  it('get_screenshot 以 PNG 图片块返回并复用 export_node 通道', async () => {
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

  it('截图超过 8 MiB 时返回错误并建议降低尺寸', async () => {
    const bridge = new FakeBridge();
    bridge.result = payload({ byteLength: 8 * 1024 * 1024 + 1 });
    await connect(bridge);
    const result = (await client.callTool({ name: 'get_screenshot', arguments: {} })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('截图超过 8 MiB');
  });
});

describe('saveExport / validateExport 单元行为', () => {
  it('saveExport 写入指定目录并保持内容一致', async () => {
    const directory = join(sandbox, 'custom-exports');
    const path = await saveExport(payload({ nodeName: '干净名称' }), directory);
    expect(path.startsWith(directory)).toBe(true);
    expect(basename(path)).toMatch(/-1-23-干净名称\.png$/);
    expect(await readFile(path, 'utf8')).toBe('hello');
  });

  it('validateExport 拒绝非对象与缺字段结果', () => {
    expect(() => validateExport(null)).toThrow(/无效的导出结果/);
    expect(() => validateExport({ data: 'xx' })).toThrow(/无效的导出结果/);
    expect(() => validateExport({ data: 'xx', byteLength: 12 * 1024 * 1024 + 1 })).toThrow(/超过大小限制/);
  });
});
