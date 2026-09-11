import type { NativeSearchEvidence, NativeSearchRequest } from '../../domain/entities/native-search';
import type { UsageFactV1 } from '../../domain';
import type { NewApiEventStreamSession } from './newapi/newapi-runtime';

export interface NativeSearchMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly reasoningContent?: string;
  readonly nativeToolCalls?: readonly NativeToolCall[];
}
interface NativeToolCall { readonly id: string; readonly type: 'function'; readonly function: { readonly name: '$web_search'; readonly arguments: string } }
export class NativeSearchProtocolError extends Error {
  constructor(readonly safeCode: string) { super(safeCode); }
}
const invalid = () => new NativeSearchProtocolError('newapi.native_search_response_invalid');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 1_000_000): string => {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw invalid();
  return v;
};
export function nativeSearchTools(request: NativeSearchRequest): readonly unknown[] {
  return request.protocol === 'kimi_builtin'
    ? [{ type: 'builtin_function', function: { name: '$web_search' } }]
    : [{ type: 'web_search', web_search: { enable: true, search_engine: 'search_std', search_result: true, ...(request.mode === 'required' ? { search_intent: 'false', require_search: true } : {}) } }];
}
/** Only protocol fields are evidence. URLs in assistant prose are deliberately ignored. */
export async function runNativeSearch(input: {
  readonly request: NativeSearchRequest;
  readonly session: NewApiEventStreamSession;
  readonly messages: readonly NativeSearchMessage[];
  readonly model: string;
  readonly signal: AbortSignal;
  readonly open: (messages: readonly NativeSearchMessage[]) => Promise<NewApiEventStreamSession>;
  readonly observe: (evidence: NativeSearchEvidence) => Promise<void>;
}): Promise<{ finishReason: 'stop' | 'length'; content: string; contentLength: number; usage?: readonly UsageFactV1[] }> {
  let session = input.session;
  const messages = [...input.messages];
  let calls = 0;
  let glmStarted = false;
  let searchContentTokens: number | null = 0;
  const requestUsage: (Record<string, number> | null)[] = [];
  const sources = new Map<string, { title: string; url: string }>();
  const totals = new Map<string, number>();
  let allUsageReported = true;
  const evidence = (status: NativeSearchEvidence['status']): NativeSearchEvidence => ({
    status, toolCalls: input.request.protocol === 'kimi_builtin' ? calls : null,
    sources: [...sources.values()], requestUsage: [...requestUsage], searchContentTokens: input.request.protocol === 'kimi_builtin' ? searchContentTokens : null, retrievedAt: new Date().toISOString(), cost: 'not_reported'
  });
  const checkCancelled = () => { if (input.signal.aborted) throw new NativeSearchProtocolError('newapi.cancelled'); };
  try {
    // At most three requests, no automatic retry or provider fallback.
    for (let round = 0; round < 3; round += 1) {
      checkCancelled();
      const parsed = await readNativeStream(session.stream, input.model, input.request.protocol, checkCancelled, async observedSources => {
        for (const source of observedSources) if (sources.size < 30) sources.set(source.url, source);
        if (!glmStarted && sources.size > 0) {
          checkCancelled();
          glmStarted = true;
          await input.observe(evidence('started'));
          checkCancelled();
        }
      });
      checkCancelled();
      requestUsage.push(parsed.usage ?? null);
      if (parsed.usage) for (const [key, n] of Object.entries(parsed.usage)) totals.set(key, (totals.get(key) ?? 0) + n);
      else allUsageReported = false;
      for (const source of parsed.sources) if (sources.size < 30) sources.set(source.url, source);
      if (parsed.finish === 'tool_calls') {
        if (input.request.protocol !== 'kimi_builtin' || parsed.calls.length === 0 || calls + parsed.calls.length > 4 || round === 2) {
          throw new NativeSearchProtocolError('newapi.native_search_limit');
        }
        calls += parsed.calls.length;
        messages.push({ role: 'assistant', content: parsed.content, reasoningContent: parsed.reasoning, nativeToolCalls: parsed.calls });
        for (const call of parsed.calls) {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          const tokens = record(args.usage) ? args.usage.total_tokens : undefined;
          searchContentTokens = searchContentTokens !== null && Number.isSafeInteger(tokens) && Number(tokens) >= 0 ? searchContentTokens + Number(tokens) : null;
          // Kimi executes the built-in tool remotely; documented handshake echoes its JSON arguments.
          messages.push({ role: 'tool', content: call.function.arguments, toolCallId: call.id, name: '$web_search' });
        }
        await input.observe(evidence('started'));
        checkCancelled();
        session.close();
        checkCancelled();
        session = await input.open(messages);
        continue;
      }
      const observed = calls > 0 || sources.size > 0;
      if (!parsed.content.trim()) throw invalid();
      checkCancelled();
      await input.observe(evidence(observed ? 'completed' : 'unobserved'));
      if (input.request.mode === 'required' && !observed) throw new NativeSearchProtocolError('newapi.native_search_unobserved');
      return {
        finishReason: parsed.finish, content: parsed.content, contentLength: parsed.content.length,
        ...(allUsageReported ? { usage: [...totals].map(([metricId, quantity]) => ({ metricId, quantity: String(quantity), unit: 'token', source: 'provider_body' as const })) } : {})
      };
    }
    throw new NativeSearchProtocolError('newapi.native_search_limit');
  } catch (error) {
    if (!(error instanceof NativeSearchProtocolError && error.safeCode === 'newapi.native_search_unobserved')) {
      await input.observe(evidence(input.signal.aborted ? 'cancelled' : 'failed'));
    }
    throw error;
  } finally { session.close(); }
}
async function readNativeStream(
  stream: AsyncIterable<Uint8Array>, model: string, protocol: NativeSearchRequest['protocol'], checkCancelled: () => void,
  observeSources: (sources: readonly { title: string; url: string }[]) => Promise<void>
) {
  let content = '', reasoning = '', buffer = '', id: string | undefined;
  let bytes = 0, done = false, finish: 'stop' | 'length' | 'tool_calls' | undefined;
  let usage: Record<string, number> | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const sources: { title: string; url: string }[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const event = (raw: string): { title: string; url: string }[] => {
    const eventSources: { title: string; url: string }[] = [];
    const lines = raw.split('\n').filter(line => line && !line.startsWith(':'));
    if (!lines.length) return eventSources;
    if (done || lines.some(line => !line.startsWith('data:'))) throw invalid();
    const data = lines.map(line => line.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') { if (!finish) throw invalid(); done = true; return eventSources; }
    const chunk: unknown = JSON.parse(data);
    if (!record(chunk) || typeof chunk.id !== 'string' || typeof chunk.model !== 'string' || chunk.model.toLowerCase() !== model.toLowerCase() || !Array.isArray(chunk.choices)) throw invalid();
    id ??= chunk.id;
    if (id !== chunk.id) throw invalid();
    if (chunk.usage != null) {
      if (usage || !record(chunk.usage)) throw invalid();
      const u = chunk.usage;
      if (['prompt_tokens', 'completion_tokens', 'total_tokens'].some(k => !Number.isSafeInteger(u[k]) || Number(u[k]) < 0) ||
          Number(u.prompt_tokens) + Number(u.completion_tokens) !== u.total_tokens) throw invalid();
      usage = { prompt_tokens: Number(u.prompt_tokens), completion_tokens: Number(u.completion_tokens), total_tokens: Number(u.total_tokens) };
    }
    if (protocol === 'glm_web_search' && chunk.web_search !== undefined) {
      if (!Array.isArray(chunk.web_search) || chunk.web_search.length > 50) throw invalid();
      for (const s of chunk.web_search) {
        if (!record(s)) throw invalid();
        const title = text(s.title, 500), url = safeSourceUrl(s.link);
        if (url) eventSources.push({ title, url });
      }
    }
    if (chunk.choices.length > 1) throw invalid();
    if (!chunk.choices.length) return eventSources;
    const choice = chunk.choices[0];
    if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw invalid();
    const d = choice.delta;
    if (finish && (d.content || d.tool_calls || d.reasoning_content)) throw invalid();
    if (d.content != null) content += text(d.content);
    if (d.reasoning_content != null) reasoning += text(d.reasoning_content);
    if (content.length + reasoning.length > 1_000_000) throw invalid();
    if (d.tool_calls != null) {
      if (protocol !== 'kimi_builtin' || !Array.isArray(d.tool_calls) || d.tool_calls.length > 4) throw invalid();
      for (const delta of d.tool_calls) {
        if (!record(delta) || !Number.isInteger(delta.index) || Number(delta.index) < 0 || Number(delta.index) > 3 ||
            (delta.type !== undefined && delta.type !== 'function')) throw invalid();
        const c = calls.get(Number(delta.index)) ?? { id: '', name: '', arguments: '' };
        if (delta.id !== undefined) { const next = text(delta.id, 200); if (c.id && c.id !== next) throw invalid(); c.id = next; }
        if (delta.function !== undefined) {
          if (!record(delta.function)) throw invalid();
          if (delta.function.name !== undefined) c.name += text(delta.function.name, 100);
          if (delta.function.arguments !== undefined) c.arguments += text(delta.function.arguments, 262_144);
        }
        if (c.arguments.length > 262_144) throw invalid();
        calls.set(Number(delta.index), c);
      }
    }
    if (choice.finish_reason != null) {
      if (finish || !['stop', 'length', 'tool_calls'].includes(String(choice.finish_reason))) throw invalid();
      finish = choice.finish_reason as 'stop' | 'length' | 'tool_calls';
    }
    return eventSources;
  };
  const consumeEvent = async (raw: string) => {
    checkCancelled();
    // Publish only after the complete event passes structural validation.
    const eventSources = event(raw);
    if (eventSources.length) {
      for (const source of eventSources) if (sources.length < 30 && !sources.some(existing => existing.url === source.url)) sources.push(source);
      await observeSources(eventSources);
      checkCancelled();
    }
  };
  for await (const chunk of stream) {
    checkCancelled();
    bytes += chunk.byteLength;
    if (bytes > 8 * 1024 * 1024) throw invalid();
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) { await consumeEvent(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
  }
  checkCancelled();
  buffer += decoder.decode();
  if (buffer.trim()) await consumeEvent(buffer);
  if (!done || !finish || (calls.size > 0 && finish !== 'tool_calls')) throw invalid();
  const resultCalls: NativeToolCall[] = [...calls].sort(([a], [b]) => a - b).map(([, c]) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(c.id) || c.name !== '$web_search' || !record(JSON.parse(c.arguments))) throw invalid();
    return { id: c.id, type: 'function', function: { name: '$web_search', arguments: c.arguments } };
  });
  if (new Set(resultCalls.map(c => c.id)).size !== resultCalls.length) throw invalid();
  return { content, reasoning, finish, usage, calls: resultCalls, sources };
}
function safeSourceUrl(v: unknown): string | undefined {
  try {
    const url = new URL(text(v, 2048));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || url.hostname.includes(':')) return;
    return url.href;
  } catch { return; }
}
