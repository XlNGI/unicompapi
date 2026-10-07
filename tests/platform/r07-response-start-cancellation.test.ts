import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectConversation, createProvider, createProviderConnection, createProviderModel, createProviderProtocolBinding,
  toConnectionId, toConversationId, toIsoTimestamp, toModelId, toProjectId, toProtocolBindingId, toProviderId
} from '../../src/domain';
import {
  createChatContextRuntime, createOpenAiCompatibleDefaultTextDefinition, DeepSeekSharedRuntime, NewApiSharedRuntime,
  JsonProviderRegistryStore, RuntimeAuthorizationLedger, JsonRuntimeAuthorizationLedgerStore, SecureCredentialVault,
  NodeProjectStorage, JsonProjectConversationRepository, JsonConversationResponseExecutionRepository,
  JsonDocumentTaskRuntimeRepository, JsonWorkRepository, NEWAPI_PROVIDER_PACKAGE_ID, NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_COMPATIBLE_TEMPLATE_ID, NEWAPI_CREDENTIAL_SCHEMA_ID, NEWAPI_ENDPOINT_POLICY_ID, NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_ADAPTER_VERSION, NEWAPI_CHAT_PROTOCOL_ID, NEWAPI_PROTOCOL_VERSION,
  type NewApiHttpTransportRequest, type NewApiHttpTransportResponse
} from '../../src/platform';
import { ConversationProductionTraceStore } from '../../src/platform/conversation-production-trace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

const projectId = toProjectId('project-r07-start-cancellation');
const timestamp = toIsoTimestamp('2026-10-03T00:00:00.000Z');

describe('R07 composed runtime cancellation before first response headers', () => {
  it('stops the real pending request, closes late tool-call headers and allows the next conversation turn', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-r07-start-cancel-'));
    const userDataDirectory = path.join(rootDirectory, 'isolated-profile');
    await mkdir(userDataDirectory);
    const provider = await providerFixture(userDataDirectory);
    const storage = new NodeProjectStorage(rootDirectory);
    const conversations = new JsonProjectConversationRepository(storage, projectId, () => timestamp);
    const executions = new JsonConversationResponseExecutionRepository(storage, projectId);
    const tasks = new JsonDocumentTaskRuntimeRepository(storage, projectId);
    const works = new JsonWorkRepository(storage, projectId);
    const conversation = createProjectConversation({ id: toConversationId('conversation-r07-start-cancel'),
      projectId, title: 'Offline cancellation integration', createdAt: timestamp });
    await conversations.create(conversation);
    const headersEntered = deferred<NewApiHttpTransportRequest>();
    const lateHeaders = deferred<NewApiHttpTransportResponse>();
    const transportReturned = deferred<void>();
    const requests: NewApiHttpTransportRequest[] = [];
    let lateStreamReads = 0;
    const errors: unknown[] = [];
    const newApiRuntime = new NewApiSharedRuntime({ transport: { send: async request => {
      requests.push(request);
      if (requests.length === 1) {
        headersEntered.resolve(request);
        // Deliberately ignores AbortSignal: the adapter must bound and close its late result.
        const response = await lateHeaders.promise;
        transportReturned.resolve();
        return response;
      }
      if (requests.length !== 2) throw new Error('Unexpected continuation or repeated synthetic HTTP');
      return textResponse(provider.modelKey, 'Next turn completed.');
    } } });
    const deepSeekRuntime = new DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected provider'); } } });
    const runtime = createChatContextRuntime({ userDataDirectory, providerRegistry: provider.registry,
      runtimeAuthorization: provider.authorization,
      getSession: () => ({ projectId, projectName: 'Offline R07 fixture', rootDirectory }),
      textSubmission: { credentialVault: provider.vault, deepSeekRuntime, newApiRuntime },
      now: () => timestamp, onError: error => errors.push(error) });
    let released = false;
    try {
      const candidates = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
      expect(candidates.ok).toBe(true);
      if (!candidates.ok) throw new Error('Synthetic candidates unavailable');
      const candidate = candidates.value.find(item => item.available)!;
      expect(candidate).toBeDefined();
      const clientCommandId = 'r07-first-headers-command';
      const first = runtime.responses.startAgent({ clientCommandId,
        conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null },
        title: conversation.title, content: '直接生成一份用于取消验收的 PPT。', productFeature: 'text_chat',
        candidateId: candidate.candidateId, contextSelections: [], parameterValues: {} });
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000, interval: 10 });
      const request = await headersEntered.promise;
      expect(request.signal.aborted).toBe(false);
      const before = await executions.list(conversation.id);
      expect(before).toHaveLength(1);
      expect(before[0].state).toBe('pending');
      const executionId = before[0].id;

      // beginConversationResponse can acknowledge a pending execution before HTTP headers exist.
      // In that case the real UI has an execution ID and uses cancelResponseExecution.
      const cancelStartedAt = performance.now();
      const commandCancellation = await runtime.responses.cancelResponseStart({ projectId, clientCommandId });
      expect(commandCancellation.ok).toBe(true);
      if (!commandCancellation.ok) throw new Error('Command cancellation rejected');
      if (commandCancellation.value.cancelled) {
        expect(await first).toMatchObject({ ok: false, error: { code: 'response_start_cancelled' } });
      } else {
        const acknowledged = await first;
        expect(acknowledged).toMatchObject({ ok: true, value: { execution: { responseExecutionId: executionId } } });
        const cancelled = await runtime.responses.cancelExecution({ responseExecutionId: executionId });
        expect(cancelled.ok).toBe(true);
      }
      expect(request.signal.aborted).toBe(true);
      expect(performance.now() - cancelStartedAt).toBeLessThan(2_000);
      // This is the real mutation/finalizer barrier, not a sleep or a fake completion callback.
      await runtime.waitForMutations();
      const stopped = await executions.get(executionId);
      expect(stopped).toBeDefined();
      expect(['cancelled', 'interrupted', 'failed']).toContain(stopped!.state);
      const stoppedEvents = await executions.listEvents(executionId);
      const terminal = stoppedEvents.at(-1)!;
      if (stopped!.state === 'failed') expect(terminal.safeCode).toMatch(/cancelled$/u);
      const saved = (await conversations.get(conversation.id))!;
      const assistant = saved.messages.find(message => message.id === before[0].snapshot.assistantMessageId)!;
      expect(['cancelled', 'failed']).toContain(assistant.state);
      expect(assistant.content).toBe('');
      expect(await works.list(projectId)).toEqual([]);

      lateHeaders.resolve({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: {
        async *[Symbol.asyncIterator]() {
          lateStreamReads += 1;
          yield Buffer.from(sse(provider.modelKey, { tool_calls: [{ index: 0, id: 'late-generation', type: 'function',
            function: { name: 'generate_pptx', arguments: '{"title":"Late","content":"Must not execute"}' } }] }, 'tool_calls'));
        }
      } });
      released = true;
      await transportReturned.promise;
      await vi.waitFor(() => expect(newApiRuntime.activeRequestCount).toBe(0), { timeout: 2_000, interval: 10 });
      await runtime.waitForMutations();
      expect(lateStreamReads).toBe(0);
      expect(requests).toHaveLength(1);
      expect((await tasks.list()).flatMap(task => task.toolCalls)).toEqual([]);
      const trace = await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id });
      expect(trace.some(event => event.code === 'tool_call')).toBe(false);
      expect(await works.list(projectId)).toEqual([]);

      const current = (await conversations.get(conversation.id))!;
      const blocked = await runtime.responses.startAgent({ clientCommandId: 'r07-blocked-next-command',
        conversation: { conversationId: current.id, expectedRevision: current.revision, editedMessageId: null },
        title: conversation.title, content: '现在只回复一句话。', productFeature: 'text_chat',
        candidateId: candidate.candidateId, contextSelections: [], parameterValues: {} });
      expect(blocked).toMatchObject({ ok: false, error: { code: 'response_reconciliation_required' } });
      expect(requests).toHaveLength(1);
      const inspection = await runtime.responses.inspectReconciliation({ projectId, responseExecutionId: before[0].id });
      expect(inspection.ok).toBe(true);
      if (!inspection.ok || !inspection.value.inspectToken) throw new Error('Missing reconciliation inspection');
      const acknowledged = await runtime.responses.acknowledgeReconciliation({ projectId, responseExecutionId: before[0].id,
        expectedRunRevision: inspection.value.parentRun.runRevision, inspectToken: inspection.value.inspectToken, confirmed: true });
      expect(acknowledged).toMatchObject({ ok: true, value: { acknowledged: true, reconciliationReason: 'unknown_result' } });
      const next = await runtime.responses.startAgent({ clientCommandId: 'r07-next-command',
        conversation: { conversationId: current.id, expectedRevision: current.revision, editedMessageId: null },
        title: conversation.title, content: '现在只回复一句话。', productFeature: 'text_chat',
        candidateId: candidate.candidateId, contextSelections: [], parameterValues: {} });
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error('Next send rejected: ' + next.error.code);
      if (!('execution' in next.value)) throw new Error('Expected an executable next response');
      const nextExecutionId = next.value.execution.responseExecutionId;
      await vi.waitFor(async () => {
        const completed = await runtime.responses.getExecution({ responseExecutionId: nextExecutionId });
        expect(completed).toMatchObject({ ok: true, value: { state: 'completed', content: 'Next turn completed.' } });
      }, { timeout: 3_000, interval: 10 });
      await runtime.waitForMutations();
      expect(requests).toHaveLength(2);
      expect((await tasks.list()).flatMap(task => task.toolCalls)).toEqual([]);
      expect(await works.list(projectId)).toEqual([]);
      expect((await executions.list(conversation.id)).every(item => !['pending', 'streaming'].includes(item.state))).toBe(true);
      // An already submitted request with no response headers retains unknown remote outcome.
      // Local cancellation must not turn that into an assertion of no charge or an automatic retry.
      expect(errors).toEqual([expect.objectContaining({ name: 'SubmissionOrchestrationError', code: 'submission_outcome_unknown',
        result: expect.objectContaining({ status: 'unknown_outcome', retryAllowed: false }) }),
        expect.objectContaining({ name: 'ConversationAgentSessionError', code: 'unknown_result' })]);
    } finally {
      if (!released) lateHeaders.resolve(textResponse(provider.modelKey, 'Cleanup response.'));
      await runtime.interruptActiveResponses();
      await runtime.waitForMutations();
      deepSeekRuntime.dispose();
      newApiRuntime.dispose();
      expect(path.dirname(path.resolve(rootDirectory))).toBe(path.resolve(os.tmpdir()));
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 15_000);
});

function sse(model: string, delta: Record<string, unknown>, finishReason: 'stop' | 'tool_calls') {
  return 'data: ' + JSON.stringify({ id: 'synthetic-r07-start', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n';
}

function textResponse(model: string, content: string): NewApiHttpTransportResponse {
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from(sse(model, { content }, 'stop')); })() };
}

async function providerFixture(directory: string) {
  const providerId = toProviderId('provider-r07-start');
  const connectionId = toConnectionId('connection-r07-start');
  const bindingId = toProtocolBindingId('binding-r07-start');
  const modelId = toModelId('model-r07-start');
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
      credentialVersionId: 'credential-version-r07-start', credentialReference: 'synthetic-r07-reference',
      connectionPolicyId: 'connection.newapi.compatible', connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.newapi.models', discoveryPolicyRevision: 1,
      endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
      connectionConfigVersionId: 'connection-config-r07-start', connectionRevision: 1,
      adapterBindings: [{ adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION,
        protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: timestamp, updatedAt: timestamp })],
    protocolBindings: [createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION, adapterKind: NEWAPI_CHAT_ADAPTER_ID,
      mediaKind: 'unknown', authScheme: 'bearer', executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: timestamp, updatedAt: timestamp })],
    models: [createProviderModel({ id: modelId, providerId, connectionId, protocolBindingId: bindingId,
      providerModelKey: modelKey, mediaKind: 'unknown', revision: 1, displayName: 'Offline synthetic model',
      activeProfileId: 'profile-r07-start', catalogState: 'present', enabled: true, createdAt: timestamp, updatedAt: timestamp })],
    modelDefinitions: [definition], modelProfiles: [{ schemaVersion: 1, profileId: 'profile-r07-start', revision: 1,
      packageId: definition.packageId, sourceTemplateId: template.templateId, adapterKey: template.adapterKey,
      modelId, modelRevision: 1, protocolBindingId: bindingId, status: 'verified', features: template.features, evidenceIds: [], recordedAt: timestamp }]
  } }));
  const authorization = new RuntimeAuthorizationLedger(new JsonRuntimeAuthorizationLedgerStore(path.join(directory, 'authorization.json')), () => timestamp);
  await authorization.upsertPolicy({ policyId: 'policy-r07-start', providerPackageId: NEWAPI_PROVIDER_PACKAGE_ID,
    connectionId, adapterKey: NEWAPI_CHAT_ADAPTER_ID, state: 'interactive_allowed', revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
  const vault = new SecureCredentialVault(path.join(directory, 'synthetic-only-credentials.json'), {
    isAvailable: () => true, protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8')
  });
  // This placeholder is synthetic and never reaches a real network transport.
  await vault.saveRecord('synthetic-r07-reference', { schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
    values: { api_key: 'offline-synthetic-placeholder' } });
  return { registry, authorization, vault, modelKey };
}
