import type { PluginCommand, PluginResult } from '../shared/protocol';
import { executeCommand, readDocumentStatus } from './commands';
import { createNodePrompt } from './prompt';

declare const __BRIDGE_ORIGIN__: string;
declare const __BRIDGE_TOKEN__: string;
declare const __PLUGIN_VERSION__: string;

const EXPANDED_SIZE = { width: 360, height: 476 };
const COLLAPSED_SIZE = { width: 328, height: 60 };
const VIEW_STORAGE_KEY = 'ui-collapsed';
let connected = false;
let polling = false;
let executing = false;
let collapsed = false;

figma.showUI(__html__, { ...EXPANDED_SIZE, title: 'Figma Local MCP', themeColors: true });

function emitStatus(): void {
  const status = readDocumentStatus(figma, __PLUGIN_VERSION__);
  figma.ui.postMessage({
    type: 'status',
    connected,
    ...status,
    prompt: status.selectedNode ? createNodePrompt(status.selectedNode) : '',
  });
}

async function restoreView(): Promise<void> {
  try {
    collapsed = await figma.clientStorage.getAsync(VIEW_STORAGE_KEY) === true;
  } catch {
    collapsed = false;
  }
  figma.ui.resize(
    collapsed ? COLLAPSED_SIZE.width : EXPANDED_SIZE.width,
    collapsed ? COLLAPSED_SIZE.height : EXPANDED_SIZE.height,
  );
  figma.ui.postMessage({ type: 'view', collapsed });
}

function setCollapsed(value: boolean): void {
  collapsed = value;
  figma.ui.resize(value ? COLLAPSED_SIZE.width : EXPANDED_SIZE.width, value ? COLLAPSED_SIZE.height : EXPANDED_SIZE.height);
  figma.ui.postMessage({ type: 'view', collapsed });
  void figma.clientStorage.setAsync(VIEW_STORAGE_KEY, collapsed).catch(() => {
    figma.ui.postMessage({ type: 'notice', message: 'View switched, but the preference could not be saved.' });
  });
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${__BRIDGE_ORIGIN__}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${__BRIDGE_TOKEN__}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Local service returned ${response.status}`);
  return payload;
}

async function runCommand(command: PluginCommand): Promise<void> {
  if (executing) return;
  executing = true;
  try {
    const result = await executeCommand(figma, __PLUGIN_VERSION__, command);
    await request<{ ok: boolean }>('/v1/plugin/result', { id: command.id, ok: true, result } satisfies PluginResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await request<{ ok: boolean }>('/v1/plugin/result', { id: command.id, ok: false, error: message } satisfies PluginResult);
    } catch {
      connected = false;
      emitStatus();
    }
  } finally {
    executing = false;
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const response = await request<{ command: PluginCommand | null }>('/v1/plugin/poll', readDocumentStatus(figma, __PLUGIN_VERSION__));
    if (!connected) {
      connected = true;
      emitStatus();
    }
    if (response.command) void runCommand(response.command);
  } catch {
    if (connected) {
      connected = false;
      emitStatus();
    }
  } finally {
    polling = false;
  }
}

figma.on('selectionchange', emitStatus);
figma.on('currentpagechange', emitStatus);
figma.ui.onmessage = (message: { type?: string; requestId?: number; collapsed?: boolean }) => {
  switch (message.type) {
    case 'ready':
      void restoreView();
      emitStatus();
      break;
    case 'copy-prompt': {
      const status = readDocumentStatus(figma, __PLUGIN_VERSION__);
      if (!status.selectedNode) {
        emitStatus();
        figma.ui.postMessage({
          type: 'prompt-error',
          requestId: message.requestId,
          message: status.selectionCount > 1 ? 'Select only one layer, then copy.' : 'Select a layer in Figma first.',
        });
        break;
      }
      emitStatus();
      figma.ui.postMessage({
        type: 'prompt',
        requestId: message.requestId,
        node: status.selectedNode,
        prompt: createNodePrompt(status.selectedNode),
      });
      break;
    }
    case 'set-view':
      setCollapsed(message.collapsed === true);
      break;
    case 'retry':
      void poll().finally(emitStatus);
      break;
  }
};

emitStatus();
void poll();
setInterval(() => void poll(), 750);
