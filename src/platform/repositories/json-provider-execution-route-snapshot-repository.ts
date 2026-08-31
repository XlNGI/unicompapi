import {
  parseProviderExecutionRouteSnapshot,
  type ProjectId,
  type ProviderExecutionRouteSnapshotId,
  type ProviderExecutionRouteSnapshotRepository,
  type ProviderExecutionRouteSnapshotV1
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

interface ProviderExecutionRouteSnapshotDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly snapshots: readonly ProviderExecutionRouteSnapshotV1[];
}

export class ProviderExecutionRouteSnapshotRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderExecutionRouteSnapshotRepositoryDataError';
  }
}

export class JsonProviderExecutionRouteSnapshotRepository
  implements ProviderExecutionRouteSnapshotRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId
  ) {}

  async get(
    id: ProviderExecutionRouteSnapshotId
  ): Promise<ProviderExecutionRouteSnapshotV1 | undefined> {
    return (await this.read()).snapshots.find((snapshot) => snapshot.id === id);
  }

  async list(): Promise<readonly ProviderExecutionRouteSnapshotV1[]> {
    return [...(await this.read()).snapshots].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
    );
  }

  async save(snapshot: ProviderExecutionRouteSnapshotV1): Promise<void> {
    const validated = parseProviderExecutionRouteSnapshot(snapshot);
    if (validated.projectId !== this.projectId) {
      throw new ProviderExecutionRouteSnapshotRepositoryDataError(
        'Provider execution route snapshot belongs to another project'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.providerExecutionRouteSnapshots,
      (current) => {
        const document = parseProviderExecutionRouteSnapshotDocument(
          current,
          this.projectId
        );
        const existing = document.snapshots.find((item) => item.id === validated.id);
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(validated)) return document;
          throw new ProviderExecutionRouteSnapshotRepositoryDataError(
            'Provider execution route snapshots are immutable'
          );
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          snapshots: [...document.snapshots, validated]
        } satisfies ProviderExecutionRouteSnapshotDocumentV1;
      },
      { backup: true }
    );
  }

  private async read(): Promise<ProviderExecutionRouteSnapshotDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.providerExecutionRouteSnapshots,
      (value) => parseProviderExecutionRouteSnapshotDocument(value, this.projectId)
    );
    return loaded?.value ?? emptyDocument();
  }
}

export function parseProviderExecutionRouteSnapshotDocument(
  value: unknown | undefined,
  projectId?: ProjectId
): ProviderExecutionRouteSnapshotDocumentV1 {
  if (value === undefined) return emptyDocument();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDocument();
  }
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'snapshots']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.snapshots)
  ) {
    throw invalidDocument();
  }
  const snapshots = item.snapshots.map(parseProviderExecutionRouteSnapshot);
  if (
    new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length ||
    (projectId !== undefined && snapshots.some((snapshot) => snapshot.projectId !== projectId))
  ) {
    throw invalidDocument();
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    snapshots
  };
}

function emptyDocument(): ProviderExecutionRouteSnapshotDocumentV1 {
  return { schemaVersion: 1, revision: 0, snapshots: [] };
}

function invalidDocument(): ProviderExecutionRouteSnapshotRepositoryDataError {
  return new ProviderExecutionRouteSnapshotRepositoryDataError(
    'Provider execution route snapshot document is invalid'
  );
}
