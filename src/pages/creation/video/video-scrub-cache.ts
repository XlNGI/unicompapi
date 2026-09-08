import type { VideoEditorClipDto } from '../../../shared/video-editor-ipc';

type Request = { draftId: string; clip: VideoEditorClipDto; sourceUs: number; present: (video: HTMLVideoElement) => void };
type Decoder = { video: HTMLVideoElement; target?: Request; requestedSeconds?: number; timer?: number; dispose: () => void };

// Sources have independent decoders. Each decoder completes its current seek
// before accepting the latest target, so pointer events never restart decoding.
export class VideoScrubCache {
  private readonly decoders = new Map<string, Decoder>();
  private current?: string;
  constructor(
    private readonly load: (draftId: string, clipId: string) => Promise<string | undefined>,
    private readonly onError: () => void = () => undefined
  ) {}

  request(request: Request) {
    this.current = this.key(request.draftId, request.clip);
    const decoder = this.prepare(request.draftId, request.clip);
    decoder.target = request;
    this.seek(decoder);
  }

  prefetch(draftId: string, clip: VideoEditorClipDto) {
    this.prepare(draftId, clip);
  }

  clear() {
    this.current = undefined;
    for (const decoder of this.decoders.values()) decoder.dispose();
    this.decoders.clear();
  }

  private key(draftId: string, clip: VideoEditorClipDto) {
    return JSON.stringify([draftId, clip.source.fileId, clip.source.identity]);
  }

  private prepare(draftId: string, clip: VideoEditorClipDto): Decoder {
    const key = this.key(draftId, clip);
    const cached = this.decoders.get(key);
    if (cached) {
      this.decoders.delete(key);
      this.decoders.set(key, cached);
      return cached;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const decoder: Decoder = { video, dispose: () => {
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
      this.decoders.delete(key);
      decoder.dispose();
      this.onError();
    };
    const ready = () => {
      if (video.readyState < 2 || video.seeking) return;
      window.clearTimeout(decoder.timer);
      if (this.current === key && decoder.target &&
        (decoder.requestedSeconds !== undefined || this.seconds(decoder.target) === 0)) decoder.target.present(video);
      if (decoder.target && decoder.requestedSeconds !== this.seconds(decoder.target)) this.seek(decoder);
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
    }
    decoder.timer = window.setTimeout(failed, 15_000);
    void this.load(draftId, clip.clipId).then(url => {
      if (this.decoders.get(key) !== decoder) return;
      if (!url) { failed(); return; }
      video.src = url;
      video.load();
    }).catch(failed);
    return decoder;
  }

  private seek(decoder: Decoder) {
    const { video, target } = decoder;
    if (!target || video.readyState < 2 || video.seeking || !video.src) return;
    const seconds = this.seconds(target);
    if (decoder.requestedSeconds === seconds || Math.abs(video.currentTime - seconds) <= 0.001) {
      if (this.current === this.key(target.draftId, target.clip)) target.present(video);
      return;
    }
    decoder.requestedSeconds = seconds;
    video.currentTime = seconds;
  }

  private seconds(target: Request) {
    return Math.max(target.clip.sourceRange.inUs,
      Math.min(target.clip.sourceRange.outUs - 1, target.sourceUs)) / 1_000_000;
  }
}
