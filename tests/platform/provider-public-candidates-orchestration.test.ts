import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addExecutionToTask,
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  createDraft,
  createExecution,
  createProviderOperationRecord,
  createTaskFromDraft,
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toMessageId,
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
  type FeatureCandidateSubjectV1,
  type ProductFeature,
  type ProviderPackageDescriptor
} from '../../src/domain';
import {
  FeatureSubmissionError,
  JsonRuntimeAuthorizationLedgerStore,
  NodeProjectStorage,
  ProjectMetadataUnitOfWork,
  ProjectSubmissionAcceptanceStore,
  ProviderFeatureCandidateService,
  ProviderPackageRegistry,
  ProviderSubmissionDispatchBridge,
  ProviderSubmissionOrchestrator,
  RouteSelectionTokenVault,
  RuntimeAuthorizationLedger,
  SubmissionIntentJournal,
  SubmissionOrchestrationError,
  type FeatureCandidateSourcePort,
  type FeatureSubjectResolverPort,
  type ProviderSubmissionOrchestrationIdFactory,
  type ResolvedFeatureCandidateV1,
  type ResolvedFeatureSubjectV1,
  type SubmissionArtifactFactoryPort
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-public-orchestration');
const t0 = toIsoTimestamp('2026-08-03T12:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T12:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T12:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T12:03:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const imageSubject: FeatureCandidateSubjectV1 = {
  kind: 'draft',
  draftId: toDraftId('draft-public-orchestration'),
  draftRevision: 4
};

function parameterSchema(productFeature: ProductFeature) {
  return {
    schemaVersion: 2 as const,
    schemaId: `parameter-schema.${productFeature}`,
    revision: 3,
    productFeature,
    fields: [{
      fieldId: 'strength',
      labelId: 'parameter.strength',
      order: 0,
      valueType: 'integer' as const,
      exposure: 'user_required' as const,
      defaultPolicy: 'require_user_value' as const,
      required: true,
      minimum: 1,
      maximum: 10,
      step: 1
    }, {
      fieldId: 'style',
      labelId: 'parameter.style',
      order: 1,
      valueType: 'string' as const,
      exposure: 'user_optional' as const,
      defaultPolicy: 'omit_use_provider_default' as const,
      required: false
    }]
  };
}

function subjectSnapshot(
  subject: FeatureCandidateSubjectV1 = imageSubject,
  productFeature: ProductFeature = 'text_to_image'
): ResolvedFeatureSubjectV1 {
  return {
    projectId,
    subject,
    productFeature,
    surface: subject.kind === 'draft' ? 'quick' : 'conversation',
    imageCount: 0,
    videoCount: 0,
    contextCount: 0,
    parameterValues: { strength: 5 },
    outboundTextSnapshot: '只使用文本生成内容',
    materialReferences: [],
    contextContentHashes: []
  };
}

function candidate(
  productFeature: ProductFeature = 'text_to_image',
  overrides: Partial<ResolvedFeatureCandidateV1> = {}
): ResolvedFeatureCandidateV1 {
  return {
    candidateId: `candidate-${productFeature}`,
    providerName: '服务商 A',
    connectionName: '连接 A',
    modelName: '模型 A',
    recipientName: '服务商 A',
    outboundScope: 'external_service',
    contentCategories: ['prompt_text'],
    parameterSchema: parameterSchema(productFeature),
    usageSchema: { schemaId: `usage-schema.${productFeature}`, revision: 2 },
    cost: { state: 'unknown' },
    eligibility: {
      modelEnabled: true,
      catalogState: 'present',
      connectionState: 'available',
      profileStatus: 'verified',
      featureSupported: true,
      bindingAvailable: true,
      runtimeAllowed: true,
      schemasInterpretable: true
    },
    routeTemplate: {
      packageId: 'provider.package',
      packageVersion: '1.0.0',
      adapterKey: 'provider.adapter',
      adapterVersion: '1.0.0',
      providerId: toProviderId('provider-public'),
      connectionId: toConnectionId('connection-public'),
      connectionRevision: 2,
      connectionConfigVersionId: 'connection-config:2',
      endpointPolicyId: 'endpoint-policy.public',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-version:2',
      modelId: toModelId('model-public'),
      modelRevision: 3,
      profileId: `profile.${productFeature}`,
      profileRevision: 2,
      protocolBindingId: toProtocolBindingId('binding-public'),
      protocolBindingRevision: 1,
      productFeature,
      internalPurpose: productFeature.startsWith('text_') &&
        (productFeature === 'text_chat' || productFeature === 'text_reasoning')
        ? 'text_execution'
        : productFeature === 'text_to_image'
          ? 'image_generation'
          : 'video_generation',
      featureMappingVersion: 1,
      parameterSchemaId: `parameter-schema.${productFeature}`,
      parameterSchemaRevision: 3,
      resultSchemaId: `result-schema.${productFeature}`,
      resultSchemaRevision: 1,
      usageSchemaId: toUsageSchemaId(`usage-schema.${productFeature}`),
      usageSchemaRevision: 2,
      constraintSetId: `constraint-set.${productFeature}`,
      constraintSetRevision: 1,
      runtimePolicyId: 'policy-public',
      runtimePolicyRevision: 1
    },
    ...overrides
  };
}

function candidateService(input: {
  readonly getSubject?: () => ResolvedFeatureSubjectV1;
  readonly getCandidates?: () => readonly ResolvedFeatureCandidateV1[];
  readonly now?: () => string;
  readonly lifetimeMs?: number;
} = {}) {
  const resolver: FeatureSubjectResolverPort = {
    async resolve() {
      return input.getSubject?.() ?? subjectSnapshot();
    }
  };
  const source: FeatureCandidateSourcePort = {
    async list() {
      return input.getCandidates?.() ?? [candidate()];
    }
  };
  return new ProviderFeatureCandidateService(
    resolver,
    source,
    new RouteSelectionTokenVault(),
    input.now ?? (() => t0),
    input.lifetimeMs ?? 60_000
  );
}

async function storageFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-public-orchestration-'));
  roots.push(root);
  const storage = new NodeProjectStorage(path.join(root, 'project'));
  const ledger = new RuntimeAuthorizationLedger(
    new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
    () => t1
  );
  return {
    root,
    ledger,
    acceptances: new ProjectSubmissionAcceptanceStore(
      new ProjectMetadataUnitOfWork(storage, () => t3)
    ),
    journal: new SubmissionIntentJournal(storage, () => t3)
  };
}

function idFactory(): ProviderSubmissionOrchestrationIdFactory {
  let invocationEvent = 0;
  let journalEvent = 0;
  return {
    nextSubmissionIntentId: () => toSubmissionIntentId('intent-public-orchestration'),
    nextRouteSnapshotId: () => toProviderExecutionRouteSnapshotId('route-public-orchestration'),
    nextProviderInvocationAttemptId: () =>
      toProviderInvocationAttemptId('attempt-public-orchestration'),
    nextProviderInvocationEventId: () =>
      toProviderInvocationEventId(`invocation-event-public-${++invocationEvent}`),
    nextAuthorizationClaimId: () => 'claim-public-orchestration',
    nextJournalEventId: () => `journal-event-public-${++journalEvent}`
  };
}

function mediaArtifacts(): SubmissionArtifactFactoryPort {
  return {
    async create(input) {
      const draft = createDraft({
        id: imageSubject.kind === 'draft' ? imageSubject.draftId : toDraftId('impossible'),
        projectId,
        kind: 'image_generation',
        state: 'saved',
        prompt: {
          originalInput: input.subject.outboundTextSnapshot,
          systemSupplements: [],
          finalPrompt: input.subject.outboundTextSnapshot
        },
        selectedAssetIds: [],
        createdAt: t0,
        updatedAt: t0
      });
      const task = createTaskFromDraft({
        id: toTaskId('task-public-orchestration'),
        draft,
        confirmedAt: input.createdAt
      });
      const execution = createExecution({
        id: toExecutionId('execution-public-orchestration'),
        taskId: task.id,
        createdAt: input.createdAt
      });
      return {
        subjectArtifacts: {
          kind: 'media' as const,
          task: addExecutionToTask(task, execution),
          execution
        },
        dispatchRequest: { prompt: input.subject.outboundTextSnapshot }
      };
    }
  };
}

function conversationArtifacts(
  textCandidate: ResolvedFeatureCandidateV1,
  responseExecutionId = 'response-execution-public',
  responseEventId = 'response-event-public'
): SubmissionArtifactFactoryPort {
  return {
    async create(input) {
      if (input.subject.subject.kind !== 'conversation_response_draft') {
        throw new Error('conversation artifact fixture received a non-conversation subject');
      }
      const conversationSubject = input.subject.subject;
      const responseExecution = createConversationResponseExecution({
        id: toConversationResponseExecutionId(responseExecutionId),
        projectId,
        providerInvocationAttemptId: input.invocationAttemptId,
        snapshot: {
          schemaVersion: 1,
          responseDraftId: conversationSubject.responseDraftId,
          responseDraftRevision: conversationSubject.responseDraftRevision,
          conversationId: conversationSubject.conversationId,
          conversationRevision: conversationSubject.conversationRevision,
          userMessageId: conversationSubject.userMessageId,
          userMessageRevision: 0,
          assistantMessageId: toMessageId('message-assistant-public'),
          productFeature: 'text_chat',
          routeSnapshotId: input.routeSnapshotId,
          candidate: {
            schemaVersion: 1,
            providerId: textCandidate.routeTemplate.providerId,
            connectionId: textCandidate.routeTemplate.connectionId,
            connectionRevision: textCandidate.routeTemplate.connectionRevision,
            modelId: textCandidate.routeTemplate.modelId,
            modelRevision: textCandidate.routeTemplate.modelRevision,
            profileId: textCandidate.routeTemplate.profileId,
            profileRevision: textCandidate.routeTemplate.profileRevision,
            protocolBindingId: textCandidate.routeTemplate.protocolBindingId,
            protocolBindingRevision: textCandidate.routeTemplate.protocolBindingRevision,
            runtimeSource: 'official_direct'
          },
          outboundUserTextSnapshot: input.subject.outboundTextSnapshot,
          contextSnapshots: []
        },
        createdAt: input.createdAt
      });
      return {
        subjectArtifacts: {
          kind: 'conversation' as const,
          responseExecution,
          responseStreamEvents: [createConversationResponseStreamEvent({
            id: toConversationResponseStreamEventId(responseEventId),
            responseExecutionId: responseExecution.id,
            sequence: 1,
            type: 'execution_created',
            occurredAt: input.createdAt
          })]
        },
        dispatchRequest: { text: input.subject.outboundTextSnapshot }
      };
    }
  };
}

async function approvedLedger(ledger: RuntimeAuthorizationLedger) {
  await ledger.upsertPolicy({
    policyId: 'policy-public',
    providerPackageId: 'provider.package',
    connectionId: 'connection-public',
    adapterKey: 'provider.adapter',
    state: 'interactive_allowed',
    revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result']
  });
}

describe('provider public feature candidates', () => {
  it('returns stable safe DTOs without issuing route tokens or auto-selecting', async () => {
    const service = candidateService({
      getCandidates: () => [
        candidate('text_to_image', {
          candidateId: 'candidate-unavailable',
          providerName: '服务商 B',
          eligibility: {
            ...candidate().eligibility,
            profileStatus: 'declared'
          }
        }),
        candidate()
      ]
    });
    const values = await service.listFeatureCandidates(imageSubject);
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      candidateId: 'candidate-text_to_image',
      available: true,
      unavailableReasons: [],
      parameterSchema: { fields: [{ fieldId: 'strength' }] }
    });
    expect(values[1]).toMatchObject({
      available: false,
      unavailableReasons: ['profile_unavailable']
    });
    expect(JSON.stringify(values)).not.toMatch(
      /routeSelectionToken|profileId|adapterKey|protocolId|endpoint|credential|evidence/i
    );
  });

  it('never publishes deleted connections while retaining disabled connections as unavailable', async () => {
    const deleted = candidate('text_to_image', {
      candidateId: 'candidate-deleted-connection',
      eligibility: {
        ...candidate().eligibility,
        connectionState: 'deleted'
      }
    });
    const disabled = candidate('text_to_image', {
      candidateId: 'candidate-disabled-connection',
      eligibility: {
        ...candidate().eligibility,
        connectionState: 'disabled'
      }
    });
    const retired = candidate('text_to_image', {
      candidateId: 'candidate-retired-model',
      eligibility: {
        ...candidate().eligibility,
        catalogState: 'retired'
      }
    });
    const service = candidateService({
      getCandidates: () => [deleted, disabled, retired]
    });

    await expect(service.listFeatureCandidates(imageSubject)).resolves.toMatchObject([
      {
        candidateId: 'candidate-disabled-connection',
        available: false,
        unavailableReasons: ['connection_unavailable']
      }
    ]);
    await expect(service.prepareSubmission({
      subject: imageSubject,
      candidateId: deleted.candidateId
    })).rejects.toMatchObject({ code: 'candidate_not_found' });
  });

  it('does not publish deleted connections in text-model catalogs', async () => {
    const textSubject: FeatureCandidateSubjectV1 = {
      kind: 'conversation_response_draft',
      conversationId: toConversationId('conversation-deleted-candidate'),
      conversationRevision: 1,
      responseDraftId: toConversationResponseDraftId('response-deleted-candidate'),
      responseDraftRevision: 1,
      userMessageId: toMessageId('message-deleted-candidate')
    };
    const service = candidateService({
      getSubject: () => subjectSnapshot(textSubject, 'text_chat'),
      getCandidates: () => [candidate('text_chat', {
        candidateId: 'candidate-deleted-text-connection',
        eligibility: {
          ...candidate('text_chat').eligibility,
          connectionState: 'deleted'
        }
      })]
    });

    await expect(service.listCatalogForFeature({
      projectId,
      productFeature: 'text_chat'
    })).resolves.toEqual([]);
  });

  it('invalidates expired, tampered, consumed and fingerprint-stale selections', async () => {
    let clock = t0 as string;
    let strength = 5;
    const service = candidateService({
      now: () => clock,
      lifetimeMs: 60_000,
      getSubject: () => ({
        ...subjectSnapshot(),
        parameterValues: { strength }
      })
    });
    const prepared = await service.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    const confirmation = {
      schemaVersion: 1 as const,
      confirmationId: prepared.confirmation.confirmationId,
      confirmed: true as const
    };
    await expect(service.validatePreparedSubmission({
      subject: imageSubject,
      routeSelectionToken: `${prepared.routeSelectionToken}x`,
      confirmation
    })).rejects.toBeInstanceOf(FeatureSubmissionError);

    strength = 6;
    await expect(service.validatePreparedSubmission({
      subject: imageSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    })).rejects.toMatchObject({ code: 'stale_route_selection' });
    strength = 5;
    await service.validatePreparedSubmission({
      subject: imageSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    });
    service.consumePreparedSubmission(prepared.routeSelectionToken);
    await expect(service.validatePreparedSubmission({
      subject: imageSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    })).rejects.toMatchObject({ code: 'route_selection_consumed' });

    const expiring = await service.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    clock = t2;
    await expect(service.validatePreparedSubmission({
      subject: imageSubject,
      routeSelectionToken: expiring.routeSelectionToken,
      confirmation: {
        ...confirmation,
        confirmationId: expiring.confirmation.confirmationId
      }
    })).rejects.toMatchObject({ code: 'route_selection_expired' });
  });
});

describe('provider submission orchestration', () => {
  it('persists acceptance before request start and performs one idempotent async submit', async () => {
    const fixture = await storageFixture();
    await approvedLedger(fixture.ledger);
    const service = candidateService({ now: () => t0 });
    const prepared = await service.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    const order: string[] = [];
    let dispatchCount = 0;
    const dispatch = new ProviderSubmissionDispatchBridge(
      new ProviderPackageRegistry([submissionPackageFixture()]),
      [{
        packageId: 'provider.package',
        packageVersion: '1.0.0',
        adapterKey: 'provider.adapter',
        adapterVersion: '1.0.0',
        protocolId: 'provider.protocol',
        protocolVersion: '1.0.0',
        async submit(input) {
          dispatchCount += 1;
          expect(await fixture.acceptances.list()).toHaveLength(1);
          order.push('accepted_project_facts');
          await input.beforeRequestStarted();
          order.push('request_started');
          return {
            kind: 'accepted_async',
            providerOperationId: 'provider-operation-public',
            providerOperationRecord: createProviderOperationRecord({
              id: toProviderOperationRecordId('provider-operation-record-public'),
              taskId: toTaskId('task-public-orchestration'),
              executionId: toExecutionId('execution-public-orchestration'),
              mediaKind: 'image',
              executionLifecycle: 'asynchronous_polling',
              outcome: {
                kind: 'accepted_async',
                providerOperationId: 'provider-operation-public',
                state: 'queued'
              },
              createdAt: t1,
              updatedAt: t1
            })
          };
        }
      }]
    );
    const orchestrator = new ProviderSubmissionOrchestrator(
      service,
      fixture.acceptances,
      fixture.ledger,
      fixture.journal,
      mediaArtifacts(),
      dispatch,
      idFactory(),
      () => t1
    );
    const input = {
      subject: imageSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1 as const,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true as const
      }
    };
    await expect(orchestrator.submitDraft(input)).resolves.toMatchObject({
      status: 'provider_accepted',
      retryAllowed: false
    });
    await expect(orchestrator.submitDraft(input)).resolves.toMatchObject({
      status: 'provider_accepted'
    });
    expect(dispatchCount).toBe(1);
    expect(order).toEqual(['accepted_project_facts', 'request_started']);
    const [acceptance] = await fixture.acceptances.list();
    expect(acceptance).toMatchObject({
      intent: { status: 'provider_accepted' },
      invocationAttempt: { state: 'accepted' },
      routeSnapshot: {
        providerDisplayName: '服务商 A',
        connectionDisplayName: '连接 A',
        modelDisplayName: '模型 A',
        runtimeAuthorizationClaimId: 'claim-public-orchestration'
      }
    });
    expect((await fixture.ledger.load()).claims[0]).toMatchObject({ state: 'request_started' });
    await expect(fixture.acceptances.scanRecovery()).resolves.toMatchObject([{
      action: 'resume_provider_operation',
      providerOperationId: 'provider-operation-public',
      allowedActions: ['query', 'cancel', 'receive_result']
    }]);
  });

  it('records authorization failure without dispatching or leaving a submit-ready attempt', async () => {
    const fixture = await storageFixture();
    const service = candidateService({ now: () => t0 });
    const prepared = await service.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    let dispatched = false;
    const orchestrator = new ProviderSubmissionOrchestrator(
      service,
      fixture.acceptances,
      fixture.ledger,
      fixture.journal,
      mediaArtifacts(),
      { async submit() { dispatched = true; return { kind: 'failed_before_submission', safeCode: 'unexpected' }; } },
      idFactory(),
      () => t1
    );
    await expect(orchestrator.submitDraft({
      subject: imageSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    })).rejects.toMatchObject({ code: 'authorization_not_claimed' });
    expect(dispatched).toBe(false);
    const [acceptance] = await fixture.acceptances.list();
    expect(acceptance.intent).toMatchObject({
      status: 'authorization_not_claimed',
      safeCode: 'authorization.no_matching_policy'
    });
    expect(acceptance.invocationAttempt.state).toBe('failed_before_submission');
  });

  it('distinguishes zero-request failure from unknown outcome and never permits automatic retry', async () => {
    const before = await storageFixture();
    await approvedLedger(before.ledger);
    const beforeService = candidateService({ now: () => t0 });
    const beforePrepared = await beforeService.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    const beforeOrchestrator = new ProviderSubmissionOrchestrator(
      beforeService,
      before.acceptances,
      before.ledger,
      before.journal,
      mediaArtifacts(),
      { async submit() { return { kind: 'failed_before_submission', safeCode: 'transport.offline' }; } },
      idFactory(),
      () => t1
    );
    await expect(beforeOrchestrator.submitDraft({
      subject: imageSubject,
      routeSelectionToken: beforePrepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: beforePrepared.confirmation.confirmationId,
        confirmed: true
      }
    })).rejects.toMatchObject({
      code: 'submission_failed_before_request',
      result: { status: 'failed_before_submission', retryAllowed: false }
    });
    expect((await before.ledger.load()).claims[0].state).toBe('released_before_request');

    const unknown = await storageFixture();
    await approvedLedger(unknown.ledger);
    const unknownService = candidateService({ now: () => t0 });
    const unknownPrepared = await unknownService.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    const unknownOrchestrator = new ProviderSubmissionOrchestrator(
      unknownService,
      unknown.acceptances,
      unknown.ledger,
      unknown.journal,
      mediaArtifacts(),
      {
        async submit(input) {
          await input.beforeRequestStarted();
          throw new Error('socket closed after write');
        }
      },
      idFactory(),
      () => t1
    );
    await expect(unknownOrchestrator.submitDraft({
      subject: imageSubject,
      routeSelectionToken: unknownPrepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: unknownPrepared.confirmation.confirmationId,
        confirmed: true
      }
    })).rejects.toMatchObject({
      code: 'submission_outcome_unknown',
      result: { status: 'unknown_outcome', retryAllowed: false }
    });
    expect((await unknown.ledger.load()).claims[0].state).toBe('outcome_recorded');
  });

  it('records an explicit provider rejection after request start as failed', async () => {
    const fixture = await storageFixture();
    await approvedLedger(fixture.ledger);
    const service = candidateService({ now: () => t0 });
    const prepared = await service.prepareSubmission({
      subject: imageSubject,
      candidateId: 'candidate-text_to_image'
    });
    const orchestrator = new ProviderSubmissionOrchestrator(
      service,
      fixture.acceptances,
      fixture.ledger,
      fixture.journal,
      mediaArtifacts(),
      {
        async submit(input) {
          await input.beforeRequestStarted();
          return {
            kind: 'failed_before_submission',
            safeCode: 'newapi.invalid_parameters'
          };
        }
      },
      idFactory(),
      () => t1
    );
    await expect(orchestrator.submitDraft({
      subject: imageSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    })).rejects.toMatchObject({
      code: 'provider_rejected',
      result: { status: 'failed', retryAllowed: false }
    });
    const [acceptance] = await fixture.acceptances.list();
    expect(acceptance.intent).toMatchObject({
      status: 'failed',
      safeCode: 'newapi.invalid_parameters'
    });
    expect(acceptance.invocationAttempt.state).toBe('failed');
    expect(acceptance.invocationEvents.at(-1)).toMatchObject({
      type: 'failed',
      safeCode: 'newapi.invalid_parameters'
    });
    expect((await fixture.ledger.load()).claims[0].state).toBe('outcome_recorded');
    await expect(fixture.journal.load()).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ stage: 'failed' })])
    });
  });

  it('keeps conversation response submission separate and can complete synchronously', async () => {
    const conversationSubject: FeatureCandidateSubjectV1 = {
      kind: 'conversation_response_draft',
      conversationId: toConversationId('conversation-public'),
      conversationRevision: 2,
      responseDraftId: toConversationResponseDraftId('response-draft-public'),
      responseDraftRevision: 1,
      userMessageId: toMessageId('message-user-public')
    };
    const textCandidate = candidate('text_chat', {
      candidateId: 'candidate-text-chat',
      contentCategories: ['conversation_text']
    });
    const service = candidateService({
      now: () => t0,
      getSubject: () => subjectSnapshot(conversationSubject, 'text_chat'),
      getCandidates: () => [textCandidate]
    });
    const prepared = await service.prepareSubmission({
      subject: conversationSubject,
      candidateId: textCandidate.candidateId
    });
    const fixture = await storageFixture();
    await approvedLedger(fixture.ledger);
    const artifacts = conversationArtifacts(textCandidate);
    const orchestrator = new ProviderSubmissionOrchestrator(
      service,
      fixture.acceptances,
      fixture.ledger,
      fixture.journal,
      artifacts,
      {
        async submit(input) {
          await input.beforeRequestStarted();
          return {
            kind: 'completed_sync',
            providerOperationId: 'text-operation-public'
          };
        }
      },
      idFactory(),
      () => t1
    );
    await expect(orchestrator.submitConversationResponse({
      subject: conversationSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    })).resolves.toMatchObject({ status: 'completed' });
    const [acceptance] = await fixture.acceptances.list();
    expect(acceptance.subjectArtifacts.kind).toBe('conversation');
    expect(acceptance.invocationAttempt.state).toBe('completed');
    expect(() => orchestrator.submitDraft({
      subject: conversationSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    })).toThrow(SubmissionOrchestrationError);
  });

  it('returns conversation acceptance before provider dispatch completes', async () => {
    const conversationSubject: FeatureCandidateSubjectV1 = {
      kind: 'conversation_response_draft',
      conversationId: toConversationId('conversation-start'),
      conversationRevision: 2,
      responseDraftId: toConversationResponseDraftId('response-draft-start'),
      responseDraftRevision: 1,
      userMessageId: toMessageId('message-user-start')
    };
    const textCandidate = candidate('text_chat', {
      candidateId: 'candidate-text-start',
      contentCategories: ['conversation_text']
    });
    const service = candidateService({
      now: () => t0,
      getSubject: () => subjectSnapshot(conversationSubject, 'text_chat'),
      getCandidates: () => [textCandidate]
    });
    const prepared = await service.prepareSubmission({
      subject: conversationSubject,
      candidateId: textCandidate.candidateId
    });
    const fixture = await storageFixture();
    await approvedLedger(fixture.ledger);
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const orchestrator = new ProviderSubmissionOrchestrator(
      service,
      fixture.acceptances,
      fixture.ledger,
      fixture.journal,
      conversationArtifacts(textCandidate, 'response-execution-start', 'response-event-start'),
      {
        async submit(input) {
          await input.beforeRequestStarted();
          await dispatchGate;
          return { kind: 'accepted_async', providerOperationId: 'text-operation-start' };
        }
      },
      idFactory(),
      () => t1
    );

    const started = await orchestrator.beginConversationResponse({
      subject: conversationSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    });
    expect(started.accepted).toMatchObject({
      status: 'authorization_pending',
      retryAllowed: false
    });

    let completionSettled = false;
    void started.completion.finally(() => { completionSettled = true; });
    await Promise.resolve();
    expect(completionSettled).toBe(false);

    releaseDispatch();
    await expect(started.completion).resolves.toMatchObject({ status: 'provider_accepted' });
  });

  it('keeps an accepted execution fact when background dispatch fails before request', async () => {
    const conversationSubject: FeatureCandidateSubjectV1 = {
      kind: 'conversation_response_draft',
      conversationId: toConversationId('conversation-start-failed'),
      conversationRevision: 2,
      responseDraftId: toConversationResponseDraftId('response-draft-start-failed'),
      responseDraftRevision: 1,
      userMessageId: toMessageId('message-user-start-failed')
    };
    const textCandidate = candidate('text_chat', {
      candidateId: 'candidate-text-start-failed',
      contentCategories: ['conversation_text']
    });
    const service = candidateService({
      now: () => t0,
      getSubject: () => subjectSnapshot(conversationSubject, 'text_chat'),
      getCandidates: () => [textCandidate]
    });
    const prepared = await service.prepareSubmission({
      subject: conversationSubject,
      candidateId: textCandidate.candidateId
    });
    const fixture = await storageFixture();
    await approvedLedger(fixture.ledger);
    const orchestrator = new ProviderSubmissionOrchestrator(
      service,
      fixture.acceptances,
      fixture.ledger,
      fixture.journal,
      conversationArtifacts(textCandidate, 'response-execution-start-failed', 'response-event-start-failed'),
      {
        async submit() {
          return { kind: 'failed_before_submission', safeCode: 'transport.offline' };
        }
      },
      idFactory(),
      () => t1
    );

    const started = await orchestrator.beginConversationResponse({
      subject: conversationSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    });
    await expect(started.completion).rejects.toMatchObject({
      code: 'submission_failed_before_request',
      result: { status: 'failed_before_submission' }
    });
    const [acceptance] = await fixture.acceptances.list();
    expect(acceptance.intent.status).toBe('failed_before_submission');
  });
});

function submissionPackageFixture(): ProviderPackageDescriptor {
  return {
    packageId: 'provider.package',
    packageVersion: '1.0.0',
    displayName: 'Submission Fixture',
    credentialSchemas: [{
      schemaId: 'credential.provider-fixture',
      version: 1,
      fields: [{
        key: 'api_key',
        label: 'API key',
        secret: true,
        required: true,
        kind: 'token'
      }]
    }],
    endpointPolicies: [{
      policyId: 'endpoint.provider-fixture',
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: ['api.provider-fixture.test'],
      allowedPorts: [443],
      allowedPathPrefixes: ['/v1'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: 'https://api.provider-fixture.test/v1'
    }],
    adapters: [{
      adapterId: 'provider.adapter',
      adapterVersion: '1.0.0',
      protocolId: 'provider.protocol',
      protocolVersion: '1.0.0',
      operations: ['submit', 'query', 'cancel', 'receive_result']
    }],
    templates: [{
      templateId: 'provider-fixture-official',
      kind: 'official',
      displayName: 'Provider Fixture Official',
      baseUrlMode: 'fixed',
      credentialSchemaId: 'credential.provider-fixture',
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.provider-fixture',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.provider-fixture',
      discoveryPolicyRevision: 1,
      endpointPolicyId: 'endpoint.provider-fixture',
      endpointPolicyRevision: 1,
      adapterBindings: [{
        adapterId: 'provider.adapter',
        adapterVersion: '1.0.0'
      }],
      freeConnectionValidation: false,
      modelDiscoveryKind: 'manual_exact'
    }]
  };
}
