export const imageWorkspaceIpcChannels = {
  create: 'image-workspace:create',
  get: 'image-workspace:get',
  update: 'image-workspace:update',
  list: 'image-workspace:list',
  derive: 'image-workspace:derive',
  selectInput: 'image-workspace:select-input',
  clearInput: 'image-workspace:clear-input',
  getInput: 'image-workspace:get-input',
  createInputPreview: 'image-workspace:create-input-preview'
} as const;

export const imageWorkspaceDtoModes = [
  'quick_image',
  'professional_image',
  'image_understanding',
  'image_editing',
  'image_to_prompt'
] as const;

export type ImageWorkspaceDtoMode =
  (typeof imageWorkspaceDtoModes)[number];

export type ImageWorkspaceIpcErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'draft_not_found'
  | 'draft_conflict'
  | 'input_not_found'
  | 'image_unreadable'
  | 'unsupported_image'
  | 'preview_unavailable'
  | 'workspace_storage_error';

export type ImageWorkspaceIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ImageWorkspaceIpcErrorCode;
        readonly message: string;
      };
    };

export type ImageWorkspaceParameterValueDto =
  | string
  | number
  | boolean
  | null
  | readonly ImageWorkspaceParameterValueDto[]
  | { readonly [key: string]: ImageWorkspaceParameterValueDto };

export interface ImageWorkspacePromptDto {
  readonly originalInput: string;
  readonly systemSupplements: readonly {
    readonly content: string;
    readonly source: string;
    readonly sourceReference?: string;
  }[];
  readonly finalPrompt: string;
}

export interface ImageWorkspaceInputDto {
  readonly assetId: string;
  readonly role: 'reference' | 'source';
  readonly purpose?: string;
  readonly region?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly selectedAt: string;
}

export interface ImageWorkspaceContextDto {
  readonly kind: 'project_asset' | 'project_context' | 'saved_conversation';
  readonly referenceId: string;
  readonly contextRevision?: number;
  readonly includeInPrompt?: boolean;
}

export interface ImageWorkspaceFeatureSelectionDto {
  readonly productFeature:
    | 'image_understanding'
    | 'image_to_prompt'
    | 'text_to_image'
    | 'reference_to_image'
    | 'image_edit';
  readonly candidateId?: string;
  readonly parameterSchemaId?: string;
  readonly parameterSchemaRevision?: number;
  readonly parameterValues: Readonly<Record<string, ImageWorkspaceParameterValueDto>>;
}

export interface ImageWorkspaceModelDto {
  readonly modelId: string;
  readonly capabilityEvidenceId: string;
}

export interface ImageWorkspaceParametersDto {
  readonly capabilityEvidenceId: string;
  readonly values: Readonly<Record<string, ImageWorkspaceParameterValueDto>>;
}

export interface ImageWorkspaceObservationDto {
  readonly id: string;
  readonly content: string;
}

export interface ImageWorkspaceObservationSetDto {
  readonly visibleFacts: readonly ImageWorkspaceObservationDto[];
  readonly modelInferences: readonly ImageWorkspaceObservationDto[];
  readonly uncertainties: readonly ImageWorkspaceObservationDto[];
  readonly unrecognized: readonly ImageWorkspaceObservationDto[];
}

export interface ImageWorkspaceInputAssetDto {
  readonly assetId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly fileState: string;
}

export interface ImageWorkspaceInputSelectionDto {
  readonly cancelled: boolean;
  readonly draft?: ImageWorkspaceDraftDto;
  readonly input?: ImageWorkspaceInputAssetDto;
}

export interface ImageWorkspaceInputPreviewDto {
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: string;
}

interface ImageWorkspaceDraftDtoBase {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly projectId: string;
  readonly state: 'editing' | 'saved' | 'stale' | 'archived';
  readonly origin:
    | { readonly kind: 'new' }
    | {
        readonly kind: 'derived';
        readonly parentDraftId: string;
        readonly parentMode: ImageWorkspaceDtoMode;
      };
  readonly prompt: ImageWorkspacePromptDto;
  readonly input?: ImageWorkspaceInputDto;
  readonly contextReferences: readonly ImageWorkspaceContextDto[];
  readonly featureSelection?: ImageWorkspaceFeatureSelectionDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ImageWorkspaceDraftDto = ImageWorkspaceDraftDtoBase &
  (
    | {
        readonly mode: 'quick_image' | 'professional_image';
        readonly generation: {
          readonly model?: ImageWorkspaceModelDto;
          readonly parameters?: ImageWorkspaceParametersDto;
        };
      }
    | {
        readonly mode: 'image_understanding';
        readonly understanding: {
          readonly analysisState: 'not_analyzed' | 'current' | 'stale';
          readonly observations: ImageWorkspaceObservationSetDto;
          readonly userRevisions: readonly {
            readonly id: string;
            readonly targetObservationId?: string;
            readonly content: string;
            readonly createdAt: string;
          }[];
          readonly saveScope: 'draft_only' | 'project_context';
          readonly staleReasons: readonly ImageWorkspaceAnalysisStaleReasonDto[];
          readonly analyzedAt?: string;
        };
      }
    | {
        readonly mode: 'image_editing';
        readonly editing: {
          readonly lineage?: {
            readonly parentDraftId?: string;
            readonly parentAssetId: string;
            readonly parentWorkId?: string;
          };
          readonly maskAssetId?: string;
          readonly mustKeep: readonly string[];
          readonly mustChange: readonly string[];
          readonly prohibited: readonly string[];
          readonly model?: ImageWorkspaceModelDto;
          readonly parameters?: ImageWorkspaceParametersDto;
        };
      }
    | {
        readonly mode: 'image_to_prompt';
        readonly imageToPrompt: {
          readonly analysisState: 'not_analyzed' | 'current' | 'stale';
          readonly purpose: string;
          readonly requirements: readonly string[];
          readonly observations: ImageWorkspaceObservationSetDto;
          readonly staleReasons: readonly ImageWorkspaceAnalysisStaleReasonDto[];
          readonly analyzedAt?: string;
        };
      }
  );

export type ImageWorkspaceAnalysisStaleReasonDto =
  | 'input_changed'
  | 'region_changed'
  | 'purpose_changed'
  | 'requirements_changed';

export interface ImageWorkspaceApi {
  create(
    mode: ImageWorkspaceDtoMode
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>>;
  get(
    draftId: string
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto | undefined>>;
  update(
    draft: ImageWorkspaceDraftDto
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>>;
  list(): Promise<
    ImageWorkspaceIpcResult<readonly ImageWorkspaceDraftDto[]>
  >;
  derive(
    sourceDraftId: string,
    targetMode: ImageWorkspaceDtoMode
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>>;
  selectInput(
    draftId: string
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceInputSelectionDto>>;
  clearInput(
    draftId: string
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>>;
  getInput(
    draftId: string
  ): Promise<
    ImageWorkspaceIpcResult<ImageWorkspaceInputAssetDto | undefined>
  >;
  createInputPreview(
    draftId: string
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceInputPreviewDto>>;
}
