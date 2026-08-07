import {
  assetOrigins,
  creationKinds,
  draftStates,
  executionStates,
  fileStates,
  isImageWorkspaceDraft,
  isVideoEditDraft,
  isVideoExportPlan,
  isVideoWorkspaceDraft,
  mediaKinds,
  imageWorkspaceModes,
  videoWorkspaceModes,
  providerAccessCategories,
  promptSupplementSources,
  toIsoTimestamp,
  type PromptSnapshot,
} from '../../domain';

export type EntityValidator = (
  value: Record<string, unknown>
) => boolean;

export const isDraftEntity: EntityValidator = (value) =>
  isOneOf(value.kind, creationKinds) &&
  isOneOf(value.state, draftStates) &&
  isPromptSnapshot(value.prompt) &&
  isStringArray(value.selectedAssetIds) &&
  isCanonicalIsoTimestamp(value.createdAt) &&
  isCanonicalIsoTimestamp(value.updatedAt);

export const isImageWorkspaceEntity: EntityValidator = (value) =>
  isImageWorkspaceDraft(value);

export const isVideoWorkspaceEntity: EntityValidator = (value) =>
  isVideoWorkspaceDraft(value);

export const isVideoEditDraftEntity: EntityValidator = (value) =>
  isVideoEditDraft(value);

export const isAssetEntity: EntityValidator = (value) =>
  isNonBlankString(value.fileId) &&
  isNonBlankString(value.name) &&
  isOneOf(value.mediaKind, mediaKinds) &&
  isOneOf(value.origin, assetOrigins) &&
  (value.role === undefined || typeof value.role === 'string') &&
  (value.imageMetadata === undefined ||
    (value.mediaKind === 'image' &&
      value.videoMetadata === undefined &&
      isImageAssetMetadata(value.imageMetadata))) &&
  (value.videoMetadata === undefined ||
    (value.mediaKind === 'video' &&
      value.imageMetadata === undefined &&
      isVideoAssetMetadata(value.videoMetadata))) &&
  isCanonicalIsoTimestamp(value.createdAt);

export const isFileReferenceEntity: EntityValidator = (value) =>
  (value.sourceExecutionId === undefined ||
    isNonBlankString(value.sourceExecutionId)) &&
  isFileLocator(value.locator) &&
  isOneOf(value.state, fileStates) &&
  (value.sizeBytes === undefined || isNonNegativeInteger(value.sizeBytes)) &&
  (value.checksumSha256 === undefined ||
    (typeof value.checksumSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.checksumSha256))) &&
  (value.lastVerification === undefined ||
    isFileVerificationSnapshot(value.lastVerification)) &&
  isCanonicalIsoTimestamp(value.createdAt) &&
  isCanonicalIsoTimestamp(value.updatedAt);

export const isTaskEntity: EntityValidator = (value) =>
  isNonBlankString(value.sourceDraftId) &&
  isRecord(value.submission) &&
  isOneOf(value.submission.kind, creationKinds) &&
  isCanonicalIsoTimestamp(value.submission.confirmedAt) &&
  (value.submission.kind === 'video_editing'
    ? isVideoEditingSubmission(value.submission)
    : isGenerationSubmission(value.submission)) &&
  isStringArray(value.executionIds) &&
  isCanonicalIsoTimestamp(value.createdAt);

export const isExecutionEntity: EntityValidator = (value) =>
  isNonBlankString(value.taskId) &&
  isPositiveInteger(value.attempt) &&
  isOneOf(value.state, executionStates) &&
  (value.failure === undefined || isExecutionFailure(value.failure)) &&
  (value.state === 'needs_user_action'
    ? isExecutionUserAction(value.userAction)
    : value.userAction === undefined) &&
  (value.remoteOperationId === undefined ||
    isNonBlankString(value.remoteOperationId)) &&
  (value.providerOperationRecordId === undefined ||
    isNonBlankString(value.providerOperationRecordId)) &&
  (value.submissionOutcome === undefined ||
    isOneOf(value.submissionOutcome, [
      'accepted_async',
      'completed_sync',
      'submission_outcome_unknown',
      'failed_before_submission'
    ] as const)) &&
  ((value.providerOperationRecordId === undefined &&
    value.submissionOutcome === undefined) ||
    (isNonBlankString(value.providerOperationRecordId) &&
      typeof value.submissionOutcome === 'string')) &&
  (value.exportPlanId === undefined || isNonBlankString(value.exportPlanId)) &&
  (value.outputFileId === undefined || isNonBlankString(value.outputFileId)) &&
  (value.workId === undefined || isNonBlankString(value.workId)) &&
  (value.cancelRequestedAt === undefined ||
    isCanonicalIsoTimestamp(value.cancelRequestedAt)) &&
  (value.progress === undefined || isExecutionProgress(value.progress)) &&
  isCanonicalIsoTimestamp(value.createdAt) &&
  isCanonicalIsoTimestamp(value.updatedAt);

export const isWorkEntity: EntityValidator = (value) =>
  isNonBlankString(value.sourceTaskId) &&
  isNonBlankString(value.sourceExecutionId) &&
  isNonBlankString(value.fileId) &&
  isOneOf(value.mediaKind, mediaKinds) &&
  isNonBlankString(value.name) &&
  (value.parentWorkId === undefined || isNonBlankString(value.parentWorkId)) &&
  isCanonicalIsoTimestamp(value.createdAt);

export const isVideoExportPlanEntity: EntityValidator = (value) =>
  isVideoExportPlan(value);

function isGenerationSubmission(value: Record<string, unknown>): boolean {
  return isPromptSnapshot(value.prompt) &&
    isStringArray(value.assetIds) &&
    (value.image === undefined || isImageSubmissionSnapshot(value.image)) &&
    (value.video === undefined ||
      (value.kind === 'video_generation' &&
        value.image === undefined &&
        isVideoSubmissionSnapshot(value.video) &&
        sameStringSet(
          value.assetIds,
          value.video.materials.map((material) => material.assetId)
        )));
}

function isVideoEditingSubmission(value: Record<string, unknown>): boolean {
  return value.prompt === undefined &&
    value.assetIds === undefined &&
    value.image === undefined &&
    value.video === undefined &&
    isRecord(value.videoEditing) &&
    isNonBlankString(value.videoEditing.exportPlanId) &&
    isNonNegativeInteger(value.videoEditing.draftRevision) &&
    isNonBlankString(value.videoEditing.title);
}

function isExecutionProgress(value: unknown): boolean {
  return isRecord(value) &&
    (value.processedUs === undefined || isNonNegativeInteger(value.processedUs)) &&
    (value.totalUs === undefined || isNonNegativeInteger(value.totalUs)) &&
    (value.percent === undefined ||
      (isNonNegativeInteger(value.percent) && value.percent <= 100));
}

function isPromptSnapshot(value: unknown): value is PromptSnapshot {
  return (
    isRecord(value) &&
    typeof value.originalInput === 'string' &&
    typeof value.finalPrompt === 'string' &&
    Array.isArray(value.systemSupplements) &&
    value.systemSupplements.every(
      (supplement) =>
        isRecord(supplement) &&
        typeof supplement.content === 'string' &&
        isOneOf(supplement.source, promptSupplementSources) &&
        (supplement.sourceReference === undefined ||
          typeof supplement.sourceReference === 'string')
    )
  );
}

function isFileLocator(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((value.kind === 'project' && isNonBlankString(value.relativePath)) ||
      (value.kind === 'external' && isNonBlankString(value.absolutePath)))
  );
}

function isImageAssetMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonBlankString(value.mimeType) &&
    isPositiveInteger(value.width) &&
    isPositiveInteger(value.height)
  );
}

function isVideoAssetMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonBlankString(value.mimeType) &&
    isNonBlankString(value.container) &&
    isPositiveInteger(value.durationMs) &&
    isPositiveInteger(value.width) &&
    isPositiveInteger(value.height)
  );
}

function isFileVerificationSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sizeBytes) &&
    typeof value.checksumSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.checksumSha256) &&
    (value.matchesExpected === undefined ||
      typeof value.matchesExpected === 'boolean') &&
    isCanonicalIsoTimestamp(value.verifiedAt)
  );
}

function isExecutionFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.stage, executionStates) &&
    typeof value.message === 'string' &&
    isOneOf(value.retryability, [
      'retryable',
      'not_retryable',
      'unknown'
    ] as const)
  );
}

function isExecutionUserAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.code, [
      'source_unavailable',
      'destination_unavailable'
    ] as const) &&
    isNonBlankString(value.message)
  );
}

function isImageSubmissionSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.mode, imageWorkspaceModes) &&
    isOneOf(value.purpose, [
      'image_generation',
      'reference_to_image',
      'image_understanding',
      'image_editing',
      'image_to_prompt'
    ] as const) &&
    isNonBlankString(value.modelId) &&
    isNonBlankString(value.capabilityEvidenceId) &&
    isNonBlankString(value.providerId) &&
    isNonBlankString(value.connectionId) &&
    isNonBlankString(value.recipientName) &&
    isOneOf(value.accessCategory, providerAccessCategories) &&
    isOneOf(value.outboundScope, [
      'local_device',
      'local_network',
      'external_service',
      'unknown'
    ] as const) &&
    value.costState === 'unknown' &&
    value.privacyState === 'unknown' &&
    value.regionState === 'unknown' &&
    isRecord(value.parameters) &&
    Object.values(value.parameters).every(isDynamicValue) &&
    (value.parentWorkId === undefined || isNonBlankString(value.parentWorkId)) &&
    isRecord(value.confirmations) &&
    value.confirmations.recipient === true &&
    value.confirmations.outboundScope === true &&
    value.confirmations.cost === true &&
    value.confirmations.finalPrompt === true &&
    value.confirmations.model === true
  );
}

function isVideoSubmissionSnapshot(value: unknown): value is {
  readonly materials: readonly { readonly assetId: string }[];
} {
  return (
    isRecord(value) &&
    isOneOf(value.mode, videoWorkspaceModes) &&
    value.purpose === 'video_generation' &&
    isNonBlankString(value.modelId) &&
    isNonBlankString(value.capabilityEvidenceId) &&
    isNonBlankString(value.providerId) &&
    isNonBlankString(value.connectionId) &&
    isNonBlankString(value.recipientName) &&
    isOneOf(value.accessCategory, providerAccessCategories) &&
    isOneOf(value.outboundScope, [
      'local_device',
      'local_network',
      'external_service',
      'unknown'
    ] as const) &&
    value.costState === 'unknown' &&
    value.privacyState === 'unknown' &&
    value.regionState === 'unknown' &&
    isRecord(value.parameters) &&
    Object.values(value.parameters).every(isDynamicValue) &&
    Array.isArray(value.materials) &&
    value.materials.every(isVideoSubmissionMaterial) &&
    Array.isArray(value.contextReferences) &&
    value.contextReferences.every(isVideoContextReference) &&
    isVideoSubmissionInput(value.input, value.mode) &&
    isRecord(value.confirmations) &&
    value.confirmations.recipient === true &&
    value.confirmations.outboundScope === true &&
    value.confirmations.materials === true &&
    value.confirmations.costPrivacyRegion === true &&
    value.confirmations.finalPrompt === true &&
    value.confirmations.model === true
  );
}

function isVideoSubmissionMaterial(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonBlankString(value.assetId) &&
    isOneOf(value.mediaKind, ['image', 'video'] as const) &&
    isNonBlankString(value.role) &&
    isRecord(value.target) &&
    (value.target.kind === 'quick_reference' ||
      value.target.kind === 'image_source' ||
      (value.target.kind === 'slot' && isNonBlankString(value.target.slotId)))
  );
}

function isVideoContextReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.kind, [
      'project_asset',
      'project_context',
      'saved_conversation'
    ] as const) &&
    isNonBlankString(value.referenceId)
  );
}

function isVideoSubmissionInput(value: unknown, mode: unknown): boolean {
  if (!isRecord(value) || value.mode !== mode) return false;
  if (mode === 'quick_video') return true;
  if (mode === 'text_to_video') {
    return (
      isOneOf(value.sourceKind, ['short_idea', 'long_form'] as const) &&
      Array.isArray(value.shots) &&
      value.shots.every(
        (shot) =>
          isRecord(shot) &&
          isNonBlankString(shot.id) &&
          isPositiveInteger(shot.order) &&
          typeof shot.description === 'string'
      )
    );
  }
  if (mode === 'image_to_video') {
    return (
      isStringArray(value.mustKeep) &&
      isStringArray(value.allowedChanges) &&
      isStringArray(value.prohibited) &&
      typeof value.subjectAction === 'string' &&
      typeof value.cameraMovement === 'string' &&
      typeof value.pace === 'string' &&
      typeof value.depthOfField === 'string'
    );
  }
  return false;
}

function sameStringSet(left: unknown, right: readonly string[]): boolean {
  const rightUnique = [...new Set(right)];
  return (
    isStringArray(left) &&
    new Set(left).size === left.length &&
    left.length === rightUnique.length &&
    left.every((value) => rightUnique.includes(value))
  );
}

function isDynamicValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isDynamicValue);
  return isRecord(value) && Object.values(value).every(isDynamicValue);
}

export function isCanonicalIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    toIsoTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonBlankString);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isOneOf<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[]
): value is TValue {
  return typeof value === 'string' && allowed.includes(value as TValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
