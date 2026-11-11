import { describe, expect, it } from 'vitest';
import { createNodePrompt } from '../src/plugin/prompt';
import { base64Encode, computeExportScale } from '../src/plugin/export';

describe('createNodePrompt', () => {
  it('包含节点名与 nodeId，并保持模板结构', () => {
    const prompt = createNodePrompt({ id: '1830:2591', name: '首页' });
    expect(prompt).toContain('「首页」');
    expect(prompt).toContain('nodeId: 1830:2591');
    expect(prompt).toContain('get_design_context');
    expect(prompt).toContain('get_screenshot');
    expect(prompt).toContain('只读');
  });

  it('把连续空白折叠为单个空格', () => {
    const prompt = createNodePrompt({ id: '1:1', name: '  添加\n\t文件夹  后  ' });
    expect(prompt).toContain('「添加 文件夹 后」');
  });

  it('空名称回退为未命名节点', () => {
    const prompt = createNodePrompt({ id: '1:1', name: '   ' });
    expect(prompt).toContain('「未命名节点」');
  });
});

describe('base64Encode', () => {
  it('与 Buffer base64 编码结果一致（含非 3 倍数长度）', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 7, 16, 255]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 37 + length) % 256;
      }
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('空输入返回空字符串', () => {
    expect(base64Encode(new Uint8Array(0))).toBe('');
  });
});

describe('computeExportScale', () => {
  it('无 maxDimension 时仅做上下限钳制', () => {
    expect(computeExportScale(null, 1)).toBe(1);
    expect(computeExportScale({ width: 100, height: 50 }, 5)).toBe(4);
    expect(computeExportScale({ width: 100, height: 50 }, 0.001)).toBe(0.01);
  });

  it('按最大边换算并取较小倍率', () => {
    expect(computeExportScale({ width: 800, height: 600 }, 2, 1200)).toBe(1.5);
    expect(computeExportScale({ width: 800, height: 600 }, 1, 1200)).toBe(1);
    expect(computeExportScale({ width: 100, height: 50 }, 1, 1200)).toBe(1);
  });

  it('以高度为最大边时按高度换算', () => {
    expect(computeExportScale({ width: 300, height: 900 }, 1, 450)).toBe(0.5);
  });

  it('零尺寸或缺失包围盒时忽略 maxDimension', () => {
    expect(computeExportScale({ width: 0, height: 0 }, 2, 100)).toBe(2);
    expect(computeExportScale(null, 2, 100)).toBe(2);
  });

  it('换算结果仍受 4 倍上限约束', () => {
    expect(computeExportScale({ width: 100, height: 50 }, 5, 1000)).toBe(4);
  });
});
