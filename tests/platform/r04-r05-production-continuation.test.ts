import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addUserMessage, createConversationAgentRun, createConversationAgentSession, createProjectConversation,
  attachConversationAgentRunExecution, beginAssistantMessage, createConversationResponseExecution, createConversationResponseStreamEvent,
  toProviderInvocationAttemptId, toConversationResponseDraftId, toProviderExecutionRouteSnapshotId, toConversationResponseStreamEventId,
  createProviderExecutionRouteSnapshot, createProviderInvocationAttempt, createProviderInvocationEvent, createSubmissionIntent,
  transitionSubmissionIntent, toSubmissionIntentId, toProviderInvocationEventId, toUsageSchemaId,
  createProvider, createProviderConnection, createProviderModel, createProviderProtocolBinding,
  toConnectionId, toConversationAgentRunId, toConversationId, toIsoTimestamp, toModelId, toProjectId,
  toProtocolBindingId, toProviderId, toConversationResponseExecutionId, toMessageId, updateConversationAgentSession,
  type ConversationAgentSessionV1
} from '../../src/domain';
import {
  createChatContextRuntime, createOpenAiCompatibleDefaultTextDefinition, DeepSeekSharedRuntime, NewApiSharedRuntime,
  JsonProviderRegistryStore, RuntimeAuthorizationLedger, JsonRuntimeAuthorizationLedgerStore, SecureCredentialVault,
  NodeProjectStorage, JsonProjectConversationRepository, JsonConversationResponseExecutionRepository,
  projectStoragePaths,
  JsonConversationAgentRunRepository, NEWAPI_PROVIDER_PACKAGE_ID, NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_COMPATIBLE_TEMPLATE_ID, NEWAPI_CREDENTIAL_SCHEMA_ID, NEWAPI_ENDPOINT_POLICY_ID, NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_ADAPTER_VERSION, NEWAPI_CHAT_PROTOCOL_ID, NEWAPI_PROTOCOL_VERSION,
  type ChatContextRuntime, type NewApiHttpTransportRequest, type NewApiHttpTransportResponse
} from '../../src/platform';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { ConversationAgentSessionService } from '../../src/application/conversation-agent-session-service';
import { ConversationAgentRuntimeService } from '../../src/application/conversation-agent-runtime-service';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { ProjectMetadataUnitOfWork } from '../../src/platform/storage/project-metadata-unit-of-work';
import { ProjectSubmissionAcceptanceStore } from '../../src/platform/storage/project-submission-acceptance';
import { ConversationDocumentToolSessionService } from '../../src/platform/documents/conversation-document-tool-session';
import type { ConversationAgentSessionDto, StartResponseRequest } from '../../src/shared/chat-context-ipc';

const projectId = toProjectId('project-r45-production');
const timestamp = toIsoTimestamp('2026-10-04T00:00:00.000Z');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  vi.restoreAllMocks();
});

async function fixture(options: { readonly holdResponse?: boolean; readonly leaseTtlMs?: number; readonly lateToolCall?: boolean; readonly initialClock?: number; readonly maximumSubmissions?: number } = {}) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-r45-production-'));
  const userDataDirectory = path.join(rootDirectory, 'isolated-profile');
  await mkdir(userDataDirectory);
  const provider = await providerFixture(userDataDirectory, options.maximumSubmissions);
  const storage = new NodeProjectStorage(rootDirectory);
  let executionClock = options.initialClock ?? Date.now();
  const at = () => new Date(executionClock).toISOString();
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => timestamp);
  const executions = new JsonConversationResponseExecutionRepository(storage, projectId);
  const sessions = new JsonConversationAgentSessionRepository(storage, projectId, at);
  const runs = new JsonConversationAgentRunRepository(storage, projectId, at);
  const conversation = createProjectConversation({ id: toConversationId('conversation-r45-production'),
    projectId, title: 'Offline continuation fixture', createdAt: timestamp });
  await conversations.create(conversation);
  const requests: NewApiHttpTransportRequest[] = [];
  const errors: unknown[] = [];
  let lateStreamReads = 0;
  let releaseResponse!: () => void;
  const released = new Promise<void>(resolve => { releaseResponse = resolve; });
  const newApiRuntime = new NewApiSharedRuntime({ transport: { send: async request => {
    requests.push(request);
    if (options.holdResponse) await released;
    if (options.lateToolCall) return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: {
      async *[Symbol.asyncIterator]() {
        lateStreamReads += 1;
        const chunk = { id: 'synthetic-r45-late-lease-response', object: 'chat.completion.chunk', created: 1, model: provider.modelKey,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'r45-lease-late-generation', type: 'function',
            function: { name: 'generate_pptx', arguments: JSON.stringify({ title: 'Late lease', content: 'Must not execute after lease loss' }) } }] },
          finish_reason: 'tool_calls' }] };
        yield Buffer.from('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
      }
    } };
    return textResponse(provider.modelKey, '已接收补充信息，任务继续。');
  } } });
  const deepSeekRuntime = new DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected provider'); } } });
  const runtimes: ChatContextRuntime[] = [];
  const createRuntime = () => {
    const runtime = createChatContextRuntime({ userDataDirectory, providerRegistry: provider.registry,
      runtimeAuthorization: provider.authorization,
      getSession: () => ({ projectId, projectName: 'Offline R04/R05 fixture', rootDirectory }),
      textSubmission: { credentialVault: provider.vault, deepSeekRuntime, newApiRuntime },
      now: () => timestamp, executionNow: () => executionClock, executionLeaseTtlMs: options.leaseTtlMs,
      onError: error => errors.push(error) });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = createRuntime();
  const available = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
  if (!available.ok) throw new Error('Synthetic candidates failed: ' + available.error.code);
  const candidate = available.value.find(item => item.available);
  if (!candidate) throw new Error('Synthetic candidate unavailable');
  async function request(content: string, commandId: string, waiting?: ConversationAgentSessionDto): Promise<Omit<StartResponseRequest, 'confirmed'>> {
    const current = (await conversations.get(conversation.id))!;
    return { clientCommandId: commandId,
      conversation: { conversationId: current.id, expectedRevision: current.revision, editedMessageId: null },
      title: current.title, content, productFeature: 'text_chat', candidateId: candidate!.candidateId,
      contextSelections: [], parameterValues: {}, ...(waiting ? { continuation: {
        sessionId: waiting.sessionId, expectedRevision: waiting.revision, resumeToken: waiting.resumeToken!,
        action: waiting.waiting?.allowedActions[0] ?? 'reply'
      } } : {}) };
  }
  async function getSession(id: string): Promise<ConversationAgentSessionV1> {
    const session = await sessions.get(toConversationAgentRunId(id));
    if (!session) throw new Error('Missing persisted parent session');
    return session;
  }
  async function getDto(host: ChatContextRuntime, id: string) {
    const current = await host.conversations.get({ conversationId: conversation.id });
    if (!current.ok) throw new Error('Conversation read failed: ' + current.error.code + ': ' + current.error.message +
      '; ' + errors.map(error => error instanceof Error ? error.stack : String(error)).join('; '));
    const session = current.value.agentSessions?.find(item => item.sessionId === id);
    if (!session) throw new Error('Missing parent session DTO');
    return session;
  }
  async function seedPlanningRoot(submitted: boolean) {
    const rootId = toConversationAgentRunId(submitted ? 'agent-root-live-unreceived-planning' : 'agent-root-live-unsubmitted-planning');
    const sourceId = toMessageId(`${rootId}-source`), current = (await conversations.get(conversation.id))!;
    const source = addUserMessage(current, { id: sourceId, content: '只回复一句话，介绍培训流程。', createdAt: timestamp });
    await conversations.save(source, current.revision);
    const message = source.messages.find(item => item.id === sourceId)!;
    const reference = { kind: 'message' as const, id: message.id, version: message.revision,
      contentHash: digest([message.content, message.displayContent, message.attachments]) };
    const createdAt = toIsoTimestamp(at()), startedAt = executionClock;
    await runs.create(createConversationAgentRun({ id: rootId, projectId, conversationId: conversation.id, sourceMessageId: sourceId, createdAt }));
    const root = createConversationAgentSession({ id: rootId, projectId, conversationId: conversation.id,
      sourceMessageId: sourceId, createdAt, budget: { startedAt, deadlineAt: startedAt + 360_000, maxToolCalls: 8, budgetUnits: 24 },
      inputReferences: [reference], goalHash: digest(reference), initialSegment: { runId: rootId, sourceMessageId: sourceId,
        inputReferenceHash: digest(reference), status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 } });
    await sessions.create(root);
    const owned = await sessions.acquireLease({ sessionId: rootId, ownerId: 'synthetic-crashed-planning-host', ttlMs: 1_000 });
    if (submitted) await sessions.commit({ sessionId: rootId, expectedRevision: owned.session.revision,
      fence: { ownerId: owned.lease.ownerId, epoch: owned.lease.epoch }, session: updateConversationAgentSession(owned.session, {
        planningBoundary: 'submitted', childSegments: owned.session.childSegments.map(child => ({ ...child, planningBoundary: 'submitted' }))
      }, toIsoTimestamp(at())) });
    return getSession(rootId);
  }
  cleanups.push(async () => {
    releaseResponse();
    for (const host of runtimes) {
      await host.interruptActiveResponses();
      await host.waitForMutations();
    }
    deepSeekRuntime.dispose(); newApiRuntime.dispose();
    expect(path.dirname(path.resolve(rootDirectory))).toBe(path.resolve(os.tmpdir()));
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { runtime, createRuntime, request, getSession, getDto, seedPlanningRoot, conversations, conversation, executions, sessions, runs, storage,
    authorization: provider.authorization,
    requests, errors, at, releaseResponse, get lateStreamReads() { return lateStreamReads; },
    advance(ms: number) { executionClock += ms; }, setTime(ms: number) { executionClock = ms; } };
}

async function waitForExecution(host: ChatContextRuntime, id: string) {
  await vi.waitFor(async () => expect(await host.responses.getExecution({ responseExecutionId: id }))
    .toMatchObject({ ok: true, value: { state: 'completed', content: '已接收补充信息，任务继续。' } }),
  { timeout: 5_000, interval: 10 });
  await host.waitForMutations();
}

describe('R04/R05 production Host continuation boundary', () => {
  async function seedBindingCrash(f: Awaited<ReturnType<typeof fixture>>, paidUnknown: boolean) {
    const original = await f.seedPlanningRoot(false), current = (await f.conversations.get(f.conversation.id))!;
    const childId = toConversationAgentRunId('agent-child-binding-crash'), responseId = toConversationResponseExecutionId('response-binding-crash');
    const message = current.messages.find(item => item.id === original.sourceMessageId)!;
    const reference = original.inputReferences[0], at = toIsoTimestamp(f.at());
    let child = createConversationAgentRun({ id: childId, parentRunId: original.id, projectId,
      conversationId: current.id, sourceMessageId: message.id, createdAt: at });
    await f.runs.create(child);
    await f.sessions.beginInitialSegment({ sessionId: original.id, expectedRevision: original.revision,
      fence: { ownerId: original.lease!.ownerId, epoch: original.lease!.epoch }, inputReference: reference,
      segment: { runId: childId, sourceMessageId: message.id, inputReferenceHash: digest(reference), status: 'active',
        planningBoundary: 'not_started', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 } });
    const assistantId = toMessageId('assistant-binding-crash');
    await f.conversations.save(beginAssistantMessage(current, { id: assistantId, createdAt: timestamp }), current.revision);
    const response = createConversationResponseExecution({ id: responseId, projectId,
      providerInvocationAttemptId: toProviderInvocationAttemptId('attempt-binding-crash'), createdAt: timestamp,
      snapshot: { schemaVersion: 1, responseDraftId: toConversationResponseDraftId('draft-binding-crash'), responseDraftRevision: 1,
        conversationId: current.id, conversationRevision: current.revision, userMessageId: message.id, userMessageRevision: message.revision,
        assistantMessageId: assistantId, productFeature: 'text_chat', routeSnapshotId: toProviderExecutionRouteSnapshotId('route-binding-crash'),
        candidate: { schemaVersion: 1, providerId: toProviderId('provider-r45-production'), connectionId: toConnectionId('connection-r45-production'),
          connectionRevision: 1, modelId: toModelId('model-r45-production'), modelRevision: 1, profileId: 'profile-r45-production', profileRevision: 1,
          protocolBindingId: toProtocolBindingId('binding-r45-production'), protocolBindingRevision: 1, runtimeSource: 'newapi_gateway' },
        outboundUserTextSnapshot: message.content, contextSnapshots: [] } });
    await f.executions.create(response, createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('event-binding-crash'),
      responseExecutionId: responseId, sequence: 1, type: 'execution_created', occurredAt: timestamp }));
    const attached = attachConversationAgentRunExecution(child, responseId, at);
    await f.runs.save(attached, child.revision); child = attached;
    if (paidUnknown) {
      const canonical = new ConversationAgentRuntimeService({ repository: new JsonConversationAgentRuntimeRepository(f.storage, projectId, f.at),
        now: f.at, nextEventId: () => `binding-crash-event-${crypto.randomUUID()}`, hash: value => createHash('sha256').update(value).digest('hex') });
      await canonical.open(child, original.budget);
      await canonical.providerLifecycle(childId).modelPrepared({ round: 0, requestHash: 'a'.repeat(64), messageCount: 1, toolCount: 0 });
      await canonical.providerLifecycle(childId).modelStarted({ round: 0 });
    }
    const unbound = await f.getSession(original.id);
    expect(unbound.childSegments[1].responseExecutionId).toBeUndefined();
    f.setTime(original.budget.deadlineAt);
    return { original: unbound, child, responseId };
  }
  async function seedAuthorizationClaim(f: Awaited<ReturnType<typeof fixture>>, responseId: string, started = false) {
    const response = (await f.executions.get(toConversationResponseExecutionId(responseId)))!;
    const claimId = 'authorization-binding-crash', candidate = response.snapshot.candidate;
    await f.authorization.claimSubmission({ providerPackageId: NEWAPI_PROVIDER_PACKAGE_ID, connectionId: candidate.connectionId,
      adapterKey: NEWAPI_CHAT_ADAPTER_ID, policyRevision: 1, routeSelectionNonce: 'nonce-binding-crash',
      idempotencyKey: 'idempotency-binding-crash', claimId, now: timestamp });
    if (started) await f.authorization.markRequestStarted(claimId, timestamp);
    const routeSnapshot = createProviderExecutionRouteSnapshot({ id: response.snapshot.routeSnapshotId, projectId,
      packageId: NEWAPI_PROVIDER_PACKAGE_ID, packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, adapterKey: NEWAPI_CHAT_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION, providerId: candidate.providerId, connectionId: candidate.connectionId,
      connectionRevision: candidate.connectionRevision, connectionConfigVersionId: 'connection-config-r45-production',
      endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1, credentialVersionId: 'credential-version-r45-production',
      modelId: candidate.modelId, modelRevision: candidate.modelRevision, profileId: candidate.profileId, profileRevision: candidate.profileRevision,
      protocolBindingId: candidate.protocolBindingId, protocolBindingRevision: 1, productFeature: 'text_chat', featureMappingVersion: 1,
      parameterSchemaId: 'parameters-binding-crash', parameterSchemaRevision: 1, resultSchemaId: 'results-binding-crash', resultSchemaRevision: 1,
      usageSchemaId: toUsageSchemaId('usage-binding-crash'), usageSchemaRevision: 1, constraintSetId: 'constraints-binding-crash', constraintSetRevision: 1,
      runtimePolicyId: 'policy-r45-production', runtimePolicyRevision: 1, runtimeAuthorizationClaimId: claimId, createdAt: timestamp });
    const intent = transitionSubmissionIntent(createSubmissionIntent({ id: toSubmissionIntentId('intent-binding-crash'), projectId,
      subject: { kind: 'conversation_response_draft', conversationId: response.snapshot.conversationId,
        conversationRevision: response.snapshot.conversationRevision, responseDraftId: response.snapshot.responseDraftId,
        responseDraftRevision: response.snapshot.responseDraftRevision, userMessageId: response.snapshot.userMessageId },
      routeSnapshotId: routeSnapshot.id, providerInvocationAttemptId: response.providerInvocationAttemptId,
      idempotencyKey: 'idempotency-binding-crash', authorizationClaimId: claimId, createdAt: timestamp }), 'authorization_claimed', timestamp);
    const acceptances = new ProjectSubmissionAcceptanceStore(new ProjectMetadataUnitOfWork(f.storage, f.at));
    await acceptances.accept({ schemaVersion: 1, intent, routeSnapshot,
      invocationAttempt: createProviderInvocationAttempt({ id: response.providerInvocationAttemptId, projectId, routeSnapshotId: routeSnapshot.id,
        subject: { kind: 'conversation', conversationId: response.snapshot.conversationId, userMessageId: response.snapshot.userMessageId,
          responseExecutionId: response.id }, createdAt: timestamp }),
      invocationEvents: [createProviderInvocationEvent({ id: toProviderInvocationEventId('invocation-binding-crash'),
        invocationAttemptId: response.providerInvocationAttemptId, sequence: 1, type: 'submission_started', occurredAt: timestamp })],
      subjectArtifacts: { kind: 'conversation', responseExecution: response, responseStreamEvents: await f.executions.listEvents(response.id) } });
    return { acceptances, claimId };
  }
  async function seedUnrelatedBusyRoot(f: Awaited<ReturnType<typeof fixture>>, startedAt: number) {
    const id = toConversationAgentRunId('agent-root-unrelated-lazy'), sourceId = toMessageId('unrelated-lazy-user');
    const createdAt = toIsoTimestamp(new Date(startedAt).toISOString());
    const conversation = createProjectConversation({ id: toConversationId('conversation-unrelated-lazy'), projectId,
      title: 'Unrelated recovery scope', createdAt: timestamp });
    await f.conversations.create(conversation);
    const withUser = addUserMessage(conversation, { id: sourceId, content: 'Unrelated task', createdAt: timestamp });
    await f.conversations.save(withUser, conversation.revision);
    const message = withUser.messages[0], reference = { kind: 'message' as const, id: message.id, version: message.revision,
      contentHash: digest([message.content, message.displayContent, message.attachments]) };
    await f.runs.create(createConversationAgentRun({ id, projectId, conversationId: conversation.id, sourceMessageId: sourceId, createdAt }));
    await f.sessions.create(createConversationAgentSession({ id, projectId, conversationId: conversation.id,
      sourceMessageId: sourceId, createdAt, budget: { startedAt, deadlineAt: startedAt + 360_000, maxToolCalls: 8, budgetUnits: 24 },
      inputReferences: [reference], initialSegment: { runId: id, sourceMessageId: sourceId, inputReferenceHash: digest([reference]),
        status: 'active', toolCallsUsed: 0, toolAttemptsUsed: 0, costUnitsUsed: 0 } }));
    await f.sessions.acquireLease({ sessionId: id, ownerId: 'unrelated-foreign-owner', ttlMs: 1_000 });
    return (await f.sessions.get(id))!;
  }

  it.each(['conversation', 'execution', 'start'] as const)('rechecks an initially busy crashed paid root after TTL in the same Host via %s without touching another root', async entry => {
    const f = await fixture({ initialClock: Date.now() - 120_000 }), crash = await seedBindingCrash(f, true);
    f.setTime(crash.original.budget.startedAt + 1);
    const unrelated = await seedUnrelatedBusyRoot(f, crash.original.budget.startedAt);
    const restarted = f.createRuntime();
    expect((await f.getDto(restarted, crash.original.id)).state).toBe('running');
    expect(await f.getSession(crash.original.id)).toEqual(crash.original);
    expect(await f.sessions.get(unrelated.id)).toEqual(unrelated); expect(f.requests).toEqual([]);
    f.setTime(crash.original.lease!.expiresAt);
    if (entry === 'conversation') expect((await f.getDto(restarted, crash.original.id)).state).toBe('needs_reconciliation');
    else if (entry === 'execution') expect(await restarted.responses.getExecution({ responseExecutionId: crash.responseId }))
      .toMatchObject({ ok: true, value: { parentRun: { state: 'needs_reconciliation' } } });
    else expect(await restarted.responses.startAgent(await f.request('只回复一句话。', 'lazy-paid-expired-start')))
      .toMatchObject({ ok: false, error: { code: 'response_reconciliation_required' } });
    const frozen = await f.getSession(crash.original.id);
    expect(frozen.status).toBe('needs_reconciliation'); expect(frozen.lease).toBeUndefined();
    expect(frozen.childSegments[1].responseExecutionId).toBe(crash.responseId);
    expect(frozen.budget).toEqual(crash.original.budget); expect(f.requests).toEqual([]);
    expect(await f.sessions.get(unrelated.id)).toEqual(unrelated);
    await Promise.all([f.getDto(restarted, frozen.id), restarted.responses.getExecution({ responseExecutionId: crash.responseId })]);
    expect(await f.getSession(frozen.id)).toEqual(frozen); expect(await f.sessions.get(unrelated.id)).toEqual(unrelated);
  }, 10_000);

  it('offers a proven unsubmitted busy root after TTL in the same Host and keeps its waiting token stable on subsequent reads', async () => {
    const f = await fixture({ initialClock: Date.now() - 120_000 }), crash = await seedBindingCrash(f, false);
    f.setTime(crash.original.budget.startedAt + 1);
    const restarted = f.createRuntime();
    expect((await f.getDto(restarted, crash.original.id)).state).toBe('running');
    expect(await f.getSession(crash.original.id)).toEqual(crash.original); expect(f.requests).toEqual([]);
    f.setTime(crash.original.lease!.expiresAt);
    const offered = await f.getDto(restarted, crash.original.id);
    expect(offered).toMatchObject({ state: 'waiting_user', waiting: { reason: 'continuation_required', allowedActions: ['continue'] } });
    expect(offered.resumeToken).toBeTruthy();
    const waiting = await f.getSession(crash.original.id);
    expect(waiting.budget).toEqual(crash.original.budget); expect(f.requests).toEqual([]);
    expect((await f.executions.get(crash.responseId))?.state).toBe('failed');
    expect(await f.getDto(restarted, waiting.id)).toEqual(offered);
    expect(await restarted.responses.getExecution({ responseExecutionId: crash.responseId })).toMatchObject({ ok: true, value: { state: 'failed' } });
    expect(await f.getSession(waiting.id)).toEqual(waiting);
    const resumed = await restarted.responses.startAgent(await f.request('继续', 'lazy-unsubmitted-explicit-continue', offered));
    if (!resumed.ok || !('execution' in resumed.value)) throw new Error('Expected explicit same-task continuation: ' + JSON.stringify(resumed));
    await waitForExecution(restarted, resumed.value.execution.responseExecutionId);
    const completed = await f.getSession(waiting.id);
    expect(completed.budget).toEqual(waiting.budget); expect(completed.childSegments).toHaveLength(waiting.childSegments.length + 1);
    expect(completed.status).toBe('closed'); expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('repairs a primary binding lost before the segment CAS, freezes a submitted outcome, and permits exact explicit close after expiry', async () => {
    const f = await fixture({ initialClock: Date.now() - 360_000 }), crash = await seedBindingCrash(f, true), restarted = f.createRuntime();
    const dto = await f.getDto(restarted, crash.original.id);
    expect(dto.state).toBe('needs_reconciliation'); expect(dto.canCloseUnknown).toBeUndefined();
    const frozen = await f.getSession(crash.original.id);
    expect(frozen.childSegments[1].responseExecutionId).toBe(crash.responseId);
    expect(frozen.status).toBe('needs_reconciliation'); expect(frozen.budget).toEqual(crash.original.budget);
    expect(frozen.leaseEpoch).toBe(crash.original.leaseEpoch); expect(f.requests).toEqual([]);
    const inspected = await restarted.responses.inspectReconciliation({ projectId, responseExecutionId: crash.responseId });
    if (!inspected.ok) throw new Error('Expected bound child reconciliation inspection');
    const closed = await restarted.responses.acknowledgeReconciliation({ projectId, responseExecutionId: crash.responseId,
      expectedRunRevision: inspected.value.parentRun.runRevision, inspectToken: inspected.value.inspectToken, confirmed: true });
    if (!closed.ok) throw new Error('Exact close failed: ' + JSON.stringify(closed) + '; ' + f.errors.map(error => error instanceof Error ? error.stack : String(error)).join('; '));
    expect(await f.getDto(restarted, crash.original.id)).toMatchObject({ state: 'cancelled' });
    const receipt = await f.getSession(crash.original.id);
    expect(receipt.childSegments[1].status).toBe('unknown'); expect(receipt.budget).toEqual(crash.original.budget);
    const next = await restarted.responses.startAgent(await f.request('只回复一句新的培训建议。', 'binding-crash-after-exact-close'));
    if (!next.ok || !('execution' in next.value)) throw new Error('Expected a new task after explicit closure: ' + JSON.stringify(next));
    await waitForExecution(restarted, next.value.execution.responseExecutionId);
    expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('locally retires a proven unsubmitted response whose binding CAS was lost, without submitting or granting a fresh deadline', async () => {
    const f = await fixture({ initialClock: Date.now() - 360_000 }), crash = await seedBindingCrash(f, false), restarted = f.createRuntime();
    expect(await f.getDto(restarted, crash.original.id)).toMatchObject({ state: 'expired' });
    const expired = await f.getSession(crash.original.id);
    expect(expired.childSegments[1].responseExecutionId).toBe(crash.responseId);
    expect(expired.budget).toEqual(crash.original.budget); expect(expired.leaseEpoch).toBe(crash.original.leaseEpoch);
    expect(expired.waiting).toBeUndefined(); expect(expired.lease).toBeUndefined(); expect(f.requests).toEqual([]);
    expect((await f.executions.get(crash.responseId))?.state).toBe('failed');
    expect((await f.runs.get(crash.child.id))?.status).toBe('failed');
    const next = await restarted.responses.startAgent(await f.request('只回复一句新的培训建议。', 'binding-crash-new-after-known-expiry'));
    if (!next.ok || !('execution' in next.value)) throw new Error('Expected explicit new task after safe local retirement: ' + JSON.stringify(next));
    await waitForExecution(restarted, next.value.execution.responseExecutionId); expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('releases only the exact unsubmitted acceptance claim so a one-submission policy can admit the explicit new task', async () => {
    const f = await fixture({ initialClock: Date.now() - 360_000, maximumSubmissions: 1 });
    const crash = await seedBindingCrash(f, false), authorization = await seedAuthorizationClaim(f, crash.responseId);
    const restarted = f.createRuntime();
    expect((await f.getDto(restarted, crash.original.id)).state).toBe('expired');
    expect((await f.authorization.getClaim(authorization.claimId))?.state).toBe('released_before_request');
    const retired = await authorization.acceptances.getByInvocationAttemptId(toProviderInvocationAttemptId('attempt-binding-crash'));
    expect(retired?.intent.status).toBe('failed_before_submission');
    expect(retired?.invocationEvents.at(-1)?.type).toBe('submission_failed_before_request');
    expect(f.requests).toEqual([]);
    const next = await restarted.responses.startAgent(await f.request('只回复一句新的培训建议。', 'binding-crash-new-after-release'));
    if (!next.ok || !('execution' in next.value)) throw new Error('Expected new task under released one-submission policy: ' + JSON.stringify(next));
    await waitForExecution(restarted, next.value.execution.responseExecutionId); expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('freezes a ledger-started claim despite missing canonical HTTP evidence and preserves its consumed authorization', async () => {
    const f = await fixture({ initialClock: Date.now() - 360_000, maximumSubmissions: 1 });
    const crash = await seedBindingCrash(f, false), authorization = await seedAuthorizationClaim(f, crash.responseId, true);
    const restarted = f.createRuntime();
    expect((await f.getDto(restarted, crash.original.id)).state).toBe('needs_reconciliation');
    expect((await f.authorization.getClaim(authorization.claimId))?.state).toBe('request_started');
    expect((await f.getSession(crash.original.id)).childSegments[1].responseExecutionId).toBe(crash.responseId);
    expect((await f.runs.get(crash.child.id))?.status).toBe('needs_reconciliation');
    expect((await authorization.acceptances.getByInvocationAttemptId(toProviderInvocationAttemptId('attempt-binding-crash')))?.intent.status).toBe('authorization_claimed');
    expect(f.requests).toEqual([]);
  }, 10_000);

  it('rejects an observer binding receipt owned by a live Host without changing primary evidence', async () => {
    const f = await fixture(), crash = await seedBindingCrash(f, false);
    f.setTime(crash.original.budget.startedAt + 1);
    const before = await f.getSession(crash.original.id);
    await expect(f.sessions.recordVerifiedResponseBinding({ sessionId: before.id, runId: crash.child.id,
      responseExecutionId: crash.responseId, expectedRevision: before.revision, expectedLeaseEpoch: before.leaseEpoch })).rejects.toThrow(/lease_busy/);
    expect(await f.getSession(before.id)).toEqual(before); expect(f.requests).toEqual([]);
  });

  it('freezes mismatched primary response source evidence instead of repairing a binding from a foreign source', async () => {
    const f = await fixture(), crash = await seedBindingCrash(f, false);
    await f.storage.mutateJsonAtomically(projectStoragePaths.entities.conversationResponseExecutions, value => {
      const document = value as { executions: readonly Record<string, unknown>[] };
      return { ...document, executions: document.executions.map(execution => execution.id === crash.responseId
        ? { ...execution, snapshot: { ...(execution.snapshot as Record<string, unknown>), userMessageId: 'foreign-source-binding-crash' } } : execution) };
    });
    const restarted = f.createRuntime();
    expect((await restarted.conversations.get({ conversationId: f.conversation.id })).ok).toBe(false);
    expect((await f.getSession(crash.original.id)).status).toBe('needs_reconciliation');
    expect((await f.getSession(crash.original.id)).childSegments[1].responseExecutionId).toBeUndefined();
    expect(f.requests).toEqual([]);
  });

  it('freezes a canonical response identity that disagrees with its primary child and repaired segment', async () => {
    const f = await fixture(), crash = await seedBindingCrash(f, false);
    const canonical = new ConversationAgentRuntimeService({ repository: new JsonConversationAgentRuntimeRepository(f.storage, projectId, f.at),
      now: f.at, nextEventId: () => `binding-conflict-event-${crypto.randomUUID()}`, hash: value => createHash('sha256').update(value).digest('hex') });
    await canonical.open({ ...crash.child, responseExecutionId: toConversationResponseExecutionId('foreign-canonical-response') }, crash.original.budget);
    const restarted = f.createRuntime();
    expect((await f.getDto(restarted, crash.original.id)).state).toBe('needs_reconciliation');
    const frozen = await f.getSession(crash.original.id);
    expect(frozen.childSegments[1].responseExecutionId).toBe(crash.responseId);
    expect(frozen.budget).toEqual(crash.original.budget); expect(f.requests).toEqual([]);
  });
  it('closes a durably saved planning root when the user cancels before any child response or external request exists', async () => {
    const f = await fixture();
    const open = ConversationAgentSessionService.prototype.open;
    vi.spyOn(ConversationAgentSessionService.prototype, 'open').mockImplementation(async function (this: ConversationAgentSessionService, input) {
      const admitted = await open.call(this, input);
      expect(await f.runtime.responses.cancelResponseStart({ projectId, clientCommandId: 'r45-root-planning-cancel' }))
        .toMatchObject({ ok: true, value: { cancelled: true } });
      return admitted;
    });
    expect(await f.runtime.responses.startAgent(await f.request('制作一个 PPT。', 'r45-root-planning-cancel')))
      .toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
    await vi.waitFor(async () => expect((await f.sessions.list())[0]).toMatchObject({ status: 'closed', closedReason: 'cancelled' }),
      { timeout: 2_000, interval: 10 });
    await f.runtime.waitForMutations();
    const saved = await f.sessions.list();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: 'closed', closedReason: 'cancelled',
      budget: { toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 }, childSegments: [{ status: 'settled' }] });
    expect(saved[0].lease).toBeUndefined();
    expect(await f.executions.list(f.conversation.id)).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('admits the next normal turn as soon as the preceding response becomes terminal while its Host settlement is still finishing', async () => {
    const f = await fixture();
    const rootIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = await f.runtime.responses.startAgent(await f.request('只回复一句话，介绍培训流程。', `r45-immediate-next-${index}`));
      expect(started.ok).toBe(true);
      if (!started.ok || !('execution' in started.value) || !started.value.agentSession) throw new Error('Expected executable normal turn');
      rootIds.push(started.value.agentSession.sessionId);
      const id = started.value.execution.responseExecutionId;
      // Real UI send readiness follows the streamed Response state. It does not
      // call the Host shutdown barrier between ordinary messages.
      await vi.waitFor(async () => expect(await f.runtime.responses.getExecution({ responseExecutionId: id }))
        .toMatchObject({ ok: true, value: { state: 'completed' } }), { timeout: 5_000, interval: 10 });
    }
    await f.runtime.waitForMutations();
    expect(new Set(rootIds).size).toBe(3);
    for (const id of rootIds) expect(await f.getSession(id)).toMatchObject({ status: 'closed', closedReason: 'completed' });
    expect(f.requests).toHaveLength(3);
    expect(f.errors).toEqual([]);
  }, 10_000);

  it('keeps clarification and consecutive replies under one stable parent with immutable child ownership and the original budget', async () => {
    const f = await fixture();
    const first = await f.runtime.responses.startAgent(await f.request('制作一个 PPT。', 'r45-missing-topic'));
    expect(first).toMatchObject({ ok: true, value: { waiting: true, agentSession: {
      state: 'waiting_user', waiting: { reason: 'input_required', allowedActions: ['reply'] }
    } } });
    if (!first.ok || !('waiting' in first.value)) throw new Error('Expected initial saved clarification');
    const originalDto = first.value.agentSession;
    expect(originalDto.resumeToken).toBeTruthy();
    const original = await f.getSession(originalDto.sessionId);
    expect(original.childSegments).toHaveLength(1);
    expect(original.lease).toBeUndefined();
    expect(original.planningBoundary).toBe('not_started');
    expect(await f.executions.list(f.conversation.id)).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(JSON.stringify(original)).not.toContain(originalDto.resumeToken!);
    const planningRoot = await f.runs.get(original.id);
    expect(planningRoot).toMatchObject({ id: original.id, sourceMessageId: original.sourceMessageId });
    expect(planningRoot?.responseExecutionId).toBeUndefined();

    f.advance(2_000);
    const stillMissing = await f.runtime.responses.startAgent(await f.request('PPT。', 'r45-still-missing', originalDto));
    expect(stillMissing).toMatchObject({ ok: true, value: { waiting: true, agentSession: { sessionId: original.id, state: 'waiting_user' } } });
    if (!stillMissing.ok || !('waiting' in stillMissing.value)) throw new Error('Expected another clarification');
    const waiting = await f.getSession(original.id);
    expect(waiting.childSegments).toHaveLength(2);
    expect(waiting.childSegments[0]).toMatchObject({ runId: original.id, sourceMessageId: original.sourceMessageId, status: 'settled' });
    expect(waiting.childSegments[1].runId).not.toBe(original.id);
    expect(waiting.budget).toEqual(original.budget);
    expect(waiting.leaseEpoch).toBeGreaterThan(original.leaseEpoch);
    expect(f.requests).toEqual([]);

    f.advance(3_000);
    const finalRequest = await f.request('主题是企业新人培训，面向新员工，内容包括流程和常见问题。', 'r45-complete-topic', stillMissing.value.agentSession);
    const started = await f.runtime.responses.startAgent(finalRequest);
    expect(started.ok).toBe(true);
    if (!started.ok || !('execution' in started.value)) throw new Error('Expected executable child after requirements become complete');
    expect(started.value.agentSession?.sessionId).toBe(original.id);
    const executionId = started.value.execution.responseExecutionId;
    await waitForExecution(f.runtime, executionId);
    const settled = await f.getSession(original.id);
    expect(settled.childSegments).toHaveLength(3);
    expect(new Set(settled.childSegments.map(child => child.runId)).size).toBe(3);
    expect(settled.budget).toEqual(original.budget);
    // The original PPT delivery goal remains required even when the latest
    // reply merely supplies a topic. A text-only response cannot complete it.
    expect(settled).toMatchObject({ status: 'closed', closedReason: 'failed' });
    expect(settled.childSegments.slice(0, 2)).toEqual(waiting.childSegments.map(child => ({ ...child, status: 'settled' })));
    const child = await f.runs.findByResponseExecutionId(toConversationResponseExecutionId(started.value.execution.responseExecutionId));
    expect(child).toMatchObject({ id: settled.childSegments[2].runId, parentRunId: original.id, responseExecutionId: executionId });
    expect((await f.runs.get(original.id))?.responseExecutionId).toBeUndefined();
    expect(f.requests).toHaveLength(1);

    const beforeReplay = (await f.conversations.get(f.conversation.id))!;
    const replay = await f.runtime.responses.startAgent(finalRequest);
    expect(replay).toMatchObject({ ok: true, value: { execution: { responseExecutionId: executionId }, agentSession: { sessionId: original.id } } });
    expect(await f.conversations.get(f.conversation.id)).toEqual(beforeReplay);
    expect(await f.getSession(original.id)).toEqual(settled);
    expect(f.requests).toHaveLength(1);
    expect(f.errors).toEqual([]);
  }, 15_000);

  it('recovers a saved wait with one fresh challenge and never dispatches an HTTP request on startup or read', async () => {
    const f = await fixture();
    const first = await f.runtime.responses.startAgent(await f.request('制作一个 PPT。', 'r45-restart-wait'));
    if (!first.ok || !('waiting' in first.value)) throw new Error('Expected saved waiting parent');
    const original = await f.getSession(first.value.agentSession.sessionId);
    await f.runtime.interruptActiveResponses(); await f.runtime.waitForMutations();
    f.advance(1_000);
    const restarted = f.createRuntime();
    const resumedDto = await f.getDto(restarted, original.id);
    expect(resumedDto).toMatchObject({ sessionId: original.id, state: 'waiting_user', waiting: { allowedActions: ['reply'] } });
    expect(resumedDto.resumeToken).toBeTruthy();
    expect(resumedDto.resumeToken).not.toBe(first.value.agentSession.resumeToken);
    const rotated = await f.getSession(original.id);
    expect(rotated.waitingVersion).toBe(original.waitingVersion + 1);
    expect(rotated.budget).toEqual(original.budget);
    expect(rotated.childSegments).toEqual(original.childSegments);
    expect(await f.getDto(restarted, original.id)).toEqual(resumedDto);
    expect(await f.getSession(original.id)).toEqual(rotated);
    expect(await f.executions.list(f.conversation.id)).toEqual([]);
    expect(f.requests).toEqual([]);

    const before = (await f.conversations.get(f.conversation.id))!;
    const stale = await restarted.responses.startAgent(await f.request('主题是企业培训。', 'r45-stale-restart-token', first.value.agentSession));
    expect(stale.ok).toBe(false);
    expect(await f.conversations.get(f.conversation.id)).toEqual(before);
    expect(f.requests).toEqual([]);
  }, 10_000);

  it('rejects continuation after the original root deadline without granting a new budget', async () => {
    const f = await fixture();
    const first = await f.runtime.responses.startAgent(await f.request('制作一个 PPT。', 'r45-expiry-wait'));
    if (!first.ok || !('waiting' in first.value)) throw new Error('Expected saved waiting parent');
    const original = await f.getSession(first.value.agentSession.sessionId);
    f.setTime(original.budget.deadlineAt);
    expect(await f.getDto(f.runtime, original.id)).toMatchObject({ sessionId: original.id, state: 'expired' });
    const before = (await f.conversations.get(f.conversation.id))!;
    const resumed = await f.runtime.responses.startAgent(await f.request('主题是培训。', 'r45-expired-reply', first.value.agentSession));
    expect(resumed.ok).toBe(false);
    expect(await f.conversations.get(f.conversation.id)).toEqual(before);
    expect((await f.getSession(original.id)).budget).toEqual(original.budget);
    expect(await f.executions.list(f.conversation.id)).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('blocks a new request in the existing Host when unreceived planning has passed its deadline and no child response exists', async () => {
    const f = await fixture();
    const original = await f.seedPlanningRoot(true);
    f.setTime(original.budget.deadlineAt + 1);
    expect(await f.getDto(f.runtime, original.id)).toMatchObject({ state: 'needs_reconciliation' });
    const before = (await f.conversations.get(f.conversation.id))!;
    const next = await f.runtime.responses.startAgent(await f.request('只回复一句新的培训建议。', 'r45-no-response-unknown-new-task'));
    expect(next).toMatchObject({ ok: false, error: { code: 'response_reconciliation_required' } });
    expect(await f.conversations.get(f.conversation.id)).toEqual(before);
    const frozen = await f.getSession(original.id);
    expect(frozen).toMatchObject({ status: 'needs_reconciliation', planningBoundary: 'submitted',
      childSegments: [{ planningBoundary: 'submitted', status: 'unknown' }] });
    expect(frozen.lease).toBeUndefined();
    expect(frozen.budget).toEqual(original.budget);
    expect(await f.executions.list(f.conversation.id)).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('inspects primary no-effect evidence before an explicit new task can replace an active expired foreign root', async () => {
    const f = await fixture({ initialClock: Date.now() - 360_000 });
    const original = await f.seedPlanningRoot(false);
    expect(await f.getDto(f.runtime, original.id)).toMatchObject({ state: 'running' });
    expect(await f.getSession(original.id)).toEqual(original);
    f.setTime(original.budget.deadlineAt);
    const next = await f.runtime.responses.startAgent(await f.request('只回复一句新的培训建议。', 'r45-active-unproven-new-task'));
    if (!next.ok || !('execution' in next.value)) throw new Error('Expected explicit new task after full primary inspection: ' + JSON.stringify(next));
    await waitForExecution(f.runtime, next.value.execution.responseExecutionId);
    expect(next.value.agentSession?.sessionId).not.toBe(original.id);
    const expired = await f.getSession(original.id);
    expect(expired.status).toBe('expired'); expect(expired.budget).toEqual(original.budget);
    expect(expired.leaseEpoch).toBe(original.leaseEpoch); expect(expired.waiting).toBeUndefined();
    expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('allows an explicit new task after a known saved wait expires while keeping the old task budget and identity', async () => {
    const f = await fixture({ initialClock: Date.now() - 360_000 });
    const first = await f.runtime.responses.startAgent(await f.request('制作一个 PPT。', 'r45-known-wait-new-task'));
    if (!first.ok || !('waiting' in first.value)) throw new Error('Expected saved waiting parent');
    const original = await f.getSession(first.value.agentSession.sessionId);
    f.setTime(original.budget.deadlineAt);
    const next = await f.runtime.responses.startAgent(await f.request('只回复一句新的培训建议。', 'r45-explicit-fresh-task'));
    if (!next.ok || !('execution' in next.value) || !next.value.agentSession) throw new Error('Expected explicit fresh task after known wait expiry');
    expect(next.value.agentSession.sessionId).not.toBe(original.id);
    await waitForExecution(f.runtime, next.value.execution.responseExecutionId);
    const expired = await f.getSession(original.id);
    expect(expired.status).toBe('expired');
    expect(expired.budget).toEqual(original.budget);
    expect(expired.childSegments).toHaveLength(original.childSegments.length);
    expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('offers explicit continuation for a crashed unsubmitted root and executes one new child only after the user resumes it', async () => {
    const f = await fixture();
    const sourceId = toMessageId('r45-safe-continuation-source');
    const current = (await f.conversations.get(f.conversation.id))!;
    const source = addUserMessage(current, { id: sourceId, content: '只回复一句话，介绍培训流程。', createdAt: timestamp });
    await f.conversations.save(source, current.revision);
    const message = source.messages.find(item => item.id === sourceId)!;
    const reference = { kind: 'message' as const, id: message.id, version: message.revision,
      contentHash: digest([message.content, message.displayContent, message.attachments]) };
    const rootId = toConversationAgentRunId('agent-root-crashed-unsubmitted');
    const createdAt = toIsoTimestamp(f.at());
    const root = createConversationAgentRun({ id: rootId, projectId, conversationId: f.conversation.id,
      sourceMessageId: sourceId, createdAt });
    await f.runs.create(root);
    const startedAt = Date.parse(f.at());
    const original = createConversationAgentSession({ id: rootId, projectId, conversationId: f.conversation.id,
      sourceMessageId: sourceId, createdAt, budget: { startedAt, deadlineAt: startedAt + 360_000, maxToolCalls: 8, budgetUnits: 24 },
      inputReferences: [reference], goalHash: digest(reference), initialSegment: { runId: rootId, sourceMessageId: sourceId,
        inputReferenceHash: digest(reference), status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 } });
    await f.sessions.create(original);
    await f.sessions.acquireLease({ sessionId: rootId, ownerId: 'synthetic-crashed-host', ttlMs: 1_000 });
    f.advance(1_001);
    const restarted = f.createRuntime();
    const offered = await f.getDto(restarted, rootId);
    expect(offered).toMatchObject({ state: 'waiting_user', waiting: { reason: 'continuation_required', allowedActions: ['continue'] } });
    expect(offered.resumeToken).toBeTruthy();
    expect(f.requests).toEqual([]);
    expect(await f.executions.list(f.conversation.id)).toEqual([]);
    const waiting = await f.getSession(rootId);
    expect(waiting.budget).toEqual(original.budget);
    expect(waiting.childSegments).toHaveLength(1);
    const started = await restarted.responses.startAgent(await f.request('继续', 'r45-user-continues-safe-root', offered));
    if (!started.ok || !('execution' in started.value)) throw new Error('Expected explicit continuation execution');
    await waitForExecution(restarted, started.value.execution.responseExecutionId);
    const settled = await f.getSession(rootId);
    expect(settled).toMatchObject({ id: original.id, status: 'closed', closedReason: 'completed' });
    expect(settled.childSegments).toHaveLength(2);
    expect(settled.childSegments[1].runId).not.toBe(original.id);
    expect(settled.budget).toEqual(original.budget);
    expect(f.requests).toHaveLength(1);
    expect(f.errors).toEqual([]);
  }, 10_000);

  it('leaves another live Host lease and its submitted response untouched during a second Host startup', async () => {
    const f = await fixture({ holdResponse: true });
    const started = await f.runtime.responses.startAgent(await f.request('只回复一句话，介绍培训流程。', 'r45-live-owner'));
    if (!started.ok || !('execution' in started.value) || !started.value.agentSession) throw new Error('Expected executable leased child');
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 5_000, interval: 10 });
    const active = await f.getSession(started.value.agentSession.sessionId);
    expect(active.lease).toBeDefined();
    const originalRun = await f.runs.findByResponseExecutionId(toConversationResponseExecutionId(executionId));
    const originalExecution = await f.executions.get(toConversationResponseExecutionId(executionId));
    const secondHost = f.createRuntime();
    expect(await f.getDto(secondHost, active.id)).toMatchObject({ sessionId: active.id, state: 'running' });
    expect(await f.getSession(active.id)).toEqual(active);
    expect(await f.runs.findByResponseExecutionId(toConversationResponseExecutionId(executionId))).toEqual(originalRun);
    expect(await f.executions.get(toConversationResponseExecutionId(executionId))).toEqual(originalExecution);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].signal.aborted).toBe(false);
    f.releaseResponse();
    await waitForExecution(f.runtime, executionId);
    expect((await f.getSession(active.id)).status).toBe('closed');
    expect(f.requests).toHaveLength(1);
    expect(f.errors).toEqual([]);
  }, 10_000);

  it('aborts a submitted request after lease loss and never reads or executes late tool-call headers', async () => {
    const f = await fixture({ holdResponse: true, leaseTtlMs: 1_000, lateToolCall: true });
    // No document tool owner exists to supply cancellation here: the stable
    // root lease itself must reach the Provider transport.
    vi.spyOn(ConversationDocumentToolSessionService.prototype, 'prepare').mockResolvedValue(undefined);
    const started = await f.runtime.responses.startAgent(await f.request('只回复一句话，介绍培训流程。', 'r45-expiring-owner'));
    if (!started.ok || !('execution' in started.value) || !started.value.agentSession) throw new Error('Expected executable leased child');
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 5_000, interval: 10 });
    const original = await f.getSession(started.value.agentSession.sessionId);
    expect(original.lease).toBeDefined();
    f.setTime(original.lease!.expiresAt);
    await vi.waitFor(() => expect(f.requests[0].signal.aborted).toBe(true), { timeout: 2_000, interval: 10 });
    await f.runtime.waitForMutations();
    f.releaseResponse();
    await f.runtime.waitForMutations();
    expect(f.lateStreamReads).toBe(0);
    expect(f.requests).toHaveLength(1);
    const stopped = await f.executions.get(toConversationResponseExecutionId(executionId));
    expect(stopped).toBeDefined();
    expect(['failed', 'cancelled', 'interrupted']).toContain(stopped!.state);
    const secondHost = f.createRuntime();
    expect(await f.getDto(secondHost, original.id)).toMatchObject({ state: 'needs_reconciliation' });
    const frozen = await f.getSession(original.id);
    expect(frozen.budget).toEqual(original.budget);
    expect(frozen.childSegments.every(child => child.toolCallsUsed === 0 && child.toolAttemptsUsed === 0)).toBe(true);
    expect(frozen.registeredWorkIds).toEqual([]);
    expect(f.lateStreamReads).toBe(0);
    expect(f.requests).toHaveLength(1);
  }, 10_000);

  it('keeps an uncertain planning boundary frozen on restart and beyond expiry without automatic submission', async () => {
    const f = await fixture();
    const first = await f.runtime.responses.startAgent(await f.request('制作一个 PPT。', 'r45-unknown-wait'));
    if (!first.ok || !('waiting' in first.value)) throw new Error('Expected saved waiting parent');
    const original = await f.getSession(first.value.agentSession.sessionId);
    // Simulate a crash after dispatch was journalled but before its response was durably received.
    // This deliberately grants no executable lease and uses only the synthetic project's repository.
    await f.sessions.commit({ sessionId: original.id, expectedRevision: original.revision,
      session: updateConversationAgentSession(original, { planningBoundary: 'submitted',
        childSegments: original.childSegments.map(child => ({ ...child, planningBoundary: 'submitted' })) }, toIsoTimestamp(f.at())) });
    await f.runtime.interruptActiveResponses(); await f.runtime.waitForMutations();
    f.setTime(original.budget.deadlineAt + 1);
    const restarted = f.createRuntime();
    expect(await f.getDto(restarted, original.id)).toMatchObject({ sessionId: original.id, state: 'needs_reconciliation' });
    const frozen = await f.getSession(original.id);
    expect(frozen.status).toBe('needs_reconciliation');
    expect(frozen.budget).toEqual(original.budget);
    expect(frozen.lease).toBeUndefined();
    expect(f.requests).toEqual([]);
    const before = (await f.conversations.get(f.conversation.id))!;
    const attempt = await restarted.responses.startAgent(await f.request('直接生成培训 PPT。', 'r45-unknown-new-send'));
    expect(attempt.ok).toBe(false);
    expect(await f.conversations.get(f.conversation.id)).toEqual(before);
    expect(f.requests).toEqual([]);
  }, 10_000);
});

function textResponse(model: string, content: string): NewApiHttpTransportResponse {
  const chunk = { id: 'synthetic-r45-production', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] };
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n'); })() };
}

async function providerFixture(directory: string, maximumSubmissions?: number) {
  const providerId = toProviderId('provider-r45-production');
  const connectionId = toConnectionId('connection-r45-production');
  const bindingId = toProtocolBindingId('binding-r45-production');
  const modelId = toModelId('model-r45-production');
  const modelKey = 'synthetic-r07-newapi-text';
  const definition = createOpenAiCompatibleDefaultTextDefinition({ packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, providerModelKey: modelKey, features: ['text_chat'] });
  const template = definition.profileTemplates[0]!;
  const registry = new JsonProviderRegistryStore(path.join(directory, 'provider-registry.json'));
  await registry.mutate(snapshot => ({ result: undefined, snapshot: { ...snapshot,
    providers: [createProvider({ id: providerId, name: 'Offline synthetic provider', packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, accessCategory: 'online', identityState: 'verified', createdAt: timestamp, updatedAt: timestamp })],
    connections: [createProviderConnection({ id: connectionId, providerId, name: 'Offline injected transport', endpoint: 'https://gateway.example.test/v1',
      packageId: NEWAPI_PROVIDER_PACKAGE_ID, packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
      templateKind: 'compatible_custom', credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
      credentialVersionId: 'credential-version-r45-production', credentialReference: 'synthetic-r45-reference',
      connectionPolicyId: 'connection.newapi.compatible', connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.newapi.models', discoveryPolicyRevision: 1,
      endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
      connectionConfigVersionId: 'connection-config-r45-production', connectionRevision: 1,
      adapterBindings: [{ adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION,
        protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: timestamp, updatedAt: timestamp })],
    protocolBindings: [createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION, adapterKind: NEWAPI_CHAT_ADAPTER_ID,
      mediaKind: 'unknown', authScheme: 'bearer', executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: timestamp, updatedAt: timestamp })],
    models: [createProviderModel({ id: modelId, providerId, connectionId, protocolBindingId: bindingId,
      providerModelKey: modelKey, mediaKind: 'unknown', revision: 1, displayName: 'Offline synthetic model',
      activeProfileId: 'profile-r45-production', catalogState: 'present', enabled: true, createdAt: timestamp, updatedAt: timestamp })],
    modelDefinitions: [definition], modelProfiles: [{ schemaVersion: 1, profileId: 'profile-r45-production', revision: 1,
      packageId: definition.packageId, sourceTemplateId: template.templateId, adapterKey: template.adapterKey,
      modelId, modelRevision: 1, protocolBindingId: bindingId, status: 'verified', features: template.features, evidenceIds: [], recordedAt: timestamp }]
  } }));
  const authorization = new RuntimeAuthorizationLedger(new JsonRuntimeAuthorizationLedgerStore(path.join(directory, 'authorization.json')), () => timestamp);
  await authorization.upsertPolicy({ policyId: 'policy-r45-production', providerPackageId: NEWAPI_PROVIDER_PACKAGE_ID,
    connectionId, adapterKey: NEWAPI_CHAT_ADAPTER_ID, state: 'interactive_allowed', revision: 1,
    ...(maximumSubmissions === undefined ? {} : { maximumSubmissions }),
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
  const vault = new SecureCredentialVault(path.join(directory, 'synthetic-only-credentials.json'), {
    isAvailable: () => true, protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8')
  });
  // This placeholder is synthetic and never reaches a real network transport.
  await vault.saveRecord('synthetic-r45-reference', { schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
    values: { api_key: 'offline-synthetic-placeholder' } });
  return { registry, authorization, vault, modelKey };
}

