import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversationAgentRuntime, updateConversationAgentRuntime,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toIsoTimestamp, toMessageId, toProjectId, toWorkId,
  type ConversationAgentRuntimeEventV1, type ConversationAgentRuntimeV1
} from '../../src/domain';
import { JsonConversationAgentRuntimeRepository, ConversationAgentRuntimeRevisionConflictError } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { NodeProjectStorage, ProjectMetadataUnitOfWork } from '../../src/platform/storage';

const roots: string[] = [];
const projectId = toProjectId('project-parent-runtime');
const t0 = toIsoTimestamp('2026-10-03T11:00:00.000Z'), t1 = toIsoTimestamp('2026-10-03T11:00:01.000Z');
const digest = 'a'.repeat(64);
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-parent-runtime-')) throw new Error('Unsafe test cleanup target');
    await rm(root, { recursive: true, force: true });
  }));
});
async function setup(options?: ConstructorParameters<typeof NodeProjectStorage>[1]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-parent-runtime-')); roots.push(root);
  const storage = new NodeProjectStorage(root, options);
  const repository = new JsonConversationAgentRuntimeRepository(storage, projectId, () => t1);
  return { root, storage, repository };
}
function initial(runSuffix = '') {
  return createConversationAgentRuntime({ runId: toConversationAgentRunId(`run-parent${runSuffix}`), projectId,
    conversationId: toConversationId('conversation-parent'), sourceMessageId: toMessageId('message-parent'),
    responseExecutionId: toConversationResponseExecutionId(`response-parent${runSuffix}`), createdAt: t0,
    budget: { startedAt: Date.parse(t0), deadlineAt: Date.parse(t0) + 360000, maxToolCalls: 8, budgetUnits: 24 } });
}
function created(runtime: ConversationAgentRuntimeV1): ConversationAgentRuntimeEventV1 {
  return { eventId: `${runtime.runId}-event-1`, eventKey: 'run-created', runId: runtime.runId, sequence: 1, kind: 'run_created', at: t0 };
}
function modelPrepared(runtime: ConversationAgentRuntimeV1) {
  const next = updateConversationAgentRuntime(runtime, { checkpoint: { ...runtime.checkpoint, stage: 'model' }, modelCalls: [{ callId: 'model-0', round: 0, requestHash: digest, status: 'prepared' }] }, t1);
  const event: ConversationAgentRuntimeEventV1 = { eventId: `${runtime.runId}-event-2`, eventKey: 'model-0-prepared', runId: runtime.runId, sequence: 2, kind: 'model_call_prepared', at: t1, facts: { requestHash: digest, round: 0 } };
  return { runId: runtime.runId, expectedRevision: runtime.revision, runtime: next, event };
}

describe('canonical conversation runtime CAS and outbox', () => {
  it('commits checkpoint, event, safe public outbox and unrelated completion WAL together', async () => {
    const { repository, storage, root } = await setup();
    const unit = new ProjectMetadataUnitOfWork(storage, () => t0);
    await unit.transact(0, draft => draft.set('completion-wal-fact', { registeredWorkId: 'work-already-committed' }));
    const runtime = initial(); await repository.create(runtime, created(runtime));
    const input = modelPrepared(runtime);
    const event = { ...input.event, publicEvent: { code: 'model_request' as const, status: 'started' as const, facts: { purpose: 'content', toolCallsUsed: 0 } } };
    const committed = await repository.commit({ ...input, event });
    expect(committed.runtime.modelCalls[0].status).toBe('prepared');
    expect(committed.events.at(-1)).toEqual(event);
    expect(committed.outbox[0]).toMatchObject({ eventId: event.eventId, sequence: 2, projected: false });
    const reopened = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(root), projectId);
    expect(await reopened.get(runtime.runId)).toEqual(committed);
    expect((await unit.load()).document.entries.find(entry => entry.key === 'completion-wal-fact')?.value).toEqual({ registeredWorkId: 'work-already-committed' });
    await reopened.acknowledgeOutbox(runtime.runId, event.eventId);
    await reopened.acknowledgeOutbox(runtime.runId, event.eventId);
    expect(await reopened.listPendingOutbox(runtime.runId)).toEqual([]);
    expect((await reopened.get(runtime.runId))?.runtime.revision).toBe(1);
  });
  it('replays an identical key without adding events, outbox or budget charges', async () => {
    const { repository, storage } = await setup(); const runtime = initial();
    await repository.create(runtime, created(runtime));
    const input = modelPrepared(runtime), committed = await repository.commit(input);
    const revision = (await new ProjectMetadataUnitOfWork(storage).load()).document.revision;
    const replay = await repository.commit({ ...input, event: { ...input.event, eventId: 'late-replay-generated-id', at: toIsoTimestamp('2026-10-03T11:00:02.000Z') } });
    expect(replay).toEqual(committed);
    expect((await new ProjectMetadataUnitOfWork(storage).load()).document.revision).toBe(revision);
    await expect(repository.commit({ ...input, event: { ...input.event, facts: { requestHash: 'b'.repeat(64), round: 0 } } })).rejects.toThrow(/different facts/);
    expect((await repository.get(runtime.runId))?.events).toHaveLength(2);
  });
  it('allows only one competing event at the same canonical revision', async () => {
    const { repository, root } = await setup(); const runtime = initial();
    await repository.create(runtime, created(runtime));
    const input = modelPrepared(runtime);
    const other = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(root), projectId, () => t1);
    const results = await Promise.allSettled([
      repository.commit(input), other.commit({ ...input, event: { ...input.event, eventId: 'competing-event', eventKey: 'competing-key' } })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConversationAgentRuntimeRevisionConflictError);
    expect((await repository.get(runtime.runId))?.events).toHaveLength(2);
  });
  it('retries bounded metadata CAS contention without losing another run', async () => {
    const { repository } = await setup(); const first = initial('-first'), second = initial('-second');
    await Promise.all([repository.create(first, created(first)), repository.create(second, created(second))]);
    await Promise.all([repository.commit(modelPrepared(first)), repository.commit(modelPrepared(second))]);
    expect((await repository.list()).map(snapshot => snapshot.runtime.modelCalls.length)).toEqual([1, 1]);
  });
  it.each(['before_replace', 'after_replace'] as const)('survives a crash at %s without splitting checkpoint and event facts', async stage => {
    let shouldFail = false;
    const { repository, root } = await setup({ onAtomicWriteStage(event) {
      if (shouldFail && event.stage === stage && event.targetPath.endsWith('project-metadata.json')) throw new Error('injected power loss');
    } });
    const runtime = initial(); await repository.create(runtime, created(runtime));
    const input = modelPrepared(runtime); input.event = { ...input.event, publicEvent: { code: 'model_request', status: 'started' } };
    shouldFail = true;
    await expect(repository.commit(input)).rejects.toThrow('injected power loss');
    shouldFail = false;
    const reopened = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(root), projectId, () => t1);
    const persisted = await reopened.get(runtime.runId);
    const committed = stage === 'after_replace';
    expect(persisted?.runtime.revision).toBe(committed ? 1 : 0);
    expect(persisted?.events).toHaveLength(committed ? 2 : 1);
    expect(persisted?.outbox).toHaveLength(committed ? 1 : 0);
    const replay = await reopened.commit(input);
    expect(replay.runtime.revision).toBe(1); expect(replay.events).toHaveLength(2); expect(replay.outbox).toHaveLength(1);
  });
  it('does not authorize execution or rewrite primary when only an old backup remains', async () => {
    const { repository, root } = await setup(); const runtime = initial();
    await repository.create(runtime, created(runtime)); await repository.commit(modelPrepared(runtime));
    const primary = path.join(root, 'entities/project-metadata.json'), backup = `${primary}.bak`;
    const originalBackup = await readFile(backup, 'utf8');
    await rm(primary);
    expect(await repository.inspect(runtime.runId)).toMatchObject({ source: 'backup', readOnly: true, snapshot: { runtime: { revision: 0 } } });
    await expect(repository.get(runtime.runId)).rejects.toThrow('conversation_agent_runtime_storage_reconciliation_required');
    await expect(repository.create(initial('-new'), created(initial('-new')))).rejects.toThrow('conversation_agent_runtime_storage_reconciliation_required');
    await expect(repository.acknowledgeOutbox(runtime.runId, 'event')).rejects.toThrow('conversation_agent_runtime_storage_reconciliation_required');
    await writeFile(primary, '{broken', 'utf8');
    await expect(repository.commit(modelPrepared(runtime))).rejects.toThrow('conversation_agent_runtime_storage_reconciliation_required');
    expect(await readFile(backup, 'utf8')).toBe(originalBackup);
  });
  it('rejects rebinding, deadline reset, fake outbox acknowledgement and cross-project ownership', async () => {
    const { repository } = await setup(); const runtime = initial(); await repository.create(runtime, created(runtime));
    const input = modelPrepared(runtime);
    await expect(repository.commit({ ...input, runtime: { ...input.runtime, sourceMessageId: toMessageId('another-source') } })).rejects.toThrow(/immutable/);
    await expect(repository.commit({ ...input, runtime: { ...input.runtime, budget: { ...input.runtime.budget, deadlineAt: input.runtime.budget.deadlineAt + 1 } } })).rejects.toThrow(/immutable/);
    await expect(repository.commit({ ...input, runtime: { ...input.runtime, projectId: toProjectId('other-project') } })).rejects.toThrow(/another project/);
    await expect(repository.acknowledgeOutbox(runtime.runId, 'uncommitted-event')).rejects.toThrow(/uncommitted/);
    expect((await repository.get(runtime.runId))?.runtime.revision).toBe(0);
  });
  it('keeps uncertain submitted model requests frozen across reopening', async () => {
    const { repository, root } = await setup(); const runtime = initial(); await repository.create(runtime, created(runtime));
    let snapshot = await repository.commit(modelPrepared(runtime));
    let next = updateConversationAgentRuntime(snapshot.runtime, { modelCalls: [{ ...snapshot.runtime.modelCalls[0], status: 'submitting' }] }, t1);
    snapshot = await repository.commit({ runId: runtime.runId, expectedRevision: 1, runtime: next, event: { ...created(runtime), eventId: 'submitted-event', eventKey: 'submitted', sequence: 3, kind: 'model_call_submitting', at: t1 } });
    next = updateConversationAgentRuntime(snapshot.runtime, { status: 'needs_reconciliation', stopReason: 'unknown_result', modelCalls: [{ ...snapshot.runtime.modelCalls[0], status: 'unknown' }] }, t1);
    await repository.commit({ runId: runtime.runId, expectedRevision: 2, runtime: next, event: { ...created(runtime), eventId: 'unknown-event', eventKey: 'unknown', sequence: 4, kind: 'model_call_unknown', at: t1 } });
    const reopened = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(root), projectId);
    const frozen = await reopened.get(runtime.runId);
    expect(frozen?.runtime).toMatchObject({ status: 'needs_reconciliation', budget: runtime.budget, modelCalls: [{ status: 'unknown' }] });
    await expect(reopened.commit({ runId: runtime.runId, expectedRevision: 3, runtime: { ...next, status: 'running', revision: 4, checkpoint: { ...next.checkpoint, sequence: 5 } }, event: { ...created(runtime), eventId: 'replay-event', eventKey: 'replay', sequence: 5, kind: 'checkpoint_committed', at: t1 } })).rejects.toThrow(/frozen parent/);
  });
  it('retains late registered Work after an uncertain write without reopening or permitting another tool', async () => {
    const { repository, root } = await setup(); const runtime = initial(); await repository.create(runtime, created(runtime));
    let next = updateConversationAgentRuntime(runtime, { budget: { ...runtime.budget, toolCallsUsed: 1, costUnitsUsed: 8 },
      toolCalls: [{ stepRef: 'tool-0-0', round: 0, toolId: 'generate_pptx', argumentsHash: digest, status: 'started' }] }, t1);
    await repository.commit({ runId: runtime.runId, expectedRevision: 0, runtime: next, event: { ...created(runtime), eventId: 'write-started', eventKey: 'write-started', sequence: 2, kind: 'tool_call_started', at: t1 } });
    const unknown = updateConversationAgentRuntime(next, { status: 'needs_reconciliation', stopReason: 'unknown_result', toolCalls: [{ ...next.toolCalls[0], status: 'unknown' }] }, t1);
    await repository.commit({ runId: runtime.runId, expectedRevision: 1, runtime: unknown, event: { ...created(runtime), eventId: 'write-unknown', eventKey: 'write-unknown', sequence: 3, kind: 'tool_call_unknown', at: t1 } });
    next = updateConversationAgentRuntime(unknown, { registeredWorkIds: [toWorkId('work-committed')], toolCalls: [{ ...unknown.toolCalls[0], status: 'observed', resultHash: 'b'.repeat(64), observationHash: 'c'.repeat(64) }] }, t1);
    await repository.commit({ runId: runtime.runId, expectedRevision: 2, runtime: next, event: { ...created(runtime), eventId: 'write-known-late', eventKey: 'write-known-late', sequence: 4, kind: 'tool_call_observed', at: t1, facts: { workId: 'work-committed' } } });
    const reopened = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(root), projectId);
    expect((await reopened.get(runtime.runId))?.runtime).toMatchObject({ status: 'needs_reconciliation', stopReason: 'unknown_result', registeredWorkIds: ['work-committed'], budget: { toolCallsUsed: 1, costUnitsUsed: 8 } });
    await expect(reopened.commit({ runId: runtime.runId, expectedRevision: 3, runtime: { ...next, revision: 4, checkpoint: { ...next.checkpoint, sequence: 5 }, toolCalls: [...next.toolCalls, { ...unknown.toolCalls[0], stepRef: 'tool-0-1', status: 'started' }] }, event: { ...created(runtime), eventId: 'new-write', eventKey: 'new-write', sequence: 5, kind: 'tool_call_started', at: t1 } })).rejects.toThrow(/admit/);
  });
  it('acknowledges a projected batch in one metadata CAS without advancing runtime revision', async () => {
    const { repository, storage } = await setup(); const runtime = initial();
    await repository.create(runtime, { ...created(runtime), publicEvent: { code: 'request_received', status: 'completed' } });
    const input = modelPrepared(runtime), committed = await repository.commit({ ...input, event: { ...input.event, publicEvent: { code: 'model_request', status: 'started' } } });
    const unit = new ProjectMetadataUnitOfWork(storage), before = (await unit.load()).document.revision;
    await repository.acknowledgeOutboxMany(runtime.runId, committed.outbox.map(entry => entry.eventId));
    expect((await unit.load()).document.revision).toBe(before + 1);
    expect((await repository.get(runtime.runId))?.runtime.revision).toBe(1);
    expect(await repository.listPendingOutbox(runtime.runId)).toEqual([]);
    await repository.acknowledgeOutboxMany(runtime.runId, committed.outbox.map(entry => entry.eventId));
    expect((await unit.load()).document.revision).toBe(before + 1);
  });
  it('does not trust a mutated caller snapshot or skip another metadata writer when its parsed collection is cached', async () => {
    const { repository, storage } = await setup(); const runtime = initial(); await repository.create(runtime, created(runtime));
    const read = await repository.get(runtime.runId);
    (read!.runtime.budget as { deadlineAt: number }).deadlineAt += 1;
    expect((await repository.get(runtime.runId))?.runtime.budget.deadlineAt).toBe(runtime.budget.deadlineAt);
    const unit = new ProjectMetadataUnitOfWork(storage), document = await unit.load();
    await unit.transact(document.document.revision, draft => draft.set('completion-wal-updated', { stage: 'applied', knownWork: 'work-valid' }));
    await repository.commit(modelPrepared(runtime));
    expect((await unit.load()).document.entries.find(entry => entry.key === 'completion-wal-updated')?.value).toEqual({ stage: 'applied', knownWork: 'work-valid' });
  });
  it('rejects semantic corruption with an unchanged metadata revision instead of reusing cached authority', async () => {
    const { repository, root } = await setup(); const runtime = initial(); await repository.create(runtime, created(runtime));
    await repository.get(runtime.runId);
    const primary = path.join(root, 'entities/project-metadata.json');
    const document = JSON.parse(await readFile(primary, 'utf8'));
    document.entries.find((entry: { key: string }) => entry.key === 'conversation-agent-runtimes-v1').value.snapshots[0].runtime.runId = 'forged-run';
    await writeFile(primary, JSON.stringify(document), 'utf8');
    await expect(repository.get(runtime.runId)).rejects.toThrow(/ordering/);
  });
});
