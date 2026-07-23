export type ImageInspectionErrorCode =
  | 'not_found'
  | 'not_regular_file'
  | 'permission_denied'
  | 'empty_file'
  | 'unsupported_image'
  | 'invalid_image'
  | 'read_failed';

export class ImageInspectionError extends Error {
  constructor(
    readonly code: ImageInspectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageInspectionError';
  }
}

export interface ImageInspectionResult {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
}

export interface ImageInspector {
  inspect(target: string): Promise<ImageInspectionResult>;
}
