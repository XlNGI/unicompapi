import { describe, expect, it } from 'vitest';
import {
  createConversationAgentSession, parseConversationAgentSession, updateConversationAgentSession,
  toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toMessageId, toProjectId, toIsoTimestamp, toWorkId
} from '../../src/domain';
const t0 = toIsoTimestamp('2026-10-04T12:00:00.000Z'), t1 = toIsoTimestamp('2026-10-04T12:00:01.000Z'), digest = 'a'.repeat(64);
function initial() {
  return createConversationAgentSession({ id: toConversationAgentRunId('session-root'), projectId: toProjectId('project-session'), conversationId: toConversationId('conversation-session'), sourceMessageId: toMessageId('message-original'),
    budget: { startedAt: Date.parse(t0), deadlineAt: Date.parse(t0) + 360000, maxToolCalls: 8, budgetUnits: 24 }, inputReferences: [{ kind: 'message', id: 'message-original', version: 0, contentHash: digest }],
    initialSegment: { runId: toConversationAgentRunId('session-root'), responseExecutionId: toConversationResponseExecutionId('response-initial'), sourceMessageId: toMessageId('message-original'), inputReferenceHash: digest, status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 }, createdAt: t0 });
}
describe('persistent root conversation session contract', () => {
  it('keeps the original source and bounded deadline separate from child responses', () => {
    const session = initial(); expect(parseConversationAgentSession(session)).toEqual(session);
    expect(session.childSegments[0].runId).toBe(session.id); expect(session.status).toBe('active');
    expect(JSON.stringify(session)).not.toContain('prompt');
  });
  it('accounts consumed counters from every immutable child segment', () => {
    const session = initial(), next = updateConversationAgentSession(session, { childSegments: [{ ...session.childSegments[0], toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 2 }], budget: { ...session.budget, toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 2 } }, t1);
    expect(next.budget.costUnitsUsed).toBe(8);
    expect(() => updateConversationAgentSession(next, { budget: { ...next.budget, costUnitsUsed: 0 } }, t1)).toThrow(/accounting/);
    expect(() => updateConversationAgentSession(next, { budget: { ...next.budget, costUnitsUsed: 0 }, childSegments: [{ ...next.childSegments[0], costUnitsUsed: 0 }] }, t1)).toThrow(/reset/);
  });
  it.each(['deadlineAt', 'startedAt', 'maxToolCalls', 'budgetUnits'] as const)('forbids resetting the root %s across waiting', key => {
    const session = initial(); expect(() => updateConversationAgentSession(session, { budget: { ...session.budget, [key]: session.budget[key] + 1 } }, t1)).toThrow();
  });
  it('requires a waiting checkpoint and matching authorization state', () => {
    const session = initial(); expect(() => updateConversationAgentSession(session, { status: 'waiting_user' }, t1)).toThrow(/checkpoint/);
    const waiting = { version: 1, reason: 'clarification' as const, allowedActions: ['reply' as const], resumeNonceHash: digest, inputReferenceHash: digest, preparedAt: t1 };
    const next = updateConversationAgentSession(session, { status: 'waiting_user', waitingVersion: 1, waiting, childSegments: [{ ...session.childSegments[0], status: 'waiting' }] }, t1);
    expect(next.waiting?.version).toBe(1);
    expect(() => updateConversationAgentSession(next, { waiting: { ...waiting, resumeNonceHash: 'b'.repeat(64) } }, t1)).toThrow(/version/);
    expect(() => parseConversationAgentSession({ ...next, status: 'waiting_authorization' })).toThrow(/conflict/);
  });
  it('rejects private text, absolute file paths and uncontrolled references', () => {
    const session = initial();
    expect(() => parseConversationAgentSession({ ...session, prompt: 'private enterprise content' })).toThrow(/unsupported/);
    expect(() => parseConversationAgentSession({ ...session, inputReferences: [{ ...session.inputReferences[0], id: 'C:\\private\\data.txt' }] })).toThrow(/reference/);
    expect(() => parseConversationAgentSession({ ...session, semanticPlanHash: 'API key or raw model plan' })).toThrow(/hash/);
    expect(() => parseConversationAgentSession({ ...session, inputReferences: [{ ...session.inputReferences[0], content: 'raw prompt' }] })).toThrow(/unsupported/);
  });
  it('never rebinds an old response or mutates a pinned input', () => {
    const session = initial();
    expect(() => updateConversationAgentSession(session, { childSegments: [{ ...session.childSegments[0], responseExecutionId: toConversationResponseExecutionId('response-new') }] }, t1)).toThrow(/immutable/);
    expect(() => updateConversationAgentSession(session, { inputReferences: [{ ...session.inputReferences[0], version: 1 }] }, t1)).toThrow(/immutable/);
  });
  it('keeps an unknown external result frozen while preserving registered work evidence', () => {
    const session = initial(), frozen = updateConversationAgentSession(session, { status: 'needs_reconciliation', childSegments: [{ ...session.childSegments[0], status: 'unknown' }], registeredWorkIds: [toWorkId('work-committed')] }, t1);
    expect(() => updateConversationAgentSession(frozen, { status: 'active', childSegments: [{ ...frozen.childSegments[0], status: 'active' }] }, t1)).toThrow();
    expect(() => updateConversationAgentSession(frozen, { registeredWorkIds: [] }, t1)).toThrow(/removed/);
  });
  it.each(['expired', 'closed'] as const)('never reopens a %s session', status => {
    const session = initial(), terminal = updateConversationAgentSession(session, { status, ...(status === 'closed' ? { closedReason: 'cancelled' as const } : {}), childSegments: [{ ...session.childSegments[0], status: 'settled' }] }, t1);
    expect(() => updateConversationAgentSession(terminal, { status: 'active', closedReason: undefined }, t1)).toThrow(/reopen/);
  });
  it('rejects unbounded leases and duplicate ownership', () => {
    const session = initial();
    expect(() => parseConversationAgentSession({ ...session, leaseEpoch: 1, lease: { ownerId: 'host-one', epoch: 1, acquiredAt: Date.parse(t1), expiresAt: Date.parse(t1) + 60_001 } })).toThrow(/bounded/);
    expect(() => parseConversationAgentSession({ ...session, childSegments: [session.childSegments[0], session.childSegments[0]] })).toThrow(/duplicate/);
  });
  it('records a monotonic initial external planning boundary and preserves uncertain legacy absence', () => {
    const session = initial(); expect(session.planningBoundary).toBe('not_started');
    const submitted = updateConversationAgentSession(session, { planningBoundary: 'submitted' }, t1);
    const received = updateConversationAgentSession(submitted, { planningBoundary: 'received' }, t1);
    expect(() => updateConversationAgentSession(received, { planningBoundary: 'submitted' }, t1)).toThrow(/regress/);
    expect(() => updateConversationAgentSession(submitted, { planningBoundary: undefined }, t1)).toThrow(/disappear/);
    const legacy = { ...session, planningBoundary: undefined }; expect(parseConversationAgentSession(legacy).planningBoundary).toBeUndefined();
    expect(() => updateConversationAgentSession(legacy, { planningBoundary: 'not_started' }, t1)).toThrow(/absence/);
    expect(() => parseConversationAgentSession({ ...session, planningBoundary: 'safe_to_replay' })).toThrow(/Unsupported/);
  });
  it('records separate submitted boundaries for each child and never uses missing legacy facts as proof', () => {
    const session = initial(); expect(session.childSegments[0].planningBoundary).toBe('not_started');
    const submitted = updateConversationAgentSession(session, { childSegments: [{ ...session.childSegments[0], planningBoundary: 'submitted' }] }, t1);
    const received = updateConversationAgentSession(submitted, { childSegments: [{ ...submitted.childSegments[0], planningBoundary: 'received' }] }, t1);
    expect(() => updateConversationAgentSession(received, { childSegments: [{ ...received.childSegments[0], planningBoundary: 'submitted' }] }, t1)).toThrow(/regress/);
    expect(() => updateConversationAgentSession(submitted, { childSegments: [{ ...submitted.childSegments[0], planningBoundary: undefined }] }, t1)).toThrow(/disappear/);
    const legacy = { ...session, childSegments: [{ ...session.childSegments[0], planningBoundary: undefined }] };
    expect(parseConversationAgentSession(legacy).childSegments[0].planningBoundary).toBeUndefined();
    expect(() => updateConversationAgentSession(legacy, { childSegments: [{ ...legacy.childSegments[0], planningBoundary: 'not_started' }] }, t1)).toThrow(/absence/);
  });
});
