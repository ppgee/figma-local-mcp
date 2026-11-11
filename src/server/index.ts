#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PluginBridge } from './bridge.js';
import { bridgeOrigin } from './config.js';
import { registerTools } from './tools.js';

const bridge = new PluginBridge();
const server = new McpServer({ name: 'figma-local-mcp', version: '0.4.0' });
registerTools(server, bridge);

await bridge.listen();
const transport = new StdioServerTransport();
transport.onclose = () => {
  void bridge.close();
};
await server.connect(transport);
console.error(`[figma-local-mcp] Bridge mode: ${bridge.connectionMode}; endpoint: ${bridgeOrigin}`);
