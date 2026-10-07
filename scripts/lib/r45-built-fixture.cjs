const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const p = require('../../dist-electron/src/platform');
const d = require('../../dist-electron/src/domain');
const { JsonConversationAgentSessionRepository } = require('../../dist-electron/src/platform/repositories/json-conversation-agent-session-repository');
const { JsonConversationAgentRuntimeRepository } = require('../../dist-electron/src/platform/repositories/json-conversation-agent-runtime-repository');
const { ConversationAgentRuntimeService } = require('../../dist-electron/src/application/conversation-agent-runtime-service');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const projectId = d.toProjectId('project-r45-built-offline');
const timestamp = d.toIsoTimestamp('2026-10-05T00:00:00.000Z');

async function providerFixture(directory, initialize) {
  const providerId = d.toProviderId('provider-r45-production'), connectionId = d.toConnectionId('connection-r45-production');
  const bindingId = d.toProtocolBindingId('binding-r45-production'), modelId = d.toModelId('model-r45-production');
  const modelKey = 'synthetic-r45-built-text';
  const registry = new p.JsonProviderRegistryStore(path.join(directory, 'provider-registry.json'));
  const authorization = new p.RuntimeAuthorizationLedger(new p.JsonRuntimeAuthorizationLedgerStore(path.join(directory, 'authorization.json')), () => new Date().toISOString());
  const vault = new p.SecureCredentialVault(path.join(directory, 'synthetic-only-credentials.json'), {
    isAvailable: () => true, protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8')
  });
  if (initialize) {
    const definition = p.createOpenAiCompatibleDefaultTextDefinition({ packageId: p.NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: p.NEWAPI_PROVIDER_PACKAGE_VERSION, providerModelKey: modelKey, features: ['text_chat'] });
    const template = definition.profileTemplates[0];
    await registry.mutate(snapshot => ({ result: undefined, snapshot: { ...snapshot,
      providers: [d.createProvider({ id: providerId, name: 'Offline synthetic provider', packageId: p.NEWAPI_PROVIDER_PACKAGE_ID,
        packageVersion: p.NEWAPI_PROVIDER_PACKAGE_VERSION, accessCategory: 'online', identityState: 'verified', createdAt: timestamp, updatedAt: timestamp })],
      connections: [d.createProviderConnection({ id: connectionId, providerId, name: 'Offline injected transport', endpoint: 'https://gateway.example.test/v1',
        packageId: p.NEWAPI_PROVIDER_PACKAGE_ID, packageVersion: p.NEWAPI_PROVIDER_PACKAGE_VERSION, templateId: p.NEWAPI_COMPATIBLE_TEMPLATE_ID,
        templateKind: 'compatible_custom', credentialSchemaId: p.NEWAPI_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
        credentialVersionId: 'credential-version-r45-production', credentialReference: 'synthetic-r45-reference',
        connectionPolicyId: 'connection.newapi.compatible', connectionPolicyRevision: 1, discoveryPolicyId: 'discovery.newapi.models', discoveryPolicyRevision: 1,
        endpointPolicyId: p.NEWAPI_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1, connectionConfigVersionId: 'connection-config-r45-production', connectionRevision: 1,
        adapterBindings: [{ adapterId: p.NEWAPI_CHAT_ADAPTER_ID, adapterVersion: p.NEWAPI_ADAPTER_VERSION,
          protocolId: p.NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION }],
        state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: timestamp, updatedAt: timestamp })],
      protocolBindings: [d.createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
        protocolId: p.NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION, adapterKind: p.NEWAPI_CHAT_ADAPTER_ID,
        mediaKind: 'unknown', authScheme: 'bearer', executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: timestamp, updatedAt: timestamp })],
      models: [d.createProviderModel({ id: modelId, providerId, connectionId, protocolBindingId: bindingId, providerModelKey: modelKey,
        mediaKind: 'unknown', revision: 1, displayName: 'Offline synthetic model', activeProfileId: 'profile-r45-production', catalogState: 'present', enabled: true,
        createdAt: timestamp, updatedAt: timestamp })],
      modelDefinitions: [definition], modelProfiles: [{ schemaVersion: 1, profileId: 'profile-r45-production', revision: 1,
        packageId: definition.packageId, sourceTemplateId: template.templateId, adapterKey: template.adapterKey, modelId, modelRevision: 1,
        protocolBindingId: bindingId, status: 'verified', features: template.features, evidenceIds: [], recordedAt: timestamp }]
    } }));
    await authorization.upsertPolicy({ policyId: 'policy-r45-production', providerPackageId: p.NEWAPI_PROVIDER_PACKAGE_ID, connectionId,
      adapterKey: p.NEWAPI_CHAT_ADAPTER_ID, state: 'interactive_allowed', revision: 1, allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
    await vault.saveRecord('synthetic-r45-reference', { schemaId: p.NEWAPI_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
      values: { api_key: 'offline-synthetic-placeholder' } });
  }
  return { registry, authorization, vault, modelKey };
}

function textResponse(model) {
  const chunk = { id: 'synthetic-r45-built', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { content: '已接收补充信息，任务继续。' }, finish_reason: 'stop' }] };
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n'); })() };
}

function repositories(rootDirectory) {
  const storage = new p.NodeProjectStorage(rootDirectory), now = () => new Date().toISOString();
  return { storage, now,
    conversations: new p.JsonProjectConversationRepository(storage, projectId, now),
    executions: new p.JsonConversationResponseExecutionRepository(storage, projectId),
    sessions: new JsonConversationAgentSessionRepository(storage, projectId, now),
    runs: new p.JsonConversationAgentRunRepository(storage, projectId, now) };
}

async function seedRoot(rootDirectory, kind) {
  const base = Date.now() - (kind === 'expired' ? 370_000 : 10_000), at = () => new Date(base).toISOString();
  const storage = new p.NodeProjectStorage(rootDirectory), createdAt = d.toIsoTimestamp(at()), now = () => new Date().toISOString();
  const conversations = new p.JsonProjectConversationRepository(storage, projectId, now);
  const sessions = new JsonConversationAgentSessionRepository(storage, projectId, now);
  const runs = new p.JsonConversationAgentRunRepository(storage, projectId, now);
  const executions = new p.JsonConversationResponseExecutionRepository(storage, projectId);
  const conversationId = d.toConversationId(`conversation-r45-built-${kind}`), sourceId = d.toMessageId(`source-r45-built-${kind}`);
  let conversation = d.createProjectConversation({ id: conversationId, projectId, title: `Synthetic ${kind}`, createdAt });
  await conversations.create(conversation);
  const initialRevision = conversation.revision;
  conversation = d.addUserMessage(conversation, { id: sourceId, content: '只回复一句话，介绍培训流程。', createdAt });
  await conversations.save(conversation, initialRevision);
  const message = conversation.messages.find(item => item.id === sourceId), reference = { kind: 'message', id: sourceId, version: message.revision,
    contentHash: digest([message.content, message.displayContent, message.attachments]) };
  const rootId = d.toConversationAgentRunId(`agent-root-r45-built-${kind}`);
  await runs.create(d.createConversationAgentRun({ id: rootId, projectId, conversationId, sourceMessageId: sourceId, createdAt }));
  await sessions.create(d.createConversationAgentSession({ id: rootId, projectId, conversationId, sourceMessageId: sourceId, createdAt,
    budget: { startedAt: base, deadlineAt: base + 360_000, maxToolCalls: 8, budgetUnits: 24 }, inputReferences: [reference], goalHash: digest(reference),
    initialSegment: { runId: rootId, sourceMessageId: sourceId, inputReferenceHash: digest(reference), status: 'active',
      toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 } }));
  if (kind === 'expired') return { session: await sessions.get(rootId), conversationId };
  const owned = await sessions.acquireLease({ sessionId: rootId, ownerId: 'synthetic-crashed-electron-host', ttlMs: 1_000 });
  if (kind === 'planning_unknown') {
    await sessions.commit({ sessionId: rootId, expectedRevision: owned.session.revision, fence: { ownerId: owned.lease.ownerId, epoch: owned.lease.epoch },
      session: d.updateConversationAgentSession(owned.session, { planningBoundary: 'submitted',
        childSegments: owned.session.childSegments.map(segment => ({ ...segment, planningBoundary: 'submitted' })) }, d.toIsoTimestamp(now())) });
  }
  if (kind === 'paid_unknown') {
    const childId = d.toConversationAgentRunId('agent-child-r45-built-crash'), responseId = d.toConversationResponseExecutionId('response-r45-built-crash');
    let child = d.createConversationAgentRun({ id: childId, parentRunId: rootId, projectId, conversationId, sourceMessageId: sourceId, createdAt });
    await runs.create(child);
    await sessions.beginInitialSegment({ sessionId: rootId, expectedRevision: owned.session.revision,
      fence: { ownerId: owned.lease.ownerId, epoch: owned.lease.epoch }, inputReference: reference,
      segment: { runId: childId, sourceMessageId: sourceId, inputReferenceHash: digest(reference), status: 'active', planningBoundary: 'not_started',
        toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 } });
    const assistantId = d.toMessageId('assistant-r45-built-crash'), previous = conversation;
    conversation = d.beginAssistantMessage(previous, { id: assistantId, createdAt });
    await conversations.save(conversation, previous.revision);
    const response = d.createConversationResponseExecution({ id: responseId, projectId,
      providerInvocationAttemptId: d.toProviderInvocationAttemptId('attempt-r45-built-crash'), createdAt,
      snapshot: { schemaVersion: 1, responseDraftId: d.toConversationResponseDraftId('draft-r45-built-crash'), responseDraftRevision: 1,
        conversationId, conversationRevision: previous.revision, userMessageId: sourceId, userMessageRevision: message.revision,
        assistantMessageId: assistantId, productFeature: 'text_chat', routeSnapshotId: d.toProviderExecutionRouteSnapshotId('route-r45-built-crash'),
        candidate: { schemaVersion: 1, providerId: d.toProviderId('provider-r45-production'), connectionId: d.toConnectionId('connection-r45-production'),
          connectionRevision: 1, modelId: d.toModelId('model-r45-production'), modelRevision: 1, profileId: 'profile-r45-production', profileRevision: 1,
          protocolBindingId: d.toProtocolBindingId('binding-r45-production'), protocolBindingRevision: 1, runtimeSource: 'newapi_gateway' },
        outboundUserTextSnapshot: message.content, contextSnapshots: [] } });
    await executions.create(response, d.createConversationResponseStreamEvent({ id: d.toConversationResponseStreamEventId('event-r45-built-crash'),
      responseExecutionId: responseId, sequence: 1, type: 'execution_created', occurredAt: createdAt }));
    const attached = d.attachConversationAgentRunExecution(child, responseId, createdAt);
    await runs.save(attached, child.revision); child = attached;
    const canonical = new ConversationAgentRuntimeService({ repository: new JsonConversationAgentRuntimeRepository(storage, projectId, now),
      now, nextEventId: () => `built-crash-${randomUUID()}`, hash: value => createHash('sha256').update(value).digest('hex') });
    await canonical.open(child, owned.session.budget);
    await canonical.providerLifecycle(child.id).modelPrepared({ round: 0, requestHash: 'a'.repeat(64), messageCount: 1, toolCount: 0 });
    await canonical.providerLifecycle(child.id).modelStarted({ round: 0 });
  }
  return { session: await sessions.get(rootId), conversationId };
}

module.exports = { providerFixture, textResponse, repositories, seedRoot, projectId, digest, p, d };
