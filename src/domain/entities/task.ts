import { InvariantViolationError } from '../errors';
import type {
  AssetId,
  DraftId,
  ExecutionId,
  CapabilityEvidenceId,
  ConnectionId,
  ModelId,
  ProviderId,
  ProjectId,
  TaskId,
  VideoEditDraftId,
  VideoExportPlanId,
  WorkId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { assertTimestampNotBefore } from '../timestamps';
import type { CreationKind, Draft } from './draft';
import type { Execution } from './execution';
import type { PromptSnapshot } from './prompt';
import type {
  DynamicParameterValue,
  ImageWorkspaceDraft,
  ImageWorkspaceMode
} from './image-workspace';
import type { ProviderAccessCategory } from './provider';
import type {
  VideoContextReference,
  VideoDynamicParameterValue,
  VideoMaterialKind,
  VideoShotDraft,
  VideoTextSourceKind,
  VideoWorkspaceDraft,
  VideoWorkspaceMode
} from './video-workspace';

export type ImageOperationPurpose =
  | 'image_generation'
  | 'reference_to_image'
  | 'image_understanding'
  | 'image_editing'
  | 'image_to_prompt';

export type ImageOutboundScope =
  | 'local_device'
  | 'local_network'
  | 'external_service'
  | 'unknown';

export interface ImageSubmissionConfirmationSnapshot {
  readonly mode: ImageWorkspaceMode;
  readonly purpose: ImageOperationPurpose;
  readonly modelId: ModelId;
  readonly capabilityEvidenceId: CapabilityEvidenceId;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly recipientName: string;
  readonly accessCategory: ProviderAccessCategory;
  readonly outboundScope: ImageOutboundScope;
  readonly costState: 'unknown';
  readonly privacyState: 'unknown';
  readonly regionState: 'unknown';
  readonly parameters: Readonly<Record<string, DynamicParameterValue>>;
  readonly parentWorkId?: WorkId;
  readonly confirmations: {
    readonly recipient: true;
    readonly outboundScope: true;
    readonly cost: true;
    readonly finalPrompt: true;
    readonly model: true;
  };
}

export type VideoOutboundScope = ImageOutboundScope;

export interface VideoSubmissionMaterialSnapshot {
  readonly assetId: AssetId;
  readonly mediaKind: VideoMaterialKind;
  readonly role: string;
  readonly target:
    | { readonly kind: 'quick_reference' }
    | { readonly kind: 'image_source' }
    | { readonly kind: 'slot'; readonly slotId: string };
}

export type VideoSubmissionModeInput =
  | {
      readonly mode: 'quick_video';
    }
  | {
      readonly mode: 'text_to_video';
      readonly sourceKind: VideoTextSourceKind;
      readonly shots: readonly VideoShotDraft[];
    }
  | {
      readonly mode: 'image_to_video';
      readonly mustKeep: readonly string[];
      readonly allowedChanges: readonly string[];
      readonly prohibited: readonly string[];
      readonly subjectAction: string;
      readonly cameraMovement: string;
      readonly pace: string;
      readonly depthOfField: string;
    };

export interface VideoSubmissionConfirmationSnapshot {
  readonly mode: VideoWorkspaceMode;
  readonly purpose: 'video_generation';
  readonly modelId: ModelId;
  readonly capabilityEvidenceId: CapabilityEvidenceId;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly recipientName: string;
  readonly accessCategory: ProviderAccessCategory;
  readonly outboundScope: VideoOutboundScope;
  readonly costState: 'unknown';
  readonly privacyState: 'unknown';
  readonly regionState: 'unknown';
  readonly parameters: Readonly<Record<string, VideoDynamicParameterValue>>;
  readonly materials: readonly VideoSubmissionMaterialSnapshot[];
  readonly contextReferences: readonly VideoContextReference[];
  readonly input: VideoSubmissionModeInput;
  readonly confirmations: {
    readonly recipient: true;
    readonly outboundScope: true;
    readonly materials: true;
    readonly costPrivacyRegion: true;
    readonly finalPrompt: true;
    readonly model: true;
  };
}

export interface GenerationSubmissionSnapshot {
  readonly kind: Exclude<CreationKind, 'video_editing'>;
  readonly prompt: PromptSnapshot;
  readonly assetIds: readonly AssetId[];
  readonly confirmedAt: IsoTimestamp;
  readonly image?: ImageSubmissionConfirmationSnapshot;
  readonly video?: VideoSubmissionConfirmationSnapshot;
  readonly videoEditing?: never;
}

export interface VideoEditingSubmissionSnapshot {
  readonly kind: 'video_editing';
  readonly confirmedAt: IsoTimestamp;
  readonly videoEditing: {
    readonly exportPlanId: VideoExportPlanId;
    readonly draftRevision: number;
    readonly title: string;
  };
  readonly prompt?: never;
  readonly assetIds?: never;
  readonly image?: never;
  readonly video?: never;
}

export type SubmissionSnapshot =
  | GenerationSubmissionSnapshot
  | VideoEditingSubmissionSnapshot;

export interface CreateImageTaskInput {
  readonly id: TaskId;
  readonly draft: ImageWorkspaceDraft;
  readonly confirmation: ImageSubmissionConfirmationSnapshot;
  readonly confirmedAt: IsoTimestamp;
}

export function createImageTask(input: CreateImageTaskInput): Task {
  if (!['editing', 'saved'].includes(input.draft.state)) {
    throw new InvariantViolationError(
      `image workspace in ${input.draft.state} state cannot create a task`
    );
  }
  if (input.confirmation.mode !== input.draft.mode) {
    throw new InvariantViolationError('image confirmation mode does not match draft');
  }
  const expectedPurpose = input.draft.input &&
    (input.draft.mode === 'quick_image' ||
      input.draft.mode === 'professional_image')
    ? 'reference_to_image'
    : imagePurposeForMode(input.draft.mode);
  if (input.confirmation.purpose !== expectedPurpose) {
    throw new InvariantViolationError(
      'image confirmation purpose does not match draft'
    );
  }
  assertTimestampNotBefore(
    input.confirmedAt,
    input.draft.updatedAt,
    'task.confirmedAt'
  );
  const kind = creationKindForImageMode(input.draft.mode);
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.draft.projectId,
    sourceDraftId: input.draft.id,
    submission: {
      kind,
      prompt: {
        ...input.draft.prompt,
        systemSupplements: input.draft.prompt.systemSupplements.map((item) => ({
          ...item
        }))
      },
      assetIds: input.draft.input ? [input.draft.input.assetId] : [],
      confirmedAt: input.confirmedAt,
      image: {
        ...input.confirmation,
        parameters: structuredClone(input.confirmation.parameters),
        confirmations: { ...input.confirmation.confirmations }
      }
    },
    executionIds: [],
    createdAt: input.confirmedAt
  };
}

export interface CreateVideoTaskInput {
  readonly id: TaskId;
  readonly draft: VideoWorkspaceDraft;
  readonly confirmation: VideoSubmissionConfirmationSnapshot;
  readonly confirmedAt: IsoTimestamp;
}

export function createVideoTask(input: CreateVideoTaskInput): Task {
  if (!['editing', 'saved'].includes(input.draft.state)) {
    throw new InvariantViolationError(
      `video workspace in ${input.draft.state} state cannot create a task`
    );
  }
  if (
    input.confirmation.mode !== input.draft.mode ||
    input.confirmation.input.mode !== input.draft.mode ||
    input.confirmation.purpose !== 'video_generation'
  ) {
    throw new InvariantViolationError(
      'video confirmation does not match the source draft'
    );
  }
  validateVideoConfirmationAgainstDraft(input.draft, input.confirmation);
  assertTimestampNotBefore(
    input.confirmedAt,
    input.draft.updatedAt,
    'task.confirmedAt'
  );
  const assetIds = [...new Set(
    input.confirmation.materials.map((material) => material.assetId)
  )];
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.draft.projectId,
    sourceDraftId: input.draft.id,
    submission: {
      kind: 'video_generation',
      prompt: {
        ...input.draft.prompt,
        systemSupplements: input.draft.prompt.systemSupplements.map((item) => ({
          ...item
        }))
      },
      assetIds,
      confirmedAt: input.confirmedAt,
      video: cloneVideoConfirmation(input.confirmation)
    },
    executionIds: [],
    createdAt: input.confirmedAt
  };
}

function validateVideoConfirmationAgainstDraft(
  draft: VideoWorkspaceDraft,
  confirmation: VideoSubmissionConfirmationSnapshot
): void {
  if (
    draft.generation.model &&
    (draft.generation.model.modelId !== confirmation.modelId ||
      draft.generation.model.capabilityEvidenceId !==
        confirmation.capabilityEvidenceId)
  ) {
    throw new InvariantViolationError(
      'video confirmation model does not match the draft snapshot'
    );
  }
  if (
    draft.generation.parameters &&
    draft.generation.parameters.capabilityEvidenceId !==
      confirmation.capabilityEvidenceId
  ) {
    throw new InvariantViolationError(
      'video confirmation parameters use another capability snapshot'
    );
  }
  const expectedParameters = draft.generation.parameters?.values ?? {};
  const expectedMaterials = materialsForVideoDraft(draft);
  const expectedInput = inputForVideoDraft(draft);
  if (
    !sameStructuredValue(expectedParameters, confirmation.parameters) ||
    !sameStructuredValue(expectedMaterials, confirmation.materials) ||
    !sameStructuredValue(draft.contextReferences, confirmation.contextReferences) ||
    !sameStructuredValue(expectedInput, confirmation.input)
  ) {
    throw new InvariantViolationError(
      'video confirmation does not freeze the current draft input'
    );
  }
}

function materialsForVideoDraft(
  draft: VideoWorkspaceDraft
): readonly VideoSubmissionMaterialSnapshot[] {
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

function inputForVideoDraft(draft: VideoWorkspaceDraft): VideoSubmissionModeInput {
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

function sameStructuredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneVideoConfirmation(
  confirmation: VideoSubmissionConfirmationSnapshot
): VideoSubmissionConfirmationSnapshot {
  return {
    ...confirmation,
    parameters: structuredClone(confirmation.parameters),
    materials: confirmation.materials.map((material) => ({
      ...material,
      target: { ...material.target }
    })),
    contextReferences: confirmation.contextReferences.map((reference) => ({
      ...reference
    })),
    input: structuredClone(confirmation.input),
    confirmations: { ...confirmation.confirmations }
  };
}

export function imagePurposeForMode(
  mode: ImageWorkspaceMode
): ImageOperationPurpose {
  switch (mode) {
    case 'quick_image':
    case 'professional_image':
      return 'image_generation';
    case 'image_understanding':
      return 'image_understanding';
    case 'image_editing':
      return 'image_editing';
    case 'image_to_prompt':
      return 'image_to_prompt';
  }
}

function creationKindForImageMode(
  mode: ImageWorkspaceMode
): Exclude<CreationKind, 'video_editing'> {
  switch (mode) {
    case 'quick_image':
    case 'professional_image':
      return 'image_generation';
    case 'image_understanding':
      return 'image_analysis';
    case 'image_editing':
      return 'image_editing';
    case 'image_to_prompt':
      return 'image_to_prompt';
  }
}

export interface Task {
  readonly schemaVersion: 1;
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly sourceDraftId: DraftId | VideoEditDraftId;
  readonly submission: SubmissionSnapshot;
  readonly executionIds: readonly ExecutionId[];
  readonly createdAt: IsoTimestamp;
}

export interface CreateVideoEditingTaskInput {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly draftId: VideoEditDraftId;
  readonly draftRevision: number;
  readonly exportPlanId: VideoExportPlanId;
  readonly title: string;
  readonly confirmedAt: IsoTimestamp;
}

export function createVideoEditingTask(input: CreateVideoEditingTaskInput): Task {
  if (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0) {
    throw new InvariantViolationError('video editing task revision is invalid');
  }
  const title = input.title.trim();
  if (!title) throw new InvariantViolationError('video editing task title is required');
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    sourceDraftId: input.draftId,
    submission: {
      kind: 'video_editing',
      confirmedAt: input.confirmedAt,
      videoEditing: {
        exportPlanId: input.exportPlanId,
        draftRevision: input.draftRevision,
        title
      }
    },
    executionIds: [],
    createdAt: input.confirmedAt
  };
}

export interface CreateTaskFromDraftInput {
  readonly id: TaskId;
  readonly draft: Draft;
  readonly confirmedAt: IsoTimestamp;
}

export function createTaskFromDraft(input: CreateTaskFromDraftInput): Task {
  if (!['editing', 'saved'].includes(input.draft.state)) {
    throw new InvariantViolationError(
      `draft in ${input.draft.state} state cannot create a task`
    );
  }
  if (input.draft.kind === 'video_editing') {
    throw new InvariantViolationError(
      'video editing tasks require a frozen export plan'
    );
  }

  assertTimestampNotBefore(
    input.confirmedAt,
    input.draft.updatedAt,
    'task.confirmedAt'
  );

  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.draft.projectId,
    sourceDraftId: input.draft.id,
    submission: {
      kind: input.draft.kind,
      prompt: {
        ...input.draft.prompt,
        systemSupplements: input.draft.prompt.systemSupplements.map((item) => ({
          ...item
        }))
      },
      assetIds: [...input.draft.selectedAssetIds],
      confirmedAt: input.confirmedAt
    },
    executionIds: [],
    createdAt: input.confirmedAt
  };
}

export function addExecutionToTask(task: Task, execution: Execution): Task {
  if (execution.taskId !== task.id) {
    throw new InvariantViolationError('execution belongs to another task');
  }

  if (task.executionIds.includes(execution.id)) {
    throw new InvariantViolationError('execution is already linked to task');
  }

  return {
    ...task,
    executionIds: [...task.executionIds, execution.id]
  };
}
