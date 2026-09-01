import type { RagChunk } from './rag-service';

export interface RetrievalEvaluationCase {
  readonly query: string;
  readonly relevantChunkIds: readonly string[];
}

export interface RetrievalEvaluationMetrics {
  readonly caseCount: number;
  readonly recallAtK: number;
  readonly meanReciprocalRank: number;
  readonly emptyResultRate: number;
  readonly citationAccuracy: number;
  readonly supportRate: number;
}

export async function evaluateRetrieval(
  cases: readonly RetrievalEvaluationCase[],
  retrieve: (query: string) => Promise<readonly Pick<RagChunk, 'chunkId'>[]>
): Promise<RetrievalEvaluationMetrics> {
  if (cases.length === 0) {
    return {
      caseCount: 0,
      recallAtK: 0,
      meanReciprocalRank: 0,
      emptyResultRate: 0,
      citationAccuracy: 0,
      supportRate: 0
    };
  }

  let recalled = 0;
  let reciprocalRank = 0;
  let empty = 0;
  let cited = 0;
  let correctCitations = 0;
  let supported = 0;
  for (const testCase of cases) {
    const relevant = new Set(testCase.relevantChunkIds);
    const results = await retrieve(testCase.query);
    if (results.length === 0) empty += 1;
    const resultIds = results.map((result) => result.chunkId);
    const hits = resultIds.filter((id) => relevant.has(id));
    if (hits.length > 0) supported += 1;
    recalled += relevant.size === 0 ? 0 : new Set(hits).size / relevant.size;
    const firstHit = resultIds.findIndex((id) => relevant.has(id));
    if (firstHit >= 0) reciprocalRank += 1 / (firstHit + 1);
    cited += resultIds.length;
    correctCitations += hits.length;
  }

  return {
    caseCount: cases.length,
    recallAtK: recalled / cases.length,
    meanReciprocalRank: reciprocalRank / cases.length,
    emptyResultRate: empty / cases.length,
    citationAccuracy: cited === 0 ? 0 : correctCitations / cited,
    supportRate: supported / cases.length
  };
}
