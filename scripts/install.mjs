import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const installRoot = join(home, '.local', 'share', 'figma-local-mcp');
const appPath = join(home, 'figma-local-mcp-app');
const stagingPath = join(installRoot, `.app-new-${process.pid}`);
const backupPath = join(installRoot, `app-backup-${Date.now()}`);
const launcherPath = join(home, '.local', 'bin', 'figma-local-mcp');

mkdirSync(stagingPath, { recursive: true });
cpSync(join(sourceRoot, 'dist'), join(stagingPath, 'dist'), { recursive: true });
copyFileSync(join(sourceRoot, 'manifest.json'), join(stagingPath, 'manifest.json'));
copyFileSync(join(sourceRoot, 'package.json'), join(stagingPath, 'package.json'));
mkdirSync(join(installRoot, 'exports'), { recursive: true });

let previousLink = null;
let backupCreated = false;
try {
  if (existsSync(appPath)) {
    if (lstatSync(appPath).isSymbolicLink()) {
      previousLink = readlinkSync(appPath);
      unlinkSync(appPath);
    } else {
      renameSync(appPath, backupPath);
      backupCreated = true;
    }
  }
  renameSync(stagingPath, appPath);
} catch (error) {
  if (backupCreated && !existsSync(appPath)) renameSync(backupPath, appPath);
  if (previousLink && !existsSync(appPath)) symlinkSync(previousLink, appPath, 'dir');
  throw error;
}

if (
  existsSync(launcherPath)
  && !readFileSync(launcherPath, 'utf8').includes('.local/share/figma-local-mcp/app')
  && !readFileSync(launcherPath, 'utf8').includes('figma-local-mcp-app/dist/server/index.js')
) {
  throw new Error(`${launcherPath} is owned by another program; not overwritten.`);
}

const fallbackNode = process.execPath.replaceAll("'", "'\\''");
const launcher = `#!/bin/bash
set -euo pipefail
APP="$HOME/figma-local-mcp-app/dist/server/index.js"
if command -v node >/dev/null 2>&1; then
  exec node "$APP" "$@"
fi
if [[ -x '${fallbackNode}' ]]; then
  exec '${fallbackNode}' "$APP" "$@"
fi
echo "Node.js 22 or newer is required." >&2
exit 1
`;
mkdirSync(dirname(launcherPath), { recursive: true });
writeFileSync(launcherPath, launcher, { mode: 0o755 });
chmodSync(launcherPath, 0o755);

console.log(`Installed app: ${appPath}`);
console.log(`Figma manifest: ${join(appPath, 'manifest.json')}`);
console.log(`MCP command: ${launcherPath}`);
if (!`${process.env.PATH || ''}`.split(':').includes(join(home, '.local', 'bin'))) {
  console.log('Add ~/.local/bin to PATH to use the figma-local-mcp command by name.');
}
