import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentGenerationApplicationService } from '../../src/application/document-generation-service';
import {
  addUserMessage, appendAssistantMessageChunk, beginAssistantMessage, completeAssistantMessage, createConversation,
  startAssistantMessageStreaming, toConversationId, toIsoTimestamp, toMessageId, toProjectId
} from '../../src/domain';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { emitProductionEvent, getProductionTraceStore, withProductionTrace } from '../../src/platform/conversation-production-trace';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('document production trace integration', () => {
  it('persists one factual service-to-runner PPT journey in the bound conversation scope', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-document-trace-'));
    roots.push(rootDirectory);
    const projectId = toProjectId('project-document-trace');
    const conversationId = toConversationId('conversation-document-trace');
    const userId = toMessageId('message-document-trace-user');
    const assistantId = toMessageId('message-document-trace-assistant');
    const createdAt = toIsoTimestamp('2026-09-22T00:00:00.000Z');
    const content = JSON.stringify({ kind: 'ppt', title: '离线生产记录验证', sections: [
      { heading: '已验证的事实', level: 1, blocks: [{ type: 'bullets', items: ['由真实本地文件和登记结果生成进度。'] }] }
    ] });
    let conversation = createConversation({ id: conversationId, projectId, title: '文档任务', createdAt });
    conversation = addUserMessage(conversation, { id: userId, content: '制作一份说明执行记录的 PPT', createdAt });
    conversation = beginAssistantMessage(conversation, { id: assistantId, createdAt });
    conversation = startAssistantMessageStreaming(conversation, assistantId, createdAt);
    conversation = appendAssistantMessageChunk(conversation, assistantId, content, createdAt);
    conversation = completeAssistantMessage(conversation, assistantId, createdAt);
    const runner = new DocumentGenerationRunner({ rootDirectory, projectId });
    const service = new DocumentGenerationApplicationService({ projectId,
      conversations: { load: async () => conversation, attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus: async () => undefined },
      compiler: { compile: input => parseDocumentOutline(input.content), recover: input => parseDocumentOutline(input.content) },
      generator: { run: async input => {
        const result = await runner.run(input);
        return { taskId: result.task.id, executionId: result.execution.id, workId: result.work.id,
          fileName: result.work.name, sizeBytes: result.file.sizeBytes! };
      } },
      fingerprint: () => 'd'.repeat(64),
      onProgress: async event => { await emitProductionEvent(event); }
    });
    const scope = { rootDirectory, projectId, conversationId, sourceMessageId: userId,
      assistantMessageId: assistantId, traceId: 'trace-document-production' };
    const result = await withProductionTrace(scope, () => service.generateFromMessage({ conversationId,
      expectedRevision: conversation.revision, messageId: assistantId, kind: 'ppt', images: [] }));
    expect(result.sizeBytes).toBeGreaterThan(0);
    const events = await getProductionTraceStore(scope).list({ conversationId });
    expect(events.map(event => `${event.operationId}:${event.status}`)).toEqual([
      'document-outline:started', 'document-outline:completed',
      'document-file-write:started', 'document-layout:started', 'document-layout:completed', 'document-file-write:completed',
      'document-output-structure:started', 'document-output-structure:completed',
      'document-temporary-hash:started', 'document-temporary-hash:completed',
      'document-atomic-publish:started', 'document-atomic-publish:completed',
      'document-published-hash:started', 'document-published-hash:completed',
      'document-work-register:started', 'document-work-register:completed'
    ]);
    expect(events.find(event => event.operationId === 'document-layout' && event.status === 'completed')?.facts?.totalPages).toBe(3);
    expect(events.every(event => event.sourceMessageId === userId && event.assistantMessageId === assistantId)).toBe(true);
    expect(events.some(event => event.code === 'document_render')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(rootDirectory);
    expect(JSON.stringify(events)).not.toContain('离线生产记录验证');
  });
});
