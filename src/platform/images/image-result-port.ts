export interface ImageRemoteResultDescriptor {
  readonly name: string;
  readonly declaredMimeType?: string;
  readonly expectedSizeBytes?: number;
  readonly expectedChecksumSha256?: string;
}

export interface ImageResultPort {
  getCompletedResult(
    remoteOperationId: string
  ): Promise<ImageRemoteResultDescriptor | undefined>;
  download(remoteOperationId: string, destinationPath: string): Promise<void>;
}

export class ImageResultPortError extends Error {
  constructor(
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    message: string
  ) {
    super(message);
    this.name = 'ImageResultPortError';
  }
}
