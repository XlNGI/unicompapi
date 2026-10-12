import { describe, expect, it } from 'vitest';
import { createModelCapabilityEvidence, toCapabilityEvidenceId, toModelId, toIsoTimestamp } from '../../src/domain';
import { pinCapabilityEvidence, resolvePinnedCapabilityEvidence } from '../../src/platform/providers/model-capability-selection';

describe('admitted capability evidence snapshots', () => {
  const evidence = createModelCapabilityEvidence({ id: toCapabilityEvidenceId('route-evidence'), modelId: toModelId('route-model'),
    revision: 1, capability: 'image_generation', state: 'verified_supported', source: 'system_observed', recordedAt: toIsoTimestamp('2026-10-12T16:00:00.000Z') });
  it('retains an admitted immutable revision when another evidence revision is later added', () => {
    const pin = pinCapabilityEvidence(evidence);
    const newer = createModelCapabilityEvidence({ ...evidence, id: toCapabilityEvidenceId('route-evidence-new'), revision: 2,
      supersedesEvidenceId: evidence.id, state: 'unsupported' });
    expect(resolvePinnedCapabilityEvidence([evidence, newer], pin, evidence.modelId, [evidence.capability])).toEqual(evidence);
  });
  it.each(['content', 'model', 'purpose', 'missing', 'revision'] as const)('rejects a changed %s before dispatch', mode => {
    const pin = pinCapabilityEvidence(evidence);
    const items = mode === 'missing' ? [] : [mode === 'content' ? { ...evidence, state: 'unsupported' as const } : evidence];
    expect(() => resolvePinnedCapabilityEvidence(items, mode === 'revision' ? { ...pin, revision: 2 } : pin,
      mode === 'model' ? 'foreign-model' : evidence.modelId, mode === 'purpose' ? ['video_generation'] : [evidence.capability])).toThrow('route_capability_evidence_changed');
  });
});
