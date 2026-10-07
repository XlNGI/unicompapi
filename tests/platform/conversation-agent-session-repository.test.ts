import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversationAgentSession, updateConversationAgentSession, toConversationAgentRunId, toConversationResponseExecutionId, toConversationId, toProjectId, toMessageId, toIsoTimestamp, toWorkId, type ConversationAgentSessionBeginResumeInput } from '../../src/domain';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { NodeProjectStorage, ProjectMetadataUnitOfWork } from '../../src/platform/storage';
import type { ProjectRelativePath } from '../../src/platform/storage/project-paths';
import type { AtomicJsonWriteOptions } from '../../src/platform/storage/storage-adapter';
const roots: string[] = [], projectId = toProjectId('project-session-store'), digest = 'a'.repeat(64), t0 = toIsoTimestamp('2026-10-04T12:00:00.000Z');
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => {
  if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-root-session-')) throw new Error('Unsafe test cleanup target');
  await rm(root, { recursive: true, force: true });
})); });
function initial(suffix = '') {
  return createConversationAgentSession({ id: toConversationAgentRunId(`session-root${suffix}`), projectId, conversationId: toConversationId('conversation-root'), sourceMessageId: toMessageId(`message-original${suffix}`),
    budget: { startedAt: Date.parse(t0), deadlineAt: Date.parse(t0) + 360_000, maxToolCalls: 8, budgetUnits: 24 },
    initialSegment: { runId: toConversationAgentRunId(`session-root${suffix}`), responseExecutionId: toConversationResponseExecutionId(`response-original${suffix}`), sourceMessageId: toMessageId(`message-original${suffix}`), inputReferenceHash: digest, status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 },
    inputReferences: [{ kind: 'message', id: `message-original${suffix}`, version: 0, contentHash: digest }], createdAt: t0 });
}
class DelayedMutationStorage extends NodeProjectStorage {
  beforeMutation?: () => void;
  override mutateJsonAtomically<T>(relativePath: ProjectRelativePath, mutate: (current: unknown | undefined) => T | Promise<T>, options?: AtomicJsonWriteOptions): Promise<T> {
    return super.mutateJsonAtomically(relativePath, current => { this.beforeMutation?.(); return mutate(current); }, options);
  }
}
async function setup(options?: ConstructorParameters<typeof NodeProjectStorage>[1]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-root-session-')); roots.push(root);
  let clock = Date.parse(t0) + 1000; const now = () => new Date(clock).toISOString(), storage = new NodeProjectStorage(root, options);
  const repository = new JsonConversationAgentSessionRepository(storage, projectId, now);
  return { root, storage, repository, now, setClock: (value: number) => { clock = value; } };
}
async function prepareWaiting(repository: JsonConversationAgentSessionRepository) {
  const session = initial(); await repository.create(session); const claim = await repository.acquireLease({ sessionId: session.id, ownerId: 'owner-initial', ttlMs: 10_000 });
  const waiting = updateConversationAgentSession(claim.session, { status: 'waiting_user', lease: undefined, waitingVersion: 1,
    waiting: { version: 1, reason: 'clarification', allowedActions: ['reply'], resumeNonceHash: digest, inputReferenceHash: digest, preparedAt: toIsoTimestamp('2026-10-04T12:00:01.000Z') },
    childSegments: [{ ...claim.session.childSegments[0], status: 'waiting', toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 2 }], budget: { ...claim.session.budget, toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 2 } }, toIsoTimestamp('2026-10-04T12:00:01.000Z'));
  return repository.commit({ sessionId: session.id, expectedRevision: claim.session.revision, session: waiting, fence: { ownerId: claim.lease.ownerId, epoch: claim.lease.epoch } });
}
function resume(session: Awaited<ReturnType<typeof prepareWaiting>>, suffix = ''): ConversationAgentSessionBeginResumeInput {
  return { sessionId: session.id, projectId, conversationId: session.conversationId, expectedRevision: session.revision, waitingVersion: 1, nonceHash: digest, expectedInputReferenceHash: digest,
    commandId: `resume-command${suffix}`, action: 'reply', ownerId: `owner-resume${suffix}`, ttlMs: 10_000,
    segment: { runId: toConversationAgentRunId(`run-resumed${suffix}`), responseExecutionId: toConversationResponseExecutionId(`response-resumed${suffix}`), sourceMessageId: toMessageId(`message-reply${suffix}`), inputReferenceHash: 'b'.repeat(64), status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 },
    inputReference: { kind: 'message', id: `message-reply${suffix}`, version: 0, contentHash: 'b'.repeat(64) } };
}
describe('root session metadata CAS, continuation nonce and lease fencing', () => {
  it('preserves other metadata WAL and survives reopening with original response ownership', async () => {
    const { repository, storage, root, now } = await setup(), unit = new ProjectMetadataUnitOfWork(storage, now);
    await unit.transact(0, draft => draft.set('completion-wal-receipt', { workId: 'work-preserved' }));
    const session = await prepareWaiting(repository), result = await repository.beginResume(resume(session));
    expect(result.replayed).toBe(false); expect(result.session.childSegments).toHaveLength(2);
    expect(result.session.childSegments[0].responseExecutionId).toBe('response-original');
    expect(result.session.budget).toEqual(session.budget); expect(result.session.waiting).toBeUndefined();
    const reopened = new JsonConversationAgentSessionRepository(new NodeProjectStorage(root), projectId, now);
    expect(await reopened.findByRunId(toConversationAgentRunId('run-resumed'))).toEqual(result.session);
    expect((await unit.load()).document.entries.find(entry => entry.key === 'completion-wal-receipt')?.value).toEqual({ workId: 'work-preserved' });
  });
  it('atomically admits only one competing resume and consumes a nonce once', async () => {
    const { repository, root, now } = await setup(), session = await prepareWaiting(repository), other = new JsonConversationAgentSessionRepository(new NodeProjectStorage(root), projectId, now);
    const results = await Promise.allSettled([repository.beginResume(resume(session, '-one')), other.beginResume(resume(session, '-two'))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const persisted = (await repository.get(session.id))!; expect(persisted.childSegments).toHaveLength(2); expect(persisted.resumeReceipts).toHaveLength(1);
    const chosen = persisted.resumeReceipts[0].commandId.endsWith('-one') ? '-one' : '-two';
    expect((await other.beginResume(resume(session, chosen))).replayed).toBe(true);
    expect((await other.get(session.id))?.revision).toBe(persisted.revision);
  });
  it.each(['waitingVersion', 'nonceHash', 'expectedInputReferenceHash', 'expectedRevision', 'action', 'conversationId', 'projectId'] as const)('rejects mismatched resume %s before changing state', async key => {
    const { repository } = await setup(), session = await prepareWaiting(repository), input = resume(session);
    const bad = { ...input, [key]: key === 'waitingVersion' || key === 'expectedRevision' ? 999 : key === 'action' ? 'continue' : key.endsWith('Hash') ? 'c'.repeat(64) : 'another-scope' };
    await expect(repository.beginResume(bad as ConversationAgentSessionBeginResumeInput)).rejects.toThrow();
    expect((await repository.get(session.id))?.status).toBe('waiting_user');
  });
  it('keeps one lease owner, fences the stale owner and grants only a higher epoch after expiry', async () => {
    const { repository, root, now, setClock } = await setup(), session = initial(); await repository.create(session);
    const other = new JsonConversationAgentSessionRepository(new NodeProjectStorage(root), projectId, now);
    const claims = await Promise.allSettled([repository.acquireLease({ sessionId: session.id, ownerId: 'owner-one', ttlMs: 1000 }), other.acquireLease({ sessionId: session.id, ownerId: 'owner-two', ttlMs: 1000 })]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const first = (await repository.get(session.id))!, oldFence = { ownerId: first.lease!.ownerId, epoch: first.lease!.epoch };
    setClock(Date.parse(t0) + 2001); await expect(repository.assertLease({ sessionId: session.id, fence: oldFence })).rejects.toThrow(/lease_lost/);
    const takeover = await other.acquireLease({ sessionId: session.id, ownerId: 'owner-new', ttlMs: 1000 }); expect(takeover.lease.epoch).toBe(2);
    await expect(repository.releaseLease({ sessionId: session.id, fence: oldFence })).rejects.toThrow(/lease_lost/);
    expect((await repository.get(session.id))?.childSegments).toHaveLength(1);
  });
  it('renews with the same epoch, releases explicitly and never extends the root deadline', async () => {
    const { repository, setClock } = await setup(), session = initial(); await repository.create(session);
    const claim = await repository.acquireLease({ sessionId: session.id, ownerId: 'owner-one', ttlMs: 10_000 }), fence = { ownerId: claim.lease.ownerId, epoch: claim.lease.epoch };
    setClock(Date.parse(t0) + 2000); const renewed = await repository.renewLease({ sessionId: session.id, fence, ttlMs: 60_000 });
    expect(renewed.lease.epoch).toBe(claim.lease.epoch); expect(renewed.session.budget.deadlineAt).toBe(session.budget.deadlineAt);
    expect((await repository.releaseLease({ sessionId: session.id, fence })).lease).toBeUndefined();
    const near = await repository.acquireLease({ sessionId: session.id, ownerId: 'owner-two', ttlMs: 60_000 });
    setClock(session.budget.deadlineAt); await expect(repository.renewLease({ sessionId: session.id, fence: { ownerId: near.lease.ownerId, epoch: near.lease.epoch }, ttlMs: 1000 })).rejects.toThrow();
  });
  it('rejects an expired wait and cancelled or unknown roots without replay authority', async () => {
    const { repository, setClock } = await setup(), session = await prepareWaiting(repository);
    setClock(session.budget.deadlineAt); await expect(repository.beginResume(resume(session))).rejects.toThrow(/unavailable/);
    setClock(Date.parse(t0) + 2000);
    const unknown = updateConversationAgentSession(session, { status: 'needs_reconciliation', waiting: undefined, childSegments: [{ ...session.childSegments[0], status: 'unknown' }] }, toIsoTimestamp('2026-10-04T12:00:02.000Z'));
    await repository.commit({ sessionId: session.id, expectedRevision: session.revision, session: unknown });
    await expect(repository.acquireLease({ sessionId: session.id, ownerId: 'owner-new', ttlMs: 1000 })).rejects.toThrow(/unavailable/);
    await expect(repository.beginResume(resume(unknown))).rejects.toThrow(/unavailable/);
  });
  it('prevents general commits from bypassing nonce consumption or changing lease epoch', async () => {
    const { repository } = await setup(), session = await prepareWaiting(repository);
    const bypass = updateConversationAgentSession(session, { status: 'active', waiting: undefined }, toIsoTimestamp('2026-10-04T12:00:01.000Z'));
    await expect(repository.commit({ sessionId: session.id, expectedRevision: session.revision, session: bypass })).rejects.toThrow(/nonce/);
    const claimed = await repository.acquireLease({ sessionId: session.id, ownerId: 'owner-one', ttlMs: 1000 });
    const forged = updateConversationAgentSession(claimed.session, { leaseEpoch: claimed.session.leaseEpoch + 1, lease: { ...claimed.lease, epoch: claimed.lease.epoch + 1 } }, toIsoTimestamp('2026-10-04T12:00:01.000Z'));
    await expect(repository.commit({ sessionId: session.id, expectedRevision: claimed.session.revision, session: forged, fence: { ownerId: claimed.lease.ownerId, epoch: claimed.lease.epoch } })).rejects.toThrow(/fenced/);
  });
  it.each(['before_replace', 'after_replace'] as const)('keeps resume consumption and new segment together at %s crash', async stage => {
    let fail = false; const { repository, root, now } = await setup({ onAtomicWriteStage(event) { if (fail && event.stage === stage && event.targetPath.endsWith('project-metadata.json')) throw new Error('injected interruption'); } });
    const session = await prepareWaiting(repository), input = resume(session); fail = true;
    await expect(repository.beginResume(input)).rejects.toThrow('injected interruption'); fail = false;
    const reopened = new JsonConversationAgentSessionRepository(new NodeProjectStorage(root), projectId, now), persisted = (await reopened.get(session.id))!;
    expect(persisted.resumeReceipts.length).toBe(stage === 'after_replace' ? 1 : 0); expect(persisted.childSegments.length).toBe(stage === 'after_replace' ? 2 : 1);
    const result = await reopened.beginResume(input); expect(result.replayed).toBe(stage === 'after_replace'); expect(result.session.childSegments).toHaveLength(2);
  });
  it('uses backups only as evidence and never writes a claim over corrupt or missing primary', async () => {
    const { repository, root } = await setup(), session = await prepareWaiting(repository), primary = path.join(root, 'entities/project-metadata.json'), backup = `${primary}.bak`, backupText = await readFile(backup, 'utf8');
    await rm(primary); expect(await repository.inspect(session.id)).toMatchObject({ source: 'backup', readOnly: true });
    await expect(repository.acquireLease({ sessionId: session.id, ownerId: 'owner-one', ttlMs: 1000 })).rejects.toThrow(/storage_reconciliation/);
    await writeFile(primary, '{broken', 'utf8'); await expect(repository.beginResume(resume(session))).rejects.toThrow(/storage_reconciliation/);
    expect(await readFile(backup, 'utf8')).toBe(backupText);
  });
  it('atomically adds the first response child under a non-executing root only once', async () => {
    const { repository } = await setup(), original = initial(), root = { ...original, childSegments: [{ ...original.childSegments[0], responseExecutionId: undefined }] };
    await repository.create(root); const claim = await repository.acquireLease({ sessionId: root.id, ownerId: 'owner-initial', ttlMs: 10_000 });
    const segment = { ...original.childSegments[0], runId: toConversationAgentRunId('first-child') };
    const input = { sessionId: root.id, expectedRevision: claim.session.revision, fence: { ownerId: claim.lease.ownerId, epoch: claim.lease.epoch }, segment, inputReference: root.inputReferences[0] };
    const first = await repository.beginInitialSegment(input); expect(first.replayed).toBe(false);
    expect(first.session.childSegments[0].status).toBe('settled'); expect(first.session.childSegments[1].responseExecutionId).toBe('response-original');
    const repeated = await repository.beginInitialSegment(input); expect(repeated.replayed).toBe(true); expect(repeated.session.revision).toBe(first.session.revision);
    await expect(repository.beginInitialSegment({ ...input, segment: { ...segment, runId: toConversationAgentRunId('another-first-child'), responseExecutionId: toConversationResponseExecutionId('another-response') } })).rejects.toThrow(/conflict/);
  });
  it('retains a known verified late Work without lease ownership or permission to continue', async () => {
    const { repository, setClock } = await setup(), session = await prepareWaiting(repository), resumed = await repository.beginResume(resume(session));
    setClock(resumed.lease.expiresAt + 1);
    const late = await repository.recordVerifiedWorks({ sessionId: session.id, workIds: [toWorkId('work-known')] });
    expect(late.registeredWorkIds).toEqual(['work-known']); expect(late.budget).toEqual(resumed.session.budget); expect(late.lease).toEqual(resumed.lease);
    await expect(repository.assertLease({ sessionId: session.id, fence: { ownerId: resumed.lease.ownerId, epoch: resumed.lease.epoch } })).rejects.toThrow(/lease_lost/);
    const repeated = await repository.recordVerifiedWorks({ sessionId: session.id, workIds: [toWorkId('work-known')] }); expect(repeated.revision).toBe(late.revision);
  });
  it('rechecks an expired fence inside the metadata write lock after a queued CAS', async () => {
    const { root, now, setClock } = await setup(), storage = new DelayedMutationStorage(root), repository = new JsonConversationAgentSessionRepository(storage, projectId, now), session = initial();
    await repository.create(session); const claim = await repository.acquireLease({ sessionId: session.id, ownerId: 'owner-one', ttlMs: 1000 });
    const next = updateConversationAgentSession(claim.session, { registeredWorkIds: [toWorkId('work-projected')] }, toIsoTimestamp('2026-10-04T12:00:01.000Z'));
    storage.beforeMutation = () => setClock(claim.lease.expiresAt + 1);
    await expect(repository.commit({ sessionId: session.id, expectedRevision: claim.session.revision, session: next, fence: { ownerId: claim.lease.ownerId, epoch: claim.lease.epoch } })).rejects.toThrow(/lease_lost/);
    storage.beforeMutation = undefined;
    expect((await repository.get(session.id))?.revision).toBe(claim.session.revision);
  });
  it('persists deadline expiry locally without using a dead lease or resetting consumed units', async () => {
    const { repository, setClock } = await setup(), waiting = await prepareWaiting(repository);
    const resumed = await repository.beginResume(resume(waiting));
    await expect(repository.expireSession({ sessionId: waiting.id })).rejects.toThrow(/unavailable/);
    setClock(waiting.budget.deadlineAt);
    const expired = await repository.expireSession({ sessionId: waiting.id });
    expect(expired.status).toBe('expired'); expect(expired.lease).toBeUndefined(); expect(expired.waiting).toBeUndefined(); expect(expired.budget).toEqual(waiting.budget);
    expect(expired.childSegments[1].status).toBe('settled');
    expect((await repository.expireSession({ sessionId: waiting.id })).revision).toBe(expired.revision);
    await expect(repository.acquireLease({ sessionId: waiting.id, ownerId: 'owner-new', ttlMs: 1000 })).rejects.toThrow(/unavailable/);
    expect(expired.leaseEpoch).toBe(resumed.lease.epoch);
  });
  it('freezes observed unknown effects only after the lease stops and retains known Work receipts', async () => {
    const { repository, setClock } = await setup(), session = await prepareWaiting(repository), resumed = await repository.beginResume(resume(session));
    await expect(repository.markUnknownObserved({ sessionId: session.id, expectedRevision: resumed.session.revision, workIds: [toWorkId('work-known')] })).rejects.toThrow(/lease_busy/);
    setClock(resumed.lease.expiresAt + 1);
    const frozen = await repository.markUnknownObserved({ sessionId: session.id, expectedRevision: resumed.session.revision, workIds: [toWorkId('work-known')] });
    expect(frozen.status).toBe('needs_reconciliation'); expect(frozen.childSegments[1].status).toBe('unknown'); expect(frozen.budget).toEqual(session.budget); expect(frozen.registeredWorkIds).toEqual(['work-known']);
    expect(frozen.lease).toBeUndefined(); expect(frozen.waiting).toBeUndefined();
    expect((await repository.markUnknownObserved({ sessionId: session.id })).revision).toBe(frozen.revision);
    setClock(session.budget.deadlineAt + 1); expect((await repository.expireSession({ sessionId: session.id })).status).toBe('needs_reconciliation');
    await expect(repository.beginResume(resume(frozen, '-after-unknown'))).rejects.toThrow(/unavailable/);
  });
  it('allows late uncertainty to freeze an expired root without reopening it', async () => {
    const { repository, setClock } = await setup(), waiting = await prepareWaiting(repository);
    setClock(waiting.budget.deadlineAt); const expired = await repository.expireSession({ sessionId: waiting.id });
    const frozen = await repository.markUnknownObserved({ sessionId: waiting.id, expectedRevision: expired.revision });
    expect(frozen.status).toBe('needs_reconciliation'); expect(frozen.budget).toEqual(expired.budget);
    await expect(repository.acquireLease({ sessionId: waiting.id, ownerId: 'owner-new', ttlMs: 1000 })).rejects.toThrow(/unavailable/);
  });
  it('persists separate planning submissions for a resumed child without regressing the initial facts', async () => {
    const { repository } = await setup(), waiting = await prepareWaiting(repository);
    const initialReceived = updateConversationAgentSession(waiting, { planningBoundary: 'received', childSegments: [{ ...waiting.childSegments[0], planningBoundary: 'received' }] }, waiting.updatedAt);
    const recorded = await repository.commit({ sessionId: waiting.id, expectedRevision: waiting.revision, session: initialReceived });
    const resumed = await repository.beginResume(resume(recorded)); expect(resumed.session.childSegments[1].planningBoundary).toBe('not_started');
    const secondSubmitted = updateConversationAgentSession(resumed.session, { childSegments: resumed.session.childSegments.map(segment => segment.runId === 'run-resumed' ? { ...segment, planningBoundary: 'submitted' } : segment) }, resumed.session.updatedAt);
    const committed = await repository.commit({ sessionId: waiting.id, expectedRevision: resumed.session.revision, session: secondSubmitted, fence: { ownerId: resumed.lease.ownerId, epoch: resumed.lease.epoch } });
    expect(committed.planningBoundary).toBe('received'); expect(committed.childSegments[0].planningBoundary).toBe('received'); expect(committed.childSegments[1].planningBoundary).toBe('submitted');
    const regression = updateConversationAgentSession(committed, { childSegments: committed.childSegments.map(segment => segment.runId === 'run-resumed' ? { ...segment, planningBoundary: 'received' } : segment) }, committed.updatedAt);
    await repository.commit({ sessionId: waiting.id, expectedRevision: committed.revision, session: regression, fence: { ownerId: resumed.lease.ownerId, epoch: resumed.lease.epoch } });
    expect(() => updateConversationAgentSession(regression, { childSegments: regression.childSegments.map(segment => segment.runId === 'run-resumed' ? { ...segment, planningBoundary: 'submitted' } : segment) }, regression.updatedAt)).toThrow(/regress/);
  });
});
