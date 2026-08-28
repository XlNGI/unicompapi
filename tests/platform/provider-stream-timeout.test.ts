import { describe, expect, it } from 'vitest';
import {
  defaultTextStreamTimeoutPolicy,
  resolveTextStreamTimeoutPolicy
} from '../../src/platform/providers/provider-stream-timeout';

describe('provider text stream timeout policy', () => {
  it('allows a paid text request five minutes to return its first response', () => {
    expect(defaultTextStreamTimeoutPolicy).toEqual({
      connectionTimeoutMs: 5 * 60_000,
      idleTimeoutMs: 60_000,
      totalTimeoutMs: 15 * 60_000
    });
    expect(resolveTextStreamTimeoutPolicy({})).toEqual(
      defaultTextStreamTimeoutPolicy
    );
  });

  it('still honors explicit provider test overrides', () => {
    expect(
      resolveTextStreamTimeoutPolicy({
        defaultConnectionTimeoutMs: 123,
        defaultStreamIdleTimeoutMs: 456,
        defaultStreamTotalTimeoutMs: 789
      })
    ).toEqual({
      connectionTimeoutMs: 123,
      idleTimeoutMs: 456,
      totalTimeoutMs: 789
    });
  });
});
