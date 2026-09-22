import { createHash, randomUUID } from 'node:crypto';
import type { Conversation, ConversationResponseDraftV1, ConversationWorkflowV1, ProviderExecutionRouteSnapshotV1 } from '../../domain';
import type { ConversationApplicationService } from '../../application';
import { parseNativeSearchRequest, type NativeSearchCapability, type NativeSearchEvidence, type NativeSearchRequest } from '../../domain/entities/native-search';
import type { ResolvedFeatureCandidateV1 } from './provider-feature-candidates';
import type { JsonProviderRegistryStore } from './provider-registry';
import { toProjectRelativePath, type ProjectStorageAdapter } from '../storage';
import { ConversationRevisionConflictError } from '../repositories/json-conversation-repository';
import { KIMI_PROVIDER_PACKAGE_ID } from './kimi/kimi-contracts';
import { emitProductionEvent } from '../conversation-production-trace';

const file = toProjectRelativePath('entities/conversation-native-search.json');
interface SearchSession {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly candidateId: string;
  readonly bindingHash: string;
  readonly promptHash: string;
  readonly optionsHash: string;
  readonly routeHash: string;
  readonly protocol: NativeSearchRequest['protocol'];
  readonly mode: 'auto' | 'required';
  readonly expiresAt: string;
  readonly status: 'authorization_required' | 'authorized' | 'declined' | 'submitted' | 'completed' | 'failed' | 'cancelled';
  readonly expectedConversationRevision: number;
  readonly evidence?: NativeSearchEvidence;
  readonly authorizationScope?: 'request' | 'conversation';
  readonly grantedAt?: string;
}
export class NativeSearchAuthorizationError extends Error {
  readonly code = 'native_search_authorization_required';
}
/** Durable grant ledger. Only the exact pending assistant question can grant a single request. */
export class ConversationNativeSearch {
  private pending: Promise<unknown> = Promise.resolve();
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  constructor(private readonly storage: ProjectStorageAdapter, private readonly registry: JsonProviderRegistryStore,
    private readonly conversations: ConversationApplicationService, private readonly now = () => new Date().toISOString(),
    private readonly local?: { retrieve(input: { query: string; k: number }): Promise<readonly unknown[]> }) {}

  preferLocal(conversation: Conversation, workflow: ConversationWorkflowV1): Promise<boolean> {
    return this.exclusive(() => this.preferLocalInternal(conversation, workflow));
  }
  private async preferLocalInternal(conversation: Conversation, workflow: ConversationWorkflowV1): Promise<boolean> {
    if (workflow.plan.sourcePolicy !== 'mixed' || !this.local || !(await this.local.retrieve({
      query: conversation.messages.find(m => m.id === workflow.sourceMessageId)?.content ?? '', k: 3
    }).catch(() => [])).length) return false;
    for (const session of await this.load()) if (session.workflowId === workflow.id && session.status === 'authorized') {
      await this.put({ ...session, status: 'declined' });
    }
    return true;
  }

  prepare(input: Parameters<ConversationNativeSearch['prepareInternal']>[0]): Promise<'local' | 'native'> { return this.exclusive(() => this.prepareInternal(input)); }
  private async prepareInternal(input: { conversation: Conversation; workflow: ConversationWorkflowV1; draft: ConversationResponseDraftV1; candidate: ResolvedFeatureCandidateV1 }): Promise<'local' | 'native'> {
    const { conversation, workflow, draft, candidate } = input;
    if (await this.preferLocalInternal(conversation, workflow)) return 'local';
    const capability = await this.capability(candidate);
    const bindingHash = hash([workflow.id, workflow.revision, workflow.plan, routeIdentity(candidate.routeTemplate), draft.promptContent,
      draft.parameterValues, draft.contextSelections, conversation.messages.filter(m => (m.attachments?.length ?? 0) > 0).map(m => m.attachments)]);
    const sessions = await this.load();
    const old = [...sessions].reverse().find(s => s.workflowId === workflow.id);
    const reusable = [...sessions].reverse().find(s => s.conversationId === conversation.id && s.authorizationScope === 'conversation' && s.status !== 'declined' && s.expiresAt > this.now() && s.routeHash === hash(routeIdentity(candidate.routeTemplate)));
    if (old?.bindingHash === bindingHash && old.status === 'authorized' && old.expiresAt > this.now()) return 'native';
    if (old?.bindingHash === bindingHash && old.status === 'authorization_required' && old.expiresAt > this.now()) {
      const restored = await this.conversations.get(conversation.id);
      if (restored.messages.at(-1)?.workflowReply?.workflowId === old.id) {
        if (old.expectedConversationRevision !== restored.revision) await this.put({ ...old, expectedConversationRevision: restored.revision });
        throw new NativeSearchAuthorizationError();
      }
    }
    const key = `native-unavailable-${hash([workflow.id, workflow.revision, candidate.candidateId]).slice(0, 32)}`;
    if (!capability || !['declared', 'verified', 'limited'].includes(capability.state)) {
      await this.reply(conversation.id, key,
        '这项需求涉及公开或时效信息，但当前连接尚无可用的模型原生联网搜索协议证据，因此没有发起搜索。可到“模型与服务商→文本模型→联网搜索设置”检查协议及服务商支持文档；保存配置不代表服务商实际支持。请切换有搜索协议支持依据的模型，或告诉我“不要联网”，按现有资料继续。');
      throw new NativeSearchAuthorizationError();
    }
    // Native services can derive queries from every supplied context. Keep this first scope exact.
    if (draft.contextSelections.some(s => s.includeInPrompt) || conversation.messages.some(m => (m.attachments?.length ?? 0) > 0) || draft.documentPageQuery || draft.imageQuery) {
      await this.reply(conversation.id, `${key}-scope`,
        '这次请求包含附件或项目资料，尚未取得把这些内容交给搜索服务的授权。请在不含内部资料的新会话查询公开信息，或回复“不要联网”继续使用现有资料。');
      throw new NativeSearchAuthorizationError();
    }
    if (/(?:联网|搜索)(?:费用|预算).*(?:不超过|最多)|(?:仅限|只搜索|只检索).*(?:域名|网站)/u.test(draft.promptContent ?? '')) {
      await this.reply(conversation.id, `${key}-limit`, '当前协议无法强制执行指定的搜索域名或费用上限，因此未联网。请调整检索限制或选择不联网。');
      throw new NativeSearchAuthorizationError();
    }
    const id = `native-${randomUUID()}`;
    const promptHash = hash(draft.promptContent);
    let session: SearchSession = {
      id, workflowId: workflow.id, workflowRevision: workflow.revision, conversationId: conversation.id, userMessageId: draft.userMessageId,
      candidateId: candidate.candidateId, bindingHash, promptHash, optionsHash: hash([draft.parameterValues, draft.contextSelections, draft.userMessageRevision]), routeHash: hash(routeIdentity(candidate.routeTemplate)), protocol: capability.protocol,
      mode: /必须.*(?:联网|搜索)|务必.*(?:联网|搜索)/u.test(conversation.messages.find(m => m.id === workflow.sourceMessageId)?.content ?? '') ? 'required' : 'auto',
      expiresAt: new Date(Date.parse(this.now()) + 10 * 60_000).toISOString(), status: 'authorization_required', expectedConversationRevision: conversation.revision
    };
    if (reusable) {
      await this.put({ ...session, status: 'authorized', authorizationScope: 'conversation', grantedAt: reusable.grantedAt, expiresAt: reusable.expiresAt });
      return 'native';
    }
    await this.put(session);
    const updated = await this.reply(conversation.id, id,
      `这项需求涉及公开或时效信息，联网检索可以补充并核实资料。是否允许本次联网？将由 ${candidate.providerName} 的 ${candidate.modelName} 根据当前任务内容及格式要求自行决定是否搜索，不发送历史对话。搜索可能另行收费，具体费用未报告；服务端查询次数、域名和费用上限无法保证，客户端最多继续 2 轮，取消后上游仍可能计费。请回复“允许本次联网”或“不要联网”。也可以回复“允许本会话联网”，授权当前连接在一小时内使用本会话后续任务正文自动搜索（仍不含附件、项目资料和历史对话）。`);
    session = { ...session, expectedConversationRevision: updated.revision };
    await this.put(session);
    throw new NativeSearchAuthorizationError();
  }
  answer(input: Parameters<ConversationNativeSearch['answerInternal']>[0]): Promise<'authorized' | 'declined'> { return this.exclusive(() => this.answerInternal(input)); }
  private async answerInternal(input: { workflow: ConversationWorkflowV1; conversation: Conversation; candidateId: string; content: string }): Promise<'authorized' | 'declined'> {
    const { workflow, conversation } = input;
    const session = (await this.load()).reverse().find(s => s.workflowId === workflow.id);
    const content = input.content.trim().replace(/[。！!]/gu, '');
    const accept = content === '允许本次联网' || content === '允许本会话联网';
    if (!accept && content !== '不要联网') throw new TypeError('请明确回复“允许本次联网”或“不要联网”。');
    if (!session || session.status !== 'authorization_required' || session.expiresAt <= this.now() ||
        session.workflowRevision !== workflow.revision || session.candidateId !== input.candidateId ||
        session.conversationId !== conversation.id || session.expectedConversationRevision !== conversation.revision ||
        conversation.messages.at(-1)?.workflowReply?.workflowId !== session.id) throw new TypeError('联网授权问题已变化，请重新准备当前请求。');
    const user = await this.conversations.addUserMessage({ conversationId: conversation.id, expectedRevision: conversation.revision, content });
    const status = accept ? 'authorized' : 'declined';
    await this.put({ ...session, status, grantedAt: this.now(), authorizationScope: content === '允许本会话联网' ? 'conversation' : 'request',
      expiresAt: content === '允许本会话联网' ? new Date(Date.parse(this.now()) + 60 * 60_000).toISOString() : session.expiresAt, expectedConversationRevision: user.revision });
    await this.reply(conversation.id, `${session.id}-answer`, accept
      ? (content === '允许本会话联网' ? '已允许本会话在一小时内使用当前连接自动搜索，可随时回复“不要联网”撤销。' : '已允许本次联网。模型会自行决定是否搜索；只有收到协议返回的搜索事实，才会标记为已搜索。')
      : '本次不联网。可以使用现有资料继续，涉及最新信息的部分将无法联网核实。');
    return status;
  }
  dispatch(draft: ConversationResponseDraftV1, candidate: ResolvedFeatureCandidateV1): Promise<NativeSearchRequest | undefined> { return this.exclusive(() => this.dispatchInternal(draft, candidate)); }
  private async dispatchInternal(draft: ConversationResponseDraftV1, candidate: ResolvedFeatureCandidateV1): Promise<NativeSearchRequest | undefined> {
    const session = (await this.load()).reverse().find(s => s.conversationId === draft.conversationId && s.userMessageId === draft.userMessageId);
    if (!session || session.status !== 'authorized') return;
    if (session.expiresAt <= this.now() || session.promptHash !== hash(draft.promptContent) || session.optionsHash !== hash([draft.parameterValues, draft.contextSelections, draft.userMessageRevision]) || session.routeHash !== hash(routeIdentity(candidate.routeTemplate))) {
      throw new NativeSearchAuthorizationError();
    }
    await this.put({ ...session, status: 'submitted' });
    return { grantId: session.id, protocol: session.protocol, mode: session.mode };
  }
  async allowsConversation(conversationId: string): Promise<boolean> {
    return (await this.load()).some(s => s.conversationId === conversationId && s.authorizationScope === 'conversation' && s.status !== 'declined' && s.expiresAt > this.now());
  }
  revoke(conversationId: string): Promise<void> { return this.exclusive(() => this.revokeInternal(conversationId)); }
  private async revokeInternal(conversationId: string): Promise<void> {
    for (const session of await this.load()) if (session.conversationId === conversationId && session.status !== 'declined') {
      await this.put({ ...session, status: 'declined' });
    }
  }
  async validate(request: NativeSearchRequest, route: ProviderExecutionRouteSnapshotV1): Promise<void> {
    const session = (await this.load()).find(s => s.id === request.grantId);
    const registry = await this.registry.load();
    const connection = registry.connections.find(c => c.id === route.connectionId);
    const model = registry.models.find(m => m.id === route.modelId);
    const profile = registry.modelProfiles?.find(p => p.profileId === route.profileId);
    if (!connection || connection.state !== 'available' || connection.connectionRevision !== route.connectionRevision ||
        connection.connectionConfigVersionId !== route.connectionConfigVersionId || connection.credentialVersionId !== route.credentialVersionId ||
        !model || !model.enabled || model.revision !== route.modelRevision || !profile || profile.revision !== route.profileRevision ||
        (profile.nativeSearch && !['declared', 'verified', 'limited'].includes(profile.nativeSearch.state))) throw new NativeSearchAuthorizationError();
    if (!session || session.status !== 'submitted' || session.protocol !== request.protocol || session.mode !== request.mode ||
        session.routeHash !== hash(routeIdentity(route)) || session.expiresAt <= this.now()) throw new NativeSearchAuthorizationError();
  }
  requestStarted(grantId: string): Promise<void> { return this.exclusive(async () => {
    const session = (await this.load()).find(s => s.id === grantId);
    if (!session) throw new NativeSearchAuthorizationError();
    if (session.status !== 'submitted' || session.evidence) return;
    await this.reply(session.conversationId as Conversation['id'], `${session.id}-request-started`,
      '已向模型提交本次联网请求，正在等待服务商返回搜索记录。只有收到真实搜索工具调用或结构化来源，才会确认已搜索。');
  }); }
  observe(grantId: string, evidence: NativeSearchEvidence): Promise<void> { return this.exclusive(() => this.observeInternal(grantId, evidence)); }
  private async observeInternal(grantId: string, evidence: NativeSearchEvidence): Promise<void> {
    const session = (await this.load()).find(s => s.id === grantId);
    if (!session) throw new NativeSearchAuthorizationError();
    const terminal = ['declined', 'cancelled', 'failed', 'completed'].includes(session.status);
    await this.put({ ...session, evidence, status: terminal ? session.status : evidence.status === 'started' ? 'submitted' : evidence.status === 'completed' || evidence.status === 'unobserved' ? 'completed' : evidence.status === 'cancelled' ? 'cancelled' : 'failed' });
    // Late provider callbacks remain auditable without reopening or announcing a finished request.
    if (terminal) return;
    const hasSources = evidence.sources.length > 0;
    const hasToolCalls = typeof evidence.toolCalls === 'number' && evidence.toolCalls > 0;
    if (hasSources || hasToolCalls || evidence.status === 'failed' || evidence.status === 'cancelled') {
      await emitProductionEvent({ code: evidence.status === 'started' ? 'tool_call' : 'tool_result',
        status: evidence.status === 'started' ? 'started' : evidence.status === 'cancelled' ? 'cancelled'
          : evidence.status === 'failed' ? 'failed' : 'completed',
        operationId: grantId, facts: { tool: 'search', count: evidence.sources.length } });
    }
    if (evidence.status === 'started') {
      if (hasSources || hasToolCalls) await this.reply(session.conversationId as Conversation['id'], `${session.id}-started`, hasSources
        ? `已收到服务商返回的 ${evidence.sources.length} 条结构化搜索来源，正在整理资料。`
        : '已收到模型原生搜索工具调用记录，正在等待搜索结果。');
      return;
    }
    const sources = evidence.sources.map((s, i) => `${i + 1}. ${s.title.replace(/[\r\n\[\]()*_<>!`]/g, ' ')} — ${s.url}`).join('\n');
    await this.reply(session.conversationId as Conversation['id'], `${session.id}-result`,
      (evidence.status === 'completed' && (hasSources || hasToolCalls) ? '已收到服务商的搜索执行记录。' : evidence.status === 'unobserved' || evidence.status === 'completed' ? '模型未返回可确认的搜索执行记录，本次回答不能标为联网核实。' : evidence.status === 'cancelled' ? '本次联网搜索已取消，未自动重试。' : '联网搜索失败，未自动重试。') +
      `搜索费用未报告。${sources ? `\n\n服务商返回的来源（未额外抓取核验）：\n${sources}` : '服务商未返回可展示的结构化来源。'}`);
  }
  private async reply(conversationId: Conversation['id'], key: string, content: string): Promise<Conversation> {
    // Only the idempotent local projection is retried; never replay a provider request.
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.conversations.ensureLocalReply(conversationId, key, content); }
      catch (error) { if (!(error instanceof ConversationRevisionConflictError) || attempt === 2) throw error; }
    }
  }
  private async capability(candidate: ResolvedFeatureCandidateV1): Promise<NativeSearchCapability | undefined> {
    const r = candidate.routeTemplate;
    const snapshot = await this.registry.load();
    const profile = snapshot.modelProfiles?.find(p => p.profileId === r.profileId && p.revision === r.profileRevision && p.modelId === r.modelId && p.modelRevision <= r.modelRevision && p.protocolBindingId === r.protocolBindingId);
    if (profile?.nativeSearch) return profile.nativeSearch;
    // Official documentation explicitly covers this API; never apply it to gateway names.
    if (r.packageId === KIMI_PROVIDER_PACKAGE_ID && r.endpointPolicyId === 'endpoint.kimi.official') {
      return { protocol: 'kimi_builtin', state: 'declared', evidenceUrl: 'https://platform.kimi.com/docs/guide/use-web-search', recordedAt: '2026-09-11T00:00:00.000Z' };
    }
  }
  private async load(): Promise<SearchSession[]> {
    const data = await this.storage.readJson<{ schemaVersion: number; sessions: SearchSession[] }>(file);
    if (!data) return [];
    if (data.schemaVersion !== 1 || !Array.isArray(data.sessions)) throw new TypeError('Invalid native search ledger');
    return data.sessions.map(parseSession);
  }
  private async put(session: SearchSession): Promise<void> {
    await this.storage.mutateJsonAtomically(file, current => {
      const data = current as { schemaVersion: number; sessions: SearchSession[] } | undefined;
      if (data && (data.schemaVersion !== 1 || !Array.isArray(data.sessions))) throw new TypeError('Invalid native search ledger');
      if ((data?.sessions.length ?? 0) > 10000) throw new TypeError('Native search history limit exceeded');
      return { schemaVersion: 1, sessions: [...(data?.sessions ?? []).map(parseSession).filter(s => s.id !== session.id), parseSession(session)] };
    }, { backup: true });
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex'); }
function routeIdentity(r: ResolvedFeatureCandidateV1['routeTemplate'] | ProviderExecutionRouteSnapshotV1) {
  return [r.connectionId, r.connectionRevision, r.connectionConfigVersionId, r.credentialVersionId, r.modelId, r.modelRevision,
    r.profileId, r.profileRevision, r.protocolBindingId, r.protocolBindingRevision, r.packageId, r.packageVersion, r.adapterKey, r.adapterVersion, r.endpointPolicyId, r.endpointPolicyRevision, r.parameterSchemaId, r.parameterSchemaRevision];
}

function parseSession(value: unknown): SearchSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid search session');
  const s = value as SearchSession;
  parseNativeSearchRequest({ grantId: s.id, protocol: s.protocol, mode: s.mode });
  if ([s.workflowId, s.conversationId, s.userMessageId, s.candidateId].some(v => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v)) ||
      [s.bindingHash, s.promptHash, s.optionsHash, s.routeHash].some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) ||
      !Number.isSafeInteger(s.workflowRevision) || s.workflowRevision < 0 || !Number.isSafeInteger(s.expectedConversationRevision) || s.expectedConversationRevision < 0 ||
      !Number.isFinite(Date.parse(s.expiresAt)) || !['authorization_required', 'authorized', 'declined', 'submitted', 'completed', 'failed', 'cancelled'].includes(s.status) ||
      (s.authorizationScope !== undefined && !['request', 'conversation'].includes(s.authorizationScope)) ||
      (s.grantedAt !== undefined && !Number.isFinite(Date.parse(s.grantedAt)))) throw new TypeError('Invalid search session');
  return s;
}
