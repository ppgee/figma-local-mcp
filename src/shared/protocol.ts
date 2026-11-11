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
  /** Figma file key; stable per file. The plugin uses a synthetic key for unsaved drafts. */
  fileKey: string;
  fileName: string;
  pageId: string;
  pageName: string;
  selectionCount: number;
  selectedNode: PluginSelectedNode | null;
  pluginVersion: string;
  locale: Locale;
}

/** Status of one connected Figma file (one bridge session per file key). */
export interface FileSessionStatus extends PluginDocumentStatus {
  lastSeen: string;
  queuedCommands: number;
  activeCommands: number;
}

export interface BridgeStatus {
  connected: boolean;
  /** File key of the most recently active session; null when nothing is connected. */
  activeFileKey: string | null;
  /** Connected files, most recently active first. */
  files: FileSessionStatus[];
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
