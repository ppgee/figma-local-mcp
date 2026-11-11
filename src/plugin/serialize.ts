export interface SerializeOptions {
  maxDepth: number;
  maxNodes: number;
}

interface SerializeState {
  count: number;
  truncated: boolean;
}

const commonKeys = [
  'id', 'name', 'type', 'visible', 'locked', 'opacity', 'blendMode', 'isMask',
  'absoluteBoundingBox', 'absoluteRenderBounds', 'relativeTransform', 'constraints',
  'layoutAlign', 'layoutGrow', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'boundVariables',
];

const styleKeys = [
  'fills', 'fillStyleId', 'strokes', 'strokeStyleId', 'strokeWeight', 'strokeAlign',
  'strokeCap', 'strokeJoin', 'dashPattern', 'effects', 'effectStyleId', 'cornerRadius',
  'rectangleCornerRadii', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius',
  'bottomRightRadius',
];

const layoutKeys = [
  'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems',
  'counterAxisAlignItems', 'layoutWrap', 'itemSpacing', 'counterAxisSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'clipsContent',
  'gridStyleId', 'layoutGrids', 'guides',
];

const textKeys = [
  'characters', 'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textCase',
  'textDecoration', 'textStyleId', 'paragraphSpacing', 'paragraphIndent',
];

const componentKeys = [
  'componentProperties', 'componentPropertyDefinitions', 'componentPropertyReferences',
  'exposedInstances', 'isExposedInstance', 'key', 'description', 'documentationLinks',
];

export function cloneValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'symbol') return value === figma.mixed ? { mixed: true } : value.description;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const cloned = cloneValue(item, seen);
      if (cloned !== undefined) result[key] = cloned;
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function summarizeNode(node: SceneNode): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    absoluteBoundingBox: cloneValue(node.absoluteBoundingBox),
  };
}

function readKeys(target: Record<string, unknown>, node: SceneNode, keys: string[]): void {
  const source = node as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (key in source && source[key] !== undefined) target[key] = cloneValue(source[key]);
  }
}

function serializeNode(
  node: SceneNode,
  options: SerializeOptions,
  state: SerializeState,
  depth: number,
): Record<string, unknown> {
  state.count += 1;
  const result: Record<string, unknown> = {};
  readKeys(result, node, commonKeys);
  readKeys(result, node, styleKeys);
  readKeys(result, node, layoutKeys);
  if (node.type === 'TEXT') readKeys(result, node, textKeys);
  if (node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    readKeys(result, node, componentKeys);
  }

  if ('children' in node) {
    const children = node.children;
    if (children.length > 0 && depth >= options.maxDepth) {
      result.childrenTruncated = 'maxDepth';
      result.omittedChildren = children.length;
      state.truncated = true;
    } else if (children.length > 0) {
      const serialized: Record<string, unknown>[] = [];
      for (const child of children) {
        if (state.count >= options.maxNodes) {
          result.childrenTruncated = 'maxNodes';
          result.omittedChildren = children.length - serialized.length;
          state.truncated = true;
          break;
        }
        serialized.push(serializeNode(child, options, state, depth + 1));
      }
      result.children = serialized;
    }
  }
  return result;
}

export function createDesignContext(
  root: SceneNode,
  options: SerializeOptions,
): Record<string, unknown> {
  const state: SerializeState = { count: 0, truncated: false };
  return {
    document: {
      fileName: figma.root.name,
      pageId: figma.currentPage.id,
      pageName: figma.currentPage.name,
    },
    root: serializeNode(root, options, state, 0),
    nodesVisited: state.count,
    truncated: state.truncated,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
  };
}
