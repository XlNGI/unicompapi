import { describe, expect, it } from 'vitest';
import {
  PARAMETER_INPUT_MAX_LATENCY_MS,
  PARAMETER_INPUT_MIN_SAMPLES,
  isParameterInputPerformanceSummary,
  isValidSample,
  roundMilliseconds,
  summarizeParameterInputSamples,
  type ParameterInputSample
} from '../../src/shared/parameter-input-performance';

/**
 * P0 evidence suite for the parameter input baseline.
 *
 * It proves the harness can produce the numbers P3 needs — visible latency
 * p50/p95/max plus parent commit, candidate request and autosave IPC counts for
 * a session of at least 30 consecutive inputs — and that the recorded shape
 * cannot carry user content. It deliberately does NOT assert the 100 ms target:
 * that is P3's GREEN, and recording a violated target before the fix would be a
 * meaningless gate.
 */

/** 32 consecutive inputs, each one millisecond slower than the last. */
function buildSamples(
  overrides: Partial<ParameterInputSample> = {},
  count = 32
): readonly ParameterInputSample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    surface: 'video_generation' as const,
    controlKind: 'text' as const,
    visibleLatencyMs: index + 1,
    parentCommitCount: 1,
    candidateRequestCount: 0,
    autosaveIpcCount: 1,
    ...overrides
  }));
}

describe('P0 parameter input performance baseline', () => {
  it('records p50, p95, max and the three counters for 32 consecutive inputs', () => {
    const summary = summarizeParameterInputSamples(buildSamples());
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      surface: 'video_generation',
      sampleCount: 32,
      // Nearest-rank over 1..32: ceil(32*0.5)-1 = 15 -> 16 ms,
      // ceil(32*0.95)-1 = 30 -> 31 ms, max 32 ms.
      visibleLatencyP50Ms: 16,
      visibleLatencyP95Ms: 31,
      visibleLatencyMaxMs: 32,
      parentCommitCount: 32,
      candidateRequestCount: 0,
      autosaveIpcCount: 32
    });
    console.info(`parameter-input-baseline ${JSON.stringify(summary)}`);
  });

  it('sums per-keystroke work so the coupling size is visible', () => {
    const summary = summarizeParameterInputSamples(buildSamples({
      parentCommitCount: 2,
      candidateRequestCount: 1,
      autosaveIpcCount: 3
    }));
    // Today every keystroke replaces the whole draft and queues a save; the
    // candidate refresh is what P3 must drive to zero.
    expect(summary).toMatchObject({
      parentCommitCount: 64,
      candidateRequestCount: 32,
      autosaveIpcCount: 96
    });
  });

  it(`refuses to report a baseline with fewer than ${PARAMETER_INPUT_MIN_SAMPLES} samples`, () => {
    expect(summarizeParameterInputSamples(buildSamples({}, PARAMETER_INPUT_MIN_SAMPLES - 1)))
      .toBeUndefined();
    expect(summarizeParameterInputSamples(buildSamples({}, PARAMETER_INPUT_MIN_SAMPLES)))
      .toBeDefined();
  });

  it('refuses to merge two surfaces into one baseline', () => {
    const mixed = [
      ...buildSamples({}, 16),
      ...buildSamples({ surface: 'image_generation' }, 16)
    ];
    expect(summarizeParameterInputSamples(mixed)).toBeUndefined();
  });

  it('rounds metrics to two decimals', () => {
    const summary = summarizeParameterInputSamples(buildSamples({ visibleLatencyMs: 0.125 }));
    expect(summary?.visibleLatencyP50Ms).toBe(roundMilliseconds(0.13));
  });

  it('rejects any recorded payload that smuggles text or extra fields', () => {
    expect(isParameterInputPerformanceSummary({
      surface: 'video_generation',
      sampleCount: 32,
      visibleLatencyP50Ms: 16,
      visibleLatencyP95Ms: 31,
      visibleLatencyMaxMs: 32,
      parentCommitCount: 32,
      candidateRequestCount: 0,
      autosaveIpcCount: 32
    })).toBe(true);

    const base = {
      surface: 'video_generation',
      sampleCount: 32,
      visibleLatencyP50Ms: 16,
      visibleLatencyP95Ms: 31,
      visibleLatencyMaxMs: 32,
      parentCommitCount: 32,
      candidateRequestCount: 0,
      autosaveIpcCount: 32
    };
    // Extra key: the vector that would let a prompt or credential reach a log.
    expect(isParameterInputPerformanceSummary({ ...base, prompt: 'secret text' })).toBe(false);
    // Missing key: the shape is fixed, not partial.
    expect(isParameterInputPerformanceSummary({ ...base, candidateRequestCount: undefined }))
      .toBe(false);
    // Text where a number belongs.
    expect(isParameterInputPerformanceSummary({ ...base, visibleLatencyP50Ms: '16' }))
      .toBe(false);
    // Out-of-range latency hides a unit or clock bug.
    expect(isParameterInputPerformanceSummary({
      ...base,
      visibleLatencyMaxMs: PARAMETER_INPUT_MAX_LATENCY_MS + 1
    })).toBe(false);
    // Below the minimum sample count.
    expect(isParameterInputPerformanceSummary({ ...base, sampleCount: 29 })).toBe(false);
    // Unknown surface.
    expect(isParameterInputPerformanceSummary({ ...base, surface: 'chat' })).toBe(false);
  });

  it('rejects a keystroke sample with an unknown control or extra content', () => {
    const sample = {
      surface: 'video_generation',
      controlKind: 'text',
      visibleLatencyMs: 12,
      parentCommitCount: 1,
      candidateRequestCount: 0,
      autosaveIpcCount: 1
    };
    expect(isValidSample(sample)).toBe(true);
    expect(isValidSample({ ...sample, controlKind: 'prompt' })).toBe(false);
    expect(isValidSample({ ...sample, fieldId: 'provider.parameter.size' })).toBe(false);
    expect(isValidSample({ ...sample, value: '1280x720' })).toBe(false);
    expect(isValidSample({ ...sample, visibleLatencyMs: -1 })).toBe(false);
    expect(isValidSample({ ...sample, parentCommitCount: 1.5 })).toBe(false);
  });

  it('exposes no free-text field anywhere in the recorded vocabulary', () => {
    const summaryKeys = Object.keys({
      surface: '',
      sampleCount: 0,
      visibleLatencyP50Ms: 0,
      visibleLatencyP95Ms: 0,
      visibleLatencyMaxMs: 0,
      parentCommitCount: 0,
      candidateRequestCount: 0,
      autosaveIpcCount: 0
    });
    expect(summaryKeys).toEqual([
      'surface',
      'sampleCount',
      'visibleLatencyP50Ms',
      'visibleLatencyP95Ms',
      'visibleLatencyMaxMs',
      'parentCommitCount',
      'candidateRequestCount',
      'autosaveIpcCount'
    ]);
    // The gate compares the key count exactly, so a new field cannot be added
    // to the wire shape without updating the validator in the same change.
    const valid = summarizeParameterInputSamples(buildSamples());
    expect(valid && Object.keys(valid).length).toBe(summaryKeys.length);
  });
});
