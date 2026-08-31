import type { IsoTimestamp } from '../../domain';
import { toIsoTimestamp } from '../../domain';
import {
  assertSafeJsonValue,
  JsonDocumentDataError,
  JsonRevisionConflictError,
  type JsonValue
} from './json-document';
import { projectStoragePaths } from './project-paths';
import type { JsonStorageLoadResult, ProjectStorageAdapter } from './storage-adapter';

export interface ProjectMetadataEntryV1 {
  readonly key: string;
  readonly value: JsonValue;
}

export interface ProjectMetadataDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly entries: readonly ProjectMetadataEntryV1[];
}

export interface ProjectMetadataLoadResult {
  readonly document: ProjectMetadataDocumentV1;
  readonly source: 'primary' | 'backup' | 'default';
}

export class ProjectMetadataDraft {
  private readonly values: Map<string, JsonValue>;

  constructor(entries: readonly ProjectMetadataEntryV1[]) {
    this.values = new Map(entries.map((entry) => [entry.key, structuredClone(entry.value)]));
  }

  get(key: string): JsonValue | undefined {
    const value = this.values.get(requireMetadataKey(key));
    return value === undefined ? undefined : structuredClone(value);
  }

  set(key: string, value: JsonValue): void {
    const normalizedKey = requireMetadataKey(key);
    assertSafeJsonValue(value, `project metadata ${normalizedKey}`);
    this.values.set(normalizedKey, structuredClone(value));
  }

  delete(key: string): void {
    this.values.delete(requireMetadataKey(key));
  }

  entries(): readonly ProjectMetadataEntryV1[] {
    return [...this.values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}

export class ProjectMetadataUnitOfWork {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async load(): Promise<ProjectMetadataLoadResult> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.metadataUnit,
      parseProjectMetadataDocument
    );
    if (!loaded) {
      return { document: emptyDocument(this.now()), source: 'default' };
    }
    return toLoadResult(loaded);
  }

  async transact(
    expectedRevision: number,
    mutate: (draft: ProjectMetadataDraft) => void
  ): Promise<ProjectMetadataDocumentV1> {
    requireRevision(expectedRevision);
    return this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.metadataUnit,
      (current) => {
        const document = current === undefined
          ? emptyDocument(this.now())
          : parseProjectMetadataDocument(current);
        if (document.revision !== expectedRevision) {
          throw new JsonRevisionConflictError(expectedRevision, document.revision);
        }
        const draft = new ProjectMetadataDraft(document.entries);
        mutate(draft);
        return parseProjectMetadataDocument({
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          entries: draft.entries()
        });
      },
      { backup: true }
    );
  }
}

export function parseProjectMetadataDocument(value: unknown): ProjectMetadataDocumentV1 {
  const item = requireExactRecord(
    value,
    ['schemaVersion', 'revision', 'updatedAt', 'entries'],
    'project metadata document'
  );
  if (item.schemaVersion !== 1) {
    throw new JsonDocumentDataError('Project metadata schema version is unsupported');
  }
  requireRevision(item.revision);
  if (!Array.isArray(item.entries)) {
    throw new JsonDocumentDataError('Project metadata entries must be an array');
  }
  const keys = new Set<string>();
  const entries = item.entries.map((value) => {
    const entry = requireExactRecord(value, ['key', 'value'], 'project metadata entry');
    const key = requireMetadataKey(entry.key);
    if (keys.has(key)) {
      throw new JsonDocumentDataError(`Project metadata contains duplicate key ${key}`);
    }
    keys.add(key);
    assertSafeJsonValue(entry.value, `project metadata ${key}`);
    return { key, value: structuredClone(entry.value) };
  });
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt: toIsoTimestamp(requireString(item.updatedAt, 'updatedAt')),
    entries
  };
}

function emptyDocument(now: string): ProjectMetadataDocumentV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: toIsoTimestamp(now),
    entries: []
  };
}

function toLoadResult(
  loaded: JsonStorageLoadResult<ProjectMetadataDocumentV1>
): ProjectMetadataLoadResult {
  return { document: loaded.value, source: loaded.source };
}

function requireMetadataKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9_.:-]{0,127}$/.test(value)
  ) {
    throw new JsonDocumentDataError('Project metadata key is invalid');
  }
  return value;
}

function requireRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new JsonDocumentDataError('Project metadata revision is invalid');
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new JsonDocumentDataError(`${label} is invalid`);
  return value;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonDocumentDataError(`${label} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(item).length !== allowed.size || Object.keys(item).some((key) => !allowed.has(key))) {
    throw new JsonDocumentDataError(`${label} contains unexpected or missing fields`);
  }
  return item;
}
