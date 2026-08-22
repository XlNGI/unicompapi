import { describe, expect, it } from 'vitest';
import {
  buildOutlineFromRequirements,
  inferDocumentKind,
  sha256Hex
} from '../../src/pages/chat/documentDrafting';

describe('document drafting helpers', () => {
  it('infers the document kind from requirements', () => {
    expect(inferDocumentKind('请生成季度销售数据表格')).toBe('excel');
    expect(inferDocumentKind('做一个工作汇报 PPT')).toBe('ppt');
    expect(inferDocumentKind('写一份项目周报')).toBe('word');
  });

  it('builds a deterministic outline from requirements', () => {
    const outline = buildOutlineFromRequirements(
      '项目周报\n完成方案评审\n修复三个缺陷',
      'word'
    );
    expect(outline.kind).toBe('word');
    expect(outline.title).toBe('项目周报');
    expect(outline.sections[0].blocks[0].items).toEqual([
      '完成方案评审',
      '修复三个缺陷'
    ]);
  });

  it('computes a stable SHA-256 fingerprint', async () => {
    const first = await sha256Hex('word:周报');
    const second = await sha256Hex('word:周报');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
