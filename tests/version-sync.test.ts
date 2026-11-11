import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion(source: string, pattern: RegExp, where: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`未在 ${where} 中找到版本号。`);
  return match[1];
}

describe('版本号同步', () => {
  it('package.json、构建脚本与服务端入口的版本号保持一致', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const build = readFileSync(join(root, 'scripts/build.mjs'), 'utf8');
    const server = readFileSync(join(root, 'src/server/index.ts'), 'utf8');

    const versions = new Set([
      pkg.version,
      readVersion(build, /__PLUGIN_VERSION__:\s*JSON\.stringify\('([^']+)'\)/, 'scripts/build.mjs'),
      readVersion(server, /version:\s*'([^']+)'/, 'src/server/index.ts'),
    ]);

    expect(versions.size).toBe(1);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
