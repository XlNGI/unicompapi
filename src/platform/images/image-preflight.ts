import {
  imagePurposeForMode,
  type DynamicParameterFieldSchema,
  type DynamicParameterSchema,
  type DynamicParameterValue,
  type ImageOutboundScope,
  type ImageWorkspaceDraft,
  type ModelCapabilityEvidence,
  type ProviderAccessCategory
} from '../../domain';
import type {
  ImagePreflightCandidateDto,
  ImagePreflightDto,
  ImageSubmissionErrorCode
} from '../../shared/image-submission-ipc';
import type { ProviderRegistrySnapshot } from '../providers';

const acceptedCapabilityStates = [
  'verified_supported',
  'user_confirmed'
] as const;

export function buildImagePreflight(
  draft: ImageWorkspaceDraft,
  registry: ProviderRegistrySnapshot
): ImagePreflightDto {
  const purpose = imagePurposeForMode(draft.mode);
  const blockers = new Set<ImageSubmissionErrorCode>();
  const candidateBlockers = new Set<ImageSubmissionErrorCode>();

  if (draft.state !== 'editing' && draft.state !== 'saved') {
    blockers.add('draft_not_submittable');
  }
  if (requiresInput(draft) && !draft.input) {
    blockers.add('input_required');
  }
  if (requiresFinalPrompt(draft) && draft.prompt.finalPrompt.trim().length === 0) {
    blockers.add('draft_not_submittable');
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
  const candidates: ImagePreflightCandidateDto[] = [];
  const selectedModelId = selectedModelForDraft(draft);
  const preferences = registry.routingPreferences
    .filter(
      (preference) =>
        preference.enabled &&
        preference.purpose === purpose &&
        (selectedModelId === undefined || preference.modelId === selectedModelId)
    )
    .sort((left, right) => left.priority - right.priority);

  if (preferences.length === 0) {
    blockers.add('no_route_candidate');
  }

  for (const preference of preferences) {
    const model = models.get(preference.modelId);
    const connection = model ? connections.get(model.connectionId) : undefined;
    const provider = connection ? providers.get(connection.providerId) : undefined;
    if (!model?.enabled || connection?.state !== 'available' || !provider) {
      continue;
    }
    const binding = bindings.get(model.protocolBindingId);
    if (
      model.mediaKind !== 'image' ||
      binding?.mediaKind !== 'image' ||
      !binding.supportedPurposes.includes(purpose)
    ) {
      candidateBlockers.add('no_route_candidate');
      continue;
    }

    const evidence = selectEvidence(
      registry.capabilities,
      model.id,
      purpose
    );
    if (!evidence) {
      candidateBlockers.add('capability_unverified');
      continue;
    }
    if (!evidence.parameterSchema) {
      candidateBlockers.add('parameter_schema_missing');
      continue;
    }

    const values = parameterValuesForDraft(draft);
    if (
      values.evidenceId !== undefined &&
      values.evidenceId !== evidence.id
    ) {
      candidateBlockers.add('parameters_invalid');
      continue;
    }
    if (!validateDynamicParameters(evidence.parameterSchema, values.values)) {
      candidateBlockers.add('parameters_invalid');
      continue;
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
      parameterSchema: evidence.parameterSchema
    });
  }

  if (candidates.length === 0) {
    for (const blocker of candidateBlockers) blockers.add(blocker);
    if (blockers.size === 0) blockers.add('no_route_candidate');
  }

  return {
    draftId: draft.id,
    draftUpdatedAt: draft.updatedAt,
    purpose,
    candidates,
    blockers: [...blockers],
    requiresSubmissionConfirmation: true
  };
}

function selectedModelForDraft(draft: ImageWorkspaceDraft): string | undefined {
  if (draft.mode === 'quick_image' || draft.mode === 'professional_image') {
    return draft.generation.model?.modelId;
  }
  if (draft.mode === 'image_editing') return draft.editing.model?.modelId;
  return undefined;
}

export function validateDynamicParameters(
  schema: DynamicParameterSchema,
  values: Readonly<Record<string, DynamicParameterValue>>
): boolean {
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  if (Object.keys(values).some((key) => !fields.has(key))) {
    return false;
  }

  return schema.fields.every((field) => {
    const value = values[field.key];
    if (value === undefined) return !field.required;
    return validateField(field, value);
  });
}

export function parameterValuesForDraft(draft: ImageWorkspaceDraft): {
  readonly evidenceId?: string;
  readonly values: Readonly<Record<string, DynamicParameterValue>>;
} {
  const snapshot = draft.mode === 'quick_image' ||
    draft.mode === 'professional_image'
    ? draft.generation.parameters
    : draft.mode === 'image_editing'
      ? draft.editing.parameters
      : undefined;
  return {
    evidenceId: snapshot?.capabilityEvidenceId,
    values: snapshot?.values ?? {}
  };
}

function validateField(
  field: DynamicParameterFieldSchema,
  value: DynamicParameterValue
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

function requiresInput(draft: ImageWorkspaceDraft): boolean {
  return draft.mode !== 'quick_image' && draft.mode !== 'professional_image';
}

function requiresFinalPrompt(draft: ImageWorkspaceDraft): boolean {
  return (
    draft.mode === 'quick_image' ||
    draft.mode === 'professional_image' ||
    draft.mode === 'image_editing'
  );
}

function outboundScopeForAccess(
  access: ProviderAccessCategory
): ImageOutboundScope {
  if (access === 'local') return 'local_device';
  if (access === 'lan') return 'local_network';
  if (access === 'online' || access === 'custom_remote') {
    return 'external_service';
  }
  return 'unknown';
}
