import { describe, expect, it, vi } from 'vitest';
import {
  runControlledProviderToolRounds,
  type ControlledProviderToolRoundResponse,
  type ProviderExecutionLifecyclePort
} from '../../src/platform/providers/provider-tool-calling';
import { providerExecutionLifecycleFixture } from '../fixtures/provider-execution-lifecycle';

const call = { id: 'model-private-call', name: 'generate_pptx', arguments: { title: 'Private title', content: 'Private content' } };
const result = { schemaVersion: 1, status: 'success', observation: { artifactRegistered: true },
  artifactRefs: [{ kind: 'work', ref: 'work-local-1' }], metadata: { toolId: 'generate_pptx', callId: call.id } };

function loop(lifecycle: ProviderExecutionLifecyclePort, execute = vi.fn(async () => result), next = vi.fn(async () => ({ finishReason: 'stop' }))) {
  const messages: string[] = [];
  return { execute, next, messages, pending: runControlledProviderToolRounds<string, ControlledProviderToolRoundResponse>({
    initialResponse: { finishReason: 'tool_calls', toolCalls: [call] }, messages,
    signal: new AbortController().signal, executionLifecycle: lifecycle,
    shouldContinue: value => value.finishReason === 'tool_calls', appendAssistant: () => undefined,
    appendTool: (_call, value, target) => target.push(JSON.stringify(value)),
    bridge: { execute: async input => { await input.onExecutionAdmitted?.(); return execute(); } }, requestNext: next, toLoopError: code => new Error(code)
  }) };
}

describe('Provider execution durable boundaries', () => {
  it('commits Started before executing, Result before Observation, and Observation before continuation', async () => {
    const events: string[] = [];
    const fixture = providerExecutionLifecycleFixture(name => { events.push(name); });
    const execute = vi.fn(async () => { events.push('execute'); return result; });
    const next = vi.fn(async () => { events.push('continuation'); return { finishReason: 'stop' }; });
    const run = loop(fixture.port, execute, next);
    await run.pending;
    expect(events).toEqual(['toolStarted', 'toolAdmitted', 'execute', 'toolResult', 'observationCommitted', 'continuation']);
    expect(fixture.events[0].input).toMatchObject({ round: 0, stepRef: 'provider-tool-0-0', toolId: 'generate_pptx', argumentsHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(fixture.events[2].input).toMatchObject({ status: 'success', outcomeUnknown: false, admissionPhase: 'admitted', registeredWorkIds: ['work-local-1'] });
    expect(JSON.stringify(fixture.events)).not.toMatch(/Private title|Private content|model-private-call/);
    expect(run.messages[0]).not.toContain('work-local-1');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['toolStarted', 'toolAdmitted', 'toolResult', 'observationCommitted'] as const)('stops at a %s commit failure without replaying a write or sending continuation', async boundary => {
    const fixture = providerExecutionLifecycleFixture(name => { if (name === boundary) throw new Error('private journal path'); });
    const run = loop(fixture.port);
    await expect(run.pending).rejects.toThrow('execution_journal_failed');
    expect(run.execute).toHaveBeenCalledTimes(['toolStarted', 'toolAdmitted'].includes(boundary) ? 0 : 1);
    expect(run.next).not.toHaveBeenCalled();
    expect(fixture.events.map(event => event.name)).toEqual(boundary === 'toolStarted' ? ['toolStarted'] :
      boundary === 'toolAdmitted' ? ['toolStarted', 'toolAdmitted'] :
        boundary === 'toolResult' ? ['toolStarted', 'toolAdmitted', 'toolResult'] : ['toolStarted', 'toolAdmitted', 'toolResult', 'observationCommitted']);
  });

  it('retains an unknown tool Result but forbids its Observation and any further tool or model dispatch', async () => {
    const fixture = providerExecutionLifecycleFixture();
    const execute = vi.fn(async () => ({ ...result, status: 'unknown' }));
    const run = loop(fixture.port, execute);
    await expect(run.pending).rejects.toThrow('unknown_result');
    expect(fixture.events.map(event => event.name)).toEqual(['toolStarted', 'toolAdmitted', 'toolResult']);
    expect(fixture.events[2].input).toMatchObject({ outcomeUnknown: true, status: 'unknown', admissionPhase: 'admitted' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.next).not.toHaveBeenCalled();
  });

  it('does not invent a successful Result or Observation when a tool throws after its Started boundary', async () => {
    const fixture = providerExecutionLifecycleFixture();
    const execute = vi.fn(async () => { throw new Error('unknown local write result'); });
    const run = loop(fixture.port, execute);
    await expect(run.pending).rejects.toThrow('unknown local write result');
    expect(fixture.events.map(event => event.name)).toEqual(['toolStarted', 'toolAdmitted']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.next).not.toHaveBeenCalled();
  });

  it('cancels a stalled write-ahead commit and ignores its late completion without invoking the tool', async () => {
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = providerExecutionLifecycleFixture(async name => { if (name === 'toolStarted') { entered(); await gate; } });
    const controller = new AbortController();
    const execute = vi.fn(async () => result);
    const next = vi.fn(async () => ({ finishReason: 'stop' }));
    const pending = runControlledProviderToolRounds<string, ControlledProviderToolRoundResponse>({
      initialResponse: { finishReason: 'tool_calls', toolCalls: [call] }, messages: [],
      signal: controller.signal, executionLifecycle: fixture.port,
      shouldContinue: value => value.finishReason === 'tool_calls', appendAssistant: () => undefined, appendTool: () => undefined,
      bridge: { execute }, requestNext: next, toLoopError: code => new Error(code)
    });
    await began;
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    release();
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
