export type VideoContainer = 'mp4' | 'quicktime';

export interface VideoInspection {
  readonly mimeType: 'video/mp4' | 'video/quicktime';
  readonly container: VideoContainer;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
}

export type VideoInspectionErrorCode =
  | 'unsupported_video'
  | 'video_unreadable';

export class VideoInspectionError extends Error {
  constructor(
    readonly code: VideoInspectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoInspectionError';
  }
}

export interface VideoInspector {
  inspect(target: string): Promise<VideoInspection>;
}
