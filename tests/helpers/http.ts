export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  rawBody?: string;
}

/**
 * 向本地桥接发起 HTTP 请求；token 传 null 表示不带 Authorization 头。
 */
export async function api(origin: string, path: string, options: ApiOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'a'.repeat(64)}`;
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export interface DocumentStatusInput {
  fileName?: string;
  pageId?: string;
  pageName?: string;
  selectionCount?: number;
  selectedNode?: Record<string, unknown> | null;
  pluginVersion?: string;
}

export function documentStatus(overrides: DocumentStatusInput = {}): Record<string, unknown> {
  return {
    fileName: overrides.fileName ?? '测试文件',
    pageId: overrides.pageId ?? '0:1',
    pageName: overrides.pageName ?? 'Page 1',
    selectionCount: overrides.selectionCount ?? 1,
    selectedNode: overrides.selectedNode === undefined
      ? { id: '1:1', name: '首页', type: 'FRAME' }
      : overrides.selectedNode,
    pluginVersion: overrides.pluginVersion ?? '0.1.0',
  };
}
