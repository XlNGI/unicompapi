import { createHash } from 'node:crypto';
import { runDocumentAgentLoop, type DocumentAgentLoopOptions } from '../../application/document-agent-loop';
import { type DocumentTaskRuntimeScope, type DocumentTaskRuntimeService } from '../../application/document-task-runtime-service';
import type { DocumentAgentResult, DocumentTaskRuntime } from '../../domain';

/** Offline-capable composition root. The caller owns this execution exclusively;
 * recovery is allowed only after the previous executor has stopped. No Work is
 * registered here: model completion leaves a candidate checkpoint paused. */
export async function runPersistentDocumentAgent(options: {
  readonly service: DocumentTaskRuntimeService;
  readonly scope: DocumentTaskRuntimeScope;
  readonly execute: DocumentAgentLoopOptions['execute'];
  readonly nextDecision: DocumentAgentLoopOptions['nextDecision'];
  readonly allowedTools: NonNullable<DocumentAgentLoopOptions['allowedTools']>;
  readonly signal?: AbortSignal;
  readonly onEvent?: DocumentAgentLoopOptions['onEvent'];
  readonly now?: () => number;
}): Promise<{ readonly agent: DocumentAgentResult; readonly runtime: DocumentTaskRuntime }> {
  const { service, scope } = options;
  const runtime = await service.recover(scope);
  if (!service.canResume(runtime)) throw new Error('runtime_not_resumable');
  const remainingMs = Date.parse(runtime.createdAt) + runtime.budget.timeoutMs - (options.now ?? Date.now)();
  if (remainingMs <= 0) throw new Error('runtime_timeout');
  const agent = await runDocumentAgentLoop({
    ...runtime.budget,
    timeoutMs: Math.min(runtime.budget.timeoutMs, remainingMs),
    initialObservations: runtime.observations,
    allowedTools: options.allowedTools,
    signal: options.signal,
    // Loop completion is not publication. Only forward tool/planning progress;
    // the caller projects final runtime truth after this function has persisted it.
    onEvent: event => event.stage === 'completed' ? undefined : options.onEvent?.(event),
    nextDecision: options.nextDecision,
    execute: options.execute,
    onBeforeTool: async (request, context) => {
      const inputHash = createHash('sha256').update(JSON.stringify([request.toolId,
        Object.entries(request.input).sort(([a], [b]) => a.localeCompare(b)), request.reason])).digest('hex');
      const started = await service.beginToolCall(scope, {
        callId: 'step-' + context.step, toolId: request.toolId, inputHash
      });
      if (!started.execute || started.runtime.checkpoint.step !== context.step ||
          started.runtime.checkpoint.costUnits !== context.costUnits) throw new Error('runtime_step_conflict');
    },
    onObservation: async observation => {
      const saved = await service.recordObservation(scope, 'step-' + observation.step, observation);
      if (saved.status === 'needs_reconciliation') throw new Error('reconciliation_required');
    }
  });
  const recovered = await service.recover(scope);
  if (['needs_reconciliation', 'cancelled', 'failed', 'completed'].includes(recovered.status)) return { agent, runtime: recovered };
  const status = agent.state === 'cancelled' ? 'cancelled'
    : agent.state === 'completed' || agent.state === 'completed_unvalidated' ? 'paused' : 'failed';
  return { agent, runtime: await service.setStatus(scope, status) };
}
