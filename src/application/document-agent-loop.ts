import {
  createDocumentToolRegistry,
  parseDocumentToolRequest,
  type DocumentAgentResult,
  type DocumentToolDefinition,
  type DocumentToolId,
  type DocumentToolObservation,
  type DocumentToolRequest,
  type DocumentAgentProgressEvent
} from '../domain';

export interface DocumentAgentDecisionComplete {
  readonly kind: 'complete';
  readonly summary: string;
}

export interface DocumentAgentDecisionTool {
  readonly kind: 'tool';
  readonly request: unknown;
}

export type DocumentAgentDecision =
  | DocumentAgentDecisionComplete
  | DocumentAgentDecisionTool;

export interface DocumentAgentToolContext {
  readonly step: number;
  readonly signal: AbortSignal;
}

export type DocumentAgentToolExecutor = (
  request: DocumentToolRequest,
  context: DocumentAgentToolContext
) => Promise<Readonly<Record<string, unknown>>>;

export interface DocumentAgentLoopOptions {
  readonly registry?: ReadonlyMap<DocumentToolId, DocumentToolDefinition>;
  readonly execute: DocumentAgentToolExecutor;
  readonly nextDecision: (
    observations: readonly DocumentToolObservation[]
  ) => Promise<DocumentAgentDecision>;
  readonly maxSteps?: number;
  readonly budgetUnits?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly allowedTools?: readonly DocumentToolId[];
  readonly repeatedDiagnosticLimit?: number;
  /** Remaining parent-task budget. Child loops cannot extend it. */
  readonly parentBudgetUnits?: number;
  readonly onEvent?: (event: DocumentAgentProgressEvent) => void | Promise<void>;
  /** Durable hooks are gates, unlike best-effort UI progress. */
  readonly onBeforeTool?: (
    request: DocumentToolRequest,
    context: { readonly step: number; readonly costUnits: number }
  ) => void | Promise<void>;
  readonly initialObservations?: readonly DocumentToolObservation[];
  readonly onObservation?: (
    observation: DocumentToolObservation,
    context: { readonly step: number; readonly costUnits: number }
  ) => void | Promise<void>;
  readonly now?: () => string;
}

export async function runDocumentAgentLoop(
  options: DocumentAgentLoopOptions
): Promise<DocumentAgentResult> {
  const registry = options.registry ?? createDocumentToolRegistry();
  const maxSteps = boundedInteger(options.maxSteps ?? 8, 1, 32);
  const requestedBudgetUnits = boundedInteger(options.budgetUnits ?? 16, 1, 10_000);
  const parentBudgetUnits = options.parentBudgetUnits === undefined
    ? requestedBudgetUnits
    : boundedInteger(options.parentBudgetUnits, 1, 10_000);
  const budgetUnits = Math.min(requestedBudgetUnits, parentBudgetUnits);
  const timeoutMs = boundedInteger(options.timeoutMs ?? 120_000, 1, 900_000);
  const repeatedDiagnosticLimit = boundedInteger(
    options.repeatedDiagnosticLimit ?? 2,
    2,
    8
  );
  const allowedTools = new Set(options.allowedTools ?? [...registry.keys()]);
  const observations: DocumentToolObservation[] = structuredClone([...(options.initialObservations ?? [])]);
  if (observations.length > maxSteps || observations.some((observation, index) =>
    observation.step !== index + 1 || !registry.has(observation.toolId))) {
    throw new TypeError('agent resume observations are invalid');
  }
  const startedAt = Date.now();
  let costUnits = observations.reduce((sum, observation) => sum + registry.get(observation.toolId)!.maxCostUnits, 0);
  if (costUnits > budgetUnits) throw new TypeError('agent resume budget is invalid');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let previousDiagnostic: string | undefined;
  let repeatedDiagnostics = 0;
  for (const observation of observations) {
    if (observation.ok) {
      previousDiagnostic = undefined;
      repeatedDiagnostics = 0;
    } else {
      repeatedDiagnostics = previousDiagnostic === observation.diagnostic ? repeatedDiagnostics + 1 : 1;
      previousDiagnostic = observation.diagnostic;
    }
  }
  let eventSequence = 0;
  const emit = async (event: Omit<DocumentAgentProgressEvent, 'sequence' | 'occurredAt'>): Promise<void> => {
    if (!options.onEvent) return;
    try {
      await options.onEvent({
        ...event,
        sequence: ++eventSequence,
        occurredAt: (options.now ?? (() => new Date().toISOString()))()
      });
    } catch {
      // Progress projection is observational and cannot change task truth.
    }
  };
  const finish = async (
    state: DocumentAgentResult['state'],
    summary?: string
  ): Promise<DocumentAgentResult> => {
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
    await emit({
      step: observations.length,
      stage: 'completed',
      status: state === 'cancelled' ? 'cancelled' : state === 'completed' || state === 'completed_unvalidated' ? 'completed' : 'failed',
      ...(state === 'timeout' ? { safeCode: 'agent.timeout' } : {}),
      ...(state === 'budget_exceeded' ? { safeCode: 'agent.budget_exceeded' } : {}),
      ...(state === 'max_steps_exceeded' ? { safeCode: 'agent.max_steps_exceeded' } : {}),
      ...(state === 'repeated_diagnosis' ? { safeCode: 'agent.repeated_diagnosis' } : {})
    });
    return result(state, observations, costUnits, summary);
  };

  for (let step = observations.length + 1; step <= maxSteps; step += 1) {
    if (repeatedDiagnostics >= repeatedDiagnosticLimit) return finish('repeated_diagnosis');
    if (isAborted(options.signal)) {
      return finish('cancelled');
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return finish('timeout');
    }
    await emit({ step, stage: 'planning', status: 'started' });
    let decision: DocumentAgentDecision;
    try {
      const decisionResult = await awaitWithin(
        options.nextDecision(observations),
        Math.max(1, timeoutMs - (Date.now() - startedAt)),
        options.signal
      );
      if (decisionResult.cancelled) return finish('cancelled');
      if (decisionResult.timedOut) return finish('timeout');
      decision = decisionResult.value;
    } catch (error) {
      return finish('failed', safeError(error));
    }
    if (decision.kind === 'complete') {
      return finish('completed', decision.summary);
    }

    let request: DocumentToolRequest;
    try {
      request = parseDocumentToolRequest(decision.request);
    } catch (error) {
      return finish('failed', safeError(error));
    }
    const definition = registry.get(request.toolId);
    if (!definition || !allowedTools.has(request.toolId)) {
      return finish('failed', 'tool_not_allowed');
    }
    if (costUnits + definition.maxCostUnits > budgetUnits) {
      return finish('budget_exceeded');
    }
    costUnits += definition.maxCostUnits;
    try {
      await options.onBeforeTool?.(request, { step, costUnits });
    } catch {
      return finish('failed', 'agent.checkpoint_failed');
    }
    if (isAborted(options.signal)) return finish('cancelled');
    if (Date.now() - startedAt >= timeoutMs) return finish('timeout');
    await emit({ step, stage: 'tool', status: 'started', toolId: request.toolId });
    let observation: DocumentToolObservation;
    try {
      const executionResult = await awaitWithin(
        options.execute(request, {
          step,
          signal: controller.signal
        }),
        Math.max(1, timeoutMs - (Date.now() - startedAt)),
        options.signal
      );
      if (executionResult.cancelled) return finish('cancelled');
      if (executionResult.timedOut) return finish('timeout');
      const data = executionResult.value;
      observation = makeObservation(step, request.toolId, true, data);
      previousDiagnostic = undefined;
      repeatedDiagnostics = 0;
    } catch (error) {
      const diagnostic = safeError(error);
      observation = makeObservation(step, request.toolId, false, {}, diagnostic);
      if (diagnostic === previousDiagnostic) repeatedDiagnostics += 1;
      else repeatedDiagnostics = 1;
      previousDiagnostic = diagnostic;
    }
    try {
      await options.onObservation?.(observation, { step, costUnits });
    } catch {
      return finish('failed', 'agent.checkpoint_failed');
    }
    observations.push(observation);
    await emit({ step, stage: 'tool', status: observation.ok ? 'completed' : 'failed', toolId: request.toolId,
      ...(!observation.ok ? { safeCode: safeProgressCode(observation.diagnostic ?? 'agent.tool_failed') } : {}) });
    if (repeatedDiagnostics >= repeatedDiagnosticLimit) return finish('repeated_diagnosis');
  }
  return finish('max_steps_exceeded');
}

function makeObservation(
  step: number,
  toolId: DocumentToolId,
  ok: boolean,
  data: Readonly<Record<string, unknown>>,
  diagnostic?: string
): DocumentToolObservation {
  return {
    step,
    toolId,
    ok,
    data: sanitizeRecord(data),
    ...(diagnostic !== undefined ? { diagnostic } : {})
  };
}

function sanitizeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/(?:path|url|token|secret|password|credential|api[_-]?key)/i.test(key)) continue;
    const sanitized = sanitizeValue(raw, 0);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return undefined;
  if (typeof value === 'string') return value.slice(0, depth === 0 ? 2_000 : 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value).slice(0, 64)) {
      if (/(?:path|url|token|secret|password|credential|api[_-]?key)/i.test(key)) {
        continue;
      }
      const sanitized = sanitizeValue(raw, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return undefined;
}

function result(
  state: DocumentAgentResult['state'],
  observations: readonly DocumentToolObservation[],
  costUnits: number,
  summary?: string
): DocumentAgentResult {
  return {
    state,
    steps: observations.length,
    costUnits,
    observations,
    ...(summary !== undefined ? { summary } : {})
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`agent option must be an integer from ${min} to ${max}`);
  }
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

function safeProgressCode(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').slice(0, 120);
  return /(?:[a-z]:[\\/]|\\\\|\/|https?:\/\/|token|secret|password|credential|api[_-]?key)/iu.test(normalized)
    ? 'agent.tool_failed'
    : normalized;
}

async function awaitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<
  | { readonly timedOut: true; readonly cancelled: false }
  | { readonly timedOut: false; readonly cancelled: true }
  | { readonly timedOut: false; readonly cancelled: false; readonly value: T }
> {
  if (signal?.aborted) {
    // The operation may abort synchronously before our listener is installed.
    void promise.catch(() => undefined);
    return { timedOut: false, cancelled: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<{
    readonly timedOut: true;
    readonly cancelled: false;
  }>((resolve) => {
    timer = setTimeout(
      () => resolve({ timedOut: true, cancelled: false }),
      timeoutMs
    );
  });
  const cancelled = new Promise<{
    readonly timedOut: false;
    readonly cancelled: true;
  }>((resolve) => {
    onAbort = () => resolve({ timedOut: false, cancelled: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([
      promise.then((resolved) => ({
        timedOut: false as const,
        cancelled: false as const,
        value: resolved
      })),
      timeout,
      cancelled
    ]);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}
