import {
  createDocumentToolRegistry,
  parseDocumentToolRequest,
  type DocumentAgentResult,
  type DocumentToolDefinition,
  type DocumentToolId,
  type DocumentToolObservation,
  type DocumentToolRequest
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
}

export async function runDocumentAgentLoop(
  options: DocumentAgentLoopOptions
): Promise<DocumentAgentResult> {
  const registry = options.registry ?? createDocumentToolRegistry();
  const maxSteps = boundedInteger(options.maxSteps ?? 8, 1, 32);
  const budgetUnits = boundedInteger(options.budgetUnits ?? 16, 1, 10_000);
  const timeoutMs = boundedInteger(options.timeoutMs ?? 120_000, 1, 900_000);
  const repeatedDiagnosticLimit = boundedInteger(
    options.repeatedDiagnosticLimit ?? 2,
    2,
    8
  );
  const allowedTools = new Set(options.allowedTools ?? [...registry.keys()]);
  const observations: DocumentToolObservation[] = [];
  const startedAt = Date.now();
  let costUnits = 0;
  let previousDiagnostic: string | undefined;
  let repeatedDiagnostics = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    if (isAborted(options.signal)) {
      return result('cancelled', observations, costUnits);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return result('timeout', observations, costUnits);
    }
    let decision: DocumentAgentDecision;
    try {
      const decisionResult = await awaitWithin(
        options.nextDecision(observations),
        Math.max(1, timeoutMs - (Date.now() - startedAt)),
        options.signal
      );
      if (decisionResult.cancelled) return result('cancelled', observations, costUnits);
      if (decisionResult.timedOut) return result('timeout', observations, costUnits);
      decision = decisionResult.value;
    } catch (error) {
      return result('failed', observations, costUnits, safeError(error));
    }
    if (decision.kind === 'complete') {
      return result('completed', observations, costUnits, decision.summary);
    }

    let request: DocumentToolRequest;
    try {
      request = parseDocumentToolRequest(decision.request);
    } catch (error) {
      return result('failed', observations, costUnits, safeError(error));
    }
    const definition = registry.get(request.toolId);
    if (!definition || !allowedTools.has(request.toolId)) {
      return result('failed', observations, costUnits, 'tool_not_allowed');
    }
    if (costUnits + definition.maxCostUnits > budgetUnits) {
      return result('budget_exceeded', observations, costUnits);
    }
    costUnits += definition.maxCostUnits;
    try {
      const executionResult = await awaitWithin(
        options.execute(request, {
          step,
          signal: options.signal ?? new AbortController().signal
        }),
        Math.max(1, timeoutMs - (Date.now() - startedAt)),
        options.signal
      );
      if (executionResult.cancelled) return result('cancelled', observations, costUnits);
      if (executionResult.timedOut) return result('timeout', observations, costUnits);
      const data = executionResult.value;
      const observation = makeObservation(step, request.toolId, true, data);
      observations.push(observation);
      previousDiagnostic = undefined;
      repeatedDiagnostics = 0;
    } catch (error) {
      const diagnostic = safeError(error);
      const observation = makeObservation(step, request.toolId, false, {}, diagnostic);
      observations.push(observation);
      if (diagnostic === previousDiagnostic) repeatedDiagnostics += 1;
      else repeatedDiagnostics = 1;
      previousDiagnostic = diagnostic;
      if (repeatedDiagnostics >= repeatedDiagnosticLimit) {
        return result('repeated_diagnosis', observations, costUnits);
      }
    }
  }
  return result('max_steps_exceeded', observations, costUnits);
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

async function awaitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<
  | { readonly timedOut: true; readonly cancelled: false }
  | { readonly timedOut: false; readonly cancelled: true }
  | { readonly timedOut: false; readonly cancelled: false; readonly value: T }
> {
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
