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
  type PrivacySettings,
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
  SettingsSnapshotDto,
  NativeSystemSettingsTarget,
  NotificationTestResultDto,
  SettingsSystemStatusDto,
  ShortcutPlatform,
  DiagnosticBundlePreviewDto,
  DiagnosticBundleResultDto,
  SettingsMaintenanceStatusDto,
  LocalApplicationDataScope
} from '../../shared/settings-ipc';
import { directoryPurposes, localApplicationDataScopes } from '../../shared/settings-ipc';
import {
  type CleanupPlan,
  type CleanupService,
  describeControlledDirectory,
  type DirectoryMigrationPlan,
  type DirectoryMigrationService,
  type DirectoryAuthorizationPort,
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
import {
  type NotificationService,
  type PrivacyPermissionService,
  type ProxyChangePlan,
  ProxyOperationError,
  type ProxyService,
  type ShortcutChangePlan,
  ShortcutOperationError,
  type ShortcutService,
  ApplicationDataOperationError,
  type ApplicationDataPlan,
  type ApplicationDataService,
  type DiagnosticsService,
  type UpdatesService
} from '../settings';

interface PendingSettingsOperation {
  readonly kind: SettingsOperationPlanDto['kind'];
  readonly expectedRevision: number;
  readonly expiresAtMs: number;
  readonly values?: SettingsValues;
  readonly migration?: DirectoryMigrationPlan;
  readonly cleanup?: CleanupPlan;
  readonly blocker?: string;
  readonly proxyPlan?: ProxyChangePlan;
  readonly shortcutPlan?: ShortcutChangePlan;
  readonly applicationData?: ApplicationDataPlan;
}

export interface SettingsB2Services {
  readonly userDataPath: string;
  readonly directoryRegistry: DirectoryRegistry;
  readonly directoryAuthorization?: DirectoryAuthorizationPort;
  readonly directoryMigration: DirectoryMigrationService;
  readonly cleanup: CleanupService;
  readonly performance: PerformancePolicyService;
  readonly media: MediaSettingsStatusService;
}

export interface SettingsB3Services {
  readonly privacy: PrivacyPermissionService;
  readonly proxy: ProxyService;
  readonly notifications: NotificationService;
  readonly shortcuts: ShortcutService;
}

export interface SettingsB4Services {
  readonly diagnostics: DiagnosticsService;
  readonly updates: UpdatesService;
  readonly applicationData: ApplicationDataService;
}

class UnsupportedSettingsOperationError extends Error {}

const unavailableCapabilities = ['diagnostics', 'updates'] as const;

const b3Capabilities = [
  'permission_controls',
  'proxy_controls',
  'notification_controls',
  'shortcut_controls'
] as const;

export class SettingsController {
  private readonly pending = new Map<string, PendingSettingsOperation>();

  constructor(
    private readonly repository: SettingsRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createHandle: () => string = () => randomUUID(),
    private readonly planLifetimeMs = 5 * 60 * 1000,
    private readonly b2?: SettingsB2Services,
    private readonly b3?: SettingsB3Services,
    private readonly b4?: SettingsB4Services
  ) {}

  async getSnapshot(): Promise<SettingsIpcResult<SettingsSnapshotDto>> {
    try {
      return {
        ok: true,
        value: toSnapshot(
          await this.repository.load(),
          Boolean(this.b2),
          Boolean(this.b3),
          Boolean(this.b4)
        )
      };
    } catch {
      return failure('settings_read_failed', 'Local settings could not be read');
    }
  }

  async getSystemStatus() {
    if (!this.b2) {
      return failure('operation_unsupported', 'System settings adapters are unavailable');
    }
    try {
      const current = await this.repository.load();
      const [entries, appUsage, performance, media, privacy, network, notifications] = await Promise.all([
        this.b2.directoryRegistry.list(),
        scanDirectoryUsage(this.b2.userDataPath),
        this.b2.performance.getStatus(),
        this.b2.media.getStatus(),
        this.b3?.privacy.getStatus() ?? Promise.resolve(unavailablePrivacyStatus()),
        this.b3?.proxy.getStatus(current.document.network.proxy) ??
          Promise.resolve(unavailableNetworkStatus()),
        this.b3?.notifications.getStatus() ?? Promise.resolve(unavailableNotificationStatus())
      ]);
      const directories = await Promise.all(entries.map((entry) =>
        describeControlledDirectory(entry, this.b2?.directoryAuthorization)
      ));
      const shortcuts = this.b3?.shortcuts.getStatus(current.document.shortcuts) ??
        unavailableShortcutStatus();
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
          media,
          privacy,
          network,
          notifications,
          shortcuts
        }
      };
    } catch {
      return failure('settings_read_failed', 'System settings status could not be read');
    }
  }

  async openSystemSettings(
    target: unknown
  ): Promise<SettingsIpcResult<{ readonly opened: true }>> {
    if (!this.b3) {
      return failure('operation_unsupported', 'System settings adapters are unavailable');
    }
    if (!isNativeSystemSettingsTarget(target)) {
      return failure('invalid_request', 'Native system settings target is invalid');
    }
    try {
      await this.b3.privacy.openSystemSettings(target);
      return { ok: true, value: { opened: true } };
    } catch {
      return failure('operation_failed', 'System settings could not be opened');
    }
  }

  async sendTestNotification(
    system: unknown,
    sound: unknown
  ): Promise<SettingsIpcResult<NotificationTestResultDto>> {
    if (!this.b3) {
      return failure('operation_unsupported', 'Notification adapters are unavailable');
    }
    if (typeof system !== 'boolean' || typeof sound !== 'boolean') {
      return failure('invalid_request', 'Notification test request is invalid');
    }
    try {
      return { ok: true, value: await this.b3.notifications.sendTest(system, sound) };
    } catch {
      return failure('operation_failed', 'Notification test failed');
    }
  }

  async stageProxyCredential(
    input: unknown
  ): Promise<SettingsIpcResult<{ readonly credentialHandle: string }>> {
    if (!this.b3) {
      return failure('operation_unsupported', 'Proxy credential storage is unavailable');
    }
    try {
      const item = exactRequest(input, ['username', 'value']);
      if (
        typeof item.username !== 'string' || item.username.length > 512 ||
        typeof item.value !== 'string' || item.value.length < 1 || item.value.length > 65_536
      ) {
        throw new TypeError('Proxy credential is invalid');
      }
      return {
        ok: true,
        value: {
          credentialHandle: await this.b3.proxy.stageCredential(item.username, item.value)
        }
      };
    } catch {
      return failure('invalid_request', 'Proxy credential is invalid');
    }
  }

  async getMaintenanceStatus(
    checkUpdates = false
  ): Promise<SettingsIpcResult<SettingsMaintenanceStatusDto>> {
    if (!this.b4) {
      return failure('operation_unsupported', 'Diagnostics and update adapters are unavailable');
    }
    try {
      const current = await this.repository.load();
      return {
        ok: true,
        value: {
          diagnostics: {
            capability: this.b4.diagnostics.getCapability(),
            logging: {
              level: current.document.diagnostics.level,
              retentionDays: current.document.diagnostics.retentionDays,
              maxFileBytes: current.document.diagnostics.maxFileBytes,
              automaticCleanup: current.document.diagnostics.autoCleanup,
              localOnly: true,
              automaticUpload: false
            },
            lastBundleAvailable: this.b4.diagnostics.getLastBundleAvailable()
          },
          updates: await this.b4.updates.getStatus(current.document.updates, checkUpdates)
        }
      };
    } catch {
      return failure('settings_read_failed', 'Maintenance status could not be read');
    }
  }

  async previewDiagnosticBundle(): Promise<SettingsIpcResult<DiagnosticBundlePreviewDto>> {
    if (!this.b4) {
      return failure('operation_unsupported', 'Diagnostics are unavailable');
    }
    try {
      const current = await this.repository.load();
      return { ok: true, value: await this.b4.diagnostics.preview(current.document.diagnostics) };
    } catch {
      return failure('operation_failed', 'Diagnostic preview could not be prepared');
    }
  }

  /** Called only by Electron main after a native directory picker succeeds. */
  async generateDiagnosticBundle(
    outputDirectory: unknown
  ): Promise<SettingsIpcResult<DiagnosticBundleResultDto>> {
    if (!this.b4) {
      return failure('operation_unsupported', 'Diagnostics are unavailable');
    }
    if (typeof outputDirectory !== 'string' || outputDirectory.length < 1) {
      return failure('invalid_request', 'Diagnostic output directory is invalid');
    }
    try {
      const current = await this.repository.load();
      return {
        ok: true,
        value: await this.b4.diagnostics.generate(current.document.diagnostics, outputDirectory)
      };
    } catch {
      return failure('operation_failed', 'Diagnostic bundle generation failed and temporary files were removed');
    }
  }

  async openDiagnosticLocation(
    target: unknown
  ): Promise<SettingsIpcResult<{ readonly opened: true }>> {
    if (!this.b4) {
      return failure('operation_unsupported', 'Diagnostics are unavailable');
    }
    if (target !== 'logs' && target !== 'last_bundle') {
      return failure('invalid_request', 'Diagnostic location target is invalid');
    }
    try {
      await this.b4.diagnostics.openLocation(target);
      return { ok: true, value: { opened: true } };
    } catch {
      return failure('operation_failed', 'Diagnostic location could not be opened');
    }
  }

  async checkForUpdates(): Promise<SettingsIpcResult<SettingsMaintenanceStatusDto>> {
    return this.getMaintenanceStatus(true);
  }

  /** Called only by Electron main after a native directory picker succeeds. */
  async registerSelectedDirectory(
    purpose: unknown,
    selectedPath: string,
    authorization?: Parameters<DirectoryRegistry['register']>[2]
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
          await this.b2.directoryRegistry.register(purpose, selectedPath, authorization),
          this.b2.directoryAuthorization
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
          Boolean(this.b2),
          Boolean(this.b3),
          Boolean(this.b4)
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
        const defaults = createDefaultSettingsValues();
        if (this.b3) {
          const proxyPlan = JSON.stringify(currentValues.network.proxy) ===
            JSON.stringify(defaults.network.proxy)
            ? undefined
            : await this.b3.proxy.plan(
                currentValues.network.proxy,
                defaults.network.proxy,
                undefined,
                currentValues.network.connectionTimeoutMs
              );
          const shortcutPlan = this.b3.shortcuts.restoreAllDefaults(
            currentValues.shortcuts
          );
          return {
            ok: true,
            value: this.rememberPlan(request.operation.kind, current, defaults, {
              blocker: proxyPlan && !proxyPlan.test.ok
                ? `proxy_test_${proxyPlan.test.failure}`
                : undefined,
              warnings: ['changes_apply_to_new_requests_only', 'active_requests_are_not_retried'],
              proxyPlan: proxyPlan?.test.ok ? proxyPlan : undefined,
              shortcutPlan
            })
          };
        }
        return {
          ok: true,
          value: this.rememberPlan(
            request.operation.kind,
            current,
            defaults
          )
        };
      }
      if (request.operation.kind === 'restore_category_defaults') {
        const next = restoreSettingsCategory(currentValues, request.operation.category);
        if (this.b3 && request.operation.category === 'network') {
          const proxyPlan = JSON.stringify(currentValues.network.proxy) ===
            JSON.stringify(next.network.proxy)
            ? undefined
            : await this.b3.proxy.plan(
                currentValues.network.proxy,
                next.network.proxy,
                undefined,
                currentValues.network.connectionTimeoutMs
              );
          return {
            ok: true,
            value: this.rememberPlan(request.operation.kind, current, next, {
              blocker: proxyPlan && !proxyPlan.test.ok
                ? `proxy_test_${proxyPlan.test.failure}`
                : undefined,
              warnings: ['changes_apply_to_new_requests_only', 'active_requests_are_not_retried'],
              proxyPlan: proxyPlan?.test.ok ? proxyPlan : undefined
            })
          };
        }
        if (this.b3 && request.operation.category === 'shortcuts') {
          return {
            ok: true,
            value: this.rememberPlan(request.operation.kind, current, next, {
              shortcutPlan: this.b3.shortcuts.restoreAllDefaults(currentValues.shortcuts)
            })
          };
        }
        return {
          ok: true,
          value: this.rememberPlan(
            request.operation.kind,
            current,
            next
          )
        };
      }
      if (
        request.operation.kind === 'update_privacy_permissions' ||
        request.operation.kind === 'update_proxy' ||
        request.operation.kind === 'update_shortcuts' ||
        request.operation.kind === 'restore_shortcut_defaults'
      ) {
        if (!this.b3) throw new UnsupportedSettingsOperationError();
        return {
          ok: true,
          value: await this.planB3Operation(current, currentValues, request.operation)
        };
      }
      if (request.operation.kind === 'clear_local_application_data') {
        if (!this.b4) throw new UnsupportedSettingsOperationError();
        const dataPlan = await this.b4.applicationData.plan(request.operation.scopes);
        const resetSettings = request.operation.scopes.includes('settings');
        const next = resetSettings ? createDefaultSettingsValues() : undefined;
        let proxyPlan: ProxyChangePlan | undefined;
        let shortcutPlan: ShortcutChangePlan | undefined;
        let blocker: string | undefined;
        if (resetSettings && this.b3) {
          if (JSON.stringify(currentValues.network.proxy) !==
            JSON.stringify(createDefaultSettingsValues().network.proxy)) {
            proxyPlan = await this.b3.proxy.plan(
              currentValues.network.proxy,
              { kind: 'system_default' },
              undefined,
              currentValues.network.connectionTimeoutMs
            );
            if (!proxyPlan.test.ok) blocker = `proxy_test_${proxyPlan.test.failure}`;
          }
          shortcutPlan = this.b3.shortcuts.restoreAllDefaults(currentValues.shortcuts);
          if (shortcutPlan.issues.length > 0) blocker = 'shortcut_conflict';
        }
        return {
          ok: true,
          value: this.rememberEffectPlan(request.operation.kind, current, {
            values: next,
            applicationData: dataPlan,
            proxyPlan: proxyPlan?.test.ok ? proxyPlan : undefined,
            shortcutPlan,
            blocker,
            reversible: false,
            affectedCategories: resetSettings ? settingsCategories : [],
            changedValueCount: resetSettings ? countChangedLeaves(currentValues, next) : 0,
            warnings: [
              'projects_works_tasks_and_source_media_are_excluded',
              'external_files_are_excluded',
              'deleted_application_data_cannot_be_recovered'
            ],
            impact: {
              fileCount: dataPlan.fileCount,
              bytes: dataPlan.bytes,
              settingsReset: resetSettings,
              credentialsDeleted: request.operation.scopes.includes('local_credentials'),
              projectsExcluded: true,
              externalFilesExcluded: true
            }
          })
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
      const rollbacks: Array<() => Promise<void>> = [];
      try {
        if (pending.proxyPlan) {
          if (!this.b3) throw new UnsupportedSettingsOperationError();
          rollbacks.push(await this.b3.proxy.apply(pending.proxyPlan));
        }
        if (pending.shortcutPlan) {
          if (!this.b3) throw new UnsupportedSettingsOperationError();
          rollbacks.push(await this.b3.shortcuts.apply(pending.shortcutPlan));
        }
        if (pending.migration) {
          if (!this.b2) throw new UnsupportedSettingsOperationError();
          await this.b2.directoryMigration.execute(pending.migration);
        }
        if (pending.cleanup) {
          if (!this.b2) throw new UnsupportedSettingsOperationError();
          await this.b2.cleanup.execute(pending.cleanup);
        }
        if (pending.applicationData) {
          if (!this.b4) throw new UnsupportedSettingsOperationError();
          await this.b4.applicationData.execute(pending.applicationData);
        }
        const result = pending.values
          ? await this.repository.replace(pending.expectedRevision, pending.values)
          : current;
        return {
          ok: true,
          value: toSnapshot(
            result,
            Boolean(this.b2),
            Boolean(this.b3),
            Boolean(this.b4)
          )
        };
      } catch (error) {
        for (const rollback of rollbacks.reverse()) {
          try {
            await rollback();
          } catch {
            // Preserve the original operation failure for the renderer.
          }
        }
        throw error;
      }
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
      readonly proxyPlan?: ProxyChangePlan;
      readonly shortcutPlan?: ShortcutChangePlan;
      readonly applicationData?: ApplicationDataPlan;
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
      blocker: options.blocker,
      proxyPlan: options.proxyPlan,
      shortcutPlan: options.shortcutPlan,
      applicationData: options.applicationData
    });
    return plan;
  }

  private async planB3Operation(
    current: SettingsLoadResult,
    values: SettingsValues,
    operation: Extract<SettingsOperationRequestDto, {
      readonly kind:
        | 'update_privacy_permissions'
        | 'update_proxy'
        | 'update_shortcuts'
        | 'restore_shortcut_defaults';
    }>
  ): Promise<SettingsOperationPlanDto> {
    if (!this.b3) throw new UnsupportedSettingsOperationError();
    if (operation.kind === 'update_privacy_permissions') {
      const next = parseSettingsValues({ ...values, privacy: operation.values });
      return this.rememberPlan(operation.kind, current, next, {
        warnings: ['mandatory_outbound_and_cost_confirmations_remain_enabled']
      });
    }
    if (operation.kind === 'update_proxy') {
      const next = parseSettingsValues({
        ...values,
        network: { ...values.network, proxy: operation.value }
      });
      const proxyPlan = await this.b3.proxy.plan(
        values.network.proxy,
        next.network.proxy,
        operation.credentialHandle,
        values.network.connectionTimeoutMs
      );
      return this.rememberPlan(operation.kind, current, next, {
        blocker: proxyPlan.test.ok ? undefined : `proxy_test_${proxyPlan.test.failure}`,
        warnings: ['changes_apply_to_new_requests_only', 'active_requests_are_not_retried'],
        proxyPlan: proxyPlan.test.ok ? proxyPlan : undefined
      });
    }
    const shortcutPlan = operation.kind === 'restore_shortcut_defaults'
      ? this.b3.shortcuts.restoreDefaults(values.shortcuts, operation.platform)
      : this.b3.shortcuts.plan(values.shortcuts, operation.platform, operation.bindings);
    const next = parseSettingsValues({ ...values, shortcuts: shortcutPlan.next });
    return this.rememberPlan(operation.kind, current, next, {
      blocker: shortcutPlan.issues.length > 0 ? 'shortcut_conflict' : undefined,
      shortcutPlan
    });
  }

  private async planB2Operation(
    current: SettingsLoadResult,
    values: SettingsValues,
    operation: Extract<SettingsOperationRequestDto, { readonly kind:
      | 'migrate_directory'
      | 'cleanup_storage'
      | 'update_performance'
      | 'update_hardware_acceleration'; }>
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
      readonly proxyPlan?: ProxyChangePlan;
      readonly shortcutPlan?: ShortcutChangePlan;
      readonly applicationData?: ApplicationDataPlan;
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
      blocker: options.blocker,
      proxyPlan: options.proxyPlan,
      shortcutPlan: options.shortcutPlan,
      applicationData: options.applicationData
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

function toSnapshot(
  result: SettingsLoadResult,
  b2Available: boolean,
  b3Available: boolean,
  b4Available = false
): SettingsSnapshotDto {
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
        ...(b2Available ? b2Capabilities : []),
        ...(b3Available ? b3Capabilities : []),
        ...(b4Available ? ['diagnostics'] : [])
      ],
      unavailableKeys: [
        ...(!b2Available ? b2Capabilities : []),
        ...(!b3Available ? b3Capabilities : []),
        ...(b4Available ? ['updates'] : unavailableCapabilities)
      ]
    },
    capabilities: [
      { id: 'settings_persistence', state: 'available' },
      ...b2Capabilities.map<SettingsCapabilityDto>((id) => b2Available
        ? { id, state: 'available' }
        : { id, state: 'unavailable', reason: 'phase8_platform_adapter_pending' }),
      ...b3Capabilities.map<SettingsCapabilityDto>((id) => b3Available
        ? { id, state: 'available' }
        : { id, state: 'unavailable', reason: 'phase8_platform_adapter_pending' }),
      ...(b4Available
        ? [
            { id: 'diagnostics', state: 'available' as const, reason: 'local_only_no_upload' },
            {
              id: 'updates',
              state: 'unavailable' as const,
              reason: 'production_update_source_not_configured'
            }
          ]
        : unavailableCapabilities.map<SettingsCapabilityDto>((id) => ({
            id,
            state: 'unavailable',
            reason: 'phase8_platform_adapter_pending'
          })))
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
  if (operation.kind === 'update_privacy_permissions') {
    exactKeys(operation, ['kind', 'values']);
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'update_privacy_permissions',
        values: record(operation.values) as unknown as PrivacySettings
      }
    };
  }
  if (operation.kind === 'update_proxy') {
    const keys = operation.credentialHandle === undefined
      ? ['kind', 'value']
      : ['kind', 'value', 'credentialHandle'];
    exactKeys(operation, keys);
    const defaults = createDefaultSettingsValues();
    const value = parseSettingsValues({
      ...defaults,
      network: { ...defaults.network, proxy: operation.value }
    }).network.proxy;
    let credentialHandle: string | undefined;
    if (operation.credentialHandle !== undefined) {
      if (
        typeof operation.credentialHandle !== 'string' ||
        !/^[A-Za-z0-9-]{8,128}$/.test(operation.credentialHandle)
      ) {
        throw new TypeError('Proxy credential handle is invalid');
      }
      credentialHandle = operation.credentialHandle;
    }
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'update_proxy',
        value,
        ...(credentialHandle ? { credentialHandle } : {})
      }
    };
  }
  if (operation.kind === 'update_shortcuts') {
    exactKeys(operation, ['kind', 'platform', 'bindings']);
    const platform = shortcutPlatform(operation.platform);
    if (!Array.isArray(operation.bindings)) throw new TypeError('Shortcut bindings are invalid');
    const bindings = operation.bindings.map((value) => {
      const binding = exactRequest(value, ['actionId', 'accelerator']);
      if (
        typeof binding.actionId !== 'string' || binding.actionId.length < 1 ||
        binding.actionId.length > 100 ||
        (binding.accelerator !== null && typeof binding.accelerator !== 'string')
      ) {
        throw new TypeError('Shortcut binding is invalid');
      }
      return {
        actionId: binding.actionId,
        accelerator: binding.accelerator as string | null
      };
    });
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: { kind: 'update_shortcuts', platform, bindings }
    };
  }
  if (operation.kind === 'restore_shortcut_defaults') {
    exactKeys(operation, ['kind', 'platform']);
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: {
        kind: 'restore_shortcut_defaults',
        platform: shortcutPlatform(operation.platform)
      }
    };
  }
  if (operation.kind === 'clear_local_application_data') {
    exactKeys(operation, ['kind', 'scopes']);
    if (!Array.isArray(operation.scopes) || operation.scopes.length === 0) {
      throw new TypeError('Application data scopes are invalid');
    }
    const scopes = operation.scopes.map((scope) => {
      if (!localApplicationDataScopes.includes(scope as LocalApplicationDataScope)) {
        throw new TypeError('Application data scope is invalid');
      }
      return scope as LocalApplicationDataScope;
    });
    if (new Set(scopes).size !== scopes.length) {
      throw new TypeError('Application data scopes must be unique');
    }
    return {
      expectedRevision: revision(item.expectedRevision),
      operation: { kind: 'clear_local_application_data', scopes }
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
  if (error instanceof ProxyOperationError || error instanceof ShortcutOperationError) {
    return failure('operation_failed', error.message);
  }
  if (error instanceof ApplicationDataOperationError) {
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

function isNativeSystemSettingsTarget(
  value: unknown
): value is NativeSystemSettingsTarget {
  return value === 'files_and_folders' || value === 'notifications';
}

function shortcutPlatform(value: unknown): ShortcutPlatform {
  if (value !== 'windows' && value !== 'macos') {
    throw new TypeError('Shortcut platform is invalid');
  }
  return value;
}

function unavailablePrivacyStatus(): SettingsSystemStatusDto['privacy'] {
  return {
    minimumAuthorization: {
      selectedFilesOnly: true,
      authorizedDirectoriesOnly: true,
      homeDirectoryScan: false,
      backgroundClipboardRead: false,
      outboundConfirmationMandatory: true,
      unknownCostConfirmationMandatory: true
    },
    permissions: ['files_and_folders', 'notifications'].map((id) => ({
      id: id as 'files_and_folders' | 'notifications',
      state: 'unavailable',
      reason: 'phase8_platform_adapter_pending',
      systemSettingsTarget: id as NativeSystemSettingsTarget
    }))
  };
}

function unavailableNetworkStatus(): SettingsSystemStatusDto['network'] {
  return {
    activeMode: null,
    appliesTo: 'new_requests_only',
    activeRequestsRetried: false,
    credentialStorage: {
      id: 'proxy_credential_storage',
      state: 'unavailable',
      reason: 'phase8_platform_adapter_pending'
    },
    lastTest: null
  };
}

function unavailableNotificationStatus(): SettingsSystemStatusDto['notifications'] {
  return {
    inApp: { id: 'in_app_notifications', state: 'available' },
    system: {
      id: 'system_notifications',
      state: 'unavailable',
      reason: 'phase8_platform_adapter_pending'
    },
    sound: {
      id: 'notification_sound',
      state: 'unavailable',
      reason: 'phase8_platform_adapter_pending'
    }
  };
}

function unavailableShortcutStatus(): SettingsSystemStatusDto['shortcuts'] {
  return {
    registryVersion: 1,
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    actions: [],
    activeGlobalActionIds: []
  };
}
