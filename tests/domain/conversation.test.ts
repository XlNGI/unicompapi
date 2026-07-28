import { describe, expect, it } from 'vitest';
import {
  InvalidStateTransitionError,
  InvariantViolationError,
  addUserMessage,
  appendAssistantMessageChunk,
  archiveConversation,
  beginAssistantMessage,
  cancelAssistantMessage,
  completeAssistantMessage,
  createConversation,
  deleteConversation,
  failAssistantMessage,
  parseConversation,
  renameConversation,
  restoreConversation,
  startAssistantMessageStreaming,
  toAssetId,
  toConversationId,
  toFileReferenceId,
  toIsoTimestamp,
  toMessageId,
  toProjectId
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-07-28T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-28T00:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-28T00:02:00.000Z');
const t3 = toIsoTimestamp('2026-07-28T00:03:00.000Z');
const t4 = toIsoTimestamp('2026-07-28T00:04:00.000Z');
const projectId = toProjectId('project-chat-domain');

function conversation() {
  return createConversation({
    id: toConversationId('conversation-domain'),
    title: '  项目讨论  ',
    projectId,
    createdAt: t0
  });
}

describe('conversation lifecycle', () => {
  it('creates, renames, archives, restores and soft-deletes without losing messages', () => {
    const created = addUserMessage(conversation(), {
      id: toMessageId('message-user'),
      content: '保留这条事实',
      createdAt: t1
    });
    expect(created).toMatchObject({
      revision: 1,
      title: '项目讨论',
      status: 'active'
    });

    const renamed = renameConversation(created, '已重命名', t2);
    const archived = archiveConversation(renamed, t3);
    expect(archived).toMatchObject({
      revision: 3,
      status: 'archived',
      archivedAt: t3
    });

    const renamedWhileArchived = renameConversation(archived, '归档记录', t4);
    const restored = restoreConversation(
      renamedWhileArchived,
      toIsoTimestamp('2026-07-28T00:05:00.000Z')
    );
    const deleted = deleteConversation(
      restored,
      toIsoTimestamp('2026-07-28T00:06:00.000Z')
    );
    expect(deleted).toMatchObject({
      status: 'deleted',
      title: '归档记录',
      messages: [{ content: '保留这条事实' }]
    });
    expect(() => renameConversation(deleted, '禁止', deleted.deletedAt)).toThrow(
      InvariantViolationError
    );
    expect(() => deleteConversation(deleted, deleted.deletedAt)).toThrow(
      InvalidStateTransitionError
    );
  });

  it('does not allow archived or deleted conversations to accept messages', () => {
    const archived = archiveConversation(conversation(), t1);
    expect(() => addUserMessage(archived, {
      id: toMessageId('message-archived'),
      content: '不应写入',
      createdAt: t2
    })).toThrow('cannot append messages while conversation is archived');

    const deleted = deleteConversation(archived, t2);
    expect(() => beginAssistantMessage(deleted, {
      id: toMessageId('message-deleted'),
      createdAt: t3
    })).toThrow('cannot append messages while conversation is deleted');
  });
});

describe('message lifecycle', () => {
  it('moves assistant content through pending, streaming and completed revisions', () => {
    const pending = beginAssistantMessage(conversation(), {
      id: toMessageId('assistant-complete'),
      createdAt: t1
    });
    expect(pending.messages[0]).toMatchObject({
      role: 'assistant',
      state: 'pending',
      revision: 0,
      content: ''
    });

    const streaming = startAssistantMessageStreaming(
      pending,
      toMessageId('assistant-complete'),
      t2
    );
    const chunked = appendAssistantMessageChunk(
      streaming,
      toMessageId('assistant-complete'),
      '第一段 ',
      t3
    );
    const chunkedAgain = appendAssistantMessageChunk(
      chunked,
      toMessageId('assistant-complete'),
      '第二段',
      t4
    );
    const completed = completeAssistantMessage(
      chunkedAgain,
      toMessageId('assistant-complete'),
      toIsoTimestamp('2026-07-28T00:05:00.000Z')
    );

    expect(completed.messages[0]).toMatchObject({
      state: 'completed',
      revision: 4,
      streamSequence: 2,
      content: '第一段 第二段'
    });
    expect(() => appendAssistantMessageChunk(
      completed,
      toMessageId('assistant-complete'),
      '禁止追加',
      toIsoTimestamp('2026-07-28T00:06:00.000Z')
    )).toThrow(InvalidStateTransitionError);
  });

  it('allows pending or streaming assistant messages to fail or cancel', () => {
    const pendingFailure = beginAssistantMessage(conversation(), {
      id: toMessageId('assistant-failed'),
      createdAt: t1
    });
    const failed = failAssistantMessage(
      pendingFailure,
      toMessageId('assistant-failed'),
      'unavailable',
      t2
    );
    expect(failed.messages[0]).toMatchObject({
      state: 'failed',
      failureReason: 'unavailable',
      streamSequence: 0
    });

    const pendingCancel = beginAssistantMessage(conversation(), {
      id: toMessageId('assistant-cancelled'),
      createdAt: t1
    });
    const streaming = startAssistantMessageStreaming(
      pendingCancel,
      toMessageId('assistant-cancelled'),
      t2
    );
    const chunked = appendAssistantMessageChunk(
      streaming,
      toMessageId('assistant-cancelled'),
      '保留的部分结果',
      t3
    );
    const cancelled = cancelAssistantMessage(
      chunked,
      toMessageId('assistant-cancelled'),
      t4
    );
    expect(cancelled.messages[0]).toMatchObject({
      state: 'cancelled',
      content: '保留的部分结果',
      streamSequence: 1
    });
  });

  it('keeps completed user messages immutable and rejects direct state shortcuts', () => {
    const userMessage = addUserMessage(conversation(), {
      id: toMessageId('immutable-user'),
      content: '用户事实',
      createdAt: t1
    });
    expect(() => startAssistantMessageStreaming(
      userMessage,
      toMessageId('immutable-user'),
      t2
    )).toThrow('user messages are immutable facts');

    const pending = beginAssistantMessage(conversation(), {
      id: toMessageId('assistant-shortcut'),
      createdAt: t1
    });
    expect(() => completeAssistantMessage(
      pending,
      toMessageId('assistant-shortcut'),
      t2
    )).toThrow(InvalidStateTransitionError);
  });
});

describe('conversation runtime validation', () => {
  it('persists only project-scoped asset or file-reference identifiers', () => {
    const withAttachment = addUserMessage(conversation(), {
      id: toMessageId('message-attachment'),
      content: '分析已登记素材',
      attachments: [{
        kind: 'asset',
        projectId,
        assetId: toAssetId('asset-safe-reference')
      }, {
        kind: 'file_reference',
        projectId,
        fileReferenceId: toFileReferenceId('file-safe-reference')
      }],
      createdAt: t1
    });
    expect(withAttachment.messages[0].attachments).toEqual([
      {
        kind: 'asset',
        projectId,
        assetId: 'asset-safe-reference'
      },
      {
        kind: 'file_reference',
        projectId,
        fileReferenceId: 'file-safe-reference'
      }
    ]);

    expect(() => addUserMessage(conversation(), {
      id: toMessageId('message-cross-project'),
      content: '禁止跨项目附件',
      attachments: [{
        kind: 'asset',
        projectId: toProjectId('another-project'),
        assetId: toAssetId('asset-cross-project')
      }],
      createdAt: t1
    })).toThrow('message attachment belongs to another project');

    const unbound = createConversation({
      id: toConversationId('conversation-unbound'),
      title: '未绑定项目',
      createdAt: t0
    });
    expect(() => addUserMessage(unbound, {
      id: toMessageId('message-unbound-attachment'),
      content: '禁止持久化附件',
      attachments: [{
        kind: 'asset',
        projectId,
        assetId: toAssetId('asset-not-allowed')
      }],
      createdAt: t1
    })).toThrow('unbound conversations cannot persist attachments');
  });

  it('rejects unknown fields, raw paths, hashes and malformed discriminated states', () => {
    const valid = addUserMessage(conversation(), {
      id: toMessageId('message-strict'),
      content: '严格校验',
      createdAt: t1
    });
    expect(() => parseConversation({ ...valid, endpoint: 'https://example.invalid' }))
      .toThrow('unexpected or missing fields');

    const message = valid.messages[0];
    expect(() => parseConversation({
      ...valid,
      messages: [{
        ...message,
        attachments: [{
          kind: 'asset',
          projectId,
          assetId: 'asset-safe',
          absolutePath: 'C:\\secret\\asset.png',
          sha256: 'a'.repeat(64)
        }]
      }]
    })).toThrow('unexpected or missing fields');

    expect(() => parseConversation({
      ...valid,
      messages: [{
        ...message,
        role: 'assistant',
        attachments: [{
          kind: 'asset',
          projectId,
          assetId: 'asset-input-only'
        }]
      }]
    })).toThrow('assistant messages cannot persist input attachments');

    expect(() => parseConversation({
      ...valid,
      messages: [{
        ...message,
        state: 'pending',
        role: 'assistant'
      }]
    })).toThrow('unexpected or missing fields');
  });
});
