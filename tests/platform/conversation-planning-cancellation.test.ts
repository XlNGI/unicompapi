import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationApplicationService, ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { toConversationId, toMessageId, toProjectId, toConversationWorkflowId } from '../../src/domain';
import { ConversationWorkflowController, JsonConversationWorkflowRepository, JsonProjectConversationRepository, NodeProjectStorage,
  type StorageProjectSession } from '../../src/platform';
import type { ConversationWorkflowControllerRuntime } from '../../src/platform/ipc/conversation-workflow-controller';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(ready?: Promise<void>, attachments?: ConversationWorkflowControllerRuntime['attachments']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-planning-cancel-'));
  roots.push(root);
  const projectId = toProjectId('planning-project');
  let session: StorageProjectSession = { projectId, projectName: 'Planning', rootDirectory: root };
  const storage = new NodeProjectStorage(root);
  const conversations = new JsonProjectConversationRepository(storage, projectId);
  const workflows = new JsonConversationWorkflowRepository(storage, projectId);
  let id = 0;
  const conversationService = new ConversationApplicationService(conversations, {
    nextConversationId: () => toConversationId(`planning-conversation-${++id}`), nextMessageId: () => toMessageId(`planning-message-${++id}`)
  });
  const orchestrator = new ConversationIntentOrchestrator();
  const workflowService = new ConversationWorkflowService(workflows, orchestrator);
  const controller = new ConversationWorkflowController({ getSession: () => session,
    getRuntime: () => ({ conversationService, workflowService, ready, attachments }) });
  return { controller, orchestrator, workflows, conversations, workflowService, setSession: (next: StorageProjectSession) => { session = next; }, session };
}
const request = { clientCommandId: 'planning-command', conversation: null, title: '报告', content: '做一份 Word 报告',
  semanticCandidate: { candidateId: 'selected-route', productFeature: 'text_chat' as const } };

describe('planning cancellation IPC controller', () => {
  it('prepares attachment summaries inside the ready planning operation and cancels the already saved plan', async () => {
    const entered = deferred<void>();
    const prepareSummary = vi.fn<NonNullable<NonNullable<ConversationWorkflowControllerRuntime['attachments']>['prepareSummary']>>().mockImplementation(async (input) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('summary cancelled')), { once: true }));
    });
    const f = await fixture(undefined, { pin: async () => [], prepareSummary });
    const pending = f.controller.start({ ...request, content: '总结附件并做一份 Word 报告', semanticCandidate: { candidateId: 'selected-route', productFeature: 'text_chat' } });
    await entered.promise;
    expect((await f.workflows.list())[0].status).toBe('ready');
    expect(prepareSummary.mock.calls[0][0]).toMatchObject({ query: '总结附件并做一份 Word 报告', selection: { candidateId: 'selected-route' } });
    await f.controller.cancelPlanning({ clientCommandId: request.clientCommandId });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'planning_cancelled' } });
    expect((await f.workflows.list())[0].status).toBe('cancelled');
  });

  it('prepares summaries when a clarification produces a ready workflow', async () => {
    const prepareSummary = vi.fn(async () => undefined);
    const f = await fixture(undefined, { pin: async () => [], prepareSummary });
    const started = await f.controller.start({ ...request, content: '帮我做个总结' });
    if (!started.ok) throw new Error(started.error.message);
    expect(prepareSummary).not.toHaveBeenCalled();
    const answered = await f.controller.answer({ clientCommandId: 'summary-answer-command', workflowId: started.value.workflow.workflowId,
      semanticCandidate: request.semanticCandidate,
      expectedWorkflowRevision: started.value.workflow.revision, expectedConversationRevision: started.value.conversation.revision, content: '做一份 Word 报告' });
    expect(answered).toMatchObject({ ok: true, value: { workflow: { status: 'ready' } } });
    expect(prepareSummary).toHaveBeenCalledOnce();
  });

  it('cancels only a command in the current project and rejects a late classifier plan before saving it', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = f.orchestrator.analyze.bind(f.orchestrator);
    vi.spyOn(f.orchestrator, 'analyze').mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return original({ ...input, signal: undefined });
    });
    const pending = f.controller.start(request);
    await entered.promise;
    f.setSession({ ...f.session, projectId: toProjectId('another-project') });
    await expect(f.controller.cancelPlanning({ clientCommandId: request.clientCommandId })).resolves.toEqual({ ok: true, value: { cancelled: false } });
    f.setSession(f.session);
    await expect(f.controller.cancelPlanning({ clientCommandId: request.clientCommandId })).resolves.toEqual({ ok: true, value: { cancelled: true } });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'planning_cancelled' } });
    expect(await f.workflows.list()).toEqual([]);
    expect((await f.conversations.list())[0].messages.every((message) => message.role === 'user')).toBe(true);
  });

  it('cancels a plan when cancellation races the completed repository write', async () => {
    const f = await fixture();
    const saved = deferred<void>();
    const release = deferred<void>();
    const original = f.workflows.createSupersedingPending.bind(f.workflows);
    vi.spyOn(f.workflows, 'createSupersedingPending').mockImplementation(async (workflow) => {
      await original(workflow);
      saved.resolve();
      await release.promise;
    });
    const pending = f.controller.start(request);
    await saved.promise;
    await f.controller.cancelPlanning({ clientCommandId: request.clientCommandId });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'planning_cancelled' } });
    expect((await f.workflows.list())[0].status).toBe('cancelled');
  });

  it('stops a pending clarification during shutdown and keeps the prior plan unexecuted', async () => {
    const f = await fixture();
    const started = await f.controller.start({ ...request, content: '帮我做个总结' });
    if (!started.ok) throw new Error(started.error.message);
    const entered = deferred<void>();
    vi.spyOn(f.orchestrator, 'analyze').mockImplementation(async (input) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      throw new Error('unreachable');
    });
    const pending = f.controller.answer({ clientCommandId: 'answer-command', workflowId: started.value.workflow.workflowId,
      semanticCandidate: request.semanticCandidate,
      expectedWorkflowRevision: started.value.workflow.revision, expectedConversationRevision: started.value.conversation.revision, content: '做 PPT' });
    await entered.promise;
    expect(f.controller.cancelActivePlanning()).toBe(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'planning_cancelled' } });
    expect((await f.workflows.get(toConversationWorkflowId(started.value.workflow.workflowId)))?.status).toBe('needs_clarification');
  });

  it('waits for recovery before reading pending workflows while cancellation remains available', async () => {
    const ready = deferred<void>();
    const f = await fixture(ready.promise);
    const getPending = vi.spyOn(f.workflowService, 'getPending');
    const reading = f.controller.getPending({ conversationId: 'not-yet-loaded' });
    const starting = f.controller.start(request);
    await f.controller.cancelPlanning({ clientCommandId: request.clientCommandId });
    expect(getPending).not.toHaveBeenCalled();
    ready.resolve();
    await reading;
    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'planning_cancelled' } });
    expect(await f.conversations.list()).toEqual([]);
  });
});
