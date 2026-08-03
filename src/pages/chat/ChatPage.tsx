import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ChatContextIpcErrorCode,
  ConversationDto,
  ConversationResponseCandidateDto,
  ConversationResponseDraftDto,
  ConversationResponseExecutionDto,
  ConversationResponsePreparationDto,
  MessageDto,
  ProjectContextCandidateDto,
  ProjectContextDetailDto,
  ProjectContextDraftPreviewDto
} from '../../shared/chat-context-ipc';
import type { StorageProjectSessionDto } from '../../shared/storage-ipc';
import '../../styles/pages.css';

const errorMessages: Record<ChatContextIpcErrorCode, string> = {
  invalid_request: '当前操作数据无效，请刷新后重试。',
  project_not_open: '请先打开目标项目。',
  project_scope_mismatch: '当前内容不属于已打开的项目。',
  conversation_not_found: '该对话已不存在。',
  conversation_not_saved: '未保存的对话不能登记为项目上下文。',
  conversation_deleted: '已删除的对话不能继续操作。',
  conversation_not_active: '请先恢复已归档对话。',
  legacy_conversation_read_only: '旧应用级对话保持只读，请在当前项目新建对话。',
  response_draft_not_found: '本次回复草稿已失效，请重新保存消息。',
  response_execution_not_found: '本次文本执行记录不存在。',
  candidate_not_found: '所选服务商、连接或模型候选已不存在。',
  candidate_unavailable: '所选候选当前不可用于文本回复。',
  route_selection_invalid: '本次候选选择已失效，请重新选择。',
  route_selection_expired: '本次候选选择已过期，请重新确认。',
  route_selection_consumed: '本次候选选择已使用，不能重复提交。',
  stale_route_selection: '草稿、上下文或候选事实已变化，请重新确认。',
  confirmation_required: '必须确认本次外发信息。',
  runtime_not_allowed: '真实文本运行授权尚未开放。',
  draft_not_found: '上下文草稿已不存在，请重新选择。',
  context_not_found: '项目上下文已不存在。',
  message_not_found: '所选消息已不存在。',
  message_not_completed: '只有已完成的消息才能登记。',
  message_revision_changed: '消息内容已变化，请重新选择。',
  selection_out_of_range: '所选消息范围已经失效。',
  revision_conflict: '内容已在其他位置更新，请刷新后重试。',
  explicit_confirmation_required: '请先明确确认预览。',
  adapter_unavailable: '文本适配器当前不可用。',
  storage_error: '本地保存失败，请检查存储状态后重试。'
};

const messageStateLabels: Record<MessageDto['state'], string> = {
  pending: '等待响应',
  streaming: '接收中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const unavailableLabels: Record<string, string> = {
  model_disabled: '模型已停用',
  model_not_present: '模型不在当前目录',
  connection_unavailable: '连接不可用',
  profile_unavailable: '功能 Profile 不可用',
  feature_unsupported: '不支持当前文本功能',
  binding_unavailable: '协议绑定不可用',
  runtime_not_allowed: '运行授权未开放',
  subject_constraints_unsatisfied: '当前输入不满足约束',
  schema_unsupported: '参数 Schema 不可解释'
};

export function ChatPage() {
  const chat = window.unicomp?.chatContexts;
  const storage = window.unicomp?.storage;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [conversations, setConversations] = useState<readonly ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [newTitle, setNewTitle] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [input, setInput] = useState('');
  const [responseFeature, setResponseFeature] = useState<'text_chat' | 'text_reasoning'>('text_chat');
  const [responseDraft, setResponseDraft] = useState<ConversationResponseDraftDto>();
  const [responseCandidates, setResponseCandidates] = useState<readonly ConversationResponseCandidateDto[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [preparation, setPreparation] = useState<ConversationResponsePreparationDto>();
  const [outboundConfirmed, setOutboundConfirmed] = useState(false);
  const [responseExecution, setResponseExecution] = useState<ConversationResponseExecutionDto>();
  const [contextDraft, setContextDraft] = useState<ProjectContextDraftPreviewDto>();
  const [contextLabels, setContextLabels] = useState('');
  const [contextConfirmed, setContextConfirmed] = useState(false);
  const [registeredContexts, setRegisteredContexts] = useState<readonly ProjectContextCandidateDto[]>([]);
  const [viewedContexts, setViewedContexts] = useState<Record<string, ProjectContextDetailDto>>({});
  const [includedContextIds, setIncludedContextIds] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === selectedId),
    [conversations, selectedId]
  );
  const selectedCandidate = responseCandidates.find(
    (candidate) => candidate.candidateId === selectedCandidateId
  );
  const completedMessages = selected?.messages.filter(
    (message) => message.state === 'completed'
  ) ?? [];

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      if (!chat || !storage) {
        setNotice('当前运行环境未连接桌面对话能力。');
        setLoading(false);
        return;
      }
      try {
        const [sessionResult, conversationResult] = await Promise.all([
          storage.getProjectSession(),
          chat.listConversations(true, false)
        ]);
        if (!active) return;
        if (sessionResult.ok) setSession(sessionResult.value);
        else setNotice('读取当前项目失败，请重试。');
        if (conversationResult.ok) {
          setConversations(conversationResult.value);
          setSelectedId(conversationResult.value[0]?.conversationId);
        } else {
          setNotice(errorMessages[conversationResult.error.code]);
        }
        if (sessionResult.ok && sessionResult.value) {
          const contexts = await chat.listProjectContextCandidates();
          if (active && contexts.ok) setRegisteredContexts(contexts.value);
        }
      } catch {
        if (active) setNotice('读取本地对话失败，请重试。');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [chat, storage]);

  useEffect(() => {
    setRenameTitle(selected?.title ?? '');
    setContextDraft(undefined);
    setContextLabels('');
    setContextConfirmed(false);
    clearResponseSelection();
  }, [selected?.conversationId, selected?.title]);

  useEffect(() => {
    if (!chat || !responseExecution || !['pending', 'streaming'].includes(responseExecution.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      void chat.getResponseExecution(responseExecution.responseExecutionId).then((result) => {
        if (result.ok) setResponseExecution(result.value);
      });
    }, 750);
    return () => window.clearInterval(timer);
  }, [chat, responseExecution?.responseExecutionId, responseExecution?.state]);

  function clearResponseSelection() {
    setResponseDraft(undefined);
    setResponseCandidates([]);
    setSelectedCandidateId(undefined);
    setPreparation(undefined);
    setOutboundConfirmed(false);
    setResponseExecution(undefined);
  }

  function replaceConversation(conversation: ConversationDto) {
    setConversations((items) => items.map((item) =>
      item.conversationId === conversation.conversationId ? conversation : item
    ));
  }

  async function createConversation() {
    if (!chat || !session || busy || !newTitle.trim()) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.createConversation(newTitle.trim(), true);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setConversations((items) => [result.value, ...items]);
      setSelectedId(result.value.conversationId);
      setNewTitle('');
      setNotice('项目对话已创建。');
    } catch {
      setNotice('创建对话失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function mutateConversation(operation: 'rename' | 'archive' | 'restore' | 'delete') {
    if (!chat || !selected || selected.readOnly || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = operation === 'rename'
        ? await chat.renameConversation(selected.conversationId, selected.revision, renameTitle.trim())
        : operation === 'archive'
          ? await chat.archiveConversation(selected.conversationId, selected.revision)
          : operation === 'restore'
            ? await chat.restoreConversation(selected.conversationId, selected.revision)
            : await chat.deleteConversation(selected.conversationId, selected.revision);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      if (operation === 'delete') {
        const remaining = conversations.filter((item) => item.conversationId !== selected.conversationId);
        setConversations(remaining);
        setSelectedId(remaining[0]?.conversationId);
        setNotice('对话已移入墓碑；已登记的项目上下文不会被删除。');
      } else {
        replaceConversation(result.value);
        setNotice(operation === 'rename' ? '对话名称已更新。' : operation === 'archive' ? '对话已归档。' : '对话已恢复。');
      }
    } catch {
      setNotice('更新对话失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function copyLegacyConversation() {
    if (!chat || !session || !selected?.readOnly || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.copyLegacyConversation(selected.conversationId);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setConversations((items) => [result.value, ...items]);
      setSelectedId(result.value.conversationId);
      setNotice('旧对话的已完成文本消息已复制到当前项目，原记录保持只读。');
    } catch {
      setNotice('复制旧对话失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveMessageAndBuildResponseDraft() {
    if (!chat || !selected || selected.readOnly || selected.status !== 'active' || !input.trim() || busy) return;
    setBusy(true);
    setNotice('');
    clearResponseSelection();
    try {
      const saved = await chat.addUserMessage(selected.conversationId, selected.revision, input.trim());
      if (!saved.ok) {
        setNotice(errorMessages[saved.error.code]);
        return;
      }
      replaceConversation(saved.value);
      setInput('');
      const userMessage = [...saved.value.messages].reverse().find((message) => message.role === 'user');
      if (!userMessage) {
        setNotice('消息已保存，但未能建立回复草稿。');
        return;
      }
      const created = await chat.createResponseDraft(
        saved.value.conversationId,
        saved.value.revision,
        userMessage.messageId,
        responseFeature
      );
      if (!created.ok) {
        setNotice(`消息已保存；${errorMessages[created.error.code]}`);
        return;
      }
      let draft = created.value;
      if (includedContextIds.length > 0) {
        const replaced = await chat.replaceResponseContexts(
          draft.responseDraftId,
          draft.revision,
          includedContextIds.flatMap((contextId) => {
            const context = viewedContexts[contextId];
            return context ? [{
              contextId,
              contextRevision: context.revision,
              includeInPrompt: true
            }] : [];
          })
        );
        if (!replaced.ok) {
          setResponseDraft(draft);
          setNotice(`消息已保存；${errorMessages[replaced.error.code]}`);
          return;
        }
        draft = replaced.value;
      }
      setResponseDraft(draft);
      const candidates = await chat.listResponseCandidates(draft.responseDraftId, draft.revision);
      if (!candidates.ok) {
        setNotice(`消息已保存；${errorMessages[candidates.error.code]}`);
        return;
      }
      setResponseCandidates(candidates.value);
      setNotice(candidates.value.length === 0
        ? '消息已保存；当前没有已登记的文本候选，请到“模型与服务商”页完成连接和模型配置。'
        : '消息已保存；请选择服务商、连接和文本模型。');
    } catch {
      setNotice('保存消息或读取文本候选失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function prepareResponse() {
    if (!chat || !responseDraft || !selectedCandidateId || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.prepareResponseSubmission(
        responseDraft.responseDraftId,
        responseDraft.revision,
        selectedCandidateId
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setPreparation(result.value);
      setOutboundConfirmed(false);
      setNotice('请核对本次外发接收方、内容类别、上下文数量和费用事实。');
    } catch {
      setNotice('准备文本提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function submitResponse() {
    if (!chat || !responseDraft || !preparation || !outboundConfirmed || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.submitResponse(
        responseDraft.responseDraftId,
        responseDraft.revision,
        preparation.routeSelectionToken,
        preparation.confirmation.confirmationId,
        true
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setResponseExecution(result.value);
      setPreparation(undefined);
      setOutboundConfirmed(false);
      setNotice('文本请求已受控提交。');
    } catch {
      setNotice('文本提交状态未知，请查看任务中心调用记录，不会自动重试。');
    } finally {
      setBusy(false);
    }
  }

  async function viewContext(candidate: ProjectContextCandidateDto) {
    if (!chat || busy) return;
    setBusy(true);
    try {
      const result = await chat.getProjectContextRevision(candidate.contextId, candidate.revision);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setViewedContexts((current) => ({ ...current, [candidate.contextId]: result.value }));
      setNotice('已读取固定版本上下文；需要用于本次回复时请另行勾选。');
    } catch {
      setNotice('读取项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function toggleMessageSelection(message: MessageDto, checked: boolean) {
    if (!chat || !selected || selected.readOnly || !session || busy) return;
    setBusy(true);
    setNotice('');
    try {
      let draft = contextDraft;
      if (!draft) {
        const created = await chat.createContextDraft(selected.conversationId);
        if (!created.ok) {
          setNotice(errorMessages[created.error.code]);
          return;
        }
        draft = created.value;
      }
      const existing = draft.fragments.find((fragment) => fragment.messageId === message.messageId);
      const result = checked
        ? existing ? { ok: true as const, value: draft } : await chat.addContextMessageFragment(
          draft.draftId, draft.revision, message.messageId, 0, message.content.length
        )
        : existing ? await chat.removeContextMessageFragment(draft.draftId, draft.revision, existing.fragmentId)
          : { ok: true as const, value: draft };
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setContextDraft(result.value);
      setContextConfirmed(false);
      setNotice(checked ? '消息内容已加入上下文草稿。' : '消息内容已从上下文草稿移除。');
    } catch {
      setNotice('更新上下文草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveContextLabels() {
    if (!chat || !contextDraft || busy) return;
    const labels = Array.from(new Set(contextLabels.split(/[,，]/).map((label) => label.trim()).filter(Boolean)));
    setBusy(true);
    try {
      const result = await chat.updateContextDraftLabels(contextDraft.draftId, contextDraft.revision, labels);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setContextDraft(result.value);
      setContextConfirmed(false);
      setNotice('上下文标签已更新，请重新确认预览。');
    } catch {
      setNotice('更新上下文标签失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function registerContext() {
    if (!chat || !contextDraft || !contextConfirmed || busy) return;
    setBusy(true);
    try {
      const result = await chat.registerContextDraft(contextDraft.draftId, contextDraft.revision, true);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      const candidates = await chat.listProjectContextCandidates();
      if (candidates.ok) setRegisteredContexts(candidates.value);
      setContextDraft(undefined);
      setContextLabels('');
      setContextConfirmed(false);
      setNotice(`项目上下文已登记为 revision ${result.value.revision}。`);
    } catch {
      setNotice('登记项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="uc-chat-page" aria-labelledby="chat-page-title">
      <aside className="uc-chat-page__history" aria-label="对话列表">
        <div className="uc-chat-page__panel-heading">
          <h2>项目对话</h2>
          <StatusPill>{conversations.length} 个</StatusPill>
        </div>
        <form className="uc-chat-page__new" onSubmit={(event) => { event.preventDefault(); void createConversation(); }}>
          <label>
            <span>新对话名称</span>
            <input maxLength={200} onChange={(event) => setNewTitle(event.target.value)} placeholder="例如：品牌短片构思" value={newTitle} />
          </label>
          <Button disabled={!session || busy || !newTitle.trim()} type="submit" variant="secondary">创建项目对话</Button>
        </form>
        {!session ? <p className="uc-chat-page__notice">打开项目后才能创建新对话。</p> : null}
        {loading ? (
          <EmptyState busy description="正在读取本地对话历史。" icon="读" title="读取中" />
        ) : conversations.length === 0 ? (
          <EmptyState description="当前没有已保存对话。" icon="对" title="暂无历史对话" />
        ) : (
          <div className="uc-chat-page__history-list">
            {conversations.map((conversation) => (
              <button aria-current={conversation.conversationId === selectedId ? 'true' : undefined} className="uc-chat-page__history-item" key={conversation.conversationId} onClick={() => setSelectedId(conversation.conversationId)} type="button">
                <strong>{conversation.title}</strong>
                <span>{conversation.readOnly ? '旧记录 · 只读' : conversation.status === 'archived' ? '已归档' : '当前项目'} · {conversation.messages.length} 条消息</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="uc-chat-page__conversation" aria-label="当前对话">
        <header className="uc-chat-page__header">
          <div>
            <div className="uc-page-skeleton__heading-row">
              <h1 className="uc-page-skeleton__title" id="chat-page-title">对话</h1>
              <StatusPill tone={selected?.readOnly ? 'warning' : selected?.status === 'active' ? 'info' : 'neutral'}>
                {selected ? selected.readOnly ? '旧记录只读' : selected.status === 'active' ? '项目级' : '已归档' : '未选择'}
              </StatusPill>
            </div>
            <p className="uc-page-skeleton__description">问答、分析、整理与项目上下文沉淀。</p>
          </div>
          <StatusPill tone="warning">运行授权关闭</StatusPill>
        </header>

        {!selected ? (
          <div className="uc-chat-page__messages"><EmptyState description="请从左侧选择或创建项目对话。" icon="聊" title="尚未选择对话" /></div>
        ) : (
          <>
            <Card className="uc-chat-page__conversation-actions">
              <label><span>对话名称</span><input disabled={selected.readOnly || selected.status === 'deleted'} maxLength={200} onChange={(event) => setRenameTitle(event.target.value)} value={renameTitle} /></label>
              <div className="uc-chat-page__actions">
                {selected.readOnly ? <Button disabled={!session || busy} onClick={() => void copyLegacyConversation()} variant="secondary">复制到当前项目</Button> : null}
                <Button disabled={selected.readOnly || busy || !renameTitle.trim() || renameTitle.trim() === selected.title} onClick={() => void mutateConversation('rename')} variant="secondary">重命名</Button>
                {selected.status === 'active' ? <Button disabled={selected.readOnly || busy} onClick={() => void mutateConversation('archive')} variant="secondary">归档</Button> : <Button disabled={selected.readOnly || busy} onClick={() => void mutateConversation('restore')} variant="secondary">恢复</Button>}
                <Button disabled={selected.readOnly || busy} onClick={() => void mutateConversation('delete')} variant="ghost">删除</Button>
              </div>
            </Card>
            <div className="uc-chat-page__messages" aria-live="polite">
              {selected.messages.length === 0 ? <EmptyState description="保存第一条用户消息后才会进入历史。" icon="聊" title="还没有对话内容" /> : (
                <ol className="uc-chat-page__message-list">
                  {selected.messages.map((item) => (
                    <li className={`uc-chat-page__message-item uc-chat-page__message-item--${item.role}`} key={item.messageId}>
                      <div><strong>{item.role === 'user' ? '你' : '助手'}</strong><StatusPill tone={item.state === 'failed' ? 'danger' : item.state === 'completed' ? 'info' : 'neutral'}>{messageStateLabels[item.state]}</StatusPill></div>
                      <p>{item.content || '尚无内容'}</p>
                    </li>
                  ))}
                </ol>
              )}
              {responseExecution ? <Card className="uc-chat-page__stream"><div><strong>受控文本流</strong><StatusPill tone={responseExecution.state === 'failed' ? 'danger' : responseExecution.state === 'completed' ? 'info' : 'neutral'}>{responseExecution.state}</StatusPill></div><p>{responseExecution.content || '等待首个文本片段'}</p></Card> : null}
            </div>
          </>
        )}

        <section className="uc-chat-page__composer" aria-labelledby="chat-composer-title">
          <div className="uc-chat-page__panel-heading"><h2 id="chat-composer-title">用户消息</h2><div className="uc-chat-page__mode" role="group" aria-label="文本功能"><button aria-pressed={responseFeature === 'text_chat'} onClick={() => setResponseFeature('text_chat')} type="button">普通对话</button><button aria-pressed={responseFeature === 'text_reasoning'} onClick={() => setResponseFeature('text_reasoning')} type="button">推理</button></div></div>
          <textarea aria-label="对话输入" disabled={!selected || selected.readOnly || selected.status !== 'active'} maxLength={8000} onChange={(event) => setInput(event.target.value)} placeholder="输入需要问答、分析或整理的内容" rows={5} value={input} />
          <div className="uc-chat-page__composer-footer"><Button disabled title="原生附件登记未进入本支范围" variant="secondary">添加附件</Button><span>{input.length} / 8000</span></div>
          <div className="uc-chat-page__actions"><Button disabled={!input} onClick={() => setInput('')} variant="secondary">清空</Button><Button disabled={!chat || !selected || selected.readOnly || selected.status !== 'active' || !input.trim() || busy} onClick={() => void saveMessageAndBuildResponseDraft()}>保存消息</Button></div>
        </section>

        {responseDraft ? (
          <section className="uc-chat-page__route" aria-labelledby="chat-route-title">
            <div className="uc-chat-page__panel-heading"><h2 id="chat-route-title">文本候选</h2><StatusPill>{responseDraft.productFeature === 'text_reasoning' ? '推理' : '普通对话'}</StatusPill></div>
            {responseCandidates.length === 0 ? <EmptyState description="请先在模型与服务商页完成连接、模型 Profile 与运行专项批准。" icon="模" readOnly title="没有文本候选" /> : (
              <fieldset className="uc-chat-page__candidate-list" disabled={busy}>
                <legend>服务商 / 连接 / 模型</legend>
                {responseCandidates.map((candidate) => (
                  <label key={candidate.candidateId}>
                    <input checked={selectedCandidateId === candidate.candidateId} disabled={!candidate.available} name="chat-candidate" onChange={() => { setSelectedCandidateId(candidate.candidateId); setPreparation(undefined); setOutboundConfirmed(false); }} type="radio" />
                    <span><strong>{candidate.providerName} · {candidate.connectionName}</strong><b>{candidate.modelName}</b><small>{candidate.available ? '可准备提交' : candidate.unavailableReasons.map((reason) => unavailableLabels[reason] ?? reason).join('、')}</small></span>
                  </label>
                ))}
              </fieldset>
            )}
            {selectedCandidate ? <Card className="uc-chat-page__schema"><small>参数 Schema · revision {selectedCandidate.parameterSchema.revision}</small><p>{selectedCandidate.parameterSchema.fields.length === 0 ? '本次不需要用户参数，采用服务商默认值。' : selectedCandidate.parameterSchema.fields.map((field) => field.labelId).join('、')}</p></Card> : null}
            <Button disabled={!selectedCandidate?.available || busy} onClick={() => void prepareResponse()} variant="secondary">检查外发</Button>
            {preparation ? <Card className="uc-chat-page__confirmation"><strong>{preparation.confirmation.providerName} · {preparation.confirmation.connectionName} · {preparation.confirmation.modelName}</strong><dl><div><dt>接收方</dt><dd>{preparation.confirmation.recipientName}</dd></div><div><dt>内容类别</dt><dd>{preparation.confirmation.contentCategories.join('、')}</dd></div><div><dt>上下文</dt><dd>{preparation.confirmation.contextCount} 项</dd></div><div><dt>费用事实</dt><dd>{preparation.confirmation.cost.summary ?? (preparation.confirmation.cost.state === 'unknown' ? '未知' : '不适用')}</dd></div></dl><label className="uc-chat-page__check"><input checked={outboundConfirmed} onChange={(event) => setOutboundConfirmed(event.target.checked)} type="checkbox" />我确认本次接收方、内容范围、上下文和费用事实</label><Button disabled={!outboundConfirmed || busy} onClick={() => void submitResponse()}>确认并请求文本回复</Button></Card> : null}
          </section>
        ) : null}
        <p className="uc-chat-page__message" aria-live="polite">{notice}</p>
      </section>

      <aside className="uc-chat-page__context" aria-labelledby="context-draft-title">
        <div className="uc-chat-page__panel-heading"><h2 id="context-draft-title">项目上下文</h2><StatusPill tone={session ? 'info' : 'neutral'}>{session ? '当前项目' : '无项目'}</StatusPill></div>
        <Card className="uc-chat-page__context-target"><small>目标项目</small><strong>{session?.projectName ?? '尚未打开项目'}</strong><span>已登记 {registeredContexts.length} 项</span></Card>
        {registeredContexts.length > 0 ? <section className="uc-chat-page__response-contexts" aria-labelledby="response-context-title"><h3 id="response-context-title">本次回复上下文</h3>{registeredContexts.map((context) => { const viewed = viewedContexts[context.contextId]; const included = includedContextIds.includes(context.contextId); return <Card key={context.contextId}><div><strong>{context.labels.join('、') || '未命名上下文'}</strong><StatusPill>rev {context.revision}</StatusPill></div><p>{viewed?.contentSnapshot ?? context.contentPreview}</p><div className="uc-chat-page__actions"><Button disabled={busy} onClick={() => void viewContext(context)} variant="secondary">查看固定版本</Button><label className="uc-chat-page__check"><input checked={included} disabled={!viewed} onChange={(event) => setIncludedContextIds((current) => event.target.checked ? [...current, context.contextId] : current.filter((id) => id !== context.contextId))} type="checkbox" />用于本次回复</label></div></Card>; })}</section> : null}
        {!session ? <EmptyState description="打开项目后才能登记上下文。" icon="项" readOnly title="需要目标项目" /> : !selected || selected.readOnly ? <EmptyState description="请选择当前项目中的可写对话。" icon="摘" readOnly title="不可登记" /> : completedMessages.length === 0 ? <EmptyState description="只有已完成消息可以登记。" icon="摘" readOnly title="没有可登记消息" /> : (
          <fieldset className="uc-chat-page__selection-list" disabled={busy}><legend>登记新的项目上下文</legend>{completedMessages.map((item) => <label key={item.messageId}><input checked={Boolean(contextDraft?.fragments.some((fragment) => fragment.messageId === item.messageId))} onChange={(event) => void toggleMessageSelection(item, event.target.checked)} type="checkbox" /><span><strong>{item.role === 'user' ? '用户' : '助手'}</strong>{item.content}</span></label>)}</fieldset>
        )}
        {contextDraft ? <><Card className="uc-chat-page__context-preview"><small>草稿预览 · revision {contextDraft.revision}</small><p>{contextDraft.contentPreview || '尚未选择内容'}</p></Card><label className="uc-chat-page__context-labels"><span>用户标签（逗号分隔）</span><input maxLength={500} onChange={(event) => setContextLabels(event.target.value)} placeholder="例如：品牌语气，镜头约束" value={contextLabels} /></label><Button disabled={busy} onClick={() => void saveContextLabels()} variant="secondary">更新标签</Button><label className="uc-chat-page__check"><input checked={contextConfirmed} disabled={!contextDraft.canRegister} onChange={(event) => setContextConfirmed(event.target.checked)} type="checkbox" />我已检查目标项目、消息内容和标签</label><Button disabled={!contextDraft.canRegister || !contextConfirmed || busy} onClick={() => void registerContext()}>确认登记到项目</Button></> : null}
        <p className="uc-chat-page__notice">查看上下文不会自动用于回复；只有显式勾选的固定版本会进入本次外发快照。</p>
      </aside>
    </section>
  );
}
