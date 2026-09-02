import { describe, expect, it } from 'vitest';
import { analyzeOfficeRequest } from '../../src/application';

describe('Office request intent', () => {
  const documents = [
    { messageId: 'word-v1', kind: 'word' as const, fileName: '项目方案.docx' },
    { messageId: 'ppt-v1', kind: 'ppt' as const, fileName: '季度汇报.pptx' },
    { messageId: 'excel-v1', kind: 'excel' as const, fileName: '经营数据.xlsx' },
    { messageId: 'ppt-v2', kind: 'ppt' as const, fileName: '季度汇报-新版.pptx' }
  ];

  it('recognizes explicit create requests for each Office format', () => {
    expect(analyzeOfficeRequest('帮我做一份季度经营汇报 PPT')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'ppt',
      missing: []
    });
    expect(analyzeOfficeRequest('生成本季度销售数据 Excel 表')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'excel',
      missing: []
    });
    expect(analyzeOfficeRequest('写一份客户拜访纪要 Word 文档')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'word',
      missing: []
    });
  });

  it('routes explicit and contextual edits to the matching previous document', () => {
    expect(
      analyzeOfficeRequest('把刚才的 PPT 第二页改成时间线，其他页不变', {
        latestDocumentKind: 'ppt',
        availableDocumentKinds: ['ppt']
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'ppt',
      targetDocumentKind: 'ppt',
      missing: []
    });
    expect(
      analyzeOfficeRequest('第二页换成时间线，整体配色更简洁', {
        latestDocumentKind: 'ppt',
        availableDocumentKinds: ['ppt']
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'ppt',
      targetDocumentKind: 'ppt',
      missing: []
    });
    expect(
      analyzeOfficeRequest('上一版表格增加负责人列', {
        latestDocumentKind: 'excel',
        availableDocumentKinds: ['excel', 'word']
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'excel',
      targetDocumentKind: 'excel',
      missing: []
    });
    expect(
      analyzeOfficeRequest('将第二章的内容删掉', {
        latestDocumentKind: 'ppt',
        availableDocumentKinds: ['ppt']
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'ppt',
      targetDocumentKind: 'ppt',
      missing: []
    });
  });

  it('uses the current conversation documents to resolve natural follow-up edits', () => {
    expect(
      analyzeOfficeRequest('ppt内容太少，给我再加几页内容', { documents })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'ppt',
      targetMessageId: 'ppt-v2',
      missing: []
    });
    expect(analyzeOfficeRequest('把内容再丰富一点', { documents })).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'ppt',
      targetMessageId: 'ppt-v2',
      missing: []
    });
    expect(
      analyzeOfficeRequest('再补一段风险分析', {
        documents: documents.slice(0, 1)
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'word',
      targetMessageId: 'word-v1'
    });
    expect(
      analyzeOfficeRequest('加一列负责人', {
        documents: documents.slice(0, 3)
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'excel',
      targetMessageId: 'excel-v1'
    });
    expect(
      analyzeOfficeRequest('给表格加几列', {
        documents: documents.slice(0, 3)
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'excel',
      targetMessageId: 'excel-v1'
    });
    expect(
      analyzeOfficeRequest('当前工资表在加年龄跟性别', {
        documents: documents.slice(0, 3)
      })
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'excel',
      targetMessageId: 'excel-v1'
    });
  });

  it('prefers an explicit format or file name and otherwise chooses the latest version', () => {
    expect(analyzeOfficeRequest('给 PPT 加几页', { documents })).toMatchObject({
      targetMessageId: 'ppt-v2',
      documentKind: 'ppt'
    });
    expect(
      analyzeOfficeRequest('把季度汇报.pptx的结论页改简洁', { documents })
    ).toMatchObject({
      targetMessageId: 'ppt-v1',
      documentKind: 'ppt'
    });
    expect(
      analyzeOfficeRequest('不是这个，改前一个版本', { documents })
    ).toMatchObject({
      targetMessageId: 'excel-v1',
      documentKind: 'excel'
    });
  });

  it('keeps explicit new-document requests separate from revisions', () => {
    expect(
      analyzeOfficeRequest('重新做一份科技风 PPT', { documents })
    ).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'ppt'
    });
    expect(analyzeOfficeRequest('再丰富一点')).toEqual({
      kind: 'chat',
      missing: []
    });
  });

  it('starts Office creation immediately and infers a safe default format', () => {
    expect(analyzeOfficeRequest('帮我做一份季度复盘')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'word',
      missing: []
    });
    expect(analyzeOfficeRequest('生成 PPT')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'ppt',
      missing: []
    });
    expect(analyzeOfficeRequest('生成 Excel')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'excel',
      missing: []
    });
    expect(analyzeOfficeRequest('写 Word 文档')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'word',
      missing: []
    });
    expect(
      analyzeOfficeRequest('把刚才的 PPT 第二页改成时间线')
    ).toMatchObject({
      kind: 'document',
      action: 'revise',
      documentKind: 'ppt',
      missing: ['可修改的上一版 PPT']
    });
  });

  it('keeps explicit new-document requests from being mistaken for revisions', () => {
    const request = '帮我生成一个 PPT，删除重复内容并保留风险和行动建议';
    expect(analyzeOfficeRequest(request)).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'ppt',
      missing: []
    });
    // Existing documents in another conversation/context must not turn a
    // clearly new request into a revision either.
    expect(analyzeOfficeRequest(request, { documents })).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'ppt',
      missing: []
    });
  });

  it('routes natural table creation to Excel without clarification', () => {
    for (const request of [
      '给我生成一个表格',
      '帮我做一个员工表',
      '把这些内容整理成表格'
    ]) {
      expect(analyzeOfficeRequest(request)).toMatchObject({
        kind: 'document',
        action: 'create',
        documentKind: 'excel',
        missing: []
      });
    }
  });

  it('does not let the word 表格 override an explicitly requested Word or PPT format', () => {
    expect(analyzeOfficeRequest('生成一份包含表格的 Word 报告')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'word',
      missing: []
    });
    expect(analyzeOfficeRequest('做个 PPT，第二页放表格')).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'ppt',
      missing: []
    });
    expect(analyzeOfficeRequest('表格应该怎么设计？')).toEqual({
      kind: 'chat',
      missing: []
    });
  });

  it('keeps Office questions and analysis requests in ordinary chat', () => {
    expect(analyzeOfficeRequest('PPT 应该怎么做得更专业？')).toEqual({
      kind: 'chat',
      missing: []
    });
    expect(analyzeOfficeRequest('帮我分析这份 PPT 为什么很单调')).toEqual({
      kind: 'chat',
      missing: []
    });
    expect(analyzeOfficeRequest('Excel 和 Word 有什么区别？')).toEqual({
      kind: 'chat',
      missing: []
    });
    expect(
      analyzeOfficeRequest('工资表怎么加年龄列更合理？', { documents })
    ).toEqual({
      kind: 'chat',
      missing: []
    });
    expect(analyzeOfficeRequest('今天给大家加油', { documents })).toEqual({
      kind: 'chat',
      missing: []
    });
  });
});
