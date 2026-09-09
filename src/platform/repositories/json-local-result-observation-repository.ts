import {
  parseLocalResultObservation,
  type LocalResultObservationId,
  type LocalResultObservationRepository,
  type LocalResultObservationV1,
  type ProviderInvocationAttemptId
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

interface LocalResultObservationDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly observations: readonly LocalResultObservationV1[];
}

export class LocalResultObservationRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LocalResultObservationRepositoryDataError';
  }
}

export class JsonLocalResultObservationRepository
  implements LocalResultObservationRepository {
  constructor(private readonly storage: ProjectStorageAdapter) {}

  async get(
    id: LocalResultObservationId
  ): Promise<LocalResultObservationV1 | undefined> {
    return (await this.read()).observations.find((item) => item.id === id);
  }

  async list(
    attemptId?: ProviderInvocationAttemptId
  ): Promise<readonly LocalResultObservationV1[]> {
    return (await this.read()).observations
      .filter((item) => attemptId === undefined || item.invocationAttemptId === attemptId)
      .sort((left, right) =>
        left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id)
      );
  }

  async append(observation: LocalResultObservationV1): Promise<void> {
    const validated = parseLocalResultObservation(observation);
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.localResultObservations,
      (current) => {
        const document = parseLocalResultObservationDocument(current);
        const existing = document.observations.find((item) => item.id === validated.id);
        if (existing) {
          if (sameJson(existing, validated)) return document;
          throw new LocalResultObservationRepositoryDataError(
            'Local result observation ID conflict'
          );
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          observations: [...document.observations, validated]
        } satisfies LocalResultObservationDocumentV1;
      },
      { backup: true }
    );
  }

  private async read(): Promise<LocalResultObservationDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.localResultObservations,
      parseLocalResultObservationDocument
    );
    return loaded?.value ?? emptyDocument();
  }
}

export function parseLocalResultObservationDocument(
  value: unknown | undefined
): LocalResultObservationDocumentV1 {
  if (value === undefined) return emptyDocument();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDocument();
  }
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'observations']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.observations)
  ) {
    throw invalidDocument();
  }
  const observations = item.observations.map(parseLocalResultObservation);
  if (new Set(observations.map((observation) => observation.id)).size !== observations.length) {
    throw invalidDocument();
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    observations
  };
}

function emptyDocument(): LocalResultObservationDocumentV1 {
  return { schemaVersion: 1, revision: 0, observations: [] };
}

function invalidDocument(): LocalResultObservationRepositoryDataError {
  return new LocalResultObservationRepositoryDataError(
    'Local result observation document is invalid'
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
