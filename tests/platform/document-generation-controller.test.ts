import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationApplicationService,
  ConversationStreamingService,
  DocumentGenerationApplicationService
} from '../../src/application';
import {
  appendAssistantMessageChunk,
  beginAssistantMessage,
  completeAssistantMessage,
  startAssistantMessageStreaming,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toWorkId,
  type Conversation
} from '../../src/domain';
import {
  DocumentGenerationController,
  DocumentGenerationRunner,
  generateDocumentFile,
  JsonProjectConversationRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  PlatformDocumentDraftCompiler,
  PlatformDocumentGenerationExecutor,
  type StorageProjectSession
} from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createEnvironment(options: {
  readonly runnerOptions?: Partial<
    ConstructorParameters<typeof DocumentGenerationRunner>[0]
  >;
  readonly onLoadConversation?: (count: number) => void | Promise<void>;
} = {}) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-doc-ipc-'));
  temporaryRoots.push(rootDirectory);
  const projectId = toProjectId('doc-ipc-project');
  let clock = Date.parse('2026-08-22T10:00:00.000Z');
  const now = () => new Date((clock += 1000)).toISOString();
  const ids = {
    nextConversationId: () => toConversationId(`conversation-${Math.random()}`),
    nextMessageId: () => toMessageId(`message-${Math.random()}`)
  };
  const storage = new NodeProjectStorage(rootDirectory);
  const repository = new JsonProjectConversationRepository(storage, projectId, now);
  const application = new ConversationApplicationService(repository, ids, now);
  const session: StorageProjectSession = {
    projectId,
    rootDirectory,
    projectName: '文档 IPC 项目'
  };
  const openedPaths: string[] = [];
  let conversationLoadCount = 0;
  const streaming = new ConversationStreamingService(repository, ids, now);
  const runner = new DocumentGenerationRunner({
    rootDirectory,
    projectId,
    now,
    createId: () => `id-${Math.random()}`,
    ...options.runnerOptions
  });
  const documentApplication = new DocumentGenerationApplicationService({
    projectId,
    conversations: {
      load: async (conversationId) => {
        conversationLoadCount += 1;
        await options.onLoadConversation?.(conversationLoadCount);
        return repository.get(conversationId);
      },
      attachDocumentResult: async (input) => {
        await streaming.attachDocumentResult(input);
      },
      updateDocumentGenerationStatus: async (input) => {
        await streaming.updateDocumentGenerationStatus(input);
      }
    },
    compiler: new PlatformDocumentDraftCompiler(),
    generator: new PlatformDocumentGenerationExecutor(runner),
    fingerprint: (content) =>
      createHash('sha256').update(content).digest('hex')
  });
  const controller = new DocumentGenerationController({
    getSession: () => session,
    getApplication: () => documentApplication,
    openPath: async (absolutePath) => {
      openedPaths.push(absolutePath);
      return '';
    }
  });
  const created = await application.create({
    title: '周报生成',
    projectId
  });
  return {
    conversationId: created.id,
    controller,
    now,
    openedPaths,
    repository,
    rootDirectory,
    session
  };
}

async function storeCompletedAssistantMessage(input: {
  readonly conversationId: string;
  readonly content: string;
  readonly messageId: string;
  readonly now: () => string;
  readonly repository: JsonProjectConversationRepository;
}): Promise<Conversation> {
  const stored = await input.repository.get(toConversationId(input.conversationId));
  if (!stored) throw new Error('conversation missing');
  const messageId = toMessageId(input.messageId);
  const steps: Array<(current: Conversation) => Conversation> = [
    (current) =>
      beginAssistantMessage(current, {
        id: messageId,
        createdAt: toIsoTimestamp(input.now())
      }),
    (current) =>
      startAssistantMessageStreaming(current, messageId, toIsoTimestamp(input.now())),
    (current) =>
      appendAssistantMessageChunk(
        current,
        messageId,
        input.content,
        toIsoTimestamp(input.now())
      ),
    (current) =>
      completeAssistantMessage(current, messageId, toIsoTimestamp(input.now()))
  ];
  let conversation = stored;
  for (const step of steps) {
    const next = step(conversation);
    await input.repository.save(next, conversation.revision);
    conversation = next;
  }
  return conversation;
}

describe('document generation controller', () => {
  it('only exposes message-based generation that can be cancelled and deduplicated', async () => {
    const { controller } = await createEnvironment();
    expect(controller).not.toHaveProperty('generateFromConversation');
    expect(controller).toHaveProperty('generateFromMessage');
    expect(controller).toHaveProperty('prepareGeneration');
    expect(controller).toHaveProperty('reconcileGeneration');
    expect(controller).toHaveProperty('cancelGeneration');
  });

  it('opens the registered document file', async () => {
    const { controller, conversationId, now, openedPaths, repository } =
      await createEnvironment();
    const messageId = 'message-open-document';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: '# 项目周报\n\n## 本周进展\n\n- 完成方案评审'
    });
    const result = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word'
    });
    if (!result.ok) throw new Error('generation failed');
    const opened = await controller.openDocument({ workId: result.value.workId });
    expect(opened.ok).toBe(true);
    expect(openedPaths).toHaveLength(1);
    expect(openedPaths[0]).toContain('files');
    expect(openedPaths[0]).toContain('documents');
  });

  it('generates a document from a completed AI assistant message', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const stored = await repository.get(toConversationId(conversationId));
    if (!stored) throw new Error('conversation missing');
    let conversation: Conversation = stored;
    const messageId = toMessageId('message-ai-1');
    const steps: Array<(current: typeof conversation) => typeof conversation> = [
      (current) =>
        beginAssistantMessage(current, {
          id: messageId,
          createdAt: toIsoTimestamp(now())
        }),
      (current) =>
        startAssistantMessageStreaming(
          current,
          messageId,
          toIsoTimestamp(now())
        ),
      (current) =>
        appendAssistantMessageChunk(
          current,
          messageId,
          '# 项目周报\n\n## 本周进展\n\n- 完成方案评审',
          toIsoTimestamp(now())
        ),
      (current) =>
        completeAssistantMessage(
          current,
          messageId,
          toIsoTimestamp(now())
        )
    ];
    for (const step of steps) {
      const next = step(conversation);
      await repository.save(next, conversation.revision);
      conversation = next;
    }
    const result = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word'
    });
    if (!result.ok) {
      throw new Error(`generation failed: ${result.error.code} ${result.error.message}`);
    }
    expect(result.ok).toBe(true);
    const refreshed = await repository.get(toConversationId(conversationId));
    const message = refreshed?.messages.find((item) => item.id === messageId);
    expect(message?.state).toBe('completed');
    if (message?.state !== 'completed') throw new Error('message not completed');
    expect(message.documentResult?.workId).toBe(result.value.workId);
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect((await works.get(toWorkId(result.value.workId)))?.mediaKind).toBe(
      'document'
    );
  });

  it('recovers malformed presentation JSON and completes the full PPTX workflow', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const messageId = 'message-malformed-ppt';
    const title = '人工智能智能体从对话到行动的革命';
    const heading = '智能体正在改变企业软件的使用方式';
    const takeaway =
      'AI Agent 的核心变化不是让对话更像人，而是把理解目标、拆解任务、调用工具和核验结果连接成可以持续执行的工作闭环。';
    const action =
      '建议先选择一个高频、边界清晰且结果可核验的办公流程，在保留人工确认与失败回退的前提下完成小范围试点，再根据准确率、节省时间和异常处理成本决定扩展范围。';
    const details = [
      '目标理解：从用户自然语言中识别业务目标、限制条件和预期交付物',
      '任务编排：把复杂工作拆成可观察、可取消、可恢复的执行步骤',
      '工具协同：在权限边界内调用文档、数据和业务系统完成实际动作',
      '结果核验：用结构校验、状态记录和人工确认避免把模型输出直接当成事实'
    ];
    const malformed = `{
      "kind": "ppt",
      "title": "${title}"
      "sections": [{
        "heading": "${heading}",
        "pageKind": "insight",
        "takeaway": "${takeaway}",
        "content": [{"type": "bullets", "items": ${JSON.stringify(details)}}],
        "action": "${action}"
      }]
    }`;
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: malformed
    });

    const result = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt',
      presentationTemplate: 'technology'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fileName.endsWith('.pptx')).toBe(true);
    const refreshed = await repository.get(toConversationId(conversationId));
    const attachedMessages = refreshed?.messages.filter(
      (message) => message.role === 'assistant' && message.documentResult !== undefined
    );
    expect(attachedMessages).toHaveLength(1);
    expect(attachedMessages?.[0]?.documentResult?.workId).toBe(result.value.workId);

    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    const storedWorks = await works.list(toProjectId('doc-ipc-project'));
    expect(storedWorks).toHaveLength(1);
    expect(storedWorks[0]?.id).toBe(toWorkId(result.value.workId));

    const pptxPath = path.join(
      rootDirectory,
      'files',
      'documents',
      result.value.fileName
    );
    const zip = new AdmZip(Buffer.from(await readFile(pptxPath)));
    expect(zip.getEntry('ppt/presentation.xml')).toBeTruthy();
    const slideXml = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry))
      .join('\n');
    for (const expectedText of [
      title,
      heading,
      takeaway,
      action,
      ...details.flatMap((detail) => detail.split('：'))
    ]) {
      expect(slideXml).toContain(expectedText);
    }
  });

  it('generates a titled Word document from the observed model JSON shape', async () => {
    const { controller, conversationId, now, repository } =
      await createEnvironment();
    const messageId = 'message-observed-word';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        title: '智能客服 Agent 系统设计文档',
        sections: [
          {
            id: '1',
            heading: '一、系统概述',
            content: [{ type: 'paragraph', text: '系统说明。' }]
          }
        ]
      })
    });

    const result = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fileName).toContain('智能客服 Agent 系统设计文档');
    expect(result.value.fileName.startsWith('{')).toBe(false);
  });

  it('rejects unsupported model JSON without registering a Word work', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const messageId = 'message-invalid-word';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content:
        '{"title":"文档","sections":[{"heading":"正文","content":[{"type":"unknown"}]}]}'
    });

    const result = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word'
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid outline');
    expect(result.error.code).toBe('invalid_outline');
    const persistedConversation = await repository.get(
      toConversationId(conversationId)
    );
    expect(
      persistedConversation?.messages.find((item) => item.id === messageId)
        ?.documentGenerationStatus
    ).toEqual({
      state: 'failed',
      kind: 'word',
      errorCode: 'invalid_outline'
    });
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect(await works.list(toProjectId('doc-ipc-project'))).toEqual([]);
  });

  it('deduplicates concurrent generation requests for the same assistant message', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const messageId = 'message-concurrent-word';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        title: '并发文档',
        sections: [{ heading: '正文', content: [{ type: 'paragraph', text: '内容' }] }]
      })
    });
    const request = {
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word' as const
    };

    const [first, second] = await Promise.all([
      controller.generateFromMessage(request),
      controller.generateFromMessage(request)
    ]);

    expect(first).toEqual(second);
    if (!first.ok) throw new Error(first.error.message);
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect(await works.list(toProjectId('doc-ipc-project'))).toHaveLength(1);
  });

  it('reuses a completed result for the same message generation request', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const messageId = 'message-sequential-word';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        title: '顺序幂等文档',
        sections: [{ heading: '正文', content: [{ type: 'paragraph', text: '内容' }] }]
      })
    });
    const request = {
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word' as const
    };

    const first = await controller.generateFromMessage(request);
    const second = await controller.generateFromMessage(request);

    expect(first).toEqual(second);
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect(await works.list(toProjectId('doc-ipc-project'))).toHaveLength(1);
  });

  it('does not let an invalid request reuse a valid in-flight request', async () => {
    const { controller, conversationId, now, repository } = await createEnvironment();
    const messageId = 'message-invalid-concurrent';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        title: '合法请求',
        sections: [{ heading: '正文', content: [{ type: 'paragraph', text: '内容' }] }]
      })
    });
    const valid = controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word'
    });
    const invalid = controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'not-a-kind'
    });

    const [validResult, invalidResult] = await Promise.all([valid, invalid]);

    expect(validResult.ok).toBe(true);
    expect(invalidResult).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'kind must be word, excel or ppt' }
    });
  });

  it('does not merge requests whose output kind differs', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const messageId = 'message-different-kind';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        title: '多格式文档',
        sections: [{ heading: '正文', content: [{ type: 'paragraph', text: '内容' }] }]
      })
    });

    const word = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'word'
    });
    const ppt = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt'
    });

    expect(word.ok).toBe(true);
    expect(ppt.ok).toBe(true);
    if (!word.ok || !ppt.ok) return;
    expect(word.value.workId).not.toBe(ppt.value.workId);
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect(await works.list(toProjectId('doc-ipc-project'))).toHaveLength(2);
  }, 15_000);

  it('registers a revision as a new work and preserves the previous document', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const firstMessageId = 'message-word-version-1';
    const firstConversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId: firstMessageId,
      now,
      repository,
      content: '# 项目方案\n\n## 背景\n\n第一版内容。'
    });
    const first = await controller.generateFromMessage({
      conversationId,
      expectedRevision: firstConversation.revision,
      messageId: firstMessageId,
      kind: 'word'
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);

    const secondMessageId = 'message-word-version-2';
    const secondConversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId: secondMessageId,
      now,
      repository,
      content: '# 项目方案\n\n## 背景\n\n第一版内容。\n\n## 风险\n\n新增风险说明。'
    });
    const second = await controller.generateFromMessage({
      conversationId,
      expectedRevision: secondConversation.revision,
      messageId: secondMessageId,
      kind: 'word',
      parentWorkId: first.value.workId
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);

    const works = await new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    ).list(toProjectId('doc-ipc-project'));
    expect(works).toHaveLength(2);
    expect(works.find((work) => work.id === second.value.workId)?.parentWorkId)
      .toBe(first.value.workId);
    expect(works.some((work) => work.id === first.value.workId)).toBe(true);
  }, 15_000);

  it('rejects an unknown presentation template at the IPC boundary', async () => {
    const { controller, conversationId, now, repository } =
      await createEnvironment();
    const messageId = 'message-invalid-presentation-template';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        kind: 'ppt',
        title: '模板校验',
        sections: [
          {
            heading: '结论',
            level: 1,
            blocks: [{ type: 'bullets', items: ['结论：说明'] }]
          }
        ]
      })
    });

    const result = await controller.generateFromMessage({
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt',
      presentationTemplate: 'unknown-template'
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message:
          'presentationTemplate must be work_report, natural_minimal, business_minimal, technology or financing'
      }
    });
  });

  it('rejects undeclared document generation fields at the IPC boundary', async () => {
    const { controller } = await createEnvironment();

    const result = await controller.generateFromMessage({
      conversationId: 'conversation-unknown-field',
      expectedRevision: 0,
      messageId: 'message-unknown-field',
      kind: 'ppt',
      outputPath: 'D:\\untrusted\\result.pptx'
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'generateFromMessage contains unsupported field outputPath'
      }
    });
  });

  it('rejects a non-boolean AI image flag at the IPC boundary', async () => {
    const { controller } = await createEnvironment();

    const result = await controller.generateFromMessage({
      conversationId: 'conversation-invalid-ai-images',
      expectedRevision: 0,
      messageId: 'message-invalid-ai-images',
      kind: 'ppt',
      aiImages: 'true'
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'aiImages must be a boolean'
      }
    });
  });

  it('deduplicates the same PPT template while keeping different templates independent', async () => {
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment();
    const messageId = 'message-template-deduplication';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        kind: 'ppt',
        title: '模板并发验证',
        sections: [
          {
            heading: '关键判断',
            level: 1,
            takeaway: '不同模板应生成独立作品。',
            blocks: [{ type: 'bullets', items: ['依据：版式选择不同。'] }]
          }
        ]
      })
    });
    const shared = {
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt' as const
    };

    const [workReport, duplicateWorkReport, technology] = await Promise.all([
      controller.generateFromMessage({
        ...shared,
        presentationTemplate: 'work_report'
      }),
      controller.generateFromMessage({
        ...shared,
        presentationTemplate: 'work_report'
      }),
      controller.generateFromMessage({
        ...shared,
        presentationTemplate: 'technology'
      })
    ]);

    expect(workReport).toEqual(duplicateWorkReport);
    expect(workReport.ok).toBe(true);
    expect(technology.ok).toBe(true);
    if (!workReport.ok || !technology.ok) return;
    expect(workReport.value.workId).not.toBe(technology.value.workId);
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect(await works.list(toProjectId('doc-ipc-project'))).toHaveLength(2);
  }, 15_000);

  it('cancels the matching active message generation idempotently', async () => {
    let markTemporaryWritten!: () => void;
    let releaseGeneration!: () => void;
    const temporaryWritten = new Promise<void>((resolve) => {
      markTemporaryWritten = resolve;
    });
    const generationReleased = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const { controller, conversationId, now, repository, rootDirectory } =
      await createEnvironment({
        runnerOptions: {
          generateTemporaryFile: async (input) => {
            const generated = await generateDocumentFile(input);
            const temporaryPath = `${generated.absolutePath}.tmp`;
            await rename(generated.absolutePath, temporaryPath);
            markTemporaryWritten();
            await generationReleased;
            return {
              fileName: generated.fileName,
              temporaryPath,
              finalPath: generated.absolutePath,
              sizeBytes: generated.sizeBytes
            };
          }
        }
      });
    const messageId = 'message-cancel-generation';
    const conversation = await storeCompletedAssistantMessage({
      conversationId,
      messageId,
      now,
      repository,
      content: JSON.stringify({
        kind: 'ppt',
        title: '取消验证',
        sections: [
          {
            heading: '执行中取消',
            level: 1,
            blocks: [{ type: 'bullets', items: ['状态：等待取消。'] }]
          }
        ]
      })
    });
    const request = {
      conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt' as const,
      presentationTemplate: 'technology' as const
    };
    const generation = controller.generateFromMessage(request);
    await temporaryWritten;

    const cancelled = await controller.cancelGeneration({
      conversationId,
      expectedRevision: conversation.revision,
      messageId
    });
    expect(cancelled).toEqual({ ok: true, value: { cancelled: true } });
    releaseGeneration();
    const generationResult = await generation;
    expect(generationResult).toEqual({
      ok: false,
      error: {
        code: 'generation_cancelled',
        message: 'Document generation was cancelled'
      }
    });

    const repeated = await controller.cancelGeneration({
      conversationId,
      expectedRevision: conversation.revision,
      messageId
    });
    expect(repeated).toEqual({ ok: true, value: { cancelled: false } });
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    expect(await works.list(toProjectId('doc-ipc-project'))).toEqual([]);
  });

  it('does not report cancellation after the document work has been registered', async () => {
    let controller!: DocumentGenerationController;
    let conversationId = '';
    let expectedRevision = 0;
    let cancellation: ReturnType<
      DocumentGenerationController['cancelGeneration']
    > | undefined;
    const environment = await createEnvironment({
      onLoadConversation: (count) => {
        if (count === 4) {
          cancellation = controller.cancelGeneration({
            conversationId,
            expectedRevision,
            messageId: 'message-after-work-registration'
          });
        }
      }
    });
    controller = environment.controller;
    const messageId = 'message-after-work-registration';
    const conversation = await storeCompletedAssistantMessage({
      conversationId: environment.conversationId,
      messageId,
      now: environment.now,
      repository: environment.repository,
      content: JSON.stringify({
        kind: 'ppt',
        title: '取消边界验证',
        sections: [
          {
            heading: '作品登记后继续挂接',
            level: 1,
            blocks: [{ type: 'bullets', items: ['已登记作品不再接受取消'] }]
          }
        ]
      })
    });
    conversationId = environment.conversationId;
    expectedRevision = conversation.revision;

    const generation = await controller.generateFromMessage({
      conversationId: environment.conversationId,
      expectedRevision: conversation.revision,
      messageId,
      kind: 'ppt',
      presentationTemplate: 'work_report'
    });

    if (!cancellation) throw new Error('cancellation was not attempted');
    expect(await cancellation).toEqual({ ok: true, value: { cancelled: false } });
    expect(generation.ok).toBe(true);
  });
});
