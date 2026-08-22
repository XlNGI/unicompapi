import { describe, expect, it } from 'vitest';
import { retrieveTopK, scoreBm25, tokenizeChinese } from '../../src/platform';

const documents = [
  { id: 'a', text: '本周完成了方案评审，修复了三个缺陷。' },
  { id: 'b', text: '销售数据：华东营收 3000 万，同比增长 18%。' },
  { id: 'c', text: '下周计划发布新版本，准备上线检查单。' }
];

describe('BM25 retrieval', () => {
  it('tokenizes Chinese text into characters and bigrams', () => {
    const tokens = tokenizeChinese('方案评审');
    expect(tokens).toContain('方');
    expect(tokens).toContain('方案');
    expect(tokens).toContain('评审');
  });

  it('ranks documents by query relevance', () => {
    const scores = scoreBm25(documents, '销售数据 营收');
    expect(scores[0].id).toBe('b');
  });

  it('returns top-k results only', () => {
    const results = retrieveTopK(documents, '评审 缺陷', 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });
});
