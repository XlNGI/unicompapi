import {
  createProviderOperationRecord,
  toExecutionId,
  toIsoTimestamp,
  toProviderOperationRecordId,
  toTaskId,
  type ExecutionId,
  type ProviderImmediateResultReference,
  type ProviderOperationRecord,
  type ProviderOperationRecordId,
  type ProviderOperationRepository,
  type ProviderSubmitOutcome,
  type TaskId
} from '../../domain';
import {
  projectStoragePaths,
  type ProjectStorageAdapter
} from '../storage';
import { RepositoryDataError } from './repository-data-error';

interface ProviderOperationDocumentV2 {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly records: readonly ProviderOperationRecord[];
}

interface ProviderOperationDocumentV1 {
  readonly schemaVersion: 1;
  readonly records: readonly Record<string, unknown>[];
}

export class JsonProviderOperationRepository
  implements ProviderOperationRepository {
  constructor(private readonly storage: ProjectStorageAdapter) {}

  async get(
    id: ProviderOperationRecordId
  ): Promise<ProviderOperationRecord | undefined> {
    return (await this.read()).records.find((record) => record.id === id);
  }

  async getByExecution(
    executionId: ExecutionId
  ): Promise<ProviderOperationRecord | undefined> {
    return (await this.read()).records.find(
      (record) => record.executionId === executionId
    );
  }

  async list(taskId?: TaskId): Promise<readonly ProviderOperationRecord[]> {
    const records = (await this.read()).records;
    return taskId
      ? records.filter((record) => record.taskId === taskId)
      : records;
  }

  async save(record: ProviderOperationRecord): Promise<void> {
    const validated = parseRecord(record);
    await this.storage.withExclusiveAccess(
      [projectStoragePaths.entities.providerOperations],
      async () => {
        const document = await this.read();
        const existing = document.records.find((item) => item.id === validated.id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(validated)) {
            throw new RepositoryDataError(
              projectStoragePaths.entities.providerOperations,
              'provider operation receipts are immutable'
            );
          }
          return;
        }
        if (
          document.records.some(
            (item) => item.executionId === validated.executionId
          )
        ) {
          throw new RepositoryDataError(
            projectStoragePaths.entities.providerOperations,
            'an execution already has a provider operation receipt'
          );
        }
        await this.storage.writeJsonAtomically<ProviderOperationDocumentV2>(
          projectStoragePaths.entities.providerOperations,
          {
            schemaVersion: 2,
            revision: document.revision + 1,
            records: [...document.records, validated]
          },
          { backup: true }
        );
      }
    );
  }

  private async read(): Promise<ProviderOperationDocumentV2> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.providerOperations,
      parseProviderOperationDocument
    );
    if (!loaded) return { schemaVersion: 2, revision: 0, records: [] };
    return loaded.value;
  }
}

function parseProviderOperationDocument(value: unknown): ProviderOperationDocumentV2 {
    const migrated = migrateProviderOperationDocument(value);
    if (
      !isRecord(migrated) ||
      migrated.schemaVersion !== 2 ||
      !Array.isArray(migrated.records)
    ) {
      throw invalidDocument();
    }
    const records = migrated.records.map(parseRecord);
    const ids = new Set<string>();
    const executionIds = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id) || executionIds.has(record.executionId)) {
        throw new RepositoryDataError(
          projectStoragePaths.entities.providerOperations,
          'provider operation document contains duplicate identities'
        );
      }
      ids.add(record.id);
      executionIds.add(record.executionId);
    }
    const revision = isRecord(migrated) && migrated.revision !== undefined
      ? Number(migrated.revision)
      : 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw invalidDocument();
    return { schemaVersion: 2, revision, records };
}

export function migrateProviderOperationDocument(value: unknown): unknown {
  if (!isRecord(value) || value.schemaVersion !== 1) return value;
  if (!Array.isArray(value.records)) throw invalidDocument();
  const legacy = value as unknown as ProviderOperationDocumentV1;
  return {
    schemaVersion: 2,
    revision: 0,
    records: legacy.records.map((record) => ({
      ...record,
      schemaVersion: 2,
      automaticRetryCount: 0
    }))
  };
}

function parseRecord(value: unknown): ProviderOperationRecord {
  if (!isRecord(value) || value.schemaVersion !== 2) throw invalidDocument();
  if (
    !['image', 'video'].includes(String(value.mediaKind)) ||
    !['synchronous_completed', 'asynchronous_polling', 'unknown'].includes(
      String(value.executionLifecycle)
    ) ||
    value.automaticRetryCount !== 0
  ) {
    throw invalidDocument();
  }
  try {
    return createProviderOperationRecord({
      id: toProviderOperationRecordId(String(value.id)),
      taskId: toTaskId(String(value.taskId)),
      executionId: toExecutionId(String(value.executionId)),
      mediaKind: value.mediaKind as ProviderOperationRecord['mediaKind'],
      executionLifecycle:
        value.executionLifecycle as ProviderOperationRecord['executionLifecycle'],
      outcome: parseOutcome(value.outcome),
      createdAt: toIsoTimestamp(String(value.createdAt)),
      updatedAt: toIsoTimestamp(String(value.updatedAt))
    });
  } catch {
    throw invalidDocument();
  }
}

function parseOutcome(value: unknown): ProviderSubmitOutcome {
  if (!isRecord(value) || typeof value.kind !== 'string') throw invalidDocument();
  if (value.kind === 'accepted_async') {
    if (!['queued', 'processing'].includes(String(value.state))) {
      throw invalidDocument();
    }
    return {
      kind: value.kind,
      providerOperationId: String(value.providerOperationId),
      state: value.state as 'queued' | 'processing'
    };
  }
  if (value.kind === 'completed_sync') {
    if (!Array.isArray(value.results)) throw invalidDocument();
    return {
      kind: value.kind,
      providerOperationId: String(value.providerOperationId),
      results: value.results.map(parseImmediateResult)
    };
  }
  if (value.kind === 'submission_outcome_unknown') {
    return {
      kind: value.kind,
      providerOperationId:
        value.providerOperationId === undefined
          ? undefined
          : String(value.providerOperationId),
      message: String(value.message)
    };
  }
  if (value.kind === 'failed_before_submission') {
    if (!['retryable', 'not_retryable', 'unknown'].includes(String(value.retryability))) {
      throw invalidDocument();
    }
    return {
      kind: value.kind,
      message: String(value.message),
      retryability: value.retryability as
        | 'retryable'
        | 'not_retryable'
        | 'unknown'
    };
  }
  throw invalidDocument();
}

function parseImmediateResult(value: unknown): ProviderImmediateResultReference {
  if (!isRecord(value) || !['remote_url', 'base64', 'file_uri'].includes(String(value.kind))) {
    throw invalidDocument();
  }
  if (value.kind === 'base64') {
    return {
      kind: value.kind,
      value: String(value.value),
      mimeType: String(value.mimeType)
    };
  }
  return {
    kind: value.kind as 'remote_url' | 'file_uri',
    value: String(value.value)
  };
}

function invalidDocument(): RepositoryDataError {
  return new RepositoryDataError(
    projectStoragePaths.entities.providerOperations,
    'provider operation document is invalid'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
