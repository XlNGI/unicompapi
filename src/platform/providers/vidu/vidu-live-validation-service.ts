import { randomUUID } from 'node:crypto';
import {
  createModelCapabilityEvidence,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toIsoTimestamp,
  toRoutingPreferenceId,
  toWorkId,
  type Execution,
  type ModelCapabilityEvidence,
  type ProviderSubmitOutcome,
  type Task
} from '../../../domain';
import {
  JsonAssetRepository,
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../../repositories';
import { NodeSha256FileVerifier } from '../../files';
import { NodeProjectStorage } from '../../storage';
import type { StorageProjectSession } from '../../ipc/storage-ipc-controller';
import type { ConnectionValidationPort } from '../provider-capability-services';
import type {
  JsonProviderRegistryStore,
  ProviderRegistrySnapshot
} from '../provider-registry';
import {
  VIDU_CONNECTION_ID,
  VIDU_PROVIDER_ID
} from '../vidu-protocol-catalog';
import type { ProviderAsyncOperationStatus } from '../provider-execution-lifecycle';
import {
  ViduLiveValidationStateError,
  type ViduLiveValidationCoordinator,
  type ViduLiveValidationMediaKind,
  type ViduLiveValidationRecord
} from './vidu-live-validation';

const liveImageModelKey = 'q3-lite';
const liveVideoModelKey = 'viduq3-turbo';

export interface ViduLiveValidationApprovalInput {
  readonly confirmLiveNetwork: true;
  readonly confirmCredentialUse: true;
  readonly confirmImageBillableAttempt: true;
  readonly confirmVideoBillableAttempt: true;
}

export interface ViduLiveValidationApplicationServiceOptions {
  readonly registry: JsonProviderRegistryStore;
  readonly coordinator: ViduLiveValidationCoordinator;
  readonly connectionValidation: ConnectionValidationPort;
  readonly now?: () => string;
}

export class ViduLiveValidationApplicationError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'already_started'
      | 'connection_not_ready'
      | 'validation_not_active'
      | 'validation_scope_mismatch'
      | 'billable_attempt_exhausted'
      | 'project_not_open'
      | 'source_work_mismatch'
      | 'validation_operation_failed',
    message: string
  ) {
    super(message);
    this.name = 'ViduLiveValidationApplicationError';
  }
}

export class ViduLiveValidationApplicationService {
  private readonly now: () => string;

  constructor(
    private readonly options: ViduLiveValidationApplicationServiceOptions
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  load(): Promise<ViduLiveValidationRecord | undefined> {
    return this.options.coordinator.load();
  }

  async start(input: unknown): Promise<ViduLiveValidationRecord> {
    parseApproval(input);
    if (await this.options.coordinator.load()) {
      throw new ViduLiveValidationApplicationError(
        'already_started',
        'The approved Vidu live validation has already started'
      );
    }

    const snapshot = await this.options.registry.load();
    const connection = snapshot.connections.find(
      (candidate) => candidate.id === VIDU_CONNECTION_ID
    );
    if (
      !connection ||
      connection.providerId !== VIDU_PROVIDER_ID ||
      connection.state === 'disabled' ||
      connection.state === 'deleted' ||
      !connection.credentialReference ||
      !['saved', 'valid'].includes(connection.credentialState)
    ) {
      throw new ViduLiveValidationApplicationError(
        'connection_not_ready',
        'The Vidu connection requires a safely stored credential before live validation starts'
      );
    }

    const validation = await this.options.connectionValidation.validate(connection);
    const observedAt = toIsoTimestamp(validation.observedAt);
    const validatedSnapshot: ProviderRegistrySnapshot = {
      ...snapshot,
      connections: snapshot.connections.map((candidate) =>
        candidate.id === connection.id
          ? {
              ...candidate,
              state: validation.state,
              identityState: validation.identityState,
              credentialState: validation.credentialState,
              lastConnectionValidationAt: observedAt,
              updatedAt: observedAt
            }
          : candidate
      )
    };
    await this.options.registry.save(validatedSnapshot);
    if (
      validation.state !== 'available' ||
      validation.identityState !== 'verified' ||
      validation.credentialState !== 'valid'
    ) {
      throw new ViduLiveValidationApplicationError(
        'connection_not_ready',
        'The Vidu credits validation did not confirm an available connection'
      );
    }

    const record = await this.options.coordinator.start({
      readiness: {
        officialFacts: {
          creditsContractVerified: true,
          imageContractVerified: true,
          videoContractVerified: true
        },
        approval: {
          liveNetworkApproved: true,
          credentialUseApproved: true,
          imageBillableAttemptApproved: true,
          videoBillableAttemptApproved: true
        }
      }
    });
    try {
      await this.options.coordinator.recordCreditsValidation({
        outcome: 'succeeded'
      });
      await this.installValidationScope(validatedSnapshot, record.validationId);
    } catch {
      await this.stopForLocalStateFailure('flow');
      throw new ViduLiveValidationApplicationError(
        'validation_operation_failed',
        'The Vidu live validation scope could not be installed'
      );
    }
    return (await this.options.coordinator.load())!;
  }

  async beforeSubmission(
    mediaKind: ViduLiveValidationMediaKind,
    task: Task,
    execution: Execution,
    getSession: () => StorageProjectSession | undefined
  ): Promise<void> {
    const record = await this.options.coordinator.load();
    const submission = mediaKind === 'image'
      ? task.submission.image
      : task.submission.video;
    if (!submission || execution.taskId !== task.id) {
      throw scopeMismatch();
    }
    const snapshot = await this.options.registry.load();
    const expectedModel = modelForMedia(snapshot, mediaKind);
    if (
      !expectedModel ||
      submission.modelId !== expectedModel.id ||
      submission.capabilityEvidenceId !== expectedModel.capabilityEvidenceId
    ) {
      throw scopeMismatch();
    }
    if (record?.status === 'passed') {
      const evidence = snapshot.capabilities.find(
        (candidate) => candidate.id === submission.capabilityEvidenceId
      );
      if (
        evidence?.state === 'verified_supported' &&
        evidence.source === 'system_observed'
      ) {
        return;
      }
      throw scopeMismatch();
    }
    if (record?.status !== 'active') {
      throw new ViduLiveValidationApplicationError(
        'validation_not_active',
        'The approved Vidu live validation is not active'
      );
    }

    if (mediaKind === 'video') {
      await this.confirmVideoSource(record, task, getSession);
    }
    try {
      await this.options.coordinator.claimBillableAttempt(mediaKind, {
        taskId: task.id,
        executionId: execution.id
      });
    } catch (error) {
      if (
        error instanceof ViduLiveValidationStateError &&
        error.code === 'budget_exhausted'
      ) {
        throw new ViduLiveValidationApplicationError(
          'billable_attempt_exhausted',
          `The approved ${mediaKind} billable attempt has already been claimed`
        );
      }
      throw error;
    }
  }

  async afterSubmission(
    mediaKind: ViduLiveValidationMediaKind,
    outcome: ProviderSubmitOutcome
  ): Promise<void> {
    const record = await this.options.coordinator.load();
    if (record?.status === 'passed') return;
    if (record?.status !== 'active') return;
    const observation = outcome.kind === 'completed_sync' ||
      outcome.kind === 'accepted_async'
      ? { outcome: 'accepted_or_completed' as const }
      : outcome.kind === 'submission_outcome_unknown'
        ? {
            outcome: 'submission_outcome_unknown' as const,
            errorCode: 'submission_outcome_unknown' as const
          }
        : {
            outcome: 'failed_before_submission' as const,
            errorCode: 'failed_before_submission' as const
          };
    try {
      await this.options.coordinator.recordSubmission(mediaKind, observation);
    } catch (error) {
      await this.stopForLocalStateFailure(`${mediaKind}_submission`);
      throw error;
    }
  }

  async recordPolling(status: ProviderAsyncOperationStatus): Promise<void> {
    const record = await this.options.coordinator.load();
    if (record?.status !== 'active' ||
      !record.events.some((event) =>
        event.stage === 'video_submission' && event.state === 'succeeded'
      )) {
      return;
    }
    const providerState = status.state === 'queued'
      ? 'queueing'
      : status.state === 'completed'
        ? 'success'
        : status.state === 'expired' || status.state === 'cancelled'
          ? 'cancelled'
          : status.state;
    try {
      await this.options.coordinator.recordVideoPolling({
        providerState,
        ...(status.state === 'failed'
          ? { errorCode: 'remote_task_failed' as const }
          : {})
      });
    } catch (error) {
      await this.stopForLocalStateFailure('video_polling');
      throw error;
    }
  }

  async recordLocalResult(
    mediaKind: ViduLiveValidationMediaKind,
    executionId: string,
    workId: string,
    getSession: () => StorageProjectSession | undefined
  ): Promise<void> {
    const record = await this.options.coordinator.load();
    if (record?.status === 'passed') return;
    if (record?.status !== 'active') {
      throw new ViduLiveValidationApplicationError(
        'validation_not_active',
        'The approved Vidu live validation is not active'
      );
    }
    const session = getSession();
    if (!session) {
      throw new ViduLiveValidationApplicationError(
        'project_not_open',
        'The project used for Vidu live validation is no longer open'
      );
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    const execution = await new JsonExecutionRepository(storage).get(
      executionId as Execution['id']
    );
    const task = execution
      ? await new JsonTaskRepository(storage, session.projectId).get(
          execution.taskId
        )
      : undefined;
    const work = await new JsonWorkRepository(storage, session.projectId).get(
      toWorkId(workId)
    );
    const file = work
      ? await new JsonFileReferenceRepository(storage, session.projectId).get(
          work.fileId
        )
      : undefined;
    const indexEntry = file
      ? await new JsonFileIndexRepository(storage, session.projectId).get(file.id)
      : undefined;
    const submission = mediaKind === 'image'
      ? task?.submission.image
      : task?.submission.video;
    if (
      !execution ||
      !task ||
      !work ||
      !submission ||
      task.projectId !== session.projectId ||
      work.projectId !== session.projectId ||
      work.mediaKind !== mediaKind ||
      work.sourceTaskId !== task.id ||
      work.sourceExecutionId !== execution.id ||
      !file ||
      file.projectId !== session.projectId ||
      file.sourceExecutionId !== execution.id ||
      file.state !== 'available' ||
      file.locator.kind !== 'project' ||
      file.sizeBytes === undefined ||
      !file.checksumSha256 ||
      file.lastVerification?.matchesExpected === false ||
      !indexEntry ||
      indexEntry.fileId !== file.id ||
      indexEntry.relativePath !== file.locator.relativePath ||
      indexEntry.state !== 'available' ||
      indexEntry.sizeBytes !== file.sizeBytes ||
      indexEntry.checksumSha256 !== file.checksumSha256
    ) {
      throw scopeMismatch();
    }
    const claimed = record.events.find(
      (event) =>
        event.stage === `${mediaKind}_submission` && event.state === 'claimed'
    );
    if (
      claimed?.localIds.taskId !== task.id ||
      claimed.localIds.executionId !== execution.id
    ) {
      throw scopeMismatch();
    }

    try {
      const verification = await new NodeSha256FileVerifier(
        session.rootDirectory
      ).verify({ file, expectedChecksum: file.checksumSha256 });
      if (
        verification.matchesExpected !== true ||
        verification.sizeBytes !== file.sizeBytes
      ) {
        throw new ViduLiveValidationApplicationError(
          'validation_operation_failed',
          'The registered Work file no longer matches its verified facts'
        );
      }
      await this.promoteVerifiedEvidence(
        mediaKind,
        submission.capabilityEvidenceId
      );
      await this.options.coordinator.recordLocalResult(mediaKind, {
        taskId: task.id,
        executionId: execution.id,
        workId: work.id,
        mediaProbed: true,
        sha256Verified: true,
        atomicallyPublished: true,
        indexed: true,
        workRegistered: true
      });
    } catch (error) {
      await this.stopForLocalStateFailure(`${mediaKind}_local_result`);
      throw error;
    }
  }

  private async confirmVideoSource(
    record: ViduLiveValidationRecord,
    task: Task,
    getSession: () => StorageProjectSession | undefined
  ): Promise<void> {
    const imageResult = record.events.find(
      (event) =>
        event.stage === 'image_local_result' && event.state === 'succeeded'
    );
    const sourceWorkId = imageResult?.localIds.workId;
    const session = getSession();
    if (!sourceWorkId || !session || task.projectId !== session.projectId) {
      throw new ViduLiveValidationApplicationError(
        'source_work_mismatch',
        'The video validation must use the verified image Work from this flow'
      );
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    const work = await new JsonWorkRepository(storage, session.projectId).get(
      toWorkId(sourceWorkId)
    );
    const assets = await new JsonAssetRepository(
      storage,
      session.projectId
    ).list(session.projectId);
    const sourceAsset = work
      ? assets.find((asset) => asset.fileId === work.fileId)
      : undefined;
    if (
      !work ||
      work.mediaKind !== 'image' ||
      task.submission.video?.mode !== 'image_to_video' ||
      !sourceAsset ||
      task.submission.assetIds?.length !== 1 ||
      task.submission.assetIds[0] !== sourceAsset.id
    ) {
      throw new ViduLiveValidationApplicationError(
        'source_work_mismatch',
        'The video validation must use the verified image Work from this flow'
      );
    }
    if (!record.events.some((event) => event.stage === 'video_confirmation')) {
      await this.options.coordinator.confirmVideo({
        sourceImageWorkId: sourceWorkId,
        outboundScopeConfirmed: true,
        costConfirmed: true
      });
    }
  }

  private async installValidationScope(
    snapshot: ProviderRegistrySnapshot,
    validationId: string
  ): Promise<void> {
    const timestamp = toIsoTimestamp(this.now());
    const imageModel = modelForMedia(snapshot, 'image');
    const videoModel = modelForMedia(snapshot, 'video');
    if (!imageModel || !videoModel) throw scopeMismatch();
    const imageEvidence = liveEvidence(
      snapshot,
      imageModel.id,
      'reference_to_image',
      validationId,
      timestamp,
      { schemaVersion: 1, fields: [] }
    );
    const videoEvidence = liveEvidence(
      snapshot,
      videoModel.id,
      'reference_to_video',
      validationId,
      timestamp,
      {
        schemaVersion: 1,
        fields: [
          {
            key: 'audio',
            label: '音频',
            kind: 'boolean',
            required: true
          },
          {
            key: 'duration',
            label: '时长（秒）',
            kind: 'integer',
            required: true,
            minimum: 3,
            maximum: 15
          },
          {
            key: 'resolution',
            label: '分辨率',
            kind: 'enum',
            required: true,
            options: ['540p']
          }
        ]
      },
      {
        schemaVersion: 1,
        modes: [{
          mode: 'image_to_video',
          materialSlots: [{
            id: 'reference',
            role: 'reference',
            required: true,
            acceptedMediaKinds: ['image']
          }]
        }]
      }
    );
    const models = snapshot.models.map((model) => {
      if (model.providerId !== VIDU_PROVIDER_ID) return model;
      const evidence = model.id === imageModel.id
        ? imageEvidence
        : model.id === videoModel.id
          ? videoEvidence
          : undefined;
      return {
        ...model,
        enabled: Boolean(evidence),
        revision: model.revision + 1,
        capabilityEvidenceId: evidence?.id ?? model.capabilityEvidenceId,
        updatedAt: timestamp
      };
    });
    const routingPreferences = upsertRoute(
      upsertRoute(
        snapshot.routingPreferences,
        'routing-vidu-live-reference-image',
        'reference_to_image',
        imageModel.id,
        timestamp
      ),
      'routing-vidu-live-reference-video',
      'video_generation',
      videoModel.id,
      timestamp
    );
    await this.options.registry.save({
      ...snapshot,
      models,
      capabilities: [
        ...snapshot.capabilities,
        imageEvidence,
        videoEvidence
      ],
      routingPreferences
    });
  }

  private async stopForLocalStateFailure(
    stage: 'flow' | 'image_submission' | 'video_submission' |
      'video_polling' | 'image_local_result' | 'video_local_result'
  ): Promise<void> {
    const record = await this.options.coordinator.load().catch(() => undefined);
    if (record?.status !== 'active') return;
    await this.options.coordinator.stopFailed({
      stage,
      errorCode: 'local_state_failed'
    }).catch(() => undefined);
  }

  private async promoteVerifiedEvidence(
    mediaKind: ViduLiveValidationMediaKind,
    sourceEvidenceId: string
  ): Promise<void> {
    const snapshot = await this.options.registry.load();
    const model = modelForMedia(snapshot, mediaKind);
    const source = snapshot.capabilities.find(
      (evidence) => evidence.id === sourceEvidenceId
    );
    if (!model || !source || source.modelId !== model.id) throw scopeMismatch();
    const existing = latestEvidence(
      snapshot.capabilities,
      model.id,
      source.capability,
      'system_observed'
    );
    if (existing?.state === 'verified_supported') return;
    const timestamp = toIsoTimestamp(this.now());
    const evidence = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId(
        `capability-live-${mediaKind}-${randomUUID()}`
      ),
      modelId: model.id,
      revision: (existing?.revision ?? 0) + 1,
      capability: source.capability,
      state: 'verified_supported',
      source: 'system_observed',
      parameterSchema: source.parameterSchema,
      videoGenerationSchema: source.videoGenerationSchema,
      observedAt: timestamp,
      recordedAt: timestamp,
      supersedesEvidenceId: existing?.id
    });
    await this.options.registry.save({
      ...snapshot,
      models: snapshot.models.map((candidate) =>
        candidate.id === model.id
          ? {
              ...candidate,
              revision: candidate.revision + 1,
              capabilityEvidenceId: evidence.id,
              enabled: true,
              updatedAt: timestamp
            }
          : candidate
      ),
      capabilities: [...snapshot.capabilities, evidence]
    });
  }

}

function parseApproval(value: unknown): ViduLiveValidationApprovalInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest();
  }
  const item = value as Record<string, unknown>;
  const keys = [
    'confirmLiveNetwork',
    'confirmCredentialUse',
    'confirmImageBillableAttempt',
    'confirmVideoBillableAttempt'
  ] as const;
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => item[key] !== true)
  ) {
    throw invalidRequest();
  }
  return item as unknown as ViduLiveValidationApprovalInput;
}

function modelForMedia(
  snapshot: ProviderRegistrySnapshot,
  mediaKind: ViduLiveValidationMediaKind
) {
  const providerModelKey = mediaKind === 'image'
    ? liveImageModelKey
    : liveVideoModelKey;
  return snapshot.models.find(
    (model) =>
      model.providerId === VIDU_PROVIDER_ID &&
      model.connectionId === VIDU_CONNECTION_ID &&
      model.mediaKind === mediaKind &&
      model.providerModelKey === providerModelKey
  );
}

function liveEvidence(
  snapshot: ProviderRegistrySnapshot,
  modelId: ProviderRegistrySnapshot['models'][number]['id'],
  capability: 'reference_to_image' | 'reference_to_video',
  validationId: string,
  recordedAt: ReturnType<typeof toIsoTimestamp>,
  parameterSchema: NonNullable<ModelCapabilityEvidence['parameterSchema']>,
  videoGenerationSchema?: ModelCapabilityEvidence['videoGenerationSchema']
): ModelCapabilityEvidence {
  const previous = latestEvidence(
    snapshot.capabilities,
    modelId,
    capability,
    'user_confirmed'
  );
  return createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(
      `capability-${validationId}-${capability}`
    ),
    modelId,
    revision: (previous?.revision ?? 0) + 1,
    capability,
    state: 'user_confirmed',
    source: 'user_confirmed',
    parameterSchema,
    videoGenerationSchema,
    observedAt: recordedAt,
    recordedAt,
    supersedesEvidenceId: previous?.id
  });
}

function latestEvidence(
  capabilities: readonly ModelCapabilityEvidence[],
  modelId: ModelCapabilityEvidence['modelId'],
  capability: string,
  source: ModelCapabilityEvidence['source']
): ModelCapabilityEvidence | undefined {
  return capabilities
    .filter(
      (candidate) =>
        candidate.modelId === modelId &&
        candidate.capability === capability &&
        candidate.source === source
    )
    .sort((left, right) => right.revision - left.revision)[0];
}

function upsertRoute(
  routes: ProviderRegistrySnapshot['routingPreferences'],
  id: string,
  purpose: string,
  modelId: ProviderRegistrySnapshot['models'][number]['id'],
  updatedAt: ReturnType<typeof toIsoTimestamp>
) {
  const existing = routes.find(
    (route) => route.purpose === purpose && route.modelId === modelId
  );
  const route = createRoutingPreference({
    id: existing?.id ?? toRoutingPreferenceId(id),
    purpose,
    modelId,
    priority: 0,
    enabled: true,
    updatedAt
  });
  return [...routes.filter((candidate) => candidate.id !== route.id), route];
}

function scopeMismatch(): ViduLiveValidationApplicationError {
  return new ViduLiveValidationApplicationError(
    'validation_scope_mismatch',
    'The operation is outside the approved Vidu live validation scope'
  );
}

function invalidRequest(): ViduLiveValidationApplicationError {
  return new ViduLiveValidationApplicationError(
    'invalid_request',
    'Every Vidu live validation approval must be confirmed explicitly'
  );
}
