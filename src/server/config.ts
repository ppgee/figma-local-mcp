import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface LocalConfig {
  port: number;
  token: string;
}

const dataRoot = join(homedir(), '.local', 'share', 'figma-local-mcp');
const configPath = join(dataRoot, 'config.json');

if (!existsSync(configPath)) {
  throw new Error('Missing local config; run pnpm install:local first.');
}

const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<LocalConfig>;
if (parsed.port !== 3846 || typeof parsed.token !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.token)) {
  throw new Error('Invalid local config; back it up, delete config.json in the install directory, and reinstall.');
}

export const localConfig: LocalConfig = {
  port: parsed.port,
  token: parsed.token,
};

export const bridgeOrigin = `http://localhost:${localConfig.port}`;
export const exportDirectory = join(dataRoot, 'exports');
