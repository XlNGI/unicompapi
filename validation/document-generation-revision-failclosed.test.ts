import { describe, expect, it, vi } from 'vitest';
import {
  DocumentGenerationApplicationService
} from '../src/application';
import {
  addUserMessage,
  appendAssistantMessageChunk,
  beginAssistantMessage,
  completeAssistantMessage,
  createConversation,
  startAssistantMessageStreaming,
  toConversationId,
  toExecutionId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toTaskId,
  toWorkId
} from '../src/domain';

const projectId = toProjectId('document-revision-project');
const conversationId = toConversationId('document-revision-conversation');
const messageId = toMessageId('document-revision-message');
const now = toIsoTimestamp('2026-09-03T00:00:00.000Z');

function outlineJson(heading = '第二章') {
  return JSON.stringify({
    kind: 'ppt',
    title: '运营方案',
    sections: [
      { heading: '第一章', level: 1, blocks: [{ type: 'paragraph', text: '保留' }] },
      { heading, level: 1, blocks: [{ type: 'paragraph', text: '目标' }] },
      { heading: '第三章', level: 1, blocks: [{ type: 'paragraph', text: '保留' }] }
    ]
  });
}

function generatedResult(suffix: string) {
  return {
    taskId: toTaskId(`task-document-${suffix}`),
    executionId: toExecutionId(`execution-document-${suffix}`),
    workId: toWorkId(`work-${suffix}`),
    fileName: '运营方案-v2.pptx',
    sizeBytes: 4096
  };
}

function revisionConversation(request = '清空第二章') {
  const previousMessageId = toMessageId('document-parent-message');
  const requestId = toMessageId('document-revision-request');
  let conversation = createConversation({
    id: conversationId,
    title: 'PPT 修订',
    projectId,
    createdAt: now
  });
  conversation = addUserMessage(conversation, {
    id: requestId,
    content: request,
    displayContent: request,
    createdAt: now
  });
  const previousPending = beginAssistantMessage(conversation, {
    id: previousMessageId,
    createdAt: now
  });
  const previousStreaming = startAssistantMessageStreaming(
    previousPending,
    previousMessageId,
    now
  );
  const previousChunked = appendAssistantMessageChunk(
    previousStreaming,
    previousMessageId,
    outlineJson(),
    now
  );
  const withParent = completeAssistantMessage(
    previousChunked,
    previousMessageId,
    now,
    undefined,
    {
      workId: toWorkId('work-parent'),
      fileName: '运营方案.pptx',
      kind: 'ppt',
      sizeBytes: 2048
    }
  );
  const pending = beginAssistantMessage(withParent, {
    id: messageId,
    createdAt: now
  });
  const streaming = startAssistantMessageStreaming(pending, messageId, now);
  const chunked = appendAssistantMessageChunk(streaming, messageId, outlineJson(), now);
  return completeAssistantMessage(chunked, messageId, now);
}

function environment(request?: string) {
  const conversation = revisionConversation(request);
  const compile = vi.fn(({ content }: { content: string }) => JSON.parse(content));
  const recover = vi.fn(() => JSON.parse(outlineJson()));
  const run = vi.fn(async (_input: unknown) => generatedResult('recovery'));
  const attachDocumentResult = vi.fn(async () => undefined);
  const service = new DocumentGenerationApplicationService({ projectId,
    conversations: { load: async () => conversation, attachDocumentResult, updateDocumentGenerationStatus: async () => undefined },
    compiler: { compile, recover }, generator: { run }, fingerprint: () => 'content-sha256', wait: async () => undefined });
  return { conversation, service, compile, recover, run, attachDocumentResult };
}

describe('retired local revision entry boundary', () => {
  it.each(['清空第二章', '只改第3页', '重新排版当前PPT', '面向非技术管理者'])('rejects %s through the retired entry before compiling, rewriting or creating any file', async request => {
    const f = environment(request);
    await expect(f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision,
      messageId, kind: 'ppt', parentWorkId: toWorkId('work-parent'), images: [] }))
      .rejects.toMatchObject({ code: 'invalid_structure' });
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.attachDocumentResult).not.toHaveBeenCalled();
  });

  it('requires the controlled tool route for an explicit edit operation without a parent pin', async () => {
    const f = environment();
    await expect(f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision,
      messageId, kind: 'ppt', operation: 'edit', images: [] })).rejects.toMatchObject({ code: 'invalid_structure' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('recovers an explicit creation without interpreting historical user prose a second time', async () => {
    const f = environment('清空第二章，面向非技术管理者，改成20页');
    await f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision,
      messageId, kind: 'ppt', operation: 'create', images: [] });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ outline: JSON.parse(outlineJson()) }));
    expect(f.run.mock.calls[0][0]).not.toHaveProperty('revisionPatch');
    expect(f.run.mock.calls[0][0]).not.toHaveProperty('pageRequirement');
  });
});
