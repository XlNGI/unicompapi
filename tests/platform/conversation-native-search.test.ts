import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationApplicationService } from '../../src/application';
import { createConversationResponseDraft, createConversationWorkflow, toConversationId, toConversationResponseDraftId, toConversationWorkflowId, toIsoTimestamp, toMessageId, toProjectId } from '../../src/domain';
import { JsonProjectConversationRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { ConversationNativeSearch, NativeSearchAuthorizationError } from '../../src/platform/providers/conversation-native-search';
import type { JsonProviderRegistryStore } from '../../src/platform/providers/provider-registry';
import type { ResolvedFeatureCandidateV1 } from '../../src/platform/providers/provider-feature-candidates';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup(packageId = 'provider-package-kimi') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-grant-')); roots.push(root);
  const storage = new NodeProjectStorage(root), projectId = toProjectId('project-native');
  let time = '2026-09-11T00:00:00.000Z', sequence = 0;
  const now = () => time;
  const repo = new JsonProjectConversationRepository(storage, projectId, now);
  const service = new ConversationApplicationService(repo, { nextConversationId: () => toConversationId('conversation-native'), nextMessageId: () => toMessageId(`message-${++sequence}`) }, now);
  const initial = await service.create({ title: '公开新闻', projectId });
  const conversation = await service.addUserMessage({ conversationId: initial.id, expectedRevision: 0, content: '联网查询公开新闻' });
  const workflow = createConversationWorkflow({ id: toConversationWorkflowId('workflow-native'), projectId, conversationId: conversation.id, sourceMessageId: conversation.messages[0].id,
    plan: { schemaVersion: 1, kind: 'chat', sourcePolicy: 'web', parameters: {}, missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false }, createdAt: toIsoTimestamp(now()) });
  const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('draft-native'), projectId, conversationId: conversation.id, conversationRevision: conversation.revision,
    userMessageId: workflow.sourceMessageId, userMessageRevision: 0, promptContent: '联网查询公开新闻', productFeature: 'text_chat', createdAt: toIsoTimestamp(now()) });
  const candidate = { candidateId: 'candidate-native', providerName: 'Kimi', modelName: '模型', routeTemplate: { packageId, endpointPolicyId: 'endpoint.kimi.official', connectionId: 'connection-native', connectionRevision: 1, modelId: 'model-native', modelRevision: 1, profileRevision: 1 } } as unknown as ResolvedFeatureCandidateV1;
  const registry = { load: vi.fn(async () => ({ modelProfiles: [] })) } as unknown as JsonProviderRegistryStore;
  const native = new ConversationNativeSearch(storage, registry, service, now);
  const input = { conversation, workflow, draft, candidate };
  return { native, input, service, registry, storage, repo, now, setTime: (t: string) => { time = t; } };
}
describe('durable conversational native search authorization', () => {
  it('persists a single question, restores it after restart, and only grants the exact reply', async () => {
    const f = await setup();
    await expect(f.native.prepare(f.input)).rejects.toBeInstanceOf(NativeSearchAuthorizationError);
    const question = await f.service.get(f.input.conversation.id);
    expect(question.messages.at(-1)?.content).toContain('是否允许本次联网');
    expect(question.revision).toBe(2);
    const recovered = new ConversationNativeSearch(f.storage, f.registry, f.service, f.now);
    await expect(recovered.prepare({ ...f.input, conversation: question })).rejects.toBeInstanceOf(NativeSearchAuthorizationError);
    expect((await f.service.get(question.id)).revision).toBe(2);
    await expect(recovered.answer({ ...f.input, conversation: question, candidateId: f.input.candidate.candidateId, content: '继续' })).rejects.toThrow();
    await recovered.answer({ ...f.input, conversation: question, candidateId: f.input.candidate.candidateId, content: '允许本次联网' });
    const authorized = await f.service.get(question.id);
    expect(authorized.messages.at(-1)?.content).toContain('已允许本次联网');
    await recovered.prepare({ ...f.input, conversation: authorized });
    const grant = await recovered.dispatch(f.input.draft, f.input.candidate);
    expect(grant).toMatchObject({ protocol: 'kimi_builtin', mode: 'auto' });
    expect(await recovered.dispatch(f.input.draft, f.input.candidate)).toBeUndefined();
  });
  it('rejects stale conversation, different model, quoted consent, and expired questions', async () => {
    const f = await setup(); await expect(f.native.prepare(f.input)).rejects.toThrow();
    const conversation = await f.service.get(f.input.conversation.id);
    const answer = { workflow: f.input.workflow, conversation, candidateId: f.input.candidate.candidateId, content: '允许本次联网' };
    await expect(f.native.answer({ ...answer, content: '他说“允许本次联网”' })).rejects.toThrow();
    await expect(f.native.answer({ ...answer, candidateId: 'different' })).rejects.toThrow();
    await expect(f.native.answer({ ...answer, conversation: f.input.conversation })).rejects.toThrow();
    f.setTime('2026-09-11T00:11:00.000Z');
    await expect(f.native.answer(answer)).rejects.toThrow();
    expect((await f.service.get(conversation.id)).revision).toBe(2);
  });
  it('does not infer gateway support from the model name and persists the honest explanation', async () => {
    const f = await setup('provider-package-newapi');
    await expect(f.native.prepare(f.input)).rejects.toThrow();
    expect((await f.service.get(f.input.conversation.id)).messages.at(-1)?.content).toContain('尚无可用');
    expect(await f.native.dispatch(f.input.draft, f.input.candidate)).toBeUndefined();
  });
  it('invalidates a grant when the outbound prompt changes', async () => {
    const f = await setup(); await expect(f.native.prepare(f.input)).rejects.toThrow();
    const conversation = await f.service.get(f.input.conversation.id);
    await f.native.answer({ workflow: f.input.workflow, conversation, candidateId: f.input.candidate.candidateId, content: '允许本次联网' });
    await expect(f.native.dispatch({ ...f.input.draft, promptContent: 'new private scope' }, f.input.candidate)).rejects.toThrow();
  });
  it('reuses conversation authorization only for the same route and revokes it on request', async () => {
    const f = await setup(); await expect(f.native.prepare(f.input)).rejects.toThrow();
    const question = await f.service.get(f.input.conversation.id);
    await f.native.answer({ workflow: f.input.workflow, conversation: question, candidateId: f.input.candidate.candidateId, content: '允许本会话联网' });
    expect(await f.native.allowsConversation(question.id)).toBe(true);
    const conversation = await f.service.addUserMessage({ conversationId: question.id, expectedRevision: (await f.service.get(question.id)).revision, content: '再查公开天气' });
    const workflow = { ...f.input.workflow, id: toConversationWorkflowId('workflow-next'), sourceMessageId: conversation.messages.at(-1)!.id };
    const draft = { ...f.input.draft, userMessageId: workflow.sourceMessageId, promptContent: '再查公开天气' };
    await f.native.prepare({ ...f.input, conversation, workflow, draft });
    const grant = await f.native.dispatch(draft, f.input.candidate);
    expect(grant?.protocol).toBe('kimi_builtin');
    await f.native.revoke(question.id);
    expect(await f.native.allowsConversation(question.id)).toBe(false);
  });
  it('does not restore revoked conversation permission when a late provider event arrives', async () => {
    const f = await setup(); await expect(f.native.prepare(f.input)).rejects.toThrow();
    const conversation = await f.service.get(f.input.conversation.id);
    await f.native.answer({ workflow: f.input.workflow, conversation, candidateId: f.input.candidate.candidateId, content: '允许本会话联网' });
    const grant = await f.native.dispatch(f.input.draft, f.input.candidate);
    await f.native.revoke(conversation.id);
    await f.native.observe(grant!.grantId, { status: 'started', toolCalls: 1, cost: 'not_reported', retrievedAt: f.now(), sources: [] });
    expect(await f.native.allowsConversation(conversation.id)).toBe(false);
    await f.native.observe(grant!.grantId, { status: 'completed', toolCalls: 1, cost: 'not_reported', retrievedAt: f.now(), sources: [] });
    expect(await f.native.allowsConversation(conversation.id)).toBe(false);
  });
  it('preserves concurrent conversation writes while projecting a search event', async () => {
    const f = await setup(); await expect(f.native.prepare(f.input)).rejects.toThrow();
    const question = await f.service.get(f.input.conversation.id);
    await f.native.answer({ workflow: f.input.workflow, conversation: question, candidateId: f.input.candidate.candidateId, content: '允许本次联网' });
    const grant = await f.native.dispatch(f.input.draft, f.input.candidate);
    const save = f.repo.save.bind(f.repo);
    let raced = false;
    vi.spyOn(f.repo, 'save').mockImplementation(async (conversation, expectedRevision) => {
      if (!raced && conversation.messages.at(-1)?.workflowReply?.workflowId.endsWith('-started')) {
        raced = true;
        await f.service.addUserMessage({ conversationId: question.id, expectedRevision: expectedRevision!, content: '请保持简洁' });
      }
      return save(conversation, expectedRevision);
    });
    await f.native.observe(grant!.grantId, { status: 'started', toolCalls: 1, cost: 'not_reported', retrievedAt: f.now(), sources: [] });
    const current = await f.service.get(question.id);
    expect(current.messages.some(m => m.content === '请保持简洁')).toBe(true);
    expect(current.messages.filter(m => m.workflowReply?.workflowId.endsWith('-started'))).toHaveLength(1);
  });
  it('preserves local-first behavior without creating a network authorization', async () => {
    const f = await setup();
    const local = { retrieve: vi.fn(async () => [{ text: '本地结果' }]) };
    const native = new ConversationNativeSearch(f.storage, f.registry, f.service, f.now, local);
    await native.prepare({ ...f.input, workflow: { ...f.input.workflow, plan: { ...f.input.workflow.plan, sourcePolicy: 'mixed' } } });
    expect((await f.service.get(f.input.conversation.id)).revision).toBe(1);
    expect(await native.dispatch(f.input.draft, f.input.candidate)).toBeUndefined();
  });

});
