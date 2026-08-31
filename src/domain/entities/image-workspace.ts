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

export const imageWorkspaceModes = [
  'quick_image',
  'professional_image',
  'image_understanding',
  'image_editing',
  'image_to_prompt'
] as const;

export type ImageWorkspaceMode = (typeof imageWorkspaceModes)[number];

export const imageWorkspaceStates = [
  'editing',
  'saved',
  'stale',
  'archived'
] as const;

export type ImageWorkspaceState = (typeof imageWorkspaceStates)[number];

export const imageInputRoles = ['reference', 'source'] as const;
export type ImageInputRole = (typeof imageInputRoles)[number];

export const imageContextKinds = [
  'project_asset',
  'project_context',
  'saved_conversation'
] as const;

export type ImageContextKind = (typeof imageContextKinds)[number];

export const imageAnalysisStates = [
  'not_analyzed',
  'current',
  'stale'
] as const;

export type ImageAnalysisState = (typeof imageAnalysisStates)[number];

export const imageAnalysisStaleReasons = [
  'input_changed',
  'region_changed',
  'purpose_changed',
  'requirements_changed'
] as const;

export type ImageAnalysisStaleReason =
  (typeof imageAnalysisStaleReasons)[number];

export const imageUnderstandingSaveScopes = [
  'draft_only',
  'project_context'
] as const;

export type ImageUnderstandingSaveScope =
  (typeof imageUnderstandingSaveScopes)[number];

export type DynamicParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly DynamicParameterValue[]
  | { readonly [key: string]: DynamicParameterValue };

export interface NormalizedImageRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageInputReference {
  readonly assetId: AssetId;
  readonly role: ImageInputRole;
  readonly purpose?: string;
  readonly region?: NormalizedImageRegion;
  readonly selectedAt: IsoTimestamp;
}

export interface ImageContextReference {
  readonly kind: ImageContextKind;
  readonly referenceId: string;
  readonly contextRevision?: number;
  readonly includeInPrompt?: boolean;
}

export type ImageWorkspaceProductFeature =
  | 'image_understanding'
  | 'image_to_prompt'
  | 'text_to_image'
  | 'reference_to_image'
  | 'image_edit';

export interface ImageFeatureSelection {
  readonly productFeature: ImageWorkspaceProductFeature;
  readonly candidateId?: string;
  readonly parameterSchemaId?: string;
  readonly parameterSchemaRevision?: number;
  readonly parameterValues: Readonly<Record<string, DynamicParameterValue>>;
}

export interface ImageModelSelection {
  readonly modelId: ModelId;
  readonly capabilityEvidenceId: CapabilityEvidenceId;
}

export interface DynamicParameterSnapshot {
  readonly capabilityEvidenceId: CapabilityEvidenceId;
  readonly values: Readonly<Record<string, DynamicParameterValue>>;
}

export interface ImageWorkspaceOriginNew {
  readonly kind: 'new';
}

export interface ImageWorkspaceOriginDerived {
  readonly kind: 'derived';
  readonly parentDraftId: DraftId;
  readonly parentMode: ImageWorkspaceMode;
}

export type ImageWorkspaceOrigin =
  | ImageWorkspaceOriginNew
  | ImageWorkspaceOriginDerived;

export interface ImageObservation {
  readonly id: string;
  readonly content: string;
}

export interface ImageObservationSet {
  readonly visibleFacts: readonly ImageObservation[];
  readonly modelInferences: readonly ImageObservation[];
  readonly uncertainties: readonly ImageObservation[];
  readonly unrecognized: readonly ImageObservation[];
}

export interface ImageUnderstandingRevision {
  readonly id: string;
  readonly targetObservationId?: string;
  readonly content: string;
  readonly createdAt: IsoTimestamp;
}

export interface ImageGenerationWorkspace {
  readonly model?: ImageModelSelection;
  readonly parameters?: DynamicParameterSnapshot;
}

export interface ImageUnderstandingWorkspace {
  readonly analysisState: ImageAnalysisState;
  readonly observations: ImageObservationSet;
  readonly userRevisions: readonly ImageUnderstandingRevision[];
  readonly saveScope: ImageUnderstandingSaveScope;
  readonly staleReasons: readonly ImageAnalysisStaleReason[];
  readonly analyzedAt?: IsoTimestamp;
}

export interface ImageEditingLineage {
  readonly parentDraftId?: DraftId;
  readonly parentAssetId: AssetId;
  readonly parentWorkId?: WorkId;
}

export interface ImageEditingWorkspace {
  readonly lineage?: ImageEditingLineage;
  readonly maskAssetId?: AssetId;
  readonly mustKeep: readonly string[];
  readonly mustChange: readonly string[];
  readonly prohibited: readonly string[];
  readonly model?: ImageModelSelection;
  readonly parameters?: DynamicParameterSnapshot;
}

export interface ImageToPromptWorkspace {
  readonly analysisState: ImageAnalysisState;
  readonly purpose: string;
  readonly requirements: readonly string[];
  readonly observations: ImageObservationSet;
  readonly staleReasons: readonly ImageAnalysisStaleReason[];
  readonly analyzedAt?: IsoTimestamp;
}

interface ImageWorkspaceDraftBase {
  readonly schemaVersion: 1;
  readonly id: DraftId;
  readonly projectId: ProjectId;
  readonly state: ImageWorkspaceState;
  readonly origin: ImageWorkspaceOrigin;
  readonly prompt: PromptSnapshot;
  readonly input?: ImageInputReference;
  readonly contextReferences: readonly ImageContextReference[];
  readonly featureSelection?: ImageFeatureSelection;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface QuickImageWorkspaceDraft extends ImageWorkspaceDraftBase {
  readonly mode: 'quick_image';
  readonly generation: ImageGenerationWorkspace;
}

export interface ProfessionalImageWorkspaceDraft
  extends ImageWorkspaceDraftBase {
  readonly mode: 'professional_image';
  readonly generation: ImageGenerationWorkspace;
}

export interface ImageUnderstandingWorkspaceDraft
  extends ImageWorkspaceDraftBase {
  readonly mode: 'image_understanding';
  readonly understanding: ImageUnderstandingWorkspace;
}

export interface ImageEditingWorkspaceDraft extends ImageWorkspaceDraftBase {
  readonly mode: 'image_editing';
  readonly editing: ImageEditingWorkspace;
}

export interface ImageToPromptWorkspaceDraft extends ImageWorkspaceDraftBase {
  readonly mode: 'image_to_prompt';
  readonly imageToPrompt: ImageToPromptWorkspace;
}

export type ImageWorkspaceDraft =
  | QuickImageWorkspaceDraft
  | ProfessionalImageWorkspaceDraft
  | ImageUnderstandingWorkspaceDraft
  | ImageEditingWorkspaceDraft
  | ImageToPromptWorkspaceDraft;

export interface CreateEmptyImageWorkspaceDraftInput<
  TMode extends ImageWorkspaceMode = ImageWorkspaceMode
> {
  readonly id: DraftId;
  readonly projectId: ProjectId;
  readonly mode: TMode;
  readonly createdAt: IsoTimestamp;
  readonly origin?: ImageWorkspaceOrigin;
}

const emptyPrompt = (): PromptSnapshot => ({
  originalInput: '',
  systemSupplements: [],
  finalPrompt: ''
});

const emptyObservations = (): ImageObservationSet => ({
  visibleFacts: [],
  modelInferences: [],
  uncertainties: [],
  unrecognized: []
});

type ImageWorkspaceDraftForMode<TMode extends ImageWorkspaceMode> = Extract<
  ImageWorkspaceDraft,
  { readonly mode: TMode }
>;

export function createEmptyImageWorkspaceDraft<
  TMode extends ImageWorkspaceMode
>(
  input: CreateEmptyImageWorkspaceDraftInput<TMode>
): ImageWorkspaceDraftForMode<TMode> {
  const base = {
    schemaVersion: 1 as const,
    id: input.id,
    projectId: input.projectId,
    state: 'editing' as const,
    origin: input.origin ?? { kind: 'new' as const },
    prompt: emptyPrompt(),
    contextReferences: [],
    featureSelection: {
      productFeature: defaultImageFeatureForMode(input.mode),
      parameterValues: {}
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };

  switch (input.mode) {
    case 'quick_image':
    case 'professional_image':
      return {
        ...base,
        mode: input.mode,
        generation: {}
      } as unknown as ImageWorkspaceDraftForMode<TMode>;
    case 'image_understanding':
      return {
        ...base,
        mode: input.mode,
        understanding: {
          analysisState: 'not_analyzed',
          observations: emptyObservations(),
          userRevisions: [],
          saveScope: 'draft_only',
          staleReasons: []
        }
      } as unknown as ImageWorkspaceDraftForMode<TMode>;
    case 'image_editing':
      return {
        ...base,
        mode: input.mode,
        editing: {
          mustKeep: [],
          mustChange: [],
          prohibited: []
        }
      } as unknown as ImageWorkspaceDraftForMode<TMode>;
    case 'image_to_prompt':
      return {
        ...base,
        mode: input.mode,
        imageToPrompt: {
          analysisState: 'not_analyzed',
          purpose: '',
          requirements: [],
          observations: emptyObservations(),
          staleReasons: []
        }
      } as unknown as ImageWorkspaceDraftForMode<TMode>;
  }
}

export function createImageWorkspaceDraft<TDraft extends ImageWorkspaceDraft>(
  input: TDraft
): TDraft {
  if (!isImageWorkspaceDraft(input)) {
    throw new TypeError('image workspace draft is invalid');
  }

  return cloneImageWorkspaceDraft(withoutProfessionalInputPurpose(input));
}

export function deriveImageWorkspaceDraft(input: {
  readonly id: DraftId;
  readonly source: ImageWorkspaceDraft;
  readonly targetMode: ImageWorkspaceMode;
  readonly createdAt: IsoTimestamp;
}): ImageWorkspaceDraft {
  const derived = createEmptyImageWorkspaceDraft({
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
  const inputRole: ImageInputRole = input.targetMode === 'quick_image' ||
    input.targetMode === 'professional_image'
    ? 'reference'
    : 'source';
  const sourceInput = input.source.input;
  const shared = {
    ...derived,
    prompt: clonePrompt(input.source.prompt),
    input: sourceInput
      ? { ...sourceInput, role: inputRole, selectedAt: input.createdAt }
      : undefined,
    contextReferences: input.source.contextReferences.map((reference) => ({
      ...reference
    })),
    featureSelection:
      input.targetMode === 'professional_image' &&
      input.source.mode === 'quick_image' &&
      sourceInput
        ? {
            productFeature: 'reference_to_image' as const,
            parameterValues: {}
          }
        : derived.featureSelection
  };

  if (shared.mode === 'image_editing' && sourceInput) {
    return createImageWorkspaceDraft({
      ...shared,
      editing: {
        ...shared.editing,
        lineage: {
          parentDraftId: input.source.id,
          parentAssetId: sourceInput.assetId
        }
      }
    });
  }

  return createImageWorkspaceDraft(shared);
}

export function markImageAnalysisStale(
  draft: ImageUnderstandingWorkspaceDraft,
  reason: ImageAnalysisStaleReason,
  updatedAt: IsoTimestamp
): ImageUnderstandingWorkspaceDraft;
export function markImageAnalysisStale(
  draft: ImageToPromptWorkspaceDraft,
  reason: ImageAnalysisStaleReason,
  updatedAt: IsoTimestamp
): ImageToPromptWorkspaceDraft;
export function markImageAnalysisStale(
  draft: ImageUnderstandingWorkspaceDraft | ImageToPromptWorkspaceDraft,
  reason: ImageAnalysisStaleReason,
  updatedAt: IsoTimestamp
): ImageUnderstandingWorkspaceDraft | ImageToPromptWorkspaceDraft {
  if (draft.mode === 'image_understanding') {
    if (draft.understanding.analysisState === 'not_analyzed') {
      return { ...draft, updatedAt };
    }

    return {
      ...draft,
      state: 'stale',
      updatedAt,
      understanding: {
        ...draft.understanding,
        analysisState: 'stale',
        staleReasons: addUnique(draft.understanding.staleReasons, reason)
      }
    };
  }

  if (draft.imageToPrompt.analysisState === 'not_analyzed') {
    return { ...draft, updatedAt };
  }

  return {
    ...draft,
    state: 'stale',
    updatedAt,
    imageToPrompt: {
      ...draft.imageToPrompt,
      analysisState: 'stale',
      staleReasons: addUnique(draft.imageToPrompt.staleReasons, reason)
    }
  };
}

export function applyImageWorkspaceChangeStaleness(
  previous: ImageWorkspaceDraft,
  next: ImageWorkspaceDraft,
  updatedAt: IsoTimestamp
): ImageWorkspaceDraft {
  if (previous.mode !== next.mode || previous.id !== next.id) {
    throw new TypeError('image workspace staleness requires the same draft');
  }

  if (
    previous.mode === 'image_understanding' &&
    next.mode === 'image_understanding'
  ) {
    if (previous.understanding.analysisState === 'not_analyzed') {
      return next;
    }

    let updated = next;
    if (previous.input?.assetId !== next.input?.assetId) {
      updated = markImageAnalysisStale(updated, 'input_changed', updatedAt);
    }
    if (!sameValue(previous.input?.region, next.input?.region)) {
      updated = markImageAnalysisStale(updated, 'region_changed', updatedAt);
    }
    if (previous.input?.purpose !== next.input?.purpose) {
      updated = markImageAnalysisStale(updated, 'purpose_changed', updatedAt);
    }
    return updated;
  }

  if (previous.mode === 'image_to_prompt' && next.mode === 'image_to_prompt') {
    if (previous.imageToPrompt.analysisState === 'not_analyzed') {
      return next;
    }

    let updated = next;
    if (previous.input?.assetId !== next.input?.assetId) {
      updated = markImageAnalysisStale(updated, 'input_changed', updatedAt);
    }
    if (!sameValue(previous.input?.region, next.input?.region)) {
      updated = markImageAnalysisStale(updated, 'region_changed', updatedAt);
    }
    if (previous.imageToPrompt.purpose !== next.imageToPrompt.purpose) {
      updated = markImageAnalysisStale(updated, 'purpose_changed', updatedAt);
    }
    if (!sameValue(
      previous.imageToPrompt.requirements,
      next.imageToPrompt.requirements
    )) {
      updated = markImageAnalysisStale(
        updated,
        'requirements_changed',
        updatedAt
      );
    }
    return updated;
  }

  return next;
}

export function isImageWorkspaceDraft(
  value: unknown
): value is ImageWorkspaceDraft {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }

  const modeField = value.mode === 'quick_image' ||
    value.mode === 'professional_image'
    ? 'generation'
    : value.mode === 'image_understanding'
      ? 'understanding'
      : value.mode === 'image_editing'
        ? 'editing'
        : value.mode === 'image_to_prompt'
          ? 'imageToPrompt'
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
      'input',
      'contextReferences',
      'featureSelection',
      'createdAt',
      'updatedAt',
      modeField
    ])
  ) {
    return false;
  }

  if (
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.projectId) ||
    !isOneOf(value.mode, imageWorkspaceModes) ||
    !isOneOf(value.state, imageWorkspaceStates) ||
    !isWorkspaceOrigin(value.origin) ||
    !isPromptSnapshot(value.prompt) ||
    (value.input !== undefined && !isImageInput(value.input, value.mode)) ||
    !isContextReferences(value.contextReferences) ||
    (value.featureSelection !== undefined &&
      !isFeatureSelection(value.featureSelection, value.mode)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    return false;
  }

  switch (value.mode) {
    case 'quick_image':
    case 'professional_image':
      return isGenerationWorkspace(value.generation);
    case 'image_understanding':
      return isUnderstandingWorkspace(value.understanding, value.state);
    case 'image_editing':
      return isEditingWorkspace(value.editing, value.input);
    case 'image_to_prompt':
      return isImageToPromptWorkspace(value.imageToPrompt, value.state);
  }
}

function cloneImageWorkspaceDraft<TDraft extends ImageWorkspaceDraft>(
  draft: TDraft
): TDraft {
  return structuredClone(draft);
}

function withoutProfessionalInputPurpose<
  TDraft extends ImageWorkspaceDraft
>(draft: TDraft): TDraft {
  if (draft.mode !== 'professional_image' || !draft.input) return draft;
  return {
    ...draft,
    input: {
      assetId: draft.input.assetId,
      role: draft.input.role,
      ...(draft.input.region ? { region: { ...draft.input.region } } : {}),
      selectedAt: draft.input.selectedAt
    }
  } as TDraft;
}

function clonePrompt(prompt: PromptSnapshot): PromptSnapshot {
  return {
    ...prompt,
    systemSupplements: prompt.systemSupplements.map((supplement) => ({
      ...supplement
    }))
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addUnique<TValue>(
  values: readonly TValue[],
  value: TValue
): readonly TValue[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function isImageInput(value: unknown, mode: ImageWorkspaceMode): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'assetId',
      'role',
      'purpose',
      'region',
      'selectedAt'
    ]) ||
    !isNonBlankString(value.assetId) ||
    !isOneOf(value.role, imageInputRoles) ||
    (value.purpose !== undefined && !isNonBlankString(value.purpose)) ||
    (value.region !== undefined && !isNormalizedRegion(value.region)) ||
    !isTimestamp(value.selectedAt)
  ) {
    return false;
  }

  const expectedRole = mode === 'quick_image' || mode === 'professional_image'
    ? 'reference'
    : 'source';
  return value.role === expectedRole;
}

function isNormalizedRegion(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['x', 'y', 'width', 'height']) &&
    isUnitNumber(value.x) &&
    isUnitNumber(value.y) &&
    isPositiveUnitNumber(value.width) &&
    isPositiveUnitNumber(value.height) &&
    value.x + value.width <= 1 &&
    value.y + value.height <= 1
  );
}

function isWorkspaceOrigin(value: unknown): boolean {
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
    isOneOf(value.parentMode, imageWorkspaceModes)
  );
}

function isContextReferences(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (reference) => {
        if (
          !isRecord(reference) ||
          !hasOnlyKeys(reference, [
            'kind',
            'referenceId',
            'contextRevision',
            'includeInPrompt'
          ]) ||
          !isOneOf(reference.kind, imageContextKinds) ||
          !isNonBlankString(reference.referenceId)
        ) {
          return false;
        }
        if (reference.kind !== 'project_context') {
          return reference.contextRevision === undefined &&
            reference.includeInPrompt === undefined;
        }
        if (reference.contextRevision === undefined) {
          return reference.includeInPrompt === undefined;
        }
        return Number.isSafeInteger(reference.contextRevision) &&
          Number(reference.contextRevision) >= 1 &&
          typeof reference.includeInPrompt === 'boolean';
      }
    )
  );
}

function isFeatureSelection(
  value: unknown,
  mode: ImageWorkspaceMode
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'productFeature',
      'candidateId',
      'parameterSchemaId',
      'parameterSchemaRevision',
      'parameterValues'
    ]) ||
    !imageFeaturesForMode(mode).includes(
      value.productFeature as ImageWorkspaceProductFeature
    ) ||
    !isRecord(value.parameterValues) ||
    !Object.values(value.parameterValues).every(isDynamicParameterValue)
  ) {
    return false;
  }
  const hasCandidate = value.candidateId !== undefined;
  const hasSchemaId = value.parameterSchemaId !== undefined;
  const hasSchemaRevision = value.parameterSchemaRevision !== undefined;
  if (hasCandidate !== hasSchemaId || hasCandidate !== hasSchemaRevision) {
    return false;
  }
  return !hasCandidate || (
    isNonBlankString(value.candidateId) &&
    isNonBlankString(value.parameterSchemaId) &&
    Number.isSafeInteger(value.parameterSchemaRevision) &&
    Number(value.parameterSchemaRevision) >= 1
  );
}

export function defaultImageFeatureForMode(
  mode: ImageWorkspaceMode
): ImageWorkspaceProductFeature {
  if (mode === 'quick_image' || mode === 'professional_image') {
    return 'text_to_image';
  }
  if (mode === 'image_understanding') return 'image_understanding';
  if (mode === 'image_to_prompt') return 'image_to_prompt';
  return 'image_edit';
}

function imageFeaturesForMode(
  mode: ImageWorkspaceMode
): readonly ImageWorkspaceProductFeature[] {
  return mode === 'professional_image'
    ? ['text_to_image', 'reference_to_image']
    : [defaultImageFeatureForMode(mode)];
}

function isGenerationWorkspace(value: unknown): boolean {
  if (
    !(
    isRecord(value) &&
    hasOnlyKeys(value, ['model', 'parameters']) &&
    (value.model === undefined || isModelSelection(value.model)) &&
    (value.parameters === undefined ||
      isDynamicParameterSnapshot(value.parameters))
    )
  ) {
    return false;
  }

  return hasMatchingCapabilityEvidence(value.model, value.parameters);
}

function isUnderstandingWorkspace(
  value: unknown,
  workspaceState: ImageWorkspaceState
): boolean {
  if (!isRecord(value) || !isObservationSet(value.observations)) {
    return false;
  }

  if (!hasOnlyKeys(value, [
    'analysisState',
    'observations',
    'userRevisions',
    'saveScope',
    'staleReasons',
    'analyzedAt'
  ])) {
    return false;
  }

  const observationIds = getObservationIds(value.observations);
  return (
    isOneOf(value.analysisState, imageAnalysisStates) &&
    Array.isArray(value.userRevisions) &&
    value.userRevisions.every(isUnderstandingRevision) &&
    hasUniqueIds(value.userRevisions) &&
    value.userRevisions.every(
      (revision) =>
        revision.targetObservationId === undefined ||
        observationIds.has(revision.targetObservationId)
    ) &&
    isOneOf(value.saveScope, imageUnderstandingSaveScopes) &&
    isStaleReasons(value.staleReasons) &&
    (value.analyzedAt === undefined || isTimestamp(value.analyzedAt)) &&
    hasAnalysisStateConsistency(
      value.analysisState,
      value.analyzedAt,
      value.staleReasons,
      workspaceState
    )
  );
}

function isEditingWorkspace(
  value: unknown,
  input: unknown
): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !hasOnlyKeys(value, [
      'lineage',
      'maskAssetId',
      'mustKeep',
      'mustChange',
      'prohibited',
      'model',
      'parameters'
    ]) ||
    (value.lineage !== undefined && !isEditingLineage(value.lineage)) ||
    (value.maskAssetId !== undefined && !isNonBlankString(value.maskAssetId)) ||
    !isStringArray(value.mustKeep) ||
    !isStringArray(value.mustChange) ||
    !isStringArray(value.prohibited) ||
    (value.model !== undefined && !isModelSelection(value.model)) ||
    (value.parameters !== undefined &&
      !isDynamicParameterSnapshot(value.parameters))
  ) {
    return false;
  }

  const lineage = value.lineage;
  if (lineage !== undefined) {
    if (
      !isRecord(lineage) ||
      !isRecord(input) ||
      input.assetId !== lineage.parentAssetId
    ) {
      return false;
    }
  }

  return hasMatchingCapabilityEvidence(value.model, value.parameters);
}

function isImageToPromptWorkspace(
  value: unknown,
  workspaceState: ImageWorkspaceState
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'analysisState',
      'purpose',
      'requirements',
      'observations',
      'staleReasons',
      'analyzedAt'
    ]) &&
    isOneOf(value.analysisState, imageAnalysisStates) &&
    typeof value.purpose === 'string' &&
    isStringArray(value.requirements) &&
    isObservationSet(value.observations) &&
    isStaleReasons(value.staleReasons) &&
    (value.analyzedAt === undefined || isTimestamp(value.analyzedAt)) &&
    hasAnalysisStateConsistency(
      value.analysisState,
      value.analyzedAt,
      value.staleReasons,
      workspaceState
    )
  );
}

function hasAnalysisStateConsistency(
  state: unknown,
  analyzedAt: unknown,
  staleReasons: unknown,
  workspaceState: ImageWorkspaceState
): boolean {
  if (!Array.isArray(staleReasons)) {
    return false;
  }

  if (state === 'not_analyzed') {
    return analyzedAt === undefined && staleReasons.length === 0;
  }

  if (state === 'current') {
    return analyzedAt !== undefined && staleReasons.length === 0;
  }

  return (
    state === 'stale' &&
    analyzedAt !== undefined &&
    staleReasons.length > 0 &&
    workspaceState === 'stale'
  );
}

function isEditingLineage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['parentDraftId', 'parentAssetId', 'parentWorkId']) &&
    (value.parentDraftId === undefined || isNonBlankString(value.parentDraftId)) &&
    isNonBlankString(value.parentAssetId) &&
    (value.parentWorkId === undefined || isNonBlankString(value.parentWorkId))
  );
}

function isObservationSet(value: unknown): boolean {
  if (!(
    isRecord(value) &&
    hasOnlyKeys(value, [
      'visibleFacts',
      'modelInferences',
      'uncertainties',
      'unrecognized'
    ]) &&
    isObservationArray(value.visibleFacts) &&
    isObservationArray(value.modelInferences) &&
    isObservationArray(value.uncertainties) &&
    isObservationArray(value.unrecognized)
  )) {
    return false;
  }

  const observations = [
    ...value.visibleFacts,
    ...value.modelInferences,
    ...value.uncertainties,
    ...value.unrecognized
  ];
  return hasUniqueIds(observations);
}

function getObservationIds(value: unknown): ReadonlySet<string> {
  if (!isRecord(value)) {
    return new Set();
  }

  const observations = [
    ...(value.visibleFacts as readonly ImageObservation[]),
    ...(value.modelInferences as readonly ImageObservation[]),
    ...(value.uncertainties as readonly ImageObservation[]),
    ...(value.unrecognized as readonly ImageObservation[])
  ];
  return new Set(observations.map((observation) => observation.id));
}

function isObservationArray(
  value: unknown
): value is readonly ImageObservation[] {
  return Array.isArray(value) && value.every(isObservation);
}

function isObservation(value: unknown): value is ImageObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'content']) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.content)
  );
}

function isUnderstandingRevision(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'targetObservationId',
      'content',
      'createdAt'
    ]) &&
    isNonBlankString(value.id) &&
    (value.targetObservationId === undefined ||
      isNonBlankString(value.targetObservationId)) &&
    isNonBlankString(value.content) &&
    isTimestamp(value.createdAt)
  );
}

function isModelSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['modelId', 'capabilityEvidenceId']) &&
    isNonBlankString(value.modelId) &&
    isNonBlankString(value.capabilityEvidenceId)
  );
}

function isDynamicParameterSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['capabilityEvidenceId', 'values']) &&
    isNonBlankString(value.capabilityEvidenceId) &&
    isRecord(value.values) &&
    Object.entries(value.values).every(
      ([key, parameter]) =>
        key.trim().length > 0 && isDynamicParameterValue(parameter)
    )
  );
}

function hasMatchingCapabilityEvidence(
  model: unknown,
  parameters: unknown
): boolean {
  if (model === undefined || parameters === undefined) {
    return true;
  }

  return (
    isRecord(model) &&
    isRecord(parameters) &&
    model.capabilityEvidenceId === parameters.capabilityEvidenceId
  );
}

function hasUniqueIds(values: readonly unknown[]): boolean {
  const ids = values
    .filter(isRecord)
    .map((value) => value.id)
    .filter((id): id is string => typeof id === 'string');
  return ids.length === values.length && new Set(ids).size === ids.length;
}

function isDynamicParameterValue(value: unknown): boolean {
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
    return value.every(isDynamicParameterValue);
  }

  return (
    isRecord(value) &&
    Object.values(value).every(isDynamicParameterValue)
  );
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

function isStaleReasons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((reason) => isOneOf(reason, imageAnalysisStaleReasons))
  );
}

function isTimestamp(value: unknown): boolean {
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

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNonBlankString);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveUnitNumber(value: unknown): value is number {
  return isUnitNumber(value) && value > 0;
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
