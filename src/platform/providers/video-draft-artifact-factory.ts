import { randomUUID } from 'node:crypto';
import {
  addExecutionToTask,
  createExecution,
  createVideoTask,
  toCapabilityEvidenceId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toTaskId
} from '../../domain';
import type {
  ExecutionId,
  ProviderAccessCategory,
  Task,
  TaskId,
  VideoSubmissionConfirmationSnapshot,
  VideoWorkspaceDraft,
  VideoWorkspaceRepository
} from '../../domain';
import type {
  JsonExecutionRepository,
  JsonTaskRepository
} from '../repositories';
import type { JsonProviderRegistryStore } from './provider-registry';
import type { SubmissionArtifactFactoryPort } from './provider-submission-orchestrator';

export interface VideoDraftArtifactFactoryDependencies {
  readonly drafts: VideoWorkspaceRepository;
  readonly tasks: JsonTaskRepository;
  readonly executions: JsonExecutionRepository;
  readonly providerRegistry: JsonProviderRegistryStore;
  nextTaskId?: () => TaskId;
  nextExecutionId?: () => ExecutionId;
}

export class VideoDraftArtifactFactory implements SubmissionArtifactFactoryPort {
  private readonly nextTaskId: () => TaskId;
  private readonly nextExecutionId: () => ExecutionId;

  constructor(private readonly dependencies: VideoDraftArtifactFactoryDependencies) {
    this.nextTaskId = dependencies.nextTaskId ??
      (() => toTaskId(`task-video-${randomUUID()}`));
    this.nextExecutionId = dependencies.nextExecutionId ??
      (() => toExecutionId(`execution-video-${randomUUID()}`));
  }

  async create(input: Parameters<SubmissionArtifactFactoryPort['create']>[0]) {
    const subject = input.subject.subject;
    if (subject.kind !== 'draft') {
      throw new TypeError('Video draft artifacts require a draft subject');
    }
    const draft = await this.dependencies.drafts.get(toDraftId(subject.draftId));
    if (!draft || draft.projectId !== input.subject.projectId) {
      throw new TypeError('Video draft is unavailable for artifact creation');
    }
    if (draft.state !== 'saved') {
      throw new TypeError('Video draft must be saved before artifact creation');
    }

    const registry = await this.dependencies.providerRegistry.load();
    const model = registry.models.find(
      (item) => item.id === input.candidate.routeTemplate.modelId
    );
    const provider = registry.providers.find(
      (item) => item.id === input.candidate.routeTemplate.providerId
    );
    const evidenceId = model?.capabilityEvidenceId;
    if (!model || !provider || !evidenceId) {
      throw new TypeError('Video route model capability evidence is unavailable');
    }

    // Domain createVideoTask freezes materials against draft sources/slots.
    // Feature-path parameterValues still go out via dispatchRequest.
    const confirmation: VideoSubmissionConfirmationSnapshot = {
      mode: draft.mode,
      purpose: 'video_generation',
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
      parameters: { ...(draft.generation.parameters?.values ?? {}) },
      materials: materialsMatchingDraft(draft),
      contextReferences: draft.contextReferences.map((reference) => ({ ...reference })),
      input: modeInputMatchingDraft(draft),
      confirmations: {
        recipient: true,
        outboundScope: true,
        materials: true,
        costPrivacyRegion: true,
        finalPrompt: true,
        model: true
      }
    };

    const createdAt = toIsoTimestamp(input.createdAt);
    const task = createVideoTask({
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

    const assetId = sourceAssetId(draft);
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

function sourceAssetId(draft: VideoWorkspaceDraft): string | undefined {
  if (draft.mode === 'image_to_video' && draft.imageToVideo.source) {
    return draft.imageToVideo.source.assetId;
  }
  if (draft.mode === 'quick_video' && draft.quick.reference) {
    return draft.quick.reference.assetId;
  }
  if (draft.mode === 'image_to_video' || draft.mode === 'text_to_video') {
    const materials = draft.mode === 'image_to_video'
      ? draft.imageToVideo.materials
      : draft.textToVideo.materials;
    const selected = materials?.slots.find((slot) => slot.selection)?.selection;
    return selected?.assetId;
  }
  return undefined;
}

function materialsMatchingDraft(
  draft: VideoWorkspaceDraft
): VideoSubmissionConfirmationSnapshot['materials'] {
  if (draft.mode === 'quick_video') {
    return draft.quick.reference
      ? [{
          assetId: draft.quick.reference.assetId,
          mediaKind: draft.quick.reference.mediaKind,
          role: draft.quick.reference.role,
          target: { kind: 'quick_reference' }
        }]
      : [];
  }
  if (draft.mode === 'image_to_video' && draft.imageToVideo.source) {
    return [{
      assetId: draft.imageToVideo.source.assetId,
      mediaKind: draft.imageToVideo.source.mediaKind,
      role: draft.imageToVideo.source.role,
      target: { kind: 'image_source' }
    }];
  }
  const materials = draft.mode === 'text_to_video'
    ? draft.textToVideo.materials
    : draft.imageToVideo.materials;
  return materials?.slots.flatMap((slot) =>
    slot.selection
      ? [{
          assetId: slot.selection.assetId,
          mediaKind: slot.selection.mediaKind,
          role: slot.selection.role,
          target: { kind: 'slot' as const, slotId: slot.id }
        }]
      : []
  ) ?? [];
}

function modeInputMatchingDraft(
  draft: VideoWorkspaceDraft
): VideoSubmissionConfirmationSnapshot['input'] {
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
