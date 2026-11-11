import { describe, expect, it } from 'vitest';
import { createNodePrompt } from '../src/plugin/prompt';
import { base64Encode, computeExportScale } from '../src/plugin/export';

describe('createNodePrompt', () => {
  it('includes the node name, nodeId and template structure', () => {
    const prompt = createNodePrompt({ id: '1830:2591', name: '首页' });
    expect(prompt).toContain('"首页"');
    expect(prompt).toContain('nodeId: 1830:2591');
    expect(prompt).toContain('get_design_context');
    expect(prompt).toContain('get_screenshot');
    expect(prompt).toContain('Read-only');
  });

  it('collapses consecutive whitespace into single spaces', () => {
    const prompt = createNodePrompt({ id: '1:1', name: '  添加\n\t文件夹  后  ' });
    expect(prompt).toContain('"添加 文件夹 后"');
  });

  it('falls back to Untitled node for empty names', () => {
    const prompt = createNodePrompt({ id: '1:1', name: '   ' });
    expect(prompt).toContain('"Untitled node"');
  });
});

describe('base64Encode', () => {
  it('matches Buffer base64 encoding (including non-multiple-of-3 lengths)', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 7, 16, 255]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 37 + length) % 256;
      }
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('returns an empty string for empty input', () => {
    expect(base64Encode(new Uint8Array(0))).toBe('');
  });
});

describe('computeExportScale', () => {
  it('only clamps bounds without maxDimension', () => {
    expect(computeExportScale(null, 1)).toBe(1);
    expect(computeExportScale({ width: 100, height: 50 }, 5)).toBe(4);
    expect(computeExportScale({ width: 100, height: 50 }, 0.001)).toBe(0.01);
  });

  it('derives from the largest side and keeps the smaller scale', () => {
    expect(computeExportScale({ width: 800, height: 600 }, 2, 1200)).toBe(1.5);
    expect(computeExportScale({ width: 800, height: 600 }, 1, 1200)).toBe(1);
    expect(computeExportScale({ width: 100, height: 50 }, 1, 1200)).toBe(1);
  });

  it('derives from height when it is the largest side', () => {
    expect(computeExportScale({ width: 300, height: 900 }, 1, 450)).toBe(0.5);
  });

  it('ignores maxDimension for zero-size or missing bounds', () => {
    expect(computeExportScale({ width: 0, height: 0 }, 2, 100)).toBe(2);
    expect(computeExportScale(null, 2, 100)).toBe(2);
  });

  it('still caps the result at 4x', () => {
    expect(computeExportScale({ width: 100, height: 50 }, 5, 1000)).toBe(4);
  });
});
