import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyConversationExecutionCompletion, attachConversationAgentRunExecution, createConversationAgentRun,
  createConversationResponseExecution, createConversationResponseStreamEvent, evaluateConversationExecutionCompletion,
  toConnectionId, toConversationAgentRunId, toConversationId, toConversationResponseDraftId,
  toConversationResponseExecutionId, toConversationResponseStreamEventId, toIsoTimestamp, toMessageId,
  toModelId, toProjectId, toProtocolBindingId, toProviderExecutionRouteSnapshotId, toProviderId,
  toProviderInvocationAttemptId
} from '../../src/domain';
import { ConversationCompletionCoordinator, type ConversationCompletionIntent } from '../../src/application/conversation-completion-coordinator';
import { JsonConversationCompletionJournal, parseCompletionIntent } from '../../src/platform/repositories/json-conversation-completion-journal';
import { JsonConversationAgentRunRepository } from '../../src/platform/repositories/json-conversation-agent-run-repository';
import { JsonConversationResponseExecutionRepository } from '../../src/platform/repositories/json-conversation-response-execution-repository';
import { JsonDocumentTaskRuntimeRepository } from '../../src/platform/repositories/json-document-task-runtime-repository';
import { NodeProjectStorage, ProjectMetadataUnitOfWork, type AtomicJsonWriteEvent } from '../../src/platform/storage';

const roots: string[] = [];
const projectId = toProjectId('completion-journal-project');
const conversationId = toConversationId('completion-journal-conversation');
const sourceMessageId = toMessageId('completion-journal-user');
const responseId = toConversationResponseExecutionId('completion-journal-response');
const t0 = toIsoTimestamp('2026-10-03T12:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-03T12:01:00.000Z');

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function intent(id = responseId): ConversationCompletionIntent {
  const run = attachConversationAgentRunExecution(createConversationAgentRun({
    id: toConversationAgentRunId(`completion-journal-run-${id}`), projectId, conversationId, sourceMessageId,
    createdAt: t0
  }), id, t0);
  const decision = evaluateConversationExecutionCompletion({ run, response: {
    id, projectId, conversationId, sourceMessageId, state: 'completed'
  } });
  return { schemaVersion: 1, revision: 0, responseExecutionId: id, expectedRunRevision: run.revision,
    targetRun: applyConversationExecutionCompletion(run, decision, t1), decision, responseState: 'completed',
    taskRevisions: [], stage: 'prepared', createdAt: t1, updatedAt: t1 };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-completion-wal-'));
  roots.push(root);
  let fault: ((event: AtomicJsonWriteEvent) => void) | undefined;
  const storage = new NodeProjectStorage(root, { onAtomicWriteStage: event => fault?.(event) });
  const journal = new JsonConversationCompletionJournal(storage, projectId, () => t1);
  return { root, storage, journal, setFault: (next?: (event: AtomicJsonWriteEvent) => void) => { fault = next; } };
}

async function persistentCoordinatorFixture() {
  const f = await fixture();
  const agentRuns = new JsonConversationAgentRunRepository(f.storage, projectId, () => t1);
  const responseExecutions = new JsonConversationResponseExecutionRepository(f.storage, projectId);
  const documentTasks = new JsonDocumentTaskRuntimeRepository(f.storage, projectId, () => t1);
  const original = createConversationAgentRun({ id: intent().targetRun.id, projectId, conversationId,
    sourceMessageId, createdAt: t0 });
  await agentRuns.create(original);
  const bound = attachConversationAgentRunExecution(original, responseId, t0);
  await agentRuns.save(bound, original.revision);
  const response = createConversationResponseExecution({ id: responseId, projectId,
    providerInvocationAttemptId: toProviderInvocationAttemptId('completion-journal-attempt'), createdAt: t0,
    snapshot: {
      schemaVersion: 1, responseDraftId: toConversationResponseDraftId('completion-journal-draft'), responseDraftRevision: 0,
      conversationId, conversationRevision: 2, userMessageId: sourceMessageId, userMessageRevision: 1,
      assistantMessageId: toMessageId('completion-journal-assistant'), productFeature: 'text_chat',
      routeSnapshotId: toProviderExecutionRouteSnapshotId('completion-journal-route'), outboundUserTextSnapshot: '测试完成结算',
      contextSnapshots: [], candidate: { schemaVersion: 1, providerId: toProviderId('completion-journal-provider'),
        connectionId: toConnectionId('completion-journal-connection'), connectionRevision: 1,
        modelId: toModelId('completion-journal-model'), modelRevision: 1, profileId: 'test-profile', profileRevision: 1,
        protocolBindingId: toProtocolBindingId('completion-journal-binding'), protocolBindingRevision: 1, runtimeSource: 'official_direct' }
    }
  });
  await responseExecutions.create(response, createConversationResponseStreamEvent({
    id: toConversationResponseStreamEventId('completion-journal-event-1'), responseExecutionId: responseId,
    sequence: 1, type: 'execution_created', occurredAt: t0
  }));
  await responseExecutions.appendEvents([
    createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('completion-journal-event-2'),
      responseExecutionId: responseId, sequence: 2, type: 'stream_started', occurredAt: t0 }),
    createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('completion-journal-event-3'),
      responseExecutionId: responseId, sequence: 3, type: 'content_delta', contentDelta: '已核对本地结果。', occurredAt: t1 }),
    createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('completion-journal-event-4'),
      responseExecutionId: responseId, sequence: 4, type: 'stream_completed', occurredAt: t1 })
  ]);
  const projectTerminal = vi.fn(async () => {
    const unit = new ProjectMetadataUnitOfWork(f.storage, () => t1);
    const loaded = await unit.load();
    if (loaded.document.entries.some(entry => entry.key === 'completion.test-projection')) return;
    await unit.transact(loaded.document.revision, draft => draft.set('completion.test-projection', true));
  });
  const options = { agentRuns, responseExecutions, documentTasks, journal: f.journal,
    collectFacts: async () => ({}), projectTerminal, now: () => t1 };
  return { ...f, agentRuns, responseExecutions, documentTasks, projectTerminal, options,
    coordinator: new ConversationCompletionCoordinator(options), bound };
}

describe('JsonConversationCompletionJournal', () => {
  it('persists an isolated CAS intent and rejects stale journal writes', async () => {
    const f = await fixture();
    const prepared = intent();
    await f.journal.save(prepared, null);
    const reopened = new JsonConversationCompletionJournal(new NodeProjectStorage(f.root), projectId, () => t1);
    expect(await reopened.get(responseId)).toEqual(prepared);
    const applied = { ...prepared, stage: 'applied' as const, revision: 1 };
    await reopened.save(applied, 0);
    await expect(f.journal.save({ ...prepared, stage: 'run_applied', revision: 1 }, 0)).rejects.toThrow();
    expect(await reopened.listPending()).toEqual([]);
  });

  it('preserves unrelated project metadata and concurrently prepared decisions through bounded metadata CAS', async () => {
    const f = await fixture();
    const unit = new ProjectMetadataUnitOfWork(f.storage, () => t1);
    await unit.transact(0, draft => draft.set('existing.registration', { knownWork: true }));
    const one = intent();
    const two = intent(toConversationResponseExecutionId('completion-journal-response-two'));
    await Promise.all([f.journal.save(one, null), f.journal.save(two, null)]);
    const loaded = await unit.load();
    expect(loaded.document.entries.find(entry => entry.key === 'existing.registration')?.value).toEqual({ knownWork: true });
    expect(await f.journal.listPending()).toHaveLength(2);
  });

  it('refuses backup journal authority after loss of the primary rather than replaying an old decision', async () => {
    const f = await fixture();
    await f.journal.save(intent(), null);
    await f.journal.save({ ...intent(), revision: 1, stage: 'run_applied' }, 0);
    await rm(path.join(f.root, 'entities/project-metadata.json'));
    await expect(f.journal.get(responseId)).rejects.toThrow('requires reconciliation');
    await expect(f.journal.save({ ...intent(), revision: 2, stage: 'applied' }, 1)).rejects.toThrow('requires reconciliation');
    expect(await readFile(path.join(f.root, 'entities/project-metadata.json.bak'), 'utf8')).toContain('prepared');
  });

  it('rejects malformed, cross-project, replay-enabled and content-bearing journal facts', () => {
    expect(() => parseCompletionIntent({ ...intent(), rawPrompt: 'untrusted attachment' }, projectId)).toThrow();
    expect(() => parseCompletionIntent({ ...intent(), targetRun: { ...intent().targetRun, projectId: toProjectId('other') } }, projectId)).toThrow();
    expect(() => parseCompletionIntent({ ...intent(), decision: { ...intent().decision, canReplay: true } }, projectId)).toThrow();
    expect(() => parseCompletionIntent({ ...intent(), taskRevisions: [{ id: 'task', revision: -1 }] }, projectId)).toThrow();
    expect(() => parseCompletionIntent({ ...intent(), freezeOrigin: 'local_projection' }, projectId)).toThrow();
    expect(() => parseCompletionIntent({ ...intent(), freezeOrigin: 'local_projection', failureStage: 'evidence' }, projectId)).toThrow();
    expect(() => parseCompletionIntent({ ...intent(), freezeOrigin: 'external', failureStage: 'projection' }, projectId)).toThrow();
  });

  it.each([undefined, 'unknown_result'] as const)('does not relabel a legacy or true unknown WAL as a retryable projection (%s)', async origin => {
    const f = await fixture();
    const frozen: ConversationCompletionIntent = { ...intent(), stage: 'needs_reconciliation',
      ...(origin ? { freezeOrigin: origin, failureStage: 'facts' } : {}) };
    await f.journal.save(frozen, null);
    await expect(f.journal.save({ ...frozen, revision: 1, freezeOrigin: 'local_projection', failureStage: 'projection' }, 0)).rejects.toThrow();
    expect((await f.journal.get(responseId))?.freezeOrigin).toBe(origin);
  });

  it('retains a prepared primary when rename succeeded but acknowledgement was lost', async () => {
    const f = await fixture();
    f.setFault(event => {
      if (event.stage === 'after_replace' && event.targetPath.endsWith('project-metadata.json')) throw new Error('ack_lost');
    });
    await expect(f.journal.save(intent(), null)).rejects.toThrow('ack_lost');
    f.setFault();
    const reopened = new JsonConversationCompletionJournal(new NodeProjectStorage(f.root), projectId, () => t1);
    expect(await reopened.get(responseId)).toEqual(intent());
  });

  it('leaves no authoritative journal when interruption occurred before replacement', async () => {
    const f = await fixture();
    f.setFault(event => {
      if (event.stage === 'before_replace' && event.targetPath.endsWith('project-metadata.json')) throw new Error('before_commit');
    });
    await expect(f.journal.save(intent(), null)).rejects.toThrow('before_commit');
    f.setFault();
    expect(await f.journal.get(responseId)).toBeUndefined();
  });

  it('keeps corrupt primary and backup read-only for reconciliation', async () => {
    const f = await fixture();
    await f.journal.save(intent(), null);
    await f.journal.save({ ...intent(), revision: 1, stage: 'run_applied' }, 0);
    await writeFile(path.join(f.root, 'entities/project-metadata.json'), '{broken-primary');
    await expect(f.journal.listPending()).rejects.toThrow('requires reconciliation');
    expect(await readFile(path.join(f.root, 'entities/project-metadata.json'), 'utf8')).toBe('{broken-primary');
  });
});

describe('persistent completion WAL integration', () => {
  it('reopens a prepare-only crash and settles only local projections against the same Response and Run', async () => {
    const f = await persistentCoordinatorFixture();
    await f.journal.save(intent(), null);
    const reopened = new ConversationCompletionCoordinator(f.options);
    expect(await reopened.reconcilePending()).toBe(1);
    expect((await f.agentRuns.get(f.bound.id))?.status).toBe('completed');
    expect((await f.journal.get(responseId))?.stage).toBe('applied');
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
    expect((await f.responseExecutions.listEvents(responseId))).toHaveLength(4);
  });

  it('confirms a real post-rename Run acknowledgement failure from the primary record', async () => {
    const f = await persistentCoordinatorFixture();
    f.setFault(event => {
      if (event.stage === 'after_replace' && event.targetPath.endsWith('conversation-agent-runs.json')) {
        f.setFault();
        throw new Error('run_ack_lost');
      }
    });
    await f.coordinator.settle(responseId);
    expect((await f.agentRuns.get(f.bound.id))?.status).toBe('completed');
    expect((await f.journal.get(responseId))?.stage).toBe('applied');
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
  });

  it('explicitly settles failed pre-commit Run CAS after reopen and retains the accepted local delivery receipt', async () => {
    const f = await persistentCoordinatorFixture();
    f.setFault(event => {
      if (event.stage === 'before_replace' && event.targetPath.endsWith('conversation-agent-runs.json')) {
        f.setFault();
        throw new Error('run_commit_failed');
      }
    });
    await expect(f.coordinator.settle(responseId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect((await f.agentRuns.get(f.bound.id))?.status).toBe('needs_reconciliation');
    expect(await f.journal.get(responseId)).toMatchObject({ stage: 'needs_reconciliation', freezeOrigin: 'local_projection', failureStage: 'run_commit' });
    const loaded = await new ProjectMetadataUnitOfWork(f.storage, () => t1).load();
    expect(loaded.document.entries.find(entry => entry.key === 'completion.test-projection')?.value).toBe(true);
    const reopened = new ConversationCompletionCoordinator(f.options);
    await reopened.reconcile(responseId);
    expect(f.projectTerminal).toHaveBeenCalledTimes(2);
    expect(await reopened.canStartNewResponse(conversationId)).toBe(true);
    expect(await f.agentRuns.get(f.bound.id)).toMatchObject({ status: 'completed', reconciliationReason: 'unknown_result',
      reconciliationAcknowledgement: { kind: 'closed_without_replay' } });
    expect((await f.responseExecutions.listEvents(responseId))).toHaveLength(4);
  });

  it('reopens a local projection failure without automatically clearing it, then explicitly settles the same known response', async () => {
    const f = await persistentCoordinatorFixture();
    f.projectTerminal.mockRejectedValueOnce(new Error('local_delivery_unavailable'));
    await expect(f.coordinator.settle(responseId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    expect(await f.journal.get(responseId)).toMatchObject({ freezeOrigin: 'local_projection', failureStage: 'projection' });
    const reopened = new ConversationCompletionCoordinator(f.options);
    expect(await reopened.reconcilePending()).toBe(0);
    expect(f.projectTerminal).toHaveBeenCalledTimes(1);
    await reopened.reconcile(responseId);
    expect(f.projectTerminal).toHaveBeenCalledTimes(2);
    expect((await f.agentRuns.get(f.bound.id))?.status).toBe('completed');
    expect((await f.journal.get(responseId))?.stage).toBe('applied');
    expect((await f.responseExecutions.listEvents(responseId))).toHaveLength(4);
  });

  it('settles only local projections after a failed final WAL replacement, without overwriting the committed terminal parent', async () => {
    const f = await persistentCoordinatorFixture();
    let metadataWrites = 0;
    f.setFault(event => {
      if (event.stage !== 'before_replace' || !event.targetPath.endsWith('project-metadata.json')) return;
      metadataWrites += 1;
      if (metadataWrites === 4) { f.setFault(); throw new Error('final_wal_unavailable'); }
    });
    await expect(f.coordinator.settle(responseId)).rejects.toMatchObject({ code: 'settlement_unknown' });
    const committed = await f.agentRuns.get(f.bound.id);
    expect(committed?.status).toBe('completed');
    expect(await f.journal.get(responseId)).toMatchObject({ freezeOrigin: 'local_projection', failureStage: 'wal_commit', stage: 'needs_reconciliation' });
    const reopened = new ConversationCompletionCoordinator(f.options);
    await reopened.reconcile(responseId);
    expect(await f.agentRuns.get(f.bound.id)).toEqual(committed);
    expect((await f.journal.get(responseId))?.stage).toBe('applied');
    expect(await reopened.canStartNewResponse(conversationId)).toBe(true);
  });

  it('persists an explicit no-replay acknowledgement and reopens without restoring the old unknown call', async () => {
    const f = await persistentCoordinatorFixture();
    await f.coordinator.settle(responseId, { unknownResult: true });
    const snapshot = await f.coordinator.inspect(responseId);
    expect(snapshot?.run.status).toBe('needs_reconciliation');
    await f.coordinator.acknowledge(responseId, snapshot!.run.revision, snapshot!.intent!.revision, snapshot!.taskRevisions);
    const reopened = new ConversationCompletionCoordinator(f.options);
    const closed = await reopened.inspect(responseId);
    expect(closed?.run.status).toBe('cancelled');
    expect(closed?.run.reconciliationReason).toBe('unknown_result');
    expect(closed?.run.reconciliationAcknowledgement?.kind).toBe('closed_without_replay');
    expect(closed?.intent?.stage).toBe('acknowledged');
    expect(await reopened.canStartNewResponse(conversationId)).toBe(true);
    const eventCount = (await f.responseExecutions.listEvents(responseId)).length;
    await reopened.settle(responseId);
    expect((await f.responseExecutions.listEvents(responseId))).toHaveLength(eventCount);
    expect((await f.journal.get(responseId))?.stage).toBe('acknowledged');
  });

  it('keeps acknowledgement pending when its final WAL acknowledgement is lost and requires a fresh revision', async () => {
    const f = await persistentCoordinatorFixture();
    await f.coordinator.settle(responseId, { unknownResult: true });
    const snapshot = await f.coordinator.inspect(responseId);
    let metadataPrimaryWrites = 0;
    f.setFault(event => {
      if (event.stage !== 'before_replace' || !event.targetPath.endsWith('project-metadata.json')) return;
      metadataPrimaryWrites += 1;
      if (metadataPrimaryWrites === 2) { f.setFault(); throw new Error('ack_closure_write_failed'); }
    });
    await expect(f.coordinator.acknowledge(responseId, snapshot!.run.revision, snapshot!.intent!.revision)).rejects
      .toMatchObject({ code: 'settlement_unknown' });
    expect((await f.agentRuns.get(f.bound.id))?.reconciliationAcknowledgement?.kind).toBe('closed_without_replay');
    expect((await f.journal.get(responseId))?.stage).toBe('needs_reconciliation');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(false);
    await expect(f.coordinator.acknowledge(responseId, snapshot!.run.revision, snapshot!.intent!.revision)).rejects
      .toMatchObject({ code: 'entity_conflict' });
    const refreshed = await f.coordinator.inspect(responseId);
    await f.coordinator.acknowledge(responseId, refreshed!.run.revision, refreshed!.intent!.revision, refreshed!.taskRevisions);
    expect((await f.journal.get(responseId))?.stage).toBe('acknowledged');
    expect(await f.coordinator.canStartNewResponse(conversationId)).toBe(true);
  });
});
