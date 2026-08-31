import { describe, expect, it } from 'vitest';
import {
  DocumentDraftRegistryService,
  extractDraftPayload,
  type DocumentDraftIdFactory
} from '../../src/application/document-draft-registry';
import {
  toConversationId,
  toDocumentDraftId,
  toMessageId,
  toProjectId,
  type DocumentDraft,
  type DocumentDraftId,
  type DocumentDraftRepository,
  type ProjectId
} from '../../src/domain';

function createStubRepository(): DocumentDraftRepository {
  const store = new Map<string, DocumentDraft>();
  return {
    async get(id) {
      return store.get(id);
    },
    async list(projectId) {
      return [...store.values()].filter(
        (draft) => draft.projectId === projectId
      );
    },
    async save(draft) {
      store.set(draft.id, draft);
    },
    async remove(id) {
      store.delete(id);
    }
  };
}

function createIdFactory(): DocumentDraftIdFactory {
  let counter = 0;
  return {
    nextDocumentDraftId() {
      counter += 1;
      return toDocumentDraftId(`draft-${counter}`);
    }
  };
}

const projectId: ProjectId = toProjectId('project-1');
const conversationId = toConversationId('conv-1');
const messageId = toMessageId('msg-1');

function createService(now: () => string = () => '2026-08-31T00:00:00.000Z') {
  return new DocumentDraftRegistryService(
    createStubRepository(),
    createIdFactory(),
    now
  );
}

describe('extractDraftPayload', () => {
  it('recognises an array of homogeneous objects as an excel table', () => {
    const payload = extractDraftPayload(
      JSON.stringify([
        { name: '张三', role: '经理', age: 32 },
        { name: '李四', role: '主管', age: 28 }
      ])
    );
    expect(payload?.format).toBe('excel');
    expect(payload?.rowCount).toBe(2);
    expect(payload?.columnCount).toBe(3);
    expect(payload?.summary).toContain('数据表');
    expect(payload?.summary).toContain('2 行');
    expect(payload?.summary).toContain('3 列');
  });

  it('recognises an outline object with kind and sections', () => {
    const payload = extractDraftPayload(
      JSON.stringify({
        kind: 'excel',
        title: '员工名单',
        sections: [
          {
            heading: '市场部',
            blocks: [
              {
                type: 'table',
                header: ['姓名', '职位'],
                rows: [
                  ['张三', '经理'],
                  ['李四', '主管']
                ]
              }
            ]
          }
        ]
      })
    );
    expect(payload?.format).toBe('excel');
    expect(payload?.rowCount).toBe(2);
    expect(payload?.columnCount).toBe(2);
    expect(payload?.summary).toContain('员工名单');
  });

  it('recognises a bare table object with rows and columns', () => {
    const payload = extractDraftPayload(
      JSON.stringify({
        title: '销售数据',
        columns: ['月份', '金额'],
        rows: [
          ['1月', 100],
          ['2月', 200],
          ['3月', 300]
        ]
      })
    );
    expect(payload?.format).toBe('excel');
    expect(payload?.rowCount).toBe(3);
    expect(payload?.columnCount).toBe(2);
  });

  it('strips leading natural language before the JSON body', () => {
    const payload = extractDraftPayload(
      '好的，这是员工数据：\n' +
        JSON.stringify([{ name: '张三' }, { name: '李四' }])
    );
    expect(payload?.format).toBe('excel');
    expect(payload?.rowCount).toBe(2);
  });

  it('strips fenced code blocks', () => {
    const payload = extractDraftPayload(
      '```json\n' +
        JSON.stringify({
          kind: 'word',
          title: '周报',
          sections: []
        }) +
        '\n```'
    );
    expect(payload?.format).toBe('word');
  });

  it('returns undefined for plain natural language', () => {
    expect(extractDraftPayload('这是一段普通聊天')).toBeUndefined();
  });

  it('returns undefined for empty arrays', () => {
    expect(extractDraftPayload('[]')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(extractDraftPayload('{name: 不完整')).toBeUndefined();
  });
});

describe('DocumentDraftRegistryService', () => {
  it('registers an assistant JSON message as a draft', async () => {
    const service = createService();
    const draft = await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: JSON.stringify([
        { name: '张三', role: '经理' },
        { name: '李四', role: '主管' }
      ])
    });
    expect(draft).toBeDefined();
    expect(draft?.format).toBe('excel');
    expect(draft?.rowCount).toBe(2);
    expect(draft?.messageId).toBe(messageId);
    const listed = await service.list(projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(draft?.id);
  });

  it('returns the existing draft when registering the same message twice', async () => {
    const service = createService();
    const first = await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: JSON.stringify([{ a: 1 }, { a: 2 }])
    });
    const second = await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: JSON.stringify([{ a: 1 }, { a: 2 }])
    });
    expect(first).toBeDefined();
    expect(second?.id).toBe(first?.id);
    const listed = await service.list(projectId);
    expect(listed).toHaveLength(1);
  });

  it('ignores messages that are not structured', async () => {
    const service = createService();
    const draft = await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: '这是一段普通的聊天回复，没有结构化数据。'
    });
    expect(draft).toBeUndefined();
    const listed = await service.list(projectId);
    expect(listed).toHaveLength(0);
  });

  it('filters drafts by conversation', async () => {
    const service = createService();
    await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: JSON.stringify([{ a: 1 }])
    });
    const otherConversationId = toConversationId('conv-2');
    const otherMessageId = toMessageId('msg-2');
    await service.registerFromMessage({
      projectId,
      conversationId: otherConversationId,
      messageId: otherMessageId,
      messageContent: JSON.stringify([{ b: 1 }])
    });
    const byConv = await service.listByConversation(projectId, conversationId);
    expect(byConv).toHaveLength(1);
    expect(byConv[0]?.conversationId).toBe(conversationId);
  });

  it('exposes get by draft id', async () => {
    const service = createService();
    const draft = await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: JSON.stringify([{ a: 1 }])
    });
    const fetched = await service.get(draft!.id as DocumentDraftId);
    expect(fetched?.id).toBe(draft?.id);
  });

  it('records supersedes when provided', async () => {
    const service = createService();
    const previousDraftId = toDocumentDraftId('draft-prev');
    const draft = await service.registerFromMessage({
      projectId,
      conversationId,
      messageId,
      messageContent: JSON.stringify([{ a: 1 }]),
      supersedes: previousDraftId
    });
    expect(draft?.supersedes).toBe(previousDraftId);
  });
});
