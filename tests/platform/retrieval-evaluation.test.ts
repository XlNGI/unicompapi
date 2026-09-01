import { describe, expect, it } from 'vitest';
import { evaluateRetrieval } from '../../src/platform';

describe('retrieval evaluation', () => {
  it('reports recall, MRR, empty results and citation accuracy', async () => {
    const metrics = await evaluateRetrieval(
      [
        { query: 'alpha', relevantChunkIds: ['a'] },
        { query: 'beta', relevantChunkIds: ['b', 'c'] },
        { query: 'gamma', relevantChunkIds: ['missing'] }
      ],
      async (query) => {
        if (query === 'alpha') return [{ chunkId: 'a' }, { chunkId: 'noise' }];
        if (query === 'beta') return [{ chunkId: 'noise' }, { chunkId: 'b' }];
        return [];
      }
    );

    expect(metrics.caseCount).toBe(3);
    expect(metrics.recallAtK).toBeCloseTo((1 + 0.5) / 3);
    expect(metrics.meanReciprocalRank).toBeCloseTo((1 + 0.5) / 3);
    expect(metrics.emptyResultRate).toBeCloseTo(1 / 3);
    expect(metrics.citationAccuracy).toBeCloseTo(2 / 4);
    expect(metrics.supportRate).toBeCloseTo(2 / 3);
  });

  it('returns zero metrics for an empty evaluation set', async () => {
    await expect(evaluateRetrieval([], async () => [])).resolves.toEqual({
      caseCount: 0,
      recallAtK: 0,
      meanReciprocalRank: 0,
      emptyResultRate: 0,
      citationAccuracy: 0,
      supportRate: 0
    });
  });
});
