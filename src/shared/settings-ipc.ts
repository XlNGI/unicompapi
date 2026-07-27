import type {
  PrivacySettings,
  PerformanceSettings,
  PortableSettingsV1,
  ProxyMode,
  SettingsCategory,
  SettingsValues
} from '../domain';

export const settingsIpcChannels = {
  getSnapshot: 'settings:get-snapshot',
  updateValues: 'settings:update-values',
  exportPortable: 'settings:export-portable',
  prepareImport: 'settings:prepare-import',
  getSystemStatus: 'settings:get-system-status',
  selectDirectory: 'settings:select-directory',
  openSystemSettings: 'settings:open-system-settings',
  sendTestNotification: 'settings:send-test-notification',
  stageProxyCredential: 'settings:stage-proxy-credential',
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
  | 'operation_unsupported'
  | 'operation_blocked'
  | 'operation_failed';

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

export const directoryPurposes = [
  'projects',
  'works',
  'imageOutput',
  'videoOutput',
  'videoEditorOutput',
  'downloads',
  'cache',
  'proxy'
] as const;

export type DirectoryPurpose = (typeof directoryPurposes)[number];

export interface ControlledDirectoryDto {
  readonly id: string;
  readonly purpose: DirectoryPurpose;
  readonly displayName: string;
  readonly state: SettingsCapabilityState;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly freeBytes: number | null;
  readonly reason?: string;
}

export type CleanupScope =
  | 'caches'
  | 'preview_proxies'
  | 'temporary_exports'
  | 'eligible_logs';

export type PerformanceTaskType =
  | 'online_generation'
  | 'local_image'
  | 'local_video'
  | 'downloads'
  | 'thumbnails';

export type NativeSystemSettingsTarget =
  | 'files_and_folders'
  | 'notifications';

export interface PrivacyPermissionStatusDto {
  readonly minimumAuthorization: {
    readonly selectedFilesOnly: true;
    readonly authorizedDirectoriesOnly: true;
    readonly homeDirectoryScan: false;
    readonly backgroundClipboardRead: false;
    readonly outboundConfirmationMandatory: true;
    readonly unknownCostConfirmationMandatory: true;
  };
  readonly permissions: readonly (SettingsCapabilityDto & {
    readonly id: 'files_and_folders' | 'notifications';
    readonly systemSettingsTarget: NativeSystemSettingsTarget;
  })[];
}

export type ProxyTestFailureKind =
  | 'dns'
  | 'certificate'
  | 'authentication'
  | 'timeout'
  | 'unknown';

export type ProxyTestResultDto =
  | { readonly ok: true; readonly reachedAt: string }
  | { readonly ok: false; readonly failure: ProxyTestFailureKind };

export type NotificationDeliveryState =
  | 'accepted'
  | 'denied'
  | 'unsupported'
  | 'failed'
  | 'not_requested';

export interface NotificationTestResultDto {
  readonly inApp: 'retained';
  readonly system: NotificationDeliveryState;
  readonly sound: NotificationDeliveryState;
  readonly taskStateMutated: false;
  readonly executionStateMutated: false;
}

export type ShortcutPlatform = 'windows' | 'macos';

export interface ShortcutActionDto {
  readonly actionId: string;
  readonly registryVersion: 1;
  readonly scope: 'application' | 'global';
  readonly mutable: boolean;
  readonly defaults: Readonly<Record<ShortcutPlatform, string | null>>;
}

export interface ShortcutValidationIssueDto {
  readonly actionId: string;
  readonly code: 'unknown_action' | 'immutable_action' | 'invalid' | 'duplicate' | 'system_reserved';
}

export interface ShortcutUpdateBindingDto {
  readonly actionId: string;
  readonly accelerator: string | null;
}

export interface SettingsSystemStatusDto {
  readonly storage: {
    readonly directories: readonly ControlledDirectoryDto[];
    readonly appUsage: {
      readonly totalBytes: number;
      readonly fileCount: number;
      readonly truncated: boolean;
    };
    readonly cleanupScopes: readonly CleanupScope[];
  };
  readonly performance: {
    readonly logicalCpuCount: number;
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
    readonly currentLoadPercent: number | null;
    readonly activeTaskCount: number | null;
    readonly recommendations: Readonly<Record<PerformanceTaskType, number>>;
    readonly maximums: Readonly<Record<PerformanceTaskType, number>>;
    readonly changesApplyTo: 'new_tasks_and_attempts';
  };
  readonly media: {
    readonly engine: SettingsCapabilityDto & {
      readonly adapterId?: string;
      readonly version?: string;
      readonly distributionScope: 'development_test_only' | 'not_configured';
      readonly supportsProbe: boolean;
      readonly supportsPreview: boolean;
      readonly supportsSoftwareExport: boolean;
    };
    readonly hardwareAcceleration: SettingsCapabilityDto;
    readonly automaticSoftwareFallback: true;
    readonly softwareExportBlockedByHardwareFailure: false;
  };
  readonly privacy: PrivacyPermissionStatusDto;
  readonly network: {
    readonly activeMode: ProxyMode['kind'] | null;
    readonly appliesTo: 'new_requests_only';
    readonly activeRequestsRetried: false;
    readonly credentialStorage: SettingsCapabilityDto;
    readonly lastTest: ProxyTestResultDto | null;
  };
  readonly notifications: {
    readonly inApp: SettingsCapabilityDto & { readonly state: 'available' };
    readonly system: SettingsCapabilityDto;
    readonly sound: SettingsCapabilityDto;
  };
  readonly shortcuts: {
    readonly registryVersion: 1;
    readonly platform: ShortcutPlatform;
    readonly actions: readonly ShortcutActionDto[];
    readonly activeGlobalActionIds: readonly string[];
  };
}

export type SettingsOperationRequestDto =
  | {
      readonly kind: 'restore_category_defaults';
      readonly category: SettingsCategory;
    }
  | { readonly kind: 'restore_all_defaults' }
  | {
      readonly kind: 'migrate_directory';
      readonly purpose: DirectoryPurpose;
      readonly targetDirectoryId: string;
    }
  | {
      readonly kind: 'cleanup_storage';
      readonly scopes: readonly CleanupScope[];
    }
  | {
      readonly kind: 'update_performance';
      readonly values: PerformanceSettings;
    }
  | {
      readonly kind: 'update_hardware_acceleration';
      readonly value: 'auto' | 'prefer_hardware' | 'software_only';
    }
  | {
      readonly kind: 'update_privacy_permissions';
      readonly values: PrivacySettings;
    }
  | {
      readonly kind: 'update_proxy';
      readonly value: ProxyMode;
      readonly credentialHandle?: string;
    }
  | {
      readonly kind: 'update_shortcuts';
      readonly platform: ShortcutPlatform;
      readonly bindings: readonly ShortcutUpdateBindingDto[];
    }
  | {
      readonly kind: 'restore_shortcut_defaults';
      readonly platform: ShortcutPlatform;
    };

export interface SettingsOperationPlanDto {
  readonly kind:
    | SettingsOperationRequestDto['kind']
    | 'import_portable_settings';
  readonly confirmationHandle: string;
  readonly expectedRevision: number;
  readonly expiresAt: string;
  readonly affectedCategories: readonly SettingsCategory[];
  readonly changedValueCount: number;
  readonly reversible: boolean;
  readonly blockers: readonly string[];
  readonly warnings?: readonly string[];
  readonly impact?: {
    readonly fileCount?: number;
    readonly bytes?: number;
    readonly activeTasksUnaffected?: boolean;
    readonly oldLocationRetained?: boolean;
  };
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
  getSystemStatus(): Promise<SettingsIpcResult<SettingsSystemStatusDto>>;
  selectDirectory(
    purpose: DirectoryPurpose
  ): Promise<SettingsIpcResult<ControlledDirectoryDto | null>>;
  openSystemSettings(
    target: NativeSystemSettingsTarget
  ): Promise<SettingsIpcResult<{ readonly opened: true }>>;
  sendTestNotification(
    system: boolean,
    sound: boolean
  ): Promise<SettingsIpcResult<NotificationTestResultDto>>;
  stageProxyCredential(
    username: string,
    value: string
  ): Promise<SettingsIpcResult<{ readonly credentialHandle: string }>>;
  planOperation(
    expectedRevision: number,
    operation: SettingsOperationRequestDto
  ): Promise<SettingsIpcResult<SettingsOperationPlanDto>>;
  executeOperation(
    confirmationHandle: string
  ): Promise<SettingsIpcResult<SettingsSnapshotDto>>;
}
