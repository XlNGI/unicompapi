import type { ConversationCompletionCoordinator } from '../../application/conversation-completion-coordinator';
import type { ConversationParentRunDto } from '../../shared/chat-context-ipc';

type ParentRunSnapshot = NonNullable<Awaited<ReturnType<ConversationCompletionCoordinator['inspect']>>>;

/** A failed settlement journal dominates a stale completed entity projection. */
export function projectConversationParentRun(snapshot: ParentRunSnapshot): ConversationParentRunDto {
  const { run, intent } = snapshot;
  const frozen = run.status === 'needs_reconciliation' || intent?.stage === 'needs_reconciliation';
  const acknowledged = Boolean(run.reconciliationAcknowledgement) && intent?.stage !== 'needs_reconciliation';
  return {
    responseExecutionId: run.responseExecutionId!, sourceMessageId: run.sourceMessageId,
    state: frozen ? 'needs_reconciliation' : run.status,
    runRevision: run.revision,
    ...(run.reconciliationReason ?? intent?.decision.reconciliationReason
      ? { reconciliationReason: run.reconciliationReason ?? intent?.decision.reconciliationReason } : {}),
    registeredWorkCount: new Set(intent?.decision.registeredWorkIds ?? []).size,
    acknowledged
  };
}
