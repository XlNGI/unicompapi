import type { ModelCapabilityEvidence, ProviderExecutionRouteSnapshotV1 } from '../../domain';
import { createHash } from 'node:crypto';

type CapabilityPin = NonNullable<ProviderExecutionRouteSnapshotV1['capabilityEvidencePin']>;

export function pinCapabilityEvidence(evidence: ModelCapabilityEvidence): CapabilityPin {
  return { id: evidence.id, revision: evidence.revision, fingerprint: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}

export function resolvePinnedCapabilityEvidence(evidence: readonly ModelCapabilityEvidence[], pin: CapabilityPin,
  modelId: string, purposes: readonly string[]): ModelCapabilityEvidence {
  const selected = evidence.find(item => item.id === pin.id);
  if (!selected || selected.modelId !== modelId || !purposes.includes(selected.capability) || selected.revision !== pin.revision ||
      pinCapabilityEvidence(selected).fingerprint !== pin.fingerprint || !['verified_supported', 'user_confirmed', 'declared_supported'].includes(selected.state)) {
    throw new Error('route_capability_evidence_changed');
  }
  return selected;
}

/** Revision is the immutable evidence clock; observation time cannot revive superseded support. */
export function latestCapabilityEvidenceByCapability(evidence: readonly ModelCapabilityEvidence[]): ReadonlyMap<string, ModelCapabilityEvidence> {
  const latest = new Map<string, ModelCapabilityEvidence>();
  for (const item of evidence) {
    if ((latest.get(item.capability)?.revision ?? -1) < item.revision) latest.set(item.capability, item);
  }
  return latest;
}
