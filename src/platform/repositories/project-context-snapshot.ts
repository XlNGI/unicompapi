import { createHash } from 'node:crypto';
import {
  getProjectContextRevision,
  parsePinnedProjectContextSelection,
  parseProjectContextOutboundSnapshot,
  type PinnedProjectContextSelectionV1,
  type ProductFeatureSurface,
  type ProjectContextOutboundSnapshotV1,
  type ProjectContextV1,
  type ProjectId
} from '../../domain';

export class ProjectContextSnapshotError extends Error {
  constructor(
    readonly code:
      | 'context_not_found'
      | 'context_revision_not_found'
      | 'context_deleted'
      | 'context_hash_mismatch'
      | 'duplicate_context_selection'
      | 'quick_context_forbidden'
      | 'cross_project_context',
    message: string
  ) {
    super(message);
    this.name = 'ProjectContextSnapshotError';
  }
}

export function createProjectContextContentHash(contentSnapshot: string): string {
  return createHash('sha256').update(contentSnapshot, 'utf8').digest('hex');
}

export function pinProjectContextSelection(
  context: ProjectContextV1,
  revision: number,
  includeInPrompt: boolean
): PinnedProjectContextSelectionV1 {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ProjectContextSnapshotError(
      'context_revision_not_found',
      'Project context revision is invalid'
    );
  }
  if (context.status === 'deleted') {
    throw new ProjectContextSnapshotError(
      'context_deleted',
      'Deleted project context cannot be selected'
    );
  }
  const version = getProjectContextRevision(context, revision);
  if (!version || version.status === 'deleted') {
    throw new ProjectContextSnapshotError(
      'context_revision_not_found',
      'Project context revision is unavailable'
    );
  }
  return parsePinnedProjectContextSelection({
    schemaVersion: 1,
    contextId: context.id,
    contextRevision: version.revision,
    contentHash: createProjectContextContentHash(version.contentSnapshot),
    includeInPrompt
  });
}

export function freezeProjectContextOutboundSnapshots(input: {
  readonly projectId: ProjectId;
  readonly surface: ProductFeatureSurface;
  readonly contexts: readonly ProjectContextV1[];
  readonly selections: readonly PinnedProjectContextSelectionV1[];
}): readonly ProjectContextOutboundSnapshotV1[] {
  const selections = input.selections.map(parsePinnedProjectContextSelection);
  const ids = selections.map((selection) => selection.contextId);
  if (new Set(ids).size !== ids.length) {
    throw new ProjectContextSnapshotError(
      'duplicate_context_selection',
      'Project context selections must be unique'
    );
  }
  if (input.surface === 'quick' && selections.some((selection) => selection.includeInPrompt)) {
    throw new ProjectContextSnapshotError(
      'quick_context_forbidden',
      'Quick creation cannot consume project context'
    );
  }
  return selections.flatMap((selection) => {
    if (!selection.includeInPrompt) return [];
    const context = input.contexts.find((item) => item.id === selection.contextId);
    if (!context) {
      throw new ProjectContextSnapshotError(
        'context_not_found',
        'Selected project context is unavailable'
      );
    }
    if (context.projectId !== input.projectId) {
      throw new ProjectContextSnapshotError(
        'cross_project_context',
        'Selected project context belongs to another project'
      );
    }
    if (context.status === 'deleted') {
      throw new ProjectContextSnapshotError(
        'context_deleted',
        'Deleted project context must be selected again'
      );
    }
    const version = getProjectContextRevision(context, selection.contextRevision);
    if (!version || version.status === 'deleted') {
      throw new ProjectContextSnapshotError(
        'context_revision_not_found',
        'Selected project context revision is unavailable'
      );
    }
    const contentHash = createProjectContextContentHash(version.contentSnapshot);
    if (contentHash !== selection.contentHash) {
      throw new ProjectContextSnapshotError(
        'context_hash_mismatch',
        'Selected project context content has changed'
      );
    }
    return [parseProjectContextOutboundSnapshot({
      schemaVersion: 1,
      contextId: context.id,
      contextRevision: version.revision,
      contentHash,
      contentSnapshot: version.contentSnapshot
    })];
  });
}

export const freezeProjectContextOutboundSnapshot =
  freezeProjectContextOutboundSnapshots;
