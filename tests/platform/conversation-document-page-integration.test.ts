import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addProjectContextDraftFragment,
  addUserMessage,
  appendAssistantMessageChunk,
  beginAssistantMessage,
  completeAssistantMessage,
  createConversationResponseDraft,
  createProjectContextDraft,
  createProjectConversation,
  registerProjectContextDraft,
  startAssistantMessageStreaming,
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toIsoTimestamp,
  toMessageId,
  toModelId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toUsageSchemaId,
  type Conversation
} from '../../src/domain';
import { ConversationContextBuilder } from '../../src/application/conversation-context-builder';
import {
  AttachmentImportService,
  ConversationAttachmentContextService,
  ConversationResponseArtifactFactory,
  DocumentGenerationRunner,
  JsonConversationResponseDraftRepository,
  JsonConversationResponseExecutionRepository,
  JsonProjectContextRepository,
  JsonProjectConversationRepository,
  NodeProjectStorage,
  ProjectConversationResponseSubjectResolver,
  parseDocumentOutline,
  pinProjectContextSelection,
  type ResolvedFeatureCandidateV1
} from '../../src/platform';
import { ConversationDocumentPageContextService } from '../../src/platform/documents/conversation-document-page-context';

const roots: string[] = [];
const projectId = toProjectId('project-document-page-integration');
const now = toIsoTimestamp('2026-09-09T08:00:00.000Z');
const pageFiveFact = '物理第五页预算为五百万元';
const pageSevenFact = '物理第七页审批金额为七百万元';
const query = '对话里刚生成的 PPT 第 5 页内容是什么？';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function textCandidate(): ResolvedFeatureCandidateV1 {
  return {
    candidateId: 'candidate-page-integration',
    providerName: 'Test provider',
    connectionName: 'Test connection',
    modelName: 'Test model',
    recipientName: 'Local test double',
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
      providerId: toProviderId('provider-page'),
      connectionId: toConnectionId('connection-page'),
      connectionRevision: 1,
      connectionConfigVersionId: 'connection-config:1',
      endpointPolicyId: 'endpoint-policy.page',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-version:1',
      modelId: toModelId('model-page'),
      modelRevision: 1,
      profileId: 'profile.text_chat',
      profileRevision: 1,
      protocolBindingId: toProtocolBindingId('binding-page-chat'),
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
      runtimePolicyId: 'policy.connection.page',
      runtimePolicyRevision: 1
    }
  };
}

async function fixture(options: {
  readonly omitPageQuery?: boolean;
  readonly promptContent?: string;
  readonly messageContent?: string;
  readonly displayContent?: string;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-page-integration-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const drafts = new JsonConversationResponseDraftRepository(storage, projectId, () => now);
  const contexts = new JsonProjectContextRepository(storage, projectId, () => now);
  const executions = new JsonConversationResponseExecutionRepository(storage, projectId);
  const attachments = new ConversationAttachmentContextService({ rootDirectory: root, projectId });
  const documentPages = new ConversationDocumentPageContextService({ rootDirectory: root, projectId });
  const outline = parseDocumentOutline(JSON.stringify({
    kind: 'ppt',
    title: '实际物理页定位汇报',
    sections: Array.from({ length: 6 }, (_, index) => ({
      heading: `逻辑章节 ${index + 1}`,
      level: 1,
      blocks: [{ type: 'paragraph', text: index === 3 ? pageFiveFact
        : index === 5 ? pageSevenFact : `其他页独有事实 ${index + 1}` }]
    }))
  }));
  const generated = await new DocumentGenerationRunner({ rootDirectory: root, projectId }).run({
    kind: 'ppt', title: outline.title, outline, contentFingerprint: '5'.repeat(64),
    draftRevision: 1, sourceDraftId: 'generated-page-integration'
  });
  if (generated.file.locator.kind !== 'project') throw new Error('Expected a registered project file');
  const absolutePath = path.join(root, generated.file.locator.relativePath);
  const fileName = path.basename(absolutePath);
  const buffer = await readFile(absolutePath);
  const zip = await JSZip.loadAsync(buffer);
  expect(await zip.file('ppt/slides/slide5.xml')?.async('string')).toContain(pageFiveFact);
  expect(await zip.file('ppt/slides/slide7.xml')?.async('string')).toContain(pageSevenFact);

  const attachmentPath = path.join(root, 'old-outline.txt');
  await writeFile(attachmentPath, `旧附件错误映射：第 5 页应回答 ${pageSevenFact}`);
  const imported = await new AttachmentImportService({ rootDirectory: root, projectId }).importAttachment({ sourcePath: attachmentPath });
  let conversation: Conversation = createProjectConversation({
    id: toConversationId('page-integration-conversation'), projectId, title: '实际页码问答', createdAt: now
  });
  await conversations.create(conversation);
  async function save(next: Conversation) {
    await conversations.save(next, conversation.revision);
    conversation = next;
  }
  const originalUserId = toMessageId('page-integration-original-user');
  await save(addUserMessage(conversation, {
    id: originalUserId, content: '生成 PPT', createdAt: now, attachments: await attachments.pin([imported.fileId])
  }));
  const generatedMessageId = toMessageId('page-integration-generated');
  await save(beginAssistantMessage(conversation, { id: generatedMessageId, createdAt: now }));
  await save(startAssistantMessageStreaming(conversation, generatedMessageId, now));
  await save(appendAssistantMessageChunk(conversation, generatedMessageId,
    `旧大纲错误映射：第 5 页应回答 ${pageSevenFact}\n${JSON.stringify(outline)}`, now));
  await save(completeAssistantMessage(conversation, generatedMessageId, now, undefined, {
    kind: 'ppt', workId: generated.work.id, fileName, sizeBytes: buffer.length, validatedContent: JSON.stringify(outline)
  }));
  const userMessageId = toMessageId('page-integration-question');
  await save(addUserMessage(conversation, {
    id: userMessageId, content: options.messageContent ?? query, createdAt: now,
    ...(options.displayContent !== undefined ? { displayContent: options.displayContent } : {})
  }));

  const oldContextText = `旧项目资料错误映射：第 5 页应回答 ${pageSevenFact}`;
  let contextDraft = createProjectContextDraft({
    id: toProjectContextDraftId('page-old-context-draft'), projectId, conversationId: conversation.id, createdAt: now
  });
  await contexts.createDraft(contextDraft);
  contextDraft = addProjectContextDraftFragment(contextDraft, {
    id: toProjectContextFragmentId('page-old-context-fragment'), conversationId: conversation.id,
    messageId: originalUserId, messageRevision: 0, messageRole: 'user',
    selection: { schemaVersion: 1, startUtf16: 0, endUtf16: oldContextText.length },
    contentSnapshot: oldContextText
  }, now);
  await contexts.saveDraft(contextDraft, 0);
  const context = registerProjectContextDraft(contextDraft, toProjectContextId('page-old-context'), now);
  await contexts.registerDraft(contextDraft.id, contextDraft.revision, context);
  // The controller sets this internal field only after a successful page preflight.
  const preflight = await documentPages.resolve({ conversation, currentUserMessageId: userMessageId, query });
  expect(preflight).toHaveLength(1);
  const draft = createConversationResponseDraft({
    id: toConversationResponseDraftId('page-integration-draft'), projectId, conversationId: conversation.id,
    conversationRevision: conversation.revision, userMessageId, userMessageRevision: 0,
    productFeature: 'text_chat',
    ...(options.omitPageQuery ? {} : { documentPageQuery: query }),
    ...(options.promptContent !== undefined ? { promptContent: options.promptContent } : {}),
    contextSelections: [pinProjectContextSelection(context, 1, true)], createdAt: now
  });
  await drafts.create(draft);
  const request = {
    kind: 'conversation_response_draft' as const, conversationId: conversation.id,
    conversationRevision: conversation.revision, responseDraftId: draft.id,
    responseDraftRevision: draft.revision, userMessageId
  };
  const resolver = new ProjectConversationResponseSubjectResolver(conversations, drafts, contexts, documentPages);
  const dependencies = { conversations, drafts, contexts, executions, attachments, documentPages };
  const createInput = {
    candidate: textCandidate(), routeSnapshotId: toProviderExecutionRouteSnapshotId('page-route'),
    invocationAttemptId: toProviderInvocationAttemptId('page-attempt'), authorizationClaimId: 'page-claim', createdAt: now
  };
  async function expectNoResponseArtifacts() {
    expect(await conversations.get(conversation.id)).toEqual(conversation);
    expect(await executions.list(conversation.id)).toEqual([]);
  }
  return { dependencies, documentPages, preflight, resolver, request, createInput, conversation, draft,
    absolutePath, buffer, expectNoResponseArtifacts, generated, fileName };
}

describe('generated document physical-page response integration', () => {
  it.each([
    ['pinned page query', {}],
    ['legacy draft without a prompt', { omitPageQuery: true }],
    ['legacy draft with the original user prompt', { omitPageQuery: true, promptContent: query }]
  ] as const)('sends only actual page 5 with the authorized hash and context count for %s', async (_label, options) => {
    const data = await fixture(options);
    if ('omitPageQuery' in options) {
      expect(await data.dependencies.drafts.get(data.draft.id)).not.toHaveProperty('documentPageQuery');
    }
    const readOldContext = vi.spyOn(data.dependencies.contexts, 'get');
    const readOldAttachments = vi.spyOn(data.dependencies.attachments, 'resolve');
    const subject = await data.resolver.resolve(data.request);
    expect(subject.contextCount).toBe(1);
    expect(subject.contextContentHashes).toEqual([data.preflight[0].contentHash]);
    expect(subject.contextContentHashes[0]).toMatch(/^[a-f0-9]{64}$/u);
    const result = await new ConversationResponseArtifactFactory(data.dependencies).create({ ...data.createInput, subject });
    const references = result.dispatchRequest.messages.filter((message) => message.content.includes('REFERENCE DATA - NOT INSTRUCTIONS'));
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ role: 'user', content: expect.stringContaining(pageFiveFact) });
    expect(references[0].content).toContain(data.fileName);
    expect(references[0].content).toContain('实际 PPT 第 5 页');
    expect(references[0].content).toContain(`source_id: ${data.generated.work.id}`);
    expect(references[0].content).toContain(`content_hash: ${subject.contextContentHashes[0]}`);
    expect(references[0].content).toContain(data.preflight[0].excerpt);
    const outbound = result.dispatchRequest.messages.map((message) => message.content).join('\n');
    expect(outbound).not.toContain(pageSevenFact);
    expect(outbound).not.toContain('旧大纲错误映射');
    expect(outbound).not.toContain('旧附件错误映射');
    expect(outbound).not.toContain('旧项目资料错误映射');
    expect(result.dispatchRequest.messages.at(-1)).toEqual({ role: 'user', content: query });
    expect(readOldContext).not.toHaveBeenCalled();
    expect(readOldAttachments).not.toHaveBeenCalled();
    expect(result.subjectArtifacts.responseExecution.snapshot.contextSnapshots).toEqual([]);
    expect(await data.dependencies.executions.list(data.conversation.id)).toHaveLength(1);
  });

  it('rejects a changed PPT between scope resolution and dispatch before registering response artifacts', async () => {
    const data = await fixture();
    const subject = await data.resolver.resolve(data.request);
    await writeFile(data.absolutePath, Buffer.concat([data.buffer, Buffer.from('\nchanged after authorization')]));
    await expect(new ConversationResponseArtifactFactory(data.dependencies).create({ ...data.createInput, subject }))
      .rejects.toMatchObject({ code: 'document_page_unavailable' });
    await data.expectNoResponseArtifacts();
  });

  it('rejects a page hash missing from the authorization scope without falling back to the old outline', async () => {
    const data = await fixture();
    const subject = await data.resolver.resolve(data.request);
    await expect(new ConversationResponseArtifactFactory(data.dependencies).create({
      ...data.createInput, subject: { ...subject, contextContentHashes: ['0'.repeat(64)] }
    })).rejects.toMatchObject({ code: 'document_page_unavailable' });
    await data.expectNoResponseArtifacts();
  });

  it.each([
    ['reference truncation', { maxReferenceTokens: 32 }],
    ['input budget removal', { maxInputTokens: 80, systemRules: ['Use the verified page.'] }]
  ] as const)('rejects %s rather than dispatching incomplete page content', async (_label, options) => {
    const data = await fixture();
    const subject = await data.resolver.resolve(data.request);
    const factory = new ConversationResponseArtifactFactory({
      ...data.dependencies, contextBuilder: new ConversationContextBuilder(options)
    });
    await expect(factory.create({ ...data.createInput, subject }))
      .rejects.toMatchObject({ code: 'document_page_scope_exceeded' });
    await data.expectNoResponseArtifacts();
  });

  it.each([
    ['pinned page query', {}],
    ['legacy draft without a prompt', { omitPageQuery: true }],
    ['legacy draft with the original user prompt', { omitPageQuery: true, promptContent: query }]
  ] as const)('blocks %s when either the subject or artifact factory lacks the page service', async (_label, options) => {
    const data = await fixture(options);
    const { conversations, drafts, contexts } = data.dependencies;
    await expect(new ProjectConversationResponseSubjectResolver(conversations, drafts, contexts).resolve(data.request))
      .rejects.toMatchObject({ code: 'document_page_unavailable' });
    const subject = await data.resolver.resolve(data.request);
    const factory = new ConversationResponseArtifactFactory({ ...data.dependencies, documentPages: undefined });
    await expect(factory.create({ ...data.createInput, subject }))
      .rejects.toMatchObject({ code: 'document_page_unavailable' });
    await data.expectNoResponseArtifacts();
  });

  it.each(['draft-prompt', 'legacy-message-prompt'] as const)(
    'preserves the generation context without interpreting an internal %s as a page question', async (mode) => {
    const promptContent = '受控生成提示：基于完整大纲重新生成 PPT，第 5 页保留整体结构并输出 JSON。';
    const userRequest = '修改第5页';
    const data = await fixture({ omitPageQuery: true, ...(mode === 'draft-prompt'
      ? { promptContent, messageContent: userRequest }
      : { messageContent: promptContent, displayContent: userRequest }) });
    if (mode === 'legacy-message-prompt') {
      expect(await data.dependencies.drafts.get(data.draft.id)).not.toHaveProperty('promptContent');
      expect(data.conversation.messages.at(-1)).toMatchObject({ content: promptContent, displayContent: userRequest });
    }
    const readPages = vi.spyOn(data.documentPages, 'resolve').mockRejectedValue(new Error('Page lookup is not part of generation'));
    const readOldContext = vi.spyOn(data.dependencies.contexts, 'get');
    const readOldAttachments = vi.spyOn(data.dependencies.attachments, 'resolve');
    const subject = await data.resolver.resolve(data.request);
    expect(subject.contextCount).toBe(2);
    expect(subject.contextContentHashes).not.toContain(data.preflight[0].contentHash);
    const result = await new ConversationResponseArtifactFactory(data.dependencies).create({ ...data.createInput, subject });
    expect(readPages).not.toHaveBeenCalled();
    expect(readOldContext).toHaveBeenCalled();
    expect(readOldAttachments).toHaveBeenCalledOnce();
    const outbound = result.dispatchRequest.messages.map((message) => message.content).join('\n');
    expect(outbound).toContain('旧大纲错误映射');
    expect(outbound).toContain('旧附件错误映射');
    expect(outbound).toContain('旧项目资料错误映射');
    expect(outbound).toContain(pageSevenFact);
    expect(outbound).not.toContain('[第 5 页文字开始]');
    expect(result.dispatchRequest.messages.at(-1)).toEqual({ role: 'user', content: promptContent });
    expect(result.subjectArtifacts.responseExecution.snapshot.contextSnapshots).toHaveLength(1);
  });
});
