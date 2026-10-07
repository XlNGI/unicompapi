import { describe, expect, it } from 'vitest';
import { ConversationAgentRecoveryCoordinator, type ConversationAgentRecoveryFacts, type ConversationAgentRecoveryClaim } from '../../src/application/conversation-agent-recovery-coordinator';
import { toConversationAgentRunId, toConversationId, toProjectId, toWorkId } from '../../src/domain';

const candidate = { sessionId: toConversationAgentRunId('recovery-session'), projectId: toProjectId('recovery-project'), conversationId: toConversationId('recovery-conversation') };
function fixture(patch: Partial<ConversationAgentRecoveryFacts> = {}) {
  let epoch = 1, currentOwner: string | undefined, inspectCount = 0;
  const effects: string[] = [], preserved: string[][] = [];
  const facts: ConversationAgentRecoveryFacts = { metadata: 'primary', session: 'active', modelBoundary: 'not_started', response: 'pending', documentTasks: ['prepared'], mutationJournal: 'none', registeredWorks: [], registrationComplete: true, noEffectProven: true, ...patch };
  const create = (ownerId: string, mutateDuringInspect?: () => void) => new ConversationAgentRecoveryCoordinator({
    listCandidates: async () => [candidate],
    claim: async () => {
      if (currentOwner) return undefined;
      currentOwner = ownerId;
      const claimed = epoch;
      return { ownerId, epoch: claimed, assertCurrent: async () => { if (currentOwner !== ownerId || epoch !== claimed) throw new Error('lease_lost'); } };
    },
    inspect: async () => { inspectCount++; mutateDuringInspect?.(); return facts; },
    freeze: async (_candidate, claim, reason, works) => { await claim.assertCurrent(); effects.push(`freeze:${reason}`); preserved.push([...works]); },
    settleKnown: async (_candidate, claim, status, works) => { await claim.assertCurrent(); effects.push(`settle:${status}`); preserved.push([...works]); },
    preserveWaiting: async (_candidate, claim) => { await claim.assertCurrent(); effects.push('waiting'); },
    offerContinuation: async (_candidate, claim) => { await claim.assertCurrent(); effects.push('offer'); },
    release: async (_candidate, claim) => { if (epoch === claim.epoch && currentOwner === claim.ownerId) currentOwner = undefined; },
    onIssue: () => undefined
  });
  return { create, effects, preserved, get inspectCount() { return inspectCount; }, takeover() { epoch++; currentOwner = 'replacement-owner'; } };
}
describe('ConversationAgentRecoveryCoordinator', () => {
  it('offers only explicit continuation after proven absence of HTTP and side effects', async () => {
    const state = fixture();
    expect(await state.create('host-a').recover()).toMatchObject({ inspected: 1, offered: 1, frozen: 0 });
    expect(state.effects).toEqual(['offer']);
  });
  it.each([
    { modelBoundary: 'submitted' as const }, { noEffectProven: false }, { response: 'unknown' as const },
    { documentTasks: ['running' as const] }, { mutationJournal: 'unknown' as const }, { session: 'needs_reconciliation' as const }
  ])('does not replay an uncertain admission: %j', async patch => {
    const state = fixture(patch);
    expect(await state.create('host-a').recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect(state.effects).toEqual(['freeze:unknown_result']);
  });
  it('preserves a known registered file while freezing a registration crash', async () => {
    const state = fixture({ modelBoundary: 'received', registeredWorks: [{ workId: toWorkId('recovered-work'), validation: 'valid' }], registrationComplete: false });
    await state.create('host-a').recover();
    expect(state.effects).toEqual(['freeze:registration_incomplete']);
    expect(state.preserved).toEqual([['recovered-work']]);
  });
  it('settles only local known facts without requiring generation to have a mutation journal', async () => {
    const state = fixture({ modelBoundary: 'received', response: 'completed', documentTasks: ['registered'], knownTerminal: 'completed', noEffectProven: false,
      registeredWorks: [{ workId: toWorkId('known-work'), validation: 'valid' }] });
    expect(await state.create('host-a').recover()).toMatchObject({ settled: 1, offered: 0 });
    expect(state.effects).toEqual(['settle:completed']); expect(state.preserved).toEqual([['known-work']]);
  });
  it('never trusts backup or corrupt metadata and does not claim its Work ids', async () => {
    const state = fixture({ metadata: 'untrusted', registeredWorks: [{ workId: toWorkId('untrusted-work'), validation: 'valid' }] });
    await state.create('host-a').recover();
    expect(state.effects).toEqual(['freeze:metadata_untrusted']); expect(state.preserved).toEqual([[]]);
  });
  it('keeps awaiting user or authorization and does not start a new segment', async () => {
    for (const session of ['waiting_user', 'waiting_authorization'] as const) {
      const state = fixture({ session, knownTerminal: 'failed' });
      expect(await state.create('host-a').recover()).toMatchObject({ waiting: 1, offered: 0 });
      expect(state.effects).toEqual(['waiting']);
    }
  });
  it('does not reopen cancelled or expired sessions', async () => {
    for (const session of ['closed', 'expired'] as const) {
      const state = fixture({ session });
      await state.create('host-a').recover(); expect(state.effects).toEqual([]);
    }
  });
  it('fences a previous owner after an expiry takeover during inspection', async () => {
    const state = fixture();
    expect(await state.create('host-a', () => state.takeover()).recover()).toMatchObject({ failed: 1, offered: 0, frozen: 0 });
    expect(state.effects).toEqual([]);
  });
  it('allows only one recovery owner and deduplicates concurrent scans on the same coordinator', async () => {
    let releaseInspection!: () => void;
    const gate = new Promise<void>(resolve => { releaseInspection = resolve; });
    let claim: ConversationAgentRecoveryClaim | undefined, offered = 0;
    const create = (ownerId: string) => new ConversationAgentRecoveryCoordinator({
      listCandidates: async () => [candidate], claim: async () => {
        if (claim) return undefined;
        return claim = { ownerId, epoch: 1, assertCurrent: async () => { if (claim?.ownerId !== ownerId) throw new Error('lease_lost'); } };
      },
      inspect: async () => { await gate; return { metadata: 'primary', session: 'active', modelBoundary: 'not_started', response: 'pending', documentTasks: [], mutationJournal: 'none', registeredWorks: [], registrationComplete: true, noEffectProven: true }; },
      freeze: async () => undefined, settleKnown: async () => undefined, preserveWaiting: async () => undefined,
      offerContinuation: async () => { offered++; }, release: async (_candidate, owned) => { if (claim === owned) claim = undefined; }
    });
    const first = create('host-a'), second = create('host-b');
    const firstScan = first.recover(); expect(first.recover()).toBe(firstScan);
    await Promise.resolve(); await Promise.resolve();
    expect(await second.recover()).toMatchObject({ busy: 1, inspected: 0 });
    releaseInspection(); await firstScan; expect(offered).toBe(1);
  });
  it('freezes unreadable inspection without starting any execution', async () => {
    const state = fixture(); const coordinator = state.create('host-a');
    const options = (coordinator as unknown as { options: { inspect: () => Promise<ConversationAgentRecoveryFacts> } }).options;
    options.inspect = async () => { throw new Error('metadata_parse_failed'); };
    expect(await coordinator.recover()).toMatchObject({ frozen: 1, offered: 0 });
    expect(state.effects).toEqual(['freeze:metadata_untrusted']);
  });
  it('rejects an oversized scan before claiming any lease', async () => {
    const coordinator = new ConversationAgentRecoveryCoordinator({ listCandidates: async () => [candidate, candidate], maxCandidates: 1,
      claim: async () => { throw new Error('must_not_claim'); }, inspect: async () => { throw new Error('must_not_inspect'); }, freeze: async () => undefined,
      settleKnown: async () => undefined, preserveWaiting: async () => undefined, offerContinuation: async () => undefined, release: async () => undefined });
    await expect(coordinator.recover()).rejects.toThrow('recovery_scan_limit_exceeded');
  });
});
