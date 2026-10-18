import { describe, expect, it, vi } from 'vitest';

import type { DocumentGenerationProgressCallback, DocumentGenerationProgressEvent } from '../../src/application/document-generation-service';
import { ConversationApplicationError, collectArtDirectionRequestText, DocumentDraftCompilationError, DocumentGenerationApplicationService } from '../../src/application';
import { appendAssistantMessageChunk, addUserMessage, beginAssistantMessage, completeAssistantMessage, createConversation, startAssistantMessageStreaming, setDocumentGenerationStatusOnMessage, toConversationId, toExecutionId, toIsoTimestamp, toMessageId, toProjectId, toTaskId, toWorkId } from '../../src/domain';

const projectId = toProjectId('document-application-project');
const conversationId = toConversationId('document-application-conversation');
const messageId = toMessageId('document-application-message');
const now = toIsoTimestamp('2026-08-27T00:00:00.000Z');

describe('semantic document revisions', () => {
  it('keeps the original visual brief across an outline and confirmation turn', () => {
    const initial = addUserMessage(createConversation({ id: conversationId, title: 'brief', projectId, createdAt: now }),
      { id: toMessageId('brief-user'), content: '左侧强结论，右侧两个指标，留白较多', createdAt: now });
    const outlineConversation = appendCompletedAssistantMessage(initial, messageId, 'validated outline');
    const withConfirmation = addUserMessage(outlineConversation, { id: toMessageId('confirm-user'), content: '确认生成', createdAt: now });
    const assistant = appendCompletedAssistantMessage(withConfirmation, toMessageId('design-assistant'), 'validated outline');
    expect(collectArtDirectionRequestText(assistant, toMessageId('design-assistant'))).toContain('左侧强结论');
    expect(collectArtDirectionRequestText(assistant, toMessageId('design-assistant'))).toContain('确认生成');
  });


});

function completedConversation(content: string) {
  const created = createConversation({
    id: conversationId,
    title: 'PPT 生成',
    projectId,
    createdAt: now
  });
  const pending = beginAssistantMessage(created, { id: messageId, createdAt: now });
  const streaming = startAssistantMessageStreaming(pending, messageId, now);
  const chunked = appendAssistantMessageChunk(streaming, messageId, content, now);
  return completeAssistantMessage(chunked, messageId, now);
}

function appendCompletedAssistantMessage(
  conversation: ReturnType<typeof createConversation>,
  id: ReturnType<typeof toMessageId>,
  content: string
) {
  const pending = beginAssistantMessage(conversation, { id, createdAt: now });
  const streaming = startAssistantMessageStreaming(pending, id, now);
  const chunked = appendAssistantMessageChunk(streaming, id, content, now);
  return completeAssistantMessage(chunked, id, now);
}

function recoveredOutline() {
  return {
    kind: 'ppt' as const,
    title: '人工智能智能体从对话到行动的革命',
    sections: [
      {
        heading: '智能体正在改变企业软件的使用方式',
        level: 1 as const,
        takeaway:
          '企业需要的已经不只是回答问题的模型，而是能够理解目标、调用工具并交付结果的数字执行者。',
        action: '选择一个高频、规则明确、结果可度量的业务场景启动试点。',
        blocks: [
          {
            type: 'bullets' as const,
            items: [
              '能力变化：从单轮问答升级为多步骤任务执行。',
              '业务变化：从提供建议升级为直接推动流程完成。',
              '组织变化：人负责目标和判断，智能体负责重复执行。'
            ]
          }
        ]
      }
    ]
  };
}

function environment(content = '{"kind":"ppt" "title":"缺少逗号"}', onProgress?: DocumentGenerationProgressCallback) {
  const conversation = completedConversation(content);
  const attachDocumentResult = vi.fn(async () => undefined);
  const compile = vi.fn(() => {
    throw new DocumentDraftCompilationError(
      'invalid_structure',
      'The model response is not valid JSON'
    );
  });
  const recover = vi.fn((input: { kind: 'word' | 'excel' | 'ppt' }) => ({
    ...recoveredOutline(),
    kind: input.kind
  }));
  const updateDocumentGenerationStatus = vi.fn(async () => undefined);
  const run = vi.fn(async () => ({
    taskId: toTaskId('task-document-application'),
    executionId: toExecutionId('execution-document-application'),
    workId: toWorkId('work-document-application'),
    fileName: '人工智能智能体从对话到行动的革命.pptx',
    sizeBytes: 4096
  }));
  const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
    projectId,
    conversations: {
      load: async () => conversation,
      attachDocumentResult,
      updateDocumentGenerationStatus
    },
    compiler: { compile, recover },
    generator: { run },
    onProgress,
    fingerprint: () => 'content-sha256',
    wait: async () => undefined
  });
  return {
    attachDocumentResult,
    updateDocumentGenerationStatus,
    compile,
    recover,
    run,
    service,
    conversation
  };
}

describe('document generation application service', () => {
  it('reports actual outline validation and passes progress to the executor', async () => {
    const events: DocumentGenerationProgressEvent[] = [];
    const onProgress = vi.fn(async (event: DocumentGenerationProgressEvent) => { events.push(event); });
    const f = environment(undefined, onProgress);
    await f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision, messageId,
      kind: 'ppt', images: [] });
    expect(events.map(event => `${event.code}:${event.status}`)).toEqual(['request_received:started', 'plan_validation:started', 'plan_validation:completed']);
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('records failed outline validation without claiming success or starting file generation', async () => {
    const events: DocumentGenerationProgressEvent[] = [];
    const f = environment(undefined, async event => { events.push(event); });
    f.recover.mockImplementation(() => { throw new DocumentDraftCompilationError('invalid_structure', 'invalid outline'); });
    await expect(f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision, messageId,
      kind: 'ppt', images: [] })).rejects.toThrow('invalid outline');
    expect(events.map(event => `${event.code}:${event.status}`)).toEqual(['request_received:started', 'plan_validation:started', 'plan_validation:failed']);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('starts one diagnostic cycle when duplicate commands share the same generation operation', async () => {
    const events: DocumentGenerationProgressEvent[] = [];
    const f = environment(undefined, async event => { events.push(event); });
    const input = { conversationId, expectedRevision: f.conversation.revision, messageId, kind: 'ppt' as const, images: [] };
    await Promise.all([f.service.generateFromMessage(input), f.service.generateFromMessage(input)]);
    expect(events.filter(event => event.code === 'request_received')).toHaveLength(1);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('does not fail successful generation when progress recording is unavailable', async () => {
    const f = environment(undefined, async () => { throw new Error('trace unavailable'); });
    await expect(f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision, messageId,
      kind: 'ppt', images: [] })).resolves.toMatchObject({ workId: 'work-document-application' });
    expect(f.attachDocumentResult).toHaveBeenCalledTimes(1);
  });

  it('recovers a non-empty PPT draft locally and completes the same generation run', async () => {
    const { attachDocumentResult, compile, recover, run, service, conversation } =
      environment();

    const result = await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt',
      presentationTemplate: 'technology',
      images: []
    });

    expect(result.fileName).toBe('人工智能智能体从对话到行动的革命.pptx');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ppt',
        title: '人工智能智能体从对话到行动的革命',
        presentationTemplate: 'technology'
      })
    );
    expect(attachDocumentResult).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent requests before compiling or generating twice', async () => {
    const { attachDocumentResult, recover, run, service, conversation } = environment();
    const input = {
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt' as const,
      presentationTemplate: 'work_report' as const,
      images: []
    };

    const [first, second] = await Promise.all([
      service.generateFromMessage(input),
      service.generateFromMessage(input)
    ]);

    expect(first).toEqual(second);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(attachDocumentResult).toHaveBeenCalledTimes(1);
  });

  it('persists preparation and a safe terminal failure when recovery cannot compile', async () => {
    const {
      recover,
      service,
      conversation,
      updateDocumentGenerationStatus
    } = environment();
    const input = {
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'excel' as const,
      images: []
    };

    await service.prepare(input);
    recover.mockImplementationOnce(() => {
      throw new DocumentDraftCompilationError(
        'invalid_structure',
        'The model response is not valid JSON'
      );
    });
    await expect(service.generateFromMessage(input)).rejects.toMatchObject({
      code: 'invalid_structure'
    });

    expect(updateDocumentGenerationStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: { state: 'generating_content', kind: 'excel' }
      })
    );
    expect(updateDocumentGenerationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: {
          state: 'failed',
          kind: 'excel',
          errorCode: 'invalid_outline'
        }
      })
    );
  });

  it('marks a persisted active Office state interrupted after an application restart', async () => {
    let current = setDocumentGenerationStatusOnMessage(
      completedConversation('{"kind":"word"}'),
      messageId,
      { state: 'generating_file', kind: 'word' },
      now
    );
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => current,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus: async (input) => {
          if (input.expectedRevision !== current.revision) {
            throw new ConversationApplicationError(
              'revision_conflict',
              'Conversation revision has changed',
              current.revision
            );
          }
          current = setDocumentGenerationStatusOnMessage(
            current,
            input.messageId,
            input.status,
            now
          );
        }
      },
      compiler: {
        compile: () => recoveredOutline(),
        recover: () => recoveredOutline()
      },
      generator: { run: vi.fn() },
      fingerprint: () => 'content-sha256',
      wait: async () => undefined
    });

    await expect(
      service.reconcileInterrupted({
        conversationId,
        expectedRevision: current.revision,
        messageId
      })
    ).resolves.toBe(true);
    expect(current.messages[0].documentGenerationStatus).toEqual({
      state: 'interrupted',
      kind: 'word'
    });
  });

  it.each(['word', 'excel'] as const)(
    'recovers an invalid %s draft without changing its requested format',
    async (kind) => {
      const { recover, service, conversation } = environment('not structured');

      await service.generateFromMessage({
        conversationId,
        expectedRevision: conversation.revision,
        messageId,
        kind,
        images: []
      });

      expect(recover).toHaveBeenCalledWith({ content: 'not structured', kind, operation: 'create', attachmentRefs: [] });
    }
  );
});
