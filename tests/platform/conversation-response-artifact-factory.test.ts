import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addUserMessage,
  createConversationResponseDraft,
  createProjectConversation,
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toIsoTimestamp,
  toMessageId,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toUsageSchemaId
} from '../../src/domain';
import {
  ConversationResponseArtifactFactory,
  JsonConversationResponseDraftRepository,
  JsonConversationResponseExecutionRepository,
  JsonProjectContextRepository,
  JsonProjectConversationRepository,
  NodeProjectStorage,
  type ResolvedFeatureCandidateV1
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-response-artifacts');
const t0 = toIsoTimestamp('2026-08-05T14:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-05T14:01:00.000Z');
const assistantMessageId = toMessageId('message-assistant-artifact');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function textCandidate(): ResolvedFeatureCandidateV1 {
  return {
    candidateId: 'candidate-artifact',
    providerName: 'DeepSeek',
    connectionName: 'hhh',
    modelName: 'deepseek-v4-flash',
    recipientName: 'DeepSeek / hhh',
    outboundScope: 'external_service',
    contentCategories: ['conversation_text'],
    parameterSchema: {
      schemaVersion: 2,
      schemaId: 'parameter-schema.text_chat',
      revision: 1,
      productFeature: 'text_chat',
      fields: []
    },
    usageSchema: { schemaId: 'usage-schema.text_chat', revision: 1 },
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
      packageId: 'provider-package-deepseek',
      packageVersion: '1.0.0',
      adapterKey: 'deepseek.chat',
      adapterVersion: '1.0.0',
      providerId: toProviderId('provider-deepseek'),
      connectionId: toConnectionId('connection-deepseek'),
      connectionRevision: 1,
      connectionConfigVersionId: 'connection-config:1',
      endpointPolicyId: 'endpoint-policy.deepseek',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-version:1',
      modelId: toModelId('model-deepseek'),
      modelRevision: 1,
      profileId: 'profile.text_chat',
      profileRevision: 1,
      protocolBindingId: toProtocolBindingId('binding-deepseek-chat'),
      protocolBindingRevision: 1,
      productFeature: 'text_chat',
      internalPurpose: 'text_execution',
      featureMappingVersion: 1,
      parameterSchemaId: 'parameter-schema.text_chat',
      parameterSchemaRevision: 1,
      resultSchemaId: 'result-schema.text_chat',
      resultSchemaRevision: 1,
      usageSchemaId: toUsageSchemaId('usage-schema.text_chat'),
      usageSchemaRevision: 1,
      constraintSetId: 'constraint-set.text_chat',
      constraintSetRevision: 1,
      runtimePolicyId: 'policy.connection.connection-deepseek',
      runtimePolicyRevision: 1
    }
  };
}

describe('ConversationResponseArtifactFactory', () => {
  it('persists pending then streaming assistant turns without revision double-bump', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-response-artifacts-'));
    roots.push(root);
    const storage = new NodeProjectStorage(root);
    const conversations = new JsonProjectConversationRepository(storage, projectId, () => t1);
    const drafts = new JsonConversationResponseDraftRepository(storage, projectId, () => t1);
    const contexts = new JsonProjectContextRepository(storage, projectId, () => t1);
    const executions = new JsonConversationResponseExecutionRepository(storage, projectId);

    let conversation = createProjectConversation({
      id: toConversationId('conversation-artifact'),
      projectId,
      title: 'artifact',
      createdAt: t0
    });
    await conversations.create(conversation);
    const userMessageId = toMessageId('message-user-artifact');
    const withUser = addUserMessage(conversation, {
      id: userMessageId,
      content: 'hello',
      createdAt: t0
    });
    await conversations.save(withUser, conversation.revision);
    conversation = withUser;

    const draft = createConversationResponseDraft({
      id: toConversationResponseDraftId('response-draft-artifact'),
      projectId,
      conversationId: conversation.id,
      conversationRevision: conversation.revision,
      userMessageId,
      userMessageRevision: 0,
      productFeature: 'text_chat',
      createdAt: t0
    });
    await drafts.create(draft);

    const factory = new ConversationResponseArtifactFactory({
      conversations,
      drafts,
      contexts,
      executions,
      nextMessageId: () => assistantMessageId,
      nextExecutionId: () => 'response-execution-artifact',
      nextStreamEventId: () => 'response-stream-artifact',
      now: () => t1
    });

    const created = await factory.create({
      subject: {
        projectId,
        subject: {
          kind: 'conversation_response_draft',
          conversationId: conversation.id,
          conversationRevision: conversation.revision,
          responseDraftId: draft.id,
          responseDraftRevision: draft.revision,
          userMessageId
        },
        productFeature: 'text_chat',
        surface: 'conversation',
        imageCount: 0,
        videoCount: 0,
        contextCount: 0,
        parameterValues: {},
        outboundTextSnapshot: 'hello',
        materialReferences: [],
        contextContentHashes: []
      },
      candidate: textCandidate(),
      routeSnapshotId: toProviderExecutionRouteSnapshotId('route-artifact'),
      invocationAttemptId: toProviderInvocationAttemptId('attempt-artifact'),
      authorizationClaimId: 'claim-artifact',
      createdAt: t1
    });

    expect(created.subjectArtifacts.kind).toBe('conversation');
    const saved = await conversations.get(conversation.id);
    expect(saved?.revision).toBe(conversation.revision + 2);
    expect(saved?.messages.find((message) => message.id === assistantMessageId)).toMatchObject({
      role: 'assistant',
      state: 'streaming'
    });
    if (created.subjectArtifacts.kind !== 'conversation') {
      throw new Error('expected conversation artifacts');
    }
    expect(created.subjectArtifacts.responseExecution.id).toBe('response-execution-artifact');
  });
});
