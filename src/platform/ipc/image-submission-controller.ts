import { randomUUID } from 'node:crypto';
import {
  addExecutionToTask,
  createExecution,
  createImageTask,
  createRetryExecution,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toProviderOperationRecordId,
  toTaskId,
  transitionExecution,
  type Execution,
  type ImageSubmissionConfirmationSnapshot,
  type ProviderExecutionLifecycle,
  type ProviderSubmitOutcome,
  type Task
} from '../../domain';
import type {
  ImageExecutionDto,
  ImagePreflightDto,
  ImageSubmissionErrorCode,
  ImageSubmissionResult,
  ImageTaskCreatedDto,
  ImageWorkRegisteredDto
} from '../../shared/image-submission-ipc';
import {
  buildImagePreflight,
  ImageOperationPortError,
  parameterValuesForDraft,
  type ImageOperationSubmitResult,
  type ImageOperationPorts
} from '../images';
import type { JsonProviderRegistryStore } from '../providers';
import { ProviderExecutionLifecycleService } from '../providers';
import {
  JsonExecutionRepository,
  JsonImageWorkspaceRepository,
  JsonProviderOperationRepository,
  JsonTaskRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { ImageWorkspaceMutationCoordinator } from './image-workspace-mutations';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ImageResultReceiver {
  receive(executionId: string): Promise<ImageSubmissionResult<ImageWorkRegisteredDto>>;
}

export interface ImageSubmissionControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  providerRegistry: JsonProviderRegistryStore;
  mutations: ImageWorkspaceMutationCoordinator;
  operationPorts?: ImageOperationPorts;
  resultReceiver?: ImageResultReceiver;
  createTaskId?(): string;
  createExecutionId?(): string;
  createProviderOperationRecordId?(): string;
  now?(): string;
  onError?(error: unknown): void;
}

export class ImageSubmissionController {
  constructor(
    private readonly dependencies: ImageSubmissionControllerDependencies
  ) {}

  preflight(
    request: unknown
  ): Promise<ImageSubmissionResult<ImagePreflightDto>> {
    return this.execute(async () => {
      await this.dependencies.mutations.wait();
      const draftId = parseId(request, 'draftId', toDraftId);
      const context = this.createContext();
      const draft = await context.workspaceRepository.get(draftId);
      if (!draft) throw submissionError('draft_not_found', 'Image draft not found');
      return this.withAdapterAvailability(
        buildImagePreflight(
          draft,
          await this.dependencies.providerRegistry.load()
        )
      );
    });
  }

  createTask(
    request: unknown
  ): Promise<ImageSubmissionResult<ImageTaskCreatedDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const parsed = parseTaskRequest(request);
        const context = this.createContext();
        const draft = await context.workspaceRepository.get(parsed.draftId);
        if (!draft) throw submissionError('draft_not_found', 'Image draft not found');
        if (draft.updatedAt !== parsed.draftUpdatedAt) {
          throw submissionError(
            'draft_not_submittable',
            'Image draft changed after preflight'
          );
        }
        if (!allConfirmationsAccepted(parsed.confirmations)) {
          throw submissionError(
            'confirmation_required',
            'Every submission fact must be confirmed explicitly'
          );
        }

        const preflight = this.withAdapterAvailability(
          buildImagePreflight(
            draft,
            await this.dependencies.providerRegistry.load()
          )
        );
        const candidate = preflight.candidates.find(
          (item) => item.modelId === parsed.modelId
        );
        if (!candidate || preflight.blockers.length > 0) {
          throw submissionError(
            preflight.blockers[0] ?? 'no_route_candidate',
            'Image submission preflight is blocked'
          );
        }

        const confirmedAt = this.now();
        const parameters = parameterValuesForDraft(draft).values;
        const confirmation: ImageSubmissionConfirmationSnapshot = {
          mode: draft.mode,
          purpose: preflight.purpose,
          modelId: candidate.modelId as ImageSubmissionConfirmationSnapshot['modelId'],
          capabilityEvidenceId:
            candidate.capabilityEvidenceId as ImageSubmissionConfirmationSnapshot['capabilityEvidenceId'],
          providerId:
            candidate.providerId as ImageSubmissionConfirmationSnapshot['providerId'],
          connectionId:
            candidate.connectionId as ImageSubmissionConfirmationSnapshot['connectionId'],
          recipientName: candidate.recipientName,
          accessCategory: candidate.accessCategory,
          outboundScope: candidate.outboundScope,
          costState: 'unknown',
          privacyState: 'unknown',
          regionState: 'unknown',
          parameters,
          parentWorkId:
            draft.mode === 'image_editing'
              ? draft.editing.lineage?.parentWorkId
              : undefined,
          confirmations: {
            recipient: true,
            outboundScope: true,
            cost: true,
            finalPrompt: true,
            model: true
          }
        };
        const task = createImageTask({
          id: this.createTaskId(),
          draft,
          confirmation,
          confirmedAt
        });
        await context.taskRepository.save(task);
        return {
          taskId: task.id,
          draftId: draft.id,
          modelId: candidate.modelId,
          confirmedAt
        };
      })
    );
  }

  createExecution(
    request: unknown
  ): Promise<ImageSubmissionResult<ImageExecutionDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const taskId = parseId(request, 'taskId', toTaskId);
        const context = this.createContext();
        const task = await requireTask(context.taskRepository, taskId);
        if (!task.submission.image) {
          throw submissionError('invalid_request', 'Task is not an image task');
        }
        const previous = await latestExecution(context.executionRepository, task);
        if (previous?.state === 'submission_outcome_unknown') {
          throw submissionError(
            'submission_outcome_unknown',
            'The previous paid submission outcome is unknown; create and confirm a new task before retrying'
          );
        }
        const createdAt = this.now();
        const execution = previous
          ? createRetryExecution(previous, this.createExecutionId(), createdAt)
          : createExecution({
              id: this.createExecutionId(),
              taskId: task.id,
              createdAt
            });
        const updatedTask = addExecutionToTask(task, execution);
        await context.executionRepository.save(execution);
        await context.taskRepository.save(updatedTask);
        return toExecutionDto(execution);
      })
    );
  }

  invokeExecution(
    request: unknown
  ): Promise<ImageSubmissionResult<ImageExecutionDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const executionId = parseId(request, 'executionId', toExecutionId);
        const context = this.createContext();
        const execution = await context.executionRepository.get(executionId);
        if (!execution) {
          throw submissionError('execution_not_found', 'Execution not found');
        }
        if (execution.state !== 'created') {
          throw submissionError(
            'invalid_execution_state',
            'Execution is not ready for submission'
          );
        }
        const task = await requireTask(context.taskRepository, execution.taskId);
        const image = task.submission.image;
        if (!image) throw submissionError('invalid_request', 'Task is not an image task');
        const port = this.dependencies.operationPorts?.[image.purpose];
        if (!port) {
          throw submissionError(
            'adapter_unavailable',
            'No remote adapter is configured for this image operation'
          );
        }

        const submitting = transitionExecution(execution, 'submitting', this.now());
        await context.executionRepository.save(submitting);
        let outcome: ProviderSubmitOutcome;
        try {
          outcome = normalizeImageSubmitOutcome(
            await port.submit({ task, execution: submitting })
          );
        } catch (error) {
          outcome = submitFailureOutcome(error, 'image');
        }
        const registry = await this.dependencies.providerRegistry.load();
        const executionLifecycle = lifecycleForModel(
          registry,
          image.modelId
        );
        const lifecycle = new ProviderExecutionLifecycleService({
          executionRepository: context.executionRepository,
          operationRepository: context.operationRepository,
          createRecordId: () => this.createProviderOperationRecordId(),
          now: () => this.now()
        });
        return toExecutionDto(
          await lifecycle.applySubmitOutcome({
            task,
            execution: submitting,
            mediaKind: 'image',
            executionLifecycle,
            outcome
          })
        );
      })
    );
  }

  async receiveResult(
    request: unknown
  ): Promise<ImageSubmissionResult<ImageWorkRegisteredDto>> {
    try {
      const executionId = parseId(request, 'executionId', toExecutionId);
      if (!this.dependencies.resultReceiver) {
        return {
          ok: false,
          error: {
            code: 'adapter_unavailable',
            message: 'No result adapter is configured for image operations'
          }
        };
      }
      return await this.dependencies.resultReceiver.receive(executionId);
    } catch (error) {
      return { ok: false, error: mapSubmissionError(error) };
    }
  }

  private createContext() {
    const session = this.dependencies.getSession();
    if (!session) {
      throw submissionError('project_not_open', 'No project is currently open');
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      workspaceRepository: new JsonImageWorkspaceRepository(
        storage,
        session.projectId
      ),
      taskRepository: new JsonTaskRepository(storage, session.projectId),
      executionRepository: new JsonExecutionRepository(storage),
      operationRepository: new JsonProviderOperationRepository(storage)
    };
  }

  private withAdapterAvailability(preflight: ImagePreflightDto): ImagePreflightDto {
    if (this.dependencies.operationPorts?.[preflight.purpose]) {
      return preflight;
    }
    return {
      ...preflight,
      blockers: preflight.blockers.includes('adapter_unavailable')
        ? preflight.blockers
        : [...preflight.blockers, 'adapter_unavailable']
    };
  }

  private createTaskId() {
    return toTaskId(
      this.dependencies.createTaskId?.() ?? `task-image-${randomUUID()}`
    );
  }

  private createExecutionId() {
    return toExecutionId(
      this.dependencies.createExecutionId?.() ?? `execution-image-${randomUUID()}`
    );
  }

  private createProviderOperationRecordId() {
    return toProviderOperationRecordId(
      this.dependencies.createProviderOperationRecordId?.() ??
        `provider-operation-image-${randomUUID()}`
    );
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<ImageSubmissionResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapSubmissionError(error) };
    }
  }
}

class ImageSubmissionControllerError extends Error {
  constructor(
    readonly code: ImageSubmissionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageSubmissionControllerError';
  }
}

function parseTaskRequest(request: unknown) {
  if (!hasExactKeys(request, ['draftId', 'draftUpdatedAt', 'modelId', 'confirmations'])) {
    throw submissionError('invalid_request', 'Submission request is invalid');
  }
  return {
    draftId: parseIdValue(request.draftId, 'draftId', toDraftId),
    draftUpdatedAt: requireString(request.draftUpdatedAt),
    modelId: requireString(request.modelId),
    confirmations: isRecord(request.confirmations) ? request.confirmations : {}
  };
}

function parseId<TValue>(
  request: unknown,
  field: string,
  convert: (value: string) => TValue
): TValue {
  if (!hasExactKeys(request, [field])) {
    throw submissionError('invalid_request', `${field} is required`);
  }
  return parseIdValue(request[field], field, convert);
}

function parseIdValue<TValue>(
  value: unknown,
  field: string,
  convert: (value: string) => TValue
): TValue {
  try {
    return convert(requireString(value));
  } catch {
    throw submissionError('invalid_request', `${field} is invalid`);
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw submissionError('invalid_request', 'A non-empty string is required');
  }
  return value;
}

function allConfirmationsAccepted(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, [
      'recipient',
      'outboundScope',
      'cost',
      'finalPrompt',
      'model'
    ]) &&
    value.recipient === true &&
    value.outboundScope === true &&
    value.cost === true &&
    value.finalPrompt === true &&
    value.model === true
  );
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

async function requireTask(
  repository: JsonTaskRepository,
  taskId: ReturnType<typeof toTaskId>
): Promise<Task> {
  const task = await repository.get(taskId);
  if (!task) throw submissionError('task_not_found', 'Task not found');
  return task;
}

async function latestExecution(
  repository: JsonExecutionRepository,
  task: Task
): Promise<Execution | undefined> {
  const executions = await repository.list(task.id);
  return [...executions].sort(
    (left, right) => right.attempt - left.attempt
  )[0];
}

function toExecutionDto(execution: Execution): ImageExecutionDto {
  return {
    executionId: execution.id,
    taskId: execution.taskId,
    attempt: execution.attempt,
    state: execution.state,
    retryability: execution.failure?.retryability
  };
}

function normalizeImageSubmitOutcome(
  result: ImageOperationSubmitResult
): ProviderSubmitOutcome {
  if ('kind' in result) return result;
  if (result.remoteOperationId.trim().length === 0) {
    throw new ImageOperationPortError(
      'not_retryable',
      'Remote adapter returned an invalid operation ID'
    );
  }
  return {
    kind: 'accepted_async',
    providerOperationId: result.remoteOperationId,
    state: result.state
  };
}

function submitFailureOutcome(
  error: unknown,
  mediaKind: 'image'
): ProviderSubmitOutcome {
  const message = `The remote ${mediaKind} operation could not be submitted`;
  if (
    error instanceof ImageOperationPortError &&
    error.submissionStatus === 'submission_outcome_unknown'
  ) {
    return {
      kind: 'submission_outcome_unknown',
      message
    };
  }
  return {
    kind: 'failed_before_submission',
    message,
    retryability:
      error instanceof ImageOperationPortError
        ? error.retryability
        : 'unknown'
  };
}

function lifecycleForModel(
  registry: Awaited<ReturnType<JsonProviderRegistryStore['load']>>,
  modelId: string
): ProviderExecutionLifecycle {
  const model = registry.models.find((candidate) => candidate.id === modelId);
  const binding = model
    ? registry.protocolBindings.find(
        (candidate) => candidate.id === model.protocolBindingId
      )
    : undefined;
  if (!binding) {
    throw submissionError(
      'no_route_candidate',
      'The selected model has no provider protocol lifecycle'
    );
  }
  return binding.executionLifecycle;
}

function submissionError(
  code: ImageSubmissionErrorCode,
  message: string
): ImageSubmissionControllerError {
  return new ImageSubmissionControllerError(code, message);
}

function mapSubmissionError(error: unknown): {
  readonly code: ImageSubmissionErrorCode;
  readonly message: string;
} {
  if (error instanceof ImageSubmissionControllerError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'submission_storage_error',
    message: 'The local image submission operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
