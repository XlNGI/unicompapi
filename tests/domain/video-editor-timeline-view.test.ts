import { describe, expect, it } from 'vitest';
import { buildTimelineSegments } from '../../src/pages/creation/video/VideoEditingPage';

describe('video editor timeline view', () => {
  it('derives positions from order, trim, speed and transition without a second start fact', () => {
    const segments = buildTimelineSegments([
      {
        clipId: 'clip-1',
        sourceRange: { inUs: 1_000_000, outUs: 5_000_000 },
        speed: { numerator: 2, denominator: 1 },
        transitionToNext: { kind: 'dissolve', durationUs: 500_000 }
      },
      {
        clipId: 'clip-2',
        sourceRange: { inUs: 0, outUs: 3_000_000 },
        speed: { numerator: 1, denominator: 1 },
        transitionToNext: { kind: 'none' }
      }
    ]);

    expect(segments).toEqual([
      expect.objectContaining({
        clipId: 'clip-1',
        startUs: 0,
        endUs: 2_000_000,
        durationUs: 2_000_000
      }),
      expect.objectContaining({
        clipId: 'clip-2',
        startUs: 1_500_000,
        endUs: 4_500_000,
        durationUs: 3_000_000
      })
    ]);
  });
});
