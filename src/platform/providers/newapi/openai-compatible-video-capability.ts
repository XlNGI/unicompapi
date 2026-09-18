import type {
  CapabilityEvidenceSource,
  ModelCapabilityEvidence,
  ProviderModel
} from '../../../domain';
import type { ProviderRegistrySnapshot } from '../provider-registry';

/**
 * Capability truth source for OpenAI-compatible (NewAPI / UniCompAPI) video
 * profiles.
 *
 * Two facts must stay separate:
 *   1. connection-level adapter capability — the package publishes
 *      `newapi.video` (POST /v1/videos). This only proves a call channel exists.
 *   2. per-model capability — the concrete provider model supports video.
 *
 * The previous soft router collapsed the two: any enabled model behind a
 * connection whose template published the video adapter received
 * `text_to_video` + `image_to_video`. That fabricated per-model capability and
 * persisted it. This module is the gate that prevents the collapse.
 */

/**
 * Bump when the trust rules below change. Query-time invalidation and
 * diagnostics record this version so a profile rejected by an older rule set
 * can be explained without rewriting user data.
 */
export const OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION = 2;

/**
 * Evidence identifiers created by the removed synthetic router path. They were
 * written by the platform itself and therefore prove nothing about the model.
 * They must never satisfy the capability gate again.
 */
export const ROUTER_SYNTHESIZED_VIDEO_EVIDENCE_SUFFIX =
  '-video_generation-declared-v1';

/** Evidence the platform is allowed to trust as a per-model declaration. */
const trustedEvidenceSources: readonly CapabilityEvidenceSource[] = [
  'provider_declared',
  'connection_verified',
  'user_confirmed',
  'system_observed'
];

/** Evidence states that assert the model actually supports video generation. */
const trustedPositiveStates = new Set(['verified_supported', 'declared_supported', 'user_confirmed']);

/** Evidence states that assert the model specifically does not support video. */
const negativeStates = new Set(['unsupported', 'restricted', 'verification_failed']);

export const openAiCompatibleVideoGateReasons = [
  /** Trusted package-level exact model mapping (e.g. the UniCompAPI capability table). */
  'package_closed_world_mapping',
  /** Trusted package-level exact model mapping for a generic package. */
  'exact_package_model_mapping',
  /** The user explicitly confirmed this concrete model supports video. */
  'user_confirmed_model',
  /** Non-synthetic per-model capability evidence declares video support. */
  'verified_capability_evidence',
  /** No trustworthy per-model evidence exists — capability stays unknown. */
  'missing_capability_evidence',
  /** Trustworthy evidence says the model does not support video. */
  'unsupported_model_capability',
  /** The model row is retired and must not receive a new profile. */
  'model_retired',
  /** The connection is not ready to execute. */
  'connection_not_ready',
  /** The package template no longer publishes the video adapter. */
  'video_adapter_missing'
] as const;
export type OpenAiCompatibleVideoGateReason =
  (typeof openAiCompatibleVideoGateReasons)[number];

export const openAiCompatibleVideoProfileInvalidationReasons = [
  'router_synthesized_evidence',
  'missing_capability_evidence',
  'unsupported_model_capability',
  'package_no_longer_publishes_video_adapter'
] as const;
export type OpenAiCompatibleVideoProfileInvalidationReason =
  (typeof openAiCompatibleVideoProfileInvalidationReasons)[number];

/** Reasons that mean "the capability is unknown", never "the capability is false". */
const unknownCapabilityReasons = new Set<OpenAiCompatibleVideoGateReason>([
  'missing_capability_evidence'
]);

export function isUnknownCapabilityReason(
  reason: OpenAiCompatibleVideoGateReason
): boolean {
  return unknownCapabilityReasons.has(reason);
}

/**
 * Trusted package-level exact model mapping.
 *
 * Deliberately empty for the generic OpenAI Compatible package: a relay that
 * merely speaks the OpenAI wire format has published no per-model video
 * metadata, so no model may be inferred. Entries are added only with a
 * verifiable, per-model source document revision.
 */
export interface OpenAiCompatibleExactVideoModelMapping {
  readonly packageId: string;
  readonly providerModelKey: string;
  readonly features: readonly ('text_to_video' | 'image_to_video')[];
  readonly sourceDocumentRevision: string;
}

export const OPENAI_COMPATIBLE_EXACT_VIDEO_MODEL_MAPPINGS:
  readonly OpenAiCompatibleExactVideoModelMapping[] = [];

export function resolveOpenAiCompatibleExactVideoModelMapping(input: {
  readonly packageId: string;
  readonly providerModelKey: string;
}): OpenAiCompatibleExactVideoModelMapping | undefined {
  return OPENAI_COMPATIBLE_EXACT_VIDEO_MODEL_MAPPINGS.find(
    (mapping) =>
      mapping.packageId === input.packageId &&
      mapping.providerModelKey === input.providerModelKey
  );
}

export interface OpenAiCompatibleVideoGateVerdict {
  readonly allowed: boolean;
  readonly reason: OpenAiCompatibleVideoGateReason;
  readonly gateVersion: number;
  /** Trusted evidence accepted by the gate; empty when the mapping authorised it. */
  readonly evidenceIds: readonly string[];
}

/**
 * Identifies evidence invented by the removed synthetic router path. The
 * platform must not use its own guess as proof of the model's capability.
 */
export function isRouterSynthesizedVideoEvidence(
  evidence: Pick<ModelCapabilityEvidence, 'id' | 'capability' | 'source' | 'state'>
): boolean {
  return (
    evidence.capability === 'video_generation' &&
    evidence.source === 'provider_declared' &&
    evidence.state === 'declared_supported' &&
    evidence.id.endsWith(ROUTER_SYNTHESIZED_VIDEO_EVIDENCE_SUFFIX)
  );
}

export function isTrustedVideoCapabilityEvidence(
  evidence: Pick<ModelCapabilityEvidence, 'id' | 'capability' | 'source' | 'state'>
): boolean {
  return (
    evidence.capability === 'video_generation' &&
    trustedEvidenceSources.includes(evidence.source) &&
    trustedPositiveStates.has(evidence.state) &&
    !isRouterSynthesizedVideoEvidence(evidence)
  );
}

export function listTrustedVideoCapabilityEvidence(
  snapshot: Pick<ProviderRegistrySnapshot, 'capabilities'>,
  modelId: string
): readonly ModelCapabilityEvidence[] {
  return snapshot.capabilities.filter(
    (evidence) => evidence.modelId === modelId && isTrustedVideoCapabilityEvidence(evidence)
  );
}

export function listNegativeVideoCapabilityEvidence(
  snapshot: Pick<ProviderRegistrySnapshot, 'capabilities'>,
  modelId: string
): readonly ModelCapabilityEvidence[] {
  return snapshot.capabilities.filter(
    (evidence) => evidence.modelId === modelId && negativeStates.has(evidence.state)
  );
}

/**
 * Single decision point shared by the video router and the candidate source.
 *
 * `exactMappingFeatures` lets the caller substitute a package-owned exact
 * mapping (the UniCompAPI capability table) for the generic mapping table,
 * so the closed-world package keeps its current behaviour while the generic
 * package loses its inferred capability.
 */
export function evaluateOpenAiCompatibleVideoGate(input: {
  readonly snapshot: Pick<ProviderRegistrySnapshot, 'capabilities'>;
  readonly model?: Pick<ProviderModel, 'id' | 'catalogState'>;
  readonly modelId: string;
  readonly packageId: string;
  readonly providerModelKey: string;
  readonly exactMappingFeatures?: readonly ('text_to_video' | 'image_to_video')[];
}): OpenAiCompatibleVideoGateVerdict {
  if (input.model && (input.model.catalogState ?? 'present') === 'retired') {
    return verdict(false, 'model_retired');
  }
  if (input.exactMappingFeatures && input.exactMappingFeatures.length > 0) {
    return verdict(true, 'package_closed_world_mapping');
  }
  const mapping = resolveOpenAiCompatibleExactVideoModelMapping({
    packageId: input.packageId,
    providerModelKey: input.providerModelKey
  });
  if (mapping && mapping.features.length > 0) {
    return verdict(true, 'exact_package_model_mapping');
  }
  const trusted = listTrustedVideoCapabilityEvidence(input.snapshot, input.modelId);
  if (trusted.length > 0) {
    const userConfirmed = trusted.filter((evidence) => evidence.source === 'user_confirmed');
    return {
      allowed: true,
      reason: userConfirmed.length > 0 ? 'user_confirmed_model' : 'verified_capability_evidence',
      gateVersion: OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION,
      evidenceIds: trusted.map((evidence) => evidence.id)
    };
  }
  const negative = listNegativeVideoCapabilityEvidence(input.snapshot, input.modelId).filter(
    (evidence) => evidence.capability === 'video_generation'
  );
  if (negative.length > 0) {
    return verdict(false, 'unsupported_model_capability');
  }
  return verdict(false, 'missing_capability_evidence');
}

export interface InvalidatedOpenAiCompatibleVideoProfile {
  readonly profileId: string;
  readonly modelId: string;
  readonly providerModelKey: string;
  readonly packageId: string;
  readonly reason: OpenAiCompatibleVideoProfileInvalidationReason;
  readonly gateVersion: number;
}

/**
 * Query-time, read-only invalidation report.
 *
 * Legacy profiles that were minted from the synthetic evidence are excluded by
 * the candidate gate (see `RegistryFeatureCandidateSource`). Nothing is deleted
 * from the user registry, so a rollback is simply "stop excluding them": the
 * report is derived, never persisted, and therefore always reversible.
 */
export function describeInvalidatedOpenAiCompatibleVideoProfiles(
  snapshot: ProviderRegistrySnapshot,
  isVideoFeature: (productFeature: string) => boolean
): readonly InvalidatedOpenAiCompatibleVideoProfile[] {
  const invalidations: InvalidatedOpenAiCompatibleVideoProfile[] = [];
  for (const profile of snapshot.modelProfiles ?? []) {
    const videoFeatures = profile.features.filter((feature) =>
      isVideoFeature(feature.productFeature)
    );
    if (videoFeatures.length === 0) continue;
    const model = snapshot.models.find((candidate) => candidate.id === profile.modelId);
    if (!model) continue;
    const evidence = profile.evidenceIds
      .map((evidenceId) => snapshot.capabilities.find((item) => item.id === evidenceId))
      .filter((item): item is ModelCapabilityEvidence => Boolean(item));
    const reason = invalidationReason(snapshot, model, evidence);
    if (!reason) continue;
    invalidations.push({
      profileId: profile.profileId,
      modelId: model.id,
      providerModelKey: model.providerModelKey,
      packageId: profile.packageId,
      reason,
      gateVersion: OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION
    });
  }
  return invalidations;
}

function invalidationReason(
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel,
  evidence: readonly ModelCapabilityEvidence[]
): OpenAiCompatibleVideoProfileInvalidationReason | undefined {
  if (evidence.some((item) => isRouterSynthesizedVideoEvidence(item))) {
    return 'router_synthesized_evidence';
  }
  const trusted = listTrustedVideoCapabilityEvidence(snapshot, model.id);
  if (trusted.length > 0) return undefined;
  if (listNegativeVideoCapabilityEvidence(snapshot, model.id).length > 0) {
    return 'unsupported_model_capability';
  }
  return 'missing_capability_evidence';
}

function verdict(
  allowed: boolean,
  reason: OpenAiCompatibleVideoGateReason
): OpenAiCompatibleVideoGateVerdict {
  return {
    allowed,
    reason,
    gateVersion: OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION,
    evidenceIds: []
  };
}
