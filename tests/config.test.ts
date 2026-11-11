import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osState = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => osState.home,
}));

let sandbox: string;

function configPath(): string {
  return join(sandbox, '.local', 'share', 'figma-local-mcp', 'config.json');
}

async function writeConfig(value: unknown): Promise<void> {
  await mkdir(join(sandbox, '.local', 'share', 'figma-local-mcp'), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'figma-local-mcp-config-'));
  osState.home = sandbox;
  vi.resetModules();
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('local config loading', () => {
  it('fails with an install hint when config is missing', async () => {
    await expect(import('../src/server/config.js')).rejects.toThrow(/Missing local config/);
  });

  it('fails on an invalid token format', async () => {
    await writeConfig({ port: 3846, token: 'z'.repeat(63) });
    await expect(import('../src/server/config.js')).rejects.toThrow(/Invalid local config/);
  });

  it('fails when the port is not 3846', async () => {
    await writeConfig({ port: 9999, token: 'a'.repeat(64) });
    await expect(import('../src/server/config.js')).rejects.toThrow(/Invalid local config/);
  });

  it('exports port, token, bridge origin and export directory for a valid config', async () => {
    const token = 'c'.repeat(64);
    await writeConfig({ port: 3846, token });
    const config = await import('../src/server/config.js');
    expect(config.localConfig).toEqual({ port: 3846, token });
    expect(config.bridgeOrigin).toBe('http://localhost:3846');
    expect(config.exportDirectory).toBe(join(sandbox, '.local', 'share', 'figma-local-mcp', 'exports'));
  });
});
