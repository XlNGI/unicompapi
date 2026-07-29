import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { toIsoTimestamp, type IsoTimestamp } from '../../../domain';
import {
  viduRuntimeErrorCodes,
  type ViduRuntimeErrorCode
} from './vidu-runtime-errors';

export const viduLiveValidationStatuses = [
  'active',
  'passed',
  'failed',
  'blocked'
] as const;

export type ViduLiveValidationStatus =
  (typeof viduLiveValidationStatuses)[number];

export const viduLiveValidationStages = [
  'readiness',
  'credits_validation',
  'image_submission',
  'image_local_result',
  'video_confirmation',
  'video_submission',
  'video_polling',
  'video_local_result',
  'flow'
] as const;

export type ViduLiveValidationStage =
  (typeof viduLiveValidationStages)[number];

export const viduLiveValidationEventStates = [
  'claimed',
  'progress',
  'succeeded',
  'failed',
  'blocked'
] as const;

export type ViduLiveValidationEventState =
  (typeof viduLiveValidationEventStates)[number];

export const viduLiveValidationBlockingReasons = [
  'credits_contract_unverified',
  'image_contract_unverified',
  'video_contract_unverified',
  'live_network_unapproved',
  'credential_use_unapproved',
  'image_billable_attempt_unapproved',
  'video_billable_attempt_unapproved',
  'video_user_confirmation_missing'
] as const;

export type ViduLiveValidationBlockingReason =
  (typeof viduLiveValidationBlockingReasons)[number];

export const viduLiveValidationErrorCodes = [
  ...viduRuntimeErrorCodes,
  'prerequisite_missing',
  'failed_before_submission',
  'submission_outcome_unknown',
  'remote_task_failed',
  'local_result_verification_failed',
  'local_state_failed'
] as const;

export type ViduLiveValidationErrorCode =
  | ViduRuntimeErrorCode
  | 'prerequisite_missing'
  | 'failed_before_submission'
  | 'submission_outcome_unknown'
  | 'remote_task_failed'
  | 'local_result_verification_failed'
  | 'local_state_failed';

export type ViduLiveValidationMediaKind = 'image' | 'video';

export const viduLiveValidationProviderStates = [
  'created',
  'queueing',
  'processing',
  'success',
  'failed',
  'cancelled'
] as const;

export type ViduLiveValidationProviderState =
  (typeof viduLiveValidationProviderStates)[number];

export const viduLiveValidationBillingFacts = [
  'not_attempted',
  'attempt_claimed',
  'accepted_or_completed',
  'failed_before_submission',
  'submission_outcome_unknown'
] as const;

export type ViduLiveValidationBillingFact =
  (typeof viduLiveValidationBillingFacts)[number];

export interface ViduLiveValidationReadiness {
  readonly officialFacts: {
    readonly creditsContractVerified: boolean;
    readonly imageContractVerified: boolean;
    readonly videoContractVerified: boolean;
  };
  readonly approval: {
    readonly liveNetworkApproved: boolean;
    readonly credentialUseApproved: boolean;
    readonly imageBillableAttemptApproved: boolean;
    readonly videoBillableAttemptApproved: boolean;
  };
}

export interface ViduLiveValidationBudgetEntry {
  readonly approval: 'approved' | 'not_approved';
  readonly claimState: 'available' | 'claimed' | 'not_available';
  readonly claimedAt: IsoTimestamp | null;
  readonly billingFact: ViduLiveValidationBillingFact;
}

export interface ViduLiveValidationLocalIds {
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly workId: string | null;
}

export interface ViduLiveValidationLocalEvidence {
  readonly mediaProbed: boolean | null;
  readonly sha256Verified: boolean | null;
  readonly atomicallyPublished: boolean | null;
  readonly indexed: boolean | null;
  readonly workRegistered: boolean | null;
}

export interface ViduLiveValidationEvent {
  readonly sequence: number;
  readonly stage: ViduLiveValidationStage;
  readonly state: ViduLiveValidationEventState;
  readonly recordedAt: IsoTimestamp;
  readonly elapsedMs: number | null;
  readonly httpStatus: number | null;
  readonly errorCode: ViduLiveValidationErrorCode | null;
  readonly providerState: ViduLiveValidationProviderState | null;
  readonly localIds: ViduLiveValidationLocalIds;
  readonly localEvidence: ViduLiveValidationLocalEvidence;
}

export interface ViduLiveValidationRecord {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly validationId: string;
  readonly status: ViduLiveValidationStatus;
  readonly startedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly stoppedAt: IsoTimestamp | null;
  readonly stopCode: ViduLiveValidationErrorCode | null;
  readonly readiness: ViduLiveValidationReadiness;
  readonly blockingReasons: readonly ViduLiveValidationBlockingReason[];
  readonly budget: {
    readonly image: ViduLiveValidationBudgetEntry;
    readonly video: ViduLiveValidationBudgetEntry;
  };
  readonly events: readonly ViduLiveValidationEvent[];
}

export interface ViduLiveValidationStore {
  load(): Promise<ViduLiveValidationRecord | undefined>;
  initialize(record: ViduLiveValidationRecord): Promise<ViduLiveValidationRecord>;
  update(
    operation: (
      current: ViduLiveValidationRecord
    ) => ViduLiveValidationRecord
  ): Promise<ViduLiveValidationRecord>;
}

export interface ViduLiveValidationStartInput {
  readonly validationId?: string;
  readonly readiness: ViduLiveValidationReadiness;
}

export interface ViduLiveValidationObservation {
  readonly outcome: 'succeeded' | 'failed';
  readonly elapsedMs?: number;
  readonly httpStatus?: number;
  readonly errorCode?: ViduLiveValidationErrorCode;
}

export interface ViduLiveValidationAttemptIdentity {
  readonly taskId: string;
  readonly executionId: string;
}

export interface ViduLiveValidationSubmissionObservation {
  readonly outcome:
    | 'accepted_or_completed'
    | 'failed_before_submission'
    | 'submission_outcome_unknown';
  readonly elapsedMs?: number;
  readonly httpStatus?: number;
  readonly errorCode?: ViduLiveValidationErrorCode;
}

export interface ViduLiveValidationResultEvidence {
  readonly taskId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly mediaProbed: boolean;
  readonly sha256Verified: boolean;
  readonly atomicallyPublished: boolean;
  readonly indexed: boolean;
  readonly workRegistered: boolean;
  readonly elapsedMs?: number;
}

export interface ViduLiveValidationVideoConfirmation {
  readonly sourceImageWorkId: string;
  readonly outboundScopeConfirmed: boolean;
  readonly costConfirmed: boolean;
}

export interface ViduLiveValidationPollingObservation {
  readonly providerState: ViduLiveValidationProviderState;
  readonly elapsedMs?: number;
  readonly httpStatus?: number;
  readonly errorCode?: ViduLiveValidationErrorCode;
}

export interface ViduLiveValidationFailure {
  readonly stage: ViduLiveValidationStage;
  readonly errorCode: ViduLiveValidationErrorCode;
  readonly elapsedMs?: number;
  readonly httpStatus?: number;
}

export class ViduLiveValidationDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ViduLiveValidationDataError';
  }
}

export class ViduLiveValidationStateError extends Error {
  constructor(
    readonly code:
      | 'already_initialized'
      | 'not_initialized'
      | 'flow_stopped'
      | 'invalid_transition'
      | 'budget_exhausted',
    message: string
  ) {
    super(message);
    this.name = 'ViduLiveValidationStateError';
  }
}

const storeQueues = new Map<string, Promise<void>>();

export class JsonViduLiveValidationStore
  implements ViduLiveValidationStore {
  private readonly recordPath: string;

  constructor(recordPath: string) {
    if (recordPath.trim().length === 0) {
      throw new TypeError('Vidu live validation record path cannot be empty');
    }
    this.recordPath = path.resolve(recordPath);
  }

  async load(): Promise<ViduLiveValidationRecord | undefined> {
    await (storeQueues.get(this.recordPath) ?? Promise.resolve());
    return this.readCurrent();
  }

  async initialize(
    record: ViduLiveValidationRecord
  ): Promise<ViduLiveValidationRecord> {
    return this.enqueue(async () => {
      if ((await this.readCurrent()) !== undefined) {
        throw new ViduLiveValidationStateError(
          'already_initialized',
          'The Vidu live validation record already exists'
        );
      }
      const validated = parseViduLiveValidationRecord(record);
      if (validated.revision !== 0) {
        throw new ViduLiveValidationDataError(
          'A new Vidu live validation record must have revision 0'
        );
      }
      await this.write(validated);
      return validated;
    });
  }

  async update(
    operation: (
      current: ViduLiveValidationRecord
    ) => ViduLiveValidationRecord
  ): Promise<ViduLiveValidationRecord> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (!current) {
        throw new ViduLiveValidationStateError(
          'not_initialized',
          'The Vidu live validation record does not exist'
        );
      }
      const next = parseViduLiveValidationRecord(operation(current));
      if (
        next.validationId !== current.validationId ||
        next.startedAt !== current.startedAt ||
        next.revision !== current.revision + 1
      ) {
        throw new ViduLiveValidationDataError(
          'The Vidu live validation record update is invalid'
        );
      }
      await this.write(next);
      return next;
    });
  }

  private async readCurrent(): Promise<ViduLiveValidationRecord | undefined> {
    try {
      return parseViduLiveValidationRecord(
        JSON.parse(await readFile(this.recordPath, 'utf8'))
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      if (error instanceof ViduLiveValidationDataError) throw error;
      throw new ViduLiveValidationDataError(
        'The Vidu live validation record could not be read',
        error
      );
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storeQueues.get(this.recordPath) ?? Promise.resolve();
    let result: T | undefined;
    const current = previous.then(async () => {
      result = await operation();
    });
    storeQueues.set(this.recordPath, current.catch(() => undefined));
    await current;
    if (result === undefined) {
      throw new ViduLiveValidationDataError(
        'The Vidu live validation store operation produced no result'
      );
    }
    return result;
  }

  private async write(record: ViduLiveValidationRecord): Promise<void> {
    const parent = path.dirname(this.recordPath);
    const temporary = path.join(
      parent,
      `.${path.basename(this.recordPath)}.${randomUUID()}.tmp`
    );
    await mkdir(parent, { recursive: true });
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.recordPath);
      await syncDirectoryBestEffort(parent);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class ViduLiveValidationCoordinator {
  constructor(
    private readonly store: ViduLiveValidationStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createValidationId: () => string = () =>
      `vidu-live-${randomUUID()}`
  ) {}

  load(): Promise<ViduLiveValidationRecord | undefined> {
    return this.store.load();
  }

  async start(
    input: ViduLiveValidationStartInput
  ): Promise<ViduLiveValidationRecord> {
    assertAllowedKeys(input, ['validationId', 'readiness'], 'start input');
    const readiness = parseReadiness(input.readiness);
    const validationId = parseLocalId(
      input.validationId ?? this.createValidationId(),
      'validationId'
    );
    const timestamp = this.timestamp();
    const blockingReasons = findBlockingReasons(readiness);
    const blocked = blockingReasons.length > 0;
    const record: ViduLiveValidationRecord = {
      schemaVersion: 1,
      revision: 0,
      validationId,
      status: blocked ? 'blocked' : 'active',
      startedAt: timestamp,
      updatedAt: timestamp,
      stoppedAt: blocked ? timestamp : null,
      stopCode: blocked ? 'prerequisite_missing' : null,
      readiness,
      blockingReasons,
      budget: {
        image: createBudgetEntry(
          readiness.approval.imageBillableAttemptApproved
        ),
        video: createBudgetEntry(
          readiness.approval.videoBillableAttemptApproved
        )
      },
      events: [createEvent({
        sequence: 1,
        stage: 'readiness',
        state: blocked ? 'blocked' : 'succeeded',
        recordedAt: timestamp,
        errorCode: blocked ? 'prerequisite_missing' : null
      })]
    };
    return this.store.initialize(record);
  }

  async recordCreditsValidation(
    input: ViduLiveValidationObservation
  ): Promise<ViduLiveValidationRecord> {
    const observation = parseObservation(input);
    return this.updateActive((current, timestamp) => {
      requireNoEvent(current, 'credits_validation');
      const succeeded = observation.outcome === 'succeeded';
      return appendEvent(
        current,
        createEvent({
          sequence: current.events.length + 1,
          stage: 'credits_validation',
          state: succeeded ? 'succeeded' : 'failed',
          recordedAt: timestamp,
          elapsedMs: observation.elapsedMs,
          httpStatus: observation.httpStatus,
          errorCode: observation.errorCode
        }),
        timestamp,
        succeeded ? undefined : {
          status: 'failed',
          stopCode: observation.errorCode
        }
      );
    });
  }

  async claimBillableAttempt(
    mediaKind: ViduLiveValidationMediaKind,
    input: ViduLiveValidationAttemptIdentity
  ): Promise<ViduLiveValidationRecord> {
    const kind = parseMediaKind(mediaKind);
    const identity = parseAttemptIdentity(input);
    return this.updateActive((current, timestamp) => {
      const entry = current.budget[kind];
      if (entry.claimState !== 'available') {
        throw new ViduLiveValidationStateError(
          'budget_exhausted',
          `The ${kind} Vidu live validation attempt is not available`
        );
      }
      assertClaimPrerequisites(current, kind);
      const stage = submissionStage(kind);
      const nextBudget = {
        ...current.budget,
        [kind]: {
          ...entry,
          claimState: 'claimed' as const,
          claimedAt: timestamp,
          billingFact: 'attempt_claimed' as const
        }
      };
      return appendEvent(
        { ...current, budget: nextBudget },
        createEvent({
          sequence: current.events.length + 1,
          stage,
          state: 'claimed',
          recordedAt: timestamp,
          localIds: {
            taskId: identity.taskId,
            executionId: identity.executionId,
            workId: null
          }
        }),
        timestamp
      );
    });
  }

  async recordSubmission(
    mediaKind: ViduLiveValidationMediaKind,
    input: ViduLiveValidationSubmissionObservation
  ): Promise<ViduLiveValidationRecord> {
    const kind = parseMediaKind(mediaKind);
    const observation = parseSubmissionObservation(input);
    return this.updateActive((current, timestamp) => {
      const stage = submissionStage(kind);
      const claim = requireClaimEvent(current, stage);
      requireNoTerminalStageEvent(current, stage);
      if (current.budget[kind].claimState !== 'claimed') {
        throw invalidTransition('A billable attempt must be claimed first');
      }
      const succeeded = observation.outcome === 'accepted_or_completed';
      const errorCode = succeeded
        ? null
        : observation.outcome === 'submission_outcome_unknown'
          ? 'submission_outcome_unknown'
          : observation.errorCode ?? 'failed_before_submission';
      const nextBudget = {
        ...current.budget,
        [kind]: {
          ...current.budget[kind],
          billingFact: observation.outcome
        }
      };
      return appendEvent(
        { ...current, budget: nextBudget },
        createEvent({
          sequence: current.events.length + 1,
          stage,
          state: succeeded ? 'succeeded' : 'failed',
          recordedAt: timestamp,
          elapsedMs: observation.elapsedMs,
          httpStatus: observation.httpStatus,
          errorCode,
          localIds: claim.localIds
        }),
        timestamp,
        succeeded ? undefined : { status: 'failed', stopCode: errorCode }
      );
    });
  }

  async recordLocalResult(
    mediaKind: ViduLiveValidationMediaKind,
    input: ViduLiveValidationResultEvidence
  ): Promise<ViduLiveValidationRecord> {
    const kind = parseMediaKind(mediaKind);
    const evidence = parseResultEvidence(input);
    return this.updateActive((current, timestamp) => {
      const submission = requireSuccessfulEvent(
        current,
        submissionStage(kind)
      );
      requireNoEvent(current, localResultStage(kind));
      if (
        submission.localIds.taskId !== evidence.taskId ||
        submission.localIds.executionId !== evidence.executionId
      ) {
        throw invalidTransition(
          'Local result evidence does not match the claimed attempt'
        );
      }
      const verified =
        evidence.mediaProbed &&
        evidence.sha256Verified &&
        evidence.atomicallyPublished &&
        evidence.indexed &&
        evidence.workRegistered;
      return appendEvent(
        current,
        createEvent({
          sequence: current.events.length + 1,
          stage: localResultStage(kind),
          state: verified ? 'succeeded' : 'failed',
          recordedAt: timestamp,
          elapsedMs: evidence.elapsedMs,
          errorCode: verified ? null : 'local_result_verification_failed',
          localIds: {
            taskId: evidence.taskId,
            executionId: evidence.executionId,
            workId: evidence.workId
          },
          localEvidence: {
            mediaProbed: evidence.mediaProbed,
            sha256Verified: evidence.sha256Verified,
            atomicallyPublished: evidence.atomicallyPublished,
            indexed: evidence.indexed,
            workRegistered: evidence.workRegistered
          }
        }),
        timestamp,
        verified
          ? kind === 'video'
            ? { status: 'passed', stopCode: null }
            : undefined
          : {
              status: 'failed',
              stopCode: 'local_result_verification_failed'
            }
      );
    });
  }

  async confirmVideo(
    input: ViduLiveValidationVideoConfirmation
  ): Promise<ViduLiveValidationRecord> {
    const confirmation = parseVideoConfirmation(input);
    return this.updateActive((current, timestamp) => {
      const imageResult = requireSuccessfulEvent(
        current,
        'image_local_result'
      );
      requireNoEvent(current, 'video_confirmation');
      if (imageResult.localIds.workId !== confirmation.sourceImageWorkId) {
        throw invalidTransition(
          'Video confirmation must reference this validation image Work'
        );
      }
      const confirmed =
        confirmation.outboundScopeConfirmed && confirmation.costConfirmed;
      const blockingReasons = confirmed
        ? current.blockingReasons
        : uniqueReasons([
            ...current.blockingReasons,
            'video_user_confirmation_missing'
          ]);
      return appendEvent(
        { ...current, blockingReasons },
        createEvent({
          sequence: current.events.length + 1,
          stage: 'video_confirmation',
          state: confirmed ? 'succeeded' : 'blocked',
          recordedAt: timestamp,
          errorCode: confirmed ? null : 'prerequisite_missing',
          localIds: imageResult.localIds
        }),
        timestamp,
        confirmed
          ? undefined
          : { status: 'blocked', stopCode: 'prerequisite_missing' }
      );
    });
  }

  async recordVideoPolling(
    input: ViduLiveValidationPollingObservation
  ): Promise<ViduLiveValidationRecord> {
    const observation = parsePollingObservation(input);
    return this.updateActive((current, timestamp) => {
      const submission = requireSuccessfulEvent(current, 'video_submission');
      const failed = observation.providerState === 'failed';
      const cancelled = observation.providerState === 'cancelled';
      const succeeded = observation.providerState === 'success';
      const errorCode = failed
        ? observation.errorCode ?? 'remote_task_failed'
        : cancelled
          ? observation.errorCode ?? 'cancelled'
          : null;
      return appendEvent(
        current,
        createEvent({
          sequence: current.events.length + 1,
          stage: 'video_polling',
          state: failed || cancelled
            ? 'failed'
            : succeeded
              ? 'succeeded'
              : 'progress',
          recordedAt: timestamp,
          elapsedMs: observation.elapsedMs,
          httpStatus: observation.httpStatus,
          errorCode,
          providerState: observation.providerState,
          localIds: submission.localIds
        }),
        timestamp,
        failed || cancelled
          ? { status: 'failed', stopCode: errorCode }
          : undefined
      );
    });
  }

  async stopFailed(
    input: ViduLiveValidationFailure
  ): Promise<ViduLiveValidationRecord> {
    const failure = parseFailure(input);
    return this.updateActive((current, timestamp) =>
      appendEvent(
        current,
        createEvent({
          sequence: current.events.length + 1,
          stage: failure.stage,
          state: 'failed',
          recordedAt: timestamp,
          elapsedMs: failure.elapsedMs,
          httpStatus: failure.httpStatus,
          errorCode: failure.errorCode
        }),
        timestamp,
        { status: 'failed', stopCode: failure.errorCode }
      )
    );
  }

  async stopBlocked(
    reason: ViduLiveValidationBlockingReason,
    stage: ViduLiveValidationStage = 'flow'
  ): Promise<ViduLiveValidationRecord> {
    const parsedReason = requireOneOf(
      reason,
      viduLiveValidationBlockingReasons,
      'blocking reason'
    );
    const parsedStage = requireOneOf(
      stage,
      viduLiveValidationStages,
      'validation stage'
    );
    return this.updateActive((current, timestamp) =>
      appendEvent(
        {
          ...current,
          blockingReasons: uniqueReasons([
            ...current.blockingReasons,
            parsedReason
          ])
        },
        createEvent({
          sequence: current.events.length + 1,
          stage: parsedStage,
          state: 'blocked',
          recordedAt: timestamp,
          errorCode: 'prerequisite_missing'
        }),
        timestamp,
        { status: 'blocked', stopCode: 'prerequisite_missing' }
      )
    );
  }

  private async updateActive(
    update: (
      current: ViduLiveValidationRecord,
      timestamp: IsoTimestamp
    ) => ViduLiveValidationRecord
  ): Promise<ViduLiveValidationRecord> {
    return this.store.update((current) => {
      if (current.status !== 'active') {
        throw new ViduLiveValidationStateError(
          'flow_stopped',
          'The Vidu live validation flow has already stopped'
        );
      }
      return update(current, this.timestamp());
    });
  }

  private timestamp(): IsoTimestamp {
    return toIsoTimestamp(this.now());
  }
}

export function parseViduLiveValidationRecord(
  value: unknown
): ViduLiveValidationRecord {
  const record = requireRecord(value, 'validation record');
  requireExactKeys(record, [
    'schemaVersion',
    'revision',
    'validationId',
    'status',
    'startedAt',
    'updatedAt',
    'stoppedAt',
    'stopCode',
    'readiness',
    'blockingReasons',
    'budget',
    'events'
  ], 'validation record');
  if (record.schemaVersion !== 1) {
    throw invalidData('The Vidu live validation schema version is unsupported');
  }
  const revision = requireNonNegativeInteger(record.revision, 'revision');
  const validationId = parseLocalId(record.validationId, 'validationId');
  const status = requireOneOf(
    record.status,
    viduLiveValidationStatuses,
    'validation status'
  );
  const startedAt = parseTimestamp(record.startedAt, 'startedAt');
  const updatedAt = parseTimestamp(record.updatedAt, 'updatedAt');
  const stoppedAt = parseNullableTimestamp(record.stoppedAt, 'stoppedAt');
  const stopCode = parseNullableErrorCode(record.stopCode);
  const readiness = parseReadiness(record.readiness);
  const blockingReasons = parseBlockingReasons(record.blockingReasons);
  const budget = parseBudget(record.budget);
  const events = parseEvents(record.events);
  if (updatedAt < startedAt || events.length === 0) {
    throw invalidData('The Vidu live validation timeline is invalid');
  }
  if (
    events[0].stage !== 'readiness' ||
    events.some((event, index) =>
      event.sequence !== index + 1 ||
      event.recordedAt < startedAt ||
      event.recordedAt > updatedAt ||
      (index > 0 && event.recordedAt < events[index - 1].recordedAt)
    )
  ) {
    throw invalidData('The Vidu live validation events are invalid');
  }
  if (
    (status === 'active' && (stoppedAt !== null || stopCode !== null)) ||
    (status !== 'active' && stoppedAt === null) ||
    (status === 'passed' && stopCode !== null) ||
    (status === 'failed' && stopCode === null) ||
    (status === 'blocked' && stopCode !== 'prerequisite_missing') ||
    (stoppedAt !== null && (stoppedAt < startedAt || stoppedAt !== updatedAt))
  ) {
    throw invalidData('The Vidu live validation stop state is invalid');
  }
  if (
    (status === 'blocked' && blockingReasons.length === 0) ||
    (budget.image.claimState === 'claimed' &&
      !events.some(
        (event) =>
          event.stage === 'image_submission' && event.state === 'claimed'
      )) ||
    (budget.video.claimState === 'claimed' &&
      !events.some(
        (event) =>
          event.stage === 'video_submission' && event.state === 'claimed'
      ))
  ) {
    throw invalidData('The Vidu live validation budget state is invalid');
  }
  return {
    schemaVersion: 1,
    revision,
    validationId,
    status,
    startedAt,
    updatedAt,
    stoppedAt,
    stopCode,
    readiness,
    blockingReasons,
    budget,
    events
  };
}

function parseReadiness(value: unknown): ViduLiveValidationReadiness {
  const record = requireRecord(value, 'readiness');
  requireExactKeys(record, ['officialFacts', 'approval'], 'readiness');
  const officialFacts = requireRecord(
    record.officialFacts,
    'official facts'
  );
  requireExactKeys(officialFacts, [
    'creditsContractVerified',
    'imageContractVerified',
    'videoContractVerified'
  ], 'official facts');
  const approval = requireRecord(record.approval, 'approval');
  requireExactKeys(approval, [
    'liveNetworkApproved',
    'credentialUseApproved',
    'imageBillableAttemptApproved',
    'videoBillableAttemptApproved'
  ], 'approval');
  return {
    officialFacts: {
      creditsContractVerified: requireBoolean(
        officialFacts.creditsContractVerified,
        'creditsContractVerified'
      ),
      imageContractVerified: requireBoolean(
        officialFacts.imageContractVerified,
        'imageContractVerified'
      ),
      videoContractVerified: requireBoolean(
        officialFacts.videoContractVerified,
        'videoContractVerified'
      )
    },
    approval: {
      liveNetworkApproved: requireBoolean(
        approval.liveNetworkApproved,
        'liveNetworkApproved'
      ),
      credentialUseApproved: requireBoolean(
        approval.credentialUseApproved,
        'credentialUseApproved'
      ),
      imageBillableAttemptApproved: requireBoolean(
        approval.imageBillableAttemptApproved,
        'imageBillableAttemptApproved'
      ),
      videoBillableAttemptApproved: requireBoolean(
        approval.videoBillableAttemptApproved,
        'videoBillableAttemptApproved'
      )
    }
  };
}

function parseBudget(value: unknown): ViduLiveValidationRecord['budget'] {
  const record = requireRecord(value, 'budget');
  requireExactKeys(record, ['image', 'video'], 'budget');
  return {
    image: parseBudgetEntry(record.image, 'image budget'),
    video: parseBudgetEntry(record.video, 'video budget')
  };
}

function parseBudgetEntry(
  value: unknown,
  label: string
): ViduLiveValidationBudgetEntry {
  const record = requireRecord(value, label);
  requireExactKeys(record, [
    'approval',
    'claimState',
    'claimedAt',
    'billingFact'
  ], label);
  const approval = requireOneOf(
    record.approval,
    ['approved', 'not_approved'] as const,
    `${label} approval`
  );
  const claimState = requireOneOf(
    record.claimState,
    ['available', 'claimed', 'not_available'] as const,
    `${label} claim state`
  );
  const claimedAt = parseNullableTimestamp(record.claimedAt, 'claimedAt');
  const billingFact = requireOneOf(
    record.billingFact,
    viduLiveValidationBillingFacts,
    `${label} billing fact`
  );
  if (
    (approval === 'approved') !== (claimState !== 'not_available') ||
    (claimState === 'claimed') !== (claimedAt !== null) ||
    (claimState === 'available' && billingFact !== 'not_attempted') ||
    (claimState === 'not_available' && billingFact !== 'not_attempted') ||
    (claimState === 'claimed' && billingFact === 'not_attempted')
  ) {
    throw invalidData(`The ${label} is inconsistent`);
  }
  return { approval, claimState, claimedAt, billingFact };
}

function parseEvents(value: unknown): readonly ViduLiveValidationEvent[] {
  if (!Array.isArray(value)) throw invalidData('Events must be an array');
  return value.map(parseEvent);
}

function parseEvent(value: unknown): ViduLiveValidationEvent {
  const record = requireRecord(value, 'event');
  requireExactKeys(record, [
    'sequence',
    'stage',
    'state',
    'recordedAt',
    'elapsedMs',
    'httpStatus',
    'errorCode',
    'providerState',
    'localIds',
    'localEvidence'
  ], 'event');
  const state = requireOneOf(
    record.state,
    viduLiveValidationEventStates,
    'event state'
  );
  const errorCode = parseNullableErrorCode(record.errorCode);
  if (
    (['failed', 'blocked'].includes(state) && errorCode === null) ||
    (!['failed', 'blocked'].includes(state) && errorCode !== null)
  ) {
    throw invalidData('The event error code is inconsistent');
  }
  return {
    sequence: requirePositiveInteger(record.sequence, 'event sequence'),
    stage: requireOneOf(
      record.stage,
      viduLiveValidationStages,
      'event stage'
    ),
    state,
    recordedAt: parseTimestamp(record.recordedAt, 'event recordedAt'),
    elapsedMs: parseNullableElapsed(record.elapsedMs),
    httpStatus: parseNullableHttpStatus(record.httpStatus),
    errorCode,
    providerState: record.providerState === null
      ? null
      : requireOneOf(
          record.providerState,
          viduLiveValidationProviderStates,
          'provider state'
        ),
    localIds: parseLocalIds(record.localIds),
    localEvidence: parseLocalEvidence(record.localEvidence)
  };
}

function parseLocalIds(value: unknown): ViduLiveValidationLocalIds {
  const record = requireRecord(value, 'local IDs');
  requireExactKeys(record, ['taskId', 'executionId', 'workId'], 'local IDs');
  return {
    taskId: parseNullableLocalId(record.taskId, 'taskId'),
    executionId: parseNullableLocalId(record.executionId, 'executionId'),
    workId: parseNullableLocalId(record.workId, 'workId')
  };
}

function parseLocalEvidence(value: unknown): ViduLiveValidationLocalEvidence {
  const record = requireRecord(value, 'local evidence');
  requireExactKeys(record, [
    'mediaProbed',
    'sha256Verified',
    'atomicallyPublished',
    'indexed',
    'workRegistered'
  ], 'local evidence');
  return {
    mediaProbed: parseNullableBoolean(record.mediaProbed, 'mediaProbed'),
    sha256Verified: parseNullableBoolean(
      record.sha256Verified,
      'sha256Verified'
    ),
    atomicallyPublished: parseNullableBoolean(
      record.atomicallyPublished,
      'atomicallyPublished'
    ),
    indexed: parseNullableBoolean(record.indexed, 'indexed'),
    workRegistered: parseNullableBoolean(
      record.workRegistered,
      'workRegistered'
    )
  };
}

function parseObservation(
  value: ViduLiveValidationObservation
): {
  readonly outcome: ViduLiveValidationObservation['outcome'];
  readonly elapsedMs: number | null;
  readonly httpStatus: number | null;
  readonly errorCode: ViduLiveValidationErrorCode | null;
} {
  assertAllowedKeys(
    value,
    ['outcome', 'elapsedMs', 'httpStatus', 'errorCode'],
    'credits observation'
  );
  const outcome = requireOneOf(
    value.outcome,
    ['succeeded', 'failed'] as const,
    'credits outcome'
  );
  const errorCode = value.errorCode === undefined
    ? null
    : parseErrorCode(value.errorCode);
  if ((outcome === 'failed') !== (errorCode !== null)) {
    throw invalidData('A failed credits observation requires an error code');
  }
  return {
    outcome,
    elapsedMs: parseOptionalElapsed(value.elapsedMs),
    httpStatus: parseOptionalHttpStatus(value.httpStatus),
    errorCode
  };
}

function parseAttemptIdentity(
  value: ViduLiveValidationAttemptIdentity
): ViduLiveValidationAttemptIdentity {
  assertAllowedKeys(value, ['taskId', 'executionId'], 'attempt identity');
  return {
    taskId: parseLocalId(value.taskId, 'taskId'),
    executionId: parseLocalId(value.executionId, 'executionId')
  };
}

function parseSubmissionObservation(
  value: ViduLiveValidationSubmissionObservation
): {
  readonly outcome: ViduLiveValidationSubmissionObservation['outcome'];
  readonly elapsedMs: number | null;
  readonly httpStatus: number | null;
  readonly errorCode: ViduLiveValidationErrorCode | null;
} {
  assertAllowedKeys(
    value,
    ['outcome', 'elapsedMs', 'httpStatus', 'errorCode'],
    'submission observation'
  );
  const outcome = requireOneOf(value.outcome, [
    'accepted_or_completed',
    'failed_before_submission',
    'submission_outcome_unknown'
  ] as const, 'submission outcome');
  const errorCode = value.errorCode === undefined
    ? null
    : parseErrorCode(value.errorCode);
  if (outcome === 'accepted_or_completed' && errorCode !== null) {
    throw invalidData('A successful submission cannot have an error code');
  }
  return {
    outcome,
    elapsedMs: parseOptionalElapsed(value.elapsedMs),
    httpStatus: parseOptionalHttpStatus(value.httpStatus),
    errorCode
  };
}

function parseResultEvidence(
  value: ViduLiveValidationResultEvidence
): {
  readonly taskId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly mediaProbed: boolean;
  readonly sha256Verified: boolean;
  readonly atomicallyPublished: boolean;
  readonly indexed: boolean;
  readonly workRegistered: boolean;
  readonly elapsedMs: number | null;
} {
  assertAllowedKeys(value, [
    'taskId',
    'executionId',
    'workId',
    'mediaProbed',
    'sha256Verified',
    'atomicallyPublished',
    'indexed',
    'workRegistered',
    'elapsedMs'
  ], 'result evidence');
  return {
    taskId: parseLocalId(value.taskId, 'taskId'),
    executionId: parseLocalId(value.executionId, 'executionId'),
    workId: parseLocalId(value.workId, 'workId'),
    mediaProbed: requireBoolean(value.mediaProbed, 'mediaProbed'),
    sha256Verified: requireBoolean(value.sha256Verified, 'sha256Verified'),
    atomicallyPublished: requireBoolean(
      value.atomicallyPublished,
      'atomicallyPublished'
    ),
    indexed: requireBoolean(value.indexed, 'indexed'),
    workRegistered: requireBoolean(value.workRegistered, 'workRegistered'),
    elapsedMs: parseOptionalElapsed(value.elapsedMs)
  };
}

function parseVideoConfirmation(
  value: ViduLiveValidationVideoConfirmation
): ViduLiveValidationVideoConfirmation {
  assertAllowedKeys(value, [
    'sourceImageWorkId',
    'outboundScopeConfirmed',
    'costConfirmed'
  ], 'video confirmation');
  return {
    sourceImageWorkId: parseLocalId(
      value.sourceImageWorkId,
      'sourceImageWorkId'
    ),
    outboundScopeConfirmed: requireBoolean(
      value.outboundScopeConfirmed,
      'outboundScopeConfirmed'
    ),
    costConfirmed: requireBoolean(value.costConfirmed, 'costConfirmed')
  };
}

function parsePollingObservation(
  value: ViduLiveValidationPollingObservation
): {
  readonly providerState: ViduLiveValidationProviderState;
  readonly elapsedMs: number | null;
  readonly httpStatus: number | null;
  readonly errorCode: ViduLiveValidationErrorCode | null;
} {
  assertAllowedKeys(
    value,
    ['providerState', 'elapsedMs', 'httpStatus', 'errorCode'],
    'polling observation'
  );
  const providerState = requireOneOf(
    value.providerState,
    viduLiveValidationProviderStates,
    'provider state'
  );
  const errorCode = value.errorCode === undefined
    ? null
    : parseErrorCode(value.errorCode);
  if (!['failed', 'cancelled'].includes(providerState) && errorCode !== null) {
    throw invalidData('A non-failed provider state cannot have an error code');
  }
  return {
    providerState,
    elapsedMs: parseOptionalElapsed(value.elapsedMs),
    httpStatus: parseOptionalHttpStatus(value.httpStatus),
    errorCode
  };
}

function parseFailure(value: ViduLiveValidationFailure): {
  readonly stage: ViduLiveValidationStage;
  readonly errorCode: ViduLiveValidationErrorCode;
  readonly elapsedMs: number | null;
  readonly httpStatus: number | null;
} {
  assertAllowedKeys(
    value,
    ['stage', 'errorCode', 'elapsedMs', 'httpStatus'],
    'failure'
  );
  return {
    stage: requireOneOf(
      value.stage,
      viduLiveValidationStages,
      'failure stage'
    ),
    errorCode: parseErrorCode(value.errorCode),
    elapsedMs: parseOptionalElapsed(value.elapsedMs),
    httpStatus: parseOptionalHttpStatus(value.httpStatus)
  };
}

function findBlockingReasons(
  readiness: ViduLiveValidationReadiness
): readonly ViduLiveValidationBlockingReason[] {
  const reasons: ViduLiveValidationBlockingReason[] = [];
  if (!readiness.officialFacts.creditsContractVerified) {
    reasons.push('credits_contract_unverified');
  }
  if (!readiness.officialFacts.imageContractVerified) {
    reasons.push('image_contract_unverified');
  }
  if (!readiness.officialFacts.videoContractVerified) {
    reasons.push('video_contract_unverified');
  }
  if (!readiness.approval.liveNetworkApproved) {
    reasons.push('live_network_unapproved');
  }
  if (!readiness.approval.credentialUseApproved) {
    reasons.push('credential_use_unapproved');
  }
  if (!readiness.approval.imageBillableAttemptApproved) {
    reasons.push('image_billable_attempt_unapproved');
  }
  if (!readiness.approval.videoBillableAttemptApproved) {
    reasons.push('video_billable_attempt_unapproved');
  }
  return reasons;
}

function createBudgetEntry(approved: boolean): ViduLiveValidationBudgetEntry {
  return {
    approval: approved ? 'approved' : 'not_approved',
    claimState: approved ? 'available' : 'not_available',
    claimedAt: null,
    billingFact: 'not_attempted'
  };
}

function createEvent(
  input: {
    readonly sequence: number;
    readonly stage: ViduLiveValidationStage;
    readonly state: ViduLiveValidationEventState;
    readonly recordedAt: IsoTimestamp;
    readonly elapsedMs?: number | null;
    readonly httpStatus?: number | null;
    readonly errorCode?: ViduLiveValidationErrorCode | null;
    readonly providerState?: ViduLiveValidationProviderState | null;
    readonly localIds?: ViduLiveValidationLocalIds;
    readonly localEvidence?: ViduLiveValidationLocalEvidence;
  }
): ViduLiveValidationEvent {
  return {
    sequence: input.sequence,
    stage: input.stage,
    state: input.state,
    recordedAt: input.recordedAt,
    elapsedMs: input.elapsedMs ?? null,
    httpStatus: input.httpStatus ?? null,
    errorCode: input.errorCode ?? null,
    providerState: input.providerState ?? null,
    localIds: input.localIds ?? emptyLocalIds(),
    localEvidence: input.localEvidence ?? emptyLocalEvidence()
  };
}

function appendEvent(
  current: ViduLiveValidationRecord,
  event: ViduLiveValidationEvent,
  timestamp: IsoTimestamp,
  terminal?: {
    readonly status: Exclude<ViduLiveValidationStatus, 'active'>;
    readonly stopCode: ViduLiveValidationErrorCode | null;
  }
): ViduLiveValidationRecord {
  return {
    ...current,
    revision: current.revision + 1,
    status: terminal?.status ?? 'active',
    updatedAt: timestamp,
    stoppedAt: terminal ? timestamp : null,
    stopCode: terminal?.stopCode ?? null,
    events: [...current.events, event]
  };
}

function assertClaimPrerequisites(
  current: ViduLiveValidationRecord,
  mediaKind: ViduLiveValidationMediaKind
): void {
  if (mediaKind === 'image') {
    requireSuccessfulEvent(current, 'credits_validation');
    requireNoEvent(current, 'image_submission');
    return;
  }
  requireSuccessfulEvent(current, 'image_local_result');
  requireSuccessfulEvent(current, 'video_confirmation');
  requireNoEvent(current, 'video_submission');
}

function requireClaimEvent(
  current: ViduLiveValidationRecord,
  stage: ViduLiveValidationStage
): ViduLiveValidationEvent {
  const event = current.events.find(
    (candidate) => candidate.stage === stage && candidate.state === 'claimed'
  );
  if (!event) throw invalidTransition('A billable attempt must be claimed first');
  return event;
}

function requireSuccessfulEvent(
  current: ViduLiveValidationRecord,
  stage: ViduLiveValidationStage
): ViduLiveValidationEvent {
  const event = [...current.events].reverse().find(
    (candidate) => candidate.stage === stage && candidate.state === 'succeeded'
  );
  if (!event) {
    throw invalidTransition(`The ${stage} step has not succeeded`);
  }
  return event;
}

function requireNoEvent(
  current: ViduLiveValidationRecord,
  stage: ViduLiveValidationStage
): void {
  if (current.events.some((event) => event.stage === stage)) {
    throw invalidTransition(`The ${stage} step has already started`);
  }
}

function requireNoTerminalStageEvent(
  current: ViduLiveValidationRecord,
  stage: ViduLiveValidationStage
): void {
  if (
    current.events.some(
      (event) => event.stage === stage && event.state !== 'claimed'
    )
  ) {
    throw invalidTransition(`The ${stage} step is already recorded`);
  }
}

function submissionStage(
  mediaKind: ViduLiveValidationMediaKind
): 'image_submission' | 'video_submission' {
  return mediaKind === 'image' ? 'image_submission' : 'video_submission';
}

function localResultStage(
  mediaKind: ViduLiveValidationMediaKind
): 'image_local_result' | 'video_local_result' {
  return mediaKind === 'image' ? 'image_local_result' : 'video_local_result';
}

function emptyLocalIds(): ViduLiveValidationLocalIds {
  return { taskId: null, executionId: null, workId: null };
}

function emptyLocalEvidence(): ViduLiveValidationLocalEvidence {
  return {
    mediaProbed: null,
    sha256Verified: null,
    atomicallyPublished: null,
    indexed: null,
    workRegistered: null
  };
}

function parseBlockingReasons(
  value: unknown
): readonly ViduLiveValidationBlockingReason[] {
  if (!Array.isArray(value)) {
    throw invalidData('Blocking reasons must be an array');
  }
  return uniqueReasons(value.map((reason) =>
    requireOneOf(
      reason,
      viduLiveValidationBlockingReasons,
      'blocking reason'
    )
  ));
}

function uniqueReasons(
  reasons: readonly ViduLiveValidationBlockingReason[]
): readonly ViduLiveValidationBlockingReason[] {
  if (new Set(reasons).size !== reasons.length) {
    throw invalidData('Blocking reasons must be unique');
  }
  return [...reasons];
}

function parseMediaKind(value: unknown): ViduLiveValidationMediaKind {
  return requireOneOf(value, ['image', 'video'] as const, 'media kind');
}

function parseErrorCode(value: unknown): ViduLiveValidationErrorCode {
  return requireOneOf(
    value,
    viduLiveValidationErrorCodes,
    'validation error code'
  );
}

function parseNullableErrorCode(
  value: unknown
): ViduLiveValidationErrorCode | null {
  return value === null ? null : parseErrorCode(value);
}

function parseTimestamp(value: unknown, label: string): IsoTimestamp {
  if (typeof value !== 'string') throw invalidData(`${label} is invalid`);
  try {
    return toIsoTimestamp(value);
  } catch (error) {
    throw invalidData(`${label} is invalid`, error);
  }
}

function parseNullableTimestamp(
  value: unknown,
  label: string
): IsoTimestamp | null {
  return value === null ? null : parseTimestamp(value, label);
}

function parseLocalId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw invalidData(`${label} is not a safe local identifier`);
  }
  return value;
}

function parseNullableLocalId(value: unknown, label: string): string | null {
  return value === null ? null : parseLocalId(value, label);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidData(`${label} must be boolean`);
  return value;
}

function parseNullableBoolean(value: unknown, label: string): boolean | null {
  return value === null ? null : requireBoolean(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidData(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label);
  if (parsed < 1) throw invalidData(`${label} must be positive`);
  return parsed;
}

function parseOptionalElapsed(value: unknown): number | null {
  return value === undefined ? null : parseElapsed(value);
}

function parseNullableElapsed(value: unknown): number | null {
  return value === null ? null : parseElapsed(value);
}

function parseElapsed(value: unknown): number {
  return requireNonNegativeInteger(value, 'elapsedMs');
}

function parseOptionalHttpStatus(value: unknown): number | null {
  return value === undefined ? null : parseHttpStatus(value);
}

function parseNullableHttpStatus(value: unknown): number | null {
  return value === null ? null : parseHttpStatus(value);
}

function parseHttpStatus(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > 599) {
    throw invalidData('HTTP status is invalid');
  }
  return Number(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidData(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !allowed.has(key))) {
    throw invalidData(`${label} contains unexpected or missing fields`);
  }
}

function assertAllowedKeys(
  value: object,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidData(`${label} contains unexpected fields`);
  }
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalidData(`${label} is invalid`);
  }
  return value as T[number];
}

function invalidTransition(message: string): ViduLiveValidationStateError {
  return new ViduLiveValidationStateError('invalid_transition', message);
}

function invalidData(
  message: string,
  cause?: unknown
): ViduLiveValidationDataError {
  return new ViduLiveValidationDataError(message, cause);
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
