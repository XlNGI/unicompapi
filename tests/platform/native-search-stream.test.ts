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
});
