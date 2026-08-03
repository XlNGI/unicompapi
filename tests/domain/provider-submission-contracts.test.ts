import { describe, expect, it } from 'vitest';
import {
  createSubmissionIntent,
  parseFeatureCandidateDto,
  parseFeatureCandidateSubject,
  parseSubmissionPreparation,
  toDraftId,
  toIsoTimestamp,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toSubmissionIntentId,
  transitionSubmissionIntent
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-08-03T11:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T11:01:00.000Z');

const parameterSchema = {
  schemaVersion: 2 as const,
  schemaId: 'parameter-schema.public',
  revision: 1,
  productFeature: 'text_to_image' as const,
  fields: [{
    fieldId: 'prompt_strength',
    labelId: 'parameter.prompt_strength',
    order: 0,
    valueType: 'integer' as const,
    exposure: 'user_required' as const,
    defaultPolicy: 'require_user_value' as const,
    required: true,
    minimum: 1,
    maximum: 10,
    step: 1
  }]
};

describe('provider public submission contracts', () => {
  it('keeps subjects explicit and public candidates free of route internals', () => {
    const subject = parseFeatureCandidateSubject({
      kind: 'draft',
      draftId: 'draft-public-candidate',
      draftRevision: 3
    });
    expect(subject).toEqual({
      kind: 'draft',
      draftId: 'draft-public-candidate',
      draftRevision: 3
    });
    expect(() => parseFeatureCandidateSubject({
      ...subject,
      productFeature: 'text_to_image'
    })).toThrow('unsupported fields');

    const candidate = parseFeatureCandidateDto({
      schemaVersion: 1,
      candidateId: 'candidate-public-1',
      providerName: '安全服务商名称',
      connectionName: '已验证连接',
      modelName: '安全模型名称',
      parameterSchema,
      usageSchema: {
        schemaVersion: 1,
        schemaId: 'usage-schema.public',
        revision: 2
      },
      cost: { state: 'unknown' },
      available: true,
      unavailableReasons: []
    });
    expect(JSON.stringify(candidate)).not.toMatch(
      /profileId|adapterKey|protocolId|endpoint|credential|evidence|authorization/i
    );
    expect(() => parseFeatureCandidateDto({
      ...candidate,
      adapterKey: 'hidden.adapter'
    })).toThrow('unsupported fields');
  });

  it('requires exact one-time preparation and monotonic intent transitions', () => {
    expect(() => parseSubmissionPreparation({
      schemaVersion: 1,
      routeSelectionToken: 'plain-token',
      expiresAt: t1,
      confirmation: {}
    })).toThrow('route selection token');

    const intent = createSubmissionIntent({
      id: toSubmissionIntentId('intent-domain-contract'),
      projectId: toProjectId('project-domain-contract'),
      subject: {
        kind: 'draft',
        draftId: toDraftId('draft-domain-contract'),
        draftRevision: 1
      },
      routeSnapshotId: toProviderExecutionRouteSnapshotId('route-domain-contract'),
      providerInvocationAttemptId: toProviderInvocationAttemptId('attempt-domain-contract'),
      idempotencyKey: 'idempotency-domain-contract',
      authorizationClaimId: 'claim-domain-contract',
      createdAt: t0
    });
    const claimed = transitionSubmissionIntent(intent, 'authorization_claimed', t1);
    expect(claimed.status).toBe('authorization_claimed');
    expect(() => transitionSubmissionIntent(claimed, 'completed', t1, {
      providerOperationId: 'operation-domain-contract'
    })).toThrow('cannot transition');
    expect(() => transitionSubmissionIntent(intent, 'authorization_not_claimed', t1))
      .toThrow('requires a safe code');
  });
});
