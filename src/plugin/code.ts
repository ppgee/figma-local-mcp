import type { PluginCommand, PluginResult } from '../shared/protocol';
import type { Locale } from '../shared/messages';
import { messages } from '../shared/messages';
import { executeCommand, readDocumentStatus } from './commands';
import { createNodePrompt } from './prompt';

declare const __BRIDGE_ORIGIN__: string;
declare const __BRIDGE_TOKEN__: string;
declare const __PLUGIN_VERSION__: string;

const EXPANDED_SIZE = { width: 360, height: 476 };
const COLLAPSED_SIZE = { width: 328, height: 60 };
const VIEW_STORAGE_KEY = 'ui-collapsed';
const LOCALE_STORAGE_KEY = 'ui-locale';
let connected = false;
let polling = false;
let executing = false;
let collapsed = false;
let uiLocale: Locale = 'en';

figma.showUI(__html__, { ...EXPANDED_SIZE, title: 'Figma Local MCP', themeColors: true });

function m() {
  return messages(uiLocale);
}

function emitStatus(): void {
  const status = readDocumentStatus(figma, __PLUGIN_VERSION__, uiLocale);
  figma.ui.postMessage({
    type: 'status',
    connected,
    ...status,
    prompt: status.selectedNode ? createNodePrompt(status.selectedNode, uiLocale) : '',
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

async function restoreLocale(): Promise<void> {
  try {
    const stored = await figma.clientStorage.getAsync(LOCALE_STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') {
      uiLocale = stored;
      figma.ui.postMessage({ type: 'locale', locale: stored });
    } else {
      figma.ui.postMessage({ type: 'locale', locale: 'auto' });
    }
  } catch {
    figma.ui.postMessage({ type: 'locale', locale: 'auto' });
  }
}

function setCollapsed(value: boolean): void {
  collapsed = value;
  figma.ui.resize(value ? COLLAPSED_SIZE.width : EXPANDED_SIZE.width, value ? COLLAPSED_SIZE.height : EXPANDED_SIZE.height);
  figma.ui.postMessage({ type: 'view', collapsed });
  void figma.clientStorage.setAsync(VIEW_STORAGE_KEY, collapsed).catch(() => {
    figma.ui.postMessage({ type: 'notice', message: m().viewSaveNotice });
  });
}

function setLocale(locale: Locale, persist: boolean): void {
  if (locale !== 'zh' && locale !== 'en') return;
  uiLocale = locale;
  if (!persist) return;
  void figma.clientStorage.setAsync(LOCALE_STORAGE_KEY, locale).catch(() => {
    figma.ui.postMessage({ type: 'notice', message: m().localeSaveNotice });
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
  if (!response.ok) throw new Error(payload.error || m().localServiceReturned(response.status));
  return payload;
}

async function runCommand(command: PluginCommand): Promise<void> {
  if (executing) return;
  executing = true;
  try {
    const result = await executeCommand(figma, __PLUGIN_VERSION__, uiLocale, command);
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
    const response = await request<{ command: PluginCommand | null }>('/v1/plugin/poll', readDocumentStatus(figma, __PLUGIN_VERSION__, uiLocale));
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
figma.ui.onmessage = (message: { type?: string; requestId?: number; collapsed?: boolean; locale?: string; persist?: boolean }) => {
  switch (message.type) {
    case 'ready':
      void restoreView();
      void restoreLocale();
      emitStatus();
      break;
    case 'copy-prompt': {
      const status = readDocumentStatus(figma, __PLUGIN_VERSION__, uiLocale);
      if (!status.selectedNode) {
        emitStatus();
        figma.ui.postMessage({
          type: 'prompt-error',
          requestId: message.requestId,
          message: status.selectionCount > 1 ? m().promptErrorMulti : m().promptErrorNone,
        });
        break;
      }
      emitStatus();
      figma.ui.postMessage({
        type: 'prompt',
        requestId: message.requestId,
        node: status.selectedNode,
        prompt: createNodePrompt(status.selectedNode, uiLocale),
      });
      break;
    }
    case 'set-view':
      setCollapsed(message.collapsed === true);
      break;
    case 'set-locale':
      setLocale(message.locale === 'zh' || message.locale === 'en' ? message.locale : 'en', message.persist === true);
      emitStatus();
      break;
    case 'retry':
      void poll().finally(emitStatus);
      break;
  }
};

emitStatus();
void poll();
setInterval(() => void poll(), 750);
