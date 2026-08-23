import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_GENERATION_INSTRUCTION,
  buildOutlineFromRequirements,
  composeDocumentRevisionInput,
  detectDocumentIntent,
  extractSectionHeadings,
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

  it('composes revision context from the previous document', () => {
    const input = composeDocumentRevisionInput(
      '# 项目周报\n\n- 完成评审',
      '把第二部分改为强调风险'
    );
    expect(input).toContain(DOCUMENT_GENERATION_INSTRUCTION);
    expect(input).toContain('上一版文档内容');
    expect(input).toContain('# 项目周报');
    expect(input).toContain('修改要求');
    expect(input).toContain('强调风险');
    expect(composeDocumentRevisionInput(undefined, '新需求')).toContain(
      DOCUMENT_GENERATION_INSTRUCTION
    );
  });

  it('extracts section headings from assistant markdown', () => {
    expect(
      extractSectionHeadings('# 封面\n\n## 本周进展\n\n正文\n\n## 下周计划')
    ).toEqual(['封面', '本周进展', '下周计划']);
    expect(extractSectionHeadings('没有标题的正文')).toEqual(['没有标题的正文']);
  });

  it('detects document intent and missing details', () => {
    expect(detectDocumentIntent('帮我做一份季度汇报 PPT')).toMatchObject({
      kind: 'document',
      documentKind: 'ppt'
    });
    expect(
      detectDocumentIntent('帮我做一份季度汇报 PPT，给领导看，包含业绩和问题')
    ).toMatchObject({ kind: 'document', documentKind: 'ppt', missing: [] });
    expect(detectDocumentIntent('今天天气怎么样')).toEqual({
      kind: 'chat',
      missing: []
    });
  });
});
