import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addExecutionToTask,
  createDraft,
  createExecution,
  createProviderExecutionRouteSnapshot,
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createProviderOperationRecord,
  createSubmissionIntent,
  createTaskFromDraft,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderOperationRecordId,
  toSubmissionIntentId,
  toTaskId,
  toUsageSchemaId,
  transitionSubmissionIntent
} from '../../src/domain';
import {
  InvocationSupervisor,
  JsonRuntimeAuthorizationLedgerStore,
  NodeProjectStorage,
  ProjectMetadataUnitOfWork,
  ProjectSubmissionAcceptanceStore,
  ProviderExecutionRouteDispatcher,
  RuntimeAuthorizationLedger
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-08-03T17:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T17:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T17:02:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('provider invocation supervisor', () => {
  it('reattaches and serializes query/result continuation against the original route snapshot', async () => {
    const fixture = await acceptedFixture('provider_accepted');
    const calls: string[] = [];
    const statuses = [
      { state: 'processing' as const },
      { state: 'processing' as const },
      { state: 'completed' as const }
    ];
    const dispatcher = new ProviderExecutionRouteDispatcher<
      unknown,
      unknown,
      (typeof statuses)[number],
      { readonly state: 'cancelled' },
      { readonly remoteResultId: string },
      string
    >([
      {
        adapterKey: fixture.route.adapterKey,
        adapterVersion: '2.0.0',
        operations: ['query'],
        async query() {
          throw new Error('new adapter version must not receive an old route');
        }
      },
      {
        adapterKey: fixture.route.adapterKey,
        adapterVersion: fixture.route.adapterVersion,
        operations: ['query', 'cancel', 'receive_result'],
        async attachOperation(input) {
          calls.push(
            `attach:${input.routeSnapshot.credentialVersionId}:${input.providerOperationId}`
          );
        },
        async query(route, operationId) {
          calls.push(`query:${route.credentialVersionId}:${operationId}`);
          return statuses.shift() ?? { state: 'completed' };
        },
        async cancel() {
          return { state: 'cancelled' };
        },
        async receiveResult(route, reference) {
          calls.push(`receive:${route.credentialVersionId}:${reference.remoteResultId}`);
          return 'verified-local-result-handle';
        }
      }
    ]);
    const supervisor = new InvocationSupervisor(
      fixture.acceptances,
      fixture.authorization,
      dispatcher,
      eventIds(),
      () => t2
    );

    await expect(supervisor.recover()).resolves.toEqual([{
      submissionIntentId: fixture.intentId,
      outcome: 'provider_operation_attached'
    }]);
    await Promise.all([
      supervisor.query(fixture.intentId),
      supervisor.query(fixture.intentId)
    ]);
    await expect(supervisor.query(fixture.intentId)).resolves.toEqual({
      state: 'completed'
    });
    await expect(supervisor.receiveResult(fixture.intentId, {
      remoteResultId: 'result-supervisor'
    })).resolves.toBe('verified-local-result-handle');

    const acceptance = await fixture.acceptances.get(fixture.intentId);
    expect(acceptance?.intent.status).toBe('completed');
    expect(acceptance?.invocationAttempt.state).toBe('completed');
    expect(acceptance?.invocationEvents.map((event) => event.type)).toEqual([
      'submission_started',
      'provider_accepted',
      'provider_progressed',
      'result_received',
      'completed'
    ]);
    expect(acceptance?.invocationEvents.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect((await fixture.authorization.getClaim(fixture.claimId))?.state)
      .toBe('outcome_recorded');
    expect(calls.every((call) => call.includes('credential-supervisor-v1'))).toBe(true);
  });

  it('records cancellation and provider failure as terminal facts without retry or fallback', async () => {
    const cancelled = await acceptedFixture('provider_accepted');
    let cancelCount = 0;
    const cancelSupervisor = new InvocationSupervisor(
      cancelled.acceptances,
      cancelled.authorization,
      dispatcherFor(cancelled, {
        async cancel() {
          cancelCount += 1;
          return { state: 'cancelled' };
        }
      }),
      eventIds(),
      () => t2
    );
    await expect(cancelSupervisor.cancel(cancelled.intentId)).resolves.toEqual({
      state: 'cancelled'
    });
    expect(cancelCount).toBe(1);
    expect((await cancelled.acceptances.get(cancelled.intentId))?.intent.status)
      .toBe('cancelled');

    const failed = await acceptedFixture('provider_accepted');
    const failedSupervisor = new InvocationSupervisor(
      failed.acceptances,
      failed.authorization,
      dispatcherFor(failed, {
        async query() {
          return {
            state: 'failed',
            message: 'synthetic provider failure',
            retryability: 'not_retryable'
          };
        }
      }),
      eventIds(),
      () => t2
    );
    await expect(failedSupervisor.query(failed.intentId)).resolves.toMatchObject({
      state: 'failed'
    });
    const failedAcceptance = await failed.acceptances.get(failed.intentId);
    expect(failedAcceptance?.intent).toMatchObject({
      status: 'failed',
      safeCode: 'provider.operation_failed'
    });
    expect(failedAcceptance?.invocationAttempt.state).toBe('failed');
  });

  it('denies a revoked continuation before any adapter call', async () => {
    const fixture = await acceptedFixture('provider_accepted');
    let queryCount = 0;
    const supervisor = new InvocationSupervisor(
      fixture.acceptances,
      fixture.authorization,
      dispatcherFor(fixture, {
        async query() {
          queryCount += 1;
          return { state: 'processing' };
        }
      }),
      eventIds(),
      () => t2
    );
    await fixture.authorization.revokeClaim(
      fixture.claimId,
      'synthetic revocation',
      t2
    );
    await expect(supervisor.query(fixture.intentId)).rejects.toMatchObject({
      code: 'continuation_denied'
    });
    expect(queryCount).toBe(0);
    expect((await fixture.acceptances.get(fixture.intentId))?.intent.status)
      .toBe('provider_accepted');
  });

  it('marks a crash after request start unknown and never resubmits', async () => {
    const fixture = await acceptedFixture('request_started');
    let transportCount = 0;
    const dispatcher = new ProviderExecutionRouteDispatcher<
      unknown,
      unknown,
      { readonly state: 'processing' },
      { readonly state: 'unknown' },
      unknown,
      unknown
    >([{
      adapterKey: fixture.route.adapterKey,
      adapterVersion: fixture.route.adapterVersion,
      operations: ['query'],
      async query() {
        transportCount += 1;
        return { state: 'processing' };
      }
    }]);
    const supervisor = new InvocationSupervisor(
      fixture.acceptances,
      fixture.authorization,
      dispatcher,
      eventIds(),
      () => t2
    );
    await expect(supervisor.recover()).resolves.toEqual([{
      submissionIntentId: fixture.intentId,
      outcome: 'unknown_outcome_recorded'
    }]);
    const acceptance = await fixture.acceptances.get(fixture.intentId);
    expect(acceptance?.intent).toMatchObject({
      status: 'unknown_outcome',
      safeCode: 'transport.recovered_unknown_outcome'
    });
    expect(acceptance?.invocationAttempt.state).toBe('unknown_outcome');
    expect(transportCount).toBe(0);
    await expect(supervisor.recover()).resolves.toEqual([]);
  });

  it('does not reattach when the authorization outcome was recorded before project facts', async () => {
    const fixture = await acceptedFixture('provider_accepted');
    await fixture.authorization.recordOutcome(fixture.claimId, t2);
    let attachCount = 0;
    const dispatcher = new ProviderExecutionRouteDispatcher<
      unknown,
      unknown,
      { readonly state: 'processing' },
      { readonly state: 'unknown' },
      unknown,
      unknown
    >([{
      adapterKey: fixture.route.adapterKey,
      adapterVersion: fixture.route.adapterVersion,
      operations: ['query'],
      async attachOperation() {
        attachCount += 1;
      },
      async query() {
        return { state: 'processing' };
      }
    }]);
    const supervisor = new InvocationSupervisor(
      fixture.acceptances,
      fixture.authorization,
      dispatcher,
      eventIds(),
      () => t2
    );
    await expect(supervisor.recover()).resolves.toMatchObject([{
      outcome: 'unknown_outcome_recorded'
    }]);
    expect(attachCount).toBe(0);
    expect((await fixture.acceptances.get(fixture.intentId))?.intent)
      .toMatchObject({
        status: 'unknown_outcome',
        safeCode: 'transport.recovered_terminal_fact_incomplete'
      });
  });
});

async function acceptedFixture(status: 'provider_accepted' | 'request_started') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-invocation-supervisor-'));
  roots.push(root);
  const projectId = toProjectId(`project-supervisor-${roots.length}`);
  const intentId = toSubmissionIntentId(`intent-supervisor-${roots.length}`);
  const claimId = `claim-supervisor-${roots.length}`;
  const route = routeFixture(projectId, claimId, roots.length);
  const storage = new NodeProjectStorage(path.join(root, 'project'));
  const acceptances = new ProjectSubmissionAcceptanceStore(
    new ProjectMetadataUnitOfWork(storage, () => t2)
  );
  const authorization = new RuntimeAuthorizationLedger(
    new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
    () => t2
  );
  await authorization.upsertPolicy({
    policyId: route.runtimePolicyId,
    providerPackageId: route.packageId,
    connectionId: route.connectionId,
    adapterKey: route.adapterKey,
    state: 'interactive_allowed',
    revision: route.runtimePolicyRevision,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result']
  });
  await authorization.claimSubmission({
    providerPackageId: route.packageId,
    connectionId: route.connectionId,
    adapterKey: route.adapterKey,
    policyRevision: route.runtimePolicyRevision,
    routeSelectionNonce: `nonce-supervisor-${roots.length}`,
    idempotencyKey: `idempotency-supervisor-${roots.length}`,
    claimId,
    now: t0
  });
  await authorization.markRequestStarted(claimId, t1);

  const draft = createDraft({
    id: toDraftId(`draft-supervisor-${roots.length}`),
    projectId,
    kind: 'video_generation',
    state: 'saved',
    prompt: {
      originalInput: 'synthetic video prompt',
      systemSupplements: [],
      finalPrompt: 'synthetic video prompt'
    },
    selectedAssetIds: [],
    createdAt: t0,
    updatedAt: t0
  });
  const task = createTaskFromDraft({
    id: toTaskId(`task-supervisor-${roots.length}`),
    draft,
    confirmedAt: t0
  });
  const execution = createExecution({
    id: toExecutionId(`execution-supervisor-${roots.length}`),
    taskId: task.id,
    createdAt: t0
  });
  const invocationAttempt = createProviderInvocationAttempt({
    id: toProviderInvocationAttemptId(`attempt-supervisor-${roots.length}`),
    projectId,
    subject: {
      kind: 'media',
      taskId: task.id,
      executionId: execution.id
    },
    routeSnapshotId: route.id,
    createdAt: t0
  });
  const events = [createProviderInvocationEvent({
    id: toProviderInvocationEventId(`event-supervisor-${roots.length}-1`),
    invocationAttemptId: invocationAttempt.id,
    sequence: 1,
    type: 'submission_started',
    occurredAt: t0
  })];
  if (status === 'provider_accepted') {
    events.push(createProviderInvocationEvent({
      id: toProviderInvocationEventId(`event-supervisor-${roots.length}-2`),
      invocationAttemptId: invocationAttempt.id,
      sequence: 2,
      type: 'provider_accepted',
      occurredAt: t1
    }));
  }
  let intent = createSubmissionIntent({
    id: intentId,
    projectId,
    subject: {
      kind: 'draft',
      draftId: draft.id,
      draftRevision: 1
    },
    routeSnapshotId: route.id,
    providerInvocationAttemptId: invocationAttempt.id,
    idempotencyKey: `idempotency-supervisor-${roots.length}`,
    authorizationClaimId: claimId,
    createdAt: t0
  });
  intent = transitionSubmissionIntent(intent, 'authorization_claimed', t0);
  intent = transitionSubmissionIntent(intent, 'request_started', t1);
  if (status === 'provider_accepted') {
    intent = transitionSubmissionIntent(intent, 'provider_accepted', t1, {
      providerOperationId: `operation-supervisor-${roots.length}`
    });
  }
  await acceptances.accept({
    schemaVersion: 1,
    intent,
    routeSnapshot: route,
    invocationAttempt: {
      ...invocationAttempt,
      state: status === 'provider_accepted' ? 'accepted' : 'submitting'
    },
    invocationEvents: events,
    subjectArtifacts: {
      kind: 'media',
      task: addExecutionToTask(task, execution),
      execution
    },
    ...(status === 'provider_accepted'
      ? {
          providerOperationRecord: createProviderOperationRecord({
            id: toProviderOperationRecordId(
              `operation-record-supervisor-${roots.length}`
            ),
            taskId: task.id,
            executionId: execution.id,
            mediaKind: 'video',
            executionLifecycle: 'asynchronous_polling',
            outcome: {
              kind: 'accepted_async',
              providerOperationId: intent.providerOperationId!,
              state: 'queued'
            },
            createdAt: t1,
            updatedAt: t1
          })
        }
      : {})
  });
  return { acceptances, authorization, claimId, intentId, route };
}

function dispatcherFor(
  fixture: Awaited<ReturnType<typeof acceptedFixture>>,
  behavior: {
    readonly query?: () => Promise<
      | { readonly state: 'processing' }
      | {
          readonly state: 'failed';
          readonly message: string;
          readonly retryability: 'not_retryable';
        }
    >;
    readonly cancel?: () => Promise<{ readonly state: 'cancelled' }>;
  }
) {
  return new ProviderExecutionRouteDispatcher<
    unknown,
    unknown,
    | { readonly state: 'processing' }
    | {
        readonly state: 'failed';
        readonly message: string;
        readonly retryability: 'not_retryable';
      },
    { readonly state: 'cancelled' },
    unknown,
    unknown
  >([{
    adapterKey: fixture.route.adapterKey,
    adapterVersion: fixture.route.adapterVersion,
    operations: ['query', 'cancel'],
    async query() {
      return behavior.query?.() ?? { state: 'processing' };
    },
    async cancel() {
      return behavior.cancel?.() ?? { state: 'cancelled' };
    }
  }]);
}

function routeFixture(
  projectId: ReturnType<typeof toProjectId>,
  claimId: string,
  sequence: number
) {
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-supervisor-${sequence}`),
    projectId,
    packageId: 'package.supervisor',
    packageVersion: '1.0.0',
    adapterKey: 'supervisor.video',
    adapterVersion: '1.0.0',
    providerId: toProviderId('provider-supervisor'),
    connectionId: toConnectionId('connection-supervisor'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-supervisor-v1',
    endpointPolicyId: 'endpoint-policy.supervisor',
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-supervisor-v1',
    modelId: toModelId('model-supervisor'),
    providerModelKey: 'model-key-supervisor',
    modelRevision: 1,
    profileId: 'profile-supervisor',
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('binding-supervisor'),
    protocolBindingRevision: 1,
    productFeature: 'text_to_video',
    internalPurpose: 'video_generation',
    featureMappingVersion: 1,
    parameterSchemaId: 'parameters.supervisor.video',
    parameterSchemaRevision: 1,
    resultSchemaId: 'results.supervisor.video',
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId('usage.supervisor.video'),
    usageSchemaRevision: 1,
    constraintSetId: 'constraints.supervisor.video',
    constraintSetRevision: 1,
    runtimePolicyId: 'policy-supervisor',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: claimId,
    createdAt: t0
  });
}

function eventIds() {
  let sequence = 0;
  return {
    nextProviderInvocationEventId: () =>
      toProviderInvocationEventId(`event-supervisor-runtime-${++sequence}`)
  };
}
