export const storageIpcChannels = {
  probeFile: 'storage:probe-file',
  verifyFile: 'storage:verify-file',
  relinkFile: 'storage:relink-file',
  rebuildIndex: 'storage:rebuild-index'
} as const;

export type StorageIpcErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'file_not_found'
  | 'verification_failed'
  | 'relink_rejected'
  | 'index_rebuild_failed'
  | 'storage_error';

export type StorageIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: StorageIpcErrorCode;
        readonly message: string;
      };
    };

export interface StorageFileStatusDto {
  readonly fileId: string;
  readonly state: string;
  readonly issues: readonly string[];
  readonly sizeBytes?: number;
  readonly matchesExpected?: boolean;
  readonly verifiedAt?: string;
}

export interface StorageRelinkResultDto {
  readonly cancelled: boolean;
  readonly file?: StorageFileStatusDto;
}

export interface StorageIndexRebuildDto {
  readonly sourceFileCount: number;
  readonly indexedFileCount: number;
  readonly skippedExternalFileCount: number;
}

export interface StorageApi {
  probeFile(fileId: string): Promise<StorageIpcResult<StorageFileStatusDto>>;
  verifyFile(fileId: string): Promise<StorageIpcResult<StorageFileStatusDto>>;
  relinkFile(fileId: string): Promise<StorageIpcResult<StorageRelinkResultDto>>;
  rebuildIndex(): Promise<StorageIpcResult<StorageIndexRebuildDto>>;
}
