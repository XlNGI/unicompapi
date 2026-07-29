import { writeFile } from 'node:fs/promises';
import type {
  ProviderImmediateResultReference,
  ProviderOperationRecord,
  ProviderOperationRepository
} from '../../../domain';
import type {
  ImageRemoteResultDescriptor,
  ImageResultOperationReference,
  ImageResultPort
} from '../../images/image-result-port';
import { ImageResultPortError } from '../../images/image-result-port';
import { ViduRuntimeError } from './vidu-runtime-errors';
import type { ViduSharedRuntime } from './vidu-shared-runtime';

export interface ViduImmediateImageResultPortDependencies {
  readonly operations: ProviderOperationRepository;
  readonly runtime: ViduSharedRuntime;
  readonly maximumResultBytes?: number;
}

export class ViduImmediateImageResultPort implements ImageResultPort {
  private readonly maximumResultBytes: number;

  constructor(
    private readonly dependencies: ViduImmediateImageResultPortDependencies
  ) {
    this.maximumResultBytes = dependencies.maximumResultBytes ?? 20 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumResultBytes) || this.maximumResultBytes < 1) {
      throw new TypeError('maximum image result bytes must be a positive integer');
    }
  }

  async getCompletedResult(
    operation: ImageResultOperationReference
  ): Promise<ImageRemoteResultDescriptor | undefined> {
    const result = await this.loadResult(operation);
    if (!result) return undefined;
    if (result.kind === 'base64') {
      const bytes = decodeBase64(result.value, this.maximumResultBytes);
      return {
        name: `vidu-image-result.${extensionForMime(result.mimeType)}`,
        declaredMimeType: result.mimeType,
        expectedSizeBytes: bytes.byteLength
      };
    }
    return { name: 'vidu-image-result' };
  }

  async download(
    operation: ImageResultOperationReference,
    destinationPath: string
  ): Promise<void> {
    const result = await this.loadResult(operation);
    if (!result) {
      throw new ImageResultPortError(
        'not_retryable',
        'The synchronous image result receipt is unavailable'
      );
    }
    if (result.kind === 'base64') {
      await writeExclusive(
        destinationPath,
        decodeBase64(result.value, this.maximumResultBytes)
      );
      return;
    }
    try {
      const downloaded = await this.dependencies.runtime.downloadResult({
        url: result.value,
        maxResponseBytes: this.maximumResultBytes
      });
      if (downloaded.contentType && !downloaded.contentType.startsWith('image/')) {
        throw new ImageResultPortError(
          'not_retryable',
          'The provider result is not an image'
        );
      }
      await writeExclusive(destinationPath, downloaded.body);
    } catch (error) {
      if (error instanceof ImageResultPortError) throw error;
      if (error instanceof ViduRuntimeError) {
        throw new ImageResultPortError(error.retryability, error.message);
      }
      throw new ImageResultPortError(
        'unknown',
        'The provider image result could not be downloaded'
      );
    }
  }

  private async loadResult(
    operation: ImageResultOperationReference
  ): Promise<ProviderImmediateResultReference | undefined> {
    if (operation.kind !== 'provider_operation_record') return undefined;
    const record = await this.dependencies.operations.get(operation.id);
    return resultFromRecord(record);
  }
}

function resultFromRecord(
  record: ProviderOperationRecord | undefined
): ProviderImmediateResultReference | undefined {
  if (
    !record ||
    record.mediaKind !== 'image' ||
    record.executionLifecycle !== 'synchronous_completed' ||
    record.outcome.kind !== 'completed_sync' ||
    record.outcome.results.length !== 1
  ) {
    return undefined;
  }
  return record.outcome.results[0];
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array {
  if (
    value.length === 0 ||
    value.length > Math.ceil(maximumBytes / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new ImageResultPortError(
      'not_retryable',
      'The provider image result encoding is invalid'
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.byteLength > maximumBytes ||
    bytes.toString('base64') !== value
  ) {
    throw new ImageResultPortError(
      'not_retryable',
      'The provider image result exceeds the allowed size'
    );
  }
  return bytes;
}

async function writeExclusive(
  destinationPath: string,
  bytes: Uint8Array
): Promise<void> {
  await writeFile(destinationPath, bytes, { flag: 'wx' });
}

function extensionForMime(mimeType: string): string {
  const extensions: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp'
  };
  const extension = extensions[mimeType];
  if (!extension) {
    throw new ImageResultPortError(
      'not_retryable',
      'The provider image result type is unsupported'
    );
  }
  return extension;
}
