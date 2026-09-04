import { describe, expect, it } from 'vitest';
import {
  buildTimelineSegments,
  canvasPreviewAspectRatio,
  resolveTimelineDropIndex,
  resolveBackgroundMusicPlayback,
  resolveTimelinePositionUs,
  resolveTimelineSegmentAt
} from '../../src/pages/creation/video/VideoEditingPage';

describe('video editor timeline view', () => {
  it('derives the visible preview canvas ratio from the persisted canvas setting', () => {
    const draft = {
      canvas: {
        aspectRatio: { kind: 'source' },
        transformPolicy: 'fit',
        background: { kind: 'solid', color: '#000000' }
      },
      videoTrack: [{ source: { identity: { width: 720, height: 1280 } } }]
    } as const;

    expect(canvasPreviewAspectRatio(draft)).toBe('720 / 1280');
    expect(canvasPreviewAspectRatio({
      ...draft,
      canvas: {
        ...draft.canvas,
        aspectRatio: { kind: 'ratio', numerator: 16, denominator: 9 }
      }
    })).toBe('16 / 9');
  });

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

  it('maps playhead dragging to the visible main-track scale and clamps both edges', () => {
    expect(resolveTimelinePositionUs(250, 100, 600, 12_000_000)).toBe(3_000_000);
    expect(resolveTimelinePositionUs(50, 100, 600, 12_000_000)).toBe(0);
    expect(resolveTimelinePositionUs(750, 100, 600, 12_000_000)).toBe(12_000_000);
    expect(resolveTimelinePositionUs(250, 100, 0, 12_000_000)).toBe(0);
  });

  it('maps background music onto timeline time and applies configured fades', () => {
    const music = {
      fileId: 'music-1',
      identity: {
        sizeBytes: 1,
        durationUs: 8_000_000,
        container: 'wav',
        width: 0,
        height: 0
      },
      sourceRange: { inUs: 1_000_000, outUs: 7_000_000 },
      timelineRange: { startUs: 2_000_000, endUs: 8_000_000 },
      volumePermille: 800,
      fadeInUs: 1_000_000,
      fadeOutUs: 2_000_000
    } as const;

    expect(resolveBackgroundMusicPlayback(music, 1_999_999)).toBeUndefined();
    expect(resolveBackgroundMusicPlayback(music, 2_500_000)).toEqual({
      sourceUs: 1_500_000,
      volumePermille: 400
    });
    expect(resolveBackgroundMusicPlayback(music, 5_000_000)).toEqual({
      sourceUs: 4_000_000,
      volumePermille: 800
    });
    expect(resolveBackgroundMusicPlayback(music, 7_000_000)).toEqual({
      sourceUs: 6_000_000,
      volumePermille: 400
    });
    expect(resolveBackgroundMusicPlayback(music, 8_000_000)).toBeUndefined();
  });
});
