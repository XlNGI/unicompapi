import { toIsoTimestamp, type IsoTimestamp } from '../../domain';
import { JsonDocumentDataError } from './json-document';
import { projectStoragePaths } from './project-paths';
import type { ProjectStorageAdapter } from './storage-adapter';

export const submissionIntentStages = [
  'intent_recorded',
  'authorization_claimed',
  'request_started',
  'provider_accepted',
  'completed',
  'failed_before_request',
  'cancelled',
  'unknown_outcome'
] as const;
export type SubmissionIntentStage = (typeof submissionIntentStages)[number];

export interface SubmissionIntentJournalEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly stage: SubmissionIntentStage;
  readonly recordedAt: IsoTimestamp;
  readonly claimId?: string;
  readonly routeSnapshotId?: string;
  readonly providerOperationId?: string;
}

export interface SubmissionIntentJournalDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly events: readonly SubmissionIntentJournalEventV1[];
}

export type SubmissionRecoveryDecision =
  | {
      readonly action: 'discard_unsubmitted_intent';
      readonly intentId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly action: 'release_authorization_claim';
      readonly intentId: string;
      readonly idempotencyKey: string;
      readonly claimId: string;
    }
  | {
      readonly action: 'mark_unknown_outcome';
      readonly intentId: string;
      readonly idempotencyKey: string;
      readonly retryAllowed: false;
    }
  | {
      readonly action: 'resume_provider_operation';
      readonly intentId: string;
      readonly idempotencyKey: string;
      readonly claimId: string;
      readonly routeSnapshotId: string;
      readonly providerOperationId: string;
      readonly allowedActions: readonly ['query', 'cancel', 'receive_result'];
    };

export class SubmissionIntentJournal {
  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async load(): Promise<SubmissionIntentJournalDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.journals.submissionIntents,
      parseSubmissionIntentJournal
    );
    return loaded?.value ?? emptyJournal(this.now());
  }

  async append(event: SubmissionIntentJournalEventV1): Promise<void> {
    const validated = parseSubmissionIntentEvent(event);
    await this.storage.mutateJsonAtomically(
      projectStoragePaths.journals.submissionIntents,
      (current) => {
        const document = current === undefined
          ? emptyJournal(this.now())
          : parseSubmissionIntentJournal(current);
        const sameEvent = document.events.find((item) => item.eventId === validated.eventId);
        if (sameEvent) {
          if (stableJson(sameEvent) !== stableJson(validated)) {
            throw new JsonDocumentDataError('Submission journal event ID is not idempotent');
          }
          return document;
        }
        const intentEvents = document.events.filter(
          (item) => item.intentId === validated.intentId
        );
        validateTransition(intentEvents, validated);
        return {
          schemaVersion: 1,
          revision: document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          events: [...document.events, validated]
        } satisfies SubmissionIntentJournalDocumentV1;
      },
      { backup: true }
    );
  }

  async scanRecovery(): Promise<readonly SubmissionRecoveryDecision[]> {
    const journal = await this.load();
    const byIntent = new Map<string, SubmissionIntentJournalEventV1[]>();
    for (const event of journal.events) {
      const events = byIntent.get(event.intentId) ?? [];
      events.push(event);
      byIntent.set(event.intentId, events);
    }
    return [...byIntent.values()]
      .map(recoveryDecision)
      .filter((item): item is SubmissionRecoveryDecision => item !== undefined)
      .sort((left, right) => left.intentId.localeCompare(right.intentId));
  }
}

export function parseSubmissionIntentJournal(
  value: unknown
): SubmissionIntentJournalDocumentV1 {
  const item = exactRecord(
    value,
    ['schemaVersion', 'revision', 'updatedAt', 'events'],
    'submission journal'
  );
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Array.isArray(item.events)
  ) {
    throw new JsonDocumentDataError('Submission journal metadata is invalid');
  }
  const eventIds = new Set<string>();
  const events = item.events.map((event) => {
    const parsed = parseSubmissionIntentEvent(event);
    if (eventIds.has(parsed.eventId)) {
      throw new JsonDocumentDataError('Submission journal contains duplicate event IDs');
    }
    eventIds.add(parsed.eventId);
    return parsed;
  });
  const grouped = new Map<string, SubmissionIntentJournalEventV1[]>();
  for (const event of events) {
    const previous = grouped.get(event.intentId) ?? [];
    validateTransition(previous, event);
    previous.push(event);
    grouped.set(event.intentId, previous);
  }
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt: toIsoTimestamp(requireString(item.updatedAt, 'updatedAt')),
    events
  };
}

function parseSubmissionIntentEvent(value: unknown): SubmissionIntentJournalEventV1 {
  const item = record(value, 'submission journal event');
  const allowed = new Set([
    'schemaVersion',
    'eventId',
    'intentId',
    'idempotencyKey',
    'stage',
    'recordedAt',
    'claimId',
    'routeSnapshotId',
    'providerOperationId'
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key)) || item.schemaVersion !== 1) {
    throw new JsonDocumentDataError('Submission journal event fields are invalid');
  }
  const stage = item.stage;
  if (!submissionIntentStages.includes(stage as SubmissionIntentStage)) {
    throw new JsonDocumentDataError('Submission journal stage is invalid');
  }
  const parsed: SubmissionIntentJournalEventV1 = {
    schemaVersion: 1,
    eventId: opaqueId(item.eventId, 'eventId'),
    intentId: opaqueId(item.intentId, 'intentId'),
    idempotencyKey: opaqueId(item.idempotencyKey, 'idempotencyKey'),
    stage: stage as SubmissionIntentStage,
    recordedAt: toIsoTimestamp(requireString(item.recordedAt, 'recordedAt')),
    claimId: optionalId(item.claimId, 'claimId'),
    routeSnapshotId: optionalId(item.routeSnapshotId, 'routeSnapshotId'),
    providerOperationId: optionalId(item.providerOperationId, 'providerOperationId')
  };
  validateStageFields(parsed);
  return parsed;
}

function validateTransition(
  previous: readonly SubmissionIntentJournalEventV1[],
  next: SubmissionIntentJournalEventV1
): void {
  if (previous.length === 0) {
    if (next.stage !== 'intent_recorded') {
      throw new JsonDocumentDataError('Submission journal must start with intent_recorded');
    }
    return;
  }
  const latest = previous.at(-1)!;
  if (previous.some((event) => event.idempotencyKey !== next.idempotencyKey)) {
    throw new JsonDocumentDataError('Submission intent changed its idempotency key');
  }
  const transitions: Record<SubmissionIntentStage, readonly SubmissionIntentStage[]> = {
    intent_recorded: ['authorization_claimed', 'failed_before_request', 'cancelled'],
    authorization_claimed: ['request_started', 'failed_before_request', 'cancelled'],
    request_started: ['provider_accepted', 'failed_before_request', 'unknown_outcome'],
    provider_accepted: ['completed', 'cancelled', 'unknown_outcome'],
    completed: [],
    failed_before_request: [],
    cancelled: [],
    unknown_outcome: []
  };
  if (!transitions[latest.stage].includes(next.stage)) {
    throw new JsonDocumentDataError(
      `Submission journal transition ${latest.stage} -> ${next.stage} is invalid`
    );
  }
}

function validateStageFields(event: SubmissionIntentJournalEventV1): void {
  if (event.stage === 'intent_recorded' &&
      (event.claimId || event.routeSnapshotId || event.providerOperationId)) {
    throw new JsonDocumentDataError('Recorded intent cannot contain remote state');
  }
  if (['authorization_claimed', 'request_started', 'provider_accepted', 'completed']
    .includes(event.stage) && !event.claimId) {
    throw new JsonDocumentDataError(`${event.stage} requires a claim ID`);
  }
  if (['request_started', 'provider_accepted', 'completed'].includes(event.stage) &&
      !event.routeSnapshotId) {
    throw new JsonDocumentDataError(`${event.stage} requires a route snapshot ID`);
  }
  if (['provider_accepted', 'completed'].includes(event.stage) &&
      !event.providerOperationId) {
    throw new JsonDocumentDataError(`${event.stage} requires a provider operation ID`);
  }
}

function recoveryDecision(
  events: readonly SubmissionIntentJournalEventV1[]
): SubmissionRecoveryDecision | undefined {
  const latest = events.at(-1)!;
  const base = { intentId: latest.intentId, idempotencyKey: latest.idempotencyKey };
  if (latest.stage === 'intent_recorded') {
    return { ...base, action: 'discard_unsubmitted_intent' };
  }
  if (latest.stage === 'authorization_claimed') {
    return { ...base, action: 'release_authorization_claim', claimId: latest.claimId! };
  }
  if (latest.stage === 'request_started') {
    return { ...base, action: 'mark_unknown_outcome', retryAllowed: false };
  }
  if (latest.stage === 'provider_accepted') {
    return {
      ...base,
      action: 'resume_provider_operation',
      claimId: latest.claimId!,
      routeSnapshotId: latest.routeSnapshotId!,
      providerOperationId: latest.providerOperationId!,
      allowedActions: ['query', 'cancel', 'receive_result']
    };
  }
  return undefined;
}

function emptyJournal(now: string): SubmissionIntentJournalDocumentV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: toIsoTimestamp(now),
    events: []
  };
}

function exactRecord(value: unknown, keys: readonly string[], label: string) {
  const item = record(value, label);
  const allowed = new Set(keys);
  if (Object.keys(item).length !== allowed.size || Object.keys(item).some((key) => !allowed.has(key))) {
    throw new JsonDocumentDataError(`${label} contains unexpected or missing fields`);
  }
  return item;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonDocumentDataError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function opaqueId(value: unknown, label: string): string {
  const item = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(item)) {
    throw new JsonDocumentDataError(`${label} is invalid`);
  }
  return item;
}

function optionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : opaqueId(value, label);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new JsonDocumentDataError(`${label} is invalid`);
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}
