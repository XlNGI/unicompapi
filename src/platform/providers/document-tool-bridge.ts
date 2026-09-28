import { createHash } from 'node:crypto';
import {
  createCanonicalToolRegistry, deriveAvailableToolSet, validateDocumentToolResult,
  type CanonicalToolId, type CanonicalToolRegistry, type CanonicalToolContract,
  type CanonicalToolArguments, type DocumentToolResult, type ToolExecutionContext
} from '../../domain/entities/canonical-tool-contract';
import { parseAtomicToolArguments, type DocumentAtomicToolBinding, type DocumentAtomicExecutionContext } from '../../application/document-atomic-tools';
import { DocumentTaskRuntimeConflictError, type DocumentTaskRuntimeScope, type DocumentTaskRuntimeService } from '../../application/document-task-runtime-service';
import type { DocumentToolObservation } from '../../domain/entities/document-agent';
import { providerToolsFromContracts, type ControlledProviderToolBridge, type ControlledProviderToolDefinition } from './provider-tool-calling';
import { emitProductionEvent } from '../conversation-production-trace';

export interface DocumentToolCallingBridgeOptions {
  readonly bindings: readonly DocumentAtomicToolBinding[];
  readonly registry?: CanonicalToolRegistry;
  /** Runtime-owned live state; requested again for advertising, queued calls and execution. */
  readonly getExecutionContext: () => ToolExecutionContext;
  readonly budgetUnits: number;
  readonly maxCalls: number;
  /** Host ceiling; a contract may impose a shorter per-tool timeout. */
  readonly timeoutMs: number;
  readonly runtime?: {
    readonly service: Pick<DocumentTaskRuntimeService, 'beginToolCall' | 'recordObservation'>;
    readonly scope: DocumentTaskRuntimeScope;
  };
}

/** One instance per task. Units are scheduling limits, never monetary prices. */
export function createDocumentToolCallingBridge(options: DocumentToolCallingBridgeOptions): {
  readonly tools: readonly ControlledProviderToolDefinition[];
  readonly bridge: ControlledProviderToolBridge;
  readonly spentCostUnits: () => number;
} {
  const budget = bounded(options.budgetUnits, 10_000);
  const maxCalls = bounded(options.maxCalls, 128);
  const hostTimeoutMs = bounded(options.timeoutMs, 900_000);
  const registry = options.registry ? createCanonicalToolRegistry([...options.registry.values()]) : createCanonicalToolRegistry();
  const bindings = new Map<CanonicalToolId, DocumentAtomicToolBinding>();
  for (const binding of options.bindings) {
    const canonical = registry.get(binding.contract.toolId);
    // The binding references a registered contract; it cannot override fields or metadata.
    if (!canonical || stable(canonical) !== stable(binding.contract) || bindings.has(canonical.toolId) ||
        'fields' in binding) throw new TypeError('tool_registry_invalid');
    bindings.set(canonical.toolId, { contract: canonical, authorize: binding.authorize, execute: binding.execute });
  }
  if (!bindings.size) throw new TypeError('tool_registry_invalid');
  const implementedToolIds = [...bindings.keys()];
  const initialContext = options.getExecutionContext();
  const taskDeadline = initialContext.taskContext.deadlineAt ?? Infinity;
  // Project and task identify the execution. The current Work/document is
  // intentionally mutable: a create tool may publish a Work that the next
  // read tool must consume in the same runtime session.
  const taskIdentity = stable([initialContext.projectContext.projectId, initialContext.taskContext.taskId]);
  const live = (): ToolExecutionContext => {
    const context = options.getExecutionContext();
    if (stable([context.projectContext.projectId, context.taskContext.taskId]) !== taskIdentity) throw new TypeError('runtime_scope_mismatch');
    return context;
  };
  const deadline = (context: ToolExecutionContext) => Math.min(taskDeadline, context.taskContext.deadlineAt ?? Infinity);
  const available = (context: ToolExecutionContext) => context.abortSignal.aborted || Date.now() >= deadline(context)
    ? [] : deriveAvailableToolSet(registry, { ...context, implementedToolIds });
  const calls = new Map<string, { fingerprint: string; result: Promise<Readonly<Record<string, unknown>>> }>();
  let spent = 0;
  let tail = Promise.resolve();
  let uncertain = false;

  return {
    get tools() { return uncertain ? [] : providerToolsFromContracts(available(live()), registry); },
    spentCostUnits: () => spent,
    bridge: {
      execute({ call, signal }) {
        if (signal.aborted) return Promise.resolve(failure('cancelled'));
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(call.id)) return Promise.resolve(failure('invalid_call_id'));
        const binding = bindings.get(call.name as CanonicalToolId);
        if (!binding) return Promise.resolve(failure('tool_not_allowed'));
        const contract = binding.contract;
        let selected: ToolExecutionContext;
        let args: CanonicalToolArguments;
        try {
          selected = live();
          args = parseAtomicToolArguments(binding, call.arguments);
        } catch { return Promise.resolve(failure('invalid_tool_arguments')); }
        if (selected.abortSignal.aborted) return Promise.resolve(failure('cancelled'));
        if (Date.now() >= deadline(selected)) return Promise.resolve(failure('tool_timeout'));
        if (!available(selected).some(item => item.toolId === contract.toolId)) {
          return report(contract, call.id, 'failed').then(() => failure('TOOL_PRECONDITION_FAILED'));
        }
        const bindingKey = stable([taskIdentity, selected.currentDocumentId, selected.revision]);
        const fingerprint = hash(stable([contract.toolId, contract.version, bindingKey, args]));
        const previous = calls.get(call.id);
        if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(failure('call_id_conflict'));
        if (calls.size >= maxCalls) return Promise.resolve(failure('tool_call_limit'));
        const result = tail.then(async (): Promise<Readonly<Record<string, unknown>>> => {
          if (signal.aborted || selected.abortSignal.aborted) return failure('cancelled');
          if (uncertain) return failure('reconciliation_required', true);
          const context = live();
          if (stable([taskIdentity, context.currentDocumentId, context.revision]) !== bindingKey ||
              !available(context).some(item => item.toolId === contract.toolId)) return failure('authorization_or_revision_invalid');
          if (spent + contract.execution.budgetUnits > budget) return failure('budget_exceeded');
          const controller = new AbortController();
          let invoked = false;
          let persistencePending = false;
          let runtimeStarted = false;
          let runtimeStep: number | undefined;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const cancellers: Array<() => void> = [];
          // Covers write-ahead persistence, authorization, execution and observation commit.
          const stopped = new Promise<DocumentToolResult>(resolve => {
            const stop = (code: string) => {
              if (controller.signal.aborted) return;
              controller.abort();
              uncertain = true;
              resolve(failure(code, persistencePending || (invoked && contract.preconditions.requiresWrite)));
            };
            for (const parent of [signal, context.abortSignal]) {
              const cancel = () => stop('cancelled');
              parent.addEventListener('abort', cancel, { once: true });
              cancellers.push(() => parent.removeEventListener('abort', cancel));
              if (parent.aborted) cancel();
            }
            timeout = setTimeout(() => stop('tool_timeout'), Math.max(0, Math.min(hostTimeoutMs, contract.execution.timeoutMs, deadline(context) - Date.now())));
          });
          const executionContext: DocumentAtomicExecutionContext = Object.freeze({
            ...context,
            projectContext: Object.freeze({ ...context.projectContext }),
            taskContext: freeze(structuredClone(context.taskContext)),
            authorization: freeze(structuredClone(context.authorization)),
            capabilities: Object.freeze([...context.capabilities]),
            currentDocumentIR: context.currentDocumentIR ? freeze(structuredClone(context.currentDocumentIR)) : undefined,
            abortSignal: controller.signal,
            callId: call.id,
            idempotencyKey: hash(stable([taskIdentity, call.id, contract.toolId, contract.version, bindingKey,
              contract.execution.idempotency.keyFields.map(key => args[key]), args]))
          });
          const execute = async (): Promise<DocumentToolResult> => {
            const authorized = await binding.authorize(args, executionContext);
            if (controller.signal.aborted) return failure('cancelled');
            await emitProductionEvent({ code: 'tool_authorization', status: authorized ? 'completed' : 'failed',
              operationId: call.id, facts: { tool: contract.diagnostics.traceType, purpose: 'tool' } });
            if (!authorized) return failure('authorization_or_revision_invalid');
            if (controller.signal.aborted) return failure('cancelled');
            const current = live();
            if (stable([taskIdentity, current.currentDocumentId, current.revision]) !== bindingKey ||
                !available(current).some(item => item.toolId === contract.toolId)) return failure('authorization_or_revision_invalid');
            spent += contract.execution.budgetUnits;
            await emitProductionEvent({ code: 'tool_call', status: 'started', operationId: call.id,
              facts: { tool: contract.diagnostics.traceType, purpose: 'tool' } });
            if (controller.signal.aborted) return failure('cancelled');
            invoked = true;
            const raw = await binding.execute(args, executionContext);
            if (controller.signal.aborted) return failure('cancelled', contract.preconditions.requiresWrite);
            let validated: DocumentToolResult;
            try { validated = validateDocumentToolResult(contract, raw); }
            catch {
              if (contract.preconditions.requiresWrite) uncertain = true;
              return failure('invalid_tool_result', contract.preconditions.requiresWrite);
            }
            if (validated.status === 'unknown') uncertain = true;
            return validateDocumentToolResult(contract, safeObservation({ ...validated,
              metadata: { ...validated.metadata, callId: call.id, toolId: contract.toolId,
                toolVersion: contract.version, costUnits: contract.execution.budgetUnits } }));
          };
          const lifecycle = async (): Promise<Readonly<Record<string, unknown>>> => {
            if (controller.signal.aborted) return failure('cancelled');
            if (options.runtime) {
              persistencePending = true;
              let checkpoint;
              try {
                checkpoint = await options.runtime.service.beginToolCall(options.runtime.scope, {
                  callId: call.id, toolId: contract.toolId, inputHash: fingerprint
                }, context);
              } catch (error) {
                // These conflicts are raised before the write-ahead claim. They are
                // known refusals, not an uncertain host write or storage failure.
                const code = error instanceof DocumentTaskRuntimeConflictError
                  ? error.message === 'runtime_binding_or_revision_invalid' || error.message === 'runtime_scope_mismatch'
                    ? 'authorization_or_revision_invalid'
                    : error.message === 'TOOL_PRECONDITION_FAILED' || error.message === 'tool_not_allowed'
                      ? 'TOOL_PRECONDITION_FAILED'
                      : error.message === 'runtime_budget_exceeded' ? 'budget_exceeded'
                        : error.message === 'call_id_conflict' ? 'call_id_conflict' : undefined
                  : undefined;
                if (!code) throw error;
                persistencePending = false;
                if (controller.signal.aborted) return failure('reconciliation_required', true);
                await report(contract, call.id, 'failed');
                return failure(code);
              }
              persistencePending = false;
              // A late persistence completion must never cause a new host operation.
              if (controller.signal.aborted) return failure('reconciliation_required', true);
              if (!checkpoint.execute) {
                const observation = checkpoint.runtime.observations.find(item =>
                  item.step === checkpoint.runtime.toolCalls.find(item => item.id === call.id)?.step && item.toolId === contract.toolId);
                if (!observation) { uncertain = true; return failure('reconciliation_required', true); }
                return observation.ok
                  ? { schemaVersion: 1, status: 'success', observation: observation.data,
                      metadata: { callId: call.id, toolId: contract.toolId, toolVersion: contract.version, replayed: true, projection: 'checkpoint_summary' } }
                  : failure(observation.diagnostic ?? 'tool_failed');
              }
              runtimeStarted = true;
              runtimeStep = checkpoint.runtime.checkpoint.step;
            }
            const outcome = await execute().catch(() => {
              if (invoked && contract.preconditions.requiresWrite) uncertain = true;
              return failure('tool_failed', invoked && contract.preconditions.requiresWrite);
            });
            if (controller.signal.aborted) return failure('reconciliation_required', true);
            if (runtimeStarted && options.runtime) {
              const observation: DocumentToolObservation = {
                step: runtimeStep!, toolId: contract.toolId, ok: outcome.status === 'success',
                data: checkpointSummary(outcome.observation),
                ...(outcome.status !== 'success' ? { diagnostic: outcome.diagnostics?.[0]?.code ?? 'tool_failed' } : {})
              };
              persistencePending = true;
              await options.runtime.service.recordObservation(options.runtime.scope, call.id, observation,
                { outcomeUnknown: outcome.status === 'unknown' });
              persistencePending = false;
              if (controller.signal.aborted) return failure('reconciliation_required', true);
            }
            await report(contract, call.id, outcome.status === 'success' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed');
            return { ...outcome };
          };
          try {
            const outcome = await Promise.race([lifecycle().catch(() => {
              uncertain = true;
              return failure('runtime_checkpoint_failed', true);
            }), stopped]);
            return { ...outcome };
          } finally {
            clearTimeout(timeout);
            cancellers.forEach(remove => remove());
          }
        }).catch(() => {
          uncertain = true;
          return failure('runtime_checkpoint_failed', true);
        });
        calls.set(call.id, { fingerprint, result });
        tail = result.then(() => undefined, () => undefined);
        return result;
      }
    }
  };
}

function failure(code: string, unknown = false): DocumentToolResult & Readonly<Record<string, unknown>> {
  return { schemaVersion: 1, status: unknown ? 'unknown' : code === 'cancelled' ? 'cancelled' : 'failed',
    diagnostics: [{ code, severity: 'error', message: code }] };
}
function report(contract: CanonicalToolContract, callId: string, status: 'completed' | 'failed' | 'cancelled') {
  return emitProductionEvent({ code: 'tool_result', status, operationId: callId,
    facts: { tool: contract.diagnostics.traceType, purpose: 'tool' } });
}

/** Audit checkpoints intentionally omit document content, paths and nested payloads. */
function checkpointSummary(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) =>
    /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) &&
    !/(?:path|url|token|secret|password|credential|api[_-]?key|content|body|prompt|__proto__|constructor|prototype)/iu.test(key) &&
    (typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && item.length <= 500))));
}

function safeObservation(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 8) throw new Error('observation_limit');
    if (typeof item === 'string') {
      if (item.length > 8_000) throw new Error('observation_limit');
      return item.replace(/(?:[a-z]:[\\/]|\\\\|https?:\/\/|\/)[^\s'"<>]*/giu, '[redacted]')
        .replace(/(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, '[redacted]');
    }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > 128) throw new Error('observation_limit');
      return item.map(child => visit(child, depth + 1));
    }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      const entries = Object.entries(item);
      if (entries.length > 64) throw new Error('observation_limit');
      return Object.fromEntries(entries.filter(([key]) => !/(?:path|url|token|secret|password|credential|api[_-]?key|__proto__|constructor|prototype)/iu.test(key))
        .filter(([key]) => !/^(?:context|executionContext|runtimeContext|currentDocumentId|currentDocumentIR|documentRef|rootDirectory|projectContext|authorization|capabilities|abortSignal|signal|taskContext|checkpoint|idempotencyKey)$/iu.test(key))
        .map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    throw new Error('observation_invalid');
  };
  const result = visit(value, 0) as Readonly<Record<string, unknown>>;
  if (JSON.stringify(result).length > 32_000) throw new Error('observation_limit');
  return result;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function bounded(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('tool_policy_invalid');
  return value;
}
