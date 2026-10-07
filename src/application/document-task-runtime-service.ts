import {
  createDocumentTaskRuntime, createDocumentToolRegistry, parseDocumentTaskRuntime,
  toIsoTimestamp, updateDocumentTaskRuntime,
  type DocumentTaskRuntime, type DocumentTaskRuntimeRepository,
  type DocumentTaskRuntimeStatus, type DocumentToolObservation, type DocumentToolId
} from '../domain';
import { createCanonicalToolRegistry, deriveAvailableToolSet, type ToolExecutionContext } from '../domain/entities/canonical-tool-contract';

export type DocumentTaskRuntimeScope = Pick<DocumentTaskRuntime,
  'id' | 'projectId' | 'conversationId' | 'executionId'>;

export class DocumentTaskRuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTaskRuntimeConflictError';
  }
}

/** The host resolves actual conversation/message ownership, grants and pinned
 * attachment/work/page versions from authoritative local repositories. */
export interface DocumentTaskRuntimeServiceOptions {
  readonly validateBindings: (runtime: DocumentTaskRuntime) => Promise<boolean>;
  readonly now?: () => string;
}

export class DocumentTaskRuntimeService {
  constructor(
    private readonly repository: DocumentTaskRuntimeRepository,
    private readonly options: DocumentTaskRuntimeServiceOptions
  ) {}

  async create(input: Omit<Parameters<typeof createDocumentTaskRuntime>[0], 'createdAt'>): Promise<DocumentTaskRuntime> {
    const runtime = createDocumentTaskRuntime({ ...input, createdAt: this.now() });
    await this.assertBindings(runtime);
    await this.repository.create(runtime);
    return runtime;
  }

  async require(scope: DocumentTaskRuntimeScope): Promise<DocumentTaskRuntime> {
    if (scope.projectId !== this.repository.projectId) throw conflict('runtime_scope_mismatch');
    const stored = await this.repository.get(scope.id);
    if (!stored) throw conflict('runtime_not_found');
    const runtime = parseDocumentTaskRuntime(stored);
    if (runtime.projectId !== scope.projectId || runtime.conversationId !== scope.conversationId ||
        runtime.executionId !== scope.executionId) throw conflict('runtime_scope_mismatch');
    return runtime;
  }

  /** Write ahead: only the caller receiving execute=true may perform the tool. */
  async beginToolCall(scope: DocumentTaskRuntimeScope, input: {
    readonly callId: string; readonly toolId: DocumentToolId; readonly inputHash: string;
  }, executionContext?: ToolExecutionContext): Promise<{ readonly runtime: DocumentTaskRuntime; readonly execute: boolean }> {
    const runtime = await this.require(scope);
    await this.assertBindings(runtime);
    if (executionContext && (executionContext.projectContext.projectId !== runtime.projectId ||
        executionContext.operation !== runtime.operation || executionContext.abortSignal.aborted ||
        !deriveAvailableToolSet(createCanonicalToolRegistry(), { ...executionContext, implementedToolIds: [input.toolId] })
          .some(contract => contract.toolId === input.toolId))) throw conflict('TOOL_PRECONDITION_FAILED');
    const previous = runtime.toolCalls.find(call => call.id === input.callId);
    if (previous) {
      if (previous.toolId !== input.toolId || previous.inputHash !== input.inputHash) throw conflict('call_id_conflict');
      if (['started', 'unknown'].includes(previous.status)) throw conflict('reconciliation_required');
      return { runtime, execute: false };
    }
    if (runtime.toolCalls.some(call => ['started', 'unknown'].includes(call.status))) throw conflict('reconciliation_required');
    if (!this.canResume(runtime)) throw conflict('runtime_not_resumable');
    const definition = createDocumentToolRegistry().get(input.toolId);
    if (!definition) throw conflict('tool_not_allowed');
    if (!executionContext && runtime.operation === 'create' && definition.requiresExistingDocument) {
      throw conflict('TOOL_PRECONDITION_FAILED');
    }
    const costUnits = runtime.checkpoint.costUnits + definition.maxCostUnits;
    const step = runtime.checkpoint.step + 1;
    if (step > runtime.budget.maxSteps || costUnits > runtime.budget.budgetUnits) throw conflict('runtime_budget_exceeded');
    const next = await this.save(runtime, {
      status: 'running',
      checkpoint: { stage: 'tool', step, costUnits, lastToolCallId: input.callId },
      toolCalls: [...runtime.toolCalls, { id: input.callId, toolId: input.toolId,
        inputHash: input.inputHash, step, status: 'started' }]
    });
    return { runtime: next, execute: true };
  }

  async recordObservation(scope: DocumentTaskRuntimeScope, callId: string,
    observation: DocumentToolObservation,
    options: { readonly outcomeUnknown?: boolean } = {}): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    const call = runtime.toolCalls.find(item => item.id === callId);
    if (!call || call.step !== observation.step || call.toolId !== observation.toolId) throw conflict('observation_call_mismatch');
    const duplicate = runtime.observations.find(item => item.step === call.step);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(observation)) throw conflict('observation_conflict');
      return runtime;
    }
    if (runtime.status !== 'running' || call.status !== 'started') throw conflict('reconciliation_required');
    // The write-ahead call already captured and validated its immutable scope.
    // Recording its result is settlement, not permission for another operation.
    // Revocation or a later document revision must not erase an executed fact.
    // A thrown write may already have changed the candidate: it is not safe to retry.
    // Callers that know the write never started may explicitly record a settled
    // validation/authorization failure instead of forcing reconciliation.
    if (!observation.ok && options.outcomeUnknown !== false &&
        createDocumentToolRegistry().get(call.toolId)!.requiresWrite) {
      return this.reconcile(runtime);
    }
    return this.save(runtime, {
      toolCalls: runtime.toolCalls.map(item => item.id === callId
        ? { ...item, status: observation.ok ? 'completed' : 'failed' } : item),
      observations: [...runtime.observations, observation]
    });
  }

  /** Called after a loop ends or process restart, never while its owner is active.
   * Unsettled calls are not replayed, even when the operation was read-only. */
  async recover(scope: DocumentTaskRuntimeScope): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (runtime.status === 'needs_reconciliation') return runtime;
    if (runtime.toolCalls.some(call => call.status === 'started')) return this.reconcile(runtime);
    if (['cancelled', 'failed', 'completed'].includes(runtime.status)) return runtime;
    await this.assertBindings(runtime);
    if (!this.canResume(runtime)) return this.save(runtime, { status: 'failed' });
    return runtime.status === 'running' ? this.save(runtime, { status: 'paused' }) : runtime;
  }

  /** Claim the local generation lifecycle before the first platform side effect. */
  async start(scope: DocumentTaskRuntimeScope): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (runtime.status === 'running') {
      await this.assertBindings(runtime);
      return runtime;
    }
    if (runtime.status !== 'planning' && runtime.status !== 'paused') {
      if (['cancelled', 'failed', 'completed', 'needs_reconciliation'].includes(runtime.status)) return runtime;
      throw conflict('runtime_not_resumable');
    }
    await this.assertBindings(runtime);
    return this.save(runtime, { status: 'running', checkpoint: runtime.checkpoint });
  }

  /** Formal completion is unavailable until the publication adapter exists. */
  async setStatus(scope: DocumentTaskRuntimeScope,
    status: Extract<DocumentTaskRuntimeStatus, 'waiting_input' | 'paused' | 'cancelled' | 'failed'>
  ): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (runtime.toolCalls.some(call => call.status === 'started')) return this.reconcile(runtime);
    return this.save(runtime, { status });
  }

  /** Mark the runtime complete only after the platform has registered a Work. */
  async complete(scope: DocumentTaskRuntimeScope, workId: string): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (runtime.status === 'completed') {
      if (runtime.workRef?.kind === 'registered' && runtime.workRef.ref === workId) return runtime;
      throw conflict('runtime_completion_conflict');
    }
    if (runtime.status !== 'running' && runtime.status !== 'paused') throw conflict('runtime_not_completable');
    if (runtime.toolCalls.some(call => ['started', 'unknown'].includes(call.status))) {
      return this.reconcile(runtime);
    }
    if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(workId)) throw conflict('work_id_invalid');
    return this.save(runtime, {
      status: 'completed',
      checkpoint: { ...runtime.checkpoint, stage: 'complete' },
      workRef: { kind: 'registered', ref: workId }
    });
  }

  /** A registered artifact is a durable fact even when its tool outcome is unknown. */
  async recordRegisteredWork(scope: DocumentTaskRuntimeScope, workId: string): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(workId)) throw conflict('work_id_invalid');
    if (runtime.workRef?.kind === 'registered') {
      if (runtime.workRef.ref !== workId) throw conflict('runtime_completion_conflict');
      return runtime;
    }
    if (!['running', 'paused', 'failed', 'cancelled', 'needs_reconciliation'].includes(runtime.status)) throw conflict('runtime_not_completable');
    return this.save(runtime, { workRef: { kind: 'registered', ref: workId } });
  }

  /** Storage may have committed a write-ahead call whose receipt was lost. */
  async markNeedsReconciliation(scope: DocumentTaskRuntimeScope): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (runtime.status === 'needs_reconciliation') return runtime;
    if (['completed', 'failed', 'cancelled'].includes(runtime.status)) throw conflict('runtime_not_resumable');
    return this.reconcile(runtime);
  }

  /** Reading an existing artifact completes an analysis without publishing a new Work. */
  async completeRead(scope: DocumentTaskRuntimeScope): Promise<DocumentTaskRuntime> {
    const runtime = await this.require(scope);
    if (runtime.operation !== 'analyze') throw conflict('runtime_not_completable');
    if (runtime.status === 'completed') return runtime;
    if (runtime.toolCalls.some(call => ['started', 'unknown'].includes(call.status))) return this.reconcile(runtime);
    if (!['running', 'paused'].includes(runtime.status) || runtime.toolCalls.length === 0 ||
        runtime.toolCalls.at(-1)?.status !== 'completed' || !runtime.observations.some(item => item.ok && item.toolId === 'read_document_structure')) throw conflict('runtime_not_completable');
    return this.save(runtime, { status: 'completed', checkpoint: { ...runtime.checkpoint, stage: 'complete' } });
  }

  canResume(runtime: DocumentTaskRuntime): boolean {
    return ['planning', 'running', 'waiting_input', 'paused'].includes(runtime.status) &&
      !runtime.toolCalls.some(call => ['started', 'unknown'].includes(call.status)) &&
      Date.parse(this.now()) < (runtime.budget.deadlineAt ?? Date.parse(runtime.createdAt) + runtime.budget.timeoutMs);
  }

  private async assertBindings(runtime: DocumentTaskRuntime): Promise<void> {
    if (runtime.projectId !== this.repository.projectId ||
        !await this.options.validateBindings(runtime)) throw conflict('runtime_binding_or_revision_invalid');
  }

  private reconcile(runtime: DocumentTaskRuntime): Promise<DocumentTaskRuntime> {
    return this.save(runtime, {
      status: 'needs_reconciliation',
      checkpoint: { ...runtime.checkpoint, stage: 'reconcile' },
      toolCalls: runtime.toolCalls.map(call => call.status === 'started' ? { ...call, status: 'unknown' } : call)
    });
  }

  private async save(runtime: DocumentTaskRuntime,
    changes: Omit<Parameters<typeof updateDocumentTaskRuntime>[1], 'updatedAt'>
  ): Promise<DocumentTaskRuntime> {
    const next = updateDocumentTaskRuntime(runtime, { ...changes, updatedAt: this.now() });
    await this.repository.save(next, runtime.revision);
    return next;
  }

  private now() {
    return toIsoTimestamp((this.options.now ?? (() => new Date().toISOString()))());
  }
}

function conflict(code: string): DocumentTaskRuntimeConflictError {
  return new DocumentTaskRuntimeConflictError(code);
}
