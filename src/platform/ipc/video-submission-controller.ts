import { randomUUID } from 'node:crypto';
import {
  addExecutionToTask,
  createExecution,
  createRetryExecution,
  createVideoTask,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toTaskId,
  transitionExecution,
  type Execution,
  type Task,
  type VideoSubmissionConfirmationSnapshot,
  type VideoSubmissionModeInput,
  type VideoWorkspaceDraft
} from '../../domain';
import type {
  VideoExecutionDto,
  VideoPreflightDto,
  VideoSubmissionErrorCode,
  VideoSubmissionResult,
  VideoTaskCreatedDto,
  VideoWorkRegisteredDto
} from '../../shared/video-submission-ipc';
import {
  buildVideoPreflight,
  parameterValuesForVideoDraft,
  videoMaterialSelections,
  VideoOperationPortError,
  type VideoGenerationSubmitPort,
  type VideoMaterialFact
} from '../videos';
import type { JsonProviderRegistryStore } from '../providers';
import {
  JsonAssetRepository,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonVideoWorkspaceRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';
import type { VideoWorkspaceMutationCoordinator } from './video-workspace-mutations';

export interface VideoSubmissionControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  providerRegistry: JsonProviderRegistryStore;
  mutations: VideoWorkspaceMutationCoordinator;
  operationPort?: VideoGenerationSubmitPort;
  resultReceiver?: {
    receive(
      executionId: string
    ): Promise<VideoSubmissionResult<VideoWorkRegisteredDto>>;
  };
  createTaskId?(): string;
  createExecutionId?(): string;
  now?(): string;
  onError?(error: unknown): void;
}

export class VideoSubmissionController {
  constructor(
    private readonly dependencies: VideoSubmissionControllerDependencies
  ) {}

  preflight(
    request: unknown
  ): Promise<VideoSubmissionResult<VideoPreflightDto>> {
    return this.execute(async () => {
      await this.dependencies.mutations.wait();
      const draftId = parseId(request, 'draftId', toDraftId);
      const context = this.createContext();
      const draft = await context.workspaceRepository.get(draftId);
      if (!draft) throw submissionError('draft_not_found', 'Video draft not found');
      return this.withAdapterAvailability(
        buildVideoPreflight(
          draft,
          await this.dependencies.providerRegistry.load(),
          await loadMaterialFacts(draft, context)
        )
      );
    });
  }

  createTask(
    request: unknown
  ): Promise<VideoSubmissionResult<VideoTaskCreatedDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const parsed = parseTaskRequest(request);
        const context = this.createContext();
        const draft = await context.workspaceRepository.get(parsed.draftId);
        if (!draft) throw submissionError('draft_not_found', 'Video draft not found');
        if (draft.updatedAt !== parsed.draftUpdatedAt) {
          throw submissionError(
            'draft_not_submittable',
            'Video draft changed after preflight'
          );
        }
        if (!allConfirmationsAccepted(parsed.confirmations)) {
          throw submissionError(
            'confirmation_required',
            'Every video submission fact must be confirmed explicitly'
          );
        }

        const preflight = this.withAdapterAvailability(
          buildVideoPreflight(
            draft,
            await this.dependencies.providerRegistry.load(),
            await loadMaterialFacts(draft, context)
          )
        );
        const candidate = preflight.candidates.find(
          (item) => item.modelId === parsed.modelId
        );
        const blocker = preflight.blockers[0] ?? candidate?.blockers[0];
        if (!candidate || blocker) {
          throw submissionError(
            blocker ?? 'no_route_candidate',
            'Video submission preflight is blocked'
          );
        }

        const confirmedAt = this.now();
        const materials = videoMaterialSelections(draft).map((item) => ({
          assetId: item.selection.assetId,
          mediaKind: item.selection.mediaKind,
          role: item.selection.role,
          target: { ...item.target }
        }));
        const confirmation: VideoSubmissionConfirmationSnapshot = {
          mode: draft.mode,
          purpose: 'video_generation',
          modelId: candidate.modelId as VideoSubmissionConfirmationSnapshot['modelId'],
          capabilityEvidenceId:
            candidate.capabilityEvidenceId as VideoSubmissionConfirmationSnapshot['capabilityEvidenceId'],
          providerId:
            candidate.providerId as VideoSubmissionConfirmationSnapshot['providerId'],
          connectionId:
            candidate.connectionId as VideoSubmissionConfirmationSnapshot['connectionId'],
          recipientName: candidate.recipientName,
          accessCategory: candidate.accessCategory,
          outboundScope: candidate.outboundScope,
          costState: 'unknown',
          privacyState: 'unknown',
          regionState: 'unknown',
          parameters: parameterValuesForVideoDraft(draft).values,
          materials,
          contextReferences: draft.contextReferences.map((reference) => ({
            ...reference
          })),
          input: modeInputForDraft(draft),
          confirmations: {
            recipient: true,
            outboundScope: true,
            materials: true,
            costPrivacyRegion: true,
            finalPrompt: true,
            model: true
          }
        };
        const task = createVideoTask({
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
  ): Promise<VideoSubmissionResult<VideoExecutionDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const taskId = parseId(request, 'taskId', toTaskId);
        const context = this.createContext();
        const task = await requireTask(context.taskRepository, taskId);
        if (!task.submission.video) {
          throw submissionError('invalid_request', 'Task is not a video task');
        }
        const previous = await latestExecution(context.executionRepository, task);
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
  ): Promise<VideoSubmissionResult<VideoExecutionDto>> {
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
        if (!task.submission.video) {
          throw submissionError('invalid_request', 'Task is not a video task');
        }
        if (!this.dependencies.operationPort) {
          throw submissionError(
            'adapter_unavailable',
            'No remote adapter is configured for video generation'
          );
        }

        const submitting = transitionExecution(execution, 'submitting', this.now());
        await context.executionRepository.save(submitting);
        try {
          const remote = await this.dependencies.operationPort.submit({
            task,
            execution: submitting
          });
          if (remote.remoteOperationId.trim().length === 0) {
            throw new VideoOperationPortError(
              'not_retryable',
              'Remote adapter returned an invalid operation ID'
            );
          }
          const submitted = transitionExecution(
            submitting,
            remote.state,
            this.now(),
            { remoteOperationId: remote.remoteOperationId }
          );
          await context.executionRepository.save(submitted);
          return toExecutionDto(submitted);
        } catch (error) {
          const failure = transitionExecution(submitting, 'failed', this.now(), {
            failure: {
              stage: 'submitting',
              message: 'The remote video generation could not be submitted',
              retryability:
                error instanceof VideoOperationPortError
                  ? error.retryability
                  : 'unknown'
            }
          });
          await context.executionRepository.save(failure);
          return toExecutionDto(failure);
        }
      })
    );
  }

  async receiveResult(
    request: unknown
  ): Promise<VideoSubmissionResult<VideoWorkRegisteredDto>> {
    try {
      const executionId = parseId(request, 'executionId', toExecutionId);
      if (!this.dependencies.resultReceiver) {
        return {
          ok: false,
          error: {
            code: 'adapter_unavailable',
            message: 'No result adapter is configured for video generation'
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
      workspaceRepository: new JsonVideoWorkspaceRepository(
        storage,
        session.projectId
      ),
      assetRepository: new JsonAssetRepository(storage, session.projectId),
      fileRepository: new JsonFileReferenceRepository(storage, session.projectId),
      taskRepository: new JsonTaskRepository(storage, session.projectId),
      executionRepository: new JsonExecutionRepository(storage)
    };
  }

  private withAdapterAvailability(preflight: VideoPreflightDto): VideoPreflightDto {
    if (this.dependencies.operationPort) return preflight;
    return {
      ...preflight,
      blockers: preflight.blockers.includes('adapter_unavailable')
        ? preflight.blockers
        : [...preflight.blockers, 'adapter_unavailable']
    };
  }

  private createTaskId() {
    return toTaskId(
      this.dependencies.createTaskId?.() ?? `task-video-${randomUUID()}`
    );
  }

  private createExecutionId() {
    return toExecutionId(
      this.dependencies.createExecutionId?.() ?? `execution-video-${randomUUID()}`
    );
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<VideoSubmissionResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapSubmissionError(error) };
    }
  }
}

type VideoSubmissionContext = ReturnType<VideoSubmissionController['createContext']>;

async function loadMaterialFacts(
  draft: VideoWorkspaceDraft,
  context: VideoSubmissionContext
): Promise<readonly VideoMaterialFact[]> {
  const facts: VideoMaterialFact[] = [];
  for (const { selection } of videoMaterialSelections(draft)) {
    const asset = await context.assetRepository.get(selection.assetId);
    if (!asset) continue;
    const file = await context.fileRepository.get(asset.fileId);
    if (!file) continue;
    facts.push({
      assetId: asset.id,
      mediaKind: asset.mediaKind === 'video' ? 'video' : 'image',
      role: asset.role,
      fileState: file.state,
      metadataAvailable:
        asset.mediaKind === 'image'
          ? asset.imageMetadata !== undefined
          : asset.mediaKind === 'video' && asset.videoMetadata !== undefined
    });
  }
  return facts;
}

function modeInputForDraft(
  draft: VideoWorkspaceDraft
): VideoSubmissionModeInput {
  if (draft.mode === 'quick_video') return { mode: draft.mode };
  if (draft.mode === 'text_to_video') {
    return {
      mode: draft.mode,
      sourceKind: draft.textToVideo.sourceKind,
      shots: draft.textToVideo.shots.map((shot) => ({ ...shot }))
    };
  }
  return {
    mode: draft.mode,
    mustKeep: [...draft.imageToVideo.mustKeep],
    allowedChanges: [...draft.imageToVideo.allowedChanges],
    prohibited: [...draft.imageToVideo.prohibited],
    subjectAction: draft.imageToVideo.subjectAction,
    cameraMovement: draft.imageToVideo.cameraMovement,
    pace: draft.imageToVideo.pace,
    depthOfField: draft.imageToVideo.depthOfField
  };
}

class VideoSubmissionControllerError extends Error {
  constructor(
    readonly code: VideoSubmissionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoSubmissionControllerError';
  }
}

function parseTaskRequest(request: unknown) {
  if (!isRecord(request)) {
    throw submissionError('invalid_request', 'Submission request is invalid');
  }
  return {
    draftId: parseId(request, 'draftId', toDraftId),
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
  if (!isRecord(request)) {
    throw submissionError('invalid_request', `${field} is required`);
  }
  try {
    return convert(requireString(request[field]));
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
    value.recipient === true &&
    value.outboundScope === true &&
    value.materials === true &&
    value.costPrivacyRegion === true &&
    value.finalPrompt === true &&
    value.model === true
  );
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

function toExecutionDto(execution: Execution): VideoExecutionDto {
  return {
    executionId: execution.id,
    taskId: execution.taskId,
    attempt: execution.attempt,
    state: execution.state,
    retryability: execution.failure?.retryability
  };
}

function submissionError(
  code: VideoSubmissionErrorCode,
  message: string
): VideoSubmissionControllerError {
  return new VideoSubmissionControllerError(code, message);
}

function mapSubmissionError(error: unknown): {
  readonly code: VideoSubmissionErrorCode;
  readonly message: string;
} {
  if (error instanceof VideoSubmissionControllerError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'submission_storage_error',
    message: 'The local video submission operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
