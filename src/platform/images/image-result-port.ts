import type { ProviderOperationRecordId } from '../../domain';

export type ImageResultOperationReference =
  | { readonly kind: 'remote_operation'; readonly id: string }
  | {
      readonly kind: 'provider_operation_record';
      readonly id: ProviderOperationRecordId;
    };

export interface ImageRemoteResultDescriptor {
  readonly name: string;
  readonly declaredMimeType?: string;
  readonly expectedSizeBytes?: number;
  readonly expectedChecksumSha256?: string;
}

export interface ImageResultPort {
  getCompletedResult(
    operation: ImageResultOperationReference
  ): Promise<ImageRemoteResultDescriptor | undefined>;
  download(
    operation: ImageResultOperationReference,
    destinationPath: string
  ): Promise<void>;
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
