import { describe, expect, it } from 'vitest';
import {
  assembleControlledToolCalls,
  parseControlledProviderTools,
  parseControlledToolCallDeltas,
  runControlledProviderToolLoop
} from '../../src/platform/providers/provider-tool-calling';

describe('controlled provider tool calling', () => {
  it('accepts bounded function schemas and rejects duplicate or unsafe names', () => {
    const tools = parseControlledProviderTools([{
      type: 'function',
      function: {
        name: 'apply_document_patch',
        description: 'Apply a bounded document patch',
        parameters: { type: 'object', properties: { operation: { type: 'string' } } }
      }
    }]);
    expect(tools?.[0]?.function.name).toBe('apply_document_patch');
    expect(() => parseControlledProviderTools([
      { type: 'function', function: { name: 'x', parameters: {} } },
      { type: 'function', function: { name: 'x', parameters: {} } }
    ])).toThrow();
  });

  it('validates tool-call deltas without exposing arbitrary payloads', () => {
    expect(parseControlledToolCallDeltas([{
      index: 0,
      id: 'call-1',
      function: { name: 'apply_document_patch', arguments: '{"operation":"clear_section"}' }
    }])).toEqual([{
      index: 0,
      id: 'call-1',
      name: 'apply_document_patch',
      argumentsDelta: '{"operation":"clear_section"}'
    }]);
    expect(() => parseControlledToolCallDeltas([{
      index: 0,
      function: { name: 'run_shell', arguments: '{}' }
    }])).toThrow();
  });

  it('assembles streamed deltas and performs one bounded tool round', async () => {
    const calls = assembleControlledToolCalls([
      { index: 0, id: 'call-1', name: 'inspect_layout', argumentsDelta: '{"kind":"ppt"}' }
    ]);
    expect(calls[0]).toMatchObject({ id: 'call-1', name: 'inspect_layout', arguments: { kind: 'ppt' } });
    let round = 0;
    const result = await runControlledProviderToolLoop({
      messages: [{ role: 'user', content: 'inspect' }],
      request: async () => {
        round += 1;
        return round === 1
          ? { finishReason: 'tool_calls' as const, toolCalls: calls }
          : { finishReason: 'stop' as const, content: 'done' };
      },
      bridge: { execute: async ({ call }) => ({ ok: true, operation: call.name }) }
    });
    expect(result.content).toBe('done');
    expect(result.messages.at(-1)?.role).toBe('tool');
  });
});
