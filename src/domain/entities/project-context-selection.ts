import { InvariantViolationError } from '../errors';
import { toProjectContextId, type ProjectContextId } from '../ids';
import { requireSha256 } from '../validation';

export interface PinnedProjectContextSelectionV1 {
  readonly schemaVersion: 1;
  readonly contextId: ProjectContextId;
  readonly contextRevision: number;
  readonly contentHash: string;
  readonly includeInPrompt: boolean;
}

export interface ProjectContextOutboundSnapshotV1 {
  readonly schemaVersion: 1;
  readonly contextId: ProjectContextId;
  readonly contextRevision: number;
  readonly contentHash: string;
  readonly contentSnapshot: string;
}

export function parsePinnedProjectContextSelection(
  value: unknown
): PinnedProjectContextSelectionV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'contextId',
    'contextRevision',
    'contentHash',
    'includeInPrompt'
  ]);
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.contextRevision) ||
    Number(item.contextRevision) < 1 ||
    typeof item.includeInPrompt !== 'boolean'
  ) {
    throw new InvariantViolationError('pinned project context selection is invalid');
  }
  return {
    schemaVersion: 1,
    contextId: toProjectContextId(nonBlank(item.contextId, 'contextId')),
    contextRevision: Number(item.contextRevision),
    contentHash: requireSha256(String(item.contentHash)),
    includeInPrompt: item.includeInPrompt
  };
}

export function parseProjectContextOutboundSnapshot(
  value: unknown
): ProjectContextOutboundSnapshotV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'contextId',
    'contextRevision',
    'contentHash',
    'contentSnapshot'
  ]);
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.contextRevision) ||
    Number(item.contextRevision) < 1 ||
    typeof item.contentSnapshot !== 'string' ||
    item.contentSnapshot.trim().length === 0
  ) {
    throw new InvariantViolationError('project context outbound snapshot is invalid');
  }
  return {
    schemaVersion: 1,
    contextId: toProjectContextId(nonBlank(item.contextId, 'contextId')),
    contextRevision: Number(item.contextRevision),
    contentHash: requireSha256(String(item.contentHash)),
    contentSnapshot: item.contentSnapshot
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError('project context snapshot must be an object');
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(item).length !== allowed.size || Object.keys(item).some((key) => !allowed.has(key))) {
    throw new InvariantViolationError('project context snapshot contains unsupported fields');
  }
  return item;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${label} cannot be empty`);
  }
  return value.trim();
}
