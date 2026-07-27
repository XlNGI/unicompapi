import { randomUUID } from 'node:crypto';
import {
  applyPortableSettings,
  createDefaultSettingsValues,
  exportPortableSettings,
  parsePortableSettings,
  parseSettingsValues,
  restoreSettingsCategory,
  settingsCategories,
  toSettingsValues,
  hasHighRiskSettingsChanges,
  type PerformanceSettings,
  type SettingsCategory,
  type SettingsValues
} from '../../domain';
import type {
  CleanupScope,
  ControlledDirectoryDto,
  DirectoryPurpose,
  SettingsCapabilityDto,
  SettingsIpcResult,
  SettingsOperationPlanDto,
  SettingsOperationRequestDto,
  SettingsSnapshotDto
} from '../../shared/settings-ipc';
import { directoryPurposes } from '../../shared/settings-ipc';
import {
  type CleanupPlan,
  type CleanupService,
  describeControlledDirectory,
  type DirectoryMigrationPlan,
  type DirectoryMigrationService,
  type DirectoryRegistry,
  type MediaSettingsStatusService,
  type PerformancePolicyService,
  scanDirectoryUsage,
  SettingsDataError,
  SettingsRevisionConflictError,
  StorageOperationError,
  type SettingsLoadResult,
  type SettingsRepository
} from '../settings';

interface PendingSettingsOperation {
  readonly kind: SettingsOperationPlanDto['kind'];
  readonly expectedRevision: number;
  readonly expiresAtMs: number;
  readonly values?: SettingsValues;
  readonly migration?: DirectoryMigrationPlan;
  readonly cleanup?: CleanupPlan;
  readonly blocker?: string;
}

export interface SettingsB2Services {
  readonly userDataPath: string;
  readonly directoryRegistry: DirectoryRegistry;
  readonly directoryMigration: DirectoryMigrationService;
  readonly cleanup: CleanupService;
  readonly performance: PerformancePolicyService;
  readonly media: MediaSettingsStatusService;
}

class UnsupportedSettingsOperationError extends Error {}

const unavailableCapabilities = [
  'permission_controls',
  'proxy_controls',
  'notification_controls',
  'shortcut_controls',
  'diagnostics',
  'updates'
] as const;

export class SettingsController {
  private readonly pending = new Map<string, PendingSettingsOperation>();

  constructor(
    private readonly repository: SettingsRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createHandle: () => string = () => randomUUID(),
    private readonly planLifetimeMs = 5 * 60 * 1000,
    private readonly b2?: SettingsB2Services
  ) {}

  async getSnapshot(): Promise<SettingsIpcResult<SettingsSnapshotDto>> {
    try {
      return { ok: true, value: toSnapshot(await this.repository.load(), Boolean(this.b2)) };
    } catch {
      return failure('settings_read_failed', 'Local settings could not be read');
    }
  }

  async getSystemStatus() {
    if (!this.b2) {
      return failure('operation_unsupported', 'System settings adapters are unavailable');
    }
    try {
      const [entries, appUsage, performance, media] = await Promise.all([
        this.b2.directoryRegistry.list(),
        scanDirectoryUsage(this.b2.userDataPath),
        this.b2.performance.getStatus(),
        this.b2.media.getStatus()
      ]);
      const directories = await Promise.all(entries.map(describeControlledDirectory));
      return {
        ok: true as const,
        value: {
          storage: {
            directories,
            appUsage,
            cleanupScopes: [
              'caches',
              'preview_proxies',
              'temporary_exports',
              'eligible_logs'
            ] as const
          },
          performance,
          media
        }
      };
    } catch {
      return failure('settings_read_failed', 'System settings status could not be read');
    }
  }

  /** Called only by Electron main after a native directory picker succeeds. */
  async registerSelectedDirectory(
    purpose: unknown,
    selectedPath: string
  ): Promise<SettingsIpcResult<ControlledDirectoryDto>> {
    if (!this.b2) {
      return failure('operation_unsupported', 'Directory registration is unavailable');
    }
    if (!isDirectoryPurpose(purpose)) {
      return failure('invalid_request', 'Directory purpose is invalid');
    }
    try {
      return {
        ok: true,
        value: await describeControlledDirectory(
          await this.b2.directoryRegistry.register(purpose, selectedPath)
        )
      };
    } catch {
      return failure('operation_failed', 'Selected directory could not be registered');
    }
  }

  async updateValues(input: unknown): Promise<SettingsIpcResult<SettingsSnapshotDto>> {
    try {
      const request = parseUpdateRequest(input);
      const current = await this.repository.load();
      if (current.document.revision !== request.expectedRevision) {
        return revisionConflict(current.document.revision);
      }
      const before = toSettingsValues(current.document);
      if (hasHighRiskSettingsChanges(before, request.values)) {
        return failure(
          'confirmation_required',
          'High-risk settings require an impact plan and explicit confirmation'
        );
      }
      return {
        ok: true,
        value: toSnapshot(
          await this.repository.replace(request.expectedRevision, request.values),
          Boolean(this.b2)
        )
      };
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async exportPortable() {
    try {
      const current = await this.repository.load();
      return {
        ok: true as const,
        value: exportPortableSettings(toSettingsValues(current.document))
      };
    } catch {
      return failure('settings_read_failed', 'Portable settings could not be prepared');
    }
  }

  async prepareImport(input: unknown): Promise<SettingsIpcResult<SettingsOperationPlanDto>> {
    try {
      const request = parseImportRequest(input);
      const current = await this.repository.load();
      if (current.document.revision !== request.expectedRevision) {
        return revisionConflict(current.document.revision);
      }
      const values = applyPortableSettings(
        toSettingsValues(current.document),
        request.document
      );
      return {
        ok: true,
        value: this.rememberPlan(
          'import_portable_settings',
          current,
          values
        )
      };
    } catch (error) {
      if (error instanceof SettingsRevisionConflictError) {
        return revisionConflict(error.actualRevision);
      }
      if (error instanceof SettingsDataError) {
        return failure('settings_read_failed', 'Local settings could not be read');
      }
      return failure('invalid_request', 'Portable settings are invalid');
    }
  }

  async planOperation(input: unknown): Promise<SettingsIpcResult<SettingsOperationPlanDto>> {
    try {
      const request = parseOperationRequest(input);
      const current = await this.repository.load();
      if (current.document.revision !== request.expectedRevision) {
        return revisionConflict(current.document.revision);
      }
      const currentValues = toSettingsValues(current.document);
      if (request.operation.kind === 'restore_all_defaults') {
        return {
          ok: true,
          value: this.rememberPlan(
            request.operation.kind,
            current,
            createDefaultSettingsValues()
          )
        };
      }
      if (request.operation.kind === 'restore_category_defaults') {
        return {
          ok: true,
          value: this.rememberPlan(
            request.operation.kind,
            current,
            restoreSettingsCategory(currentValues, request.operation.category)
          )
        };
      }
      if (!this.b2) throw new UnsupportedSettingsOperationError();
      return {
        ok: true,
        value: await this.planB2Operation(current, currentValues, request.operation)
      };
    } catch (error) {
      if (error instanceof UnsupportedSettingsOperationError) {
        return failure('operation_unsupported', 'Settings operation is not supported');
      }
      if (error instanceof SettingsDataError) {
        return failure('settings_read_failed', 'Local settings could not be read');
      }
      if (error instanceof StorageOperationError) {
        return failure('operation_blocked', error.message);
      }
      return failure('invalid_request', 'Settings operation request is invalid');
    }
  }

  async executeOperation(input: unknown): Promise<SettingsIpcResult<SettingsSnapshotDto>> {
    const confirmationHandle = parseConfirmationHandle(input);
    if (!confirmationHandle) {
      return failure('invalid_request', 'Confirmation handle is invalid');
    }
    const pending = this.pending.get(confirmationHandle);
    this.pending.delete(confirmationHandle);
    if (!pending) {
      return failure('operation_not_found', 'Settings operation was not found or already used');
    }
    if (Date.parse(this.now()) > pending.expiresAtMs) {
      return failure('operation_expired', 'Settings operation confirmation has expired');
    }
    try {
      const current = await this.repository.load();
      if (current.document.revision !== pending.expectedRevision) {
        return revisionConflict(current.document.revision);
      }
      if (pending.blocker) {
        return failure('operation_blocked', 'The operation still has blockers');
      }
      if (pending.migration) {
        if (!this.b2) throw new UnsupportedSettingsOperationError();
        await this.b2.directoryMigration.execute(pending.migration);
      }
      if (pending.cleanup) {
        if (!this.b2) throw new UnsupportedSettingsOperationError();
        await this.b2.cleanup.execute(pending.cleanup);
      }
      const result = pending.values
        ? await this.repository.replace(pending.expectedRevision, pending.values)
        : current;
      return {
        ok: true,
        value: toSnapshot(result, Boolean(this.b2))
      };
    } catch (error) {
      return mapOperationError(error);
    }
  }

  private rememberPlan(
    kind: SettingsOperationPlanDto['kind'],
    current: SettingsLoadResult,
    values: SettingsValues,
    options: {
      readonly reversible?: boolean;
      readonly blocker?: string;
      readonly warnings?: readonly string[];
      readonly impact?: SettingsOperationPlanDto['impact'];
    } = {}
  ): SettingsOperationPlanDto {
    const confirmationHandle = this.createHandle();
    const nowMs = Date.parse(this.now());
    this.purgeExpiredPlans(nowMs);
    const expiresAtMs = nowMs + this.planLifetimeMs;
    const before = toSettingsValues(current.document);
    const affectedCategories = settingsCategories.filter(
      (category) => JSON.stringify(before[category]) !== JSON.stringify(values[category])
    );
    const plan: SettingsOperationPlanDto = {
      kind,
      confirmationHandle,
      expectedRevision: current.document.revision,
      expiresAt: new Date(expiresAtMs).toISOString(),
      affectedCategories,
      changedValueCount: countChangedLeaves(before, values),
      reversible: options.reversible ?? true,
      blockers: options.blocker ? [options.blocker] : [],
      warnings: options.warnings,
      impact: options.impact,
      pendingRestart: []
    };
    this.pending.set(confirmationHandle, {
      kind,
      expectedRevision: current.document.revision,
      expiresAtMs,
      values,
      blocker: options.blocker
    });
    return plan;
  }

  private async planB2Operation(
    current: SettingsLoadResult,
    values: SettingsValues,
    operation: Exclude<SettingsOperationRequestDto,
      { readonly kind: 'restore_all_defaults' | 'restore_category_defaults' }>
  ): Promise<SettingsOperationPlanDto> {
    if (!this.b2) throw new UnsupportedSettingsOperationError();
    if (operation.kind === 'update_performance') {
      const next = parseSettingsValues({ ...values, performance: operation.values });
      return this.rememberPlan(operation.kind, current, next, {
        reversible: true,
        warnings: ['changes_apply_only_to_new_tasks_and_attempts'],
        impact: { activeTasksUnaffected: true }
      });
    }
    if (operation.kind === 'update_hardware_acceleration') {
      const next = parseSettingsValues({
        ...values,
        media: { ...values.media, hardwareAcceleration: operation.value }
      });
      return this.rememberPlan(operation.kind, current, next, {
        reversible: true,
        blocker: operation.value === 'prefer_hardware'
          ? 'hardware_acceleration_not_approved'
          : undefined,
        warnings: ['software_export_remains_available']
      });
    }
    if (operation.kind === 'cleanup_storage') {
      const cleanup = await this.b2.cleanup.plan(operation.scopes, {
        logRetentionDays: values.diagnostics.retentionDays,
        nowMs: Date.parse(this.now())
      });
      return this.rememberEffectPlan(operation.kind, current, {
        cleanup,
        reversible: false,
        affectedCategories: [],
        impact: { fileCount: cleanup.fileCount, bytes: cleanup.bytes }
      });
    }
    const next = assignDirectory(values, operation.purpose, operation.targetDirectoryId);
    try {
      const migration = await this.b2.directoryMigration.plan({
        purpose: operation.purpose,
        sourceDirectoryId: assignedDirectoryId(values, operation.purpose),
        targetDirectoryId: operation.targetDirectoryId
      });
      return this.rememberEffectPlan(operation.kind, current, {
        values: next,
        migration,
        reversible: true,
        affectedCategories: [operation.purpose === 'proxy' ? 'media' : 'storage'],
        changedValueCount: 1,
        impact: {
          fileCount: migration.fileCount,
          bytes: migration.bytes,
          oldLocationRetained: true
        }
      });
    } catch (error) {
      if (!(error instanceof StorageOperationError)) throw error;
      return this.rememberEffectPlan(operation.kind, current, {
        values: next,
        blocker: error.code,
        reversible: true,
        affectedCategories: [operation.purpose === 'proxy' ? 'media' : 'storage'],
        changedValueCount: 1
      });
    }
  }

  private rememberEffectPlan(
    kind: SettingsOperationPlanDto['kind'],
    current: SettingsLoadResult,
    options: {
      readonly values?: SettingsValues;
      readonly migration?: DirectoryMigrationPlan;
      readonly cleanup?: CleanupPlan;
      readonly blocker?: string;
      readonly reversible: boolean;
      readonly affectedCategories: readonly SettingsCategory[];
      readonly changedValueCount?: number;
      readonly warnings?: readonly string[];
      readonly impact?: SettingsOperationPlanDto['impact'];
    }
  ): SettingsOperationPlanDto {
    const confirmationHandle = this.createHandle();
    const nowMs = Date.parse(this.now());
    this.purgeExpiredPlans(nowMs);
    const expiresAtMs = nowMs + this.planLifetimeMs;
    this.pending.set(confirmationHandle, {
      kind,
      expectedRevision: current.document.revision,
      expiresAtMs,
      values: options.values,
      migration: options.migration,
      cleanup: options.cleanup,
      blocker: options.blocker
    });
    return {
      kind,
      confirmationHandle,
      expectedRevision: current.document.revision,
      expiresAt: new Date(expiresAtMs).toISOString(),
      affectedCategories: options.affectedCategories,
      changedValueCount: options.changedValueCount ?? 0,
      reversible: options.reversible,
      blockers: options.blocker ? [options.blocker] : [],
      warnings: options.warnings,
      impact: options.impact,
      pendingRestart: []
    };
  }

  private purgeExpiredPlans(nowMs: number): void {
    for (const [handle, operation] of this.pending) {
      if (nowMs > operation.expiresAtMs) this.pending.delete(handle);
    }
  }
}

function toSnapshot(result: SettingsLoadResult, b2Available: boolean): SettingsSnapshotDto {
  const b2Capabilities = [
    'platform_capability_detection',
    'directory_operations',
    'task_policy',
    'media_components'
  ];
  return {
    revision: result.document.revision,
    values: toSettingsValues(result.document),
    resolved: {
      appliedKeys: [
        'settings_persistence',
        ...(b2Available ? b2Capabilities : [])
      ],
      unavailableKeys: [
        ...(!b2Available ? b2Capabilities : []),
        ...unavailableCapabilities
      ]
    },
    capabilities: [
      { id: 'settings_persistence', state: 'available' },
      ...b2Capabilities.map<SettingsCapabilityDto>((id) => b2Available
        ? { id, state: 'available' }
        : { id, state: 'unavailable', reason: 'phase8_platform_adapter_pending' }),
      ...unavailableCapabilities.map<SettingsCapabilityDto>((id) => ({
        id,
        state: 'unavailable',
        reason: 'phase8_platform_adapter_pending'
      }))
    ],
    statuses: {
      repository: result.source,
      schemaVersion: 1
    },
    pendingRestart: []
  };
}

function parseUpdateRequest(value: unknown): {
  readonly expectedRevision: number;
  readonly values: SettingsValues;
} {
  const item = exactRequest(value, ['expectedRevision', 'values']);
  return {
    expectedRevision: revision(item.expectedRevision),
    values: parseSettingsValues(item.values)
  };
}

function parseImportRequest(value: unknown) {
  const item = exactRequest(value, ['expectedRevision', 'document']);
  return {
    expectedRevision: revision(item.expectedRevision),
    document: parsePortableSettings(item.document)
  };
}

function parseOperationRequest(value: unknown): {
  readonly expectedRevision: number;
  readonly operation: SettingsOperationRequestDto;
} {
  const item = exactRequest(value, ['expectedRevision', 'operation']);
  const operation = record(item.operation);
  if (operation.kind === 'restore_all_defaults') {
    exactKeys(operation, ['kind']);
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: { kind: 'restore_all_defaults' }
    };
  }
  if (operation.kind === 'restore_category_defaults') {
    exactKeys(operation, ['kind', 'category']);
    if (
      typeof operation.category !== 'string' ||
      !settingsCategories.includes(operation.category as SettingsCategory)
    ) {
      throw new TypeError('Settings category is invalid');
    }
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'restore_category_defaults',
        category: operation.category as SettingsCategory
      }
    };
  }
  if (operation.kind === 'migrate_directory') {
    exactKeys(operation, ['kind', 'purpose', 'targetDirectoryId']);
    if (!isDirectoryPurpose(operation.purpose) || !isControlledId(operation.targetDirectoryId)) {
      throw new TypeError('Directory migration request is invalid');
    }
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'migrate_directory',
        purpose: operation.purpose,
        targetDirectoryId: operation.targetDirectoryId
      }
    };
  }
  if (operation.kind === 'cleanup_storage') {
    exactKeys(operation, ['kind', 'scopes']);
    if (!Array.isArray(operation.scopes) || operation.scopes.length === 0) {
      throw new TypeError('Cleanup scopes are invalid');
    }
    const scopes = operation.scopes.map((scope) => {
      if (!isCleanupScope(scope)) throw new TypeError('Cleanup scope is invalid');
      return scope;
    });
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: { kind: 'cleanup_storage', scopes }
    };
  }
  if (operation.kind === 'update_performance') {
    exactKeys(operation, ['kind', 'values']);
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'update_performance',
        values: record(operation.values) as unknown as PerformanceSettings
      }
    };
  }
  if (operation.kind === 'update_hardware_acceleration') {
    exactKeys(operation, ['kind', 'value']);
    if (!['auto', 'prefer_hardware', 'software_only'].includes(String(operation.value))) {
      throw new TypeError('Hardware acceleration preference is invalid');
    }
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'update_hardware_acceleration',
        value: operation.value as 'auto' | 'prefer_hardware' | 'software_only'
      }
    };
  }
  throw new UnsupportedSettingsOperationError('Settings operation is unsupported');
}

function parseConfirmationHandle(value: unknown): string | undefined {
  try {
    const item = exactRequest(value, ['confirmationHandle']);
    if (
      typeof item.confirmationHandle !== 'string' ||
      !/^[A-Za-z0-9-]{8,128}$/.test(item.confirmationHandle)
    ) {
      return undefined;
    }
    return item.confirmationHandle;
  } catch {
    return undefined;
  }
}

function countChangedLeaves(before: unknown, after: unknown): number {
  if (JSON.stringify(before) === JSON.stringify(after)) return 0;
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].reduce(
      (total, key) => total + countChangedLeaves(before[key], after[key]),
      0
    );
  }
  return 1;
}

function mapWriteError(error: unknown): SettingsIpcResult<never> {
  if (error instanceof SettingsRevisionConflictError) {
    return revisionConflict(error.actualRevision);
  }
  if (error instanceof TypeError) {
    return failure('invalid_request', 'Settings values are invalid');
  }
  if (error instanceof SettingsDataError) {
    return failure('settings_write_failed', 'Local settings could not be saved');
  }
  return failure('settings_write_failed', 'Local settings could not be saved');
}

function mapOperationError(error: unknown): SettingsIpcResult<never> {
  if (error instanceof StorageOperationError) {
    return failure('operation_failed', error.message);
  }
  if (error instanceof UnsupportedSettingsOperationError) {
    return failure('operation_unsupported', 'Settings operation is not supported');
  }
  return mapWriteError(error);
}

function revisionConflict(actualRevision: number): SettingsIpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'revision_conflict',
      message: 'Settings changed since they were loaded',
      actualRevision
    }
  };
}

function failure(
  code: Parameters<typeof buildFailure>[0],
  message: string
): SettingsIpcResult<never> {
  return buildFailure(code, message);
}

function buildFailure(
  code: 'invalid_request' | 'settings_read_failed' | 'settings_write_failed' |
    'revision_conflict' | 'confirmation_required' | 'operation_not_found' |
    'operation_expired' | 'operation_unsupported' | 'operation_blocked' |
    'operation_failed',
  message: string
): SettingsIpcResult<never> {
  return { ok: false, error: { code, message } };
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError('Settings revision is invalid');
  }
  return Number(value);
}

function exactRequest(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = record(value);
  exactKeys(item, keys);
  return item;
}

function exactKeys(item: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (
    Object.keys(item).length !== expected.size ||
    Object.keys(item).some((key) => !expected.has(key))
  ) {
    throw new TypeError('Settings request contains missing or unknown fields');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError('Settings request must be an object');
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirectoryPurpose(value: unknown): value is DirectoryPurpose {
  return directoryPurposes.includes(value as DirectoryPurpose);
}

function isCleanupScope(value: unknown): value is CleanupScope {
  return [
    'caches',
    'preview_proxies',
    'temporary_exports',
    'eligible_logs'
  ].includes(String(value));
}

function isControlledId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function assignedDirectoryId(
  values: SettingsValues,
  purpose: DirectoryPurpose
): string | null {
  return purpose === 'proxy'
    ? values.media.proxyDirectoryId
    : values.storage.directories[purpose];
}

function assignDirectory(
  values: SettingsValues,
  purpose: DirectoryPurpose,
  directoryId: string
): SettingsValues {
  return purpose === 'proxy'
    ? parseSettingsValues({
      ...values,
      media: { ...values.media, proxyDirectoryId: directoryId }
    })
    : parseSettingsValues({
      ...values,
      storage: {
        ...values.storage,
        directories: { ...values.storage.directories, [purpose]: directoryId }
      }
    });
}
