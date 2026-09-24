import type { VideoEditorClipDto } from '../../../shared/video-editor-ipc';

type Request = { draftId: string; clip: VideoEditorClipDto; sourceUs: number; present: (video: HTMLVideoElement) => void };
type Decoder = { video: HTMLVideoElement; originalUrl?: string; proxy: boolean; sourceStartUs: number; target?: Request; pending?: Request; direction: number; generation: number; pendingGeneration?: number; requestedSeconds?: number; timer?: number; dispose: () => void };

// Sources have independent decoders. Each decoder completes its current seek
// before accepting the latest target, so pointer events never restart decoding.
export class VideoScrubCache {
  private readonly decoders = new Map<string, Decoder>();
  private current?: string;
  private readonly proxyQueue = new Map<string, { decoder: Decoder; draftId: string; clip: VideoEditorClipDto }>();
  private proxyBusy = false;
  constructor(
    private readonly load: (draftId: string, clipId: string) => Promise<string | undefined>,
    private readonly onError: () => void = () => undefined,
    private readonly loadProxy?: (draftId: string, clipId: string) => Promise<string | undefined>
  ) {}

  request(request: Request) {
    const key = this.key(request.draftId, request.clip);
    const decoder = this.prepare(request.draftId, request.clip);
    const direction = decoder.target ? Math.sign(request.sourceUs - decoder.target.sourceUs) : 0;
    if (this.current !== key || decoder.target?.clip.clipId !== request.clip.clipId ||
      (direction !== 0 && decoder.direction !== 0 && direction !== decoder.direction)) decoder.generation++;
    if (direction !== 0) decoder.direction = direction;
    this.current = key;
    decoder.target = request;
    this.seek(decoder);
  }

  prefetch(draftId: string, clip: VideoEditorClipDto) {
    this.prepare(draftId, clip);
  }

  invalidate(draftId: string, clip: VideoEditorClipDto) {
    const key = this.key(draftId, clip);
    this.decoders.get(key)?.dispose();
    this.decoders.delete(key);
    this.proxyQueue.delete(key);
    if (this.current === key) this.current = undefined;
  }

  clear() {
    this.current = undefined;
    this.proxyQueue.clear();
    for (const decoder of this.decoders.values()) decoder.dispose();
    this.decoders.clear();
  }

  private key(draftId: string, clip: VideoEditorClipDto) {
    return JSON.stringify([draftId, clip.source.fileId, clip.source.identity, clip.sourceRange]);
  }

  private prepare(draftId: string, clip: VideoEditorClipDto): Decoder {
    const key = this.key(draftId, clip);
    const cached = this.decoders.get(key);
    if (cached) {
      this.decoders.delete(key);
      this.proxyQueue.delete(key);
      this.decoders.set(key, cached);
      return cached;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const decoder: Decoder = { video, proxy: false, sourceStartUs: 0, direction: 0, generation: 0, dispose: () => {
      window.clearTimeout(decoder.timer);
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('seeked', ready);
      video.removeEventListener('error', failed);
      video.pause();
      video.removeAttribute('src');
      video.load();
    } };
    const failed = () => {
      if (this.decoders.get(key) !== decoder) return;
      if (decoder.proxy && decoder.originalUrl) {
        window.clearTimeout(decoder.timer);
        decoder.proxy = false;
        decoder.sourceStartUs = 0;
        decoder.pending = undefined;
        decoder.requestedSeconds = undefined;
        video.src = decoder.originalUrl;
        video.load();
        return;
      }
      this.decoders.delete(key);
      decoder.dispose();
      this.onError();
    };
    const ready = () => {
      if (video.readyState < 2 || video.seeking) return;
      window.clearTimeout(decoder.timer);
      if (this.current === key && decoder.pending && decoder.pendingGeneration === decoder.generation) {
        decoder.pending.present(video);
      }
      decoder.pending = undefined;
      if (decoder.target && decoder.requestedSeconds !== this.seconds(decoder.target, decoder)) this.seek(decoder);
    };
    video.addEventListener('loadeddata', ready);
    video.addEventListener('seeked', ready);
    video.addEventListener('error', failed);
    this.decoders.set(key, decoder);
    // Bound native decoder resources, not seconds of huge decoded JPEG sheets.
    while (this.decoders.size > 8) {
      const oldest = [...this.decoders.keys()].find(candidate => candidate !== this.current && candidate !== key);
      if (!oldest) break;
      this.decoders.get(oldest)!.dispose();
      this.decoders.delete(oldest);
      this.proxyQueue.delete(oldest);
    }
    decoder.timer = window.setTimeout(failed, 15_000);
    void this.load(draftId, clip.clipId).then(url => {
      if (this.decoders.get(key) !== decoder) return;
      if (!url) { failed(); return; }
      decoder.originalUrl = url;
      video.src = url;
      video.load();
      if (this.loadProxy) {
        this.proxyQueue.set(key, { decoder, draftId, clip });
        void this.prepareNextProxy();
      }
    }).catch(failed);
    return decoder;
  }

  private async prepareNextProxy() {
    if (this.proxyBusy || !this.loadProxy) return;
    const entry = this.proxyQueue.entries().next().value;
    if (!entry) return;
    const [key, { decoder, draftId, clip }] = entry;
    this.proxyQueue.delete(key);
    this.proxyBusy = true;
    try {
      const url = await this.loadProxy(draftId, clip.clipId);
      if (!url || this.decoders.get(key) !== decoder) return;
      decoder.pending = undefined;
      decoder.requestedSeconds = undefined;
      decoder.sourceStartUs = clip.sourceRange.inUs;
      decoder.proxy = true;
      decoder.video.src = url;
      decoder.video.load();
    } catch {
      // Optional acceleration must not block original-media preview.
    } finally {
      this.proxyBusy = false;
      void this.prepareNextProxy();
    }
  }

  private seek(decoder: Decoder) {
    const { video, target } = decoder;
    if (!target || video.readyState < 2 || video.seeking || !video.src) return;
    const seconds = this.seconds(target, decoder);
    if (decoder.requestedSeconds === seconds || Math.abs(video.currentTime - seconds) <= 0.001) {
      if (this.current === this.key(target.draftId, target.clip)) target.present(video);
      return;
    }
    decoder.requestedSeconds = seconds;
    decoder.pending = target;
    decoder.pendingGeneration = decoder.generation;
    video.currentTime = seconds;
  }

  private seconds(target: Request, decoder: Decoder) {
    return (Math.max(target.clip.sourceRange.inUs,
      Math.min(target.clip.sourceRange.outUs - 1, target.sourceUs)) - decoder.sourceStartUs) / 1_000_000;
  }
}
