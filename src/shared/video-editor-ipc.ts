export const videoEditorIpcChannels = {
  getCapabilities: 'video-editor:get-capabilities',
  create: 'video-editor:create',
  get: 'video-editor:get',
  list: 'video-editor:list',
  update: 'video-editor:update',
  undo: 'video-editor:undo',
  redo: 'video-editor:redo',
  copy: 'video-editor:copy',
  selectSource: 'video-editor:select-source',
  attachWork: 'video-editor:attach-work',
  getSourceStatus: 'video-editor:get-source-status',
  prepareRelink: 'video-editor:prepare-relink',
  confirmRelink: 'video-editor:confirm-relink',
  selectBackgroundMusic: 'video-editor:select-background-music',
  selectCoverImage: 'video-editor:select-cover-image',
  attachCoverWork: 'video-editor:attach-cover-work',
  createSourcePreview: 'video-editor:create-source-preview',
  createCompositionPreview: 'video-editor:create-composition-preview',
  requestPreviewArtifact: 'video-editor:request-preview-artifact',
  clearPreviewCache: 'video-editor:clear-preview-cache',
  preflightExport: 'video-editor:preflight-export',
  startExport: 'video-editor:start-export',
  getExport: 'video-editor:get-export',
  cancelExport: 'video-editor:cancel-export',
  retryExport: 'video-editor:retry-export',
  recoverExports: 'video-editor:recover-exports'
} as const;

export type VideoEditorIpcErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'draft_not_found'
  | 'draft_conflict'
  | 'source_not_found'
  | 'source_invalid'
  | 'nothing_to_undo'
  | 'nothing_to_redo'
  | 'clip_not_found'
  | 'work_not_found'
  | 'source_unavailable'
  | 'source_changed'
  | 'unsupported_video'
  | 'unsupported_audio'
  | 'unsupported_image'
  | 'media_unreadable'
  | 'managed_copy_failed'
  | 'relink_token_invalid'
  | 'relink_mismatch_confirmation_required'
  | 'relink_candidate_too_short'
  | 'preview_unavailable'
  | 'adapter_unavailable'
  | 'export_preflight_failed'
  | 'export_not_found'
  | 'export_not_cancellable'
  | 'export_not_retryable'
  | 'export_failed'
  | 'workspace_storage_error';

export interface VideoEditorExportPreflightDto {
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly output: {
    readonly container: 'webm';
    readonly videoCodec: 'libvpx-vp9';
    readonly audioCodec: 'libopus';
    readonly hardwareAcceleration: 'software_only';
  };
  readonly estimatedOutputBytes: number;
}

export interface VideoEditorExportTaskDto {
  readonly taskId: string;
  readonly executionId: string;
  readonly attempt: number;
  readonly state: string;
  readonly progress?: {
    readonly processedUs?: number;
    readonly totalUs?: number;
    readonly percent?: number;
  };
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly workId?: string;
  readonly requiredAction?: {
    readonly code: 'source_unavailable' | 'destination_unavailable';
    readonly message: string;
  };
  readonly failure?: {
    readonly message: string;
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown';
  };
  readonly updatedAt: string;
}

export type VideoEditorIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: VideoEditorIpcErrorCode;
        readonly message: string;
        readonly recoverableDraft?: VideoEditorDraftDto;
      };
    };

export type VideoEditorSourceIntentDto =
  | { readonly kind: 'blank' }
  | { readonly kind: 'from_work'; readonly sourceWorkId: string }
  | { readonly kind: 'from_video_draft'; readonly sourceDraftId: string };

export interface VideoEditorMediaIdentityDto {
  readonly sizeBytes: number;
  readonly durationUs: number;
  readonly container: string;
  readonly width: number;
  readonly height: number;
}

export interface VideoEditorSourceRangeDto {
  readonly inUs: number;
  readonly outUs: number;
}

export interface VideoEditorRationalDto {
  readonly numerator: number;
  readonly denominator: number;
}

export interface VideoEditorTransformDto {
  readonly scalePermille: number;
  readonly positionXPermille: number;
  readonly positionYPermille: number;
  readonly rotationMilliDegrees: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly crop: {
    readonly xPermille: number;
    readonly yPermille: number;
    readonly widthPermille: number;
    readonly heightPermille: number;
  } | null;
}

export type VideoEditorTransitionDto =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'fade' | 'dissolve';
      readonly durationUs: number;
    };

export interface VideoEditorClipDto {
  readonly clipId: string;
  readonly source: {
    readonly fileId: string;
    readonly assetId?: string;
    readonly workId?: string;
    readonly identity: VideoEditorMediaIdentityDto;
  };
  readonly sourceRange: VideoEditorSourceRangeDto;
  readonly speed: VideoEditorRationalDto;
  readonly transform: VideoEditorTransformDto;
  readonly sourceAudio: {
    readonly muted: boolean;
    readonly volumePermille: number;
  };
  readonly transitionToNext: VideoEditorTransitionDto;
}

export interface VideoEditorTextOverlayDto {
  readonly textId: string;
  readonly content: string;
  readonly range: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly style: {
    readonly requestedFontFamily: string;
    readonly resolvedFontId?: string;
    readonly fontSizeMilliPx: number;
    readonly alignment: 'left' | 'center' | 'right';
    readonly opacityPermille: number;
    readonly color: string;
  };
  readonly position: {
    readonly xPermille: number;
    readonly yPermille: number;
  };
  readonly entrance: 'none' | 'fade_in';
  readonly exit: 'none' | 'fade_out';
}

export interface VideoEditorBackgroundMusicDto {
  readonly fileId: string;
  readonly assetId?: string;
  readonly identity: VideoEditorMediaIdentityDto;
  readonly sourceRange: VideoEditorSourceRangeDto;
  readonly timelineRange: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly volumePermille: number;
  readonly fadeInUs: number;
  readonly fadeOutUs: number;
}

export type VideoEditorCoverDto =
  | {
      readonly kind: 'video_frame';
      readonly clipId: string;
      readonly sourceTimeUs: number;
      readonly prependToVideo: boolean;
      readonly prependDurationUs?: number;
    }
  | {
      readonly kind: 'local_image';
      readonly fileId: string;
      readonly assetId?: string;
      readonly prependToVideo: boolean;
      readonly prependDurationUs?: number;
    }
  | {
      readonly kind: 'project_image';
      readonly workId: string;
      readonly fileId: string;
      readonly prependToVideo: boolean;
      readonly prependDurationUs?: number;
    };

export interface VideoEditorCanvasDto {
  readonly aspectRatio:
    | { readonly kind: 'source' }
    | {
        readonly kind: 'ratio';
        readonly numerator: number;
        readonly denominator: number;
      };
  readonly transformPolicy: 'fit' | 'fill';
  readonly background:
    | { readonly kind: 'solid'; readonly color: string }
    | { readonly kind: 'blur_source'; readonly strengthPermille: number };
}

export type VideoEditorCapabilityPreferenceDto =
  | { readonly kind: 'auto' }
  | { readonly kind: 'capability'; readonly valueId: string };

export type VideoEditorResolutionPreferenceDto =
  | { readonly kind: 'source' }
  | { readonly kind: 'capability'; readonly valueId: string };

export interface VideoEditorOutputPreferenceDto {
  readonly destinationId?: string;
  readonly fileName?: string;
  readonly container: VideoEditorCapabilityPreferenceDto;
  readonly videoCodec: VideoEditorCapabilityPreferenceDto;
  readonly audioCodec: VideoEditorCapabilityPreferenceDto;
  readonly resolution: VideoEditorResolutionPreferenceDto;
  readonly frameRate: VideoEditorResolutionPreferenceDto;
  readonly quality: VideoEditorCapabilityPreferenceDto;
  readonly hardwareAcceleration:
    | 'auto'
    | 'prefer_hardware'
    | 'software_only';
  readonly conflictPolicy: 'fail' | 'create_unique_name';
}

export interface VideoEditorDraftDto {
  readonly schemaVersion: 1;
  readonly kind: 'video_basic_edit';
  readonly draftId: string;
  readonly projectId: string;
  readonly title: string;
  readonly revision: number;
  readonly sourceIntent: VideoEditorSourceIntentDto;
  readonly canvas: VideoEditorCanvasDto;
  readonly videoTrack: readonly VideoEditorClipDto[];
  readonly removedClips: readonly {
    readonly clip: VideoEditorClipDto;
    readonly previousIndex: number;
  }[];
  readonly textTrack: readonly VideoEditorTextOverlayDto[];
  readonly backgroundMusic: VideoEditorBackgroundMusicDto | null;
  readonly cover: VideoEditorCoverDto | null;
  readonly outputPreference: VideoEditorOutputPreferenceDto;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type VideoEditorSourceRegistrationStrategyDto =
  | 'external_reference'
  | 'managed_project_copy';

export type VideoEditorSourceReferenceKindDto =
  | VideoEditorSourceRegistrationStrategyDto
  | 'managed_work';

export interface VideoEditorSourceDto {
  readonly clipId: string;
  readonly assetId?: string;
  readonly workId?: string;
  readonly name: string;
  readonly referenceKind: VideoEditorSourceReferenceKindDto;
  readonly fileState: string;
  readonly identity: VideoEditorMediaIdentityDto;
}

export interface VideoEditorSourceSelectionResultDto {
  readonly cancelled: boolean;
  readonly draft?: VideoEditorDraftDto;
  readonly source?: VideoEditorSourceDto;
}

export interface VideoEditorAssetSelectionResultDto {
  readonly cancelled: boolean;
  readonly draft?: VideoEditorDraftDto;
}

export interface VideoEditorSourceStatusDto {
  readonly clipId: string;
  readonly state: string;
  readonly issues: readonly string[];
  readonly matchesIdentity?: boolean;
  readonly relinkRequired: boolean;
  readonly referenceKind: VideoEditorSourceReferenceKindDto;
  readonly checkedAt?: string;
}

export interface VideoEditorRelinkPreparationDto {
  readonly cancelled: boolean;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly matchesIdentity?: boolean;
  readonly candidate?: VideoEditorMediaIdentityDto;
  readonly differences?: {
    readonly content: boolean;
    readonly size: boolean;
    readonly duration: boolean;
    readonly container: boolean;
    readonly dimensions: boolean;
  };
}

export interface VideoEditorSourcePreviewDto {
  readonly draftRevision: number;
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: 'video/mp4' | 'video/quicktime';
  readonly kind: 'original';
}

export interface VideoEditorCompositionPreviewDto {
  readonly draftRevision: number;
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: 'video/webm';
  readonly kind: 'composition';
}

export type VideoEditorPreviewArtifactKindDto =
  | 'proxy_video'
  | 'thumbnail_strip'
  | 'audio_waveform';

export interface VideoEditorPreviewArtifactDto {
  readonly kind: VideoEditorPreviewArtifactKindDto;
  readonly draftRevision: number;
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: string;
}

export type VideoEditorUpdateDto =
  | { readonly kind: 'set_title'; readonly title: string }
  | {
      readonly kind: 'trim_clip';
      readonly clipId: string;
      readonly sourceRange: VideoEditorSourceRangeDto;
    }
  | {
      readonly kind: 'split_clip';
      readonly clipId: string;
      readonly atSourceUs: number;
    }
  | { readonly kind: 'remove_clip'; readonly clipId: string }
  | {
      readonly kind: 'restore_clip';
      readonly clipId: string;
      readonly targetIndex?: number;
    }
  | {
      readonly kind: 'duplicate_clip';
      readonly clipId: string;
      readonly targetIndex?: number;
    }
  | {
      readonly kind: 'move_clip';
      readonly clipId: string;
      readonly toIndex: number;
    }
  | {
      readonly kind: 'set_clip_speed';
      readonly clipId: string;
      readonly speed: VideoEditorRationalDto;
    }
  | {
      readonly kind: 'set_clip_transform';
      readonly clipId: string;
      readonly transform: VideoEditorTransformDto;
    }
  | {
      readonly kind: 'set_clip_transition';
      readonly clipId: string;
      readonly transition: VideoEditorTransitionDto;
    }
  | {
      readonly kind: 'set_source_audio';
      readonly clipId: string;
      readonly sourceAudio: {
        readonly muted: boolean;
        readonly volumePermille: number;
      };
    }
  | {
      readonly kind: 'upsert_text';
      readonly text: Omit<VideoEditorTextOverlayDto, 'textId'> & {
        readonly textId?: string;
      };
    }
  | { readonly kind: 'remove_text'; readonly textId: string }
  | {
      readonly kind: 'update_background_music';
      readonly sourceRange: VideoEditorSourceRangeDto;
      readonly timelineRange: {
        readonly startUs: number;
        readonly endUs: number;
      };
      readonly volumePermille: number;
      readonly fadeInUs: number;
      readonly fadeOutUs: number;
    }
  | { readonly kind: 'clear_background_music' }
  | {
      readonly kind: 'set_cover';
      readonly cover: VideoEditorCoverDto | null;
    }
  | {
      readonly kind: 'set_canvas';
      readonly canvas: VideoEditorCanvasDto;
    }
  | {
      readonly kind: 'set_output_preference';
      readonly outputPreference: VideoEditorOutputPreferenceDto;
    };

export interface VideoEditorApi {
  getCapabilities(): Promise<VideoEditorIpcResult<{
    readonly transitions: readonly {
      readonly kind: 'fade' | 'dissolve';
      readonly minimumDurationUs: number;
      readonly maximumDurationUs: number;
    }[];
    readonly compositionPreview: 'available' | 'unavailable';
  }>>;
  create(
    sourceIntent?: VideoEditorSourceIntentDto,
    title?: string
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>>;
  get(
    draftId: string
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto | undefined>>;
  list(): Promise<VideoEditorIpcResult<readonly VideoEditorDraftDto[]>>;
  update(
    draftId: string,
    expectedRevision: number,
    command: VideoEditorUpdateDto
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>>;
  undo(
    draftId: string,
    expectedRevision: number
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>>;
  redo(
    draftId: string,
    expectedRevision: number
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>>;
  copy(
    draftId: string,
    expectedRevision: number,
    title?: string
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>>;
  selectSource(
    draftId: string,
    expectedRevision: number,
    strategy: VideoEditorSourceRegistrationStrategyDto
  ): Promise<VideoEditorIpcResult<VideoEditorSourceSelectionResultDto>>;
  attachWork(
    draftId: string,
    expectedRevision: number,
    workId: string
  ): Promise<VideoEditorIpcResult<VideoEditorSourceSelectionResultDto>>;
  getSourceStatus(
    draftId: string,
    clipId: string
  ): Promise<VideoEditorIpcResult<VideoEditorSourceStatusDto>>;
  prepareRelink(
    draftId: string,
    clipId: string
  ): Promise<VideoEditorIpcResult<VideoEditorRelinkPreparationDto>>;
  confirmRelink(
    draftId: string,
    clipId: string,
    token: string,
    acceptMismatch: boolean
  ): Promise<VideoEditorIpcResult<VideoEditorSourceSelectionResultDto>>;
  selectBackgroundMusic(
    draftId: string,
    expectedRevision: number
  ): Promise<VideoEditorIpcResult<VideoEditorAssetSelectionResultDto>>;
  selectCoverImage(
    draftId: string,
    expectedRevision: number,
    prependToVideo: boolean,
    prependDurationUs?: number
  ): Promise<VideoEditorIpcResult<VideoEditorAssetSelectionResultDto>>;
  attachCoverWork(
    draftId: string,
    expectedRevision: number,
    workId: string,
    prependToVideo: boolean,
    prependDurationUs?: number
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>>;
  createSourcePreview(
    draftId: string,
    clipId: string
  ): Promise<VideoEditorIpcResult<VideoEditorSourcePreviewDto>>;
  createCompositionPreview(
    draftId: string,
    expectedRevision: number
  ): Promise<VideoEditorIpcResult<VideoEditorCompositionPreviewDto>>;
  requestPreviewArtifact(
    draftId: string,
    clipId: string,
    kind: VideoEditorPreviewArtifactKindDto
  ): Promise<VideoEditorIpcResult<VideoEditorPreviewArtifactDto>>;
  clearPreviewCache(): Promise<
    VideoEditorIpcResult<{ readonly cleared: true }>
  >;
  preflightExport(
    draftId: string,
    expectedRevision: number
  ): Promise<VideoEditorIpcResult<VideoEditorExportPreflightDto>>;
  startExport(
    draftId: string,
    expectedRevision: number
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>>;
  getExport(
    taskId: string
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>>;
  cancelExport(
    taskId: string
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>>;
  retryExport(
    taskId: string
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>>;
  recoverExports(): Promise<
    VideoEditorIpcResult<{ readonly recoveryRequired: number }>
  >;
}
