import type { ConversationAgentRunId, ConversationId, ProjectId, WorkId } from '../domain';

export interface ConversationAgentRecoveryCandidate {
  readonly sessionId: ConversationAgentRunId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
}
export interface ConversationAgentRecoveryClaim {
  readonly ownerId: string;
  readonly epoch: number;
  /** This reads the primary lease; a cached or backup lease must not authorize a write. */
  assertCurrent(): Promise<void>;
}
export interface ConversationAgentRecoveryFacts {
  readonly metadata: 'primary' | 'untrusted';
  readonly session: 'active' | 'waiting_user' | 'waiting_authorization' | 'needs_reconciliation' | 'expired' | 'closed';
  readonly modelBoundary: 'not_started' | 'submitted' | 'received' | 'unknown';
  readonly response: 'missing' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly documentTasks: readonly ('prepared' | 'running' | 'registered' | 'failed' | 'cancelled' | 'unknown')[];
  readonly mutationJournal: 'none' | 'committed' | 'uncommitted' | 'unknown';
  readonly registeredWorks: readonly { readonly workId: WorkId; readonly validation: 'valid' | 'invalid' | 'unknown' }[];
  /** Registration/manifest has been checked independently of a mutation journal, which generation may not use. */
  readonly registrationComplete: boolean;
  /** True only after inspecting the durable admission records, never inferred from missing output. */
  readonly noEffectProven: boolean;
  readonly knownTerminal?: 'completed' | 'failed' | 'cancelled';
  readonly acknowledgedClosed?: boolean;
}
export type ConversationAgentRecoveryFreezeReason = 'metadata_untrusted' | 'unknown_result' | 'registration_incomplete' | 'file_validation_failed';
export interface ConversationAgentRecoveryCoordinatorOptions {
  readonly listCandidates: () => Promise<readonly ConversationAgentRecoveryCandidate[]>;
  readonly claim: (candidate: ConversationAgentRecoveryCandidate) => Promise<ConversationAgentRecoveryClaim | undefined>;
  readonly inspect: (candidate: ConversationAgentRecoveryCandidate, claim: ConversationAgentRecoveryClaim) => Promise<ConversationAgentRecoveryFacts>;
  readonly freeze: (candidate: ConversationAgentRecoveryCandidate, claim: ConversationAgentRecoveryClaim, reason: ConversationAgentRecoveryFreezeReason, registeredWorkIds: readonly WorkId[]) => Promise<void>;
  readonly settleKnown: (candidate: ConversationAgentRecoveryCandidate, claim: ConversationAgentRecoveryClaim, status: 'completed' | 'failed' | 'cancelled', registeredWorkIds: readonly WorkId[]) => Promise<void>;
  readonly preserveWaiting: (candidate: ConversationAgentRecoveryCandidate, claim: ConversationAgentRecoveryClaim) => Promise<void>;
  readonly offerContinuation: (candidate: ConversationAgentRecoveryCandidate, claim: ConversationAgentRecoveryClaim) => Promise<void>;
  readonly release: (candidate: ConversationAgentRecoveryCandidate, claim: ConversationAgentRecoveryClaim) => Promise<void>;
  readonly onIssue?: (error: unknown, candidate: ConversationAgentRecoveryCandidate) => void;
  readonly maxCandidates?: number;
}
export interface ConversationAgentRecoveryReport {
  readonly inspected: number;
  readonly busy: number;
  readonly frozen: number;
  readonly settled: number;
  readonly waiting: number;
  readonly offered: number;
  readonly failed: number;
}

/** One startup owner and one local repair path. No model or tool execution capability is accepted. */
export class ConversationAgentRecoveryCoordinator {
  private running?: Promise<ConversationAgentRecoveryReport>;
  constructor(private readonly options: ConversationAgentRecoveryCoordinatorOptions) {
    const limit = options.maxCandidates ?? 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new TypeError('invalid_recovery_scan_limit');
  }
  recover(signal?: AbortSignal): Promise<ConversationAgentRecoveryReport> {
    if (this.running) return this.running;
    const operation = this.scan(signal);
    this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = undefined; }).catch(() => undefined);
    return operation;
  }
  private async scan(signal?: AbortSignal): Promise<ConversationAgentRecoveryReport> {
    const report = { inspected: 0, busy: 0, frozen: 0, settled: 0, waiting: 0, offered: 0, failed: 0 };
    const candidates = await this.options.listCandidates();
    if (candidates.length > (this.options.maxCandidates ?? 1024)) throw new Error('recovery_scan_limit_exceeded');
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      let claim: ConversationAgentRecoveryClaim | undefined;
      try {
        claim = await this.options.claim(candidate);
        if (!claim) { report.busy++; continue; }
        await claim.assertCurrent();
        let facts: ConversationAgentRecoveryFacts;
        try { facts = await this.options.inspect(candidate, claim); }
        catch (error) {
          await claim.assertCurrent();
          await this.options.freeze(candidate, claim, 'metadata_untrusted', []);
          this.options.onIssue?.(error, candidate); report.inspected++; report.frozen++; continue;
        }
        await claim.assertCurrent();
        report.inspected++;
        if (facts.session === 'closed' && facts.acknowledgedClosed && facts.metadata === 'primary') continue;
        const works = facts.metadata === 'primary' ? [...new Set(facts.registeredWorks.filter(work => work.validation === 'valid').map(work => work.workId))] : [];
        const reason = this.freezeReason(facts);
        if (reason) { await this.options.freeze(candidate, claim, reason, works); report.frozen++; }
        else if (facts.session === 'expired' || facts.session === 'closed') {
          // Existing terminal state is never reopened by a startup scan.
        }
        else if (facts.session === 'waiting_user' || facts.session === 'waiting_authorization') {
          await this.options.preserveWaiting(candidate, claim); report.waiting++;
        }
        else if (facts.knownTerminal) {
          await this.options.settleKnown(candidate, claim, facts.knownTerminal, works); report.settled++;
        }
        else if (facts.noEffectProven && facts.modelBoundary === 'not_started' && facts.mutationJournal === 'none' && facts.registeredWorks.length === 0 &&
          facts.documentTasks.every(status => status === 'prepared' || status === 'failed' || status === 'cancelled')) {
          await this.options.offerContinuation(candidate, claim); report.offered++;
        }
        else { await this.options.freeze(candidate, claim, 'unknown_result', works); report.frozen++; }
      } catch (error) { report.failed++; this.options.onIssue?.(error, candidate); }
      finally { if (claim) await this.options.release(candidate, claim).catch(error => this.options.onIssue?.(error, candidate)); }
    }
    return report;
  }
  private freezeReason(facts: ConversationAgentRecoveryFacts): ConversationAgentRecoveryFreezeReason | undefined {
    if (facts.metadata !== 'primary') return 'metadata_untrusted';
    if (facts.registeredWorks.some(work => work.validation === 'invalid')) return 'file_validation_failed';
    if (facts.session === 'needs_reconciliation' || facts.modelBoundary === 'submitted' || facts.modelBoundary === 'unknown' || facts.response === 'unknown' ||
      facts.documentTasks.some(status => status === 'running' || status === 'unknown') || facts.mutationJournal === 'unknown' || facts.registeredWorks.some(work => work.validation === 'unknown')) return 'unknown_result';
    if (facts.mutationJournal === 'uncommitted' || facts.registeredWorks.length && !facts.registrationComplete) return 'registration_incomplete';
    return undefined;
  }
}
