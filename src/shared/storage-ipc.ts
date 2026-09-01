export const storageIpcChannels = {
  probeFile: 'storage:probe-file',
  verifyFile: 'storage:verify-file',
  relinkFile: 'storage:relink-file',
  restoreBackup: 'storage:restore-backup',
  rebuildIndex: 'storage:rebuild-index',
  openProject: 'storage:open-project',
  openRecentProject: 'storage:open-recent-project',
  createProject: 'storage:create-project',
  listProjects: 'storage:list-projects',
  getLocalStorageSummary: 'storage:get-local-storage-summary',
  localStorageChanged: 'storage:local-storage-changed',
  listTasks: 'storage:list-tasks',
  getTaskDetails: 'storage:get-task-details',
  getTaskTimeline: 'storage:get-task-timeline',
  listGenerationHistory: 'storage:list-generation-history',
  listCallRecords: 'storage:list-call-records',
  getCallDetails: 'storage:get-call-details',
  getConsumptionSummary: 'storage:get-consumption-summary',
  listWorks: 'storage:list-works',
  getWorkDetails: 'storage:get-work-details',
  createWorkMediaHandle: 'storage:create-work-media-handle',
  revealWorkFile: 'storage:reveal-work-file',
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
  | 'read_model_failed'
  | 'work_not_found'
  | 'media_unavailable'
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

export interface StorageLocalStorageSummaryDto {
  readonly projectUsage: {
    readonly totalBytes: number;
    readonly projectCount: number;
    readonly measuredProjectCount: number;
    readonly unavailableProjectCount: number;
    readonly truncated: boolean;
  };
  readonly currentProject?: {
    readonly projectId: string;
    readonly projectName: string;
    readonly diskFreeBytes: number | null;
  };
}

export interface StorageReadModelIssueDto {
  readonly projectId: string;
  readonly projectName: string;
  readonly reason: 'unavailable' | 'invalid_data';
}

export interface StorageTaskSummaryDto {
  readonly taskId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly executionCount: number;
  readonly latestExecutionState?: string;
  readonly latestExecutionUpdatedAt?: string;
  readonly retryability?: 'retryable' | 'not_retryable' | 'unknown';
}

export interface StorageTaskDetailsDto extends StorageTaskSummaryDto {
  readonly sourceDraftId: string;
  readonly originalInput: string;
  readonly finalPrompt: string;
  readonly canRecoverImageResult: boolean;
  readonly canRecoverVideoResult: boolean;
}

export interface StorageCallRecordFilterDto {
  readonly projectId?: string;
  readonly productFeature?: string;
  readonly providerId?: string;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly state?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface StorageCallRecordSummaryDto {
  readonly invocationAttemptId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly subjectKind: 'media' | 'conversation' | 'prompt_once';
  readonly productFeature: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly providerName?: string;
  readonly connectionName?: string;
  readonly modelName?: string;
  readonly displayNameAvailability: 'snapshotted' | 'unavailable';
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly durationMs?: string;
  readonly retryOfInvocationAttemptId?: string;
  readonly usageAvailability: string;
  readonly localResultCount: number;
  readonly resultRegistrationState: 'registered' | 'not_registered' | 'not_applicable';
  readonly billing?: StorageCallBillingDto;
}

export type StorageCallBillingState =
  | 'actual_bill'
  | 'estimated_station_price'
  | 'estimated_official_price'
  | 'pending_reconciliation'
  | 'unestimated'
  | 'failed_no_charge'
  | 'unknown_need_check'
  | 'refunded';

export interface StorageCallBillingDto {
  readonly state: StorageCallBillingState;
  readonly currencyCode: 'CNY';
  readonly amount?: string;
  readonly refundAmount?: string;
  readonly actualQuota?: string;
  readonly sourceLabel?: string;
  readonly reconciledAt?: string;
}

export interface StorageCallRecordListDto {
  readonly items: readonly StorageCallRecordSummaryDto[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly issues: readonly StorageReadModelIssueDto[];
}

export interface StorageTaskTimelineDto {
  readonly items: readonly StorageCallDetailsDto[];
  readonly issues: readonly StorageReadModelIssueDto[];
}

export type StorageGenerationHistoryItemDto =
  | {
      readonly kind: 'work';
      readonly workId: string;
      readonly projectId: string;
      readonly name: string;
      readonly mediaKind: 'image' | 'video';
      readonly sourceTaskId: string;
      readonly createdAt: string;
      readonly verifiedAt: string;
    }
  | {
      readonly kind: 'status';
      readonly taskId: string;
      readonly state: string;
      readonly createdAt: string;
      readonly occurredAt: string;
    };

export interface StorageGenerationHistoryPageDto {
  readonly items: readonly StorageGenerationHistoryItemDto[];
  readonly nextCursor?: string;
  readonly issues: readonly StorageReadModelIssueDto[];
}

export interface StorageConsumptionSummaryRequestDto {
  readonly calendarDays?: number;
}

export interface StorageConsumptionTimeBucketDto {
  readonly date: string;
  readonly amount: string;
  readonly callCount: number;
}

export interface StorageConsumptionProviderSliceDto {
  readonly key: string;
  readonly providerId?: string;
  readonly label: string;
  readonly amount: string;
  readonly callCount: number;
  readonly ratioBasisPoints: number;
  readonly isOther: boolean;
}

export interface StorageConsumptionPendingCurrencyDto {
  readonly currencyCode: string;
  readonly callCount: number;
}

export interface StorageConsumptionConversionSourceDto {
  readonly sourceCurrencyCode: string;
  readonly targetCurrencyCode: 'CNY';
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly sourceCheckedAt: string;
}

export interface StorageConsumptionSummaryDto {
  readonly currencyCode: 'CNY';
  readonly currencyLabel: '人民币';
  readonly period: {
    readonly startDate: string;
    readonly endDate: string;
    readonly calendarDays: number;
    readonly timeZone: 'Asia/Shanghai';
  };
  readonly totalAmount: string;
  readonly actualBillAmount: string;
  readonly estimatedAmount: string;
  readonly refundedAmount: string;
  readonly totalCallCount: number;
  readonly successfulCallCount: number;
  readonly pricedCallCount: number;
  readonly includedCallCount: number;
  readonly pendingConversionCallCount: number;
  readonly missingPricingRuleCount: number;
  readonly missingUsageCount: number;
  readonly invalidFeeCount: number;
  readonly pendingReconciliationCallCount: number;
  readonly unestimatedCallCount: number;
  readonly timeBuckets: readonly StorageConsumptionTimeBucketDto[];
  readonly providerSlices: readonly StorageConsumptionProviderSliceDto[];
  readonly pendingCurrencies: readonly StorageConsumptionPendingCurrencyDto[];
  readonly conversionSources: readonly StorageConsumptionConversionSourceDto[];
  readonly issues: readonly StorageReadModelIssueDto[];
  readonly disclaimer: 'provider_bill_preferred_with_estimate_fallback';
}

export type StorageCallSubjectDto =
  | {
      readonly kind: 'media';
      readonly taskId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: 'conversation';
      readonly conversationId: string;
      readonly userMessageId: string;
      readonly responseExecutionId: string;
    }
  | {
      readonly kind: 'prompt_once';
      readonly subjectId: string;
    };

export interface StorageCallTimelineEventDto {
  readonly sequence: number;
  readonly type: string;
  readonly safeCode?: string;
  readonly occurredAt: string;
}

export interface StorageCallUsageFactDto {
  readonly metricId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly source: string;
}

export interface StorageCallUsageDto {
  readonly availability: string;
  readonly facts: readonly StorageCallUsageFactDto[];
  readonly providerRequestId?: string;
  readonly calculatedAt: string;
}

export type StorageCallPricingStrategy =
  | 'credit'
  | 'provider_unit'
  | 'provider_billing'
  | 'token_split'
  | 'video_token'
  | 'image_count'
  | 'video_second';

export interface StorageCallPricingRateDto {
  readonly metricId: string;
  readonly amount: string;
  readonly unit: string;
  readonly scale?: string;
  readonly label?: string;
}

export interface StorageCallOfficialPricingRuleDto {
  readonly strategy: StorageCallPricingStrategy;
  readonly currencyCode: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly sourceCheckedAt: string;
  readonly rates: readonly StorageCallPricingRateDto[];
}

export interface StorageCallOfficialUnitPriceDto {
  readonly amount: string;
  readonly currencyCode: string;
  readonly creditUnit: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly sourceCheckedAt: string;
}

export interface StorageCallLocalResultDto {
  readonly mediaKind: 'image' | 'video' | 'text';
  readonly outputCount: number;
  readonly durationMs?: string;
  readonly width?: number;
  readonly height?: number;
  readonly byteLength?: string;
  /** Provider-returned image URL shown in call records (owner decision). */
  readonly resultImageUrl?: string;
  readonly validationState: 'pending' | 'valid' | 'invalid';
  readonly observedAt: string;
}

export interface StorageCallResultRegistrationDto {
  readonly state: 'registered' | 'not_registered' | 'not_applicable';
  readonly workIds: readonly string[];
}

export interface StorageCallDetailsDto extends StorageCallRecordSummaryDto {
  readonly subject: StorageCallSubjectDto;
  readonly timeline: readonly StorageCallTimelineEventDto[];
  readonly usage: StorageCallUsageDto;
  readonly officialPricingRule?: StorageCallOfficialPricingRuleDto;
  readonly officialUnitPrice?: StorageCallOfficialUnitPriceDto;
  readonly localResults: readonly StorageCallLocalResultDto[];
  readonly resultRegistration: StorageCallResultRegistrationDto;
}

export interface StorageWorkSummaryDto {
  readonly workId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly name: string;
  readonly mediaKind: string;
  readonly fileId: string;
  readonly fileState: string;
  readonly createdAt: string;
  readonly parentWorkId?: string;
}

export interface StorageWorkDetailsDto extends StorageWorkSummaryDto {
  readonly sourceTaskId: string;
  readonly sourceExecutionId: string;
  readonly sizeBytes?: number;
  readonly verifiedAt?: string;
}

export interface StorageLocalMediaHandleDto {
  readonly url: string;
  readonly expiresAt: string;
  readonly mediaKind: string;
}

export interface StorageReadModelListDto<TItem> {
  readonly items: readonly TItem[];
  readonly issues: readonly StorageReadModelIssueDto[];
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
  openRecentProject(
    projectId: string
  ): Promise<StorageIpcResult<StorageOpenProjectDto>>;
  createProject(
    name: string
  ): Promise<StorageIpcResult<StorageCreateProjectDto>>;
  listProjects(): Promise<StorageIpcResult<readonly StorageProjectSummaryDto[]>>;
  getLocalStorageSummary(): Promise<StorageIpcResult<StorageLocalStorageSummaryDto>>;
  onLocalStorageChanged(listener: () => void): () => void;
  listTasks(): Promise<
    StorageIpcResult<StorageReadModelListDto<StorageTaskSummaryDto>>
  >;
  getTaskDetails(
    taskId: string
  ): Promise<StorageIpcResult<StorageTaskDetailsDto | undefined>>;
  getTaskTimeline(
    projectId: string,
    taskId: string
  ): Promise<StorageIpcResult<StorageTaskTimelineDto>>;
  listGenerationHistory(request: {
    readonly projectId: string;
    readonly draftId: string;
    readonly mediaKind: 'image' | 'video';
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<StorageIpcResult<StorageGenerationHistoryPageDto>>;
  listCallRecords(
    filter?: StorageCallRecordFilterDto
  ): Promise<StorageIpcResult<StorageCallRecordListDto>>;
  getCallDetails(
    projectId: string,
    invocationAttemptId: string
  ): Promise<StorageIpcResult<StorageCallDetailsDto | undefined>>;
  getConsumptionSummary(
    request?: StorageConsumptionSummaryRequestDto
  ): Promise<StorageIpcResult<StorageConsumptionSummaryDto>>;
  listWorks(): Promise<
    StorageIpcResult<StorageReadModelListDto<StorageWorkSummaryDto>>
  >;
  getWorkDetails(
    workId: string
  ): Promise<StorageIpcResult<StorageWorkDetailsDto | undefined>>;
  createWorkMediaHandle(
    workId: string,
    projectId?: string
  ): Promise<StorageIpcResult<StorageLocalMediaHandleDto>>;
  revealWorkFile(
    workId: string
  ): Promise<StorageIpcResult<{ readonly revealed: true }>>;
  closeProject(): Promise<StorageIpcResult<{ readonly closed: true }>>;
  getProjectSession(): Promise<
    StorageIpcResult<StorageProjectSessionDto | undefined>
  >;
}
