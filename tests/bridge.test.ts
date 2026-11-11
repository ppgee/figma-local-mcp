import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, documentStatus } from './helpers/http';

const osState = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => osState.home,
}));

type BridgeModule = typeof import('../src/server/bridge.js');

const TOKEN = 'b'.repeat(64);
let PluginBridge: BridgeModule['PluginBridge'];
let bridge: InstanceType<BridgeModule['PluginBridge']>;
let origin: string;
let sandbox: string;

async function pluginPoll(token = TOKEN, status = documentStatus()) {
  return api(origin, '/v1/plugin/poll', { method: 'POST', body: status, token });
}

async function pluginResult(body: Record<string, unknown>, token = TOKEN) {
  return api(origin, '/v1/plugin/result', { method: 'POST', body, token });
}

async function pollUntilCommand(targetOrigin: string, token: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await api(targetOrigin, '/v1/plugin/poll', { method: 'POST', body: documentStatus(), token });
    if (response.body.command) return response.body.command as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Polling timed out: no command entered the queue.');
}

async function health(token = TOKEN) {
  const response = await api(origin, '/health', { token });
  expect(response.status).toBe(200);
  return response.body as {
    ok: boolean;
    bridge: string;
    status: {
      connected: boolean;
      fileName: string;
      pageId: string;
      pageName: string;
      selectionCount: number;
      selectedNode: Record<string, unknown> | null;
      pluginVersion: string;
      lastSeen: string | null;
      queuedCommands: number;
      activeCommands: number;
    };
  };
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'figma-local-mcp-bridge-'));
  osState.home = sandbox;
  await mkdir(join(sandbox, '.local', 'share', 'figma-local-mcp'), { recursive: true });
  await writeFile(
    join(sandbox, '.local', 'share', 'figma-local-mcp', 'config.json'),
    `${JSON.stringify({ port: 3846, token: TOKEN }, null, 2)}\n`,
  );
  ({ PluginBridge } = await import('../src/server/bridge.js'));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  bridge = new PluginBridge({ port: 0, token: TOKEN });
  await bridge.listen();
  expect(bridge.connectionMode).toBe('listening');
  origin = `http://localhost:${bridge.boundPort}`;
});

afterEach(async () => {
  await bridge.close();
});

describe('auth and basic routing', () => {
  it('returns 401 without a token', async () => {
    const response = await api(origin, '/health', { token: null });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Unauthorized');
  });

  it('returns 401 with a wrong token', async () => {
    const response = await api(origin, '/health', { token: 'c'.repeat(64) });
    expect(response.status).toBe(401);
  });

  it('returns 204 with CORS headers for OPTIONS preflight', async () => {
    const response = await api(origin, '/health', { method: 'OPTIONS', token: null });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('starts disconnected with empty queues', async () => {
    const body = await health();
    expect(body.ok).toBe(true);
    expect(body.bridge).toBe(origin);
    expect(body.status.connected).toBe(false);
    expect(body.status.selectedNode).toBeNull();
    expect(body.status.lastSeen).toBeNull();
    expect(body.status.queuedCommands).toBe(0);
    expect(body.status.activeCommands).toBe(0);
  });

  it('returns 404 for unknown endpoints and 400 for unknown commands', async () => {
    expect((await api(origin, '/nope', { method: 'GET', token: TOKEN })).status).toBe(404);
    expect((await api(origin, '/health', { method: 'PUT', body: {}, token: TOKEN })).status).toBe(404);
    const bad = await api(origin, '/v1/plugin/call', { method: 'POST', body: { name: 'run_js', args: {} }, token: TOKEN });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Unknown plugin command');
  });

  it('returns 400 for invalid JSON bodies', async () => {
    const response = await api(origin, '/v1/plugin/poll', { method: 'POST', rawBody: '{"broken":', token: TOKEN });
    expect(response.status).toBe(400);
  });

  it('returns 413 for bodies over 32 MiB', async () => {
    const response = await api(origin, '/v1/plugin/poll', {
      method: 'POST',
      rawBody: 'a'.repeat(33 * 1024 * 1024),
      token: TOKEN,
    });
    expect(response.status).toBe(413);
    expect(response.body.error).toBe('Request body too large.');
  });
});

describe('plugin status sync', () => {
  it('poll reports document status and returns no command', async () => {
    const response = await pluginPoll();
    expect(response.status).toBe(200);
    expect(response.body.command).toBeNull();

    const body = await health();
    expect(body.status.connected).toBe(true);
    expect(body.status.fileName).toBe('测试文件');
    expect(body.status.pageName).toBe('Page 1');
    expect(body.status.selectionCount).toBe(1);
    expect(body.status.selectedNode).toEqual({ id: '1:1', name: '首页', type: 'FRAME' });
    expect(body.status.lastSeen).not.toBeNull();
  });

  it('clamps oversized fields and zeroes invalid counts', async () => {
    await pluginPoll(TOKEN, documentStatus({
      fileName: 'f'.repeat(600),
      pageId: 'p'.repeat(200),
      selectionCount: 999_999,
      selectedNode: { id: '1:1' },
      pluginVersion: 'v'.repeat(60),
    }));
    const body = await health();
    expect(body.status.fileName.length).toBe(500);
    expect(body.status.pageId.length).toBe(100);
    expect(body.status.selectionCount).toBe(100_000);
    expect(body.status.selectedNode).toBeNull();
    expect(body.status.pluginVersion.length).toBe(50);

    await pluginPoll(TOKEN, documentStatus({ selectionCount: 2.5 }));
    expect((await health()).status.selectionCount).toBe(0);
  });

  it('treats the plugin as disconnected after 5s without reports', async () => {
    await pluginPoll();
    expect((await health()).status.connected).toBe(true);

    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(realNow + 6000));
      expect((await health()).status.connected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('command queue and results', () => {
  it('call rejects while the plugin is not connected', async () => {
    await expect(bridge.call('get_selection', {})).rejects.toThrow(/plugin not connected/);
  });

  it('full cycle: queue, sequential dispatch, result delivery', async () => {
    await pluginPoll();

    const first = bridge.call('get_design_context', { nodeId: '1:1' }, 5000);
    await Promise.resolve();
    const poll1 = await pluginPoll();
    const command1 = poll1.body.command as Record<string, unknown>;
    expect(command1.name).toBe('get_design_context');
    expect(command1.args).toEqual({ nodeId: '1:1' });
    expect(typeof command1.id).toBe('string');

    let body = await health();
    expect(body.status.queuedCommands).toBe(0);
    expect(body.status.activeCommands).toBe(1);

    const second = bridge.call('get_selection', {}, 5000);
    second.catch(() => {});
    await Promise.resolve();
    expect((await pluginPoll()).body.command).toBeNull();
    body = await health();
    expect(body.status.queuedCommands).toBe(1);

    await pluginResult({ id: command1.id, ok: true, result: { document: {}, selection: [] } });
    await expect(first).resolves.toEqual({ document: {}, selection: [] });

    const poll2 = await pluginPoll();
    const command2 = poll2.body.command as Record<string, unknown>;
    expect(command2.name).toBe('get_selection');
    await pluginResult({ id: command2.id, ok: false, error: 'boom' });
    await expect(second).rejects.toThrow('boom');

    body = await health();
    expect(body.status.queuedCommands).toBe(0);
    expect(body.status.activeCommands).toBe(0);
  });

  it('duplicate or unknown result IDs return 404', async () => {
    await pluginPoll();
    const response = await pluginResult({ id: '00000000-0000-4000-8000-000000000000', ok: true });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Unknown or expired command result.');
  });

  it('cleans up queue state after a command timeout', async () => {
    await pluginPoll();
    await expect(bridge.call('get_selection', {}, 60)).rejects.toThrow(/timed out/);

    const body = await health();
    expect(body.status.queuedCommands).toBe(0);
    expect(body.status.activeCommands).toBe(0);
    expect((await pluginPoll()).body.command).toBeNull();
  });

  it('close() rejects pending commands and stops listening', async () => {
    await pluginPoll();
    const first = bridge.call('get_selection', {}, 10_000);
    const second = bridge.call('get_selection', {}, 10_000);
    first.catch(() => {});
    second.catch(() => {});
    await Promise.resolve();

    await bridge.close();
    await expect(first).rejects.toThrow(/shutting down/);
    await expect(second).rejects.toThrow(/shutting down/);
    await expect(api(origin, '/health')).rejects.toThrow();
  });

  it('/v1/plugin/call waits for the result before responding', async () => {
    await pluginPoll();
    const pending = api(origin, '/v1/plugin/call', {
      method: 'POST',
      body: { name: 'get_selection', args: {}, timeoutMs: 3000 },
      token: TOKEN,
    });
    const command = await pollUntilCommand(origin, TOKEN);
    await pluginResult({ id: command.id, ok: true, result: { ok: true } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.result).toEqual({ ok: true });
  });
});

describe('multi-instance reuse', () => {
  it('enters reuse mode behind a same-token instance and forwards commands', async () => {
    const token = 'd'.repeat(64);
    const primary = new PluginBridge({ port: 0, token });
    await primary.listen();
    const port = primary.boundPort;
    if (port === null) throw new Error('Failed to obtain the listening port.');
    const primaryOrigin = `http://localhost:${port}`;

    try {
      await api(primaryOrigin, '/v1/plugin/poll', { method: 'POST', body: documentStatus(), token });

      const secondary = new PluginBridge({ port, token });
      await secondary.listen();
      expect(secondary.connectionMode).toBe('reusing');
      expect((await secondary.getStatus()).connected).toBe(true);

      const forwarded = secondary.call('get_selection', {}, 3000);
      const command = await pollUntilCommand(primaryOrigin, token);
      expect(command.name).toBe('get_selection');
      await api(primaryOrigin, '/v1/plugin/result', {
        method: 'POST',
        body: { id: command.id, ok: true, result: { via: 'reuse' } },
        token,
      });
      await expect(forwarded).resolves.toEqual({ via: 'reuse' });

      await secondary.close();
      const stillAlive = await api(primaryOrigin, '/health', { token });
      expect(stillAlive.status).toBe(200);
    } finally {
      await primary.close();
    }
  });

  it('refuses to start when the port is held by a different-token service', async () => {
    const token = 'e'.repeat(64);
    const primary = new PluginBridge({ port: 0, token });
    await primary.listen();
    const port = primary.boundPort;
    if (port === null) throw new Error('Failed to obtain the listening port.');
    try {
      const intruder = new PluginBridge({ port, token: 'f'.repeat(64) });
      await expect(intruder.listen()).rejects.toThrow(/Unauthorized|another service/);
    } finally {
      await primary.close();
    }
  });
});
