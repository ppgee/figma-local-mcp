import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bridgeOrigin, exportDirectory } from './config.js';
import type { BridgeStatus, ExportPayload, PluginCommandName } from '../shared/protocol.js';

export interface BridgeLike {
  getStatus(): Promise<BridgeStatus>;
  call(name: PluginCommandName, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

const nodeIdSchema = z.string().min(1).optional();

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

async function handleTool(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function validateExport(value: unknown): ExportPayload {
  const payload = value as ExportPayload;
  if (!payload || typeof payload.data !== 'string' || typeof payload.byteLength !== 'number') {
    throw new Error('The plugin returned an invalid export result.');
  }
  if (payload.byteLength > 12 * 1024 * 1024) throw new Error('Export result exceeds the size limit.');
  return payload;
}

/**
 * Clamp a name to the given number of UTF-8 bytes (cutting at code point boundaries)
 * so multi-byte names never hit the Linux/macOS file name length limit (ENAMETOOLONG).
 */
function clampNameBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  let out = '';
  for (const character of name) {
    if (Buffer.byteLength(out + character, 'utf8') > maxBytes) break;
    out += character;
  }
  return out;
}

export async function saveExport(payload: ExportPayload, directory: string = exportDirectory): Promise<string> {
  const data = Buffer.from(payload.data, 'base64');
  if (data.length !== payload.byteLength) throw new Error('Export result failed the length check.');
  await mkdir(directory, { recursive: true });
  const extension = payload.format.toLowerCase();
  const safeName = clampNameBytes(
    payload.nodeName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 80),
    120,
  ) || 'figma-node';
  const safeId = payload.nodeId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const path = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeId}-${safeName}.${extension}`);
  await writeFile(path, data, { flag: 'wx' });
  return path;
}

export function registerTools(server: McpServer, bridge: BridgeLike): void {
  server.registerTool(
    'get_plugin_status',
    {
      title: 'Get local Figma plugin status',
      description: 'Check whether the local Figma desktop bridge plugin is connected.',
      inputSchema: {},
    },
    async () => textResult({ bridge: bridgeOrigin, ...await bridge.getStatus() }),
  );

  server.registerTool(
    'get_selection',
    {
      title: 'Get Figma selection',
      description: 'Read the current selection in the open Figma file through the local desktop plugin.',
      inputSchema: {},
    },
    () => handleTool(async () => textResult(await bridge.call('get_selection', {}))),
  );

  server.registerTool(
    'get_design_context',
    {
      title: 'Get Figma design context',
      description: 'Read layout, styles, text, components and variable bindings for a selected Frame or a node ID. Uses the local Plugin API, not the Figma REST API.',
      inputSchema: {
        nodeId: nodeIdSchema.describe('Optional Figma node ID. Omit to use the single selected node.'),
        maxDepth: z.number().int().min(0).max(20).default(6),
        maxNodes: z.number().int().min(1).max(2000).default(300),
      },
    },
    (args) => handleTool(async () => textResult(await bridge.call('get_design_context', args))),
  );

  server.registerTool(
    'get_variable_defs',
    {
      title: 'Get local Figma variables',
      description: 'Read local variable collections and variable values from the open Figma file.',
      inputSchema: {
        maxVariables: z.number().int().min(1).max(2000).default(200),
      },
    },
    (args) => handleTool(async () => textResult(await bridge.call('get_variable_defs', args))),
  );

  server.registerTool(
    'export_node',
    {
      title: 'Export a Figma node',
      description: 'Export the selected node or a node ID as PNG, SVG, JPG or PDF through the desktop plugin and save it locally.',
      inputSchema: {
        nodeId: nodeIdSchema,
        format: z.enum(['PNG', 'SVG', 'JPG', 'PDF']).default('PNG'),
        scale: z.number().min(0.01).max(4).default(1),
      },
    },
    (args) => handleTool(async () => {
      const payload = validateExport(await bridge.call('export_node', args, 120_000));
      const path = await saveExport(payload);
      return textResult({
        path,
        nodeId: payload.nodeId,
        nodeName: payload.nodeName,
        format: payload.format,
        byteLength: payload.byteLength,
        scale: payload.scale,
      });
    }),
  );

  server.registerTool(
    'get_screenshot',
    {
      title: 'Get a Figma node screenshot',
      description: 'Render the selected node or a node ID to a PNG image through the desktop plugin.',
      inputSchema: {
        nodeId: nodeIdSchema,
        maxDimension: z.number().int().min(128).max(2048).default(1200),
      },
    },
    (args) => handleTool(async () => {
      const payload = validateExport(await bridge.call('export_node', {
        nodeId: args.nodeId,
        format: 'PNG',
        scale: 1,
        maxDimension: args.maxDimension,
      }, 120_000));
      if (payload.byteLength > 8 * 1024 * 1024) {
        throw new Error('Screenshot exceeds 8 MiB; lower maxDimension, or use export_node to save a file instead.');
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ nodeId: payload.nodeId, nodeName: payload.nodeName, scale: payload.scale }),
          },
          { type: 'image', data: payload.data, mimeType: 'image/png' },
        ],
      };
    }),
  );
}
