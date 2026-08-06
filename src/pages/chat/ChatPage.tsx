import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Input, SelectPicker } from 'rsuite';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import {
  DynamicParameterForm,
  toDynamicParameterFields,
  type DynamicParameterValue
} from '../../components/DynamicParameterForm';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ChatContextIpcErrorCode,
  ConversationDto,
  ConversationResponseCandidateDto,
  ConversationResponseDraftDto,
  ConversationResponseExecutionDto,
  MessageDto,
  ProjectContextCandidateDto,
  ProjectContextDetailDto,
  ProjectContextDraftPreviewDto
} from '../../shared/chat-context-ipc';
import type { StorageProjectSessionDto } from '../../shared/storage-ipc';
import { PROJECT_SESSION_CHANGED_EVENT } from '../../ui/project-session-events';
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
  response_draft_not_found: '本次回复草稿已失效，请重新发送。',
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
  profile_unavailable: '功能配置不可用',
  feature_unsupported: '不支持当前文本功能',
  binding_unavailable: '协议绑定不可用',
  runtime_not_allowed: '运行授权未开放',
  subject_constraints_unsatisfied: '当前输入不满足约束',
  schema_unsupported: '参数定义无法识别'
};

function mapExecutionStateToMessageState(
  state: ConversationResponseExecutionDto['state']
): MessageDto['state'] {
  if (state === 'streaming') return 'streaming';
  if (state === 'pending') return 'pending';
  if (state === 'completed') return 'completed';
  if (state === 'cancelled') return 'cancelled';
  return 'failed';
}

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
  const [, setResponseDraft] = useState<ConversationResponseDraftDto>();
  const [responseCandidates, setResponseCandidates] = useState<readonly ConversationResponseCandidateDto[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [parameterValues, setParameterValues] = useState<
    Readonly<Record<string, DynamicParameterValue | undefined>>
  >({});
  const [lockedSchemaKey, setLockedSchemaKey] = useState<string>();
  const [paramsOpen, setParamsOpen] = useState(false);
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
  const [candidatesLoading, setCandidatesLoading] = useState(false);

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
  const displayMessages = useMemo(() => {
    if (!selected) return [];
    return selected.messages.map((message) => {
      if (!responseExecution || message.messageId !== responseExecution.assistantMessageId) {
        return message;
      }
      const state = mapExecutionStateToMessageState(responseExecution.state);
      return {
        ...message,
        state,
        content: responseExecution.content || message.content
      };
    });
  }, [selected, responseExecution]);
  const modelOptions = responseCandidates.map((candidate) => ({
    id: candidate.candidateId,
    label: `${candidate.providerName} · ${candidate.connectionName} · ${candidate.modelName}`,
    available: candidate.available,
    unavailableReasons: candidate.unavailableReasons
  }));
  const canCompose = Boolean(
    selected && !selected.readOnly && selected.status === 'active' && session
  );

  useEffect(() => {
    let active = true;
    async function load(options?: { readonly quiet?: boolean }) {
      if (!options?.quiet) setLoading(true);
      if (!chat || !storage) {
        setNotice('当前运行环境未连接桌面对话能力。');
        if (!options?.quiet) setLoading(false);
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
          setSelectedId((current) =>
            current && conversationResult.value.some((item) => item.conversationId === current)
              ? current
              : conversationResult.value[0]?.conversationId
          );
        } else {
          setNotice(errorMessages[conversationResult.error.code]);
        }
        if (sessionResult.ok && sessionResult.value) {
          const contexts = await chat.listProjectContextCandidates();
          if (active && contexts.ok) setRegisteredContexts(contexts.value);
        } else if (active) {
          setRegisteredContexts([]);
        }
      } catch {
        if (active) setNotice('读取本地对话失败，请重试。');
      } finally {
        if (active && !options?.quiet) setLoading(false);
      }
    }
    void load();
    const refresh = () => { void load({ quiet: true }); };
    window.addEventListener('focus', refresh);
    window.addEventListener(PROJECT_SESSION_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener(PROJECT_SESSION_CHANGED_EVENT, refresh);
    };
  }, [chat, storage]);

  useEffect(() => {
    setRenameTitle(selected?.title ?? '');
    setContextDraft(undefined);
    setContextLabels('');
    setContextConfirmed(false);
    clearResponseDraftState();
  }, [selected?.conversationId, selected?.title]);

  useEffect(() => {
    let active = true;
    async function loadCandidates() {
      if (!chat || !session || !selected || selected.readOnly || selected.status !== 'active') {
        setResponseCandidates([]);
        return;
      }
      setCandidatesLoading(true);
      try {
        const result = await chat.listTextCandidates(responseFeature);
        if (!active) return;
        if (!result.ok) {
          setResponseCandidates([]);
          setNotice(errorMessages[result.error.code]);
          return;
        }
        setResponseCandidates(result.value);
        setSelectedCandidateId((current) =>
          current && result.value.some((item) => item.candidateId === current)
            ? current
            : undefined
        );
        if (result.value.length === 0) {
          setNotice('当前没有已登记的文本候选，请到「模型与服务商」页完成连接和模型配置。');
        }
      } catch {
        if (active) {
          setResponseCandidates([]);
          setNotice('读取文本模型候选失败，请重试。');
        }
      } finally {
        if (active) setCandidatesLoading(false);
      }
    }
    void loadCandidates();
    return () => { active = false; };
  }, [chat, session, selected?.conversationId, selected?.readOnly, selected?.status, responseFeature]);

  useEffect(() => {
    if (!chat || !responseExecution || !['pending', 'streaming'].includes(responseExecution.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      void chat.getResponseExecution(responseExecution.responseExecutionId).then((result) => {
        if (!result.ok) return;
        setResponseExecution(result.value);
        if (!['pending', 'streaming'].includes(result.value.state) && selectedId) {
          void chat.getConversation(selectedId).then((conversation) => {
            if (conversation.ok) replaceConversation(conversation.value);
          });
        }
      });
      if (selectedId) {
        void chat.getConversation(selectedId).then((result) => {
          if (result.ok) replaceConversation(result.value);
        });
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [chat, responseExecution?.responseExecutionId, responseExecution?.state, selectedId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!input.trim()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [input]);

  function clearResponseDraftState() {
    setResponseDraft(undefined);
    setResponseExecution(undefined);
  }

  function changeCandidate(next: string) {
    const candidate = responseCandidates.find((item) => item.candidateId === next);
    const schemaKey = candidate
      ? `${candidate.parameterSchema.schemaId}@${candidate.parameterSchema.revision}`
      : undefined;
    setSelectedCandidateId(next || undefined);
    if (schemaKey !== lockedSchemaKey) {
      setParameterValues({});
      setLockedSchemaKey(schemaKey);
    }
    if (!next) setParamsOpen(false);
  }

  function confirmLeaveUnsentInput(): boolean {
    if (!input.trim()) return true;
    return window.confirm('当前输入尚未发送，确定离开并丢弃吗？');
  }

  function selectConversation(conversationId: string) {
    if (conversationId === selectedId) return;
    if (!confirmLeaveUnsentInput()) return;
    setInput('');
    setSelectedId(conversationId);
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

  async function sendMessage() {
    if (
      !chat ||
      !selected ||
      selected.readOnly ||
      selected.status !== 'active' ||
      !input.trim() ||
      !selectedCandidateId ||
      !selectedCandidate?.available ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setNotice('');
    clearResponseDraftState();
    const content = input.trim();
    try {
      const saved = await chat.addUserMessage(selected.conversationId, selected.revision, content);
      if (!saved.ok) {
        setNotice(errorMessages[saved.error.code]);
        return;
      }
      replaceConversation(saved.value);
      setInput('');
      const userMessage = [...saved.value.messages].reverse().find((message) => message.role === 'user');
      if (!userMessage) {
        setNotice('消息已写入，但未能建立回复草稿。');
        return;
      }
      const created = await chat.createResponseDraft(
        saved.value.conversationId,
        saved.value.revision,
        userMessage.messageId,
        responseFeature
      );
      if (!created.ok) {
        setNotice(errorMessages[created.error.code]);
        return;
      }
      let draft = created.value;
      if (includedContextIds.length > 0) {
        const replaced = await chat.replaceResponseContexts(
          draft.responseDraftId,
          draft.revision,
          includedContextIds.flatMap((contextId) => {
            const context = viewedContexts[contextId];
            return context
              ? [{
                  contextId,
                  contextRevision: context.revision,
                  includeInPrompt: true
                }]
              : [];
          })
        );
        if (!replaced.ok) {
          setResponseDraft(draft);
          setNotice(errorMessages[replaced.error.code]);
          return;
        }
        draft = replaced.value;
      }
      setResponseDraft(draft);
      const prepared = await chat.prepareResponseSubmission(
        draft.responseDraftId,
        draft.revision,
        selectedCandidateId
      );
      if (!prepared.ok) {
        setNotice(errorMessages[prepared.error.code] ?? '准备回复失败，请重试。');
        return;
      }
      const submitted = await chat.submitResponse(
        draft.responseDraftId,
        draft.revision,
        prepared.value.routeSelectionToken,
        prepared.value.confirmation.confirmationId,
        true
      );
      if (!submitted.ok) {
        setNotice(errorMessages[submitted.error.code] ?? '发送失败，请重试。');
        return;
      }
      setResponseExecution(submitted.value);
      setNotice('已发送，正在接收回复。');
      const refreshed = await chat.getConversation(selected.conversationId);
      if (refreshed.ok) replaceConversation(refreshed.value);
    } catch {
      setNotice('发送失败，请重试。若状态未知，请查看任务中心调用记录。');
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
      setNotice(`项目上下文已登记为版本 ${result.value.revision}。`);
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
            <Input maxLength={200} onChange={(value) => setNewTitle(value)} placeholder="例如：品牌短片构思" value={newTitle} />
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
              <button aria-current={conversation.conversationId === selectedId ? 'true' : undefined} className="uc-chat-page__history-item" key={conversation.conversationId} onClick={() => selectConversation(conversation.conversationId)} type="button">
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
              <h1 className="uc-page-skeleton__title" id="chat-page-title">
                {selected?.title ?? '对话'}
              </h1>
              <StatusPill tone={selected?.readOnly ? 'warning' : selected?.status === 'active' ? 'info' : 'neutral'}>
                {selected ? selected.readOnly ? '旧记录只读' : selected.status === 'active' ? '项目级' : '已归档' : '未选择'}
              </StatusPill>
            </div>
          </div>
          <div className="uc-chat-page__header-actions">
            <div className="uc-chat-page__mode" role="group" aria-label="文本功能">
              <button
                aria-pressed={responseFeature === 'text_chat'}
                disabled={!canCompose || busy}
                onClick={() => setResponseFeature('text_chat')}
                type="button"
              >
                普通对话
              </button>
              <button
                aria-pressed={responseFeature === 'text_reasoning'}
                disabled={!canCompose || busy}
                onClick={() => setResponseFeature('text_reasoning')}
                type="button"
              >
                推理
              </button>
            </div>
            <StatusPill tone="warning">运行授权关闭</StatusPill>
          </div>
        </header>

        {selected ? (
          <Card className="uc-chat-page__conversation-actions">
            <label>
              <span>对话名称</span>
              <Input
                disabled={selected.readOnly || selected.status === 'deleted'}
                maxLength={200}
                onChange={(value) => setRenameTitle(value)}
                value={renameTitle}
              />
            </label>
            <div className="uc-chat-page__actions">
              {selected.readOnly ? (
                <Button disabled={!session || busy} onClick={() => void copyLegacyConversation()} variant="secondary">
                  复制到当前项目
                </Button>
              ) : null}
              <Button
                disabled={selected.readOnly || busy || !renameTitle.trim() || renameTitle.trim() === selected.title}
                onClick={() => void mutateConversation('rename')}
                variant="secondary"
              >
                重命名
              </Button>
              {selected.status === 'active' ? (
                <Button disabled={selected.readOnly || busy} onClick={() => void mutateConversation('archive')} variant="secondary">
                  归档
                </Button>
              ) : (
                <Button disabled={selected.readOnly || busy} onClick={() => void mutateConversation('restore')} variant="secondary">
                  恢复
                </Button>
              )}
              <Button disabled={selected.readOnly || busy} onClick={() => void mutateConversation('delete')} variant="ghost">
                删除
              </Button>
            </div>
          </Card>
        ) : null}

        <div className="uc-chat-page__messages" aria-live="polite">
          {!selected ? (
            <EmptyState description="请从左侧选择或创建项目对话。" icon="聊" title="尚未选择对话" />
          ) : displayMessages.length === 0 ? (
            <EmptyState description="在下方选择模型并发送第一条消息。" icon="聊" title="还没有对话内容" />
          ) : (
            <ol className="uc-chat-page__message-list">
              {displayMessages.map((item) => (
                <li
                  className={`uc-chat-page__message-item uc-chat-page__message-item--${item.role}`}
                  key={item.messageId}
                >
                  <div>
                    <strong>{item.role === 'user' ? '你' : '助手'}</strong>
                    <StatusPill
                      tone={
                        item.state === 'failed'
                          ? 'danger'
                          : item.state === 'streaming' || item.state === 'pending'
                            ? 'warning'
                            : item.state === 'completed'
                              ? 'info'
                              : 'neutral'
                      }
                    >
                      {messageStateLabels[item.state]}
                    </StatusPill>
                  </div>
                  <p>
                    {item.content || (item.state === 'streaming' || item.state === 'pending' ? '正在接收…' : '尚无内容')}
                    {item.state === 'streaming' ? <span className="uc-chat-page__caret" aria-hidden="true">▌</span> : null}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>

        <section className="uc-chat-page__composer" aria-labelledby="chat-composer-title">
          <h2 className="uc-visually-hidden" id="chat-composer-title">发送消息</h2>
          {paramsOpen && selectedCandidate ? (
            <Card className="uc-chat-page__params-panel">
              <div className="uc-chat-page__panel-heading">
                <strong>参数</strong>
                <Button onClick={() => setParamsOpen(false)} type="button" variant="ghost">
                  收起
                </Button>
              </div>
              <small>
                参数配置版本 {selectedCandidate.parameterSchema.revision}
              </small>
              <DynamicParameterForm
                disabled={busy || !canCompose}
                fields={toDynamicParameterFields(selectedCandidate.parameterSchema.fields)}
                onChange={(fieldId, value) => {
                  setParameterValues((current) => ({ ...current, [fieldId]: value }));
                }}
                values={parameterValues}
              />
            </Card>
          ) : null}
          <Input
            aria-label="对话输入"
            as="textarea"
            disabled={!canCompose}
            maxLength={8000}
            onChange={(value) => setInput(value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={
              !selected
                ? '先选择或创建对话'
                : selectedCandidate
                  ? `发送给 ${selectedCandidate.providerName} · ${selectedCandidate.modelName}`
                  : '先选择模型，再输入内容发送'
            }
            rows={3}
            value={input}
          />
          <div className="uc-chat-page__composer-toolbar">
            <div className="uc-chat-page__composer-tools">
              <button
                aria-expanded={paramsOpen}
                className="uc-chat-page__tool-pill"
                disabled={!canCompose || !selectedCandidate || busy}
                onClick={() => setParamsOpen((open) => !open)}
                type="button"
              >
                参数
              </button>
              <div className="uc-chat-page__model-tool">
                <span className="uc-visually-hidden">选择文本模型</span>
                <SelectPicker
                  aria-label="选择文本模型"
                  data={modelOptions.map((option) => ({
                    value: option.id,
                    label: `${option.label}${
                      option.available
                        ? ''
                        : `（${(option.unavailableReasons ?? [])
                            .map((reason) => unavailableLabels[reason] ?? '其他不可用原因')
                            .join('、') || '不可用'}）`
                    }`
                  }))}
                  disabled={!canCompose || busy || candidatesLoading}
                  disabledItemValues={modelOptions
                    .filter((option) => !option.available)
                    .map((option) => option.id)}
                  onChange={(value) => changeCandidate(value ?? '')}
                  placeholder={
                    candidatesLoading ? '加载模型…' : modelOptions.length === 0 ? '暂无可用模型' : '选择模型'
                  }
                  searchable={false}
                  value={selectedCandidateId ?? null}
                />
              </div>
            </div>
            <div className="uc-chat-page__composer-actions">
              <span className="uc-chat-page__composer-count">{input.length} / 8000</span>
              <Button disabled title="原生附件登记未进入本支范围" variant="secondary">
                附件
              </Button>
              <Button
                disabled={
                  !chat ||
                  !canCompose ||
                  !input.trim() ||
                  !selectedCandidate?.available ||
                  busy
                }
                onClick={() => void sendMessage()}
              >
                发送
              </Button>
            </div>
          </div>
          {!canCompose && session ? (
            <p className="uc-chat-page__notice">当前对话不可写，请选择或创建可写项目对话。</p>
          ) : null}
          {canCompose && modelOptions.length === 0 && !candidatesLoading ? (
            <p className="uc-chat-page__notice">
              没有可选模型。请到「模型与服务商」添加连接并启用文本模型。
            </p>
          ) : null}
        </section>
        <p className="uc-chat-page__message" aria-live="polite">{notice}</p>
      </section>

      <aside className="uc-chat-page__context" aria-labelledby="context-draft-title">
        <div className="uc-chat-page__panel-heading"><h2 id="context-draft-title">项目上下文</h2><StatusPill tone={session ? 'info' : 'neutral'}>{session ? '当前项目' : '无项目'}</StatusPill></div>
        <Card className="uc-chat-page__context-target"><small>目标项目</small><strong>{session?.projectName ?? '尚未打开项目'}</strong><span>已登记 {registeredContexts.length} 项</span></Card>
        {registeredContexts.length > 0 ? <section className="uc-chat-page__response-contexts" aria-labelledby="response-context-title"><h3 id="response-context-title">本次回复上下文</h3>{registeredContexts.map((context) => { const viewed = viewedContexts[context.contextId]; const included = includedContextIds.includes(context.contextId); return <Card key={context.contextId}><div><strong>{context.labels.join('、') || '未命名上下文'}</strong><StatusPill>版本 {context.revision}</StatusPill></div><p>{viewed?.contentSnapshot ?? context.contentPreview}</p><div className="uc-chat-page__actions"><Button disabled={busy} onClick={() => void viewContext(context)} variant="secondary">查看固定版本</Button><Checkbox checked={included} className="uc-chat-page__check" disabled={!viewed} onChange={(_value, checked) => setIncludedContextIds((current) => checked ? [...current, context.contextId] : current.filter((id) => id !== context.contextId))}>用于本次回复</Checkbox></div></Card>; })}</section> : null}
        {!session ? <EmptyState description="打开项目后才能登记上下文。" icon="项" readOnly title="需要目标项目" /> : !selected || selected.readOnly ? <EmptyState description="请选择当前项目中的可写对话。" icon="摘" readOnly title="不可登记" /> : completedMessages.length === 0 ? <EmptyState description="只有已完成消息可以登记。" icon="摘" readOnly title="没有可登记消息" /> : (
          <fieldset className="uc-chat-page__selection-list" disabled={busy}><legend>登记新的项目上下文</legend>{completedMessages.map((item) => <Checkbox checked={Boolean(contextDraft?.fragments.some((fragment) => fragment.messageId === item.messageId))} key={item.messageId} onChange={(_value, checked) => void toggleMessageSelection(item, checked)}><span className="uc-chat-page__selection-copy"><strong>{item.role === 'user' ? '用户' : '助手'}</strong><span className="uc-chat-page__selection-content">{item.content}</span></span></Checkbox>)}</fieldset>
        )}
        {contextDraft ? <><Card className="uc-chat-page__context-preview"><small>草稿预览 · 版本 {contextDraft.revision}</small><p>{contextDraft.contentPreview || '尚未选择内容'}</p></Card><label className="uc-chat-page__context-labels"><span>用户标签（逗号分隔）</span><Input maxLength={500} onChange={(value) => setContextLabels(value)} placeholder="例如：品牌语气，镜头约束" value={contextLabels} /></label><Button disabled={busy} onClick={() => void saveContextLabels()} variant="secondary">更新标签</Button><Checkbox checked={contextConfirmed} className="uc-chat-page__check" disabled={!contextDraft.canRegister} onChange={(_value, checked) => setContextConfirmed(checked)}>我已检查目标项目、消息内容和标签</Checkbox><Button disabled={!contextDraft.canRegister || !contextConfirmed || busy} onClick={() => void registerContext()}>确认登记到项目</Button></> : null}
        <p className="uc-chat-page__notice">查看上下文不会自动用于回复；只有显式勾选的固定版本会进入本次外发快照。</p>
      </aside>
    </section>
  );
}
