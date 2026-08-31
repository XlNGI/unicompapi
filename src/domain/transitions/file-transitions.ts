import {
  InvariantViolationError,
  InvalidStateTransitionError
} from '../errors';
import type {
  FileLocator,
  FileReference
} from '../entities/file-reference';
import type {
  ExecutionId,
  FileReferenceId,
  ProjectId
} from '../ids';
import type { FileState } from '../states/file-state';
import { assertTimestampNotBefore, type IsoTimestamp } from '../timestamps';
import {
  requireNonBlank,
  requireNonNegativeInteger,
  requireSha256
} from '../validation';

const allowedTransitions: Record<FileState, readonly FileState[]> = {
  pending: ['writing', 'verifying', 'missing', 'disconnected'],
  writing: ['verifying', 'missing', 'read_only', 'disconnected', 'corrupted'],
  verifying: ['available', 'missing', 'read_only', 'disconnected', 'corrupted'],
  available: ['missing', 'read_only', 'disconnected', 'corrupted'],
  missing: ['verifying', 'deleted'],
  read_only: ['verifying', 'missing', 'disconnected'],
  disconnected: ['verifying', 'missing'],
  corrupted: ['writing', 'deleted'],
  deleted: []
};

export interface CreateFileReferenceInput {
  readonly id: FileReferenceId;
  readonly projectId: ProjectId;
  readonly sourceExecutionId?: ExecutionId;
  readonly locator: FileLocator;
  readonly createdAt: IsoTimestamp;
  readonly sizeBytes?: number;
  readonly checksumSha256?: string;
}

export interface FileTransitionContext {
  readonly sizeBytes?: number;
  readonly checksumSha256?: string;
}

function validateLocator(locator: FileLocator): FileLocator {
  if (locator.kind === 'project') {
    return {
      kind: 'project',
      relativePath: requireNonBlank(
        locator.relativePath,
        'file.locator.relativePath'
      )
    };
  }

  return {
    kind: 'external',
    absolutePath: requireNonBlank(
      locator.absolutePath,
      'file.locator.absolutePath'
    )
  };
}

export function createFileReference(
  input: CreateFileReferenceInput
): FileReference {
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    sourceExecutionId: input.sourceExecutionId,
    locator: validateLocator(input.locator),
    state: 'pending',
    sizeBytes:
      input.sizeBytes === undefined
        ? undefined
        : requireNonNegativeInteger(input.sizeBytes, 'file.sizeBytes'),
    checksumSha256:
      input.checksumSha256 === undefined
        ? undefined
        : requireSha256(input.checksumSha256),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

export function canTransitionFile(from: FileState, to: FileState): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionFile(
  file: FileReference,
  nextState: FileState,
  updatedAt: IsoTimestamp,
  context: FileTransitionContext = {}
): FileReference {
  if (!canTransitionFile(file.state, nextState)) {
    throw new InvalidStateTransitionError('file', file.state, nextState);
  }

  assertTimestampNotBefore(updatedAt, file.updatedAt, 'file.updatedAt');

  if (nextState === 'available') {
    if (context.sizeBytes === undefined || !context.checksumSha256) {
      throw new InvariantViolationError(
        'available file requires byte size and SHA-256 checksum'
      );
    }

    return {
      ...file,
      state: nextState,
      sizeBytes: requireNonNegativeInteger(context.sizeBytes, 'file.sizeBytes'),
      checksumSha256: requireSha256(context.checksumSha256),
      updatedAt
    };
  }

  if (context.sizeBytes !== undefined || context.checksumSha256 !== undefined) {
    throw new InvariantViolationError(
      'file verification metadata can only be set when becoming available'
    );
  }

  return {
    ...file,
    state: nextState,
    updatedAt
  };
}
