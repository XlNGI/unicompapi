export const videoWorkspaceIpcChannels = {
  create: 'video-workspace:create',
  get: 'video-workspace:get',
  update: 'video-workspace:update',
  list: 'video-workspace:list',
  derive: 'video-workspace:derive'
} as const;

export const videoWorkspaceDtoModes = [
  'quick_video',
  'text_to_video',
  'image_to_video'
] as const;

export type VideoWorkspaceDtoMode =
  (typeof videoWorkspaceDtoModes)[number];

export type VideoWorkspaceParentModeDto =
  | VideoWorkspaceDtoMode
  | 'quick_image'
  | 'professional_image'
  | 'image_understanding'
  | 'image_editing'
  | 'image_to_prompt';

export type VideoWorkspaceIpcErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'draft_not_found'
  | 'draft_conflict'
  | 'workspace_storage_error';

export type VideoWorkspaceIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: VideoWorkspaceIpcErrorCode;
        readonly message: string;
      };
    };

export type VideoWorkspaceParameterValueDto =
  | string
  | number
  | boolean
  | null
  | readonly VideoWorkspaceParameterValueDto[]
  | { readonly [key: string]: VideoWorkspaceParameterValueDto };

export interface VideoWorkspacePromptDto {
  readonly originalInput: string;
  readonly systemSupplements: readonly {
    readonly content: string;
    readonly source: string;
    readonly sourceReference?: string;
  }[];
  readonly finalPrompt: string;
}

export interface VideoWorkspaceContextDto {
  readonly kind: 'project_asset' | 'project_context' | 'saved_conversation';
  readonly referenceId: string;
}

export interface VideoWorkspaceModelDto {
  readonly modelId: string;
  readonly capabilityEvidenceId: string;
}

export interface VideoWorkspaceParametersDto {
  readonly capabilityEvidenceId: string;
  readonly values: Readonly<Record<string, VideoWorkspaceParameterValueDto>>;
}

export type VideoWorkspaceStaleReasonDto =
  | 'prompt_changed'
  | 'materials_changed'
  | 'context_changed'
  | 'shot_plan_changed'
  | 'requirements_changed'
  | 'model_changed'
  | 'parameters_changed';

export interface VideoWorkspaceArtifactDto {
  readonly state: 'not_created' | 'current' | 'stale';
  readonly staleReasons: readonly VideoWorkspaceStaleReasonDto[];
  readonly completedAt?: string;
}

export interface VideoWorkspaceMaterialSelectionDto {
  readonly assetId: string;
  readonly mediaKind: 'image' | 'video';
  readonly role: string;
  readonly selectedAt: string;
}

export interface VideoWorkspaceMaterialSlotDto {
  readonly id: string;
  readonly role: string;
  readonly required: boolean;
  readonly acceptedMediaKinds: readonly ('image' | 'video')[];
  readonly selection?: VideoWorkspaceMaterialSelectionDto;
}

export interface VideoWorkspaceMaterialSlotsDto {
  readonly capabilityEvidenceId: string;
  readonly slots: readonly VideoWorkspaceMaterialSlotDto[];
}

export interface VideoWorkspaceGenerationDto {
  readonly model?: VideoWorkspaceModelDto;
  readonly parameters?: VideoWorkspaceParametersDto;
  readonly enhancement: VideoWorkspaceArtifactDto;
  readonly preflight: VideoWorkspaceArtifactDto;
}

export interface VideoWorkspaceShotDto {
  readonly id: string;
  readonly order: number;
  readonly description: string;
  readonly action?: string;
  readonly cameraMovement?: string;
  readonly pace?: string;
  readonly depthOfField?: string;
}

interface VideoWorkspaceDraftDtoBase {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly projectId: string;
  readonly state: 'editing' | 'saved' | 'stale' | 'archived';
  readonly origin:
    | { readonly kind: 'new' }
    | {
        readonly kind: 'derived';
        readonly parentDraftId: string;
        readonly parentMode: VideoWorkspaceParentModeDto;
      };
  readonly prompt: VideoWorkspacePromptDto;
  readonly contextReferences: readonly VideoWorkspaceContextDto[];
  readonly generation: VideoWorkspaceGenerationDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type VideoWorkspaceDraftDto = VideoWorkspaceDraftDtoBase &
  (
    | {
        readonly mode: 'quick_video';
        readonly quick: {
          readonly reference?: VideoWorkspaceMaterialSelectionDto;
        };
      }
    | {
        readonly mode: 'text_to_video';
        readonly textToVideo: {
          readonly sourceKind: 'short_idea' | 'long_form';
          readonly materials?: VideoWorkspaceMaterialSlotsDto;
          readonly shots: readonly VideoWorkspaceShotDto[];
          readonly storyboard: VideoWorkspaceArtifactDto & {
            readonly frameAssetIds: readonly string[];
          };
        };
      }
    | {
        readonly mode: 'image_to_video';
        readonly imageToVideo: {
          readonly materials?: VideoWorkspaceMaterialSlotsDto;
          readonly mustKeep: readonly string[];
          readonly allowedChanges: readonly string[];
          readonly prohibited: readonly string[];
          readonly subjectAction: string;
          readonly cameraMovement: string;
          readonly pace: string;
          readonly depthOfField: string;
        };
      }
  );

export interface VideoWorkspaceApi {
  create(
    mode: VideoWorkspaceDtoMode
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>>;
  get(
    draftId: string
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto | undefined>>;
  update(
    draft: VideoWorkspaceDraftDto
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>>;
  list(): Promise<
    VideoWorkspaceIpcResult<readonly VideoWorkspaceDraftDto[]>
  >;
  derive(
    sourceDraftId: string,
    targetMode: VideoWorkspaceDtoMode
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>>;
}
