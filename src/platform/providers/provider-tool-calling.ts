import { createHash } from 'node:crypto';
import {
  canonicalToolInputSchema,
  createCanonicalToolRegistry,
  validateDocumentToolResult,
  type CanonicalToolContract,
  type CanonicalToolId,
  type CanonicalToolRegistry
} from '../../domain/entities/canonical-tool-contract';
import { ExecutionBudgetError, HostExecutionBudget, type ExecutionStage } from '../../application/execution-budget';

export interface ControlledProviderToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly requiresExistingDocument?: boolean;
  };
}

const maxTools = 8;
const maxSchemaBytes = 16_000;
const protocolRegistry = createCanonicalToolRegistry();

/** Project a Runtime-selected subset only. Registry membership is not authorization. */
export function providerToolsFromContracts(
  availableContracts: readonly CanonicalToolContract[],
  registry: CanonicalToolRegistry = protocolRegistry,
  diagnostic?: (stage: string, count: number) => void
): readonly ControlledProviderToolDefinition[] {
  diagnostic?.(`provider_tools_from_contracts_enter:${availableContracts.map(contract => contract.toolId).join('.')}`, availableContracts.length);
  if (availableContracts.length > maxTools) throw new Error('controlled tool definitions are invalid');
  const names = new Set<string>();
  diagnostic?.('contracts_enumerated', availableContracts.length);
  const result = availableContracts.map(contract => {
    const registered = registry.get(contract.toolId);
    if (!registered || registered.exposure !== 'provider' || names.has(contract.toolId) || !sameJsonValue(contract, registered)) {
      throw new Error('controlled tool contract is invalid');
    }
    names.add(contract.toolId);
    diagnostic?.(`contract_${contract.toolId}_schema_enter`, names.size);
    const projected = canonicalProviderTool(registered);
    diagnostic?.(`contract_${contract.toolId}_schema_returned`, names.size);
    return projected;
  });
  diagnostic?.('provider_tools_from_contracts_returned', result.length);
  return result;
}

/** Validate transported definitions against the contract, never infer task permissions. */
export function parseControlledProviderTools(
  value: unknown,
  registry: CanonicalToolRegistry = protocolRegistry
): readonly ControlledProviderToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxTools) {
    throw new Error('controlled tool definitions are invalid');
  }
  // No currently available tools means no Provider tools field at all.
  if (value.length === 0) return undefined;
  const names = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || item.type !== 'function' || !isRecord(item.function) ||
        Object.keys(item).some(key => key !== 'type' && key !== 'function') ||
        Object.keys(item.function).some(key => !['name', 'description', 'parameters', 'requiresExistingDocument'].includes(key))) {
      throw new Error(`controlled tool ${index} is invalid`);
    }
    const name = item.function.name;
    const contract = typeof name === 'string' ? registry.get(name as CanonicalToolId) : undefined;
    if (!contract || contract.exposure !== 'provider' || names.has(contract.toolId)) {
      throw new Error(`controlled tool ${index} name is invalid`);
    }
    names.add(contract.toolId);
    const parameters = item.function.parameters;
    const canonical = canonicalProviderTool(contract);
    if (!isRecord(parameters) || JSON.stringify(parameters).length > maxSchemaBytes ||
        !sameJsonValue(parameters, canonical.function.parameters)) {
      throw new Error(`controlled tool ${index} parameters are invalid`);
    }
    if (item.function.requiresExistingDocument !== undefined &&
        item.function.requiresExistingDocument !== contract.preconditions.requiresExistingDocument) {
      throw new Error(`controlled tool ${index} prerequisite is invalid`);
    }
    if (item.function.description !== undefined && item.function.description !== contract.description) {
      throw new Error(`controlled tool ${index} description is invalid`);
    }
    return canonical;
  });
}

export interface ControlledProviderToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
}

export interface ControlledProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Provider wire representation for an assistant message that requested tools. */
export interface ControlledProviderAssistantToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export function toControlledProviderAssistantToolCalls(
  calls: readonly ControlledProviderToolCall[]
): readonly ControlledProviderAssistantToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    }
  }));
}

export interface ControlledProviderToolBridge {
  execute(input: {
    readonly call: ControlledProviderToolCall;
    readonly signal: AbortSignal;
    /** Trusted Host admission receipt; never supplied by model-authored arguments or result metadata. */
    readonly onExecutionAdmitted?: () => Promise<void>;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface ControlledProviderToolLoopMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly toolCalls?: readonly ControlledProviderToolCall[];
}

export interface ControlledProviderToolLoopResponse {
  readonly content?: string;
  readonly toolCalls?: readonly ControlledProviderToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ControlledProviderToolRoundResponse {
  readonly content?: string;
  readonly toolCalls?: readonly ControlledProviderToolCall[];
  readonly finishReason: string;
}

/** Host-only durable boundaries. This port is never included in Provider JSON. */
export interface ProviderExecutionLifecyclePort {
  modelPrepared(input: { readonly round: number; readonly requestHash: string; readonly messageCount: number; readonly toolCount: number }): Promise<void>;
  modelStarted(input: { readonly round: number }): Promise<void>;
  modelResult(input: { readonly round: number; readonly resultHash: string; readonly contentLength: number; readonly finishReason: string; readonly toolCallCount: number }): Promise<void>;
  modelFailed(input: { readonly round: number; readonly unknown: boolean; readonly code: 'cancelled' | 'timeout' | 'transport' | 'invalid_response' | 'journal_failed' | 'failed' }): Promise<void>;
  toolStarted(input: { readonly round: number; readonly stepRef: string; readonly toolId: string; readonly argumentsHash: string }): Promise<void>;
  toolAdmitted?(input: { readonly round: number; readonly stepRef: string }): Promise<void>;
  toolResult(input: { readonly round: number; readonly stepRef: string; readonly resultHash: string; readonly status: 'success' | 'failed' | 'unknown'; readonly outcomeUnknown: boolean; readonly registeredWorkIds?: readonly string[]; readonly failureCode?: string; readonly admissionPhase?: 'rejected' | 'admitted' | 'replayed' | 'unknown' }): Promise<void>;
  observationCommitted(input: { readonly round: number; readonly stepRef: string; readonly observationHash: string }): Promise<void>;
}

export class ProviderExecutionJournalError extends Error {
  constructor() { super('execution_journal_failed'); this.name = 'ProviderExecutionJournalError'; }
}

/** Only the digest crosses the durable metadata boundary, never the source data. */
export function providerExecutionHash(value: unknown): string {
  return createHash('sha256').update(value instanceof Uint8Array ? value : stableJson(value)).digest('hex');
}

export async function persistProviderExecutionBoundary(
  operation: (() => Promise<void>) | undefined,
  budget?: HostExecutionBudget,
  signal?: AbortSignal
): Promise<void> {
  if (!operation) return;
  const stopError = () => signal?.reason instanceof ExecutionBudgetError ? signal.reason : new ExecutionBudgetError('cancelled');
  if (signal?.aborted) throw stopError();
  let removeAbort = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const stop = () => reject(stopError());
    signal.addEventListener('abort', stop, { once: true });
    removeAbort = () => { signal.removeEventListener('abort', stop); };
  });
  try {
    const pending = budget ? budget.run('prepare', () => operation()) : operation();
    await Promise.race([pending, stopped]);
  } catch (error) {
    if (error instanceof ExecutionBudgetError) throw error;
    throw new ProviderExecutionJournalError();
  } finally { removeAbort(); }
}

function registeredWorkRefs(result: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Array.isArray(result.artifactRefs)) return [];
  return [...new Set(result.artifactRefs.filter((item): item is { kind: 'work'; ref: string } =>
    isRecord(item) && item.kind === 'work' && typeof item.ref === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(item.ref)
  ).map(item => item.ref))];
}

/** Production Provider rounds share one bounded call, progress and failure loop. */
export async function runControlledProviderToolRounds<
  TMessage,
  TResponse extends ControlledProviderToolRoundResponse
>(input: {
  readonly initialResponse: TResponse;
  readonly messages: TMessage[];
  readonly bridge?: ControlledProviderToolBridge;
  readonly signal: AbortSignal;
  readonly shouldContinue: (response: TResponse) => boolean;
  readonly maxRounds?: number;
  readonly executionBudget?: HostExecutionBudget;
  readonly executionLifecycle?: ProviderExecutionLifecyclePort;
  readonly requestNext: (messages: readonly TMessage[], signal: AbortSignal) => Promise<TResponse>;
  readonly appendAssistant: (response: TResponse, messages: TMessage[]) => void;
  readonly appendTool: (call: ControlledProviderToolCall, result: Readonly<Record<string, unknown>>, messages: TMessage[]) => void;
  readonly toLoopError: (code: ControlledProviderToolLoopErrorCode) => Error;
}): Promise<TResponse> {
  const maxRounds = input.maxRounds ?? 64;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 64) {
    throw new Error('controlled tool loop rounds are invalid');
  }
  const controller = createControlledProviderToolLoopController({
    signal: input.signal,
    maxToolCalls: input.executionBudget?.policy.maxToolCalls ?? 64,
    executionBudget: input.executionBudget
  });
  let response = input.initialResponse;
  let rounds = 0;
  try {
    while (input.shouldContinue(response)) {
      if (!input.bridge) throw input.toLoopError('tool_bridge_unavailable');
      if (!response.toolCalls?.length) throw input.toLoopError('invalid_tool_calls');
      controller.assertCanProceed();
      controller.recordToolCalls(response.toolCalls);
      rounds += 1;
      if (rounds > maxRounds) throw input.toLoopError('tool_loop_limit_exceeded');
      input.appendAssistant(response, input.messages);
      for (const [ordinal, call] of response.toolCalls.entries()) {
        controller.assertCanProceed();
        const round = rounds - 1;
        const stepRef = `provider-tool-${round}-${ordinal}`;
        await controller.run('prepare', () => persistProviderExecutionBoundary(input.executionLifecycle && (() => input.executionLifecycle!.toolStarted({
          round, stepRef, toolId: call.name, argumentsHash: providerExecutionHash(call.arguments)
        }))));
        controller.assertCanProceed();
        let admitted = false;
        const raw = await controller.run('tool', signal => input.bridge!.execute({ call, signal,
          onExecutionAdmitted: async () => {
            if (admitted) throw new ProviderExecutionJournalError();
            await persistProviderExecutionBoundary(input.executionLifecycle?.toolAdmitted && (() => input.executionLifecycle!.toolAdmitted!({ round, stepRef })), input.executionBudget, signal);
            admitted = true;
          }
        }));
        const result = sanitizeControlledToolResult(raw);
        const diagnostic = Array.isArray(raw.diagnostics) ? raw.diagnostics.find(item => isRecord(item) && typeof item.code === 'string' && /^[a-z0-9_-]{1,80}$/iu.test(item.code)) : undefined;
        const failureCode = isRecord(diagnostic) ? diagnostic.code as string : undefined;
        const admissionPhase = admitted ? 'admitted' : result.status === 'unknown' ? 'unknown'
          : isRecord(raw.metadata) && raw.metadata.replayed === true ? 'replayed' : 'rejected';
        await persistProviderExecutionBoundary(input.executionLifecycle && (() => input.executionLifecycle!.toolResult({
          round, stepRef, resultHash: providerExecutionHash(raw),
          status: result.status === 'failed' || result.status === 'unknown' ? result.status : 'success',
          outcomeUnknown: result.status === 'unknown', registeredWorkIds: registeredWorkRefs(raw), admissionPhase,
          ...(failureCode ? { failureCode } : {})
        })), undefined, controller.signal);
        controller.recordToolResult(result);
        input.appendTool(call, result, input.messages);
        await controller.run('prepare', () => persistProviderExecutionBoundary(input.executionLifecycle && (() => input.executionLifecycle!.observationCommitted({
          round, stepRef, observationHash: providerExecutionHash(result)
        }))));
        controller.assertCanProceed();
      }
      response = await controller.run('model', signal => input.requestNext(input.messages, signal));
    }
    controller.assertCanProceed();
    return response;
  } catch (error) {
    if (error instanceof ExecutionBudgetError && error.scope === 'execution') throw input.toLoopError(error.code);
    if (error instanceof ControlledProviderToolLoopError) {
      throw input.toLoopError(error.code);
    }
    throw error;
  } finally {
    controller.dispose();
  }
}

/**
 * Bounded provider/tool handshake. The provider transport is deliberately
 * injected so this helper cannot select endpoints, credentials, or commands.
 */
export async function runControlledProviderToolLoop(input: {
  readonly messages: readonly ControlledProviderToolLoopMessage[];
  readonly request: (messages: readonly ControlledProviderToolLoopMessage[], signal: AbortSignal) => Promise<ControlledProviderToolLoopResponse>;
  readonly bridge: ControlledProviderToolBridge;
  readonly signal?: AbortSignal;
  readonly maxRounds?: number;
}): Promise<{ readonly messages: readonly ControlledProviderToolLoopMessage[]; readonly content: string }> {
  const maxRounds = input.maxRounds ?? 2;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 4) throw new Error('tool loop rounds are invalid');
  const messages = [...input.messages];
  let content = '';
  for (let round = 0; round < maxRounds; round += 1) {
    if (input.signal?.aborted) throw new Error('cancelled');
    const response = await input.request(messages, input.signal ?? new AbortController().signal);
    if (response.content) content += response.content;
    if (response.finishReason === 'stop' || response.finishReason === 'length') {
      return { messages, content };
    }
    const calls = response.toolCalls ?? [];
    if (calls.length < 1 || calls.length > maxTools) throw new Error('tool calls are invalid');
    const assistantContent = response.content ?? '';
    messages.push({ role: 'assistant', content: assistantContent, toolCalls: calls });
    for (const call of calls) {
      if (!protocolRegistry.has(call.name as CanonicalToolId) || !call.id) throw new Error('tool call is not allowed');
      const result = sanitizeControlledToolResult(await input.bridge.execute({ call, signal: input.signal ?? new AbortController().signal }));
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
    }
  }
  throw new Error('tool_loop_limit_exceeded');
}

export function parseControlledToolArguments(value: string): Readonly<Record<string, unknown>> {
  if (value.length > 8_000) throw new Error('controlled tool arguments are too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('controlled tool arguments are invalid JSON');
  }
  if (!isRecord(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error('controlled tool arguments must be an object');
  }
  return parsed;
}

export function sanitizeControlledToolResult(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(value);
  if (encoded.length > 32_000) throw new Error('controlled tool result is too large');
  const toolId = isRecord(value.metadata) && typeof value.metadata.toolId === 'string'
    ? value.metadata.toolId : undefined;
  const contract = toolId === undefined ? undefined : protocolRegistry.get(toolId as CanonicalToolId);
  if (contract?.exposure === 'provider') {
    // Canonical results have their own closed envelope and depth/collection limits.
    // Validate before redaction so the Provider cannot receive an uncontracted shape.
    const validated = validateDocumentToolResult(contract, value);
    const redacted = validateDocumentToolResult(contract, redactValidatedToolValue(validated));
    // Artifact identities belong to the host's authoritative result. The model
    // only needs the kinds/count of published artifacts, never a Work/file ref.
    // This is a Provider DTO projection, not a replacement DocumentToolResult.
    const providerResult = Object.fromEntries(Object.entries(redacted).filter(([key]) => key !== 'irPatch'));
    return { ...providerResult, ...(redacted.artifactRefs === undefined ? {} : {
      artifactRefs: redacted.artifactRefs.map(({ kind }) => ({ kind }))
    }) };
  }
  return sanitizeToolValue(value, 0) as Readonly<Record<string, unknown>>;
}

export type ControlledProviderToolLoopErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'budget_exceeded'
  | 'tool_call_limit'
  | 'no_progress'
  | 'failure_limit'
  | 'unknown_result'
  | 'tool_bridge_unavailable'
  | 'invalid_tool_calls'
  | 'tool_loop_limit_exceeded';

/**
 * Runtime safety limits for the provider/tool handshake. These are deliberately
 * expressed as a call budget and state guards, rather than a business round
 * count. A progressing task may therefore use more than four provider turns.
 */
export class ControlledProviderToolLoopError extends Error {
  constructor(readonly code: ControlledProviderToolLoopErrorCode, message = code) {
    super(message);
    this.name = 'ControlledProviderToolLoopError';
  }
}

export interface ControlledProviderToolLoopController {
  readonly signal: AbortSignal;
  assertCanProceed(): void;
  recordToolCalls(calls: readonly ControlledProviderToolCall[]): void;
  recordToolResult(result: Readonly<Record<string, unknown>>): void;
  recordToolFailure(): void;
  run<T>(stage: ExecutionStage, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  dispose(): void;
}

export function createControlledProviderToolLoopController(input: {
  readonly signal: AbortSignal;
  readonly onTimeout?: () => void;
  readonly totalTimeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxFailures?: number;
  readonly executionBudget?: HostExecutionBudget;
}): ControlledProviderToolLoopController {
  const totalTimeoutMs = input.totalTimeoutMs ?? 120_000;
  const maxToolCalls = input.maxToolCalls ?? 64;
  const maxFailures = input.maxFailures ?? 3;
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1_000 || totalTimeoutMs > 900_000 ||
      !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 256 ||
      !Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 16) {
    throw new Error('controlled tool loop limits are invalid');
  }
  const startedAt = Date.now();
  const budget = input.executionBudget ?? new HostExecutionBudget({ startedAt, deadlineAt: startedAt + totalTimeoutMs,
    maxToolCalls, budgetUnits: 1_000_000 }, { signal: input.signal,
      onDiagnostic: diagnostic => { if (diagnostic.stopReason === 'timeout') input.onTimeout?.(); } });
  let totalCalls = 0;
  let consecutiveFailures = 0;
  let disposed = false;
  const seenProgress = new Set<string>();
  const onAbort = () => budget.cancel('cancelled');
  if (input.executionBudget) input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) onAbort();

  const assertCanProceed = (): void => {
    if (disposed) throw new ControlledProviderToolLoopError('cancelled');
    try { budget.assertCanProceed(); }
    catch (error) { if (error instanceof ExecutionBudgetError) throw new ControlledProviderToolLoopError(error.code); throw error; }
  };
  return {
    signal: budget.signal,
    assertCanProceed,
    run: (stage, operation) => budget.run(stage, operation),
    recordToolCalls(calls) {
      assertCanProceed();
      if (calls.length < 1 || calls.length > maxTools) {
        throw new ControlledProviderToolLoopError('invalid_tool_calls');
      }
      totalCalls += calls.length;
      if (totalCalls > maxToolCalls) {
        budget.cancel('tool_call_limit');
        throw new ControlledProviderToolLoopError('tool_call_limit');
      }
      const key = stableJson(calls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })));
      if (seenProgress.has(key)) {
        budget.cancel('no_progress');
        throw new ControlledProviderToolLoopError('no_progress');
      }
      seenProgress.add(key);
    },
    recordToolResult(result) {
      assertCanProceed();
      const status = result.status;
      if (status === 'unknown') {
        budget.cancel('unknown_result');
        throw new ControlledProviderToolLoopError('unknown_result');
      }
      if (status === 'failed') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures) {
          budget.cancel('failure_limit');
          throw new ControlledProviderToolLoopError('failure_limit');
        }
        return;
      }
      consecutiveFailures = 0;
    },
    recordToolFailure() {
      assertCanProceed();
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFailures) {
        budget.cancel('failure_limit');
        throw new ControlledProviderToolLoopError('failure_limit');
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!input.executionBudget) budget.dispose();
      input.signal.removeEventListener('abort', onAbort);
    }
  };
}

/** Only called after canonical validation bounded the complete JSON tree. */
function redactValidatedToolValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/(?:[a-z]:[\\/]|\\\\|https?:\/\/|\/)[^\s'"<>]*/giu, '[redacted]')
      .replace(/(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(redactValidatedToolValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/(?:path|url|token|secret|password|credential|api[_-]?key)/iu.test(key) &&
      !/^(?:context|executionContext|runtimeContext|currentDocumentId|currentDocumentIR|currentVersionPin|documentId|documentRef|workId|fileId|projectId|documentLineageId|sourceExecutionId|checksum|checksumSha256|identityIndexVersion|identity|manifest|slidePart|shapeId|physicalLocator|candidatePin|basePin|rootDirectory|projectContext|authorization|capabilities|abortSignal|signal|taskContext|checkpoint|idempotencyKey)$/iu.test(key)
    ).map(([key, item]) => [key, redactValidatedToolValue(item)]));
  }
  return value;
}

function sanitizeToolValue(value: unknown, depth: number): unknown {
  if (depth > 4) return undefined;
  if (typeof value === 'string') return value.slice(0, depth === 0 ? 4_000 : 1_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeToolValue(item, depth + 1)).filter((item) => item !== undefined);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (/(?:path|url|token|secret|password|credential|api[_-]?key)/iu.test(key)) continue;
      const sanitized = sanitizeToolValue(item, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return undefined;
}

export function parseControlledToolCallDeltas(value: unknown): readonly ControlledProviderToolCallDelta[] {
  if (!Array.isArray(value) || value.length > maxTools) throw new Error('tool call deltas are invalid');
  return value.map((item, index) => {
    if (!isRecord(item) || !Number.isSafeInteger(item.index) || Number(item.index) < 0 || Number(item.index) >= maxTools) {
      throw new Error(`tool call delta ${index} is invalid`);
    }
    const fn = item.function;
    if (fn !== undefined && !isRecord(fn)) throw new Error(`tool call delta ${index} function is invalid`);
    const id = item.id === undefined ? undefined : boundedText(item.id);
    const name = fn?.name === undefined ? undefined : boundedName(fn.name);
    // OpenAI-compatible streams may emit an initial empty arguments delta
    // before later chunks provide the JSON body. The assembled call still
    // goes through strict JSON and contract validation.
    const argumentsDelta = fn?.arguments === undefined ? undefined : boundedArgumentsDelta(fn.arguments);
    return {
      index: Number(item.index),
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(argumentsDelta !== undefined ? { argumentsDelta } : {})
    };
  });
}

export function assembleControlledToolCalls(
  deltas: readonly ControlledProviderToolCallDelta[]
): readonly ControlledProviderToolCall[] {
  const calls = new Map<number, { id: string; name: string; argumentsText: string }>();
  for (const delta of deltas) {
    const current = calls.get(delta.index) ?? { id: '', name: '', argumentsText: '' };
    if (delta.id !== undefined) {
      if (current.id && current.id !== delta.id) throw new Error('tool call ID changed');
      current.id = delta.id;
    }
    if (delta.name !== undefined) {
      if (current.name && current.name !== delta.name) throw new Error('tool call name changed');
      current.name = delta.name;
    }
    if (delta.argumentsDelta !== undefined) {
      current.argumentsText += delta.argumentsDelta;
      if (current.argumentsText.length > 8_000) throw new Error('tool call arguments are too large');
    }
    calls.set(delta.index, current);
  }
  const indexes = [...calls.keys()].sort((left, right) => left - right);
  if (indexes.some((index, position) => index !== position)) throw new Error('tool call indexes are not contiguous');
  const callIds = new Set<string>();
  return indexes.map((index) => {
    const call = calls.get(index)!;
    if (!call.id || !call.name || !protocolRegistry.has(call.name as CanonicalToolId)) throw new Error('tool call is incomplete');
    if (callIds.has(call.id)) throw new Error('tool call IDs are not unique');
    callIds.add(call.id);
    return { id: call.id, name: call.name, arguments: parseControlledToolArguments(call.argumentsText) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum = 2_000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('controlled tool text is invalid');
  }
  return value;
}

function boundedName(value: unknown): string {
  if (typeof value !== 'string' || !protocolRegistry.has(value as CanonicalToolId)) throw new Error('controlled tool name is invalid');
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function boundedArgumentsDelta(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8_000 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('controlled tool arguments are invalid');
  }
  return value;
}

function canonicalProviderTool(contract: CanonicalToolContract): ControlledProviderToolDefinition {
  return {
    type: 'function',
    function: {
      name: contract.toolId,
      description: contract.description,
      requiresExistingDocument: contract.preconditions.requiresExistingDocument,
      parameters: canonicalToolInputSchema(contract)
    }
  };
}

/** JSON object order is immaterial; every field, type and array entry must agree. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]));
}
