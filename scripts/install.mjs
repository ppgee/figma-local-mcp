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
import { spawnSync } from 'node:child_process';
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

// Resident background bridge: a launchd LaunchAgent keeps the bridge alive
// (RunAtLoad + KeepAlive) so the plugin never loses the port when MCP
// sessions exit. MCP processes reuse it via the existing fallback path.
const agentsDir = join(home, 'Library', 'LaunchAgents');
const agentLabel = 'com.figma-local-mcp.bridge';
const plistPath = join(agentsDir, `${agentLabel}.plist`);
const logPath = join(installRoot, 'bridge.log');
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${agentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(appPath, 'dist', 'server', 'index.js'))}</string>
    <string>--bridge</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
mkdirSync(agentsDir, { recursive: true });
writeFileSync(plistPath, plist);

const uid = process.getuid();
const guiDomain = `gui/${uid}`;
spawnSync('launchctl', ['bootout', guiDomain, plistPath], { stdio: 'ignore' }); // not loaded yet on first install
const bootstrap = spawnSync('launchctl', ['bootstrap', guiDomain, plistPath], { encoding: 'utf8' });
if (bootstrap.status !== 0) {
  // Older launchd without bootstrap/bootout
  spawnSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
  const loaded = spawnSync('launchctl', ['load', '-w', plistPath], { encoding: 'utf8' });
  if (loaded.status !== 0) {
    console.warn(`Could not start the background bridge service: ${(bootstrap.stderr || loaded.stderr || '').trim()}`);
    console.warn('The bridge will only run while an MCP client session is active.');
  }
}

console.log(`Installed app: ${appPath}`);
console.log(`Figma manifest: ${join(appPath, 'manifest.json')}`);
console.log(`MCP command: ${launcherPath}`);
console.log(`Background bridge: ${agentLabel} (log: ${logPath})`);
if (!`${process.env.PATH || ''}`.split(':').includes(join(home, '.local', 'bin'))) {
  console.log('Add ~/.local/bin to PATH to use the figma-local-mcp command by name.');
}
