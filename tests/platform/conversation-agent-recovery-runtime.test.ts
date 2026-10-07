import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversationAgentRun, toConversationAgentRunId, toConversationId, toIsoTimestamp, toMessageId, toProjectId, toWorkId, type ConversationAgentSessionV1 } from '../../src/domain';
import { ConversationAgentSessionService } from '../../src/application/conversation-agent-session-service';
import { createConversationAgentRecoveryRuntime } from '../../src/platform/ipc/conversation-agent-recovery-runtime';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { JsonConversationAgentRunRepository } from '../../src/platform/repositories/json-conversation-agent-run-repository';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { JsonConversationResponseExecutionRepository } from '../../src/platform/repositories/json-conversation-response-execution-repository';
import { JsonConversationCompletionJournal } from '../../src/platform/repositories/json-conversation-completion-journal';
import { NodeProjectStorage, projectStoragePaths } from '../../src/platform/storage';

const roots: string[] = [], services: ConversationAgentSessionService[] = [];
const start = Date.parse('2026-10-04T12:00:00.000Z'), projectId = toProjectId('recovery-runtime-project'), conversationId = toConversationId('recovery-runtime-conversation');
const sessionId = toConversationAgentRunId('recovery-runtime-root'), sourceMessageId = toMessageId('recovery-runtime-source');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-recovery-runtime-')) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-recovery-runtime-')); roots.push(root);
  let now = start + 1, token = 0, localRepairs = 0, safeOffers = 0, safeOfferOwned = false;
  const storage = new NodeProjectStorage(root), at = () => new Date(now).toISOString();
  const sessions = new JsonConversationAgentSessionRepository(storage, projectId, at), agentRuns = new JsonConversationAgentRunRepository(storage, projectId, at);
  const runtimeRepository = new JsonConversationAgentRuntimeRepository(storage, projectId, at), responses = new JsonConversationResponseExecutionRepository(storage, projectId);
  const completionJournal = new JsonConversationCompletionJournal(storage, projectId, at);
  const source = { kind: 'message' as const, id: sourceMessageId, version: 0, contentHash: 'a'.repeat(64) };
  const create = (ownerId: string) => {
    const service = new ConversationAgentSessionService({ repository: sessions, ownerId, now: () => now, hash, leaseTtlMs: 1000,
      nextResumeToken: () => `recovery-runtime-resume-token-${++token}`, recheckContinuation: async () => undefined }); services.push(service); return service;
  };
  const first = create('first-host'), second = create('second-host');
  const run = createConversationAgentRun({ id: sessionId, projectId, conversationId, sourceMessageId, createdAt: toIsoTimestamp(new Date(start).toISOString()) });
  await agentRuns.create(run);
  await first.open({ run, budget: { startedAt: start, deadlineAt: start + 360_000, maxToolCalls: 8, budgetUnits: 24 }, inputReferences: [source] });
  const challenges: { session: ConversationAgentSessionV1; resumeToken: string }[] = [], changes: ConversationAgentSessionV1[] = [];
  const runtime = createConversationAgentRecoveryRuntime({ rootDirectory: root, projectId, storage, sessions, sessionService: second, runtimeRepository, agentRuns, responses, completionJournal,
    documentTools: { collectResponseFacts: async () => ({ documentTasks: [], pendingToolCallCount: 0, unpersistedObservationCount: 0, unknownResult: false, toolFailed: false }) },
    recoverLocal: async input => { await input.claim.assertCurrent(); localRepairs++; }, onSafeContinuation: async input => {
      await input.claim.assertCurrent();
      const current = await sessions.get(input.session.id);
      safeOfferOwned = current?.status === 'active' && current.lease?.ownerId === input.claim.ownerId;
      safeOffers++;
    },
    onWaitingChallenge: input => { challenges.push(input); }, onSessionChanged: session => { changes.push(session); }, now: () => now });
  return { root, storage, sessions, agentRuns, first, second, runtime, source, challenges, changes, get localRepairs() { return localRepairs; }, get safeOffers() { return safeOffers; }, get safeOfferOwned() { return safeOfferOwned; }, setTime(value: number) { now = value; } };
}
describe('Unified conversation recovery runtime', () => {
  it('serializes duplicate scoped recovery and does not rotate the waiting token produced by the first claim', async () => {
    const f = await setup(); f.first.dispose(); f.setTime(start + 1500);
    const reports = await Promise.all([f.runtime.recoverSpecificRootIds([sessionId]), f.runtime.recoverSpecificRootIds([sessionId])]);
    expect(reports.map(report => report.offered)).toEqual([1, 0]);
    expect(f.challenges).toHaveLength(1); expect(f.safeOffers).toBe(1);
    const waiting = (await f.sessions.get(sessionId))!;
    expect(waiting.waitingVersion).toBe(1);
    expect(await f.runtime.recoverSpecificRootIds([sessionId])).toMatchObject({ inspected: 0, waiting: 0, offered: 0 });
    expect(await f.sessions.get(sessionId)).toEqual(waiting); expect(f.challenges).toHaveLength(1);
  });
  it('leaves another live owner untouched and blocks legacy recovery from that Run', async () => {
    const f = await setup(), before = await f.sessions.get(sessionId);
    expect(await f.runtime.canRecoverRun(sessionId)).toBe(false);
    expect(await f.runtime.recover()).toMatchObject({ busy: 1, inspected: 0 });
    expect(await f.sessions.get(sessionId)).toEqual(before); expect(f.challenges).toEqual([]); expect(f.localRepairs).toBe(0);
  });
  it('offers a versioned explicit continuation only when all durable boundaries prove no submission', async () => {
    const f = await setup(); f.first.dispose(); f.setTime(start + 1500);
    expect(await f.runtime.recover()).toMatchObject({ offered: 1, frozen: 0 });
    const recovered = (await f.sessions.get(sessionId))!;
    expect(recovered).toMatchObject({ status: 'waiting_user', waiting: { reason: 'safe_continuation', allowedActions: ['continue'] }, leaseEpoch: 2 });
    expect(recovered.budget.deadlineAt).toBe(start + 360_000); expect(f.challenges).toHaveLength(1); expect(f.safeOffers).toBe(1); expect(f.localRepairs).toBe(0);
    expect(JSON.stringify(recovered)).not.toContain(f.challenges[0].resumeToken);
    expect(f.safeOfferOwned).toBe(true);
    expect(await f.runtime.canRecoverRun(sessionId)).toBe(false);
  });
  it('refreshes a saved waiting challenge once per startup without closing the parent or replaying a model', async () => {
    const f = await setup(), old = await f.first.wait(sessionId, { reason: 'clarification', allowedActions: ['reply'] });
    expect(await f.runtime.recover()).toMatchObject({ waiting: 1, offered: 0, frozen: 0 });
    const current = (await f.sessions.get(sessionId))!;
    expect(current.status).toBe('waiting_user'); expect(current.waitingVersion).toBe(old.session.waitingVersion + 1);
    expect(current.waiting!.resumeNonceHash).not.toBe(old.session.waiting!.resumeNonceHash); expect(f.challenges).toHaveLength(1); expect(f.localRepairs).toBe(0);
    expect(current.childSegments).toHaveLength(1); expect(current.budget.costUnitsUsed).toBe(0);
  });
  it('freezes a planning request whose response was never durably received', async () => {
    const f = await setup(); await f.first.markPlanningBoundary(sessionId, 'submitted'); f.first.dispose(); f.setTime(start + 1500);
    expect((await f.runtime.inspectSession(sessionId)).modelBoundary).toBe('unknown');
    expect(await f.runtime.recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect((await f.sessions.get(sessionId))!.status).toBe('needs_reconciliation'); expect(f.localRepairs).toBe(0); expect(f.challenges).toEqual([]);
  });
  it('also freezes a resumed child planning request while the initial planning receipt remains known', async () => {
    const f = await setup(); await f.first.markPlanningBoundary(sessionId, 'submitted'); await f.first.markPlanningBoundary(sessionId, 'received');
    const waiting = await f.first.wait(sessionId, { reason: 'clarification', allowedActions: ['reply'] });
    const childRunId = toConversationAgentRunId('recovery-runtime-child'), nextMessageId = toMessageId('recovery-runtime-followup');
    await f.first.resume({ sessionId, projectId, conversationId, expectedRevision: waiting.session.revision, resumeToken: waiting.resumeToken, commandId: 'recovery-runtime-reply', action: 'reply', childRunId,
      sourceMessageId: nextMessageId, inputReference: { kind: 'message', id: nextMessageId, version: 0, contentHash: 'b'.repeat(64) } });
    await f.first.markPlanningBoundary(sessionId, 'submitted', childRunId); f.first.dispose(); f.setTime(start + 1500);
    expect((await f.sessions.get(sessionId))!.planningBoundary).toBe('received');
    expect(await f.runtime.recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect(f.localRepairs).toBe(0); expect(f.challenges).toEqual([]);
  });
  it('persists expiry for a provably unsubmitted task without offering a new deadline or lease', async () => {
    const f = await setup(); f.first.dispose(); f.setTime(start + 360_000);
    expect(await f.runtime.recover()).toMatchObject({ offered: 0, frozen: 0, inspected: 1 });
    expect((await f.sessions.get(sessionId))!).toMatchObject({ status: 'expired', leaseEpoch: 1, budget: { deadlineAt: start + 360_000 } });
    expect(f.challenges).toEqual([]);
  });
  it('keeps uncertain effects frozen after the deadline instead of losing their cause', async () => {
    const f = await setup(); await f.first.markPlanningBoundary(sessionId, 'submitted'); f.first.dispose(); f.setTime(start + 360_000);
    expect(await f.runtime.recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect((await f.sessions.get(sessionId))!).toMatchObject({ status: 'needs_reconciliation', leaseEpoch: 1 });
  });
  it('preserves an explicitly closed lost planner reply during later recovery while retaining its unknown evidence', async () => {
    const f = await setup(); await f.first.markPlanningBoundary(sessionId, 'submitted');
    const frozen = await f.first.freeze(sessionId);
    const closed = await f.first.acknowledgeWithoutResponse({ sessionId, expectedRevision: frozen.revision, confirmed: true });
    f.first.dispose(); f.setTime(start + 1500);
    expect(await f.runtime.recover()).toMatchObject({ frozen: 0, offered: 0, settled: 0 });
    expect(await f.sessions.get(sessionId)).toEqual(closed);
    expect(closed.childSegments[0].status).toBe('unknown'); expect(f.localRepairs).toBe(0);
  });
  it('does not trust a document entity backup as proof of no side effect', async () => {
    const f = await setup();
    const empty = { schemaVersion: 1, revision: 0, updatedAt: new Date(start).toISOString(), runtimes: [] };
    await f.storage.writeJsonAtomically(projectStoragePaths.entities.documentTaskRuntimes, empty);
    await f.storage.writeJsonAtomically(projectStoragePaths.entities.documentTaskRuntimes, empty, { backup: true });
    await writeFile(path.join(f.root, 'entities', 'document-task-runtimes.json'), '{broken-primary-json');
    f.first.dispose(); f.setTime(start + 1500);
    expect(await f.runtime.recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect((await f.sessions.get(sessionId))!.status).toBe('needs_reconciliation'); expect(f.localRepairs).toBe(0);
  });
  it('preserves recorded Work identity but refuses continuation when its registration or file cannot be verified', async () => {
    const f = await setup(); await f.first.recordVerifiedWorks(sessionId, [toWorkId('registered-but-unreadable-work')]); f.first.dispose(); f.setTime(start + 1500);
    expect(await f.runtime.recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect((await f.sessions.get(sessionId))!.registeredWorkIds).toEqual(['registered-but-unreadable-work']); expect(f.challenges).toEqual([]);
  });
});
