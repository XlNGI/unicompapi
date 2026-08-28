import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalResultObservation,
  createProviderExecutionRouteSnapshot,
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createProviderUsageObservation,
  createUsageSchema,
  toConnectionId,
  toConversationId,
  toConversationResponseExecutionId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toLocalResultObservationId,
  toMessageId,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderUsageObservationId,
  toTaskId,
  toUsageSchemaId,
  toWorkId,
  type ProductFeature,
  type ProjectId,
  type Work
} from '../../src/domain';
import {
  InMemoryProjectCatalogStore,
  JsonLocalResultObservationRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderUsageObservationRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  ProjectCatalogService,
  ProviderInvocationReadModelController,
  ProviderUsageSchemaRegistry
} from '../../src/platform';
import { VIDU_PROVIDER_PACKAGE_ID } from '../../src/platform/providers/vidu/vidu-contracts';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-08-03T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T10:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T10:03:00.000Z');
const t4 = toIsoTimestamp('2026-08-03T11:00:00.000Z');
const t5 = toIsoTimestamp('2026-08-03T11:01:00.000Z');

const usageSchema = createUsageSchema({
  id: toUsageSchemaId('usage-schema.call-records'),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [{
    metricId: 'total_tokens',
    allowedUnits: ['token'],
    numericKind: 'integer',
    aggregation: 'cumulative_latest',
    requiredForComplete: true,
    allowedStages: ['submit', 'poll', 'result']
  }, {
    metricId: 'credit_amount',
    allowedUnits: ['credit'],
    numericKind: 'decimal',
    aggregation: 'cumulative_latest',
    requiredForComplete: false,
    allowedStages: ['submit', 'poll', 'result']
  }]
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('provider invocation read model controller', () => {
  it('aggregates projects and applies exact project, feature, route, state, time and paging filters', async () => {
    const fixture = await controllerFixture();
    const all = await fixture.controller.listCallRecords({ limit: 1 });
    expect(all).toMatchObject({
      ok: true,
      value: {
        total: 2,
        offset: 0,
        limit: 1,
        items: [{
          invocationAttemptId: 'attempt-conversation-call',
          projectName: 'Conversation project',
          productFeature: 'text_chat',
          state: 'unknown_outcome',
          usageAvailability: 'unknown_outcome',
          resultRegistrationState: 'not_applicable'
        }],
        issues: [{ projectId: 'project-call-unavailable', reason: 'unavailable' }]
      }
    });

    const media = await fixture.controller.listCallRecords({
      projectId: fixture.mediaProjectId,
      productFeature: 'text_to_video',
      providerId: 'provider-media-call',
      connectionId: 'connection-media-call',
      modelId: 'model-media-call',
      state: 'completed',
      createdFrom: t0,
      createdTo: t3,
      offset: 0,
      limit: 20
    });
    expect(media).toMatchObject({
      ok: true,
      value: {
        total: 1,
        items: [{
          invocationAttemptId: 'attempt-media-call',
          providerName: 'Synthetic Provider',
          connectionName: 'Synthetic Connection',
          modelName: 'Synthetic Model',
          displayNameAvailability: 'snapshotted',
          durationMs: '180000',
          localResultCount: 1,
          resultRegistrationState: 'registered'
        }]
      }
    });

    await expect(fixture.controller.listCallRecords({
      productFeature: 'unknown_feature'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    await expect(fixture.controller.listCallRecords({ limit: 201 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('returns safe details with timeline, usage, local result facts and Work registration only', async () => {
    const fixture = await controllerFixture();
    const result = await fixture.controller.getCallDetails({
      invocationAttemptId: 'attempt-media-call'
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        subject: {
          kind: 'media',
          taskId: 'task-media-call',
          executionId: 'execution-media-call'
        },
        productFeature: 'text_to_video',
        state: 'completed',
        timeline: [
          { sequence: 1, type: 'submission_started', occurredAt: t0 },
          { sequence: 2, type: 'provider_accepted', occurredAt: t1 },
          { sequence: 3, type: 'result_received', occurredAt: t2 },
          { sequence: 4, type: 'completed', occurredAt: t3 }
        ],
        usage: {
          availability: 'reported_complete',
          facts: [{
            metricId: 'total_tokens',
            quantity: '12',
            unit: 'token',
            source: 'provider_body'
          }]
        },
        localResults: [{
          mediaKind: 'video',
          outputCount: 1,
          durationMs: '1200',
          width: 1280,
          height: 720,
          byteLength: '4096',
          validationState: 'valid'
        }],
        resultRegistration: {
          state: 'registered',
          workIds: ['work-media-call']
        }
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /routeSnapshot|packageId|adapterKey|endpoint|credential|runtimePolicy|authorization|sourceEventKey|observationId|remoteOperation|prompt|absolutePath|contentHash/i
    );
    await expect(fixture.controller.getCallDetails({
      invocationAttemptId: 'missing-attempt'
    })).resolves.toEqual({ ok: true, value: undefined });
    await expect(fixture.controller.getCallDetails({
      invocationAttemptId: 'attempt-media-call',
      extra: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('does not interpret recorded usage without its exact schema and keeps no-observation calls readable', async () => {
    const fixture = await controllerFixture(false);
    const listed = await fixture.controller.listCallRecords({});
    expect(listed).toMatchObject({
      ok: true,
      value: {
        total: 1,
        items: [{ invocationAttemptId: 'attempt-conversation-call' }],
        issues: [
          { projectId: 'project-call-unavailable', reason: 'unavailable' },
          { projectId: 'project-media-call', reason: 'invalid_data' }
        ]
      }
    });
    await expect(fixture.controller.getCallDetails({
      invocationAttemptId: 'attempt-media-call'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'read_model_failed' }
    });
    expect(() => new ProviderUsageSchemaRegistry([usageSchema, usageSchema]))
      .toThrow('unique');
  });

  it('returns one controlled CNY summary without mixing currencies or exposing conversion rates', async () => {
    const fixture = await consumptionControllerFixture();
    const pending = await fixture.withoutConversion.getConsumptionSummary({ calendarDays: 7 });
    expect(pending).toMatchObject({
      ok: true,
      value: {
        currencyCode: 'CNY',
        currencyLabel: '人民币',
        totalAmount: '0',
        totalCallCount: 7,
        successfulCallCount: 7,
        pricedCallCount: 7,
        includedCallCount: 0,
        pendingConversionCallCount: 7,
        pendingCurrencies: [{ currencyCode: 'USD', callCount: 7 }],
        conversionSources: [],
        timeBuckets: expect.arrayContaining([
          { date: '2026-08-03', amount: '0', callCount: 0 }
        ]),
        disclaimer: 'local_estimate_not_provider_bill'
      }
    });

    const converted = await fixture.withConversion.getConsumptionSummary({ calendarDays: 7 });
    expect(converted).toMatchObject({
      ok: true,
      value: {
        totalAmount: '2.8',
        includedCallCount: 7,
        pendingConversionCallCount: 0,
        pendingCurrencies: [],
        conversionSources: [{
          sourceCurrencyCode: 'USD',
          targetCurrencyCode: 'CNY',
          sourceTitle: 'Synthetic approved conversion',
          sourceCheckedAt: '2026-08-03'
        }],
        timeBuckets: expect.arrayContaining([
          { date: '2026-08-03', amount: '2.8', callCount: 7 }
        ])
      }
    });
    if (!converted.ok) throw new TypeError('Expected summary');
    expect(converted.value.timeBuckets).toHaveLength(7);
    expect(converted.value.providerSlices).toHaveLength(6);
    expect(converted.value.providerSlices.find((item) => item.key === 'other')).toMatchObject({
      label: '其他',
      amount: '0.3',
      callCount: 2,
      isOther: true
    });
    expect(converted.value.providerSlices.map((item) => item.key).filter((key) => key !== 'other'))
      .toHaveLength(5);
    expect(converted.value.providerSlices.reduce(
      (sum, item) => sum + item.ratioBasisPoints,
      0
    )).toBe(10_000);
    expect(JSON.stringify(converted)).not.toMatch(
      /"rate"|routeSnapshot|packageId|adapterKey|endpoint|credential|runtimePolicy|authorization/i
    );

    await expect(fixture.withConversion.getConsumptionSummary({ calendarDays: 32 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(fixture.withConversion.getConsumptionSummary({ calendarDays: 7, extra: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(fixture.invalidConversion.getConsumptionSummary({ calendarDays: 7 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'read_model_failed' } });
  });
});

async function consumptionControllerFixture() {
  const root = await makeRoot('unicomp-consumption-summary-');
  const projectId = toProjectId('project-consumption-summary');
  await createConsumptionCalls(root, projectId);
  const catalog = new ProjectCatalogService(
    new InMemoryProjectCatalogStore(),
    () => t5
  );
  await catalog.remember({
    projectId,
    projectName: 'Consumption project',
    rootDirectory: root
  });
  const conversions = {
    async listApprovedFacts() {
      return [{
        sourceCurrencyCode: 'USD',
        targetCurrencyCode: 'CNY' as const,
        rate: '1',
        sourceTitle: 'Synthetic approved conversion',
        sourceUrl: 'https://example.com/conversion-fact',
        sourceCheckedAt: '2026-08-03'
      }];
    }
  };
  const now = () => new Date('2026-08-05T12:00:00.000Z');
  return {
    withoutConversion: new ProviderInvocationReadModelController(
      catalog,
      new ProviderUsageSchemaRegistry([usageSchema]),
      undefined,
      now
    ),
    withConversion: new ProviderInvocationReadModelController(
      catalog,
      new ProviderUsageSchemaRegistry([usageSchema]),
      conversions,
      now
    ),
    invalidConversion: new ProviderInvocationReadModelController(
      catalog,
      new ProviderUsageSchemaRegistry([usageSchema]),
      {
        async listApprovedFacts() {
          return [{
            ...(await conversions.listApprovedFacts())[0]!,
            sourceUrl: 'https://example.com/conversion-fact?token=not-allowed'
          }];
        }
      },
      now
    )
  };
}

async function createConsumptionCalls(root: string, projectId: ProjectId): Promise<void> {
  const context = callContext(root, projectId);
  const creditQuantities = ['20', '40', '60', '80', '100', '120', '140'];
  for (const [index, creditQuantity] of creditQuantities.entries()) {
    const suffix = `consumption-${index + 1}`;
    const route = {
      ...routeSnapshot(projectId, suffix, 'text_to_video', t0, {
        providerDisplayName: 'Same Provider',
        connectionDisplayName: `Connection ${index + 1}`,
        modelDisplayName: `Model ${index + 1}`
      }),
      packageId: VIDU_PROVIDER_PACKAGE_ID
    };
    await context.routes.save(route);
    const attempt = createProviderInvocationAttempt({
      id: toProviderInvocationAttemptId(`attempt-${suffix}`),
      projectId,
      subject: {
        kind: 'media',
        taskId: toTaskId(`task-${suffix}`),
        executionId: toExecutionId(`execution-${suffix}`)
      },
      routeSnapshotId: route.id,
      createdAt: t0
    });
    await context.invocations.create(
      attempt,
      invocationEvent(attempt.id, 1, 'submission_started', t0)
    );
    await context.invocations.appendEvent(invocationEvent(
      attempt.id,
      2,
      'provider_accepted',
      t1
    ));
    await context.invocations.appendEvent(invocationEvent(
      attempt.id,
      3,
      'result_received',
      t2
    ));
    await context.invocations.appendEvent(invocationEvent(
      attempt.id,
      4,
      'completed',
      t3
    ));
    await context.usage.append(createProviderUsageObservation({
      id: toProviderUsageObservationId(`usage-${suffix}`),
      invocationAttemptId: attempt.id,
      usageSchemaId: usageSchema.id,
      usageSchemaRevision: usageSchema.revision,
      sourceEventKey: `usage-${suffix}`,
      sequence: 1,
      status: 'reported',
      sourceStage: 'result',
      facts: [{
        metricId: 'credit_amount',
        quantity: creditQuantity,
        unit: 'credit',
        source: 'provider_body'
      }],
      observedAt: t2
    }, usageSchema), usageSchema);
  }
}

async function controllerFixture(withUsageSchema = true) {
  const mediaRoot = await makeRoot('unicomp-call-media-');
  const conversationRoot = await makeRoot('unicomp-call-conversation-');
  const mediaProjectId = toProjectId('project-media-call');
  const conversationProjectId = toProjectId('project-conversation-call');
  await createMediaCall(mediaRoot, mediaProjectId);
  await createConversationCall(conversationRoot, conversationProjectId);
  const catalog = new ProjectCatalogService(
    new InMemoryProjectCatalogStore(),
    () => t5
  );
  await catalog.remember({
    projectId: mediaProjectId,
    projectName: 'Media project',
    rootDirectory: mediaRoot
  });
  await catalog.remember({
    projectId: conversationProjectId,
    projectName: 'Conversation project',
    rootDirectory: conversationRoot
  });
  await catalog.remember({
    projectId: toProjectId('project-call-unavailable'),
    projectName: 'Unavailable project',
    rootDirectory: path.join(os.tmpdir(), 'unicomp-call-missing-project')
  });
  return {
    mediaProjectId,
    controller: new ProviderInvocationReadModelController(
      catalog,
      new ProviderUsageSchemaRegistry(withUsageSchema ? [usageSchema] : [])
    )
  };
}

async function createMediaCall(root: string, projectId: ProjectId): Promise<void> {
  const context = callContext(root, projectId);
  const route = routeSnapshot(
    projectId,
    'media-call',
    'text_to_video',
    t0,
    {
      providerDisplayName: 'Synthetic Provider',
      connectionDisplayName: 'Synthetic Connection',
      modelDisplayName: 'Synthetic Model'
    }
  );
  await context.routes.save(route);
  const attempt = createProviderInvocationAttempt({
    id: toProviderInvocationAttemptId('attempt-media-call'),
    projectId,
    subject: {
      kind: 'media',
      taskId: toTaskId('task-media-call'),
      executionId: toExecutionId('execution-media-call')
    },
    routeSnapshotId: route.id,
    createdAt: t0
  });
  await context.invocations.create(attempt, invocationEvent(attempt.id, 1, 'submission_started', t0));
  await context.invocations.appendEvent(invocationEvent(attempt.id, 2, 'provider_accepted', t1));
  await context.invocations.appendEvent(invocationEvent(attempt.id, 3, 'result_received', t2));
  await context.invocations.appendEvent(invocationEvent(attempt.id, 4, 'completed', t3));
  await context.usage.append(createProviderUsageObservation({
    id: toProviderUsageObservationId('usage-media-call'),
    invocationAttemptId: attempt.id,
    usageSchemaId: usageSchema.id,
    usageSchemaRevision: usageSchema.revision,
    sourceEventKey: 'usage-media-call-1',
    sequence: 1,
    status: 'reported',
    sourceStage: 'result',
    facts: [{
      metricId: 'total_tokens',
      quantity: '12',
      unit: 'token',
      source: 'provider_body'
    }],
    observedAt: t2
  }, usageSchema), usageSchema);
  await context.localResults.append(createLocalResultObservation({
    id: toLocalResultObservationId('local-result-media-call'),
    invocationAttemptId: attempt.id,
    mediaKind: 'video',
    outputCount: 1,
    durationMs: '1200',
    width: 1280,
    height: 720,
    byteLength: '4096',
    validationState: 'valid',
    observedAt: t3
  }));
  const work: Work = {
    schemaVersion: 1,
    id: toWorkId('work-media-call'),
    projectId,
    sourceTaskId: toTaskId('task-media-call'),
    sourceExecutionId: toExecutionId('execution-media-call'),
    fileId: toFileReferenceId('file-media-call'),
    mediaKind: 'video',
    name: 'Registered media result',
    createdAt: t3
  };
  await context.works.save(work);
  await context.works.save({
    ...work,
    id: toWorkId('work-media-mismatched-task'),
    sourceTaskId: toTaskId('task-other-call')
  });
}

async function createConversationCall(root: string, projectId: ProjectId): Promise<void> {
  const context = callContext(root, projectId);
  const route = routeSnapshot(projectId, 'conversation-call', 'text_chat', t4, {
    providerDisplayName: 'Chat Provider',
    connectionDisplayName: 'Chat Connection',
    modelDisplayName: 'Chat Model'
  });
  await context.routes.save(route);
  const attempt = createProviderInvocationAttempt({
    id: toProviderInvocationAttemptId('attempt-conversation-call'),
    projectId,
    subject: {
      kind: 'conversation',
      conversationId: toConversationId('conversation-call'),
      userMessageId: toMessageId('message-call'),
      responseExecutionId: toConversationResponseExecutionId('response-execution-call')
    },
    routeSnapshotId: route.id,
    createdAt: t4
  });
  await context.invocations.create(attempt, invocationEvent(attempt.id, 1, 'submission_started', t4));
  await context.invocations.appendEvent(invocationEvent(
    attempt.id,
    2,
    'outcome_unknown',
    t5,
    'transport.outcome_unknown'
  ));
}

function callContext(root: string, projectId: ProjectId) {
  const storage = new NodeProjectStorage(root);
  return {
    routes: new JsonProviderExecutionRouteSnapshotRepository(storage, projectId),
    invocations: new JsonProviderInvocationRepository(storage, projectId),
    usage: new JsonProviderUsageObservationRepository(storage),
    localResults: new JsonLocalResultObservationRepository(storage),
    works: new JsonWorkRepository(storage, projectId)
  };
}

function routeSnapshot(
  projectId: ProjectId,
  suffix: string,
  productFeature: ProductFeature,
  createdAt: string,
  names: {
    readonly providerDisplayName: string;
    readonly connectionDisplayName: string;
    readonly modelDisplayName: string;
  }
) {
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-${suffix}`),
    projectId,
    packageId: 'package.synthetic',
    packageVersion: '1.0.0',
    adapterKey: 'synthetic.adapter',
    adapterVersion: '1.0.0',
    providerId: toProviderId(`provider-${suffix}`),
    providerDisplayName: names.providerDisplayName,
    connectionId: toConnectionId(`connection-${suffix}`),
    connectionDisplayName: names.connectionDisplayName,
    connectionRevision: 1,
    connectionConfigVersionId: `connection-config:${suffix}`,
    endpointPolicyId: 'endpoint-policy.synthetic',
    endpointPolicyRevision: 1,
    credentialVersionId: `credential-version:${suffix}`,
    modelId: toModelId(`model-${suffix}`),
    modelDisplayName: names.modelDisplayName,
    modelRevision: 1,
    profileId: `profile.${suffix}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId(`binding-${suffix}`),
    protocolBindingRevision: 1,
    productFeature,
    featureMappingVersion: 1,
    parameterSchemaId: `parameters.${suffix}`,
    parameterSchemaRevision: 1,
    resultSchemaId: `results.${suffix}`,
    resultSchemaRevision: 1,
    usageSchemaId: usageSchema.id,
    usageSchemaRevision: usageSchema.revision,
    constraintSetId: `constraints.${suffix}`,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: `claim:${suffix}`,
    createdAt: toIsoTimestamp(createdAt)
  });
}

function invocationEvent(
  attemptId: ReturnType<typeof toProviderInvocationAttemptId>,
  sequence: number,
  type: Parameters<typeof createProviderInvocationEvent>[0]['type'],
  occurredAt: string,
  safeCode?: string
) {
  return createProviderInvocationEvent({
    id: toProviderInvocationEventId(`event-${attemptId}-${sequence}`),
    invocationAttemptId: attemptId,
    sequence,
    type,
    ...(safeCode ? { safeCode } : {}),
    occurredAt: toIsoTimestamp(occurredAt)
  });
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
