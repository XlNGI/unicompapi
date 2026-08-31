import {
  parseProviderInvocationAttempt,
  parseProviderInvocationEvent,
  projectProviderInvocationState,
  type ProjectId,
  type ProviderInvocationAttemptId,
  type ProviderInvocationAttemptV1,
  type ProviderInvocationEventId,
  type ProviderInvocationEventV1,
  type ProviderInvocationRepository
} from '../../domain';
import { projectStoragePaths, type ProjectStorageAdapter } from '../storage';

interface ProviderInvocationDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly attempts: readonly ProviderInvocationAttemptV1[];
  readonly events: readonly ProviderInvocationEventV1[];
}

export class ProviderInvocationRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderInvocationRepositoryDataError';
  }
}

export class JsonProviderInvocationRepository
  implements ProviderInvocationRepository {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    readonly projectId: ProjectId
  ) {}

  async get(
    id: ProviderInvocationAttemptId
  ): Promise<ProviderInvocationAttemptV1 | undefined> {
    return (await this.read()).attempts.find((attempt) => attempt.id === id);
  }

  async list(): Promise<readonly ProviderInvocationAttemptV1[]> {
    return (await this.readAll()).attempts;
  }

  async getEvent(
    id: ProviderInvocationEventId
  ): Promise<ProviderInvocationEventV1 | undefined> {
    return (await this.read()).events.find((event) => event.id === id);
  }

  async listEvents(
    attemptId?: ProviderInvocationAttemptId
  ): Promise<readonly ProviderInvocationEventV1[]> {
    return (await this.readAll()).events
      .filter((event) =>
        attemptId === undefined || event.invocationAttemptId === attemptId
      );
  }

  async readAll(): Promise<{
    readonly attempts: readonly ProviderInvocationAttemptV1[];
    readonly events: readonly ProviderInvocationEventV1[];
  }> {
    const document = await this.read();
    return {
      attempts: [...document.attempts].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
      ),
      events: [...document.events].sort((left, right) =>
        left.invocationAttemptId.localeCompare(right.invocationAttemptId) ||
        left.sequence - right.sequence
      )
    };
  }

  async create(
    attempt: ProviderInvocationAttemptV1,
    initialEvent: ProviderInvocationEventV1
  ): Promise<void> {
    const validatedAttempt = this.requireProjectAttempt(attempt);
    const validatedEvent = parseProviderInvocationEvent(initialEvent);
    if (
      validatedAttempt.state !== 'submitting' ||
      validatedEvent.invocationAttemptId !== validatedAttempt.id ||
      validatedEvent.sequence !== 1 ||
      validatedEvent.type !== 'submission_started' ||
      projectProviderInvocationState(validatedAttempt, [validatedEvent]) !== 'submitting'
    ) {
      throw new ProviderInvocationRepositoryDataError(
        'Provider invocation must be created with its submission_started event'
      );
    }
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.providerInvocations,
      (current) => {
        const document = parseProviderInvocationDocument(current, this.projectId);
        const existing = document.attempts.find((item) => item.id === validatedAttempt.id);
        if (existing) {
          if (
            sameJson(existing, validatedAttempt) &&
            document.events.some((event) => sameJson(event, validatedEvent))
          ) {
            return document;
          }
          throw new ProviderInvocationRepositoryDataError(
            'Provider invocation attempt identity already exists with different content'
          );
        }
        if (document.events.some((event) => event.id === validatedEvent.id)) {
          throw new ProviderInvocationRepositoryDataError(
            'Provider invocation event identity already exists'
          );
        }
        if (validatedAttempt.retryOfInvocationAttemptId) {
          const previous = document.attempts.find(
            (item) => item.id === validatedAttempt.retryOfInvocationAttemptId
          );
          if (
            !previous ||
            !isTerminal(previous.state) ||
            !sameJson(previous.subject, validatedAttempt.subject)
          ) {
            throw new ProviderInvocationRepositoryDataError(
              'Provider invocation retry must reference a terminal attempt with the same subject'
            );
          }
        }
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          attempts: [...document.attempts, validatedAttempt],
          events: [...document.events, validatedEvent]
        } satisfies ProviderInvocationDocumentV1;
      },
      { backup: true }
    );
  }

  async appendEvent(event: ProviderInvocationEventV1): Promise<void> {
    const validatedEvent = parseProviderInvocationEvent(event);
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.entities.providerInvocations,
      (current) => {
        const document = parseProviderInvocationDocument(current, this.projectId);
        const attemptIndex = document.attempts.findIndex(
          (attempt) => attempt.id === validatedEvent.invocationAttemptId
        );
        if (attemptIndex < 0) {
          throw new ProviderInvocationRepositoryDataError(
            'Provider invocation event references an unknown attempt'
          );
        }
        const attemptEvents = document.events
          .filter((item) => item.invocationAttemptId === validatedEvent.invocationAttemptId)
          .sort((left, right) => left.sequence - right.sequence);
        const duplicateId = document.events.find((item) => item.id === validatedEvent.id);
        if (duplicateId) {
          if (sameJson(duplicateId, validatedEvent)) return document;
          throw new ProviderInvocationRepositoryDataError(
            'Provider invocation event ID conflict'
          );
        }
        const duplicateSequence = attemptEvents.find(
          (item) => item.sequence === validatedEvent.sequence
        );
        if (duplicateSequence) {
          if (sameJson(duplicateSequence, validatedEvent)) return document;
          throw new ProviderInvocationRepositoryDataError(
            'Provider invocation event sequence conflict'
          );
        }
        if (validatedEvent.sequence !== attemptEvents.length + 1) {
          throw new ProviderInvocationRepositoryDataError(
            'Provider invocation event sequence must be contiguous'
          );
        }
        const attempt = document.attempts[attemptIndex];
        const state = projectProviderInvocationState(attempt, [
          ...attemptEvents,
          validatedEvent
        ]);
        const attempts = [...document.attempts];
        attempts[attemptIndex] = { ...attempt, state };
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          attempts,
          events: [...document.events, validatedEvent]
        } satisfies ProviderInvocationDocumentV1;
      },
      { backup: true }
    );
  }

  private async read(): Promise<ProviderInvocationDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.entities.providerInvocations,
      (value) => parseProviderInvocationDocument(value, this.projectId)
    );
    return loaded?.value ?? emptyDocument();
  }

  private requireProjectAttempt(
    attempt: ProviderInvocationAttemptV1
  ): ProviderInvocationAttemptV1 {
    const validated = parseProviderInvocationAttempt(attempt);
    if (validated.projectId !== this.projectId) {
      throw new ProviderInvocationRepositoryDataError(
        'Provider invocation attempt belongs to another project'
      );
    }
    return validated;
  }
}

export function parseProviderInvocationDocument(
  value: unknown | undefined,
  projectId?: ProjectId
): ProviderInvocationDocumentV1 {
  if (value === undefined) return emptyDocument();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDocument();
  }
  const item = value as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'revision', 'attempts', 'events']);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.attempts) ||
    !Array.isArray(item.events)
  ) {
    throw invalidDocument();
  }
  const attempts = item.attempts.map(parseProviderInvocationAttempt);
  const events = item.events.map(parseProviderInvocationEvent);
  if (
    new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length ||
    new Set(events.map((event) => event.id)).size !== events.length ||
    (projectId !== undefined && attempts.some((attempt) => attempt.projectId !== projectId))
  ) {
    throw invalidDocument();
  }
  for (const attempt of attempts) {
    const timeline = events.filter((event) => event.invocationAttemptId === attempt.id);
    if (projectProviderInvocationState(attempt, timeline) !== attempt.state) {
      throw invalidDocument();
    }
    if (attempt.retryOfInvocationAttemptId) {
      const previous = attempts.find(
        (item) => item.id === attempt.retryOfInvocationAttemptId
      );
      if (
        !previous ||
        !isTerminal(previous.state) ||
        !sameJson(previous.subject, attempt.subject)
      ) {
        throw invalidDocument();
      }
    }
  }
  if (events.some((event) => !attempts.some((attempt) => attempt.id === event.invocationAttemptId))) {
    throw invalidDocument();
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    attempts,
    events
  };
}

function emptyDocument(): ProviderInvocationDocumentV1 {
  return { schemaVersion: 1, revision: 0, attempts: [], events: [] };
}

function invalidDocument(): ProviderInvocationRepositoryDataError {
  return new ProviderInvocationRepositoryDataError(
    'Provider invocation document is invalid'
  );
}

function isTerminal(state: ProviderInvocationAttemptV1['state']): boolean {
  return [
    'failed_before_submission',
    'completed',
    'failed',
    'cancelled',
    'unknown_outcome'
  ].includes(state);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
