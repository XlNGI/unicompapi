import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachConversationAgentRunExecution, createConversationAgentRun, createConversationAgentRuntime, createConversationAgentSession,
  createConversationResponseExecution, createConversationResponseStreamEvent, transitionConversationAgentRun,
  evaluateConversationExecutionCompletion,
  updateConversationAgentRuntime, updateConversationAgentSession, toConnectionId, toConversationAgentRunId, toConversationId,
  toConversationResponseDraftId, toConversationResponseExecutionId, toConversationResponseStreamEventId, toIsoTimestamp, toMessageId,
  toModelId, toProjectId, toProtocolBindingId, toProviderExecutionRouteSnapshotId, toProviderId, toProviderInvocationAttemptId, toWorkId,
  type ConversationAgentRunV1, type ConversationAgentSessionV1
} from '../../src/domain';
import { ConversationAgentSessionService } from '../../src/application/conversation-agent-session-service';
import { createConversationAgentRecoveryRuntime } from '../../src/platform/ipc/conversation-agent-recovery-runtime';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { JsonConversationAgentRunRepository } from '../../src/platform/repositories/json-conversation-agent-run-repository';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { JsonConversationResponseExecutionRepository } from '../../src/platform/repositories/json-conversation-response-execution-repository';
import { JsonConversationCompletionJournal } from '../../src/platform/repositories/json-conversation-completion-journal';
import { NodeProjectStorage, ProjectMetadataUnitOfWork, projectStoragePaths, type JsonValue } from '../../src/platform/storage';

const roots: string[] = [], services: ConversationAgentSessionService[] = [];
const projectId = toProjectId('candidate-selection-project'), conversationId = toConversationId('candidate-selection-conversation');
const t0 = toIsoTimestamp('2026-10-05T12:00:00.000Z'), t1 = toIsoTimestamp('2026-10-05T12:00:01.000Z'), startedAt = Date.parse(t0);
const budget = { startedAt, deadlineAt: startedAt + 360_000, maxToolCalls: 8, budgetUnits: 24 }, digest = 'a'.repeat(64);

afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-recovery-candidates-')) throw new Error('Unsafe cleanup target');
    await rm(root, { recursive: true, force: true });
  }));
});
function task(suffix: string, state: 'active' | 'closed' | 'expired' = 'active', bound = false) {
  const id = toConversationAgentRunId(`candidate-root-${suffix}`), sourceMessageId = toMessageId(`candidate-source-${suffix}`);
  const responseId = toConversationResponseExecutionId(`candidate-response-${suffix}`);
  const initial = createConversationAgentSession({ id, projectId, conversationId, sourceMessageId, budget,
    initialSegment: { runId: id, sourceMessageId, inputReferenceHash: digest, status: 'active', planningBoundary: 'not_started',
      toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0, ...(bound ? { responseExecutionId: responseId } : {}) },
    inputReferences: [{ kind: 'message', id: sourceMessageId, version: 0, contentHash: digest }], createdAt: t0 });
  const session = state === 'active' ? initial : updateConversationAgentSession(initial, { status: state,
    ...(state === 'closed' ? { closedReason: bound ? 'cancelled' : 'completed' } : {}),
    childSegments: [{ ...initial.childSegments[0], status: 'settled' }] }, t1);
  const initialRun = createConversationAgentRun({ id, projectId, conversationId, sourceMessageId, createdAt: t0 });
  const run = bound ? transitionConversationAgentRun(attachConversationAgentRunExecution(initialRun, responseId, t0), 'cancelled', t1) : initialRun;
  return { session, run, responseId };
}
async function setup(tasks: readonly { session: ConversationAgentSessionV1; run: ConversationAgentRunV1 }[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-recovery-candidates-')); roots.push(root);
  const storage = new NodeProjectStorage(root), at = () => t1, sessions = new JsonConversationAgentSessionRepository(storage, projectId, at);
  const agentRuns = new JsonConversationAgentRunRepository(storage, projectId, at), runtimeRepository = new JsonConversationAgentRuntimeRepository(storage, projectId, at);
  const responses = new JsonConversationResponseExecutionRepository(storage, projectId), completionJournal = new JsonConversationCompletionJournal(storage, projectId, at);
  await new ProjectMetadataUnitOfWork(storage, at).transact(0, draft => draft.set('conversation-agent-sessions-v1',
    { schemaVersion: 1, projectId, sessions: tasks.map(item => item.session) } as unknown as JsonValue));
  await storage.writeJsonAtomically(projectStoragePaths.entities.conversationAgentRuns,
    { schemaVersion: 1, revision: 1, updatedAt: t1, runs: tasks.map(item => item.run) });
  const service = new ConversationAgentSessionService({ repository: sessions, ownerId: 'candidate-selection-host', now: () => Date.parse(t1),
    hash: value => createHash('sha256').update(value).digest('hex'), nextResumeToken: () => 'candidate-selection-resume-token', recheckContinuation: async () => undefined });
  services.push(service);
  const collectResponseFacts = vi.fn(async () => ({ documentTasks: [], pendingToolCallCount: 0, unpersistedObservationCount: 0, unknownResult: false, toolFailed: false }));
  const waiting = vi.fn(), recoverLocal = vi.fn(async () => undefined), onError = vi.fn();
  const runtime = createConversationAgentRecoveryRuntime({ rootDirectory: root, projectId, storage, sessions, sessionService: service, runtimeRepository, agentRuns, responses, completionJournal,
    documentTools: { collectResponseFacts }, recoverLocal, onWaitingChallenge: waiting, now: () => Date.parse(t1), onError });
  return { storage, sessions, service, runtimeRepository, responses, completionJournal, runtime, waiting, collectResponseFacts, recoverLocal, onError };
}
async function persistResponse(f: Awaited<ReturnType<typeof setup>>, selected: ReturnType<typeof task>) {
  const response = createConversationResponseExecution({ id: selected.responseId, projectId,
    providerInvocationAttemptId: toProviderInvocationAttemptId(`attempt-${selected.session.id}`), createdAt: t0,
    snapshot: { schemaVersion: 1, responseDraftId: toConversationResponseDraftId(`draft-${selected.session.id}`), responseDraftRevision: 0,
      conversationId, conversationRevision: 1, userMessageId: selected.session.sourceMessageId, userMessageRevision: 0,
      assistantMessageId: toMessageId(`assistant-${selected.session.id}`), productFeature: 'text_chat',
      routeSnapshotId: toProviderExecutionRouteSnapshotId(`route-${selected.session.id}`), outboundUserTextSnapshot: 'synthetic recovery case', contextSnapshots: [],
      candidate: { schemaVersion: 1, providerId: toProviderId('synthetic-provider'), connectionId: toConnectionId('synthetic-connection'), connectionRevision: 1,
        modelId: toModelId('synthetic-model'), modelRevision: 1, profileId: 'synthetic-profile', profileRevision: 1,
        protocolBindingId: toProtocolBindingId('synthetic-binding'), protocolBindingRevision: 1, runtimeSource: 'official_direct' } } });
  await f.responses.create(response, createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId(`event-${selected.session.id}-1`),
    responseExecutionId: selected.responseId, sequence: 1, type: 'execution_created', occurredAt: t0 }));
}
async function persistCanonical(f: Awaited<ReturnType<typeof setup>>, selected: ReturnType<typeof task>, unknown: boolean) {
  let current = createConversationAgentRuntime({ runId: selected.run.id, projectId, conversationId, sourceMessageId: selected.session.sourceMessageId,
    responseExecutionId: selected.responseId, createdAt: t0, budget });
  await f.runtimeRepository.create(current, { eventId: `runtime-${selected.run.id}-1`, eventKey: 'run-created', runId: current.runId, sequence: 1, kind: 'run_created', at: t0 });
  if (!unknown) return current;
  for (const status of ['prepared', 'submitting', 'unknown'] as const) {
    const next = updateConversationAgentRuntime(current, { ...(status === 'unknown' ? { status: 'needs_reconciliation' } : {}),
      modelCalls: [{ callId: 'model-0', round: 0, requestHash: digest, status }], checkpoint: { ...current.checkpoint, stage: status === 'unknown' ? 'reconciliation' : 'model' } }, t1);
    await f.runtimeRepository.commit({ runId: current.runId, expectedRevision: current.revision, runtime: next,
      event: { eventId: `runtime-${current.runId}-${next.checkpoint.sequence}`, eventKey: `model-0-${status}`, runId: current.runId,
        sequence: next.checkpoint.sequence, kind: status === 'prepared' ? 'model_call_prepared' : status === 'submitting' ? 'model_call_submitting' : 'model_call_unknown', at: t1 } });
    current = next;
  }
  return current;
}

describe('bounded unified recovery candidate selection', () => {
  it('recovers an active task after 1025 completed Roots without revalidating completed Works', async () => {
    const historical = Array.from({ length: 1025 }, (_, index) => task(`history-${index}`, 'closed'));
    historical[0] = { ...historical[0], session: { ...historical[0].session, registeredWorkIds: [toWorkId('historical-formal-work')] } };
    const active = task('active'), f = await setup([...historical, active]);
    const reads = [vi.spyOn(f.sessions, 'list'), vi.spyOn(f.runtimeRepository, 'list'), vi.spyOn(f.responses, 'list'), vi.spyOn(f.completionJournal, 'listPending')];
    expect(await f.runtime.recover()).toMatchObject({ inspected: 1, offered: 1, frozen: 0, failed: 0 });
    expect((await f.sessions.get(active.session.id))?.waiting?.reason).toBe('safe_continuation');
    expect(await f.sessions.get(historical[0].session.id)).toEqual(historical[0].session);
    expect(f.collectResponseFacts).not.toHaveBeenCalled(); expect(f.recoverLocal).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled();
    // Candidate selection is a collection read, not one repository lookup per historical Root.
    reads.forEach(read => expect(read).toHaveBeenCalledTimes(1));
  });
  it.each([false, true])('still investigates a cancelled Root with a %s unknown canonical request', async unknown => {
    const cancelled = task(`cancelled-${unknown}`, 'closed', true), f = await setup([cancelled]);
    await persistResponse(f, cancelled); await persistCanonical(f, cancelled, unknown);
    expect(await f.runtime.recover()).toMatchObject({ inspected: 1, offered: 0, frozen: unknown ? 1 : 0, failed: 0 });
    expect((await f.sessions.get(cancelled.session.id))?.status).toBe(unknown ? 'needs_reconciliation' : 'closed');
    expect((await f.sessions.get(cancelled.session.id))?.closedReason).toBe('cancelled');
    expect((await f.sessions.get(cancelled.session.id))?.budget).toEqual(cancelled.session.budget);
    expect(f.waiting).not.toHaveBeenCalled(); expect(f.recoverLocal).not.toHaveBeenCalled();
  });
  it('keeps an expired Root with a missing bound Response in the investigation set', async () => {
    const expired = task('expired-missing-bound', 'expired', true), f = await setup([expired]);
    expect(await f.runtime.recover()).toMatchObject({ inspected: 1, frozen: 1, offered: 0, failed: 0 });
    expect((await f.sessions.get(expired.session.id))?.status).toBe('needs_reconciliation');
    expect(f.waiting).not.toHaveBeenCalled(); expect(f.recoverLocal).not.toHaveBeenCalled();
  });
  it('skips a settled bound history but selects it when a completion WAL still needs projection', async () => {
    const closed = task('closed-with-completion-wal', 'closed', true), f = await setup([closed]);
    await persistResponse(f, closed);
    await f.responses.appendEvents([
      createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('completed-history-event-2'), responseExecutionId: closed.responseId,
        sequence: 2, type: 'stream_started', occurredAt: t0 }),
      createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('completed-history-event-3'), responseExecutionId: closed.responseId,
        sequence: 3, type: 'content_delta', contentDelta: 'Synthetic completed response.', occurredAt: t1 }),
      createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('completed-history-event-4'), responseExecutionId: closed.responseId,
        sequence: 4, type: 'stream_completed', occurredAt: t1 })
    ]);
    let current = await persistCanonical(f, closed, false);
    for (const status of ['prepared', 'submitting', 'completed'] as const) {
      const next = updateConversationAgentRuntime(current, { modelCalls: [{ callId: 'model-0', round: 0, requestHash: digest, status,
        ...(status === 'completed' ? { resultHash: digest } : {}) }], checkpoint: { ...current.checkpoint, stage: 'model' } }, t1);
      await f.runtimeRepository.commit({ runId: current.runId, expectedRevision: current.revision, runtime: next,
        event: { eventId: `closed-completion-event-${next.checkpoint.sequence}`, eventKey: `model-0-${status}`, runId: current.runId,
          sequence: next.checkpoint.sequence, kind: status === 'prepared' ? 'model_call_prepared' : status === 'submitting' ? 'model_call_submitting' : 'model_call_completed', at: t1 } });
      current = next;
    }
    const settled = updateConversationAgentRuntime(current, { status: 'settled', checkpoint: { ...current.checkpoint, stage: 'settled' } }, t1);
    await f.runtimeRepository.commit({ runId: current.runId, expectedRevision: current.revision, runtime: settled,
      event: { eventId: 'closed-canonical-event-5', eventKey: 'run-settled', runId: current.runId, sequence: 5, kind: 'run_settled', at: t1 } });
    expect(await f.runtime.recover()).toMatchObject({ inspected: 0, frozen: 0 });
    const decision = evaluateConversationExecutionCompletion({ run: closed.run, response: { id: closed.responseId, projectId, conversationId,
      sourceMessageId: closed.session.sourceMessageId, state: 'completed' } });
    await f.completionJournal.save({ schemaVersion: 1, revision: 0, responseExecutionId: closed.responseId, expectedRunRevision: closed.run.revision,
      targetRun: closed.run, decision, responseState: 'completed', taskRevisions: [], stage: 'prepared', createdAt: t1, updatedAt: t1 }, null);
    expect(await f.runtime.recover()).toMatchObject({ inspected: 1, frozen: 0, offered: 0, failed: 0 });
    expect((await f.completionJournal.get(closed.responseId))?.stage).toBe('prepared');
    expect(await f.sessions.get(closed.session.id)).toEqual(closed.session);
  });
});
