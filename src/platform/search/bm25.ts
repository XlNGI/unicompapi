export interface Bm25Document {
  readonly id: string;
  readonly text: string;
}

export interface Bm25Score {
  readonly id: string;
  readonly score: number;
}

const K1 = 1.2;
const B = 0.75;

export function tokenizeChinese(text: string): readonly string[] {
  const normalized = text.toLowerCase();
  const words = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const word of words) {
    if (/^[a-z0-9]+$/.test(word)) {
      tokens.push(word);
      continue;
    }
    const chars = Array.from(word);
    for (const char of chars) {
      tokens.push(char);
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return tokens;
}

export function scoreBm25(
  documents: readonly Bm25Document[],
  query: string
): readonly Bm25Score[] {
  const queryTokens = [...new Set(tokenizeChinese(query))];
  if (queryTokens.length === 0) return [];
  const documentCount = documents.length;
  const averageLength =
    documentCount === 0
      ? 0
      : documents.reduce((sum, doc) => sum + doc.text.length, 0) / documentCount;
  const documentFrequency = new Map<string, number>();
  const termFrequencies = documents.map((doc) => {
    const frequencies = new Map<string, number>();
    for (const token of tokenizeChinese(doc.text)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    return frequencies;
  });
  const results: Bm25Score[] = [];
  documents.forEach((doc, index) => {
    const frequencies = termFrequencies[index];
    let score = 0;
    for (const token of queryTokens) {
      const termFrequency = frequencies.get(token) ?? 0;
      if (termFrequency === 0) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(
        1 +
          (documentCount - df + 0.5) / (df + 0.5)
      );
      const denominator =
        termFrequency +
        K1 * (1 - B + (B * doc.text.length) / (averageLength || 1));
      score += idf * ((termFrequency * (K1 + 1)) / denominator);
    }
    if (score > 0) {
      results.push({ id: doc.id, score });
    }
  });
  return results.sort((a, b) => b.score - a.score);
}

export function retrieveTopK(
  documents: readonly Bm25Document[],
  query: string,
  k = 3
): readonly Bm25Score[] {
  return scoreBm25(documents, query).slice(0, k);
}
