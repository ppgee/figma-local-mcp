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

describe('本地配置加载', () => {
  it('缺少配置时报错并提示安装命令', async () => {
    await expect(import('../src/server/config.js')).rejects.toThrow(/缺少本地配置/);
  });

  it('令牌格式非法时报错', async () => {
    await writeConfig({ port: 3846, token: 'z'.repeat(63) });
    await expect(import('../src/server/config.js')).rejects.toThrow(/本地配置无效/);
  });

  it('端口不是 3846 时报错', async () => {
    await writeConfig({ port: 9999, token: 'a'.repeat(64) });
    await expect(import('../src/server/config.js')).rejects.toThrow(/本地配置无效/);
  });

  it('合法配置导出端口、令牌、桥接地址与导出目录', async () => {
    const token = 'c'.repeat(64);
    await writeConfig({ port: 3846, token });
    const config = await import('../src/server/config.js');
    expect(config.localConfig).toEqual({ port: 3846, token });
    expect(config.bridgeOrigin).toBe('http://localhost:3846');
    expect(config.exportDirectory).toBe(join(sandbox, '.local', 'share', 'figma-local-mcp', 'exports'));
  });
});
