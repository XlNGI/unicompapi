import type { Readable } from 'node:stream';

export interface VideoRemoteCompletionFact {
  readonly state: 'completed';
}

export interface VideoRemoteResultDescriptor {
  readonly remoteResultId: string;
  readonly name: string;
  readonly declaredMimeType?: 'video/mp4' | 'video/quicktime';
  readonly declaredContainer?: 'mp4' | 'quicktime';
  readonly expectedSizeBytes?: number;
  readonly expectedChecksumSha256?: string;
  readonly expectedDurationMs?: number;
  readonly expectedWidth?: number;
  readonly expectedHeight?: number;
}

export interface VideoResultPort {
  getCompletion(
    remoteOperationId: string
  ): Promise<VideoRemoteCompletionFact | undefined>;
  listResults(
    remoteOperationId: string
  ): Promise<readonly VideoRemoteResultDescriptor[]>;
  openDownload(
    remoteOperationId: string,
    remoteResultId: string
  ): Promise<Readable>;
}

export class VideoResultPortError extends Error {
  constructor(
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    message: string
  ) {
    super(message);
    this.name = 'VideoResultPortError';
  }
}
