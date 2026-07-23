import type {
  AssetId,
  CapabilityEvidenceId,
  DraftId,
  ModelId,
  ProjectId,
  WorkId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { toIsoTimestamp } from '../timestamps';
import { promptSupplementSources, type PromptSnapshot } from './prompt';
import { imageWorkspaceModes, type ImageWorkspaceMode } from './image-workspace';

export const videoWorkspaceModes = [
  'quick_video',
  'text_to_video',
  'image_to_video'
] as const;

export type VideoWorkspaceMode = (typeof videoWorkspaceModes)[number];

export const videoWorkspaceStates = [
  'editing',
  'saved',
  'stale',
  'archived'
] as const;

export type VideoWorkspaceState = (typeof videoWorkspaceStates)[number];

export const videoContextKinds = [
  'project_asset',
  'project_context',
  'saved_conversation'
] as const;

export type VideoContextKind = (typeof videoContextKinds)[number];

export const videoMaterialKinds = ['image', 'video'] as const;
export type VideoMaterialKind = (typeof videoMaterialKinds)[number];

export const videoTextSourceKinds = ['short_idea', 'long_form'] as const;
export type VideoTextSourceKind = (typeof videoTextSourceKinds)[number];

export const videoArtifactStates = [
  'not_created',
  'current',
  'stale'
] as const;

export type VideoArtifactState = (typeof videoArtifactStates)[number];

export const videoWorkspaceStaleReasons = [
  'prompt_changed',
  'materials_changed',
  'context_changed',
  'shot_plan_changed',
  'requirements_changed',
  'model_changed',
  'parameters_changed'
] as const;

export type VideoWorkspaceStaleReason =
  (typeof videoWorkspaceStaleReasons)[number];

export type VideoDynamicParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly VideoDynamicParameterValue[]
  | { readonly [key: string]: VideoDynamicParameterValue };

export interface VideoContextReference {
  readonly kind: VideoContextKind;
  readonly referenceId: string;
}

export interface VideoModelSelection {
  readonly modelId: ModelId;
  readonly capabilityEvidenceId: CapabilityEvidenceId;
}

export interface VideoDynamicParameterSnapshot {
  readonly capabilityEvidenceId: CapabilityEvidenceId;
  readonly values: Readonly<Record<string, VideoDynamicParameterValue>>;
}

export interface VideoArtifactStatus {
  readonly state: VideoArtifactState;
  readonly staleReasons: readonly VideoWorkspaceStaleReason[];
  readonly completedAt?: IsoTimestamp;
}

export interface VideoMaterialSelection {
  readonly assetId: AssetId;
  readonly mediaKind: VideoMaterialKind;
  readonly role: string;
  readonly selectedAt: IsoTimestamp;
}

export interface VideoMaterialSlot {
  readonly id: string;
  readonly role: string;
  readonly required: boolean;
  readonly acceptedMediaKinds: readonly VideoMaterialKind[];
  readonly selection?: VideoMaterialSelection;
}

export interface VideoMaterialSlotSnapshot {
  readonly capabilityEvidenceId: CapabilityEvidenceId;
  readonly slots: readonly VideoMaterialSlot[];
}

export interface VideoGenerationWorkspace {
  readonly model?: VideoModelSelection;
  readonly parameters?: VideoDynamicParameterSnapshot;
  readonly enhancement: VideoArtifactStatus;
  readonly preflight: VideoArtifactStatus;
}

export interface VideoShotDraft {
  readonly id: string;
  readonly order: number;
  readonly description: string;
  readonly action?: string;
  readonly cameraMovement?: string;
  readonly pace?: string;
  readonly depthOfField?: string;
}

export interface VideoStoryboardDraft extends VideoArtifactStatus {
  readonly frameAssetIds: readonly AssetId[];
}

export interface QuickVideoWorkspace {
  readonly reference?: VideoMaterialSelection;
}

export interface TextToVideoWorkspace {
  readonly sourceKind: VideoTextSourceKind;
  readonly materials?: VideoMaterialSlotSnapshot;
  readonly shots: readonly VideoShotDraft[];
  readonly storyboard: VideoStoryboardDraft;
}

export interface ImageToVideoWorkspace {
  readonly materials?: VideoMaterialSlotSnapshot;
  readonly mustKeep: readonly string[];
  readonly allowedChanges: readonly string[];
  readonly prohibited: readonly string[];
  readonly subjectAction: string;
  readonly cameraMovement: string;
  readonly pace: string;
  readonly depthOfField: string;
}

export interface VideoWorkspaceOriginNew {
  readonly kind: 'new';
}

export type VideoWorkspaceParentMode = VideoWorkspaceMode | ImageWorkspaceMode;

export interface VideoWorkspaceOriginDerived {
  readonly kind: 'derived';
  readonly parentDraftId: DraftId;
  readonly parentMode: VideoWorkspaceParentMode;
}

export type VideoWorkspaceOrigin =
  | VideoWorkspaceOriginNew
  | VideoWorkspaceOriginDerived;

interface VideoWorkspaceDraftBase {
  readonly schemaVersion: 1;
  readonly id: DraftId;
  readonly projectId: ProjectId;
  readonly state: VideoWorkspaceState;
  readonly origin: VideoWorkspaceOrigin;
  readonly prompt: PromptSnapshot;
  readonly contextReferences: readonly VideoContextReference[];
  readonly generation: VideoGenerationWorkspace;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface QuickVideoWorkspaceDraft extends VideoWorkspaceDraftBase {
  readonly mode: 'quick_video';
  readonly quick: QuickVideoWorkspace;
}

export interface TextToVideoWorkspaceDraft extends VideoWorkspaceDraftBase {
  readonly mode: 'text_to_video';
  readonly textToVideo: TextToVideoWorkspace;
}

export interface ImageToVideoWorkspaceDraft extends VideoWorkspaceDraftBase {
  readonly mode: 'image_to_video';
  readonly imageToVideo: ImageToVideoWorkspace;
}

export type VideoWorkspaceDraft =
  | QuickVideoWorkspaceDraft
  | TextToVideoWorkspaceDraft
  | ImageToVideoWorkspaceDraft;

export interface VideoEditHandoffIntent {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly sourceDraftId: DraftId;
  readonly sourceWorkId: WorkId;
  readonly requestedAt: IsoTimestamp;
}

export interface CreateEmptyVideoWorkspaceDraftInput<
  TMode extends VideoWorkspaceMode = VideoWorkspaceMode
> {
  readonly id: DraftId;
  readonly projectId: ProjectId;
  readonly mode: TMode;
  readonly createdAt: IsoTimestamp;
  readonly origin?: VideoWorkspaceOrigin;
}

type VideoWorkspaceDraftForMode<TMode extends VideoWorkspaceMode> = Extract<
  VideoWorkspaceDraft,
  { readonly mode: TMode }
>;

const emptyPrompt = (): PromptSnapshot => ({
  originalInput: '',
  systemSupplements: [],
  finalPrompt: ''
});

const emptyArtifact = (): VideoArtifactStatus => ({
  state: 'not_created',
  staleReasons: []
});

const emptyGeneration = (): VideoGenerationWorkspace => ({
  enhancement: emptyArtifact(),
  preflight: emptyArtifact()
});

export function createEmptyVideoWorkspaceDraft<
  TMode extends VideoWorkspaceMode
>(
  input: CreateEmptyVideoWorkspaceDraftInput<TMode>
): VideoWorkspaceDraftForMode<TMode> {
  const base = {
    schemaVersion: 1 as const,
    id: input.id,
    projectId: input.projectId,
    state: 'editing' as const,
    origin: input.origin ?? { kind: 'new' as const },
    prompt: emptyPrompt(),
    contextReferences: [],
    generation: emptyGeneration(),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };

  switch (input.mode) {
    case 'quick_video':
      return {
        ...base,
        mode: input.mode,
        quick: {}
      } as unknown as VideoWorkspaceDraftForMode<TMode>;
    case 'text_to_video':
      return {
        ...base,
        mode: input.mode,
        textToVideo: {
          sourceKind: 'short_idea',
          shots: [],
          storyboard: {
            ...emptyArtifact(),
            frameAssetIds: []
          }
        }
      } as unknown as VideoWorkspaceDraftForMode<TMode>;
    case 'image_to_video':
      return {
        ...base,
        mode: input.mode,
        imageToVideo: {
          mustKeep: [],
          allowedChanges: [],
          prohibited: [],
          subjectAction: '',
          cameraMovement: '',
          pace: '',
          depthOfField: ''
        }
      } as unknown as VideoWorkspaceDraftForMode<TMode>;
  }
}

export function createVideoWorkspaceDraft<TDraft extends VideoWorkspaceDraft>(
  input: TDraft
): TDraft {
  if (!isVideoWorkspaceDraft(input)) {
    throw new TypeError('video workspace draft is invalid');
  }
  return structuredClone(input);
}

export function deriveVideoWorkspaceDraft(input: {
  readonly id: DraftId;
  readonly source: VideoWorkspaceDraft;
  readonly targetMode: VideoWorkspaceMode;
  readonly createdAt: IsoTimestamp;
}): VideoWorkspaceDraft {
  const derived = createEmptyVideoWorkspaceDraft({
    id: input.id,
    projectId: input.source.projectId,
    mode: input.targetMode,
    createdAt: input.createdAt,
    origin: {
      kind: 'derived',
      parentDraftId: input.source.id,
      parentMode: input.source.mode
    }
  });

  return {
    ...derived,
    prompt: clonePrompt(input.source.prompt),
    contextReferences: input.source.contextReferences.map((reference) => ({
      ...reference
    }))
  };
}

export function createVideoEditHandoffIntent(
  input: Omit<VideoEditHandoffIntent, 'schemaVersion'>
): VideoEditHandoffIntent {
  const intent: VideoEditHandoffIntent = { ...input, schemaVersion: 1 };
  if (!isVideoEditHandoffIntent(intent)) {
    throw new TypeError('video edit handoff intent is invalid');
  }
  return { ...intent };
}

export function applyVideoWorkspaceChangeStaleness(
  previous: VideoWorkspaceDraft,
  next: VideoWorkspaceDraft,
  updatedAt: IsoTimestamp
): VideoWorkspaceDraft {
  if (previous.id !== next.id || previous.mode !== next.mode) {
    throw new TypeError('video workspace staleness requires the same draft');
  }

  const enhancementReasons: VideoWorkspaceStaleReason[] = [];
  const preflightReasons: VideoWorkspaceStaleReason[] = [];
  const storyboardReasons: VideoWorkspaceStaleReason[] = [];

  if (previous.prompt.originalInput !== next.prompt.originalInput) {
    enhancementReasons.push('prompt_changed');
    preflightReasons.push('prompt_changed');
    storyboardReasons.push('prompt_changed');
  } else if (!sameValue(previous.prompt, next.prompt)) {
    preflightReasons.push('prompt_changed');
  }

  if (!sameValue(previous.contextReferences, next.contextReferences)) {
    enhancementReasons.push('context_changed');
    preflightReasons.push('context_changed');
    storyboardReasons.push('context_changed');
  }

  if (!sameValue(materialState(previous), materialState(next))) {
    enhancementReasons.push('materials_changed');
    preflightReasons.push('materials_changed');
    storyboardReasons.push('materials_changed');
  }

  if (!sameValue(previous.generation.model, next.generation.model)) {
    preflightReasons.push('model_changed');
  }
  if (!sameValue(previous.generation.parameters, next.generation.parameters)) {
    preflightReasons.push('parameters_changed');
  }

  if (
    previous.mode === 'text_to_video' &&
    next.mode === 'text_to_video' &&
    !sameValue(
      {
        sourceKind: previous.textToVideo.sourceKind,
        shots: previous.textToVideo.shots
      },
      {
        sourceKind: next.textToVideo.sourceKind,
        shots: next.textToVideo.shots
      }
    )
  ) {
    enhancementReasons.push('shot_plan_changed');
    preflightReasons.push('shot_plan_changed');
    storyboardReasons.push('shot_plan_changed');
  }

  if (
    previous.mode === 'image_to_video' &&
    next.mode === 'image_to_video' &&
    !sameValue(requirementState(previous), requirementState(next))
  ) {
    enhancementReasons.push('requirements_changed');
    preflightReasons.push('requirements_changed');
  }

  let updated = {
    ...next,
    updatedAt,
    generation: {
      ...next.generation,
      enhancement: markArtifactStale(
        next.generation.enhancement,
        enhancementReasons
      ),
      preflight: markArtifactStale(
        next.generation.preflight,
        preflightReasons
      )
    }
  } as VideoWorkspaceDraft;

  if (updated.mode === 'text_to_video') {
    updated = {
      ...updated,
      textToVideo: {
        ...updated.textToVideo,
        storyboard: {
          ...markArtifactStale(
            updated.textToVideo.storyboard,
            storyboardReasons
          ),
          frameAssetIds: [...updated.textToVideo.storyboard.frameAssetIds]
        }
      }
    };
  }

  if (hasStaleArtifact(updated) && updated.state !== 'archived') {
    return { ...updated, state: 'stale' };
  }
  return updated;
}

export function isVideoWorkspaceDraft(
  value: unknown
): value is VideoWorkspaceDraft {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }

  const modeField = value.mode === 'quick_video'
    ? 'quick'
    : value.mode === 'text_to_video'
      ? 'textToVideo'
      : value.mode === 'image_to_video'
        ? 'imageToVideo'
        : undefined;

  if (
    !modeField ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'id',
      'projectId',
      'mode',
      'state',
      'origin',
      'prompt',
      'contextReferences',
      'generation',
      'createdAt',
      'updatedAt',
      modeField
    ]) ||
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.projectId) ||
    !isOneOf(value.mode, videoWorkspaceModes) ||
    !isOneOf(value.state, videoWorkspaceStates) ||
    !isVideoWorkspaceOrigin(value.origin) ||
    !isPromptSnapshot(value.prompt) ||
    !isVideoContextReferences(value.contextReferences) ||
    !isVideoGenerationWorkspace(value.generation) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    return false;
  }

  const draft = value as unknown as VideoWorkspaceDraft;
  const validModeState =
    (draft.mode === 'quick_video' &&
      isQuickVideoWorkspace(draft.quick)) ||
    (draft.mode === 'text_to_video' &&
      isTextToVideoWorkspace(draft.textToVideo, draft.generation)) ||
    (draft.mode === 'image_to_video' &&
      isImageToVideoWorkspace(draft.imageToVideo, draft.generation));

  if (!validModeState) {
    return false;
  }

  const stale = hasStaleArtifact(draft);
  return draft.state === 'stale'
    ? stale
    : draft.state === 'archived' || !stale;
}

export function isVideoEditHandoffIntent(
  value: unknown
): value is VideoEditHandoffIntent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'schemaVersion',
      'projectId',
      'sourceDraftId',
      'sourceWorkId',
      'requestedAt'
    ]) &&
    value.schemaVersion === 1 &&
    isNonBlankString(value.projectId) &&
    isNonBlankString(value.sourceDraftId) &&
    isNonBlankString(value.sourceWorkId) &&
    isTimestamp(value.requestedAt)
  );
}

function markArtifactStale(
  artifact: VideoArtifactStatus,
  reasons: readonly VideoWorkspaceStaleReason[]
): VideoArtifactStatus {
  if (artifact.state === 'not_created' || reasons.length === 0) {
    return { ...artifact, staleReasons: [...artifact.staleReasons] };
  }

  return {
    ...artifact,
    state: 'stale',
    staleReasons: addUniqueMany(artifact.staleReasons, reasons)
  };
}

function materialState(draft: VideoWorkspaceDraft): unknown {
  switch (draft.mode) {
    case 'quick_video':
      return draft.quick.reference;
    case 'text_to_video':
      return draft.textToVideo.materials;
    case 'image_to_video':
      return draft.imageToVideo.materials;
  }
}

function requirementState(draft: ImageToVideoWorkspaceDraft): unknown {
  return {
    mustKeep: draft.imageToVideo.mustKeep,
    allowedChanges: draft.imageToVideo.allowedChanges,
    prohibited: draft.imageToVideo.prohibited,
    subjectAction: draft.imageToVideo.subjectAction,
    cameraMovement: draft.imageToVideo.cameraMovement,
    pace: draft.imageToVideo.pace,
    depthOfField: draft.imageToVideo.depthOfField
  };
}

function hasStaleArtifact(draft: VideoWorkspaceDraft): boolean {
  if (
    draft.generation.enhancement.state === 'stale' ||
    draft.generation.preflight.state === 'stale'
  ) {
    return true;
  }
  return draft.mode === 'text_to_video' &&
    draft.textToVideo.storyboard.state === 'stale';
}

function isVideoWorkspaceOrigin(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'new') {
    return hasOnlyKeys(value, ['kind']);
  }
  return (
    value.kind === 'derived' &&
    hasOnlyKeys(value, ['kind', 'parentDraftId', 'parentMode']) &&
    isNonBlankString(value.parentDraftId) &&
    (isOneOf(value.parentMode, videoWorkspaceModes) ||
      isOneOf(value.parentMode, imageWorkspaceModes))
  );
}

function isVideoContextReferences(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const keys = value.map((reference) =>
    isRecord(reference)
      ? `${String(reference.kind)}:${String(reference.referenceId)}`
      : ''
  );
  return (
    value.every(
      (reference) =>
        isRecord(reference) &&
        hasOnlyKeys(reference, ['kind', 'referenceId']) &&
        isOneOf(reference.kind, videoContextKinds) &&
        isNonBlankString(reference.referenceId)
    ) &&
    new Set(keys).size === keys.length
  );
}

function isVideoGenerationWorkspace(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'model',
      'parameters',
      'enhancement',
      'preflight'
    ]) ||
    (value.model !== undefined && !isVideoModelSelection(value.model)) ||
    (value.parameters !== undefined &&
      !isVideoDynamicParameterSnapshot(value.parameters)) ||
    !isVideoArtifactStatus(value.enhancement) ||
    !isVideoArtifactStatus(value.preflight)
  ) {
    return false;
  }

  if (value.parameters !== undefined) {
    return (
      value.model !== undefined &&
      isRecord(value.model) &&
      isRecord(value.parameters) &&
      value.model.capabilityEvidenceId ===
        value.parameters.capabilityEvidenceId
    );
  }
  return true;
}

function isQuickVideoWorkspace(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['reference']) &&
    (value.reference === undefined ||
      isVideoMaterialSelection(value.reference))
  );
}

function isTextToVideoWorkspace(
  value: unknown,
  generation: VideoGenerationWorkspace
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'sourceKind',
      'materials',
      'shots',
      'storyboard'
    ]) ||
    !isOneOf(value.sourceKind, videoTextSourceKinds) ||
    (value.materials !== undefined &&
      !isVideoMaterialSlotSnapshot(value.materials, generation)) ||
    !isVideoShotDrafts(value.shots) ||
    !isVideoStoryboardDraft(value.storyboard)
  ) {
    return false;
  }
  return true;
}

function isImageToVideoWorkspace(
  value: unknown,
  generation: VideoGenerationWorkspace
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'materials',
      'mustKeep',
      'allowedChanges',
      'prohibited',
      'subjectAction',
      'cameraMovement',
      'pace',
      'depthOfField'
    ]) &&
    (value.materials === undefined ||
      isVideoMaterialSlotSnapshot(value.materials, generation)) &&
    isNonBlankStringArray(value.mustKeep) &&
    isNonBlankStringArray(value.allowedChanges) &&
    isNonBlankStringArray(value.prohibited) &&
    typeof value.subjectAction === 'string' &&
    typeof value.cameraMovement === 'string' &&
    typeof value.pace === 'string' &&
    typeof value.depthOfField === 'string'
  );
}

function isVideoMaterialSlotSnapshot(
  value: unknown,
  generation: VideoGenerationWorkspace
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['capabilityEvidenceId', 'slots']) ||
    !isNonBlankString(value.capabilityEvidenceId) ||
    !Array.isArray(value.slots) ||
    !value.slots.every(isVideoMaterialSlot) ||
    !hasUniqueStrings(
      value.slots.map((slot) =>
        isRecord(slot) && typeof slot.id === 'string' ? slot.id : ''
      )
    )
  ) {
    return false;
  }
  return (
    generation.model !== undefined &&
    generation.model.capabilityEvidenceId === value.capabilityEvidenceId
  );
}

function isVideoMaterialSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'role',
      'required',
      'acceptedMediaKinds',
      'selection'
    ]) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.role) &&
    typeof value.required === 'boolean' &&
    Array.isArray(value.acceptedMediaKinds) &&
    value.acceptedMediaKinds.length > 0 &&
    value.acceptedMediaKinds.every((kind) =>
      isOneOf(kind, videoMaterialKinds)
    ) &&
    hasUniqueStrings(value.acceptedMediaKinds) &&
    (value.selection === undefined ||
      (isVideoMaterialSelection(value.selection) &&
        value.acceptedMediaKinds.includes(value.selection.mediaKind) &&
        value.selection.role === value.role))
  );
}

function isVideoMaterialSelection(
  value: unknown
): value is VideoMaterialSelection {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['assetId', 'mediaKind', 'role', 'selectedAt']) &&
    isNonBlankString(value.assetId) &&
    isOneOf(value.mediaKind, videoMaterialKinds) &&
    isNonBlankString(value.role) &&
    isTimestamp(value.selectedAt)
  );
}

function isVideoShotDrafts(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(isVideoShotDraft)) {
    return false;
  }
  const ids = value.map((shot) => shot.id);
  const orders = value.map((shot) => shot.order);
  return hasUniqueStrings(ids) && new Set(orders).size === orders.length;
}

function isVideoShotDraft(value: unknown): value is VideoShotDraft {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'order',
      'description',
      'action',
      'cameraMovement',
      'pace',
      'depthOfField'
    ]) &&
    isNonBlankString(value.id) &&
    isPositiveInteger(value.order) &&
    isNonBlankString(value.description) &&
    isOptionalNonBlankString(value.action) &&
    isOptionalNonBlankString(value.cameraMovement) &&
    isOptionalNonBlankString(value.pace) &&
    isOptionalNonBlankString(value.depthOfField)
  );
}

function isVideoStoryboardDraft(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'state',
      'staleReasons',
      'completedAt',
      'frameAssetIds'
    ]) &&
    isVideoArtifactFields(value) &&
    Array.isArray(value.frameAssetIds) &&
    value.frameAssetIds.every(isNonBlankString) &&
    hasUniqueStrings(value.frameAssetIds)
  );
}

function isVideoArtifactStatus(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['state', 'staleReasons', 'completedAt']) ||
    !isVideoArtifactFields(value)
  ) {
    return false;
  }
  return true;
}

function isVideoArtifactFields(value: Record<string, unknown>): boolean {
  if (
    !isOneOf(value.state, videoArtifactStates) ||
    !Array.isArray(value.staleReasons) ||
    !value.staleReasons.every((reason) =>
      isOneOf(reason, videoWorkspaceStaleReasons)
    ) ||
    !hasUniqueStrings(value.staleReasons) ||
    (value.completedAt !== undefined && !isTimestamp(value.completedAt))
  ) {
    return false;
  }

  if (value.state === 'not_created') {
    return value.completedAt === undefined && value.staleReasons.length === 0;
  }
  if (value.state === 'current') {
    return value.completedAt !== undefined && value.staleReasons.length === 0;
  }
  return value.completedAt !== undefined && value.staleReasons.length > 0;
}

function isVideoModelSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['modelId', 'capabilityEvidenceId']) &&
    isNonBlankString(value.modelId) &&
    isNonBlankString(value.capabilityEvidenceId)
  );
}

function isVideoDynamicParameterSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['capabilityEvidenceId', 'values']) &&
    isNonBlankString(value.capabilityEvidenceId) &&
    isRecord(value.values) &&
    Object.entries(value.values).every(
      ([key, parameter]) =>
        key.trim().length > 0 && isVideoDynamicParameterValue(parameter)
    )
  );
}

function isVideoDynamicParameterValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isVideoDynamicParameterValue);
  }
  return isRecord(value) &&
    Object.values(value).every(isVideoDynamicParameterValue);
}

function isPromptSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'originalInput',
      'systemSupplements',
      'finalPrompt'
    ]) &&
    typeof value.originalInput === 'string' &&
    typeof value.finalPrompt === 'string' &&
    Array.isArray(value.systemSupplements) &&
    value.systemSupplements.every(
      (supplement) =>
        isRecord(supplement) &&
        hasOnlyKeys(supplement, [
          'content',
          'source',
          'sourceReference'
        ]) &&
        typeof supplement.content === 'string' &&
        isOneOf(supplement.source, promptSupplementSources) &&
        (supplement.sourceReference === undefined ||
          typeof supplement.sourceReference === 'string')
    )
  );
}

function clonePrompt(prompt: PromptSnapshot): PromptSnapshot {
  return {
    ...prompt,
    systemSupplements: prompt.systemSupplements.map((supplement) => ({
      ...supplement
    }))
  };
}

function addUniqueMany<TValue>(
  values: readonly TValue[],
  additions: readonly TValue[]
): readonly TValue[] {
  return [...new Set([...values, ...additions])];
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return values.every((value) => value.trim().length > 0) &&
    new Set(values).size === values.length;
}

function isNonBlankStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonBlankString);
}

function isOptionalNonBlankString(value: unknown): boolean {
  return value === undefined || isNonBlankString(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    toIsoTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOneOf<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[]
): value is TValue {
  return typeof value === 'string' && allowed.includes(value as TValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
