import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('preserved intent evaluation corpus', () => {
  it('retains all 73 historical language cases as data for model evaluation', async () => {
    const suite = JSON.parse(await readFile(new URL('./conversation-intent-golden.json', import.meta.url), 'utf8'));
    expect(suite.schemaVersion).toBe(1);
    expect(suite.cases).toHaveLength(73);
    for (const item of suite.cases) {
      expect(typeof item.input).toBe('string');
      expect(['chat', 'document', 'unknown']).toContain(item.expectedKind);
    }
    // A local rule implementation is deliberately not the oracle. Actual
    // semantic quality requires an explicitly authorized model evaluation.
  });
});
