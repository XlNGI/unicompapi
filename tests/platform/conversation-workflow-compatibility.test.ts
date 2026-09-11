import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { parseConversationWorkflow, toConversationId, toMessageId, toProjectId } from '../../src/domain';
import { createChatContextRuntime } from '../../src/platform/ipc/chat-context-runtime';
import { JsonConversationWorkflowRepository } from '../../src/platform/repositories';
import { NodeProjectStorage, projectStoragePaths } from '../../src/platform/storage';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-compatibility-'));
  roots.push(root);
  const projectId = toProjectId('project-compatibility');
  const conversationId = toConversationId('conversation-compatibility');
  const storage = new NodeProjectStorage(root);
  const repository = new JsonConversationWorkflowRepository(storage, projectId);
  const service = new ConversationWorkflowService(repository, new ConversationIntentOrchestrator());
  const original = await service.create({ projectId, conversationId,
    sourceMessageId: toMessageId('message-compatibility'), rawText: '你好' });
  const documentCommand = { action: 'recreate', requestText: '重新创建一份测试演示文稿', candidates: [], stage: 'choose_target' };
  const legacy = { ...original, status: 'ready', documentCommand };
  const document = { schemaVersion: 1, revision: 1, updatedAt: original.updatedAt, workflows: [legacy] };
  await storage.writeJsonAtomically(projectStoragePaths.entities.conversationWorkflows, document);
  return { root, projectId, conversationId, storage, repository, service, original, legacy, document, documentCommand };
}

describe('retired document command compatibility', () => {
  it('opens the project without executing a retired selector or rewriting its data during reads', async () => {
    const f = await fixture();
    const file = path.join(f.root, projectStoragePaths.entities.conversationWorkflows);
    const before = await readFile(file, 'utf8');
    const runtime = createChatContextRuntime({ userDataDirectory: path.join(f.root, 'isolated-user-data'),
      getSession: () => ({ projectId: f.projectId, projectName: '兼容性测试', rootDirectory: f.root }) });
    expect(await runtime.conversations.list({ includeArchived: false, includeDeleted: false })).toEqual({ ok: true, value: [] });
    expect(await runtime.workflows.getPending({ conversationId: f.conversationId })).toEqual({ ok: true, value: null });
    expect(await f.repository.get(f.original.id)).toMatchObject({ status: 'cancelled', documentCommand: f.documentCommand });
    await expect(f.service.beginExecution({ workflowId: f.original.id,
      expectedRevision: f.original.revision, executionId: 'must-not-start' })).rejects.toMatchObject({ code: 'workflow_not_ready' });
    await runtime.waitForMutations();
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('preserves the retired request and other workflows through new writes and reopen', async () => {
    const f = await fixture();
    await f.service.create({ projectId: f.projectId, conversationId: f.conversationId,
      sourceMessageId: toMessageId('message-next'), rawText: '制作关于项目总结的 PPT' });
    const reopened = new JsonConversationWorkflowRepository(new NodeProjectStorage(f.root), f.projectId);
    expect(await reopened.list()).toHaveLength(2);
    expect(await reopened.get(f.original.id)).toMatchObject({ status: 'cancelled', documentCommand: f.documentCommand });
    const persisted = await f.storage.readJson<{ workflows: unknown[] }>(projectStoragePaths.entities.conversationWorkflows);
    expect(persisted?.workflows).toContainEqual(expect.objectContaining({ id: f.original.id,
      status: 'cancelled', documentCommand: f.documentCommand }));
  });

  it('reads the retired draft from a valid backup without overwriting the primary', async () => {
    const f = await fixture();
    await f.storage.writeJsonAtomically(projectStoragePaths.entities.conversationWorkflows,
      { malformed: true }, { backup: true });
    const file = path.join(f.root, projectStoragePaths.entities.conversationWorkflows);
    const before = await readFile(file, 'utf8');
    expect(await f.repository.get(f.original.id)).toMatchObject({ status: 'cancelled', documentCommand: f.documentCommand });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it.each([
    { documentCommand: { action: 'delete', requestText: '删除', candidates: [], stage: 'choose_target' } },
    { documentCommand: { action: 'recreate', requestText: '重建', candidates: ['unverified-target'], stage: 'choose_target' } },
    { documentCommand: { action: 'recreate', requestText: '重建', candidates: [], stage: 'execute' } },
    { documentCommand: { action: 'recreate', requestText: '重建', candidates: [], stage: 'choose_target', path: 'untrusted' } },
    { executionId: 'unverified-execution' },
    { status: 'executing' },
    { unsupported: true }
  ])('rejects unknown or executable legacy shapes without dropping data: %j', async (changes) => {
    const f = await fixture();
    const invalid = { ...f.legacy, ...changes };
    expect(() => parseConversationWorkflow(invalid)).toThrow(TypeError);
    await f.storage.writeJsonAtomically(projectStoragePaths.entities.conversationWorkflows,
      { ...f.document, workflows: [invalid] });
    const file = path.join(f.root, projectStoragePaths.entities.conversationWorkflows);
    const before = await readFile(file, 'utf8');
    await expect(f.repository.list()).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
