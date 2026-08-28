import { describe, expect, it, vi } from 'vitest';
import {
  ConversationApplicationError,
  DocumentDraftCompilationError,
  DocumentGenerationApplicationService,
  waitForDocumentResponseCompletion
} from '../../src/application';
import {
  appendAssistantMessageChunk,
  beginAssistantMessage,
  completeAssistantMessage,
  createConversation,
  startAssistantMessageStreaming,
  setDocumentGenerationStatusOnMessage,
  toConversationId,
  toExecutionId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toTaskId,
  toWorkId
} from '../../src/domain';

const projectId = toProjectId('document-application-project');
const conversationId = toConversationId('document-application-conversation');
const messageId = toMessageId('document-application-message');
const now = toIsoTimestamp('2026-08-27T00:00:00.000Z');

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

function environment(content = '{"kind":"ppt" "title":"缺少逗号"}') {
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
    projectId,
    conversations: {
      load: async () => conversation,
      attachDocumentResult,
      updateDocumentGenerationStatus
    },
    compiler: { compile, recover },
    generator: { run },
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

      expect(recover).toHaveBeenCalledWith({ content: 'not structured', kind });
    }
  );
});

describe('waitForDocumentResponseCompletion', () => {
  it('keeps waiting past the former renderer limit while the response is still active', async () => {
    let reads = 0;

    const result = await waitForDocumentResponseCompletion({
      read: async () => ({
        state: reads++ < 301 ? 'streaming' as const : 'completed' as const,
        content: 'completed outline'
      }),
      wait: async () => undefined
    });

    expect(reads).toBe(302);
    expect(result).toEqual({
      state: 'completed',
      content: 'completed outline'
    });
  });

  it('stops immediately on a real terminal failure', async () => {
    const wait = vi.fn(async () => undefined);

    await expect(waitForDocumentResponseCompletion({
      read: async () => ({ state: 'failed' as const }),
      wait
    })).resolves.toBeUndefined();

    expect(wait).not.toHaveBeenCalled();
  });
});
