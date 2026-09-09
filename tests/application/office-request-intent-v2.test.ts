import { describe, expect, it } from 'vitest';
import { analyzeOfficeRequestV2, type OfficeRequestContextV2 } from '../../src/application/office-request-intent-v2';
import { toDocumentDraftId } from '../../src/domain';

describe('analyzeOfficeRequestV2', () => {
  const emptyContext: OfficeRequestContextV2 = {};

  const contextWithDraft: OfficeRequestContextV2 = {
    drafts: [
      {
        draftId: toDocumentDraftId('draft-1'),
        summary: '员工名单 · 8 行 · 6 列',
        format: 'excel'
      }
    ]
  };

  const contextWithDocument: OfficeRequestContextV2 = {
    documents: [
      {
        messageId: 'msg-1',
        kind: 'excel',
        fileName: '员工表.xlsx'
      }
    ]
  };

  const contextWithBoth: OfficeRequestContextV2 = {
    documents: [
      {
        messageId: 'msg-1',
        kind: 'excel',
        fileName: '员工表.xlsx'
      }
    ],
    drafts: [
      {
        draftId: toDocumentDraftId('draft-1'),
        summary: '员工名单 · 8 行 · 6 列',
        format: 'excel'
      }
    ]
  };

  describe('P0-3 regression suite', () => {
    it('case 1: "Excel 表格前面那些不对，作出修改" → document/revise/excel/high', () => {
      const result = analyzeOfficeRequestV2(
        'Excel 表格前面那些不对，作出修改',
        contextWithDocument
      );
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('revise');
        expect(result.format).toBe('excel');
        expect(result.confidence).toBe('high');
        expect(result.sourceMessageId).toBe('msg-1');
      }
    });

    it('case 2: "根据上面说的话生成 Excel" → document/create/excel + sourceDraftId 非空', () => {
      const result = analyzeOfficeRequestV2(
        '根据上面说的话生成 Excel',
        contextWithDraft
      );
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('create');
        expect(result.format).toBe('excel');
        expect(result.sourceDraftId).toBeDefined();
        expect(result.sourceDraftId).toBe(contextWithDraft.drafts![0].draftId);
      }
    });

    it('case 3: "表格怎么设计比较美观" → chat', () => {
      const result = analyzeOfficeRequestV2('表格怎么设计比较美观', emptyContext);
      expect(result.kind).toBe('chat');
      expect(result.confidence).toBe('high');
    });

    it('case 4: "Excel 是什么" → chat', () => {
      const result = analyzeOfficeRequestV2('Excel 是什么', emptyContext);
      expect(result.kind).toBe('chat');
    });

    it('case 5: "再加一列奖金" → document/revise + sourceDraftId 非空（有 draft 时）', () => {
      const result = analyzeOfficeRequestV2('再加一列奖金', contextWithBoth);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('revise');
        expect(result.sourceMessageId).toBe('msg-1');
        expect(result.sourceDraftId).toBe(contextWithDraft.drafts![0].draftId);
      }
    });

    it('case 6: "做份周报 PPT" → document/create/ppt/high', () => {
      const result = analyzeOfficeRequestV2('做份周报 PPT', emptyContext);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('create');
        expect(result.format).toBe('ppt');
        expect(result.confidence).toBe('high');
      }
    });

    it('case 7: "把上一版的字体调小" → document/revise/medium（无上一版时需确认）', () => {
      const result = analyzeOfficeRequestV2('把上一版的字体调小', emptyContext);
      expect(result.kind).toBe('chat');
    });

    it('case 8: "帮我看看上面数据有没有问题" → chat', () => {
      const result = analyzeOfficeRequestV2(
        '帮我看看上面数据有没有问题',
        contextWithDraft
      );
      expect(result.kind).toBe('chat');
    });
  });

  describe('anaphora with drafts', () => {
    it('recognises "上面" + "生成" as create with draft reference', () => {
      const result = analyzeOfficeRequestV2(
        '根据上面生成 Excel',
        contextWithDraft
      );
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.sourceDraftId).toBe(contextWithDraft.drafts![0].draftId);
      }
    });

    it('recognises "刚才" + "做成表格" as create with draft reference', () => {
      const result = analyzeOfficeRequestV2(
        '把刚才的做成表格',
        contextWithDraft
      );
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.format).toBe('excel');
        expect(result.sourceDraftId).toBe(contextWithDraft.drafts![0].draftId);
      }
    });

    it('without anaphora and no drafts, pure question → chat', () => {
      const result = analyzeOfficeRequestV2('表格应该怎么设计', emptyContext);
      expect(result.kind).toBe('chat');
    });
  });

  describe('high confidence new document', () => {
    it('explicit new + create → high confidence', () => {
      const result = analyzeOfficeRequestV2('新建一份员工表 Excel', emptyContext);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('create');
        expect(result.confidence).toBe('high');
        expect(result.needsConfirmation).toBe(false);
      }
    });

    it('question without create verb → chat', () => {
      const result = analyzeOfficeRequestV2('Excel 怎么用', emptyContext);
      expect(result.kind).toBe('chat');
    });
  });

  describe('revision with existing document', () => {
    it('revision verb + document context → high confidence revise', () => {
      const result = analyzeOfficeRequestV2(
        '修改上一版表格',
        contextWithDocument
      );
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('revise');
        expect(result.confidence).toBe('high');
        expect(result.sourceMessageId).toBe('msg-1');
      }
    });

    it('contextual add pattern → revise', () => {
      const result = analyzeOfficeRequestV2('再加一行', contextWithDocument);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.action).toBe('revise');
      }
    });
  });

  describe('format inference', () => {
    it('infers ppt from "汇报"', () => {
      const result = analyzeOfficeRequestV2('做个季度汇报', emptyContext);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.format).toBe('ppt');
      }
    });

    it('infers excel from "清单"', () => {
      const result = analyzeOfficeRequestV2('生成采购清单', emptyContext);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.format).toBe('excel');
      }
    });

    it('infers word by default', () => {
      const result = analyzeOfficeRequestV2('写个方案', emptyContext);
      expect(result.kind).toBe('document');
      if (result.kind === 'document') {
        expect(result.format).toBe('word');
      }
    });
  });

  describe('edge cases', () => {
    it('empty input → chat', () => {
      const result = analyzeOfficeRequestV2('', emptyContext);
      expect(result.kind).toBe('chat');
    });

    it('no create verb and no generic deliverable → chat', () => {
      const result = analyzeOfficeRequestV2('这是一段普通聊天', emptyContext);
      expect(result.kind).toBe('chat');
    });
  });
});
