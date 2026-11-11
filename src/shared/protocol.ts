import type { Locale } from './messages';

export type PluginCommandName =
  | 'get_selection'
  | 'get_design_context'
  | 'get_variable_defs'
  | 'export_node';

export interface PluginCommand {
  id: string;
  name: PluginCommandName;
  args: Record<string, unknown>;
}

export interface PluginResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PluginSelectedNode {
  id: string;
  name: string;
  type: string;
}

export interface PluginDocumentStatus {
  fileName: string;
  pageId: string;
  pageName: string;
  selectionCount: number;
  selectedNode: PluginSelectedNode | null;
  pluginVersion: string;
  locale: Locale;
}

export interface BridgeStatus extends PluginDocumentStatus {
  connected: boolean;
  lastSeen: string | null;
  queuedCommands: number;
  activeCommands: number;
}

export interface ExportPayload {
  nodeId: string;
  nodeName: string;
  format: 'PNG' | 'SVG' | 'JPG' | 'PDF';
  mimeType: 'image/png' | 'image/svg+xml' | 'image/jpeg' | 'application/pdf';
  data: string;
  byteLength: number;
  scale: number;
}
