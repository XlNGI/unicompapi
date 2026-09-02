export interface ControlledProviderToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

const maxTools = 8;
const maxSchemaBytes = 16_000;
const allowedToolNames = new Set([
  'extract_source',
  'aggregate_data',
  'generate_chart',
  'select_material',
  'read_document_structure',
  'apply_document_patch',
  'render_preview',
  'inspect_layout'
]);

export function parseControlledProviderTools(value: unknown): readonly ControlledProviderToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > maxTools) {
    throw new Error('controlled tool definitions are invalid');
  }
  const names = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || item.type !== 'function' || !isRecord(item.function)) {
      throw new Error(`controlled tool ${index} is invalid`);
    }
    const name = item.function.name;
    if (typeof name !== 'string' || !allowedToolNames.has(name) || names.has(name)) {
      throw new Error(`controlled tool ${index} name is invalid`);
    }
    names.add(name);
    const parameters = item.function.parameters;
    if (!isRecord(parameters) || JSON.stringify(parameters).length > maxSchemaBytes) {
      throw new Error(`controlled tool ${index} parameters are invalid`);
    }
    return {
      type: 'function' as const,
      function: {
        name,
        ...(item.function.description !== undefined
          ? { description: boundedText(item.function.description) }
          : {}),
        parameters
      }
    };
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

export interface ControlledProviderToolBridge {
  execute(input: {
    readonly call: ControlledProviderToolCall;
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface ControlledProviderToolLoopMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface ControlledProviderToolLoopResponse {
  readonly content?: string;
  readonly toolCalls?: readonly ControlledProviderToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length';
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
    messages.push({ role: 'assistant', content: assistantContent });
    for (const call of calls) {
      if (!allowedToolNames.has(call.name) || !call.id) throw new Error('tool call is not allowed');
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
  return sanitizeToolValue(value, 0) as Readonly<Record<string, unknown>>;
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
    const argumentsDelta = fn?.arguments === undefined ? undefined : boundedText(fn.arguments, 8_000);
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
  return indexes.map((index) => {
    const call = calls.get(index)!;
    if (!call.id || !call.name || !allowedToolNames.has(call.name)) throw new Error('tool call is incomplete');
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
  if (typeof value !== 'string' || !allowedToolNames.has(value)) throw new Error('controlled tool name is invalid');
  return value;
}
