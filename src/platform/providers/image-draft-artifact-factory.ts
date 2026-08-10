import { randomUUID } from 'node:crypto';
import {
  addExecutionToTask,
  createExecution,
  createImageTask,
  imagePurposeForMode,
  toCapabilityEvidenceId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toTaskId
} from '../../domain';
import type {
  ExecutionId,
  ImageSubmissionConfirmationSnapshot,
  ImageWorkspaceRepository,
  ProviderAccessCategory,
  Task,
  TaskId
} from '../../domain';
import type {
  JsonExecutionRepository,
  JsonTaskRepository
} from '../repositories';
import type { JsonProviderRegistryStore } from './provider-registry';
import type { SubmissionArtifactFactoryPort } from './provider-submission-orchestrator';

export interface ImageDraftArtifactFactoryDependencies {
  readonly drafts: ImageWorkspaceRepository;
  readonly tasks: JsonTaskRepository;
  readonly executions: JsonExecutionRepository;
  readonly providerRegistry: JsonProviderRegistryStore;
  nextTaskId?: () => TaskId;
  nextExecutionId?: () => ExecutionId;
}

export class ImageDraftArtifactFactory implements SubmissionArtifactFactoryPort {
  private readonly nextTaskId: () => TaskId;
  private readonly nextExecutionId: () => ExecutionId;

  constructor(private readonly dependencies: ImageDraftArtifactFactoryDependencies) {
    this.nextTaskId = dependencies.nextTaskId ??
      (() => toTaskId(`task-image-${randomUUID()}`));
    this.nextExecutionId = dependencies.nextExecutionId ??
      (() => toExecutionId(`execution-image-${randomUUID()}`));
  }

  async create(input: Parameters<SubmissionArtifactFactoryPort['create']>[0]) {
    const subject = input.subject.subject;
    if (subject.kind !== 'draft') {
      throw new TypeError('Image draft artifacts require a draft subject');
    }
    const draft = await this.dependencies.drafts.get(toDraftId(subject.draftId));
    if (!draft || draft.projectId !== input.subject.projectId) {
      throw new TypeError('Image draft is unavailable for artifact creation');
    }
    if (draft.state !== 'saved') {
      throw new TypeError('Image draft must be saved before artifact creation');
    }

    const registry = await this.dependencies.providerRegistry.load();
    const model = registry.models.find(
      (item) => item.id === input.candidate.routeTemplate.modelId
    );
    const provider = registry.providers.find(
      (item) => item.id === input.candidate.routeTemplate.providerId
    );
    if (!model || !provider) {
      throw new TypeError('Image route model capability evidence is unavailable');
    }

    const purpose = draft.input &&
      (draft.mode === 'quick_image' || draft.mode === 'professional_image')
      ? 'reference_to_image' as const
      : imagePurposeForMode(draft.mode);
    const routePurpose =
      input.candidate.routeTemplate.internalPurpose ?? purpose;
    const capabilities = registry.capabilities ?? [];
    const evidence =
      capabilities.find(
        (item) =>
          item.modelId === model.id && item.capability === routePurpose
      ) ??
      (model.capabilityEvidenceId
        ? capabilities.find((item) => item.id === model.capabilityEvidenceId)
        : undefined);
    const evidenceId = evidence?.id ?? model.capabilityEvidenceId;
    if (!evidenceId || (evidence && evidence.modelId !== model.id)) {
      throw new TypeError('Image route model capability evidence is unavailable');
    }
    const confirmation: ImageSubmissionConfirmationSnapshot = {
      mode: draft.mode,
      purpose,
      modelId: input.candidate.routeTemplate.modelId,
      capabilityEvidenceId: toCapabilityEvidenceId(evidenceId),
      providerId: input.candidate.routeTemplate.providerId,
      connectionId: input.candidate.routeTemplate.connectionId,
      recipientName: input.candidate.recipientName,
      accessCategory: provider.accessCategory as ProviderAccessCategory,
      outboundScope: input.candidate.outboundScope,
      costState: 'unknown',
      privacyState: 'unknown',
      regionState: 'unknown',
      parameters: { ...input.subject.parameterValues },
      ...(draft.mode === 'image_editing' && draft.editing.lineage?.parentWorkId
        ? { parentWorkId: draft.editing.lineage.parentWorkId }
        : {}),
      confirmations: {
        recipient: true,
        outboundScope: true,
        cost: true,
        finalPrompt: true,
        model: true
      }
    };

    const createdAt = toIsoTimestamp(input.createdAt);
    const task = createImageTask({
      id: this.nextTaskId(),
      draft,
      confirmation,
      confirmedAt: createdAt
    });
    const execution = createExecution({
      id: this.nextExecutionId(),
      taskId: task.id,
      createdAt
    });
    const linked: Task = addExecutionToTask(task, execution);
    await this.dependencies.executions.save(execution);
    await this.dependencies.tasks.save(linked);

    const assetId = draft.input?.assetId;
    return {
      subjectArtifacts: {
        kind: 'media' as const,
        task: linked,
        execution
      },
      dispatchRequest: {
        invocationAttemptId: input.invocationAttemptId,
        projectId: input.subject.projectId,
        prompt: input.subject.outboundTextSnapshot,
        taskId: linked.id,
        executionId: execution.id,
        ...(assetId ? { assetId } : {}),
        parameterValues: input.subject.parameterValues
      }
    };
  }
}
