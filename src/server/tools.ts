import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bridgeOrigin, exportDirectory } from './config.js';
import { messages } from '../shared/messages.js';
import type { Locale } from '../shared/messages.js';
import type { BridgeStatus, ExportPayload, PluginCommandName } from '../shared/protocol.js';

export interface BridgeLike {
  getStatus(): Promise<BridgeStatus>;
  call(
    name: PluginCommandName,
    args: Record<string, unknown>,
    timeoutMs?: number,
    fileKey?: string,
  ): Promise<unknown>;
  /** Locale reported by the plugin; drives localized runtime messages. */
  getLocale?(): Locale | null;
}

const nodeIdSchema = z.string().min(1).optional();

/**
 * Workflow guidance attached to get_plugin_status so every MCP client learns the
 * intended usage on its first call, without any client-side skill or setup.
 * Kept in English on purpose: it targets models, like the tool descriptions.
 */
const usageHints: readonly string[] = [
  'Design-to-code flow: get_screenshot for a visual overview first, then get_design_context for structure, then get_variable_defs/get_style_defs for exact tokens, then export_node for assets.',
  'get_screenshot returns an image for visual reference; get_design_context returns structured data for writing code.',
  'Omit nodeId to use the single selected node. With no or multiple nodes selected, call get_document (page list) and find_nodes (name/type search) to locate a node ID first.',
  'The plugin must be running in the Figma desktop app; its window may be collapsed but not closed. If nothing is connected, ask the user to open the plugin.',
  'When several files are connected, pass the fileKey from this status to target one file; otherwise the most recently active file is used.',
];
const fileKeySchema = z.string().min(1).max(100).optional()
  .describe('Optional key of the Figma file to target. Omit to use the most recently active file; see get_plugin_status.');

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

export function validateExport(value: unknown, locale: Locale = 'en'): ExportPayload {
  const m = messages(locale);
  const payload = value as ExportPayload;
  if (!payload || typeof payload.data !== 'string' || typeof payload.byteLength !== 'number') {
    throw new Error(m.invalidExport);
  }
  if (payload.byteLength > 12 * 1024 * 1024) throw new Error(m.exportSizeLimit);
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

export async function saveExport(payload: ExportPayload, directory: string = exportDirectory, locale: Locale = 'en'): Promise<string> {
  const data = Buffer.from(payload.data, 'base64');
  if (data.length !== payload.byteLength) throw new Error(messages(locale).exportLengthCheck);
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
  const locale = (): Locale => bridge.getLocale?.() ?? 'en';
  server.registerTool(
    'get_plugin_status',
    {
      title: 'Get local Figma plugin status',
      description: 'Check which Figma files are connected through the local desktop plugin, which file is active, and the current selection in it.',
      inputSchema: {},
    },
    async () => textResult({ bridge: bridgeOrigin, ...await bridge.getStatus(), usageHints }),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get Figma document overview',
      description: 'List all pages with node counts and the local resource counts (variables, collections, styles) of the open Figma file.',
      inputSchema: { fileKey: fileKeySchema },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      return textResult(await bridge.call('get_document', pluginArgs, undefined, fileKey));
    }),
  );

  server.registerTool(
    'get_selection',
    {
      title: 'Get Figma selection',
      description: 'Read the current selection in the open Figma file through the local desktop plugin.',
      inputSchema: { fileKey: fileKeySchema },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      return textResult(await bridge.call('get_selection', pluginArgs, undefined, fileKey));
    }),
  );

  server.registerTool(
    'find_nodes',
    {
      title: 'Find Figma nodes',
      description: 'Search the whole file (or one page) for nodes by name substring and/or node type, returning matching node IDs with their pages.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Case-insensitive substring to match node names.'),
        types: z.array(z.string().min(1)).min(1).max(20).optional()
          .describe('Node types to match (AND with query), e.g. ["FRAME", "INSTANCE", "TEXT"].'),
        pageId: z.string().min(1).optional().describe('Optional page ID to limit the search to one page (see get_document).'),
        maxResults: z.number().int().min(1).max(500).default(50),
        fileKey: fileKeySchema,
      },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      return textResult(await bridge.call('find_nodes', pluginArgs, undefined, fileKey));
    }),
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
        fileKey: fileKeySchema,
      },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      return textResult(await bridge.call('get_design_context', pluginArgs, undefined, fileKey));
    }),
  );

  server.registerTool(
    'get_variable_defs',
    {
      title: 'Get local Figma variables',
      description: 'Read local variable collections and variable values from the open Figma file.',
      inputSchema: {
        maxVariables: z.number().int().min(1).max(2000).default(200),
        fileKey: fileKeySchema,
      },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      return textResult(await bridge.call('get_variable_defs', pluginArgs, undefined, fileKey));
    }),
  );

  server.registerTool(
    'get_style_defs',
    {
      title: 'Get local Figma styles',
      description: 'Read local paint, text, effect and grid styles from the open Figma file (useful for design tokens).',
      inputSchema: {
        maxStyles: z.number().int().min(1).max(2000).default(200),
        fileKey: fileKeySchema,
      },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      return textResult(await bridge.call('get_style_defs', pluginArgs, undefined, fileKey));
    }),
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
        fileKey: fileKeySchema,
      },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      const currentLocale = locale();
      const payload = validateExport(await bridge.call('export_node', pluginArgs, 120_000, fileKey), currentLocale);
      const path = await saveExport(payload, exportDirectory, currentLocale);
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
        fileKey: fileKeySchema,
      },
    },
    (args) => handleTool(async () => {
      const { fileKey, ...pluginArgs } = args;
      const payload = validateExport(await bridge.call('export_node', {
        nodeId: pluginArgs.nodeId,
        format: 'PNG',
        scale: 1,
        maxDimension: pluginArgs.maxDimension,
      }, 120_000, fileKey), locale());
      if (payload.byteLength > 8 * 1024 * 1024) {
        throw new Error(messages(locale()).screenshotTooLarge);
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
