import { describe, expect, it } from 'vitest';
import {
  createProviderExecutionRouteSnapshot,
  parseProviderExecutionRouteSnapshot,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toUsageSchemaId
} from '../../src/domain';

export const routeSnapshotFixture = () => createProviderExecutionRouteSnapshot({
  id: toProviderExecutionRouteSnapshotId('route-snapshot-contract'),
  projectId: toProjectId('project-route-contract'),
  packageId: 'package.deepseek',
  packageVersion: '1.2.0',
  adapterKey: 'deepseek.chat',
  adapterVersion: '2.1.0',
  providerId: toProviderId('provider-route-contract'),
  connectionId: toConnectionId('connection-route-contract'),
  connectionRevision: 3,
  connectionConfigVersionId: 'connection-config:3',
  endpointPolicyId: 'endpoint-policy.deepseek',
  endpointPolicyRevision: 2,
  credentialVersionId: 'credential-version:4',
  modelId: toModelId('model-route-contract'),
  modelRevision: 5,
  profileId: 'profile.deepseek-chat',
  profileRevision: 6,
  protocolBindingId: toProtocolBindingId('binding-route-contract'),
  protocolBindingRevision: 2,
  productFeature: 'text_chat',
  internalPurpose: 'chat_completion',
  featureMappingVersion: 1,
  parameterSchemaId: 'parameter-schema.chat',
  parameterSchemaRevision: 4,
  resultSchemaId: 'result-schema.chat',
  resultSchemaRevision: 3,
  usageSchemaId: toUsageSchemaId('usage-schema-route'),
  usageSchemaRevision: 2,
  constraintSetId: 'constraint-set.chat',
  constraintSetRevision: 1,
  runtimePolicyId: 'runtime-policy.interactive',
  runtimePolicyRevision: 7,
  runtimeAuthorizationClaimId: 'runtime-claim:route-contract',
  createdAt: toIsoTimestamp('2026-08-03T08:00:00.000Z')
});

describe('provider execution route snapshot contract', () => {
  it('freezes every routing and schema revision without storing endpoint or credential material', () => {
    const snapshot = routeSnapshotFixture();
    expect(snapshot).toMatchObject({
      adapterKey: 'deepseek.chat',
      adapterVersion: '2.1.0',
      connectionRevision: 3,
      modelRevision: 5,
      profileRevision: 6,
      usageSchemaRevision: 2,
      runtimePolicyRevision: 7,
      productFeature: 'text_chat'
    });
    expect(snapshot).not.toHaveProperty('baseUrl');
    expect(snapshot).not.toHaveProperty('endpointUrl');
    expect(snapshot).not.toHaveProperty('apiKey');
    expect(snapshot).not.toHaveProperty('credential');
    expect(snapshot).not.toHaveProperty('authorizationHeader');
  });

  it('rejects zero revisions, unknown fields and secret-bearing route data', () => {
    const snapshot = routeSnapshotFixture();
    expect(() => parseProviderExecutionRouteSnapshot({
      ...snapshot,
      modelRevision: 0
    })).toThrow('positive safe integer');
    expect(() => parseProviderExecutionRouteSnapshot({
      ...snapshot,
      baseUrl: 'https://private.example',
      credential: 'plaintext'
    })).toThrow('unsupported fields');
  });
});
