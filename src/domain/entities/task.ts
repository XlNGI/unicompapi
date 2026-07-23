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

export type ImageOperationPurpose =
  | 'image_generation'
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

export interface SubmissionSnapshot {
  readonly kind: CreationKind;
  readonly prompt: PromptSnapshot;
  readonly assetIds: readonly AssetId[];
  readonly confirmedAt: IsoTimestamp;
  readonly image?: ImageSubmissionConfirmationSnapshot;
}

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
  if (input.confirmation.purpose !== imagePurposeForMode(input.draft.mode)) {
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

function creationKindForImageMode(mode: ImageWorkspaceMode): CreationKind {
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
  readonly sourceDraftId: DraftId;
  readonly submission: SubmissionSnapshot;
  readonly executionIds: readonly ExecutionId[];
  readonly createdAt: IsoTimestamp;
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
