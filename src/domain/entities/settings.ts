import type { IsoTimestamp } from '../timestamps';
import { toIsoTimestamp } from '../timestamps';

export const settingsCategories = [
  'general',
  'storage',
  'performance',
  'media',
  'privacy',
  'network',
  'notifications',
  'shortcuts',
  'diagnostics',
  'updates'
] as const;

export type SettingsCategory = (typeof settingsCategories)[number];

export interface GeneralSettings {
  readonly launchAtLogin: boolean;
  readonly startupDestination: 'projects' | 'chat' | 'last_active';
  readonly restoreLastSession: boolean;
  readonly inspectIncompleteTasks: boolean;
  readonly closeBehavior:
    | 'direct_exit'
    | 'minimize_to_tray'
    | 'confirm_when_tasks_running'
    | 'always_confirm';
  readonly theme: 'system' | 'dark' | 'light';
  readonly uiScalePercent: number;
  readonly density: 'comfortable' | 'compact';
  readonly animations: boolean;
  readonly reduceMotion: boolean;
  readonly rememberSidebar: boolean;
  readonly showTooltips: boolean;
  readonly locale: string;
  readonly dateFormat: 'system' | 'yyyy-mm-dd' | 'yyyy/mm/dd' | 'mm/dd/yyyy';
  readonly timeFormat: 'system' | '12h' | '24h';
  readonly fileSizeUnit: 'auto' | 'decimal' | 'binary';
}

export interface DirectoryAssignments {
  readonly projects: string | null;
  readonly works: string | null;
  readonly imageOutput: string | null;
  readonly videoOutput: string | null;
  readonly videoEditorOutput: string | null;
  readonly downloads: string | null;
  readonly cache: string | null;
}

export interface StorageSettings {
  readonly directories: DirectoryAssignments;
  readonly fileNamePrefix: string;
  readonly includeProjectName: boolean;
  readonly includeDate: boolean;
  readonly conflictPolicy: 'fail' | 'create_unique_name';
}

export type ConcurrencyIntent = 'auto' | number;

export interface PerformanceSettings {
  readonly mode: 'energy_saver' | 'balanced' | 'high_performance' | 'custom';
  readonly concurrency: {
    readonly onlineGeneration: ConcurrencyIntent;
    readonly localImage: ConcurrencyIntent;
    readonly localVideo: ConcurrencyIntent;
    readonly downloads: ConcurrencyIntent;
    readonly thumbnails: ConcurrencyIntent;
  };
  readonly continueInBackground: boolean;
  readonly preventSleepWhileActive: boolean;
  readonly pauseOnLowBattery: boolean;
  readonly switchToEnergySaverOnBattery: boolean;
  readonly resumeQueuedTasks: boolean;
  readonly resumeDownloads: boolean;
  readonly resumeExports: boolean;
  readonly cleanupUnrecoverableTemporaryFiles: boolean;
}

export interface MediaSettings {
  readonly hardwareAcceleration: 'auto' | 'prefer_hardware' | 'software_only';
  readonly automaticSoftwareFallback: true;
  readonly generatePreviewProxy: boolean;
  readonly exportFromOriginal: true;
  readonly cleanupExpiredProxies: boolean;
  readonly proxyDirectoryId: string | null;
}

export interface PrivacySettings {
  readonly allowSelectedFiles: true;
  readonly allowAuthorizedProjectDirectories: true;
  readonly allowWorkDownloadDirectories: true;
  readonly externalDiskPolicy: 'confirm_each_connection' | 'allow_authorized';
  readonly scanHomeDirectory: false;
  readonly clipboardMode: 'user_initiated_only';
  readonly textOutboundConfirmation: 'each_task' | 'always';
  readonly imageOutboundConfirmation: 'each_submission' | 'always';
  readonly videoOutboundConfirmation: 'each_submission' | 'always';
  readonly projectContextOutboundConfirmation: 'always';
  readonly unknownCostConfirmation: 'always';
  readonly readProjectContext: boolean;
  readonly readSavedProjectChats: boolean;
  readonly readUnsavedChats: false;
  readonly taskHistoryRetention: 'user_configured';
  readonly temporaryFileRetention: 'cleanup_rule';
  readonly worksRetention: 'never_auto_cleanup';
  readonly sourceMediaRetention: 'never_auto_cleanup';
}

export type ProxyMode =
  | { readonly kind: 'system_default' }
  | { readonly kind: 'system_proxy' }
  | {
      readonly kind: 'custom';
      readonly protocol: 'http' | 'https' | 'socks5';
      readonly host: string;
      readonly port: number;
      readonly authenticationConfigured: boolean;
    }
  | { readonly kind: 'direct' };

export interface NetworkSettings {
  readonly proxy: ProxyMode;
  readonly connectionTimeoutMs: number;
  readonly downloadTimeoutMs: number;
  readonly retryMode: 'request_only';
  readonly continueDownloadsAfterRecovery: boolean;
  readonly unknownRequestStatus: 'query_first';
}

export const notificationEventKinds = [
  'task_completed',
  'task_failed',
  'user_action_required',
  'download_completed',
  'export_completed',
  'storage_insufficient',
  'service_connection_failed',
  'update_available',
  'local_component_failed'
] as const;

export type NotificationEventKind = (typeof notificationEventKinds)[number];

export interface NotificationRule {
  readonly event: NotificationEventKind;
  readonly inApp: true;
  readonly system: boolean;
  readonly sound: boolean;
}

export interface NotificationSettings {
  readonly rules: readonly NotificationRule[];
  readonly mergeTaskCompletions: boolean;
  readonly mergeFailures: false;
  readonly keepUserActionVisible: true;
}

export interface ShortcutBinding {
  readonly actionId: string;
  readonly windows: string | null;
  readonly macos: string | null;
}

export interface ShortcutSettings {
  readonly bindings: readonly ShortcutBinding[];
}

export interface DiagnosticSettings {
  readonly categories: {
    readonly application: boolean;
    readonly tasks: boolean;
    readonly media: boolean;
    readonly networkErrors: boolean;
    readonly connectionValidation: boolean;
    readonly crashDiagnostics: boolean;
  };
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly retentionDays: number;
  readonly maxFileBytes: number;
  readonly autoCleanup: boolean;
  readonly crashCollection: 'only_on_crash';
}

export interface UpdateSettings {
  readonly automaticChecks: boolean;
  readonly downloadMode: 'notify_only';
  readonly installMode: 'user_confirmed';
  readonly duringActiveTasks: 'never';
  readonly channel: 'stable';
}

export interface SettingsValues {
  readonly general: GeneralSettings;
  readonly storage: StorageSettings;
  readonly performance: PerformanceSettings;
  readonly media: MediaSettings;
  readonly privacy: PrivacySettings;
  readonly network: NetworkSettings;
  readonly notifications: NotificationSettings;
  readonly shortcuts: ShortcutSettings;
  readonly diagnostics: DiagnosticSettings;
  readonly updates: UpdateSettings;
}

export interface SettingsDocumentV1 extends SettingsValues {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
}

export interface PortableSettingsV1 {
  readonly schemaVersion: 1;
  readonly general: GeneralSettings;
  readonly storage: Omit<StorageSettings, 'directories'>;
  readonly performance: PerformanceSettings;
  readonly media: Pick<
    MediaSettings,
    'generatePreviewProxy' | 'exportFromOriginal' | 'cleanupExpiredProxies'
  >;
  readonly privacy: PrivacySettings;
  readonly notifications: NotificationSettings;
  readonly diagnostics: DiagnosticSettings;
  readonly updates: UpdateSettings;
}

export function createDefaultSettings(now: string): SettingsDocumentV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: toIsoTimestamp(now),
    ...createDefaultSettingsValues()
  };
}

export function createDefaultSettingsValues(): SettingsValues {
  return {
    general: {
      launchAtLogin: false,
      startupDestination: 'projects',
      restoreLastSession: true,
      inspectIncompleteTasks: true,
      closeBehavior: 'confirm_when_tasks_running',
      theme: 'system',
      uiScalePercent: 100,
      density: 'comfortable',
      animations: true,
      reduceMotion: false,
      rememberSidebar: true,
      showTooltips: true,
      locale: 'zh-CN',
      dateFormat: 'system',
      timeFormat: 'system',
      fileSizeUnit: 'auto'
    },
    storage: {
      directories: {
        projects: null,
        works: null,
        imageOutput: null,
        videoOutput: null,
        videoEditorOutput: null,
        downloads: null,
        cache: null
      },
      fileNamePrefix: 'UniComp',
      includeProjectName: true,
      includeDate: false,
      conflictPolicy: 'create_unique_name'
    },
    performance: {
      mode: 'balanced',
      concurrency: {
        onlineGeneration: 'auto',
        localImage: 'auto',
        localVideo: 'auto',
        downloads: 'auto',
        thumbnails: 'auto'
      },
      continueInBackground: true,
      preventSleepWhileActive: true,
      pauseOnLowBattery: false,
      switchToEnergySaverOnBattery: true,
      resumeQueuedTasks: true,
      resumeDownloads: true,
      resumeExports: true,
      cleanupUnrecoverableTemporaryFiles: false
    },
    media: {
      hardwareAcceleration: 'auto',
      automaticSoftwareFallback: true,
      generatePreviewProxy: true,
      exportFromOriginal: true,
      cleanupExpiredProxies: true,
      proxyDirectoryId: null
    },
    privacy: {
      allowSelectedFiles: true,
      allowAuthorizedProjectDirectories: true,
      allowWorkDownloadDirectories: true,
      externalDiskPolicy: 'confirm_each_connection',
      scanHomeDirectory: false,
      clipboardMode: 'user_initiated_only',
      textOutboundConfirmation: 'each_task',
      imageOutboundConfirmation: 'each_submission',
      videoOutboundConfirmation: 'each_submission',
      projectContextOutboundConfirmation: 'always',
      unknownCostConfirmation: 'always',
      readProjectContext: true,
      readSavedProjectChats: true,
      readUnsavedChats: false,
      taskHistoryRetention: 'user_configured',
      temporaryFileRetention: 'cleanup_rule',
      worksRetention: 'never_auto_cleanup',
      sourceMediaRetention: 'never_auto_cleanup'
    },
    network: {
      proxy: { kind: 'system_default' },
      connectionTimeoutMs: 30_000,
      downloadTimeoutMs: 120_000,
      retryMode: 'request_only',
      continueDownloadsAfterRecovery: true,
      unknownRequestStatus: 'query_first'
    },
    notifications: {
      rules: notificationEventKinds.map((event) => ({
        event,
        inApp: true,
        system: event !== 'update_available',
        sound: event === 'task_failed' || event === 'user_action_required'
      })),
      mergeTaskCompletions: true,
      mergeFailures: false,
      keepUserActionVisible: true
    },
    shortcuts: { bindings: [] },
    diagnostics: {
      categories: {
        application: true,
        tasks: true,
        media: true,
        networkErrors: true,
        connectionValidation: true,
        crashDiagnostics: true
      },
      level: 'info',
      retentionDays: 14,
      maxFileBytes: 10 * 1024 * 1024,
      autoCleanup: true,
      crashCollection: 'only_on_crash'
    },
    updates: {
      automaticChecks: true,
      downloadMode: 'notify_only',
      installMode: 'user_confirmed',
      duringActiveTasks: 'never',
      channel: 'stable'
    }
  };
}

export function parseSettingsDocument(value: unknown): SettingsDocumentV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'revision', 'updatedAt', ...settingsCategories
  ], 'settings document');
  if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0) {
    throw new TypeError('Settings document version or revision is invalid');
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt: toIsoTimestamp(requireString(item.updatedAt, 'settings.updatedAt')),
    ...parseSettingsValues(pickSettingsValues(item))
  };
}

export function parseSettingsValues(value: unknown): SettingsValues {
  const item = exactRecord(value, settingsCategories, 'settings values');
  return {
    general: parseGeneral(item.general),
    storage: parseStorage(item.storage),
    performance: parsePerformance(item.performance),
    media: parseMedia(item.media),
    privacy: parsePrivacy(item.privacy),
    network: parseNetwork(item.network),
    notifications: parseNotifications(item.notifications),
    shortcuts: parseShortcuts(item.shortcuts),
    diagnostics: parseDiagnostics(item.diagnostics),
    updates: parseUpdates(item.updates)
  };
}

export function toSettingsValues(document: SettingsDocumentV1): SettingsValues {
  return parseSettingsValues(pickSettingsValues(document));
}

export function replaceSettingsValues(
  current: SettingsDocumentV1,
  values: SettingsValues,
  now: string
): SettingsDocumentV1 {
  return parseSettingsDocument({
    schemaVersion: 1,
    revision: current.revision + 1,
    updatedAt: now,
    ...values
  });
}

export function exportPortableSettings(
  values: SettingsValues
): PortableSettingsV1 {
  return parsePortableSettings({
    schemaVersion: 1,
    general: values.general,
    storage: {
      fileNamePrefix: values.storage.fileNamePrefix,
      includeProjectName: values.storage.includeProjectName,
      includeDate: values.storage.includeDate,
      conflictPolicy: values.storage.conflictPolicy
    },
    performance: values.performance,
    media: {
      generatePreviewProxy: values.media.generatePreviewProxy,
      exportFromOriginal: values.media.exportFromOriginal,
      cleanupExpiredProxies: values.media.cleanupExpiredProxies
    },
    privacy: values.privacy,
    notifications: values.notifications,
    diagnostics: values.diagnostics,
    updates: values.updates
  });
}

export function parsePortableSettings(value: unknown): PortableSettingsV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'general', 'storage', 'performance', 'media',
    'privacy', 'notifications', 'diagnostics', 'updates'
  ], 'portable settings');
  if (item.schemaVersion !== 1) {
    throw new TypeError('Portable settings version is unsupported');
  }
  const storage = exactRecord(item.storage, [
    'fileNamePrefix', 'includeProjectName', 'includeDate', 'conflictPolicy'
  ], 'portable storage settings');
  const media = exactRecord(item.media, [
    'generatePreviewProxy', 'exportFromOriginal', 'cleanupExpiredProxies'
  ], 'portable media settings');
  const parsedStorage = parseStorage({
    directories: createDefaultSettingsValues().storage.directories,
    ...storage
  });
  const parsedMedia = parseMedia({
    ...createDefaultSettingsValues().media,
    ...media
  });
  return {
    schemaVersion: 1,
    general: parseGeneral(item.general),
    storage: {
      fileNamePrefix: parsedStorage.fileNamePrefix,
      includeProjectName: parsedStorage.includeProjectName,
      includeDate: parsedStorage.includeDate,
      conflictPolicy: parsedStorage.conflictPolicy
    },
    performance: parsePerformance(item.performance),
    media: {
      generatePreviewProxy: parsedMedia.generatePreviewProxy,
      exportFromOriginal: parsedMedia.exportFromOriginal,
      cleanupExpiredProxies: parsedMedia.cleanupExpiredProxies
    },
    privacy: parsePrivacy(item.privacy),
    notifications: parseNotifications(item.notifications),
    diagnostics: parseDiagnostics(item.diagnostics),
    updates: parseUpdates(item.updates)
  };
}

export function applyPortableSettings(
  current: SettingsValues,
  portable: PortableSettingsV1
): SettingsValues {
  return parseSettingsValues({
    ...current,
    general: portable.general,
    storage: { ...current.storage, ...portable.storage },
    performance: portable.performance,
    media: { ...current.media, ...portable.media },
    privacy: portable.privacy,
    notifications: portable.notifications,
    diagnostics: portable.diagnostics,
    updates: portable.updates
  });
}

export function restoreSettingsCategory(
  current: SettingsValues,
  category: SettingsCategory
): SettingsValues {
  const defaults = createDefaultSettingsValues();
  return parseSettingsValues({ ...current, [category]: defaults[category] });
}

export function hasHighRiskSettingsChanges(
  before: SettingsValues,
  after: SettingsValues
): boolean {
  return stableJson(highRiskProjection(before)) !== stableJson(highRiskProjection(after));
}

function highRiskProjection(values: SettingsValues): unknown {
  return {
    directories: values.storage.directories,
    performance: values.performance,
    media: {
      hardwareAcceleration: values.media.hardwareAcceleration,
      cleanupExpiredProxies: values.media.cleanupExpiredProxies,
      proxyDirectoryId: values.media.proxyDirectoryId
    },
    proxy: values.network.proxy,
    shortcuts: values.shortcuts,
    diagnosticsCleanup: values.diagnostics.autoCleanup
  };
}

function parseGeneral(value: unknown): GeneralSettings {
  const item = exactRecord(value, [
    'launchAtLogin', 'startupDestination', 'restoreLastSession',
    'inspectIncompleteTasks', 'closeBehavior', 'theme', 'uiScalePercent',
    'density', 'animations', 'reduceMotion', 'rememberSidebar', 'showTooltips',
    'locale', 'dateFormat', 'timeFormat', 'fileSizeUnit'
  ], 'general settings');
  return {
    launchAtLogin: boolean(item.launchAtLogin, 'general.launchAtLogin'),
    startupDestination: oneOf(item.startupDestination, ['projects', 'chat', 'last_active'], 'general.startupDestination'),
    restoreLastSession: boolean(item.restoreLastSession, 'general.restoreLastSession'),
    inspectIncompleteTasks: boolean(item.inspectIncompleteTasks, 'general.inspectIncompleteTasks'),
    closeBehavior: oneOf(item.closeBehavior, ['direct_exit', 'minimize_to_tray', 'confirm_when_tasks_running', 'always_confirm'], 'general.closeBehavior'),
    theme: oneOf(item.theme, ['system', 'dark', 'light'], 'general.theme'),
    uiScalePercent: integer(item.uiScalePercent, 75, 200, 'general.uiScalePercent'),
    density: oneOf(item.density, ['comfortable', 'compact'], 'general.density'),
    animations: boolean(item.animations, 'general.animations'),
    reduceMotion: boolean(item.reduceMotion, 'general.reduceMotion'),
    rememberSidebar: boolean(item.rememberSidebar, 'general.rememberSidebar'),
    showTooltips: boolean(item.showTooltips, 'general.showTooltips'),
    locale: boundedString(item.locale, 2, 35, 'general.locale'),
    dateFormat: oneOf(item.dateFormat, ['system', 'yyyy-mm-dd', 'yyyy/mm/dd', 'mm/dd/yyyy'], 'general.dateFormat'),
    timeFormat: oneOf(item.timeFormat, ['system', '12h', '24h'], 'general.timeFormat'),
    fileSizeUnit: oneOf(item.fileSizeUnit, ['auto', 'decimal', 'binary'], 'general.fileSizeUnit')
  };
}

function parseStorage(value: unknown): StorageSettings {
  const item = exactRecord(value, [
    'directories', 'fileNamePrefix', 'includeProjectName', 'includeDate', 'conflictPolicy'
  ], 'storage settings');
  const directories = exactRecord(item.directories, [
    'projects', 'works', 'imageOutput', 'videoOutput', 'videoEditorOutput',
    'downloads', 'cache'
  ], 'directory assignments');
  return {
    directories: {
      projects: controlledIdOrNull(directories.projects, 'directories.projects'),
      works: controlledIdOrNull(directories.works, 'directories.works'),
      imageOutput: controlledIdOrNull(directories.imageOutput, 'directories.imageOutput'),
      videoOutput: controlledIdOrNull(directories.videoOutput, 'directories.videoOutput'),
      videoEditorOutput: controlledIdOrNull(directories.videoEditorOutput, 'directories.videoEditorOutput'),
      downloads: controlledIdOrNull(directories.downloads, 'directories.downloads'),
      cache: controlledIdOrNull(directories.cache, 'directories.cache')
    },
    fileNamePrefix: boundedString(item.fileNamePrefix, 1, 64, 'storage.fileNamePrefix'),
    includeProjectName: boolean(item.includeProjectName, 'storage.includeProjectName'),
    includeDate: boolean(item.includeDate, 'storage.includeDate'),
    conflictPolicy: oneOf(item.conflictPolicy, ['fail', 'create_unique_name'], 'storage.conflictPolicy')
  };
}

function parsePerformance(value: unknown): PerformanceSettings {
  const item = exactRecord(value, [
    'mode', 'concurrency', 'continueInBackground', 'preventSleepWhileActive',
    'pauseOnLowBattery', 'switchToEnergySaverOnBattery', 'resumeQueuedTasks',
    'resumeDownloads', 'resumeExports', 'cleanupUnrecoverableTemporaryFiles'
  ], 'performance settings');
  const concurrency = exactRecord(item.concurrency, [
    'onlineGeneration', 'localImage', 'localVideo', 'downloads', 'thumbnails'
  ], 'concurrency settings');
  return {
    mode: oneOf(item.mode, ['energy_saver', 'balanced', 'high_performance', 'custom'], 'performance.mode'),
    concurrency: {
      onlineGeneration: concurrencyValue(concurrency.onlineGeneration, 'concurrency.onlineGeneration'),
      localImage: concurrencyValue(concurrency.localImage, 'concurrency.localImage'),
      localVideo: concurrencyValue(concurrency.localVideo, 'concurrency.localVideo'),
      downloads: concurrencyValue(concurrency.downloads, 'concurrency.downloads'),
      thumbnails: concurrencyValue(concurrency.thumbnails, 'concurrency.thumbnails')
    },
    continueInBackground: boolean(item.continueInBackground, 'performance.continueInBackground'),
    preventSleepWhileActive: boolean(item.preventSleepWhileActive, 'performance.preventSleepWhileActive'),
    pauseOnLowBattery: boolean(item.pauseOnLowBattery, 'performance.pauseOnLowBattery'),
    switchToEnergySaverOnBattery: boolean(item.switchToEnergySaverOnBattery, 'performance.switchToEnergySaverOnBattery'),
    resumeQueuedTasks: boolean(item.resumeQueuedTasks, 'performance.resumeQueuedTasks'),
    resumeDownloads: boolean(item.resumeDownloads, 'performance.resumeDownloads'),
    resumeExports: boolean(item.resumeExports, 'performance.resumeExports'),
    cleanupUnrecoverableTemporaryFiles: boolean(item.cleanupUnrecoverableTemporaryFiles, 'performance.cleanupUnrecoverableTemporaryFiles')
  };
}

function parseMedia(value: unknown): MediaSettings {
  const item = exactRecord(value, [
    'hardwareAcceleration', 'automaticSoftwareFallback', 'generatePreviewProxy',
    'exportFromOriginal', 'cleanupExpiredProxies', 'proxyDirectoryId'
  ], 'media settings');
  return {
    hardwareAcceleration: oneOf(item.hardwareAcceleration, ['auto', 'prefer_hardware', 'software_only'], 'media.hardwareAcceleration'),
    automaticSoftwareFallback: literal(item.automaticSoftwareFallback, true, 'media.automaticSoftwareFallback'),
    generatePreviewProxy: boolean(item.generatePreviewProxy, 'media.generatePreviewProxy'),
    exportFromOriginal: literal(item.exportFromOriginal, true, 'media.exportFromOriginal'),
    cleanupExpiredProxies: boolean(item.cleanupExpiredProxies, 'media.cleanupExpiredProxies'),
    proxyDirectoryId: controlledIdOrNull(item.proxyDirectoryId, 'media.proxyDirectoryId')
  };
}

function parsePrivacy(value: unknown): PrivacySettings {
  const item = exactRecord(value, [
    'allowSelectedFiles', 'allowAuthorizedProjectDirectories',
    'allowWorkDownloadDirectories', 'externalDiskPolicy', 'scanHomeDirectory',
    'clipboardMode', 'textOutboundConfirmation', 'imageOutboundConfirmation',
    'videoOutboundConfirmation', 'projectContextOutboundConfirmation',
    'unknownCostConfirmation', 'readProjectContext', 'readSavedProjectChats',
    'readUnsavedChats', 'taskHistoryRetention', 'temporaryFileRetention',
    'worksRetention', 'sourceMediaRetention'
  ], 'privacy settings');
  return {
    allowSelectedFiles: literal(item.allowSelectedFiles, true, 'privacy.allowSelectedFiles'),
    allowAuthorizedProjectDirectories: literal(item.allowAuthorizedProjectDirectories, true, 'privacy.allowAuthorizedProjectDirectories'),
    allowWorkDownloadDirectories: literal(item.allowWorkDownloadDirectories, true, 'privacy.allowWorkDownloadDirectories'),
    externalDiskPolicy: oneOf(item.externalDiskPolicy, ['confirm_each_connection', 'allow_authorized'], 'privacy.externalDiskPolicy'),
    scanHomeDirectory: literal(item.scanHomeDirectory, false, 'privacy.scanHomeDirectory'),
    clipboardMode: literal(item.clipboardMode, 'user_initiated_only', 'privacy.clipboardMode'),
    textOutboundConfirmation: oneOf(item.textOutboundConfirmation, ['each_task', 'always'], 'privacy.textOutboundConfirmation'),
    imageOutboundConfirmation: oneOf(item.imageOutboundConfirmation, ['each_submission', 'always'], 'privacy.imageOutboundConfirmation'),
    videoOutboundConfirmation: oneOf(item.videoOutboundConfirmation, ['each_submission', 'always'], 'privacy.videoOutboundConfirmation'),
    projectContextOutboundConfirmation: literal(item.projectContextOutboundConfirmation, 'always', 'privacy.projectContextOutboundConfirmation'),
    unknownCostConfirmation: literal(item.unknownCostConfirmation, 'always', 'privacy.unknownCostConfirmation'),
    readProjectContext: boolean(item.readProjectContext, 'privacy.readProjectContext'),
    readSavedProjectChats: boolean(item.readSavedProjectChats, 'privacy.readSavedProjectChats'),
    readUnsavedChats: literal(item.readUnsavedChats, false, 'privacy.readUnsavedChats'),
    taskHistoryRetention: literal(item.taskHistoryRetention, 'user_configured', 'privacy.taskHistoryRetention'),
    temporaryFileRetention: literal(item.temporaryFileRetention, 'cleanup_rule', 'privacy.temporaryFileRetention'),
    worksRetention: literal(item.worksRetention, 'never_auto_cleanup', 'privacy.worksRetention'),
    sourceMediaRetention: literal(item.sourceMediaRetention, 'never_auto_cleanup', 'privacy.sourceMediaRetention')
  };
}

function parseNetwork(value: unknown): NetworkSettings {
  const item = exactRecord(value, [
    'proxy', 'connectionTimeoutMs', 'downloadTimeoutMs', 'retryMode',
    'continueDownloadsAfterRecovery', 'unknownRequestStatus'
  ], 'network settings');
  return {
    proxy: parseProxy(item.proxy),
    connectionTimeoutMs: integer(item.connectionTimeoutMs, 1_000, 300_000, 'network.connectionTimeoutMs'),
    downloadTimeoutMs: integer(item.downloadTimeoutMs, 1_000, 3_600_000, 'network.downloadTimeoutMs'),
    retryMode: literal(item.retryMode, 'request_only', 'network.retryMode'),
    continueDownloadsAfterRecovery: boolean(item.continueDownloadsAfterRecovery, 'network.continueDownloadsAfterRecovery'),
    unknownRequestStatus: literal(item.unknownRequestStatus, 'query_first', 'network.unknownRequestStatus')
  };
}

function parseProxy(value: unknown): ProxyMode {
  const item = record(value, 'network.proxy');
  const kind = oneOf(item.kind, ['system_default', 'system_proxy', 'custom', 'direct'], 'network.proxy.kind');
  if (kind !== 'custom') {
    exactKeys(item, ['kind'], 'network.proxy');
    return { kind };
  }
  exactKeys(item, ['kind', 'protocol', 'host', 'port', 'authenticationConfigured'], 'network.proxy');
  return {
    kind,
    protocol: oneOf(item.protocol, ['http', 'https', 'socks5'], 'network.proxy.protocol'),
    host: boundedString(item.host, 1, 253, 'network.proxy.host'),
    port: integer(item.port, 1, 65_535, 'network.proxy.port'),
    authenticationConfigured: boolean(item.authenticationConfigured, 'network.proxy.authenticationConfigured')
  };
}

function parseNotifications(value: unknown): NotificationSettings {
  const item = exactRecord(value, [
    'rules', 'mergeTaskCompletions', 'mergeFailures', 'keepUserActionVisible'
  ], 'notification settings');
  if (!Array.isArray(item.rules) || item.rules.length !== notificationEventKinds.length) {
    throw new TypeError('Notification rules are incomplete');
  }
  const seen = new Set<string>();
  const rules = item.rules.map((value) => {
    const rule = exactRecord(value, ['event', 'inApp', 'system', 'sound'], 'notification rule');
    const event = oneOf(rule.event, notificationEventKinds, 'notification.event');
    if (seen.has(event)) throw new TypeError('Notification rules contain duplicate events');
    seen.add(event);
    return {
      event,
      inApp: literal(rule.inApp, true, 'notification.inApp'),
      system: boolean(rule.system, 'notification.system'),
      sound: boolean(rule.sound, 'notification.sound')
    };
  });
  return {
    rules,
    mergeTaskCompletions: boolean(item.mergeTaskCompletions, 'notifications.mergeTaskCompletions'),
    mergeFailures: literal(item.mergeFailures, false, 'notifications.mergeFailures'),
    keepUserActionVisible: literal(item.keepUserActionVisible, true, 'notifications.keepUserActionVisible')
  };
}

function parseShortcuts(value: unknown): ShortcutSettings {
  const item = exactRecord(value, ['bindings'], 'shortcut settings');
  if (!Array.isArray(item.bindings)) throw new TypeError('Shortcut bindings must be an array');
  const seen = new Set<string>();
  const bindings = item.bindings.map((value) => {
    const binding = exactRecord(value, ['actionId', 'windows', 'macos'], 'shortcut binding');
    const actionId = boundedString(binding.actionId, 1, 100, 'shortcut.actionId');
    if (seen.has(actionId)) throw new TypeError('Shortcut action IDs must be unique');
    seen.add(actionId);
    return {
      actionId,
      windows: nullableBoundedString(binding.windows, 64, 'shortcut.windows'),
      macos: nullableBoundedString(binding.macos, 64, 'shortcut.macos')
    };
  });
  return { bindings };
}

function parseDiagnostics(value: unknown): DiagnosticSettings {
  const item = exactRecord(value, [
    'categories', 'level', 'retentionDays', 'maxFileBytes', 'autoCleanup', 'crashCollection'
  ], 'diagnostic settings');
  const categories = exactRecord(item.categories, [
    'application', 'tasks', 'media', 'networkErrors', 'connectionValidation', 'crashDiagnostics'
  ], 'diagnostic categories');
  return {
    categories: {
      application: boolean(categories.application, 'diagnostics.application'),
      tasks: boolean(categories.tasks, 'diagnostics.tasks'),
      media: boolean(categories.media, 'diagnostics.media'),
      networkErrors: boolean(categories.networkErrors, 'diagnostics.networkErrors'),
      connectionValidation: boolean(categories.connectionValidation, 'diagnostics.connectionValidation'),
      crashDiagnostics: boolean(categories.crashDiagnostics, 'diagnostics.crashDiagnostics')
    },
    level: oneOf(item.level, ['error', 'warn', 'info', 'debug'], 'diagnostics.level'),
    retentionDays: integer(item.retentionDays, 1, 90, 'diagnostics.retentionDays'),
    maxFileBytes: integer(item.maxFileBytes, 1_048_576, 104_857_600, 'diagnostics.maxFileBytes'),
    autoCleanup: boolean(item.autoCleanup, 'diagnostics.autoCleanup'),
    crashCollection: literal(item.crashCollection, 'only_on_crash', 'diagnostics.crashCollection')
  };
}

function parseUpdates(value: unknown): UpdateSettings {
  const item = exactRecord(value, [
    'automaticChecks', 'downloadMode', 'installMode', 'duringActiveTasks', 'channel'
  ], 'update settings');
  return {
    automaticChecks: boolean(item.automaticChecks, 'updates.automaticChecks'),
    downloadMode: literal(item.downloadMode, 'notify_only', 'updates.downloadMode'),
    installMode: literal(item.installMode, 'user_confirmed', 'updates.installMode'),
    duringActiveTasks: literal(item.duringActiveTasks, 'never', 'updates.duringActiveTasks'),
    channel: literal(item.channel, 'stable', 'updates.channel')
  };
}

function concurrencyValue(value: unknown, field: string): ConcurrencyIntent {
  return value === 'auto' ? value : integer(value, 1, 64, field);
}

function controlledIdOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  const id = boundedString(value, 1, 128, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new TypeError(`${field} must be an opaque controlled identifier`);
  }
  return id;
}

function nullableBoundedString(value: unknown, max: number, field: string): string | null {
  return value === null ? null : boundedString(value, 1, max, field);
}

function boundedString(value: unknown, min: number, max: number, field: string): string {
  const result = requireString(value, field).trim();
  if (result.length < min || result.length > max) {
    throw new TypeError(`${field} has an invalid length`);
  }
  return result;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function literal<T extends string | boolean>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new TypeError(`${field} must be ${String(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${field} has an unsupported value`);
  }
  return value as T[number];
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string
): Record<string, unknown> {
  const item = record(value, field);
  exactKeys(item, keys, field);
  return item;
}

function exactKeys(item: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(item);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`${field} contains missing or unknown fields`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function pickSettingsValues(value: object): Record<string, unknown> {
  const item = value as Record<string, unknown>;
  return Object.fromEntries(settingsCategories.map((category) => [category, item[category]]));
}
