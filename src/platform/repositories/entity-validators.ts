import {
  assetOrigins,
  creationKinds,
  draftStates,
  executionStates,
  fileStates,
  isImageWorkspaceDraft,
  mediaKinds,
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

export const isAssetEntity: EntityValidator = (value) =>
  isNonBlankString(value.fileId) &&
  isNonBlankString(value.name) &&
  isOneOf(value.mediaKind, mediaKinds) &&
  isOneOf(value.origin, assetOrigins) &&
  (value.role === undefined || typeof value.role === 'string') &&
  (value.imageMetadata === undefined || isImageAssetMetadata(value.imageMetadata)) &&
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
  isPromptSnapshot(value.submission.prompt) &&
  isStringArray(value.submission.assetIds) &&
  isCanonicalIsoTimestamp(value.submission.confirmedAt) &&
  isStringArray(value.executionIds) &&
  isCanonicalIsoTimestamp(value.createdAt);

export const isExecutionEntity: EntityValidator = (value) =>
  isNonBlankString(value.taskId) &&
  isPositiveInteger(value.attempt) &&
  isOneOf(value.state, executionStates) &&
  (value.failure === undefined || isExecutionFailure(value.failure)) &&
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
