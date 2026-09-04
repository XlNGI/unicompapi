import { describe, expect, it } from 'vitest';
import {
  buildTimelineRulerTicks,
  buildTimelineSegments,
  buildTimelineThumbnailSlots,
  canvasPreviewAspectRatio,
  resolveTimelineDropIndex,
  resolveBackgroundMusicPlayback,
  resolveTimelineEdgeAutoScroll,
  resolveTimelineHorizontalWheelDelta,
  resolveTimelinePositionUs,
  resolveTimelineSegmentAt,
  resolveTimelineWheelZoom
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

  it('pans the timeline with a horizontal wheel or Shift+wheel without stealing vertical scroll', () => {
    expect(resolveTimelineHorizontalWheelDelta({
      deltaX: 48,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: false,
      viewportHeight: 300
    })).toBe(48);
    expect(resolveTimelineHorizontalWheelDelta({
      deltaX: 0,
      deltaY: 3,
      deltaMode: 1,
      shiftKey: true,
      viewportHeight: 300
    })).toBe(48);
    expect(resolveTimelineHorizontalWheelDelta({
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      shiftKey: false,
      viewportHeight: 300
    })).toBe(0);
  });

  it('auto-scrolls while the playhead is held near an edge and clamps the canvas bounds', () => {
    const base = {
      viewportLeft: 100,
      viewportWidth: 1_000,
      scrollLeft: 400,
      scrollWidth: 2_400
    };
    expect(resolveTimelineEdgeAutoScroll({ ...base, clientX: 1_090 })).toBeGreaterThan(400);
    expect(resolveTimelineEdgeAutoScroll({ ...base, clientX: 110 })).toBeLessThan(400);
    expect(resolveTimelineEdgeAutoScroll({ ...base, clientX: 600 })).toBe(400);
    expect(resolveTimelineEdgeAutoScroll({
      ...base,
      clientX: 1_200,
      scrollLeft: 1_395
    })).toBe(1_400);
  });

  it('zooms around the pointer while clamping to fit and maximum density', () => {
    const totalDurationUs = 13_077_000;
    const viewportWidth = 1_128;
    const pointerOffsetPx = 420;
    const scrollLeft = 180;
    const currentPixelsPerSecond = 112;
    const anchorBefore =
      (scrollLeft + pointerOffsetPx) / currentPixelsPerSecond;

    const zoomedIn = resolveTimelineWheelZoom({
      currentPixelsPerSecond,
      deltaY: -360,
      pointerOffsetPx,
      scrollLeft,
      totalDurationUs,
      viewportWidth
    });
    const anchorAfter =
      (zoomedIn.scrollLeft + pointerOffsetPx) /
      zoomedIn.pixelsPerSecond;

    expect(zoomedIn.pixelsPerSecond).toBeGreaterThan(currentPixelsPerSecond);
    expect(anchorAfter).toBeCloseTo(anchorBefore, 9);

    const fitted = resolveTimelineWheelZoom({
      currentPixelsPerSecond,
      deltaY: 100_000,
      pointerOffsetPx,
      scrollLeft,
      totalDurationUs,
      viewportWidth
    });
    expect(fitted.pixelsPerSecond).toBeCloseTo(
      viewportWidth / (totalDurationUs / 1_000_000),
      9
    );
    expect(fitted.scrollLeft).toBe(0);

    const maximum = resolveTimelineWheelZoom({
      currentPixelsPerSecond,
      deltaY: -100_000,
      pointerOffsetPx,
      scrollLeft,
      totalDurationUs,
      viewportWidth
    });
    expect(maximum.pixelsPerSecond).toBe(1_000);
  });

  it('uses finer ruler steps as the timeline is enlarged', () => {
    const normal = buildTimelineRulerTicks(5_042_000, 112);
    const enlarged = buildTimelineRulerTicks(5_042_000, 224);

    expect(normal[1].timeUs - normal[0].timeUs).toBe(1_000_000);
    expect(enlarged[1].timeUs - enlarged[0].timeUs).toBe(500_000);
    expect(enlarged[0]).toEqual({
      timeUs: 0,
      leftPx: 0,
      label: '00:00.000'
    });
  });

  it('limits ruler ticks to the viewport plus bounded overscan', () => {
    const ticks = buildTimelineRulerTicks(
      100_000_000,
      100,
      1_000,
      1_500,
      500
    );

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(20);
    expect(ticks.every((tick) => tick.leftPx >= 500)).toBe(true);
    expect(ticks.every((tick) => tick.leftPx <= 2_000)).toBe(true);
  });

  it('adds real source-time thumbnail slots as the clip becomes wider', () => {
    const [segment] = buildTimelineSegments([
      {
        clipId: 'clip-1',
        sourceRange: { inUs: 1_000_000, outUs: 6_042_000 },
        speed: { numerator: 1, denominator: 1 },
        transitionToNext: { kind: 'none' }
      }
    ]);

    const normal = buildTimelineThumbnailSlots(
      [segment],
      112,
      0,
      10_000,
      0
    );
    const enlarged = buildTimelineThumbnailSlots(
      [segment],
      224,
      0,
      10_000,
      0
    );

    expect(normal).toHaveLength(11);
    expect(enlarged).toHaveLength(21);
    expect(new Set(enlarged.map((slot) => slot.sourceUs)).size).toBe(21);
    expect(enlarged[0].sourceUs).toBeGreaterThan(segment.sourceInUs);
    expect(enlarged.at(-1)?.sourceUs).toBeLessThan(segment.sourceOutUs);
  });

  it('maps thumbnail samples through trim and speed without changing clip data', () => {
    const clip = {
      clipId: 'clip-1',
      sourceRange: { inUs: 1_000_000, outUs: 5_000_000 },
      speed: { numerator: 2, denominator: 1 },
      transitionToNext: { kind: 'none' as const }
    };
    const snapshot = JSON.stringify(clip);
    const [segment] = buildTimelineSegments([clip]);
    const slots = buildTimelineThumbnailSlots(
      [segment],
      112,
      0,
      1_000,
      0
    );

    expect(slots.map((slot) => slot.sourceUs)).toEqual([
      1_500_000,
      2_500_000,
      3_500_000,
      4_500_000
    ]);
    expect(JSON.stringify(clip)).toBe(snapshot);
  });

  it('limits thumbnail work to the viewport plus bounded overscan', () => {
    const [segment] = buildTimelineSegments([
      {
        clipId: 'clip-1',
        sourceRange: { inUs: 0, outUs: 100_000_000 },
        speed: { numerator: 1, denominator: 1 },
        transitionToNext: { kind: 'none' }
      }
    ]);
    const slots = buildTimelineThumbnailSlots(
      [segment],
      100,
      1_000,
      1_500,
      500
    );

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThan(40);
    expect(slots.every((slot) => slot.leftPx + slot.widthPx >= 500)).toBe(true);
    expect(slots.every((slot) => slot.leftPx <= 2_000)).toBe(true);
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
