import { describe, expect, it, vi } from 'vitest';
import {
  ConversationApplicationError,
  DocumentDraftCompilationError,
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

function revisionConversation() {
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
    content: '清空第二章',
    displayContent: '清空第二章',
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

function environment() {
  const conversation = revisionConversation();
  const updateDocumentGenerationStatus = vi.fn(async () => undefined);
  const run = vi.fn(async () => generatedResult('revision'));
  const service = new DocumentGenerationApplicationService({
    projectId,
    conversations: {
      load: async () => conversation,
      attachDocumentResult: async () => undefined,
      updateDocumentGenerationStatus
    },
    compiler: {
      compile: ({ content }) => JSON.parse(content),
      recover: () => JSON.parse(outlineJson())
    },
    generator: { run },
    fingerprint: () => 'content-sha256',
    wait: async () => undefined
  });
  return { conversation, service, run, updateDocumentGenerationStatus };
}

function serviceWithCompilerError(
  conversation: ReturnType<typeof revisionConversation>
) {
  const compile = vi.fn(() => {
    throw new DocumentDraftCompilationError(
      'invalid_structure',
      'The model response is not valid JSON'
    );
  });
  const recover = vi.fn(() => JSON.parse(outlineJson('兼容章节')));
  const run = vi.fn(async () => generatedResult('legacy'));
  const service = new DocumentGenerationApplicationService({
    projectId,
    conversations: {
      load: async () => conversation,
      attachDocumentResult: async () => undefined,
      updateDocumentGenerationStatus: async () => undefined
    },
    compiler: { compile, recover },
    generator: { run },
    fingerprint: () => 'content-sha256',
    wait: async () => undefined
  });
  return { service, run, recover };
}

describe('document generation revision fail-closed boundary', () => {
  it('passes a structurally validated local revision to the rendering runner', async () => {
    const { conversation, run, updateDocumentGenerationStatus } = environment();
    const currentTarget = JSON.parse(outlineJson()).sections[1];
    const parsed = JSON.parse(outlineJson());
    const revised = {
      ...parsed,
      sections: parsed.sections.map(
        (section: object, index: number) =>
          index === 1 ? { ...section, blocks: [] } : section
      )
    };
    const service = new DocumentGenerationApplicationService({
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: () => JSON.parse(outlineJson())
      },
      generator: { run },
      fingerprint: () => 'content-sha256',
      revisionAgent: async () => ({
        outline: revised,
        agent: {
          state: 'completed_unvalidated',
          steps: 4,
          costUnits: 8,
          observations: []
        },
        changed: true,
        targetSectionIndex: 1,
        patch: {
          operation: 'clear_section',
          target: {
            sectionIndex: 1,
            sectionHeading: currentTarget.heading,
            pageNumber: 3
          }
        }
      }),
      wait: async () => undefined
    });

    await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt',
      parentWorkId: toWorkId('work-parent'),
      images: []
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        outline: revised,
        revisionPatch: {
          operation: 'clear_section',
          target: {
            sectionIndex: 1,
            sectionHeading: currentTarget.heading,
            pageNumber: 3
          }
        }
      })
    );
  });

  it('uses the compatibility path only for an unparseable previous revision', async () => {
    const conversation = revisionConversation();
    const { service, run, recover } = serviceWithCompilerError(conversation);

    await service.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt',
      parentWorkId: toWorkId('work-parent'),
      images: []
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('stops before file creation when the revision agent throws', async () => {
    const { conversation, run, updateDocumentGenerationStatus } = environment();
    const service = new DocumentGenerationApplicationService({
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: () => JSON.parse(outlineJson())
      },
      generator: { run },
      fingerprint: () => 'content-sha256',
      revisionAgent: async () => {
        throw new Error('patch executor failed');
      },
      wait: async () => undefined
    });

    await expect(
      service.generateFromMessage({
        conversationId,
        expectedRevision: conversation.revision,
        messageId,
        kind: 'ppt',
        parentWorkId: toWorkId('work-parent'),
        images: []
      })
    ).rejects.toMatchObject({ code: 'revision_patch_failed' });

    expect(run).not.toHaveBeenCalled();
    expect(updateDocumentGenerationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ errorCode: 'revision_patch_failed' })
      })
    );
  });

  it('rejects model output that changes sections outside the revision target', async () => {
    const { conversation, run, updateDocumentGenerationStatus } = environment();
    const parsed = JSON.parse(outlineJson());
    const crossScope = {
      ...parsed,
      sections: parsed.sections.map(
        (section: object, index: number) =>
          index < 2 ? { ...section, blocks: [] } : section
      )
    };
    const service = new DocumentGenerationApplicationService({
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: () => JSON.parse(outlineJson())
      },
      generator: { run },
      fingerprint: () => 'content-sha256',
      revisionAgent: async () => ({
        outline: crossScope,
        agent: { state: 'completed', steps: 1, costUnits: 1, observations: [] },
        changed: true,
        targetSectionIndex: 1,
        patch: {
          operation: 'clear_section',
          target: { sectionIndex: 1, sectionHeading: '第二章', pageNumber: 3 }
        }
      }),
      wait: async () => undefined
    });

    await expect(
      service.generateFromMessage({
        conversationId,
        expectedRevision: conversation.revision,
        messageId,
        kind: 'ppt',
        parentWorkId: toWorkId('work-parent'),
        images: []
      })
    ).rejects.toMatchObject({ code: 'revision_scope_violation' });

    expect(run).not.toHaveBeenCalled();
    expect(updateDocumentGenerationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({
          errorCode: 'revision_scope_violation'
        })
      })
    );
  });

  it('fails closed without a new work when the revision chain conflicts', async () => {
    const { conversation, run, updateDocumentGenerationStatus } = environment();
    const serviceWithAgent = new DocumentGenerationApplicationService({
      projectId,
      conversations: {
        load: async () => conversation,
        attachDocumentResult: async () => undefined,
        updateDocumentGenerationStatus
      },
      compiler: {
        compile: ({ content }) => JSON.parse(content),
        recover: () => JSON.parse(outlineJson())
      },
      generator: { run },
      fingerprint: () => 'content-sha256',
      revisionAgent: async () => {
        throw new ConversationApplicationError(
          'revision_conflict',
          'Conversation revision has changed'
        );
      },
      wait: async () => undefined
    });

    await expect(
      serviceWithAgent.generateFromMessage({
        conversationId,
        expectedRevision: conversation.revision,
        messageId,
        kind: 'ppt',
        parentWorkId: toWorkId('work-parent'),
        images: []
      })
    ).rejects.toMatchObject({ code: 'revision_conflict' });

    expect(run).not.toHaveBeenCalled();
  });
});
