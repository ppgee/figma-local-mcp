import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataRoot = join(homedir(), '.local', 'share', 'figma-local-mcp');
const configPath = join(dataRoot, 'config.json');
const legacyConfigPath = join(root, '.figma-local-mcp.json');
let config;
let shouldWriteConfig = false;

if (existsSync(configPath)) {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} else if (existsSync(legacyConfigPath)) {
  config = JSON.parse(readFileSync(legacyConfigPath, 'utf8'));
  shouldWriteConfig = true;
} else {
  config = { port: 3846, token: randomBytes(32).toString('hex') };
  shouldWriteConfig = true;
}

if (config.port !== 3846 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) {
  throw new Error('Invalid local config; back it up and remove it before rebuilding.');
}

mkdirSync(dataRoot, { recursive: true });
if (shouldWriteConfig) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
chmodSync(configPath, 0o600);

const bridgeOrigin = `http://localhost:${config.port}`;
mkdirSync(join(root, 'dist/plugin'), { recursive: true });
mkdirSync(join(root, 'dist/server'), { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(root, 'src/server/index.ts')],
    outfile: join(root, 'dist/server/index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  }),
  build({
    entryPoints: [join(root, 'src/plugin/code.ts')],
    outfile: join(root, 'dist/plugin/code.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    define: {
      __BRIDGE_ORIGIN__: JSON.stringify(bridgeOrigin),
      __BRIDGE_TOKEN__: JSON.stringify(config.token),
      __PLUGIN_VERSION__: JSON.stringify('0.2.1'),
    },
  }),
]);

copyFileSync(join(root, 'src/plugin/ui.html'), join(root, 'dist/plugin/ui.html'));
chmodSync(join(root, 'dist/server/index.js'), 0o755);
console.log('Built standalone MCP server and Figma plugin.');
