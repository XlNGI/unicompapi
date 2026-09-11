import { describe, expect, it, vi } from 'vitest';
import { runNativeSearch, nativeSearchTools } from '../../src/platform/providers/native-search-stream';
import type { NativeSearchRequest } from '../../src/domain/entities/native-search';
const request: NativeSearchRequest = { grantId: 'native-00000000-0000-0000-0000-000000000000', protocol: 'kimi_builtin', mode: 'auto' };
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
function session(delta: unknown, finish = 'stop', extra = {}, split = 0) {
  const data = `data: ${JSON.stringify({ id: 'response-1', model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }], usage, ...extra })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = new TextEncoder().encode(data);
  return { stream: (async function* () { if (split) { for (let i = 0; i < bytes.length; i += split) yield bytes.slice(i, i + split); } else yield bytes; })(), cancel: vi.fn(), close: vi.fn() };
}
const call = (name = '$web_search') => ({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{"query":"public news","usage":{"total_tokens":12}}' } }] });
function input(s: ReturnType<typeof session>, overrides = {}) {
  return { request, session: s, model: 'test-model', messages: [{ role: 'user' as const, content: '公开新闻' }], signal: new AbortController().signal,
    open: vi.fn(async (_messages: unknown) => session({ content: '已查询' })), observe: vi.fn(), ...overrides };
}
function event(delta: unknown, finish: string | null = null, extra = {}) {
  return `data: ${JSON.stringify({ id: 'response-1', model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function gatedSession(first: string, remaining: string) {
  const paused = gate(), resume = gate();
  const stream = (async function* () {
    yield new TextEncoder().encode(first);
    paused.release();
    await resume.promise;
    yield new TextEncoder().encode(remaining);
  })();
  return { ...session({}), stream, paused, resume };
}
describe('native search protocol, not model prose', () => {
  it('serializes independent native tools without extending document tool whitelist', () => {
    expect(nativeSearchTools(request)).toEqual([{ type: 'builtin_function', function: { name: '$web_search' } }]);
    expect(nativeSearchTools({ ...request, protocol: 'glm_web_search' })).toEqual([{ type: 'web_search', web_search: { enable: true, search_engine: 'search_std', search_result: true } }]);
  });
  it('echoes Kimi arguments with the original assistant tool call and aggregates token usage across requests', async () => {
    const opts = input(session(call(), 'tool_calls', {}, 1));
    const result = await runNativeSearch(opts);
    expect(result.content).toBe('已查询');
    expect(opts.open.mock.calls[0]?.[0]).toEqual([
      { role: 'user', content: '公开新闻' },
      { role: 'assistant', content: '', reasoningContent: '', nativeToolCalls: [{ id: 'call_1', type: 'function', function: { name: '$web_search', arguments: '{"query":"public news","usage":{"total_tokens":12}}' } }] },
      { role: 'tool', content: '{"query":"public news","usage":{"total_tokens":12}}', toolCallId: 'call_1', name: '$web_search' }
    ]);
    expect(result.usage).toContainEqual({ metricId: 'total_tokens', quantity: '26', unit: 'token', source: 'provider_body' });
    expect(opts.observe).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', toolCalls: 1, cost: 'not_reported', sources: [] }));
  });
  it('does not claim search when the model only says it searched and prints a URL', async () => {
    const opts = input(session({ content: '我已搜索 https://example.com' }));
    await runNativeSearch(opts);
    expect(opts.open).not.toHaveBeenCalled();
    expect(opts.observe).toHaveBeenCalledWith(expect.objectContaining({ status: 'unobserved', sources: [] }));
  });
  it('blocks required search without evidence and performs no retry', async () => {
    const opts = input(session({ content: '根据最新搜索结果' }), { request: { ...request, mode: 'required' as const } });
    await expect(runNativeSearch(opts)).rejects.toMatchObject({ safeCode: 'newapi.native_search_unobserved' });
    expect(opts.open).not.toHaveBeenCalled();
  });
  it('extracts GLM protocol citations, rejecting private and executable links', async () => {
    const opts = input(session({ content: '结论' }, 'stop', { web_search: [
      { title: '来源', link: 'https://example.com/news' }, { title: 'private', link: 'http://127.0.0.1/x' }, { title: 'code', link: 'javascript:alert(1)' }
    ] }), { request: { ...request, protocol: 'glm_web_search' as const } });
    await runNativeSearch(opts);
    expect(opts.observe).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', toolCalls: null, sources: [{ title: '来源', url: 'https://example.com/news' }] }));
  });
  it('reports real GLM sources before the stream finishes, once, and completes with cumulative citations', async () => {
    const firstSource = { title: '首个来源', link: 'https://example.com/news' };
    const secondSource = { title: '另一个来源', link: 'https://example.org/report' };
    const s = gatedSession(event({}, null, { web_search: [firstSource], choices: [] }),
      event({ content: '结论' }, 'stop', { web_search: [firstSource, secondSource], usage }) + 'data: [DONE]\n\n');
    const opts = input(s, { request: { ...request, protocol: 'glm_web_search' as const } });
    const result = runNativeSearch(opts);
    try {
      await s.paused.promise;
      expect(opts.observe).toHaveBeenCalledTimes(1);
      expect(opts.observe).toHaveBeenCalledWith(expect.objectContaining({ status: 'started', sources: [{ title: firstSource.title, url: firstSource.link }], requestUsage: [] }));
      expect(s.close).not.toHaveBeenCalled();
    } finally { s.resume.release(); }
    await result;
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started', 'completed']);
    expect(opts.observe).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed', sources: [
      { title: firstSource.title, url: firstSource.link }, { title: secondSource.title, url: secondSource.link }
    ], requestUsage: [usage] }));
  });
  it.each([
    ['assistant prose', event({ content: '我已搜索 https://example.com' })],
    ['empty structured results', event({}, null, { web_search: [] })],
    ['unsafe structured links', event({}, null, { web_search: [{ title: '私有地址', link: 'http://127.0.0.1/x' }, { title: '脚本', link: 'javascript:alert(1)' }] })]
  ])('does not report GLM search progress for %s', async (_label, first) => {
    const s = gatedSession(first, event({ content: '回答' }, 'stop', { usage }) + 'data: [DONE]\n\n');
    const opts = input(s, { request: { ...request, protocol: 'glm_web_search' as const } });
    const result = runNativeSearch(opts);
    try {
      await s.paused.promise;
      expect(opts.observe).not.toHaveBeenCalled();
    } finally { s.resume.release(); }
    await result;
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['unobserved']);
  });
  it('never reports progress from a malformed GLM event that happens to include a valid source', async () => {
    const opts = input(session({}, 'stop', { web_search: [{ title: '来源', link: 'https://example.com' }], choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] }),
      { request: { ...request, protocol: 'glm_web_search' as const } });
    await expect(runNativeSearch(opts)).rejects.toThrow();
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['failed']);
    expect(opts.observe).toHaveBeenLastCalledWith(expect.objectContaining({ sources: [] }));
  });
  it('keeps earlier search evidence but never completes when the later GLM stream is malformed', async () => {
    const s = gatedSession(event({}, null, { web_search: [{ title: '来源', link: 'https://example.com/news' }] }), 'data: {broken}\n\n');
    const opts = input(s, { request: { ...request, protocol: 'glm_web_search' as const } });
    const rejection = expect(runNativeSearch(opts)).rejects.toThrow();
    try {
      await s.paused.promise;
      expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started']);
    } finally { s.resume.release(); }
    await rejection;
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started', 'failed']);
    expect(opts.observe).toHaveBeenLastCalledWith(expect.objectContaining({ sources: [{ title: '来源', url: 'https://example.com/news' }] }));
  });
  it('reports cancellation without completion when cancelled after live GLM evidence', async () => {
    const control = new AbortController();
    const s = gatedSession(event({}, null, { web_search: [{ title: '来源', link: 'https://example.com/news' }] }),
      event({ content: '回答' }, 'stop', { usage }) + 'data: [DONE]\n\n');
    const opts = input(s, { request: { ...request, protocol: 'glm_web_search' as const }, signal: control.signal });
    const rejection = expect(runNativeSearch(opts)).rejects.toMatchObject({ safeCode: 'newapi.cancelled' });
    try {
      await s.paused.promise;
      expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started']);
      control.abort();
    } finally { s.resume.release(); }
    await rejection;
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started', 'cancelled']);
    expect(opts.open).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalled();
  });
  it('does not complete if cancellation arrives as the final stream read ends', async () => {
    const control = new AbortController();
    const s = session({ content: '回答' }, 'stop', { web_search: [{ title: '来源', link: 'https://example.com/news' }] });
    const originalStream = s.stream;
    s.stream = (async function* () { yield* originalStream; control.abort(); })();
    const opts = input(s, { request: { ...request, protocol: 'glm_web_search' as const }, signal: control.signal });
    await expect(runNativeSearch(opts)).rejects.toMatchObject({ safeCode: 'newapi.cancelled' });
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started', 'cancelled']);
  });
  it('rejects arbitrary tool calls without executing or echoing them', async () => {
    const opts = input(session(call('read_file'), 'tool_calls'));
    await expect(runNativeSearch(opts)).rejects.toThrow();
    expect(opts.open).not.toHaveBeenCalled();
  });
  it('stops the bounded loop without a fourth request', async () => {
    const opts = input(session(call(), 'tool_calls'), { open: vi.fn(async () => session(call(), 'tool_calls')) });
    await expect(runNativeSearch(opts)).rejects.toMatchObject({ safeCode: 'newapi.native_search_limit' });
    expect(opts.open).toHaveBeenCalledTimes(2);
  });
  it('honors cancellation before another request', async () => {
    const control = new AbortController(); control.abort();
    const opts = input(session(call(), 'tool_calls'), { signal: control.signal });
    await expect(runNativeSearch(opts)).rejects.toThrow();
    expect(opts.open).not.toHaveBeenCalled();
    expect(opts.observe).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });
  it.each(['observe', 'close'])('does not open the Kimi follow-up when %s triggers cancellation', async phase => {
    const control = new AbortController();
    const s = session(call(), 'tool_calls');
    const opts = input(s, { signal: control.signal });
    if (phase === 'observe') opts.observe.mockImplementation(async evidence => { if (evidence.status === 'started') control.abort(); });
    else s.close.mockImplementation(() => control.abort());
    await expect(runNativeSearch(opts)).rejects.toMatchObject({ safeCode: 'newapi.cancelled' });
    expect(opts.open).not.toHaveBeenCalled();
    expect(opts.observe.mock.calls.map(([evidence]) => evidence.status)).toEqual(['started', 'cancelled']);
  });
});
