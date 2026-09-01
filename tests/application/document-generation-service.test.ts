import { describe, expect, it, vi } from 'vitest';
import {
  ConversationApplicationError,
  DocumentDraftCompilationError,
  DocumentGenerationApplicationService,
  preserveUntargetedDocumentSections,
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

describe('semantic document revisions', () => {
  it('preserves untargeted chapters while applying the requested ordinal chapter', () => {
    const previous = {
      kind: 'ppt' as const,
      title: '运营方案',
      sections: [
        { heading: '第一章', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'bullets' as const, items: ['原章节一'] }] },
        { heading: '第二章', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'bullets' as const, items: ['原章节二'] }] },
        { heading: '第三章', level: 1 as const, pageKind: 'closing' as const, blocks: [{ type: 'bullets' as const, items: ['原章节三'] }] }
      ]
    };
    const next = {
      ...previous,
      title: '被模型改写的标题',
      sections: [
        { ...previous.sections[0], blocks: [{ type: 'bullets' as const, items: ['被错误改写一'] }] },
        { ...previous.sections[1], blocks: [{ type: 'bullets' as const, items: ['面向管理者的表达'] }] },
        { ...previous.sections[2], blocks: [{ type: 'bullets' as const, items: ['被错误改写三'] }] }
      ]
    };

    const revised = preserveUntargetedDocumentSections(previous, next, '把第二章改成面向非技术管理者的表达');
    expect(revised.title).toBe('运营方案');
    expect(revised.sections[0]).toEqual(previous.sections[0]);
    expect(revised.sections[1].blocks).toEqual([{ type: 'bullets', items: ['面向管理者的表达'] }]);
    expect(revised.sections[1].heading).toBe('第二章');
    expect(revised.sections[2]).toEqual(previous.sections[2]);
  });

  it('does not silently deliver unchanged technical copy for a management audience', () => {
    const previous = {
      kind: 'ppt' as const,
      title: '运营方案',
      sections: [
        { heading: '第一章', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'bullets' as const, items: ['保持不变'] }] },
        { heading: '第二章', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'bullets' as const, items: ['API 参数决定生成效果'] }] }
      ]
    };
    const revised = preserveUntargetedDocumentSections(
      previous,
      structuredClone(previous),
      '把第二章改成面向非技术管理者的表达'
    );
    expect(revised.sections[1].blocks).not.toEqual(previous.sections[1].blocks);
    expect(JSON.stringify(revised.sections[1])).toContain('系统能力');
    expect(revised.sections[1].action).toContain('试点');
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
