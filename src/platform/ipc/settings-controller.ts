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
  type SettingsCategory,
  type SettingsValues
} from '../../domain';
import type {
  SettingsCapabilityDto,
  SettingsIpcResult,
  SettingsOperationPlanDto,
  SettingsOperationRequestDto,
  SettingsSnapshotDto
} from '../../shared/settings-ipc';
import {
  SettingsDataError,
  SettingsRevisionConflictError,
  type SettingsLoadResult,
  type SettingsRepository
} from '../settings';

interface PendingSettingsOperation {
  readonly expectedRevision: number;
  readonly expiresAtMs: number;
  readonly values: SettingsValues;
}

class UnsupportedSettingsOperationError extends Error {}

const unavailableCapabilities = [
  'platform_capability_detection',
  'directory_operations',
  'task_policy',
  'media_components',
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
    private readonly planLifetimeMs = 5 * 60 * 1000
  ) {}

  async getSnapshot(): Promise<SettingsIpcResult<SettingsSnapshotDto>> {
    try {
      return { ok: true, value: toSnapshot(await this.repository.load()) };
    } catch {
      return failure('settings_read_failed', 'Local settings could not be read');
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
          await this.repository.replace(request.expectedRevision, request.values)
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
      const values = request.operation.kind === 'restore_all_defaults'
        ? createDefaultSettingsValues()
        : restoreSettingsCategory(currentValues, request.operation.category);
      return {
        ok: true,
        value: this.rememberPlan(
          request.operation.kind,
          current,
          values
        )
      };
    } catch (error) {
      if (error instanceof UnsupportedSettingsOperationError) {
        return failure('operation_unsupported', 'Settings operation is not supported');
      }
      if (error instanceof SettingsDataError) {
        return failure('settings_read_failed', 'Local settings could not be read');
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
      return {
        ok: true,
        value: toSnapshot(
          await this.repository.replace(pending.expectedRevision, pending.values)
        )
      };
    } catch (error) {
      return mapWriteError(error);
    }
  }

  private rememberPlan(
    kind: SettingsOperationPlanDto['kind'],
    current: SettingsLoadResult,
    values: SettingsValues
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
      reversible: true,
      blockers: [],
      pendingRestart: []
    };
    this.pending.set(confirmationHandle, {
      expectedRevision: current.document.revision,
      expiresAtMs,
      values
    });
    return plan;
  }

  private purgeExpiredPlans(nowMs: number): void {
    for (const [handle, operation] of this.pending) {
      if (nowMs > operation.expiresAtMs) this.pending.delete(handle);
    }
  }
}

function toSnapshot(result: SettingsLoadResult): SettingsSnapshotDto {
  return {
    revision: result.document.revision,
    values: toSettingsValues(result.document),
    resolved: {
      appliedKeys: ['settings_persistence'],
      unavailableKeys: [...unavailableCapabilities]
    },
    capabilities: [
      { id: 'settings_persistence', state: 'available' },
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
    'operation_expired' | 'operation_unsupported',
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
