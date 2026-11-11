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
  throw new Error('缺少本地配置，请先运行 pnpm install:local。');
}

const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<LocalConfig>;
if (parsed.port !== 3846 || typeof parsed.token !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.token)) {
  throw new Error('本地配置无效，请备份后删除固定安装目录中的 config.json，再重新安装。');
}

export const localConfig: LocalConfig = {
  port: parsed.port,
  token: parsed.token,
};

export const bridgeOrigin = `http://localhost:${localConfig.port}`;
export const exportDirectory = join(dataRoot, 'exports');
