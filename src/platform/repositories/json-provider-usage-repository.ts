import {
  parseProviderUsageObservation,
  parseUsageSchema,
  sameUsageSourceEvent,
  summarizeProviderUsage,
  validateUsageObservationAgainstSchema,
  type ProviderInvocationAttemptId,
  type ProviderUsageObservationId,
  type ProviderUsageObservationRepository,
  type ProviderUsageObservationV1,
  type ProviderUsageSummaryV1,
  type UsageSchemaV1
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

interface ProviderUsageObservationDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly observations: readonly ProviderUsageObservationV1[];
}

export class ProviderUsageRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderUsageRepositoryDataError';
  }
}

export class JsonProviderUsageObservationRepository
  implements ProviderUsageObservationRepository {
  constructor(private readonly storage: ProjectStorageAdapter) {}

  async get(
    id: ProviderUsageObservationId
  ): Promise<ProviderUsageObservationV1 | undefined> {
    return (await this.read()).observations.find((item) => item.id === id);
  }

  async list(
    attemptId?: ProviderInvocationAttemptId
  ): Promise<readonly ProviderUsageObservationV1[]> {
    return (await this.read()).observations
      .filter((item) => attemptId === undefined || item.invocationAttemptId === attemptId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void> {
    const validatedSchema = parseUsageSchema(schema);
    const validated = parseProviderUsageObservation(observation);
    validateUsageObservationAgainstSchema(validated, validatedSchema);
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.providerUsageObservations,
      (current) => {
        const document = parseProviderUsageObservationDocument(current);
        const attemptObservations = document.observations.filter(
          (item) => item.invocationAttemptId === validated.invocationAttemptId
        );
        const sourceEvent = attemptObservations.find(
          (item) => item.sourceEventKey === validated.sourceEventKey
        );
        if (sourceEvent) {
          if (sameUsageSourceEvent(sourceEvent, validated)) return document;
          const existingConflict = attemptObservations.find(
            (item) =>
              item.id === validated.id &&
              item.sourceEventKey === validated.sourceEventKey &&
              item.status === 'invalid_response' &&
              item.facts.length === 0
          );
          if (existingConflict) return document;
          const conflict = parseProviderUsageObservation({
            ...validated,
            sequence: sourceEvent.sequence,
            status: 'invalid_response',
            facts: []
          });
          return {
            schemaVersion: 1,
            revision: document.revision + 1,
            observations: [...document.observations, conflict]
          } satisfies ProviderUsageObservationDocumentV1;
        }
        const sameId = document.observations.find((item) => item.id === validated.id);
        if (sameId) {
          throw new ProviderUsageRepositoryDataError(
            'Provider usage observation ID conflict'
          );
        }
        const maxSequence = attemptObservations.reduce(
          (maximum, item) => Math.max(maximum, item.sequence),
          0
        );
        if (validated.sequence !== maxSequence + 1) {
          throw new ProviderUsageRepositoryDataError(
            'Provider usage observation sequence must be contiguous'
          );
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          observations: [...document.observations, validated]
        } satisfies ProviderUsageObservationDocumentV1;
      },
      { backup: true }
    );
  }

  async summarize(input: Parameters<ProviderUsageObservationRepository['summarize']>[0]): Promise<ProviderUsageSummaryV1> {
    return summarizeProviderUsage({
      invocationAttemptId: input.attemptId,
      schema: input.schema,
      observations: await this.list(input.attemptId),
      attemptState: input.attemptState,
      calculatedAt: input.calculatedAt,
      availabilityOverride: input.availabilityOverride
    });
  }

  private async read(): Promise<ProviderUsageObservationDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.providerUsageObservations,
      parseProviderUsageObservationDocument
    );
    return loaded?.value ?? emptyDocument();
  }
}

export function parseProviderUsageObservationDocument(
  value: unknown | undefined
): ProviderUsageObservationDocumentV1 {
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
  const observations = item.observations.map(parseProviderUsageObservation);
  if (new Set(observations.map((observation) => observation.id)).size !== observations.length) {
    throw invalidDocument();
  }
  const byAttempt = groupBy(
    observations,
    (observation) => observation.invocationAttemptId
  );
  for (const attemptObservations of byAttempt.values()) {
    const bySource = groupBy(
      attemptObservations,
      (observation) => observation.sourceEventKey
    );
    const uniqueSequences = new Set<number>();
    for (const sourceObservations of bySource.values()) {
      const sequence = sourceObservations[0].sequence;
      if (
        sourceObservations.some((item) => item.sequence !== sequence) ||
        sourceObservations.slice(1).some(
          (item) => item.status !== 'invalid_response' || item.facts.length !== 0
        )
      ) {
        throw invalidDocument();
      }
      uniqueSequences.add(sequence);
    }
    const ordered = [...uniqueSequences].sort((left, right) => left - right);
    if (ordered.some((sequence, index) => sequence !== index + 1)) {
      throw invalidDocument();
    }
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    observations
  };
}

function emptyDocument(): ProviderUsageObservationDocumentV1 {
  return { schemaVersion: 1, revision: 0, observations: [] };
}

function invalidDocument(): ProviderUsageRepositoryDataError {
  return new ProviderUsageRepositoryDataError(
    'Provider usage observation document is invalid'
  );
}

function groupBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}
