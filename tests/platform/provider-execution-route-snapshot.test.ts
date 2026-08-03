import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderExecutionRouteSnapshot,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toUsageSchemaId
} from '../../src/domain';
import {
  JsonProviderExecutionRouteSnapshotRepository,
  NodeProjectStorage,
  ProviderExecutionRouteDispatchError,
  ProviderExecutionRouteDispatcher,
  ProviderExecutionRouteSnapshotRepositoryDataError
} from '../../src/platform';

const roots: string[] = [];

function routeSnapshotFixture() {
  return createProviderExecutionRouteSnapshot({
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
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-route-snapshot-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const snapshot = routeSnapshotFixture();
  return {
    storage,
    snapshot,
    repository: new JsonProviderExecutionRouteSnapshotRepository(
      storage,
      snapshot.projectId
    )
  };
}

describe('provider execution route snapshot repository', () => {
  it('serializes immutable project snapshots across repository instances', async () => {
    const { storage, snapshot, repository } = await fixture();
    const second = new JsonProviderExecutionRouteSnapshotRepository(
      storage,
      snapshot.projectId
    );
    const another = {
      ...snapshot,
      id: toProviderExecutionRouteSnapshotId('route-snapshot-second')
    };
    await Promise.all([repository.save(snapshot), second.save(another)]);
    await repository.save(snapshot);
    await expect(repository.save({ ...snapshot, modelRevision: 99 }))
      .rejects.toBeInstanceOf(ProviderExecutionRouteSnapshotRepositoryDataError);
    await expect(repository.list()).resolves.toHaveLength(2);
  });

  it('rejects cross-project route snapshots', async () => {
    const { snapshot, repository } = await fixture();
    await expect(repository.save({
      ...snapshot,
      projectId: toProjectId('project-route-other')
    })).rejects.toThrow('another project');
  });
});

describe('provider execution route dispatcher', () => {
  it('uses the exact captured adapter version for submit, query, cancel and result receipt', async () => {
    const snapshot = routeSnapshotFixture();
    const calls: string[] = [];
    const dispatcher = new ProviderExecutionRouteDispatcher<
      { readonly requestId: string },
      string,
      string,
      string,
      { readonly resultId: string },
      string
    >([{
      adapterKey: snapshot.adapterKey,
      adapterVersion: snapshot.adapterVersion,
      operations: ['submit', 'query', 'cancel', 'receive_result'],
      async submit(route, request) {
        calls.push(`submit:${route.id}:${request.requestId}`);
        return 'submitted';
      },
      async query(route, operationId) {
        calls.push(`query:${route.id}:${operationId}`);
        return 'running';
      },
      async cancel(route, operationId) {
        calls.push(`cancel:${route.id}:${operationId}`);
        return 'cancelled';
      },
      async receiveResult(route, reference) {
        calls.push(`receive:${route.id}:${reference.resultId}`);
        return 'received';
      }
    }]);
    await expect(dispatcher.submit(snapshot, { requestId: 'request-1' })).resolves.toBe('submitted');
    await expect(dispatcher.query(snapshot, 'operation-1')).resolves.toBe('running');
    await expect(dispatcher.cancel(snapshot, 'operation-1')).resolves.toBe('cancelled');
    await expect(dispatcher.receiveResult(snapshot, { resultId: 'result-1' })).resolves.toBe('received');
    expect(calls).toEqual([
      `submit:${snapshot.id}:request-1`,
      `query:${snapshot.id}:operation-1`,
      `cancel:${snapshot.id}:operation-1`,
      `receive:${snapshot.id}:result-1`
    ]);
  });

  it('stops on an unavailable version or operation and never falls back', async () => {
    const snapshot = routeSnapshotFixture();
    const dispatcher = new ProviderExecutionRouteDispatcher<unknown, string, string, string, unknown, string>([{
      adapterKey: snapshot.adapterKey,
      adapterVersion: '9.0.0',
      operations: ['submit'],
      async submit() {
        return 'wrong-version';
      }
    }]);
    await expect(dispatcher.submit(snapshot, {})).rejects.toMatchObject({
      code: 'adapter_version_unavailable'
    });

    const exact = new ProviderExecutionRouteDispatcher<unknown, string, string, string, unknown, string>([{
      adapterKey: snapshot.adapterKey,
      adapterVersion: snapshot.adapterVersion,
      operations: ['submit'],
      async submit() {
        return 'submitted';
      }
    }]);
    await expect(exact.query(snapshot, 'operation-1')).rejects.toBeInstanceOf(
      ProviderExecutionRouteDispatchError
    );
    await expect(exact.query(snapshot, 'operation-1')).rejects.toMatchObject({
      code: 'operation_unsupported'
    });
  });
});
