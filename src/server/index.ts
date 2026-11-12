#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PluginBridge } from './bridge.js';
import { bridgeOrigin } from './config.js';
import { registerTools } from './tools.js';

function logMode(bridge: PluginBridge): void {
  console.error(`[figma-local-mcp] Bridge mode: ${bridge.connectionMode}; endpoint: ${bridgeOrigin}`);
}

if (process.argv.includes('--bridge')) {
  // Resident daemon mode (launchd): hold the bridge independent of MCP client
  // sessions, and take over the port as soon as any previous holder exits.
  const bridge = new PluginBridge();
  await bridge.listen();
  logMode(bridge);
  let lastMode = bridge.connectionMode;
  const retry = setInterval(() => {
    void bridge.tryListen()
      .then(() => {
        if (bridge.connectionMode !== lastMode) {
          lastMode = bridge.connectionMode;
          logMode(bridge);
        }
      })
      .catch(() => {});
  }, 5000);
  const shutdown = () => {
    clearInterval(retry);
    void bridge.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} else {
  const bridge = new PluginBridge();
  const server = new McpServer({ name: 'figma-local-mcp', version: '0.7.1' });
  registerTools(server, bridge);

  await bridge.listen();
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void bridge.close();
  };
  await server.connect(transport);
  logMode(bridge);
}
