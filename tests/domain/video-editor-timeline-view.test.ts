import { describe, expect, it } from 'vitest';
import {
  buildTimelineSegments,
  resolveTimelineDropIndex,
  resolveTimelineSegmentAt
} from '../../src/pages/creation/video/VideoEditingPage';

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

  it('maps a drop edge to the final move_clip index after removing the source', () => {
    expect(resolveTimelineDropIndex(1, 3, false)).toBe(2);
    expect(resolveTimelineDropIndex(1, 3, true)).toBe(3);
    expect(resolveTimelineDropIndex(3, 1, false)).toBe(1);
    expect(resolveTimelineDropIndex(3, 1, true)).toBe(2);
    expect(resolveTimelineDropIndex(2, 2, false)).toBe(2);
    expect(resolveTimelineDropIndex(2, 2, true)).toBe(2);
  });

  it('resolves a cross-clip seek to the segment that owns the timeline frame', () => {
    const segments = buildTimelineSegments([
      {
        clipId: 'clip-1',
        sourceRange: { inUs: 0, outUs: 3_000_000 },
        speed: { numerator: 1, denominator: 1 },
        transitionToNext: { kind: 'none' }
      },
      {
        clipId: 'clip-2',
        sourceRange: { inUs: 1_000_000, outUs: 6_000_000 },
        speed: { numerator: 1, denominator: 1 },
        transitionToNext: { kind: 'none' }
      }
    ]);

    expect(resolveTimelineSegmentAt(segments, 2_999_999)?.clipId).toBe('clip-1');
    expect(resolveTimelineSegmentAt(segments, 3_000_000)?.clipId).toBe('clip-2');
    expect(resolveTimelineSegmentAt(segments, 8_000_000)?.clipId).toBe('clip-2');
  });
});
