import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationApplicationService,
  ConversationStreamingService
} from '../../src/application';
import {
  toConversationId,
  toMessageId,
  toProjectId,
  toWorkId
} from '../../src/domain';
import {
  DocumentGenerationController,
  DocumentGenerationRunner,
  JsonProjectConversationRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  type StorageProjectSession
} from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createEnvironment() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-doc-ipc-'));
  temporaryRoots.push(rootDirectory);
  const projectId = toProjectId('doc-ipc-project');
  const now = () => '2026-08-22T10:00:00.000Z';
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
  const controller = new DocumentGenerationController({
    getSession: () => session,
    getStreaming: () => new ConversationStreamingService(repository, ids, now),
    getRunner: () =>
      new DocumentGenerationRunner({
        rootDirectory,
        projectId,
        now,
        createId: () => `id-${Math.random()}`
      }),
    openPath: async (absolutePath) => {
      openedPaths.push(absolutePath);
      return '';
    },
    now,
    createId: () => `id-${Math.random()}`
  });
  const created = await application.create({
    title: '周报生成',
    projectId
  });
  return {
    conversationId: created.id,
    controller,
    openedPaths,
    repository,
    rootDirectory,
    session
  };
}

function outlineJson() {
  return JSON.stringify({
    kind: 'word',
    title: '项目周报',
    sections: [
      {
        heading: '本周进展',
        level: 1,
        blocks: [{ type: 'bullets', items: ['完成方案评审'] }]
      }
    ]
  });
}

describe('document generation controller', () => {
  it('generates a document and completes the assistant message with a result', async () => {
    const { controller, conversationId, repository, rootDirectory } =
      await createEnvironment();
    const result = await controller.generateFromConversation({
      conversationId,
      expectedRevision: 0,
      kind: 'word',
      title: '项目周报',
      outlineJson: outlineJson(),
      contentFingerprint: 'd'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-1'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('generation failed');
    expect(result.value.workId).toMatch(/^work-document-/);
    expect(result.value.fileName.endsWith('.docx')).toBe(true);

    const conversation = await repository.get(toConversationId(conversationId));
    const message = conversation?.messages.find(
      (item) => item.id === result.value.messageId
    );
    expect(message?.state).toBe('completed');
    if (message?.state !== 'completed') throw new Error('message not completed');
    expect(message.documentResult?.workId).toBe(result.value.workId);
    expect(message.content).toContain('本周进展');

    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      toProjectId('doc-ipc-project')
    );
    const work = await works.get(toWorkId(result.value.workId));
    expect(work?.mediaKind).toBe('document');
  });

  it('rejects invalid outline JSON', async () => {
    const { controller, conversationId } = await createEnvironment();
    const result = await controller.generateFromConversation({
      conversationId,
      expectedRevision: 0,
      kind: 'word',
      title: '项目周报',
      outlineJson: '{bad json',
      contentFingerprint: 'd'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-1'
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('invalid_outline');
  });

  it('rejects stale revisions', async () => {
    const { controller, conversationId } = await createEnvironment();
    const result = await controller.generateFromConversation({
      conversationId,
      expectedRevision: 99,
      kind: 'word',
      title: '项目周报',
      outlineJson: outlineJson(),
      contentFingerprint: 'd'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-1'
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('revision_conflict');
  });

  it('opens the registered document file', async () => {
    const { controller, conversationId, openedPaths } = await createEnvironment();
    const result = await controller.generateFromConversation({
      conversationId,
      expectedRevision: 0,
      kind: 'word',
      title: '项目周报',
      outlineJson: outlineJson(),
      contentFingerprint: 'd'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-1'
    });
    if (!result.ok) throw new Error('generation failed');
    const opened = await controller.openDocument({ workId: result.value.workId });
    expect(opened.ok).toBe(true);
    expect(openedPaths).toHaveLength(1);
    expect(openedPaths[0]).toContain('files');
    expect(openedPaths[0]).toContain('documents');
  });
});
