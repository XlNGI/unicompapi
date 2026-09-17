import { describe, expect, it } from 'vitest';
import {
  formatHistorySummary,
  summarizeHistoryNodes
} from '../../src/components/GenerationHistory';

describe('generation history timeline summary', () => {
  it('counts every registered work node as a success', () => {
    const summary = summarizeHistoryNodes([{ kind: 'work' } as const, { kind: 'work' } as const]);
    expect(summary).toEqual({ failed: 0, running: 0, succeeded: 2, uncertain: 0 });
  });

  it('counts failed executions as failures instead of successes', () => {
    const summary = summarizeHistoryNodes([
      { kind: 'work' } as const,
      { kind: 'failed' } as const,
      { kind: 'failed' } as const
    ]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(2);
  });

  it('groups pending, awaiting receipt and receiving nodes as running', () => {
    const summary = summarizeHistoryNodes([
      { kind: 'pending' } as const,
      { kind: 'awaiting_receipt' } as const,
      { kind: 'receiving' } as const
    ]);
    expect(summary.running).toBe(3);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.uncertain).toBe(0);
  });

  it('keeps uncertain nodes out of both the succeeded and failed totals', () => {
    const summary = summarizeHistoryNodes([{ kind: 'uncertain' } as const]);
    expect(summary).toEqual({ failed: 0, running: 0, succeeded: 0, uncertain: 1 });
  });

  it('never drops a node: the buckets always add up to the rendered node count', () => {
    const nodes = [
      { kind: 'work' } as const,
      { kind: 'work' } as const,
      { kind: 'pending' } as const,
      { kind: 'awaiting_receipt' } as const,
      { kind: 'receiving' } as const,
      { kind: 'failed' } as const,
      { kind: 'uncertain' } as const,
      { kind: 'uncertain' } as const
    ];
    const summary = summarizeHistoryNodes(nodes);
    expect(summary.succeeded + summary.failed + summary.running + summary.uncertain).toBe(
      nodes.length
    );
  });

  it('always states the succeeded and failed totals even when both are zero', () => {
    expect(summarizeHistoryNodes([])).toEqual({
      failed: 0,
      running: 0,
      succeeded: 0,
      uncertain: 0
    });
    expect(formatHistorySummary(summarizeHistoryNodes([]))).toBe('成功 0 · 失败 0');
  });

  it('reports a clean run without inventing status buckets', () => {
    expect(formatHistorySummary({ failed: 0, running: 0, succeeded: 10, uncertain: 0 })).toBe(
      '成功 10 · 失败 0'
    );
  });

  it('only mentions running entries while a generation is actually in flight', () => {
    expect(formatHistorySummary({ failed: 2, running: 1, succeeded: 8, uncertain: 0 })).toBe(
      '成功 8 · 失败 2 · 进行中 1'
    );
  });

  it('only mentions uncertain entries when an execution still needs confirmation', () => {
    expect(formatHistorySummary({ failed: 1, running: 0, succeeded: 7, uncertain: 2 })).toBe(
      '成功 7 · 失败 1 · 待确认 2'
    );
  });

  it('lists every bucket in outcome order for a mixed timeline', () => {
    const summary = summarizeHistoryNodes([
      { kind: 'work' } as const,
      { kind: 'work' } as const,
      { kind: 'failed' } as const,
      { kind: 'pending' } as const,
      { kind: 'uncertain' } as const
    ]);
    expect(formatHistorySummary(summary)).toBe('成功 2 · 失败 1 · 进行中 1 · 待确认 1');
  });
});
