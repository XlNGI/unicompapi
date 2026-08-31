import { describe, expect, it } from 'vitest';
import {
  classifyWithLlm,
  convertClassificationToIntent
} from '../../src/application/office-intent-classifier';
import { toDocumentDraftId } from '../../src/domain';
import type { OfficeRequestContextV2 } from '../../src/application/office-request-intent-v2';

describe('classifyWithLlm', () => {
  it('parses valid JSON response', async () => {
    const mockInvoker = async () =>
      JSON.stringify({
        kind: 'document',
        action: 'create',
        format: 'excel',
        useDraft: true,
        useDocument: false,
        confidence: 'high',
        rationale: '生成动词+明确类型'
      });

    const result = await classifyWithLlm(
      {
        text: '根据上面生成 Excel',
        recentMessages: [],
        drafts: [{ summary: '员工表 · 8行', format: 'excel' }],
        documents: []
      },
      mockInvoker
    );

    expect(result).toBeDefined();
    expect(result?.kind).toBe('document');
    expect(result?.action).toBe('create');
    expect(result?.format).toBe('excel');
    expect(result?.useDraft).toBe(true);
  });

  it('returns undefined on timeout', async () => {
    const slowInvoker = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return '{}';
    };

    const result = await classifyWithLlm(
      {
        text: 'test',
        recentMessages: [],
        drafts: [],
        documents: []
      },
      slowInvoker,
      500
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined on malformed JSON', async () => {
    const mockInvoker = async () => 'not json';

    const result = await classifyWithLlm(
      {
        text: 'test',
        recentMessages: [],
        drafts: [],
        documents: []
      },
      mockInvoker
    );

    expect(result).toBeUndefined();
  });

  it('extracts JSON from markdown code block', async () => {
    const mockInvoker = async () =>
      '```json\n' +
      JSON.stringify({
        kind: 'chat',
        confidence: 'high',
        rationale: '问答句'
      }) +
      '\n```';

    const result = await classifyWithLlm(
      {
        text: 'Excel 是什么',
        recentMessages: [],
        drafts: [],
        documents: []
      },
      mockInvoker
    );

    expect(result).toBeDefined();
    expect(result?.kind).toBe('chat');
  });
});

describe('convertClassificationToIntent', () => {
  it('converts chat classification', () => {
    const intent = convertClassificationToIntent(
      {
        kind: 'chat',
        confidence: 'high',
        rationale: '问答句'
      },
      {}
    );

    expect(intent.kind).toBe('chat');
    expect(intent.confidence).toBe('high');
  });

  it('converts document classification with draft reference', () => {
    const context: OfficeRequestContextV2 = {
      drafts: [
        {
          draftId: toDocumentDraftId('draft-1'),
          summary: '员工表',
          format: 'excel'
        }
      ]
    };

    const intent = convertClassificationToIntent(
      {
        kind: 'document',
        action: 'create',
        format: 'excel',
        useDraft: true,
        useDocument: false,
        confidence: 'medium',
        rationale: 'LLM分类'
      },
      context
    );

    expect(intent.kind).toBe('document');
    if (intent.kind === 'document') {
      expect(intent.action).toBe('create');
      expect(intent.format).toBe('excel');
      expect(intent.sourceDraftId).toBe('draft-1');
      expect(intent.needsConfirmation).toBe(true);
    }
  });

  it('converts document classification with document reference', () => {
    const context: OfficeRequestContextV2 = {
      documents: [
        {
          messageId: 'msg-1',
          kind: 'excel',
          fileName: '员工表.xlsx'
        }
      ]
    };

    const intent = convertClassificationToIntent(
      {
        kind: 'document',
        action: 'revise',
        format: 'excel',
        useDraft: false,
        useDocument: true,
        confidence: 'high',
        rationale: 'LLM分类'
      },
      context
    );

    expect(intent.kind).toBe('document');
    if (intent.kind === 'document') {
      expect(intent.action).toBe('revise');
      expect(intent.sourceMessageId).toBe('msg-1');
      expect(intent.needsConfirmation).toBe(false);
    }
  });

  it('infers default format from context', () => {
    const context: OfficeRequestContextV2 = {
      latestDocumentKind: 'ppt'
    };

    const intent = convertClassificationToIntent(
      {
        kind: 'document',
        action: 'create',
        useDraft: false,
        useDocument: false,
        confidence: 'medium',
        rationale: 'LLM分类'
      },
      context
    );

    expect(intent.kind).toBe('document');
    if (intent.kind === 'document') {
      expect(intent.format).toBe('ppt');
    }
  });
});
