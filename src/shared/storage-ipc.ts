export const storageIpcChannels = {
  probeFile: 'storage:probe-file',
  verifyFile: 'storage:verify-file',
  relinkFile: 'storage:relink-file',
  restoreBackup: 'storage:restore-backup',
  rebuildIndex: 'storage:rebuild-index',
  openProject: 'storage:open-project',
  createProject: 'storage:create-project',
  listProjects: 'storage:list-projects',
  closeProject: 'storage:close-project',
  getProjectSession: 'storage:get-project-session'
} as const;

export type StorageIpcErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'file_not_found'
  | 'verification_failed'
  | 'relink_rejected'
  | 'backup_restore_failed'
  | 'index_rebuild_failed'
  | 'invalid_project'
  | 'project_open_failed'
  | 'project_create_failed'
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

export interface StorageBackupRestoreResultDto {
  readonly cancelled: boolean;
  readonly file?: StorageFileStatusDto;
}

export interface StorageProjectSessionDto {
  readonly projectId: string;
  readonly projectName: string;
}

export interface StorageOpenProjectDto {
  readonly cancelled: boolean;
  readonly session?: StorageProjectSessionDto;
}

export interface StorageProjectSummaryDto {
  readonly projectId: string;
  readonly projectName: string;
  readonly availability: 'available' | 'unavailable';
  readonly lastOpenedAt: string;
}

export interface StorageCreateProjectDto {
  readonly cancelled: boolean;
  readonly session?: StorageProjectSessionDto;
}

export interface StorageApi {
  probeFile(fileId: string): Promise<StorageIpcResult<StorageFileStatusDto>>;
  verifyFile(fileId: string): Promise<StorageIpcResult<StorageFileStatusDto>>;
  relinkFile(fileId: string): Promise<StorageIpcResult<StorageRelinkResultDto>>;
  restoreBackup(
    fileId: string
  ): Promise<StorageIpcResult<StorageBackupRestoreResultDto>>;
  rebuildIndex(): Promise<StorageIpcResult<StorageIndexRebuildDto>>;
  openProject(): Promise<StorageIpcResult<StorageOpenProjectDto>>;
  createProject(
    name: string
  ): Promise<StorageIpcResult<StorageCreateProjectDto>>;
  listProjects(): Promise<StorageIpcResult<readonly StorageProjectSummaryDto[]>>;
  closeProject(): Promise<StorageIpcResult<{ readonly closed: true }>>;
  getProjectSession(): Promise<
    StorageIpcResult<StorageProjectSessionDto | undefined>
  >;
}
