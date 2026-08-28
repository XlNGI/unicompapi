import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type {
  ProviderImmediateResultReference,
  ProviderOperationRecord,
  ProviderOperationRepository
} from '../../domain';
import type {
  ImageRemoteResultDescriptor,
  ImageResultOperationReference,
  ImageResultPort
} from './image-result-port';
import { ImageResultPortError } from './image-result-port';

export interface ControlledImmediateImageResultDownloader {
  download(input: {
    readonly url: string;
    readonly maximumResponseBytes: number;
    readonly signal?: AbortSignal;
    readonly endpointSecurity: {
      readonly allowPrivateNetwork: false;
      readonly dnsRebindingProtection: 'required';
      readonly redirectPolicy: 'deny';
      readonly sendCredential: false;
    };
  }): Promise<{
    readonly body: Uint8Array;
    readonly contentType?: string;
  }>;
}

export function controlledImageResultDownloaderFromRuntime(runtime: {
  downloadResult(input: {
    readonly url: string;
    readonly maxResponseBytes?: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly body: Uint8Array; readonly contentType?: string }>;
}): ControlledImmediateImageResultDownloader {
  return {
    download: (input) => runtime.downloadResult({
      url: input.url,
      maxResponseBytes: input.maximumResponseBytes,
      signal: input.signal
    })
  };
}

export interface StoredImmediateImageResultPortDependencies {
  readonly operations: ProviderOperationRepository;
  readonly downloader: ControlledImmediateImageResultDownloader;
  readonly maximumResultBytes?: number;
}

/**
 * Resolves a persisted synchronous image result without depending on the
 * provider package that originally produced the operation record.
 */
export class StoredImmediateImageResultPort implements ImageResultPort {
  private readonly maximumResultBytes: number;

  constructor(
    private readonly dependencies: StoredImmediateImageResultPortDependencies
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
        name: `image-result.${extensionForMime(result.mimeType)}`,
        declaredMimeType: result.mimeType,
        expectedSizeBytes: bytes.byteLength
      };
    }
    requireControlledResultUrl(result.value);
    return { name: 'image-result' };
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
    await writeExclusive(
      destinationPath,
      await readStoredImmediateImageResult(
        result,
        this.dependencies.downloader,
        this.maximumResultBytes
      )
    );
  }

  private async loadResult(
    operation: ImageResultOperationReference
  ): Promise<ProviderImmediateResultReference | undefined> {
    if (operation.kind !== 'provider_operation_record') return undefined;
    const record = await this.dependencies.operations.get(operation.id);
    return resultFromRecord(record, operation.id);
  }
}

export async function readStoredImmediateImageResult(
  result: ProviderImmediateResultReference,
  downloader: ControlledImmediateImageResultDownloader,
  maximumResultBytes = 20 * 1024 * 1024,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumResultBytes) || maximumResultBytes < 1) {
    throw new TypeError('maximum image result bytes must be a positive integer');
  }
  if (result.kind === 'base64') {
    return decodeBase64(result.value, maximumResultBytes);
  }
  const url = requireControlledResultUrl(result.value);
  try {
    const downloaded = await downloader.download({
      url: url.toString(),
      maximumResponseBytes: maximumResultBytes,
      signal,
      endpointSecurity: {
        allowPrivateNetwork: false,
        dnsRebindingProtection: 'required',
        redirectPolicy: 'deny',
        sendCredential: false
      }
    });
    if (
      !(downloaded.body instanceof Uint8Array) ||
      downloaded.body.byteLength < 1
    ) {
      throw new ImageResultPortError(
        'retryable',
        'The provider image result download was empty'
      );
    }
    if (downloaded.body.byteLength > maximumResultBytes) {
      throw new ImageResultPortError(
        'not_retryable',
        'The provider image result exceeds the allowed size'
      );
    }
    const declaredMimeType = normalizeContentType(downloaded.contentType);
    if (declaredMimeType && !declaredMimeType.startsWith('image/')) {
      throw new ImageResultPortError(
        'not_retryable',
        'The provider result is not an image'
      );
    }
    return Uint8Array.from(downloaded.body);
  } catch (error) {
    if (error instanceof ImageResultPortError) throw error;
    throw new ImageResultPortError(
      downloadFailureRetryability(error),
      'The provider image result could not be downloaded'
    );
  }
}

function resultFromRecord(
  record: ProviderOperationRecord | undefined,
  expectedId: ProviderOperationRecord['id']
): ProviderImmediateResultReference | undefined {
  if (
    !record ||
    record.id !== expectedId ||
    record.mediaKind !== 'image' ||
    record.executionLifecycle !== 'synchronous_completed' ||
    record.outcome.kind !== 'completed_sync' ||
    record.outcome.results.length !== 1
  ) {
    return undefined;
  }
  return record.outcome.results[0];
}

function requireControlledResultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageResultPortError(
      'not_retryable',
      'The provider image result URL is invalid'
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    !hostname.includes('.')
  ) {
    throw new ImageResultPortError(
      'not_retryable',
      'The provider image result endpoint is not allowed'
    );
  }
  return url;
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
  if (bytes.byteLength > maximumBytes || bytes.toString('base64') !== value) {
    throw new ImageResultPortError(
      'not_retryable',
      'The provider image result exceeds the allowed size'
    );
  }
  return bytes;
}

function downloadFailureRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (hasRetryability(error)) return error.retryability;
  const code = safeFailureCode(error);
  if (
    code === 'response_too_large' ||
    code === 'redirect_not_allowed' ||
    code === 'endpoint_not_allowed' ||
    code === 'endpoint_address_denied' ||
    code === 'invalid_request' ||
    code === 'invalid_response'
  ) {
    return 'not_retryable';
  }
  if (
    code === 'network' ||
    code === 'network_error' ||
    code === 'timeout' ||
    code === 'cancelled' ||
    code === 'dns_unavailable'
  ) {
    return 'retryable';
  }
  return 'unknown';
}

function hasRetryability(error: unknown): error is {
  readonly retryability: 'retryable' | 'not_retryable' | 'unknown';
} {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ['retryable', 'not_retryable', 'unknown'].includes(
        String((error as { retryability?: unknown }).retryability)
      )
  );
}

function safeFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : undefined;
}

function normalizeContentType(value: string | undefined): string | undefined {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
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
