import { afterEach, describe, expect, it, vi } from 'vitest';
import { planPresentationArtDirection } from '../../src/application/presentation-art-direction';
import { buildDocumentIRFromOutline } from '../../src/domain/entities/document-agent';
import { buildFallbackPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import type { DocumentOutline } from '../../src/domain';

const outline: DocumentOutline = { kind: 'ppt', title: 'Fixed facts', sections: [{ heading: 'Result', level: 1,
  takeaway: 'The pilot improved throughput', blocks: [{ type: 'bullets', items: ['Throughput: 42%', 'Cost: 18%'] }] }] };
const base = { outline, documentIR: buildDocumentIRFromOutline({ outline, operation: 'create' }),
  userRequirement: 'Keep whitespace generous and emphasize the second metric.' };
afterEach(() => vi.useRealTimers());

describe('bounded Application Art Direction stage', () => {
  it('projects semantic inputs, validates one response, and preserves content facts', async () => {
    const original = JSON.stringify(outline);
    const design = buildFallbackPresentationDesignIR(outline);
    const request = vi.fn(async () => JSON.stringify(design));
    const result = await planPresentationArtDirection({ ...base, signal: new AbortController().signal, request });
    expect(result.designIR).toEqual(design);
    expect(result.diagnostics).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(request.mock.calls)).not.toContain('attachmentRefs');
    expect(JSON.stringify(outline)).toBe(original);
  });

  it('extends the bounded Art Direction wait for larger page counts', async () => {
    const manyPageOutline: DocumentOutline = { ...outline, sections: Array.from({ length: 6 }, (_, index) => ({
      ...outline.sections[0], heading: `Section ${index + 1}`
    })) };
    const design = buildFallbackPresentationDesignIR(manyPageOutline);
    let timeoutMs = 0;
    const result = await planPresentationArtDirection({ ...base, outline: manyPageOutline,
      documentIR: buildDocumentIRFromOutline({ outline: manyPageOutline, operation: 'create' }),
      signal: new AbortController().signal,
      request: async request => { timeoutMs = request.timeoutMs; return JSON.stringify(design); } });
    expect(result.designIR).toEqual(design);
    expect(timeoutMs).toBe(115_000);
  });

  it.each(['{broken', '{"schemaVersion":2', JSON.stringify({ schemaVersion: 2, globalDesign: {}, pages: [] })])
    ('invalid response chooses legacy rendering without a second request: %s', async response => {
      const request = vi.fn(async () => response);
      const result = await planPresentationArtDirection({ ...base, signal: new AbortController().signal, request });
      expect(result.designIR).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(request).toHaveBeenCalledTimes(1);
    });

  it('unavailable and failing providers produce safe fallback diagnostics', async () => {
    expect((await planPresentationArtDirection({ ...base, signal: new AbortController().signal })).diagnostics)
      .toEqual([{ code: 'art_direction_unavailable' }]);
    const result = await planPresentationArtDirection({ ...base, signal: new AbortController().signal,
      request: async () => { throw new Error('secret C:/private'); } });
    expect(result).toMatchObject({ diagnostics: [{ code: 'art_direction_failed' }] });
    expect(JSON.stringify(result.diagnostics)).not.toContain('private');
  });

  it.each([
    ['classification_invalid_response', 'art_direction_provider_response_incomplete'],
    ['semantic_response_incomplete', 'art_direction_provider_response_incomplete'],
    ['semantic_output_budget_exceeded', 'art_direction_output_budget_exceeded']
  ])('preserves only an allowlisted failure category for %s', async (message, code) => {
    const result = await planPresentationArtDirection({ ...base, signal: new AbortController().signal,
      request: async () => { throw new Error(message); } });
    expect(result.diagnostics).toEqual([{ code }]);
  });

  it('bounds a hung provider and ignores a late successful result', async () => {
    vi.useFakeTimers();
    let late!: (value: unknown) => void;
    let childSignal: AbortSignal | undefined;
    const operation = planPresentationArtDirection({ ...base, signal: new AbortController().signal, timeoutMs: 10,
      request: ({ signal }) => { childSignal = signal; return new Promise(resolve => { late = resolve; }); } });
    await vi.advanceTimersByTimeAsync(11);
    expect(await operation).toMatchObject({ diagnostics: [{ code: 'art_direction_timeout' }] });
    expect(childSignal?.aborted).toBe(true);
    late(buildFallbackPresentationDesignIR(outline));
    expect((await operation).designIR).toBeUndefined();
  });

  it('cancellation aborts the child and never turns into template fallback', async () => {
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    const operation = planPresentationArtDirection({ ...base, signal: parent.signal,
      request: ({ signal }) => { childSignal = signal; return new Promise(() => undefined); } });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    parent.abort();
    await rejected;
    expect(childSignal?.aborted).toBe(true);
  });
});
