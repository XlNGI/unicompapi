import { describe, expect, it, vi } from 'vitest';
import type { DocumentGenerationProgressCallback, DocumentGenerationProgressEvent } from '../../src/application/document-generation-service';
import {
  ConversationApplicationError,
  collectRevisionRequestText,
  DocumentDraftCompilationError,
  DocumentGenerationApplicationService,
  type DocumentGenerationExecutionInput,
  parseRequestedPresentationTotalPages,
  preserveUntargetedDocumentSections,
  waitForDocumentResponseCompletion
} from '../../src/application';
import {
  appendAssistantMessageChunk,
  addUserMessage,
  attachDocumentResultToMessage,
  beginAssistantMessage,
  completeAssistantMessage,
  createConversation,
  startAssistantMessageStreaming,
  setDocumentGenerationStatusOnMessage,
  toConversationId,
  toConversationWorkflowId,
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

  it('preserves all other sections when a PPT physical page is revised', () => {
    const previous = {
      kind: 'ppt' as const,
      title: '运营方案',
      sections: [
        { heading: '第一页', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'paragraph' as const, text: '第一页旧内容' }] },
        { heading: '第二页', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'paragraph' as const, text: '第二页旧内容' }] }
      ]
    };
    const next = {
      ...previous,
      title: '被模型改写的标题',
      sections: [
        { ...previous.sections[0], blocks: [{ type: 'paragraph' as const, text: '第二页的新内容' }] },
        { ...previous.sections[1], blocks: [{ type: 'paragraph' as const, text: '不应被修改' }] }
      ]
    };

    const revised = preserveUntargetedDocumentSections(previous, next, '把第二页改成新的表达', { checksumSha256: '0'.repeat(64), totalPages: 4, sections: [{ sectionIndex: 0, heading: '第一页', pages: [2] }, { sectionIndex: 1, heading: '第二页', pages: [3] }] });
    expect(revised.title).toBe(previous.title);
    expect(revised.sections[0].blocks).toEqual(next.sections[0].blocks);
    expect(revised.sections[1]).toEqual(previous.sections[1]);
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
    expect(events.map(event => `${event.code}:${event.status}`)).toEqual(['plan_validation:started', 'plan_validation:completed']);
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('records failed outline validation without claiming success or starting file generation', async () => {
    const events: DocumentGenerationProgressEvent[] = [];
    const f = environment(undefined, async event => { events.push(event); });
    f.recover.mockImplementation(() => { throw new DocumentDraftCompilationError('invalid_structure', 'invalid outline'); });
    await expect(f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision, messageId,
      kind: 'ppt', images: [] })).rejects.toThrow('invalid outline');
    expect(events.map(event => `${event.code}:${event.status}`)).toEqual(['plan_validation:started', 'plan_validation:failed']);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('does not fail successful generation when progress recording is unavailable', async () => {
    const f = environment(undefined, async () => { throw new Error('trace unavailable'); });
    await expect(f.service.generateFromMessage({ conversationId, expectedRevision: f.conversation.revision, messageId,
      kind: 'ppt', images: [] })).resolves.toMatchObject({ workId: 'work-document-application' });
    expect(f.attachDocumentResult).toHaveBeenCalledTimes(1);
  });

  it('prepares and completes an explicit clear revision without provider output', async () => {
    const progress: DocumentGenerationProgressEvent[] = [];
    const parentMessageId = toMessageId('document-local-clear-parent');
    const sourceMessageId = toMessageId('document-local-clear-source');
    const parentWorkId = toWorkId('document-local-clear-work');
    const workflowId = toConversationWorkflowId('document-local-clear-workflow');
    const previousOutline = {
      kind: 'ppt' as const,
      title: '龙文化',
      sections: [
        {
          heading: '第一章',
          level: 1 as const,
          blocks: [{ type: 'paragraph' as const, text: '保留' }]
        },
        {
          heading: '第二章',
          level: 1 as const,
          blocks: [{ type: 'paragraph' as const, text: '清空' }]
        }
      ]
    };
    let conversation = createConversation({
      id: conversationId,
      title: '本地清空',
      projectId,
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      parentMessageId,
      JSON.stringify(previousOutline)
    );
    conversation = attachDocumentResultToMessage(
      conversation,
      parentMessageId,
      {
        workId: parentWorkId,
        fileName: '龙文化.pptx',
        kind: 'ppt',
        sizeBytes: 4096,
        validatedContent: JSON.stringify(previousOutline)
      },
      now
    );
    conversation = addUserMessage(conversation, {
      id: sourceMessageId,
      content: '将第二章的内容清空',
      createdAt: now
    });
    const workflow = {
      schemaVersion: 1 as const,
      id: workflowId,
      projectId,
      conversationId,
      sourceMessageId,
      revision: 1,
      status: 'ready' as const,
      plan: {
        schemaVersion: 1 as const,
        kind: 'document' as const,
        action: 'revise' as const,
        documentKind: 'ppt' as const,
        targetHint: { unit: 'section' as const, ordinal: 2 },
        parameters: { topic: '将第二章的内容清空' },
        sourcePolicy: 'none' as const,
        missing: [],
        ambiguities: [],
        confidence: 'high' as const,
        needsConfirmation: false
      },
      pendingQuestions: [],
      resolvedTarget: { artifactRef: parentMessageId, version: 1 },
      createdAt: now,
      updatedAt: now
    };
    const beginExecution = vi.fn(async () => undefined);
    const finishExecution = vi.fn(async () => undefined);
    const createCompletedLocalAssistantMessage = vi.fn(async (input: {
      readonly expectedRevision: number;
      readonly content: string;
    }) => {
      expect(input.expectedRevision).toBe(conversation.revision);
      const localMessageId = toMessageId('document-local-clear-result');
      conversation = appendCompletedAssistantMessage(
        conversation,
        localMessageId,
        input.content
      );
      return { conversation, messageId: localMessageId };
    });
    const updateDocumentGenerationStatus = vi.fn(async (input: {
      readonly messageId: ReturnType<typeof toMessageId>;
      readonly status: Parameters<typeof setDocumentGenerationStatusOnMessage>[2];
    }) => {
      conversation = setDocumentGenerationStatusOnMessage(
        conversation,
        input.messageId,
        input.status,
        now
      );
    });
    const attachDocumentResult = vi.fn(async (input: {
      readonly messageId: ReturnType<typeof toMessageId>;
      readonly documentResult: Parameters<typeof attachDocumentResultToMessage>[2];
    }) => {
      conversation = attachDocumentResultToMessage(
        conversation,
        input.messageId,
        input.documentResult,
        now
      );
    });
    const run = vi.fn(async (input: DocumentGenerationExecutionInput) => ({
      taskId: toTaskId('task-local-clear'),
      executionId: toExecutionId('execution-local-clear'),
      workId: toWorkId('work-local-clear-result'),
      fileName: '龙文化-新版.pptx',
      sizeBytes: 4096,
      outline: input.outline
    }));
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => conversation,
        createCompletedLocalAssistantMessage,
        updateDocumentGenerationStatus,
        attachDocumentResult
      },
      workflows: {
        load: async () => workflow,
        beginExecution,
        finishExecution
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: ({ content }) => JSON.parse(content)
      },
      generator: { run },
      onProgress: async event => { progress.push(event); },
      revisionAgent: async (input) => ({
        outline: {
          ...input.outline,
          sections: [
            input.outline.sections[0],
            { ...input.outline.sections[1], blocks: [] }
          ]
        },
        agent: {
          state: 'completed_unvalidated',
          steps: 4,
          costUnits: 0,
          observations: [],
          summary: 'Local clear complete'
        },
        changed: true,
        targetSectionIndex: 1,
        patch: {
          operation: 'clear_section',
          target: {
            sectionIndex: 1,
            sectionHeading: '第二章',
            pageNumber: 3
          }
        }
      }),
      fingerprint: () => 'local-clear-fingerprint',
      nextLocalExecutionId: () => 'local-clear-execution',
      wait: async () => undefined
    });

    const prepared = await service.prepareDeterministicRevision({
      conversationId,
      expectedRevision: conversation.revision,
      workflowId,
      expectedWorkflowRevision: workflow.revision,
      kind: 'ppt',
      parentWorkId
    });
    const result = await service.generateFromMessage({
      ...prepared,
      kind: 'ppt',
      parentWorkId,
      images: []
    });

    expect(result.workId).toBe(toWorkId('work-local-clear-result'));
    expect(progress.filter(event => event.operationId === 'document-revision').map(event => [event.code, event.status]))
      .toEqual([['tool_call', 'started'], ['tool_result', 'completed']]);
    expect(createCompletedLocalAssistantMessage).toHaveBeenCalledOnce();
    expect(beginExecution).toHaveBeenCalledOnce();
    expect(finishExecution).toHaveBeenLastCalledWith(
      'local-clear-execution',
      'completed'
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      parentWorkId,
      revisionPatch: expect.objectContaining({ operation: 'clear_section' }),
      outline: expect.objectContaining({
        sections: [
          previousOutline.sections[0],
          expect.objectContaining({ blocks: [] })
        ]
      })
    }));
    expect(
      conversation.messages.find((message) => message.id === parentMessageId)
        ?.documentResult?.workId
    ).toBe(parentWorkId);
  });

  it('rejects mixed clear and rewrite instructions before creating a local result message', async () => {
    const parentMessageId = toMessageId('document-local-mixed-parent');
    const sourceMessageId = toMessageId('document-local-mixed-source');
    const parentWorkId = toWorkId('document-local-mixed-work');
    const workflowId = toConversationWorkflowId('document-local-mixed-workflow');
    const outline = {
      kind: 'ppt' as const,
      title: '安全边界',
      sections: [
        { heading: '第一章', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '甲' }] },
        { heading: '第二章', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '乙' }] }
      ]
    };
    let conversation = createConversation({ id: conversationId, title: '安全边界', projectId, createdAt: now });
    conversation = appendCompletedAssistantMessage(conversation, parentMessageId, JSON.stringify(outline));
    conversation = attachDocumentResultToMessage(conversation, parentMessageId, {
      workId: parentWorkId,
      fileName: '安全边界.pptx',
      kind: 'ppt',
      sizeBytes: 100,
      validatedContent: JSON.stringify(outline)
    }, now);
    conversation = addUserMessage(conversation, {
      id: sourceMessageId,
      content: '清空第二章并改写第一章',
      createdAt: now
    });
    const createCompletedLocalAssistantMessage = vi.fn();
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => conversation,
        createCompletedLocalAssistantMessage,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus: async () => undefined
      },
      workflows: {
        load: async () => ({
          schemaVersion: 1,
          id: workflowId,
          projectId,
          conversationId,
          sourceMessageId,
          revision: 0,
          status: 'ready',
          plan: {
            schemaVersion: 1,
            kind: 'document',
            action: 'revise',
            documentKind: 'ppt',
            targetHint: { unit: 'section', ordinal: 2 },
            parameters: {},
            sourcePolicy: 'none',
            missing: [],
            ambiguities: [],
            confidence: 'high',
            needsConfirmation: false
          },
          pendingQuestions: [],
          resolvedTarget: { artifactRef: parentMessageId, version: 1 },
          createdAt: now,
          updatedAt: now
        }),
        beginExecution: async () => undefined,
        finishExecution: async () => undefined
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: ({ content }) => JSON.parse(content)
      },
      generator: { run: vi.fn() },
      fingerprint: () => 'unused'
    });

    await expect(service.prepareDeterministicRevision({
      conversationId,
      expectedRevision: conversation.revision,
      workflowId,
      expectedWorkflowRevision: 0,
      kind: 'ppt',
      parentWorkId
    })).rejects.toMatchObject({ code: 'local_revision_not_supported' });
    expect(createCompletedLocalAssistantMessage).not.toHaveBeenCalled();
  });

  it('applies a deterministic PPT page clear without compiling the provider draft', async () => {
    const previousMessageId = toMessageId('document-application-clear-parent');
    const currentMessageId = toMessageId('document-application-clear-current');
    const parentWorkId = toWorkId('document-application-clear-work');
    const previousOutline = {
      kind: 'ppt' as const,
      title: '关于龙的PPT',
      sections: [
        {
          heading: '神话起源',
          level: 1 as const,
          pageKind: 'insight' as const,
          blocks: [{ type: 'paragraph' as const, text: '需要清空的正文' }]
        },
        {
          heading: '现代诠释',
          level: 1 as const,
          pageKind: 'insight' as const,
          blocks: [{ type: 'paragraph' as const, text: '必须保留的正文' }]
        }
      ]
    };
    let conversation = createConversation({
      id: conversationId,
      title: 'PPT 局部清空',
      projectId,
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      previousMessageId,
      JSON.stringify(previousOutline)
    );
    conversation = attachDocumentResultToMessage(
      conversation,
      previousMessageId,
      {
        workId: parentWorkId,
        fileName: '关于龙的PPT.pptx',
        kind: 'ppt',
        sizeBytes: 4096
      },
      now
    );
    conversation = addUserMessage(conversation, {
      id: toMessageId('document-application-clear-request'),
      content: '将第二页的内容清空',
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      currentMessageId,
      '这不是有效的文档大纲'
    );

    const compile = vi.fn(({ content }: { readonly content: string }) =>
      JSON.parse(content)
    );
    const recover = vi.fn(({ content }: { readonly content: string }) =>
      JSON.parse(content)
    );
    const revisionAgent = vi.fn(async (input: Parameters<NonNullable<
      ConstructorParameters<typeof DocumentGenerationApplicationService>[0]['revisionAgent']
    >>[0]) => ({
      outline: {
        ...input.outline,
        sections: [
          { ...input.outline.sections[0], blocks: [] },
          input.outline.sections[1]
        ]
      },
      agent: {
        state: 'completed_unvalidated' as const,
        steps: 4,
        costUnits: 0,
        observations: [],
        summary: 'Scoped clear completed'
      },
      changed: true,
      targetSectionIndex: 0,
      patch: {
        operation: 'clear_section' as const,
        target: {
          sectionIndex: 0,
          sectionHeading: '神话起源',
          pageNumber: 2,
          targetUnit: 'page' as const
        }
      }
    }));
    const run = vi.fn(async () => ({
      taskId: toTaskId('task-document-clear-page'),
      executionId: toExecutionId('execution-document-clear-page'),
      workId: toWorkId('work-document-clear-page'),
      fileName: '关于龙的PPT-新版.pptx',
      sizeBytes: 4096
    }));
    const fingerprint = vi.fn<(content: string) => string>(() => 'clear-page-content-sha256');
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus: async () => undefined
      },
      compiler: {
        compile,
        recover
      },
      generator: { run },
      revisionAgent,
      fingerprint,
      wait: async () => undefined
    });

    await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId: currentMessageId,
      kind: 'ppt',
      parentWorkId,
      images: []
    });

    expect(revisionAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestText: '将第二页的内容清空',
        outline: previousOutline
      })
    );
    expect(revisionAgent.mock.calls[0]?.[0]).not.toHaveProperty('proposedOutline');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith({
      content: JSON.stringify(previousOutline),
      kind: 'ppt'
    });
    expect(recover).not.toHaveBeenCalled();
    expect(JSON.parse(fingerprint.mock.calls[0][0])).toMatchObject({
      content: '将第二页的内容清空', kind: 'ppt', theme: null, presentationTemplate: null,
      parentWorkId, images: []
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        parentWorkId,
        outline: expect.objectContaining({
          sections: [
            expect.objectContaining({ blocks: [] }),
            previousOutline.sections[1]
          ]
        }),
        revisionPatch: expect.objectContaining({
          operation: 'clear_section',
          target: expect.objectContaining({ pageNumber: 2, targetUnit: 'page' })
        })
      })
    );
  });

  it('chains every revision from the latest application-validated outline', async () => {
    const initialMessageId = toMessageId('document-canonical-initial');
    const firstRevisionMessageId = toMessageId('document-canonical-revision-1');
    const secondRevisionMessageId = toMessageId('document-canonical-revision-2');
    const initialWorkId = toWorkId('document-canonical-work-0');
    const firstWorkId = toWorkId('document-canonical-work-1');
    const secondWorkId = toWorkId('document-canonical-work-2');
    const initialOutline = {
      kind: 'ppt' as const,
      title: 'Canonical revision chain',
      sections: [
        {
          heading: 'Page two',
          level: 1 as const,
          pageKind: 'insight' as const,
          blocks: [{ type: 'paragraph' as const, text: 'Keep until round one' }]
        },
        {
          heading: 'Page three',
          level: 1 as const,
          pageKind: 'insight' as const,
          blocks: [{ type: 'paragraph' as const, text: 'Keep until round two' }]
        }
      ]
    };
    const staleProviderOutline = {
      ...initialOutline,
      sections: [
        initialOutline.sections[0],
        { ...initialOutline.sections[1], blocks: [] }
      ]
    };
    let conversation = createConversation({
      id: conversationId,
      title: 'Canonical revisions',
      projectId,
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      initialMessageId,
      JSON.stringify(initialOutline)
    );
    conversation = attachDocumentResultToMessage(
      conversation,
      initialMessageId,
      {
        workId: initialWorkId,
        fileName: 'canonical.pptx',
        kind: 'ppt',
        sizeBytes: 4096
      },
      now
    );
    conversation = addUserMessage(conversation, {
      id: toMessageId('document-canonical-request-1'),
      content: '\u5c06\u7b2c\u4e8c\u9875\u7684\u5185\u5bb9\u6e05\u7a7a',
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      firstRevisionMessageId,
      JSON.stringify(staleProviderOutline)
    );

    const revisionAgent = vi.fn(async (input: Parameters<NonNullable<
      ConstructorParameters<typeof DocumentGenerationApplicationService>[0]['revisionAgent']
    >>[0]) => {
      const targetSectionIndex = input.requestText.includes('\u7b2c\u4e09\u9875') ? 1 : 0;
      const targetSection = input.outline.sections[targetSectionIndex];
      if (!targetSection) throw new Error('revision target missing');
      const outline = {
        ...input.outline,
        sections: input.outline.sections.map((section, index) =>
          index === targetSectionIndex ? { ...section, blocks: [] } : section
        )
      };
      return {
        outline,
        agent: {
          state: 'completed_unvalidated' as const,
          steps: 4,
          costUnits: 0,
          observations: [],
          summary: 'Scoped clear completed'
        },
        changed: true,
        targetSectionIndex,
        patch: {
          operation: 'clear_section' as const,
          target: {
            sectionIndex: targetSectionIndex,
            sectionHeading: targetSection.heading,
            pageNumber: targetSectionIndex + 2,
            targetUnit: 'page' as const
          }
        }
      };
    });
    let runCount = 0;
    const run = vi.fn(async () => {
      runCount += 1;
      return {
        taskId: toTaskId(`document-canonical-task-${runCount}`),
        executionId: toExecutionId(`document-canonical-execution-${runCount}`),
        workId: runCount === 1 ? firstWorkId : secondWorkId,
        fileName: `canonical-${runCount}.pptx`,
        sizeBytes: 4096
      };
    });
    const attachDocumentResult = vi.fn(async (input: {
      readonly messageId: ReturnType<typeof toMessageId>;
      readonly expectedRevision: number;
      readonly documentResult: Parameters<typeof attachDocumentResultToMessage>[2];
    }) => {
      expect(input.expectedRevision).toBe(conversation.revision);
      conversation = attachDocumentResultToMessage(
        conversation,
        input.messageId,
        input.documentResult,
        now
      );
    });
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult,
        updateDocumentGenerationStatus: async (input) => {
          expect(input.expectedRevision).toBe(conversation.revision);
          conversation = setDocumentGenerationStatusOnMessage(
            conversation,
            input.messageId,
            input.status,
            now
          );
        }
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: ({ content }) => JSON.parse(content)
      },
      generator: { run },
      revisionAgent,
      fingerprint: (content) => content,
      wait: async () => undefined
    });

    await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId: firstRevisionMessageId,
      kind: 'ppt',
      parentWorkId: initialWorkId,
      images: []
    });

    const firstRevisionMessage = conversation.messages.find(
      (message) => message.id === firstRevisionMessageId
    );
    expect(firstRevisionMessage?.content).toBe(JSON.stringify(staleProviderOutline));
    const firstValidatedOutline = JSON.parse(
      firstRevisionMessage?.documentResult?.validatedContent ?? ''
    );
    expect(firstValidatedOutline.sections[0].blocks).toEqual([]);
    expect(firstValidatedOutline.sections[1].blocks).toEqual(
      initialOutline.sections[1].blocks
    );

    conversation = addUserMessage(conversation, {
      id: toMessageId('document-canonical-request-2'),
      content: '\u5c06\u7b2c\u4e09\u9875\u7684\u5185\u5bb9\u6e05\u7a7a',
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      secondRevisionMessageId,
      JSON.stringify(staleProviderOutline)
    );

    await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId: secondRevisionMessageId,
      kind: 'ppt',
      parentWorkId: firstWorkId,
      images: []
    });

    expect(revisionAgent).toHaveBeenCalledTimes(2);
    expect(revisionAgent.mock.calls[1]?.[0].outline.sections[0].blocks).toEqual([]);
    expect(revisionAgent.mock.calls[1]?.[0].outline.sections[1].blocks).toEqual(
      initialOutline.sections[1].blocks
    );
    const secondRevisionMessage = conversation.messages.find(
      (message) => message.id === secondRevisionMessageId
    );
    const secondValidatedOutline = JSON.parse(
      secondRevisionMessage?.documentResult?.validatedContent ?? ''
    );
    expect(secondValidatedOutline.sections.map(
      (section: { blocks: unknown[] }) => section.blocks
    ))
      .toEqual([[], []]);
    expect(attachDocumentResult).toHaveBeenCalledTimes(2);
  });

  it('aggregates the consecutive revision messages and applies an exact total-page rewrite', async () => {
    const previousMessageId = toMessageId('document-application-previous-message');
    const currentMessageId = toMessageId('document-application-page-count-message');
    const parentWorkId = toWorkId('document-application-parent-work');
    const previousOutline = {
      kind: 'ppt' as const,
      title: '关于龙的PPT',
      sections: [
        {
          heading: '资料说明',
          level: 1 as const,
          pageKind: 'insight' as const,
          blocks: [{ type: 'bullets' as const, items: ['原内容'] }]
        }
      ]
    };
    const proposedOutline = {
      ...previousOutline,
      title: '模型不应擅自改标题',
      sections: Array.from({ length: 3 }, (_, index) => ({
        heading: `正文 ${index + 1}`,
        level: 1 as const,
        pageKind: 'insight' as const,
        blocks: [{ type: 'bullets' as const, items: [`扩展内容 ${index + 1}`] }]
      }))
    };
    let conversation = createConversation({
      id: conversationId,
      title: 'PPT 修订',
      projectId,
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      previousMessageId,
      JSON.stringify(previousOutline)
    );
    conversation = attachDocumentResultToMessage(
      conversation,
      previousMessageId,
      {
        workId: parentWorkId,
        fileName: '关于龙的PPT.pptx',
        kind: 'ppt',
        sizeBytes: 4096
      },
      now
    );
    conversation = addUserMessage(conversation, {
      id: toMessageId('document-application-page-count-request'),
      content: '内容太少了加到5页',
      createdAt: now
    });
    conversation = addUserMessage(conversation, {
      id: toMessageId('document-application-revision-confirmation'),
      content: '修改文档',
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      currentMessageId,
      JSON.stringify(proposedOutline)
    );

    expect(collectRevisionRequestText(conversation, currentMessageId)).toBe(
      '内容太少了加到5页\n修改文档'
    );
    const revisionAgent = vi.fn();
    const run = vi.fn(async () => ({
      taskId: toTaskId('task-document-page-count'),
      executionId: toExecutionId('execution-document-page-count'),
      workId: toWorkId('work-document-page-count'),
      fileName: '关于龙的PPT-5页.pptx',
      sizeBytes: 8192
    }));
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus: async () => undefined
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: ({ content }) => JSON.parse(content)
      },
      generator: { run },
      revisionAgent,
      fingerprint: () => 'page-count-content-sha256',
      wait: async () => undefined
    });

    await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId: currentMessageId,
      kind: 'ppt',
      parentWorkId,
      presentationTemplate: 'work_report',
      images: []
    });

    expect(revisionAgent).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        parentWorkId,
        requestedTotalPages: 5,
        outline: expect.objectContaining({
          title: previousOutline.title,
          sections: proposedOutline.sections
        })
      })
    );
  });

  it('rejects a total-page rewrite whose body section count is not exact', async () => {
    const previousMessageId = toMessageId('document-application-mismatch-parent');
    const currentMessageId = toMessageId('document-application-mismatch-current');
    const parentWorkId = toWorkId('document-application-mismatch-work');
    const previousOutline = recoveredOutline();
    const proposedOutline = {
      ...previousOutline,
      sections: Array.from({ length: 5 }, (_, index) => ({
        ...previousOutline.sections[0],
        heading: `模型正文 ${index + 1}`
      }))
    };
    let conversation = createConversation({
      id: conversationId,
      title: 'PPT 页数不匹配',
      projectId,
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      previousMessageId,
      JSON.stringify(previousOutline)
    );
    conversation = attachDocumentResultToMessage(
      conversation,
      previousMessageId,
      {
        workId: parentWorkId,
        fileName: '上一版.pptx',
        kind: 'ppt',
        sizeBytes: 4096
      },
      now
    );
    conversation = addUserMessage(conversation, {
      id: toMessageId('document-application-mismatch-request'),
      content: '扩展至 5 页',
      createdAt: now
    });
    conversation = appendCompletedAssistantMessage(
      conversation,
      currentMessageId,
      JSON.stringify(proposedOutline)
    );
    const run = vi.fn();
    const statuses: unknown[] = [];
    const service = new DocumentGenerationApplicationService({
    resolvePresentationMap: async (_workId, outline) => ({ checksumSha256: '0'.repeat(64), totalPages: outline.sections.length + 2,
      sections: outline.sections.map((section, index) => ({ sectionIndex: index, heading: section.heading, pages: [index + 2] })) }),
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus: async (input) => {
          statuses.push(input.status);
        }
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: ({ content }) => JSON.parse(content)
      },
      generator: { run },
      revisionAgent: vi.fn(),
      fingerprint: () => 'page-count-content-sha256',
      wait: async () => undefined
    });

    await expect(service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId: currentMessageId,
      kind: 'ppt',
      parentWorkId,
      images: []
    })).rejects.toMatchObject({ code: 'page_count_mismatch' });
    expect(run).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({
      state: 'failed',
      kind: 'ppt',
      errorCode: 'page_count_mismatch'
    });
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

      expect(recover).toHaveBeenCalledWith({ content: 'not structured', kind });
    }
  );
});

describe('presentation total-page request parsing', () => {
  it.each([
    ['内容太少了加到5页', 5],
    ['扩展至 8 页', 8],
    ['页数：十二页', 12],
    ['生成一份 6 页 PPT', 6]
  ])('parses %s as an exact total', (request, expected) => {
    expect(parseRequestedPresentationTotalPages(request)).toBe(expected);
  });

  it('does not confuse a local page target with a total-page request', () => {
    expect(parseRequestedPresentationTotalPages('修改第5页')).toBeUndefined();
    expect(parseRequestedPresentationTotalPages('增加5页内容')).toBeUndefined();
  });
});

describe('waitForDocumentResponseCompletion', () => {
  it('stops polling an unresolved request at its budget and respects cancellation without another read', async () => {
    const read = vi.fn(async () => ({ state: 'streaming' as const }));
    await expect(waitForDocumentResponseCompletion({ read, wait: async () => undefined, maxWaitMs: 3_000 })).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(3);
    const controller = new AbortController();
    controller.abort();
    await expect(waitForDocumentResponseCompletion({ read, wait: async () => undefined, signal: controller.signal })).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(3);
  });

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

  it('recovers from transient completion-read failures without discarding the response', async () => {
    let reads = 0;

    const result = await waitForDocumentResponseCompletion({
      read: async () => {
        reads += 1;
        if (reads < 4) throw new Error('transient storage read');
        return { state: 'completed' as const, content: 'completed outline' };
      },
      wait: async () => undefined
    });

    expect(reads).toBe(4);
    expect(result).toEqual({
      state: 'completed',
      content: 'completed outline'
    });
  });

  it('fails closed after five consecutive completion-read failures', async () => {
    let reads = 0;

    await expect(waitForDocumentResponseCompletion({
      read: async () => {
        reads += 1;
        throw new Error('persistent storage read failure');
      },
      wait: async () => undefined
    })).rejects.toThrow('persistent storage read failure');

    expect(reads).toBe(5);
  });
});
