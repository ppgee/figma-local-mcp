import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion(source: string, pattern: RegExp, where: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`No version string found in ${where}.`);
  return match[1];
}

describe('version sync', () => {
  it('keeps package.json, build script and server entry versions in sync', () => {
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

  it('CHANGELOG.md has a section for the current version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const section = changelog.split(/^## \[/m).find((part) => part.startsWith(`${pkg.version}]`));
    expect(section, `CHANGELOG.md is missing a ## [${pkg.version}] section`).toBeTruthy();
    expect((section ?? '').trim().length).toBeGreaterThan(20);
  });
});
