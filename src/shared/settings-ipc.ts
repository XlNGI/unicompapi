import type {
  PortableSettingsV1,
  SettingsCategory,
  SettingsValues
} from '../domain';

export const settingsIpcChannels = {
  getSnapshot: 'settings:get-snapshot',
  updateValues: 'settings:update-values',
  exportPortable: 'settings:export-portable',
  prepareImport: 'settings:prepare-import',
  planOperation: 'settings:plan-operation',
  executeOperation: 'settings:execute-operation'
} as const;

export type SettingsIpcErrorCode =
  | 'invalid_request'
  | 'settings_read_failed'
  | 'settings_write_failed'
  | 'revision_conflict'
  | 'confirmation_required'
  | 'operation_not_found'
  | 'operation_expired'
  | 'operation_unsupported';

export type SettingsIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: SettingsIpcErrorCode;
        readonly message: string;
        readonly actualRevision?: number;
      };
    };

export type SettingsCapabilityState =
  | 'available'
  | 'unavailable'
  | 'permission_required'
  | 'unsupported'
  | 'unknown'
  | 'failed';

export interface SettingsCapabilityDto {
  readonly id: string;
  readonly state: SettingsCapabilityState;
  readonly reason?: string;
}

export interface SettingsSnapshotDto {
  readonly revision: number;
  readonly values: SettingsValues;
  readonly resolved: {
    readonly appliedKeys: readonly string[];
    readonly unavailableKeys: readonly string[];
  };
  readonly capabilities: readonly SettingsCapabilityDto[];
  readonly statuses: {
    readonly repository: 'primary' | 'backup' | 'default';
    readonly schemaVersion: 1;
  };
  readonly pendingRestart: readonly string[];
}

export type SettingsOperationRequestDto =
  | {
      readonly kind: 'restore_category_defaults';
      readonly category: SettingsCategory;
    }
  | { readonly kind: 'restore_all_defaults' };

export interface SettingsOperationPlanDto {
  readonly kind:
    | SettingsOperationRequestDto['kind']
    | 'import_portable_settings';
  readonly confirmationHandle: string;
  readonly expectedRevision: number;
  readonly expiresAt: string;
  readonly affectedCategories: readonly SettingsCategory[];
  readonly changedValueCount: number;
  readonly reversible: true;
  readonly blockers: readonly string[];
  readonly pendingRestart: readonly string[];
}

export interface SettingsApi {
  getSnapshot(): Promise<SettingsIpcResult<SettingsSnapshotDto>>;
  updateValues(
    expectedRevision: number,
    values: SettingsValues
  ): Promise<SettingsIpcResult<SettingsSnapshotDto>>;
  exportPortable(): Promise<SettingsIpcResult<PortableSettingsV1>>;
  prepareImport(
    expectedRevision: number,
    document: PortableSettingsV1
  ): Promise<SettingsIpcResult<SettingsOperationPlanDto>>;
  planOperation(
    expectedRevision: number,
    operation: SettingsOperationRequestDto
  ): Promise<SettingsIpcResult<SettingsOperationPlanDto>>;
  executeOperation(
    confirmationHandle: string
  ): Promise<SettingsIpcResult<SettingsSnapshotDto>>;
}
