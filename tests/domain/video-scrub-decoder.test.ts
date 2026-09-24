import { afterEach, expect, it, vi } from 'vitest';
import { VideoScrubCache } from '../../src/pages/creation/video/video-scrub-cache';
import type { VideoEditorClipDto } from '../../src/shared/video-editor-ipc';

afterEach(() => vi.unstubAllGlobals());

class Decoder extends EventTarget {
  readyState = 2;
  videoWidth = 640;
  videoHeight = 360;
  seeking = false;
  src = '';
  muted = false;
  preload = '';
  playsInline = false;
  time = 0;
  seeks: number[] = [];
  get currentTime() { return this.time; }
  set currentTime(value: number) { this.time = value; this.seeking = true; this.seeks.push(value); }
  finish() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
  load() { queueMicrotask(() => this.dispatchEvent(new Event('loadeddata'))); }
  pause() {}
  removeAttribute() { this.src = ''; }
}

it('keeps independent sources ready and coalesces seeks without reopening media', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const decoders: Decoder[] = [];
  vi.stubGlobal('document', { createElement: () => { const video = new Decoder(); decoders.push(video); return video; } });
  const load = vi.fn(async (_draft: string, clip: string) => `media:${clip}`);
  const cache = new VideoScrubCache(load);
  const clip = (id: string) => ({ clipId: id, source: { fileId: id, identity: {} }, sourceRange: { inUs: 0, outUs: 5_000_000 } }) as VideoEditorClipDto;
  cache.prefetch('draft', clip('a'));
  cache.prefetch('draft', clip('b'));
  await vi.waitFor(() => expect(decoders).toHaveLength(2));
  const present = vi.fn();
  cache.request({ draftId: 'draft', clip: clip('a'), sourceUs: 1_000_000, present });
  cache.request({ draftId: 'draft', clip: clip('a'), sourceUs: 2_000_000, present });
  cache.request({ draftId: 'draft', clip: clip('a'), sourceUs: 3_000_000, present });
  expect(decoders[0].seeks).toEqual([1]);
  decoders[0].finish();
  expect(decoders[0].seeks).toEqual([1, 3]);
  expect(present).toHaveBeenCalledTimes(1);
  cache.request({ draftId: 'draft', clip: clip('b'), sourceUs: 2_000_000, present });
  decoders[0].finish();
  expect(present).toHaveBeenCalledTimes(1);
  decoders[1].finish();
  expect(present).toHaveBeenCalledTimes(2);
  expect(present.mock.calls[1][0]).toBe(decoders[1]);
  expect(load).toHaveBeenCalledTimes(2);
  decoders[1].time = 1.96;
  decoders[1].finish();
  expect(decoders[1].seeks).toEqual([2]);
  cache.clear();
  expect(decoders.every(video => video.src === '')).toBe(true);
});

it('presents completed positions to their own callback and discards a seek after direction reversal', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const video = new Decoder();
  vi.stubGlobal('document', { createElement: () => video });
  const cache = new VideoScrubCache(async () => 'media:a');
  const clip = { clipId: 'a', source: { fileId: 'a', identity: {} }, sourceRange: { inUs: 0, outUs: 5_000_000 } } as VideoEditorClipDto;
  const shown: number[] = [];
  const request = (seconds: number) => cache.request({ draftId: 'draft', clip, sourceUs: seconds * 1_000_000,
    present: decoded => { expect(decoded.currentTime).toBe(seconds); shown.push(seconds); } });
  cache.prefetch('draft', clip);
  await Promise.resolve();
  request(1);
  request(2);
  video.finish();
  expect(shown).toEqual([1]);
  request(0.5);
  video.finish();
  expect(shown).toEqual([1]);
  video.finish();
  expect(shown).toEqual([1, 0.5]);
  cache.clear();
});

it('bounds decoder resources and ignores a source response after clearing', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const decoders: Decoder[] = [];
  vi.stubGlobal('document', { createElement: () => { const video = new Decoder(); decoders.push(video); return video; } });
  const finish: Array<(url: string) => void> = [];
  const cache = new VideoScrubCache(() => new Promise(resolve => finish.push(resolve)));
  for (let i = 0; i < 12; i++) {
    cache.prefetch('draft', { clipId: String(i), source: { fileId: String(i), identity: {} } } as VideoEditorClipDto);
  }
  for (const resolve of finish) resolve('media:ready');
  await Promise.resolve();
  expect(decoders.filter(video => video.src)).toHaveLength(8);
  cache.clear();
  expect(decoders.every(video => video.src === '')).toBe(true);
  cache.prefetch('other', { clipId: 'a', source: { fileId: 'a', identity: {} } } as VideoEditorClipDto);
  cache.clear();
  finish.at(-1)!('media:late');
  await Promise.resolve();
  expect(decoders.at(-1)!.src).toBe('');
});

it('uses original media immediately, serializes proxies and maps trimmed source time', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const videos: Decoder[] = [];
  vi.stubGlobal('document', { createElement: () => { const video = new Decoder(); videos.push(video); return video; } });
  const finish: Array<(url: string) => void> = [];
  const proxy = vi.fn(() => new Promise<string>(resolve => finish.push(resolve)));
  const cache = new VideoScrubCache(async () => 'media:original', undefined, proxy);
  const clip = (id: string) => ({ clipId: id, source: { fileId: id, identity: {} }, sourceRange: { inUs: 2_000_000, outUs: 5_000_000 } }) as VideoEditorClipDto;
  cache.prefetch('draft', clip('a'));
  cache.prefetch('draft', clip('b'));
  await vi.waitFor(() => expect(proxy).toHaveBeenCalledTimes(1));
  expect(videos[0].src).toBe('media:original');
  finish[0]('media:proxy');
  await vi.waitFor(() => expect(proxy).toHaveBeenCalledTimes(2));
  cache.request({ draftId: 'draft', clip: clip('a'), sourceUs: 3_000_000, present: () => undefined });
  expect(videos[0].src).toBe('media:proxy');
  expect(videos[0].seeks.at(-1)).toBe(1);
  videos[0].seeking = false;
  videos[0].dispatchEvent(new Event('error'));
  await Promise.resolve();
  expect(videos[0].src).toBe('media:original');
  expect(videos[0].seeks.at(-1)).toBe(3);
  cache.clear();
  finish[1]('media:late-proxy');
  await Promise.resolve();
  expect(videos.every(video => !video.src)).toBe(true);
});
