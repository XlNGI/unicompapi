import type {
  AssetId,
  DynamicParameterFieldSchema,
  DynamicParameterSchema,
  ModelCapabilityEvidence,
  ProviderAccessCategory,
  VideoDynamicParameterValue,
  VideoGenerationModeCapabilitySchema,
  VideoMaterialSelection,
  VideoShotDraft,
  VideoWorkspaceDraft
} from '../../domain';
import type {
  VideoModeCapabilityDto,
  VideoPreflightCandidateDto,
  VideoPreflightDto,
  VideoSubmissionErrorCode
} from '../../shared/video-submission-ipc';
import type { ProviderRegistrySnapshot } from '../providers';

const acceptedCapabilityStates = [
  'verified_supported',
  'user_confirmed'
] as const;

export interface VideoMaterialFact {
  readonly assetId: AssetId;
  readonly mediaKind: 'image' | 'video';
  readonly role?: string;
  readonly fileState: string;
  readonly metadataAvailable: boolean;
}

export function buildVideoPreflight(
  draft: VideoWorkspaceDraft,
  registry: ProviderRegistrySnapshot,
  materialFacts: readonly VideoMaterialFact[]
): VideoPreflightDto {
  const blockers = new Set<VideoSubmissionErrorCode>();
  const candidateDiscoveryBlockers = new Set<VideoSubmissionErrorCode>();

  if (draft.state !== 'editing' && draft.state !== 'saved') {
    blockers.add('draft_not_submittable');
  }
  if (draft.prompt.finalPrompt.trim().length === 0) {
    blockers.add('prompt_required');
  }

  const models = new Map(registry.models.map((model) => [model.id, model]));
  const connections = new Map(
    registry.connections.map((connection) => [connection.id, connection])
  );
  const providers = new Map(
    registry.providers.map((provider) => [provider.id, provider])
  );
  const bindings = new Map(
    registry.protocolBindings.map((binding) => [binding.id, binding])
  );
  const selectedModelId = draft.generation.model?.modelId;
  const preferences = registry.routingPreferences
    .filter(
      (preference) =>
        preference.enabled &&
        preference.purpose === 'video_generation' &&
        (selectedModelId === undefined || preference.modelId === selectedModelId)
    )
    .sort((left, right) => left.priority - right.priority);

  if (preferences.length === 0) blockers.add('no_route_candidate');

  const candidates: VideoPreflightCandidateDto[] = [];
  for (const preference of preferences) {
    const model = models.get(preference.modelId);
    const connection = model ? connections.get(model.connectionId) : undefined;
    const provider = connection ? providers.get(connection.providerId) : undefined;
    if (!model?.enabled || connection?.state !== 'available' || !provider) {
      continue;
    }
    const binding = bindings.get(model.protocolBindingId);
    if (
      model.mediaKind !== 'video' ||
      binding?.mediaKind !== 'video' ||
      !binding.supportedPurposes.includes('video_generation')
    ) {
      candidateDiscoveryBlockers.add('no_route_candidate');
      continue;
    }

    const evidence = selectEvidence(
      registry.capabilities,
      model.id,
      'video_generation'
    );
    if (!evidence) {
      candidateDiscoveryBlockers.add('capability_unverified');
      continue;
    }
    if (!evidence.parameterSchema) {
      candidateDiscoveryBlockers.add('parameter_schema_missing');
      continue;
    }
    if (!evidence.videoGenerationSchema) {
      candidateDiscoveryBlockers.add('mode_schema_missing');
      continue;
    }
    const modeSchema = evidence.videoGenerationSchema.modes.find(
      (mode) => mode.mode === draft.mode
    );
    if (!modeSchema) {
      candidateDiscoveryBlockers.add('mode_unsupported');
      continue;
    }

    const candidateBlockers = new Set<VideoSubmissionErrorCode>();
    if (
      draft.generation.model &&
      draft.generation.model.capabilityEvidenceId !== evidence.id
    ) {
      candidateBlockers.add('capability_snapshot_stale');
    }
    const parameters = parameterValuesForVideoDraft(draft);
    if (
      parameters.evidenceId !== undefined &&
      parameters.evidenceId !== evidence.id
    ) {
      candidateBlockers.add('parameters_invalid');
    } else if (
      !validateVideoDynamicParameters(
        evidence.parameterSchema,
        parameters.values
      )
    ) {
      candidateBlockers.add('parameters_invalid');
    }
    for (const blocker of validateModeInput(
      draft,
      evidence,
      modeSchema,
      materialFacts
    )) {
      candidateBlockers.add(blocker);
    }

    candidates.push({
      modelId: model.id,
      modelName: model.displayName,
      capabilityEvidenceId: evidence.id,
      providerId: provider.id,
      connectionId: connection.id,
      recipientName: `${provider.name} / ${connection.name}`,
      accessCategory: provider.accessCategory,
      outboundScope: outboundScopeForAccess(provider.accessCategory),
      costState: 'unknown',
      privacyState: 'unknown',
      regionState: 'unknown',
      parameterSchema: evidence.parameterSchema,
      modeSchema: structuredClone(modeSchema) as VideoModeCapabilityDto,
      blockers: [...candidateBlockers]
    });
  }

  if (candidates.length === 0) {
    for (const blocker of candidateDiscoveryBlockers) blockers.add(blocker);
    if (blockers.size === 0) blockers.add('no_route_candidate');
  }

  return {
    draftId: draft.id,
    draftUpdatedAt: draft.updatedAt,
    purpose: 'video_generation',
    candidates,
    blockers: [...blockers],
    requiresSubmissionConfirmation: true
  };
}

export function parameterValuesForVideoDraft(draft: VideoWorkspaceDraft): {
  readonly evidenceId?: string;
  readonly values: Readonly<Record<string, VideoDynamicParameterValue>>;
} {
  return {
    evidenceId: draft.generation.parameters?.capabilityEvidenceId,
    values: draft.generation.parameters?.values ?? {}
  };
}

export function videoMaterialSelections(
  draft: VideoWorkspaceDraft
): readonly {
  readonly selection: VideoMaterialSelection;
  readonly target:
    | { readonly kind: 'quick_reference' }
    | { readonly kind: 'slot'; readonly slotId: string };
}[] {
  if (draft.mode === 'quick_video') {
    return draft.quick.reference
      ? [{ selection: draft.quick.reference, target: { kind: 'quick_reference' } }]
      : [];
  }
  const materials = draft.mode === 'text_to_video'
    ? draft.textToVideo.materials
    : draft.imageToVideo.materials;
  return materials?.slots.flatMap((slot) =>
    slot.selection
      ? [{ selection: slot.selection, target: { kind: 'slot' as const, slotId: slot.id } }]
      : []
  ) ?? [];
}

function validateModeInput(
  draft: VideoWorkspaceDraft,
  evidence: ModelCapabilityEvidence,
  schema: VideoGenerationModeCapabilitySchema,
  materialFacts: readonly VideoMaterialFact[]
): readonly VideoSubmissionErrorCode[] {
  const blockers = new Set<VideoSubmissionErrorCode>();
  const facts = new Map(materialFacts.map((fact) => [fact.assetId, fact]));

  if (draft.mode === 'quick_video' && schema.mode === 'quick_video') {
    const reference = draft.quick.reference;
    if (
      reference &&
      (!schema.reference ||
        !schema.reference.acceptedMediaKinds.includes(reference.mediaKind))
    ) {
      blockers.add('material_invalid');
    }
    if (reference && !isAvailableSelection(reference, facts)) {
      blockers.add('material_invalid');
    }
    return [...blockers];
  }

  if (draft.mode === 'text_to_video' && schema.mode === 'text_to_video') {
    validateSlots(
      draft.textToVideo.materials,
      evidence.id,
      schema.materialSlots,
      facts,
      blockers
    );
    validateShots(draft.textToVideo.shots, schema.shotPlan, blockers);
    return [...blockers];
  }

  if (draft.mode === 'image_to_video' && schema.mode === 'image_to_video') {
    if (!schema.materialSlots.some(
      (slot) => slot.required && slot.acceptedMediaKinds.includes('image')
    )) {
      blockers.add('mode_schema_invalid');
    }
    validateSlots(
      draft.imageToVideo.materials,
      evidence.id,
      schema.materialSlots,
      facts,
      blockers
    );
    return [...blockers];
  }

  return ['mode_unsupported'];
}

function validateSlots(
  snapshot: {
    readonly capabilityEvidenceId: string;
    readonly slots: readonly {
      readonly id: string;
      readonly role: string;
      readonly required: boolean;
      readonly acceptedMediaKinds: readonly ('image' | 'video')[];
      readonly selection?: VideoMaterialSelection;
    }[];
  } | undefined,
  evidenceId: string,
  schemaSlots: readonly {
    readonly id: string;
    readonly role: string;
    readonly required: boolean;
    readonly acceptedMediaKinds: readonly ('image' | 'video')[];
  }[],
  facts: ReadonlyMap<AssetId, VideoMaterialFact>,
  blockers: Set<VideoSubmissionErrorCode>
): void {
  if (schemaSlots.length === 0 && !snapshot) return;
  if (
    !snapshot ||
    snapshot.capabilityEvidenceId !== evidenceId ||
    snapshot.slots.length !== schemaSlots.length ||
    snapshot.slots.some((slot, index) =>
      !sameSlotSchema(slot, schemaSlots[index])
    )
  ) {
    blockers.add('material_slots_stale');
    return;
  }

  for (const slot of snapshot.slots) {
    if (slot.required && !slot.selection) blockers.add('material_required');
    if (slot.selection && !isAvailableSelection(slot.selection, facts)) {
      blockers.add('material_invalid');
    }
  }
}

function sameSlotSchema(
  left: {
    readonly id: string;
    readonly role: string;
    readonly required: boolean;
    readonly acceptedMediaKinds: readonly ('image' | 'video')[];
  },
  right: {
    readonly id: string;
    readonly role: string;
    readonly required: boolean;
    readonly acceptedMediaKinds: readonly ('image' | 'video')[];
  } | undefined
): boolean {
  return Boolean(
    right &&
    left.id === right.id &&
    left.role === right.role &&
    left.required === right.required &&
    left.acceptedMediaKinds.length === right.acceptedMediaKinds.length &&
    left.acceptedMediaKinds.every((kind) =>
      right.acceptedMediaKinds.includes(kind)
    )
  );
}

function isAvailableSelection(
  selection: VideoMaterialSelection,
  facts: ReadonlyMap<AssetId, VideoMaterialFact>
): boolean {
  const fact = facts.get(selection.assetId);
  return Boolean(
    fact &&
    fact.mediaKind === selection.mediaKind &&
    fact.role === selection.role &&
    fact.fileState === 'available' &&
    fact.metadataAvailable
  );
}

function validateShots(
  shots: readonly VideoShotDraft[],
  schema: {
    readonly supported: boolean;
    readonly required: boolean;
    readonly minimumShots?: number;
    readonly maximumShots?: number;
  },
  blockers: Set<VideoSubmissionErrorCode>
): void {
  if (!schema.supported && shots.length > 0) {
    blockers.add('shot_plan_invalid');
    return;
  }
  if (schema.required && shots.length === 0) blockers.add('shot_plan_invalid');
  if (schema.minimumShots !== undefined && shots.length < schema.minimumShots) {
    blockers.add('shot_plan_invalid');
  }
  if (schema.maximumShots !== undefined && shots.length > schema.maximumShots) {
    blockers.add('shot_plan_invalid');
  }
  if (shots.some((shot) => shot.description.trim().length === 0)) {
    blockers.add('shot_plan_invalid');
  }
}

export function validateVideoDynamicParameters(
  schema: DynamicParameterSchema,
  values: Readonly<Record<string, VideoDynamicParameterValue>>
): boolean {
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  if (Object.keys(values).some((key) => !fields.has(key))) return false;
  return schema.fields.every((field) => {
    const value = values[field.key];
    if (value === undefined) return !field.required;
    return validateField(field, value);
  });
}

function validateField(
  field: DynamicParameterFieldSchema,
  value: VideoDynamicParameterValue
): boolean {
  if (field.kind === 'string') return typeof value === 'string';
  if (field.kind === 'boolean') return typeof value === 'boolean';
  if (field.kind === 'enum') {
    return (
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean') &&
      (field.options?.includes(value) ?? false)
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (field.kind === 'integer' && !Number.isInteger(value)) return false;
  if (field.minimum !== undefined && value < field.minimum) return false;
  if (field.maximum !== undefined && value > field.maximum) return false;
  return true;
}

function selectEvidence(
  evidence: readonly ModelCapabilityEvidence[],
  modelId: string,
  purpose: string
): ModelCapabilityEvidence | undefined {
  return evidence
    .filter(
      (item) =>
        item.modelId === modelId &&
        item.capability === purpose &&
        acceptedCapabilityStates.includes(
          item.state as (typeof acceptedCapabilityStates)[number]
        )
    )
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
}

function outboundScopeForAccess(
  access: ProviderAccessCategory
): VideoPreflightCandidateDto['outboundScope'] {
  if (access === 'local') return 'local_device';
  if (access === 'lan') return 'local_network';
  if (access === 'online' || access === 'custom_remote') {
    return 'external_service';
  }
  return 'unknown';
}
