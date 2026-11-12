import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { localConfig } from './config.js';
import { messages } from '../shared/messages.js';
import type { Locale } from '../shared/messages.js';
import type {
  BridgeStatus,
  FileSessionStatus,
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
  'get_style_defs',
  'get_document',
  'find_nodes',
  'export_node',
];

interface PendingCommand {
  fileKey: string;
  name: PluginCommandName;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One bridge session per connected Figma file, keyed by the plugin-reported file key. */
interface FileSession {
  fileKey: string;
  status: PluginDocumentStatus;
  lastSeen: number;
  queue: string[];
  active: Set<string>;
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

async function readJson(request: IncomingMessage, tooLargeMessage: string): Promise<Record<string, unknown>> {
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
    throw Object.assign(new Error(tooLargeMessage), { statusCode: 413 });
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
  private readonly sessions = new Map<string, FileSession>();
  private readonly options: BridgeOptions;
  private lastKnownLocale: Locale | null = null;
  private remoteFallback = false;

  constructor(options: BridgeOptions = {}) {
    this.options = options;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  /** Locale for messages that are not tied to a specific file session. */
  private m() {
    return messages(this.lastKnownLocale ?? 'en');
  }

  private messagesFor(session: FileSession | null | undefined) {
    return messages(session?.status.locale ?? this.lastKnownLocale ?? 'en');
  }

  private activeSession(): FileSession | null {
    let active: FileSession | null = null;
    for (const session of this.sessions.values()) {
      if (active === null || session.lastSeen > active.lastSeen) active = session;
    }
    return active;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastSeen <= CONNECTION_WINDOW_MS) continue;
      const error = new Error(this.messagesFor(session).fileDisconnected(session.status.fileName));
      this.failSessionCommands(session, error);
      this.sessions.delete(session.fileKey);
    }
  }

  private failSessionCommands(session: FileSession, error: Error): void {
    for (const id of [...session.queue, ...session.active]) {
      const command = this.pending.get(id);
      if (!command) continue;
      clearTimeout(command.timer);
      this.pending.delete(id);
      command.reject(error);
    }
    session.queue.length = 0;
    session.active.clear();
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
      await this.listenLocal();
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error;
      }
      await this.getRemoteStatus();
      this.remoteFallback = true;
    }
  }

  private listenLocal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  /**
   * For the resident daemon: while reusing another instance, retry binding the
   * port and take over as soon as it frees. Returns true when this bridge listens.
   */
  async tryListen(): Promise<boolean> {
    if (!this.remoteFallback) return true;
    try {
      await this.listenLocal();
      this.remoteFallback = false;
      return true;
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error;
      }
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.remoteFallback) return;
    const error = new Error(this.m().shuttingDown);
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    this.pending.clear();
    this.sessions.clear();
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
    fileKey?: string,
  ): Promise<unknown> {
    if (this.remoteFallback) {
      const payload = await this.requestBridge('POST', '/v1/plugin/call', { name, args, timeoutMs, fileKey }, timeoutMs + 5000);
      return payload.result;
    }
    this.pruneSessions();
    const target = fileKey === undefined ? this.activeSession() : this.sessions.get(fileKey) ?? null;
    if (target === null) {
      throw new Error(fileKey === undefined ? this.m().pluginNotConnected : this.m().fileNotConnected(fileKey));
    }
    const catalog = this.messagesFor(target);
    const targetKey = target.fileKey;
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const session = this.sessions.get(targetKey);
        if (session) {
          const queueIndex = session.queue.indexOf(id);
          if (queueIndex >= 0) session.queue.splice(queueIndex, 1);
          session.active.delete(id);
        }
        reject(new Error(catalog.commandTimeout(name)));
      }, timeoutMs);
      this.pending.set(id, { fileKey: targetKey, name, args, resolve, reject, timer });
      target.queue.push(id);
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
    if (!response.ok) throw new Error(payload.error || this.m().existingBridge(response.status));
    return payload;
  }

  private getLocalStatus(): BridgeStatus {
    this.pruneSessions();
    const sessions = [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    return {
      connected: sessions.length > 0,
      activeFileKey: sessions.length > 0 ? sessions[0].fileKey : null,
      files: sessions.map((session): FileSessionStatus => ({
        fileKey: session.fileKey,
        fileName: session.status.fileName,
        pageId: session.status.pageId,
        pageName: session.status.pageName,
        selectionCount: session.status.selectionCount,
        selectedNode: session.status.selectedNode,
        pluginVersion: session.status.pluginVersion,
        locale: session.status.locale,
        lastSeen: new Date(session.lastSeen).toISOString(),
        queuedCommands: session.queue.length,
        activeCommands: session.active.size,
      })),
    };
  }

  private async getRemoteStatus(): Promise<BridgeStatus> {
    const payload = await this.requestBridge('GET', '/health');
    if (payload.ok !== true || payload.bridge !== this.origin || !payload.status) {
      throw new Error(this.m().portOccupied(this.port));
    }
    return payload.status as BridgeStatus;
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
        sendJson(response, 401, { error: this.m().unauthorized });
        return;
      }

      const path = new URL(request.url ?? '/', this.origin).pathname;
      if (request.method === 'GET' && path === '/health') {
        sendJson(response, 200, { ok: true, bridge: this.origin, status: this.getLocalStatus() });
        return;
      }
      if (request.method === 'POST' && path === '/v1/plugin/call') {
        const body = await readJson(request, this.m().requestTooLarge);
        if (!commandNames.includes(body.name as PluginCommandName)) {
          sendJson(response, 400, { error: this.m().unknownPluginCommand });
          return;
        }
        const requestedTimeout = typeof body.timeoutMs === 'number' ? body.timeoutMs : 60_000;
        const timeoutMs = Math.max(1, Math.min(requestedTimeout, 130_000));
        const fileKey = typeof body.fileKey === 'string' && body.fileKey.trim() !== ''
          ? body.fileKey.trim()
          : undefined;
        const result = await this.call(
          body.name as PluginCommandName,
          typeof body.args === 'object' && body.args !== null ? body.args as Record<string, unknown> : {},
          timeoutMs,
          fileKey,
        );
        sendJson(response, 200, { result });
        return;
      }
      if (request.method === 'POST' && path === '/v1/plugin/poll') {
        const body = await readJson(request, this.m().requestTooLarge);
        const session = this.touchSession(body);
        this.pruneSessions();
        sendJson(response, 200, { command: this.nextCommand(session) });
        return;
      }
      if (request.method === 'POST' && path === '/v1/plugin/result') {
        const body = await readJson(request, this.m().requestTooLarge);
        this.acceptResult(body as unknown as PluginResult);
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { error: this.m().unknownEndpoint });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 400;
      const message = error instanceof Error ? error.message : this.m().requestFailed;
      if (!response.headersSent) sendJson(response, statusCode, { error: message.slice(0, 500) });
    }
  }

  private touchSession(body: Record<string, unknown>): FileSession {
    const fileKey = typeof body.fileKey === 'string' ? body.fileKey.trim().slice(0, 100) : '';
    if (!fileKey) {
      throw Object.assign(new Error(this.m().missingFileKey), { statusCode: 400 });
    }
    const previous = this.sessions.get(fileKey)?.status ?? null;
    const node = typeof body.selectedNode === 'object' && body.selectedNode !== null
      ? body.selectedNode as Record<string, unknown>
      : null;
    const locale = body.locale === 'zh' || body.locale === 'en' ? body.locale : null;
    const status: PluginDocumentStatus = {
      fileKey,
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
      locale: locale ?? previous?.locale ?? 'en',
    };
    if (locale) this.lastKnownLocale = locale;

    const existing = this.sessions.get(fileKey);
    if (existing) {
      existing.status = status;
      existing.lastSeen = Date.now();
      return existing;
    }
    const session: FileSession = { fileKey, status, lastSeen: Date.now(), queue: [], active: new Set() };
    this.sessions.set(fileKey, session);
    return session;
  }

  private nextCommand(session: FileSession): PluginCommand | null {
    if (session.active.size > 0) return null;
    const id = session.queue.shift();
    if (id === undefined) return null;
    const pending = this.pending.get(id);
    if (!pending) return this.nextCommand(session);
    session.active.add(id);
    return { id, name: pending.name, args: pending.args };
  }

  private acceptResult(result: PluginResult): void {
    const command = this.pending.get(result.id);
    const session = command ? this.sessions.get(command.fileKey) : undefined;
    if (!command || !session || !session.active.delete(result.id)) {
      throw Object.assign(new Error(this.m().unknownResult), { statusCode: 404 });
    }
    clearTimeout(command.timer);
    this.pending.delete(result.id);
    if (result.ok) {
      command.resolve(result.result);
    } else {
      command.reject(new Error((result.error || this.messagesFor(session).pluginExecutionFailed).slice(0, 2000)));
    }
  }
}
