import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createParameterInputProbe,
  emitParameterInputSummary
} from '../../src/ui/parameter-input-performance-probe';
import type { ParameterInputPerformanceSummary } from '../../src/shared/parameter-input-performance';

/**
 * P0 evidence suite for the Electron-time probe: it must count and time one
 * editing session, flush only when the session is long enough, and never hold
 * timers open. The probe must also be fully inert when disabled, so disabling it
 * restores the untouched interaction.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function clock(start = 0): { now: () => number; advance: (delta: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (delta: number) => {
      current += delta;
    }
  };
}

describe('P0 parameter input probe', () => {
  it('is completely inert when disabled', () => {
    const emit = vi.fn();
    const probe = createParameterInputProbe({
      surface: 'video_generation',
      emit,
      enabled: false
    });
    probe.begin('text');
    probe.parentCommit();
    probe.candidateRequest();
    probe.autosaveIpc();
    probe.settle();
    probe.flush();
    expect(probe.sampleCount()).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('summarises 32 keystrokes with their measured latency and counters', () => {
    const time = clock();
    const emit = vi.fn();
    const probe = createParameterInputProbe({
      surface: 'video_generation',
      emit,
      enabled: true,
      now: time.now
    });
    for (let index = 0; index < 32; index += 1) {
      probe.begin('text');
      probe.parentCommit();
      probe.autosaveIpc();
      time.advance(index + 1);
      probe.settle();
    }
    expect(probe.sampleCount()).toBe(32);
    probe.flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      surface: 'video_generation',
      sampleCount: 32,
      visibleLatencyP50Ms: 16,
      visibleLatencyP95Ms: 31,
      visibleLatencyMaxMs: 32,
      parentCommitCount: 32,
      candidateRequestCount: 0,
      autosaveIpcCount: 32
    });
  });

  it('attributes counters to the keystroke that caused them', () => {
    const time = clock();
    const emit = vi.fn();
    const probe = createParameterInputProbe({
      surface: 'image_generation',
      emit,
      enabled: true,
      now: time.now
    });
    for (let index = 0; index < 30; index += 1) {
      probe.begin('number');
      // The first keystroke also refreshes the candidate list; the rest must not.
      if (index === 0) probe.candidateRequest();
      probe.parentCommit();
      time.advance(5);
      probe.settle();
    }
    probe.flush();
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      sampleCount: 30,
      candidateRequestCount: 1,
      parentCommitCount: 30,
      visibleLatencyP50Ms: 5
    });
  });

  it('does not emit a baseline shorter than the minimum sample count', () => {
    const time = clock();
    const emit = vi.fn();
    const probe = createParameterInputProbe({
      surface: 'video_generation',
      emit,
      enabled: true,
      now: time.now
    });
    for (let index = 0; index < 29; index += 1) {
      probe.begin('text');
      time.advance(1);
      probe.settle();
    }
    probe.flush();
    expect(emit).not.toHaveBeenCalled();
    expect(probe.sampleCount()).toBe(0);
  });

  it('flushes an idle session once it is long enough', () => {
    vi.useFakeTimers();
    const time = clock();
    const emit = vi.fn();
    const probe = createParameterInputProbe({
      surface: 'video_generation',
      emit,
      enabled: true,
      now: time.now,
      idleFlushMs: 100
    });
    for (let index = 0; index < 30; index += 1) {
      probe.begin('json');
      time.advance(2);
      probe.settle();
    }
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);
    // The summary is per-session, not per-control: it carries no field or
    // control identity, only counts and timings.
    const summary = emit.mock.calls[0]?.[0] as ParameterInputPerformanceSummary;
    expect(Object.keys(summary).sort()).toEqual([
      'autosaveIpcCount',
      'candidateRequestCount',
      'parentCommitCount',
      'sampleCount',
      'surface',
      'visibleLatencyMaxMs',
      'visibleLatencyP50Ms',
      'visibleLatencyP95Ms'
    ]);
    expect(summary.sampleCount).toBe(30);
  });

  it('ignores a settle without a matching begin', () => {
    const emit = vi.fn();
    const probe = createParameterInputProbe({
      surface: 'video_generation',
      emit,
      enabled: true,
      now: () => 0
    });
    probe.settle();
    probe.settle();
    expect(probe.sampleCount()).toBe(0);
    probe.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it('stays inert when no preload bridge is present', () => {
    const summary = {
      surface: 'video_generation',
      sampleCount: 32,
      visibleLatencyP50Ms: 16,
      visibleLatencyP95Ms: 31,
      visibleLatencyMaxMs: 32,
      parentCommitCount: 32,
      candidateRequestCount: 0,
      autosaveIpcCount: 32
    } as unknown as ParameterInputPerformanceSummary;
    expect(() => emitParameterInputSummary(summary)).not.toThrow();
    const record = vi.fn();
    vi.stubGlobal('window', { unicomp: { parameterInputDiagnostics: { record } } });
    emitParameterInputSummary(summary);
    expect(record).toHaveBeenCalledWith(summary);
    vi.unstubAllGlobals();
  });
});
