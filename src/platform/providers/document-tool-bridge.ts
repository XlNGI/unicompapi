import { createHash } from 'node:crypto';
import { createDocumentToolRegistry } from '../../domain/entities/document-agent';
import { atomicToolSchema, parseAtomicToolArguments, type DocumentAtomicToolBinding } from '../../application/document-atomic-tools';
import type { ControlledProviderToolBridge, ControlledProviderToolDefinition } from './provider-tool-calling';
import { emitProductionEvent } from '../conversation-production-trace';
import type { ProductionEventFacts } from '../../shared/conversation-production-ipc';

const traceTools: Record<string, NonNullable<ProductionEventFacts['tool']>> = {
  extract_source: 'read_sources', aggregate_data: 'analyze', generate_chart: 'write_document',
  select_material: 'read_sources', read_document_structure: 'read_sources', apply_document_patch: 'patch',
  render_preview: 'render', inspect_layout: 'check'
};

export interface DocumentToolCallingBridgeOptions {
  /** Only tools implemented for this task are advertised. No implicit permission. */
  readonly bindings: readonly DocumentAtomicToolBinding[];
  readonly budgetUnits: number;
  readonly maxCalls: number;
  readonly timeoutMs: number;
}

/** One instance per task. Units are local scheduling limits, never monetary prices. */
export function createDocumentToolCallingBridge(options: DocumentToolCallingBridgeOptions): {
  readonly tools: readonly ControlledProviderToolDefinition[];
  readonly bridge: ControlledProviderToolBridge;
  readonly spentCostUnits: () => number;
} {
  const budget = bounded(options.budgetUnits, 10_000);
  const maxCalls = bounded(options.maxCalls, 128);
  const timeoutMs = bounded(options.timeoutMs, 900_000);
  const registry = createDocumentToolRegistry();
  const bindings = new Map(options.bindings.map(binding => [binding.id, {
    ...binding, fields: structuredClone(binding.fields)
  }]));
  if (!bindings.size || bindings.size !== options.bindings.length) throw new TypeError('tool_registry_invalid');
  const tools = [...bindings.values()].map(binding => ({
    type: 'function' as const,
    function: { name: binding.id, description: registry.get(binding.id)?.description, parameters: atomicToolSchema(binding) }
  }));
  const calls = new Map<string, { fingerprint: string; result: Promise<Readonly<Record<string, unknown>>> }>();
  let spent = 0;
  let tail = Promise.resolve();
  let uncertain = false;
  const fail = (errorCode: string, outcomeUnknown = false): Readonly<Record<string, unknown>> => ({ ok: false, errorCode, outcomeUnknown });

  return {
    tools,
    spentCostUnits: () => spent,
    bridge: {
      execute({ call, signal }) {
        if (signal.aborted) return Promise.resolve(fail('cancelled'));
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(call.id)) return Promise.resolve(fail('invalid_call_id'));
        const binding = bindings.get(call.name as DocumentAtomicToolBinding['id']);
        const definition = binding && registry.get(binding.id);
        if (!binding || !definition) return Promise.resolve(fail('tool_not_allowed'));
        let request;
        try { request = parseAtomicToolArguments(binding, call.arguments); }
        catch { return Promise.resolve(fail('invalid_tool_arguments')); }
        const fingerprint = createHash('sha256').update(JSON.stringify([request.toolId,
          Object.entries(request.input).sort(([a], [b]) => a.localeCompare(b)), request.reason])).digest('hex');
        const previous = calls.get(call.id);
        if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(fail('call_id_conflict'));
        if (calls.size >= maxCalls) return Promise.resolve(fail('tool_call_limit'));
        const validated = request;
        const result = tail.then(async () => {
          if (signal.aborted) return fail('cancelled');
          if (uncertain) return fail('reconciliation_required', true);
          if (spent + definition.maxCostUnits > budget) return fail('budget_exceeded');
          const controller = new AbortController();
          let invoked = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let cancel: () => void = () => undefined;
          const stopped = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
            const stop = (code: string) => {
              if (controller.signal.aborted) return;
              controller.abort();
              // An uncooperative host can still finish: freeze all later execution.
              uncertain = true;
              resolve(fail(code, invoked && definition.requiresWrite));
            };
            cancel = () => stop('cancelled');
            signal.addEventListener('abort', cancel, { once: true });
            timeout = setTimeout(() => stop('tool_timeout'), timeoutMs);
          });
          const action = async (): Promise<Readonly<Record<string, unknown>>> => {
            const authorized = await binding.authorize(validated, controller.signal);
            await emitProductionEvent({ code: 'tool_authorization', status: authorized ? 'completed' : 'failed',
              operationId: call.id, facts: { tool: traceTools[definition.id], purpose: 'tool' } });
            if (!authorized) return fail('authorization_or_revision_invalid');
            if (controller.signal.aborted) return fail('cancelled');
            spent += definition.maxCostUnits;
            await emitProductionEvent({ code: 'tool_call', status: 'started', operationId: call.id,
              facts: { tool: traceTools[definition.id], purpose: 'tool' } });
            if (controller.signal.aborted) return fail('cancelled');
            invoked = true;
            const data = await binding.execute(validated, { callId: call.id, definition, signal: controller.signal });
            if (controller.signal.aborted) return fail('cancelled', definition.requiresWrite);
            return { ok: true, callId: call.id, toolId: definition.id, toolVersion: definition.version,
              costUnits: definition.maxCostUnits, outcomeUnknown: false, result: safeObservation(data) };
          };
          try {
            const outcome = await Promise.race([action().catch(() => {
              if (invoked && definition.requiresWrite) uncertain = true;
              return fail('tool_failed', invoked && definition.requiresWrite);
            }), stopped]);
            await emitProductionEvent({ code: 'tool_result', status: outcome.ok === true ? 'completed'
              : outcome.errorCode === 'cancelled' ? 'cancelled' : 'failed', operationId: call.id,
              facts: { tool: traceTools[definition.id], purpose: 'tool' } });
            return outcome;
          } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
          }
        });
        calls.set(call.id, { fingerprint, result });
        tail = result.then(() => undefined, () => undefined);
        return result;
      }
    }
  };
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
        .map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    throw new Error('observation_invalid');
  };
  const result = visit(value, 0) as Readonly<Record<string, unknown>>;
  if (JSON.stringify(result).length > 32_000) throw new Error('observation_limit');
  return result;
}

function bounded(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('tool_policy_invalid');
  return value;
}
