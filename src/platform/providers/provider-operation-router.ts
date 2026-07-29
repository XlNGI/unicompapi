import type {
  Execution,
  ModelCapabilityEvidence,
  ProviderMediaKind,
  ProviderModel,
  ProviderOperationPurpose,
  ProviderProtocolBinding,
  ProviderSubmitOutcome,
  Task
} from '../../domain';
import type { JsonProviderRegistryStore } from './provider-registry';

export type ProviderOperationRouterErrorCode =
  | 'operation_model_mismatch'
  | 'protocol_binding_not_found'
  | 'capability_evidence_not_found'
  | 'capability_unverified'
  | 'connection_unavailable'
  | 'adapter_unavailable'
  | 'adapter_contract_violation';

export type ProviderOperationRouterResult =
  | { readonly ok: true; readonly value: ProviderSubmitOutcome }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ProviderOperationRouterErrorCode;
        readonly message: string;
      };
    };

export interface ProviderProtocolSubmitRequest {
  readonly task: Task;
  readonly execution: Execution;
  readonly model: ProviderModel;
  readonly binding: ProviderProtocolBinding;
  readonly evidence: ModelCapabilityEvidence;
}

export interface ProviderProtocolSubmitPort {
  submit(request: ProviderProtocolSubmitRequest): Promise<ProviderSubmitOutcome>;
}

export type ProviderProtocolAdapters = Readonly<
  Record<string, ProviderProtocolSubmitPort | undefined>
>;

export class ImageOperationRouter {
  constructor(
    private readonly registry: JsonProviderRegistryStore,
    private readonly adapters: ProviderProtocolAdapters
  ) {}

  submit(input: {
    readonly task: Task;
    readonly execution: Execution;
  }): Promise<ProviderOperationRouterResult> {
    return routeOperation(
      this.registry,
      this.adapters,
      'image',
      input.task,
      input.execution
    );
  }
}

export class VideoOperationRouter {
  constructor(
    private readonly registry: JsonProviderRegistryStore,
    private readonly adapters: ProviderProtocolAdapters
  ) {}

  submit(input: {
    readonly task: Task;
    readonly execution: Execution;
  }): Promise<ProviderOperationRouterResult> {
    return routeOperation(
      this.registry,
      this.adapters,
      'video',
      input.task,
      input.execution
    );
  }
}

async function routeOperation(
  registry: JsonProviderRegistryStore,
  adapters: ProviderProtocolAdapters,
  expectedMediaKind: Exclude<ProviderMediaKind, 'unknown'>,
  task: Task,
  execution: Execution
): Promise<ProviderOperationRouterResult> {
  if (execution.taskId !== task.id) {
    return failure(
      'operation_model_mismatch',
      'Execution and task do not describe the same operation'
    );
  }
  const operation = operationForTask(task, expectedMediaKind);
  if (!operation) {
    return failure(
      'operation_model_mismatch',
      `The task is not a ${expectedMediaKind} operation`
    );
  }

  const snapshot = await registry.load();
  const model = snapshot.models.find((candidate) => candidate.id === operation.modelId);
  if (
    !model ||
    model.mediaKind !== expectedMediaKind ||
    model.providerId !== operation.providerId ||
    model.connectionId !== operation.connectionId
  ) {
    return failure(
      'operation_model_mismatch',
      'The selected model does not match the operation media type'
    );
  }
  const binding = snapshot.protocolBindings.find(
    (candidate) => candidate.id === model.protocolBindingId
  );
  if (!binding) {
    return failure(
      'protocol_binding_not_found',
      'The selected model has no protocol binding'
    );
  }
  if (
    binding.mediaKind !== expectedMediaKind ||
    binding.providerId !== model.providerId ||
    binding.connectionId !== model.connectionId ||
    !binding.supportedPurposes.includes(operation.purpose)
  ) {
    return failure(
      'operation_model_mismatch',
      'The selected protocol does not support this operation'
    );
  }
  const connection = snapshot.connections.find(
    (candidate) => candidate.id === model.connectionId
  );
  if (!model.enabled || connection?.state !== 'available') {
    return failure(
      'connection_unavailable',
      'The selected model connection is unavailable'
    );
  }
  const evidence = snapshot.capabilities.find(
    (candidate) => candidate.id === operation.capabilityEvidenceId
  );
  if (!evidence || evidence.modelId !== model.id) {
    return failure(
      'capability_evidence_not_found',
      'The selected capability evidence does not belong to the model'
    );
  }
  if (
    evidence.capability !== operation.purpose ||
    (evidence.state !== 'verified_supported' &&
      evidence.state !== 'user_confirmed')
  ) {
    return failure(
      'capability_unverified',
      'The selected capability evidence does not authorize this operation'
    );
  }
  if (
    expectedMediaKind === 'video' &&
    task.submission.video &&
    (!evidence.videoGenerationSchema ||
      !evidence.videoGenerationSchema.modes.some(
        (mode) => mode.mode === task.submission.video?.mode
      ))
  ) {
    return failure(
      'capability_unverified',
      'The capability evidence does not support the requested video mode'
    );
  }

  const adapter = adapters[binding.adapterKind];
  if (!adapter) {
    return failure('adapter_unavailable', 'The protocol adapter is unavailable');
  }
  const outcome = await adapter.submit({
    task,
    execution,
    model,
    binding,
    evidence
  });
  if (!outcomeMatchesLifecycle(outcome, binding)) {
    return failure(
      'adapter_contract_violation',
      'The adapter outcome does not match the protocol lifecycle'
    );
  }
  return { ok: true, value: outcome };
}

function operationForTask(
  task: Task,
  expectedMediaKind: Exclude<ProviderMediaKind, 'unknown'>
): {
  readonly modelId: ProviderModel['id'];
  readonly capabilityEvidenceId: ModelCapabilityEvidence['id'];
  readonly providerId: ProviderModel['providerId'];
  readonly connectionId: ProviderModel['connectionId'];
  readonly purpose: ProviderOperationPurpose;
} | undefined {
  if (
    expectedMediaKind === 'image' &&
    task.submission.image &&
    imageTaskKindMatchesPurpose(
      task.submission.kind,
      task.submission.image.purpose
    )
  ) {
    return {
      modelId: task.submission.image.modelId,
      capabilityEvidenceId: task.submission.image.capabilityEvidenceId,
      providerId: task.submission.image.providerId,
      connectionId: task.submission.image.connectionId,
      purpose: task.submission.image.purpose
    };
  }
  if (
    expectedMediaKind === 'video' &&
    task.submission.kind === 'video_generation' &&
    task.submission.video?.purpose === 'video_generation'
  ) {
    const purpose = task.submission.video.materials.length === 1 &&
      task.submission.video.materials[0]?.mediaKind === 'image'
      ? 'reference_to_video'
      : 'video_generation';
    return {
      modelId: task.submission.video.modelId,
      capabilityEvidenceId: task.submission.video.capabilityEvidenceId,
      providerId: task.submission.video.providerId,
      connectionId: task.submission.video.connectionId,
      purpose
    };
  }
  return undefined;
}

function imageTaskKindMatchesPurpose(
  kind: Task['submission']['kind'],
  purpose: ProviderOperationPurpose
): boolean {
  switch (purpose) {
    case 'image_generation':
      return kind === 'image_generation';
    case 'image_understanding':
      return kind === 'image_analysis';
    case 'image_editing':
      return kind === 'image_editing';
    case 'image_to_prompt':
      return kind === 'image_to_prompt';
    default:
      return false;
  }
}

function outcomeMatchesLifecycle(
  outcome: ProviderSubmitOutcome,
  binding: ProviderProtocolBinding
): boolean {
  if (binding.executionLifecycle === 'asynchronous_polling') {
    return (
      outcome.kind === 'accepted_async' ||
      outcome.kind === 'submission_outcome_unknown' ||
      outcome.kind === 'failed_before_submission'
    );
  }
  if (binding.executionLifecycle === 'synchronous_completed') {
    return (
      outcome.kind === 'completed_sync' ||
      outcome.kind === 'submission_outcome_unknown' ||
      outcome.kind === 'failed_before_submission'
    );
  }
  return false;
}

function failure(
  code: ProviderOperationRouterErrorCode,
  message: string
): ProviderOperationRouterResult {
  return { ok: false, error: { code, message } };
}
