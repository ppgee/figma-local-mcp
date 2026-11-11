import { describe, expect, it, beforeAll } from 'vitest';
import { cloneValue, createDesignContext, summarizeNode } from '../src/plugin/serialize';

const documentInfo = { fileName: '测试文件', pageId: '0:1', pageName: 'Page 1' };

const mixed = Symbol('figma.mixed');

beforeAll(() => {
  (globalThis as unknown as { figma: unknown }).figma = {
    mixed,
    root: { name: '测试文件' },
    currentPage: { id: '0:1', name: 'Page 1' },
  };
});

function makeNode(overrides: Record<string, unknown> = {}): SceneNode {
  return {
    id: '1:1',
    name: 'node',
    type: 'FRAME',
    visible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    ...overrides,
  } as unknown as SceneNode;
}

describe('cloneValue', () => {
  it('原样返回基础类型', () => {
    expect(cloneValue(null)).toBeNull();
    expect(cloneValue('text')).toBe('text');
    expect(cloneValue(42)).toBe(42);
    expect(cloneValue(true)).toBe(true);
    expect(cloneValue(undefined)).toBeUndefined();
  });

  it('把 figma.mixed 符号转换为标记对象', () => {
    expect(cloneValue(mixed)).toEqual({ mixed: true });
  });

  it('把其他符号转换为描述字符串', () => {
    expect(cloneValue(Symbol('custom'))).toBe('custom');
  });

  it('bigint 转换为字符串，函数被丢弃', () => {
    expect(cloneValue(10n)).toBe('10');
    expect(cloneValue(() => 'x')).toBeUndefined();
    expect(cloneValue({ keep: 1, drop: () => 2 })).toEqual({ keep: 1 });
  });

  it('递归克隆数组与嵌套对象', () => {
    const value = { list: [1, { inner: 'x' }], nested: { deep: { n: null } } };
    const cloned = cloneValue(value) as typeof value;
    expect(cloned).toEqual(value);
    expect(cloned).not.toBe(value);
    expect(cloned.nested).not.toBe(value.nested);
  });

  it('对象中值为 undefined 的键被移除', () => {
    expect(cloneValue({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('循环引用被替换为占位符', () => {
    const value: Record<string, unknown> = { name: 'root' };
    value.self = value;
    expect(cloneValue(value)).toEqual({ name: 'root', self: '[Circular]' });
  });

  it('同级不同对象不误判为循环引用', () => {
    const shared = { id: 'shared' };
    const cloned = cloneValue({ a: shared, b: shared }) as Record<string, unknown>;
    expect(cloned).toEqual({ a: { id: 'shared' }, b: { id: 'shared' } });
  });
});

describe('summarizeNode', () => {
  it('返回节点摘要字段', () => {
    expect(summarizeNode(makeNode({ id: '2:9', name: '按钮', type: 'RECTANGLE' }))).toEqual({
      id: '2:9',
      name: '按钮',
      type: 'RECTANGLE',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    });
  });
});

describe('createDesignContext', () => {
  it('返回文档信息、根节点与统计字段', () => {
    const root = makeNode({ id: '9:9', name: '首页', children: [] });
    const context = createDesignContext(root, { maxDepth: 6, maxNodes: 300 }, documentInfo);
    expect(context.document).toEqual({ fileName: '测试文件', pageId: '0:1', pageName: 'Page 1' });
    expect(context.root).toMatchObject({ id: '9:9', name: '首页', type: 'FRAME' });
    expect(context.nodesVisited).toBe(1);
    expect(context.truncated).toBe(false);
    expect(context.maxDepth).toBe(6);
    expect(context.maxNodes).toBe(300);
  });

  it('只输出白名单键，忽略多余属性', () => {
    const root = makeNode({ secret: 'nope', customField: 1, children: [] });
    const context = createDesignContext(root, { maxDepth: 6, maxNodes: 300 }, documentInfo);
    const serialized = context.root as Record<string, unknown>;
    expect(serialized).not.toHaveProperty('secret');
    expect(serialized).not.toHaveProperty('customField');
    expect(serialized).toHaveProperty('absoluteBoundingBox');
  });

  it('TEXT 节点带文本键，非 TEXT 节点不带', () => {
    const text = createDesignContext(
      makeNode({ type: 'TEXT', characters: '你好', fontSize: 14, children: [] }),
      { maxDepth: 2, maxNodes: 10 },
      documentInfo,
    ).root as Record<string, unknown>;
    expect(text.characters).toBe('你好');
    expect(text.fontSize).toBe(14);

    const frame = createDesignContext(
      makeNode({ type: 'FRAME', children: [] }),
      { maxDepth: 2, maxNodes: 10 },
      documentInfo,
    ).root as Record<string, unknown>;
    expect(frame).not.toHaveProperty('characters');
    expect(frame).not.toHaveProperty('fontSize');
  });

  it('INSTANCE/COMPONENT 节点带组件键', () => {
    const instance = createDesignContext(
      makeNode({ type: 'INSTANCE', key: 'abc123', children: [] }),
      { maxDepth: 2, maxNodes: 10 },
      documentInfo,
    ).root as Record<string, unknown>;
    expect(instance.key).toBe('abc123');

    const group = createDesignContext(
      makeNode({ type: 'GROUP', key: 'abc123', children: [] }),
      { maxDepth: 2, maxNodes: 10 },
      documentInfo,
    ).root as Record<string, unknown>;
    expect(group).not.toHaveProperty('key');
  });

  it('达到 maxDepth 时标记 childrenTruncated 并停止递归', () => {
    const grandchild = makeNode({ id: '3:3', name: 'grandchild' });
    const child = makeNode({ id: '2:2', name: 'child', children: [grandchild] });
    const root = makeNode({ id: '1:1', name: 'root', children: [child] });

    const context = createDesignContext(root, { maxDepth: 1, maxNodes: 100 }, documentInfo);
    const serializedRoot = context.root as Record<string, unknown>;
    const serializedChild = (serializedRoot.children as Record<string, unknown>[])[0];
    expect(serializedChild.childrenTruncated).toBe('maxDepth');
    expect(serializedChild.omittedChildren).toBe(1);
    expect(serializedChild).not.toHaveProperty('children');
    expect(context.nodesVisited).toBe(2);
    expect(context.truncated).toBe(true);
  });

  it('maxDepth 为 0 时根节点即截断', () => {
    const root = makeNode({ children: [makeNode({ id: '2:2' }), makeNode({ id: '2:3' })] });
    const context = createDesignContext(root, { maxDepth: 0, maxNodes: 100 }, documentInfo);
    const serialized = context.root as Record<string, unknown>;
    expect(serialized.childrenTruncated).toBe('maxDepth');
    expect(serialized.omittedChildren).toBe(2);
    expect(context.nodesVisited).toBe(1);
  });

  it('达到 maxNodes 时截断并列出遗漏数量', () => {
    const children = ['a', 'b', 'c', 'd', 'e'].map((n, index) => makeNode({ id: `2:${index}`, name: n }));
    const root = makeNode({ children });
    const context = createDesignContext(root, { maxDepth: 4, maxNodes: 3 }, documentInfo);
    const serialized = context.root as Record<string, unknown>;
    expect((serialized.children as unknown[]).length).toBe(2);
    expect(serialized.childrenTruncated).toBe('maxNodes');
    expect(serialized.omittedChildren).toBe(3);
    expect(context.nodesVisited).toBe(3);
    expect(context.truncated).toBe(true);
  });

  it('空 children 数组不产生截断标记', () => {
    const root = makeNode({ children: [] });
    const context = createDesignContext(root, { maxDepth: 2, maxNodes: 10 }, documentInfo);
    const serialized = context.root as Record<string, unknown>;
    expect(serialized).not.toHaveProperty('children');
    expect(serialized).not.toHaveProperty('childrenTruncated');
    expect(context.truncated).toBe(false);
  });
});
