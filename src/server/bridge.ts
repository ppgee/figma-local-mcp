import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { localConfig } from './config.js';
import type {
  BridgeStatus,
  PluginCommand,
  PluginCommandName,
  PluginDocumentStatus,
  PluginResult,
} from '../shared/protocol.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CONNECTION_WINDOW_MS = 5000;
const commandNames: readonly PluginCommandName[] = [
  'get_selection',
  'get_design_context',
  'get_variable_defs',
  'export_node',
];

interface PendingCommand {
  name: PluginCommandName;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function tokensMatch(expected: string, supplied: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
    } else {
      chunks.push(buffer);
    }
  }

  if (tooLarge) {
    throw Object.assign(new Error('请求体过大。'), { statusCode: 413 });
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export interface BridgeOptions {
  port?: number;
  token?: string;
}

export class PluginBridge {
  private readonly server: Server;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private readonly options: BridgeOptions;
  private documentStatus: PluginDocumentStatus | null = null;
  private lastSeen: number | null = null;
  private remoteFallback = false;

  constructor(options: BridgeOptions = {}) {
    this.options = options;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  private get port(): number {
    return this.options.port ?? localConfig.port;
  }

  private get token(): string {
    return this.options.token ?? localConfig.token;
  }

  private get origin(): string {
    return `http://localhost:${this.boundPort ?? this.port}`;
  }

  get boundPort(): number | null {
    const address = this.server.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  }

  get connectionMode(): 'listening' | 'reusing' {
    return this.remoteFallback ? 'reusing' : 'listening';
  }

  async listen(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.server.once('error', onError);
        this.server.listen(this.port, '127.0.0.1', () => {
          this.server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error;
      }
      await this.getRemoteStatus();
      this.remoteFallback = true;
    }
  }

  async close(): Promise<void> {
    if (this.remoteFallback) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('本地 MCP 服务已关闭。'));
    }
    this.pending.clear();
    this.queue.length = 0;
    this.active.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.remoteFallback ? this.getRemoteStatus() : this.getLocalStatus();
  }

  async call(
    name: PluginCommandName,
    args: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    if (this.remoteFallback) {
      const payload = await this.requestBridge('POST', '/v1/plugin/call', { name, args, timeoutMs }, timeoutMs + 5000);
      return payload.result;
    }
    if (!this.isConnected()) {
      throw new Error('Figma 插件未连接。请运行 Figma Local MCP Bridge 插件（窗口可收起），并确认本地服务已启动。');
    }

    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.active.delete(id);
        const index = this.queue.indexOf(id);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error(`插件命令 ${name} 执行超时。`));
      }, timeoutMs);
      this.pending.set(id, { name, args, resolve, reject, timer });
      this.queue.push(id);
    });
  }

  private async requestBridge(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(payload.error || `已有桥接返回 ${response.status}`);
    return payload;
  }

  private getLocalStatus(): BridgeStatus {
    return {
      connected: this.isConnected(),
      fileName: this.documentStatus?.fileName ?? '',
      pageId: this.documentStatus?.pageId ?? '',
      pageName: this.documentStatus?.pageName ?? '',
      selectionCount: this.documentStatus?.selectionCount ?? 0,
      selectedNode: this.documentStatus?.selectedNode ?? null,
      pluginVersion: this.documentStatus?.pluginVersion ?? '',
      lastSeen: this.lastSeen === null ? null : new Date(this.lastSeen).toISOString(),
      queuedCommands: this.queue.length,
      activeCommands: this.active.size,
    };
  }

  private async getRemoteStatus(): Promise<BridgeStatus> {
    const payload = await this.requestBridge('GET', '/health');
    if (payload.ok !== true || payload.bridge !== this.origin || !payload.status) {
      throw new Error(`端口 ${this.port} 已被其他服务占用。`);
    }
    return payload.status as BridgeStatus;
  }

  private isConnected(): boolean {
    return this.lastSeen !== null && Date.now() - this.lastSeen < CONNECTION_WINDOW_MS;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const authorization = request.headers.authorization ?? '';
      const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokensMatch(this.token, supplied)) {
        sendJson(response, 401, { error: '未授权' });
        return;
      }

      const path = new URL(request.url ?? '/', this.origin).pathname;
      if (request.method === 'GET' && path === '/health') {
        sendJson(response, 200, { ok: true, bridge: this.origin, status: this.getLocalStatus() });
        return;
      }
      if (request.method === 'POST' && path === '/v1/plugin/call') {
        const body = await readJson(request);
        if (!commandNames.includes(body.name as PluginCommandName)) {
          sendJson(response, 400, { error: '未知插件命令' });
          return;
        }
        const requestedTimeout = typeof body.timeoutMs === 'number' ? body.timeoutMs : 60_000;
        const timeoutMs = Math.max(1, Math.min(requestedTimeout, 130_000));
        const result = await this.call(
          body.name as PluginCommandName,
          typeof body.args === 'object' && body.args !== null ? body.args as Record<string, unknown> : {},
          timeoutMs,
        );
        sendJson(response, 200, { result });
        return;
      }
      if (request.method === 'POST' && path === '/v1/plugin/poll') {
        const body = await readJson(request);
        this.updateDocumentStatus(body);
        const command = this.nextCommand();
        sendJson(response, 200, { command });
        return;
      }
      if (request.method === 'POST' && path === '/v1/plugin/result') {
        const body = await readJson(request);
        this.acceptResult(body as unknown as PluginResult);
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { error: '未知接口' });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 400;
      const message = error instanceof Error ? error.message : '请求失败';
      if (!response.headersSent) sendJson(response, statusCode, { error: message.slice(0, 500) });
    }
  }

  private updateDocumentStatus(body: Record<string, unknown>): void {
    const node = typeof body.selectedNode === 'object' && body.selectedNode !== null
      ? body.selectedNode as Record<string, unknown>
      : null;
    this.documentStatus = {
      fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 500) : '',
      pageId: typeof body.pageId === 'string' ? body.pageId.slice(0, 100) : '',
      pageName: typeof body.pageName === 'string' ? body.pageName.slice(0, 500) : '',
      selectionCount: typeof body.selectionCount === 'number' && Number.isInteger(body.selectionCount)
        ? Math.max(0, Math.min(body.selectionCount, 100_000))
        : 0,
      selectedNode: node
        && typeof node.id === 'string'
        && typeof node.name === 'string'
        && typeof node.type === 'string'
        ? {
          id: node.id.slice(0, 100),
          name: node.name.slice(0, 500),
          type: node.type.slice(0, 100),
        }
        : null,
      pluginVersion: typeof body.pluginVersion === 'string' ? body.pluginVersion.slice(0, 50) : '',
    };
    this.lastSeen = Date.now();
  }

  private nextCommand(): PluginCommand | null {
    if (this.active.size > 0) return null;
    const id = this.queue.shift();
    if (!id) return null;
    const pending = this.pending.get(id);
    if (!pending) return this.nextCommand();
    this.active.add(id);
    return { id, name: pending.name, args: pending.args };
  }

  private acceptResult(result: PluginResult): void {
    const pending = this.pending.get(result.id);
    if (!pending || !this.active.delete(result.id)) {
      throw Object.assign(new Error('未知或已过期的命令结果。'), { statusCode: 404 });
    }
    clearTimeout(pending.timer);
    this.pending.delete(result.id);
    if (result.ok) {
      pending.resolve(result.result);
    } else {
      pending.reject(new Error((result.error || '插件执行失败。').slice(0, 2000)));
    }
  }
}
