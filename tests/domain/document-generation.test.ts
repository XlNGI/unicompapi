import { describe, expect, it } from 'vitest';
import {
  createDocumentTask,
  parseDocumentMessageResult,
  parseMessage,
  toIsoTimestamp,
  toProjectId,
  toTaskId
} from '../../src/domain';

const timestamp = toIsoTimestamp('2026-08-22T00:00:00.000Z');

function completedAssistantMessage(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'message-doc-1',
    conversationId: 'conversation-1',
    revision: 0,
    role: 'assistant',
    state: 'completed',
    content: '文档正文',
    attachments: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    streamSequence: 0,
    ...extra
  };
}

const validDocumentResult = {
  workId: 'work-document-1',
  fileName: '季度复盘.docx',
  kind: 'word',
  sizeBytes: 1024
};

describe('document message result', () => {
  it('parses a valid document result', () => {
    const result = parseDocumentMessageResult(validDocumentResult);
    expect(result.workId).toBe('work-document-1');
    expect(result.kind).toBe('word');
    expect(result.sizeBytes).toBe(1024);
  });

  it('rejects invalid document results', () => {
    expect(() =>
      parseDocumentMessageResult({ ...validDocumentResult, fileName: ' ' })
    ).toThrow(TypeError);
    expect(() =>
      parseDocumentMessageResult({ ...validDocumentResult, kind: 'pdf' })
    ).toThrow(TypeError);
    expect(() =>
      parseDocumentMessageResult({ ...validDocumentResult, sizeBytes: -1 })
    ).toThrow(TypeError);
    expect(() => parseDocumentMessageResult(null)).toThrow(TypeError);
  });

  it('keeps legacy messages without documentResult compatible', () => {
    const message = parseMessage(completedAssistantMessage());
    expect(message.documentResult).toBeUndefined();
    expect(message.role).toBe('assistant');
  });

  it('persists documentResult on completed assistant messages', () => {
    const message = parseMessage(
      completedAssistantMessage({ documentResult: validDocumentResult })
    );
    expect(message.documentResult?.workId).toBe('work-document-1');
  });

  it('rejects documentResult on user messages', () => {
    expect(() =>
      parseMessage({
        schemaVersion: 1,
        id: 'message-user-1',
        conversationId: 'conversation-1',
        revision: 0,
        role: 'user',
        state: 'completed',
        content: '需求',
        attachments: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        streamSequence: 0,
        documentResult: validDocumentResult
      })
    ).toThrow(TypeError);
  });

  it('rejects documentResult on non-completed assistant messages', () => {
    expect(() =>
      parseMessage({
        ...completedAssistantMessage({
          state: 'streaming',
          startedAt: timestamp,
          streamSequence: 1,
          content: '生成中'
        }),
        documentResult: validDocumentResult
      })
    ).toThrow(TypeError);
  });
});

describe('document generation task', () => {
  it('creates a document_generation task with a frozen snapshot', () => {
    const task = createDocumentTask({
      id: toTaskId('task-document-1'),
      projectId: toProjectId('project-1'),
      sourceDraftId: 'draft-response-1',
      kind: 'excel',
      title: '销售数据',
      contentFingerprint: 'a'.repeat(64),
      draftRevision: 3,
      confirmedAt: timestamp
    });
    expect(task.submission.kind).toBe('document_generation');
    if (task.submission.kind !== 'document_generation') {
      throw new Error('unexpected submission kind');
    }
    expect(task.submission.document).toEqual({
      kind: 'excel',
      title: '销售数据',
      contentFingerprint: 'a'.repeat(64),
      draftRevision: 3
    });
    expect(task.executionIds).toEqual([]);
  });

  it('rejects invalid document task plans', () => {
    const base = {
      id: toTaskId('task-document-2'),
      projectId: toProjectId('project-1'),
      sourceDraftId: 'draft-response-1',
      kind: 'word' as const,
      title: '标题',
      contentFingerprint: 'a'.repeat(64),
      draftRevision: 0,
      confirmedAt: timestamp
    };
    expect(() =>
      createDocumentTask({ ...base, title: ' ' })
    ).toThrow(Error);
    expect(() =>
      createDocumentTask({ ...base, contentFingerprint: 'not-hex' })
    ).toThrow(Error);
    expect(() =>
      createDocumentTask({ ...base, draftRevision: -1 })
    ).toThrow(Error);
    expect(() =>
      createDocumentTask({ ...base, sourceDraftId: '' })
    ).toThrow(Error);
  });
});
