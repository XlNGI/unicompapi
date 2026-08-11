import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArrowUp,
  LuBrainCircuit,
  LuCheck,
  LuChevronDown,
  LuCopy,
  LuMessagesSquare,
  LuPanelRight,
  LuSquare,
  LuTrash2
} from 'react-icons/lu';
import { Checkbox, Drawer, Input, Modal, Tooltip, Whisper } from 'rsuite';
import { ActionMenu } from '../../components/ActionMenu';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ModelSelect } from '../../components/ModelSelect';
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

function describeChatError(error: {
  readonly code: ChatContextIpcErrorCode;
  readonly message: string;
}): string {
  if (
    error.code === 'storage_error' &&
    /max_tokens|parameter|invalid/i.test(error.message)
  ) {
    return '参数无效（例如 max_tokens 过大），请调小后重试。';
  }
  return errorMessages[error.code] ?? error.message;
}

const messageStateLabels: Record<MessageDto['state'], string> = {
  pending: '等待响应',
  streaming: '接收中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

function messageStatusLabel(message: MessageDto): string {
  if (message.state === 'failed' && message.failureReason === 'truncated') {
    return '已截断';
  }
  return messageStateLabels[message.state];
}

function messageStatusTone(
  message: MessageDto
): 'danger' | 'warning' | 'info' | 'neutral' {
  if (message.state === 'failed' && message.failureReason === 'truncated') return 'warning';
  if (message.state === 'failed') return 'danger';
  if (message.state === 'streaming' || message.state === 'pending') return 'warning';
  if (message.state === 'completed') return 'info';
  return 'neutral';
}

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

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatExecutionDuration(startValue: string, endValue: string): string {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remainingSeconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function contextDisplayName(labels: readonly string[]): string {
  return labels[0] ?? '未命名上下文';
}

function contextDisplayTags(labels: readonly string[]): string {
  return labels.slice(1).join('、');
}

function composeContextLabels(name: string, tags: string): readonly string[] {
  const values = [
    name.trim(),
    ...tags.split(/[,，]/).map((label) => label.trim())
  ].filter(Boolean);
  const unique = new Map<string, string>();
  values.forEach((label) => {
    const key = label.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, label);
  });
  return [...unique.values()].slice(0, 20);
}

function conversationTitleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > 36
    ? `${characters.slice(0, 36).join('')}…`
    : normalized;
}

function conversationGroupLabel(updatedAt: string): string {
  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.getTime())) return '更早';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const updatedDay = new Date(updated.getFullYear(), updated.getMonth(), updated.getDate()).getTime();
  const days = Math.floor((today - updatedDay) / 86_400_000);
  if (days <= 0) return '今天';
  if (days <= 7) return '7 天内';
  if (days <= 30) return '30 天内';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit'
  }).format(updated);
}

type DeleteTarget =
  | { readonly kind: 'conversation'; readonly value: ConversationDto }
  | { readonly kind: 'context'; readonly value: ProjectContextCandidateDto };

interface ChatPageProps {
  readonly newConversationRequest?: number;
}

export function ChatPage({ newConversationRequest = 0 }: ChatPageProps) {
  const chat = window.unicomp?.chatContexts;
  const storage = window.unicomp?.storage;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [conversations, setConversations] = useState<readonly ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renamingConversationId, setRenamingConversationId] = useState<string>();
  const [input, setInput] = useState('');
  const [responseFeature, setResponseFeature] = useState<'text_chat' | 'text_reasoning'>('text_chat');
  const [, setResponseDraft] = useState<ConversationResponseDraftDto>();
  const [responseCandidates, setResponseCandidates] = useState<readonly ConversationResponseCandidateDto[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [modelSearch, setModelSearch] = useState('');
  const [activityExpanded, setActivityExpanded] = useState(true);
  const [responseExecution, setResponseExecution] = useState<ConversationResponseExecutionDto>();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [contextDraft, setContextDraft] = useState<ProjectContextDraftPreviewDto>();
  const [contextName, setContextName] = useState('');
  const [contextLabels, setContextLabels] = useState('');
  const [registeredContexts, setRegisteredContexts] = useState<readonly ProjectContextCandidateDto[]>([]);
  const [viewedContexts, setViewedContexts] = useState<Record<string, ProjectContextDetailDto>>({});
  const [includedContextIds, setIncludedContextIds] = useState<readonly string[]>([]);
  const [contextTab, setContextTab] = useState<'selected' | 'library'>('selected');
  const [contextOpen, setContextOpen] = useState(false);
  const [contextSearch, setContextSearch] = useState('');
  const [renamingContextId, setRenamingContextId] = useState<string>();
  const [contextRename, setContextRename] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const cancelRequestedRef = useRef(false);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === selectedId),
    [conversations, selectedId]
  );
  const renamingConversation = conversations.find(
    (conversation) => conversation.conversationId === renamingConversationId
  );
  const selectedCandidate = responseCandidates.find(
    (candidate) => candidate.candidateId === selectedCandidateId
  );
  const featureCandidates = responseCandidates.filter(
    (candidate) => candidate.parameterSchema.productFeature === responseFeature
  );
  const filteredModelCandidates = featureCandidates.filter((candidate) => {
    const keyword = modelSearch.trim().toLocaleLowerCase();
    if (!keyword) return true;
    return `${candidate.modelName} ${candidate.providerName} ${candidate.connectionName}`
      .toLocaleLowerCase()
      .includes(keyword);
  });
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
  const duplicateIncludedContexts = useMemo(() => {
    const included = registeredContexts.filter((context) =>
      includedContextIds.includes(context.contextId)
    );
    if (included.length < 2) return false;
    const previews = included.map((context) => context.contentPreview.trim());
    return new Set(previews).size < included.length;
  }, [registeredContexts, includedContextIds]);
  const selectedContexts = registeredContexts.filter((context) =>
    includedContextIds.includes(context.contextId)
  );
  const filteredContexts = registeredContexts.filter((context) => {
    const keyword = contextSearch.trim().toLocaleLowerCase();
    if (!keyword) return true;
    return `${context.labels.join(' ')} ${context.contentPreview}`
      .toLocaleLowerCase()
      .includes(keyword);
  });
  const conversationGroups = useMemo(() => {
    const groups = new Map<string, ConversationDto[]>();
    conversations.forEach((conversation) => {
      const label = conversationGroupLabel(conversation.updatedAt);
      const group = groups.get(label) ?? [];
      group.push(conversation);
      groups.set(label, group);
    });
    return [...groups.entries()];
  }, [conversations]);
  const responseInProgress = Boolean(
    responseExecution && ['pending', 'streaming'].includes(responseExecution.state)
  );
  const canCompose = Boolean(
    session && (!selected || (!selected.readOnly && selected.status === 'active'))
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
          chat.listConversations(false, false)
        ]);
        if (!active) return;
        if (sessionResult.ok) setSession(sessionResult.value);
        else setNotice('读取当前项目失败，请重试。');
        if (conversationResult.ok) {
          setConversations(conversationResult.value);
          setSelectedId((current) =>
            current && conversationResult.value.some((item) => item.conversationId === current)
              ? current
              : undefined
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
    setContextName('');
    setContextLabels('');
    clearResponseDraftState();
  }, [selected?.conversationId, selected?.title]);

  useEffect(() => {
    let active = true;
    async function loadCandidates() {
      if (
        !chat ||
        !session ||
        (selected && (selected.readOnly || selected.status !== 'active'))
      ) {
        setResponseCandidates([]);
        return;
      }
      setCandidatesLoading(true);
      try {
        const [chatResult, reasoningResult] = await Promise.all([
          chat.listTextCandidates('text_chat'),
          chat.listTextCandidates('text_reasoning')
        ]);
        if (!active) return;
        if (!chatResult.ok && !reasoningResult.ok) {
          setResponseCandidates([]);
          setNotice(errorMessages[chatResult.error.code]);
          return;
        }
        const candidates = [
          ...(chatResult.ok ? chatResult.value : []),
          ...(reasoningResult.ok ? reasoningResult.value : [])
        ];
        const candidatesById = new Map<string, ConversationResponseCandidateDto>();
        candidates.forEach((candidate) => {
          candidatesById.set(candidate.candidateId, candidate);
        });
        const distinctCandidates = [...candidatesById.values()];
        setResponseCandidates(distinctCandidates);
        setSelectedCandidateId((current) =>
          current && distinctCandidates.some((item) => item.candidateId === current)
            ? current
            : undefined
        );
        if (distinctCandidates.length === 0) {
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
  }, [chat, session, selected?.conversationId, selected?.readOnly, selected?.status]);

  useEffect(() => {
    if (
      !chat ||
      !responseExecution ||
      cancelRequested ||
      !['pending', 'streaming'].includes(responseExecution.state)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void chat.getResponseExecution(responseExecution.responseExecutionId).then((result) => {
        if (!result.ok || cancelRequestedRef.current) return;
        setResponseExecution(result.value);
        if (!['pending', 'streaming'].includes(result.value.state) && selectedId) {
          void chat.getConversation(selectedId).then((conversation) => {
            if (!conversation.ok) return;
            replaceConversation(conversation.value);
            const assistant = conversation.value.messages.find(
              (message) => message.messageId === result.value.assistantMessageId
            );
            if (result.value.state === 'completed') {
              setNotice('');
            } else if (
              result.value.state === 'failed' &&
              assistant?.failureReason === 'truncated'
            ) {
              setNotice(
                '回复因输出长度限制被截断。可在参数中提高 max_tokens 后重试，或减少勾选的上下文。'
              );
            } else if (result.value.state === 'failed') {
              setNotice('回复失败，请查看任务中心调用记录。');
            } else if (result.value.state === 'cancelled') {
              setNotice('回复已取消。');
            } else if (result.value.state === 'interrupted') {
              setNotice('回复被中断，请重试。');
            }
          });
        }
      });
      if (selectedId) {
        void chat.getConversation(selectedId).then((result) => {
          if (result.ok && !cancelRequestedRef.current) replaceConversation(result.value);
        });
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [cancelRequested, chat, responseExecution?.responseExecutionId, responseExecution?.state, selectedId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!input.trim()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [input]);

  useEffect(() => {
    if (newConversationRequest === 0) return;
    if (responseInProgress) {
      setNotice('请先停止当前回复，再开始新的对话。');
      return;
    }
    if (!confirmLeaveUnsentInput()) return;
    setSelectedId(undefined);
    setInput('');
    setHistoryOpen(false);
    setContextOpen(false);
    setIncludedContextIds([]);
    setContextDraft(undefined);
    setNotice(session ? '新的对话已准备好，发送第一条消息后自动保存。' : '请先打开项目。');
    clearResponseDraftState();
  }, [newConversationRequest]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  function clearResponseDraftState() {
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    setResponseDraft(undefined);
    setResponseExecution(undefined);
  }

  function changeCandidate(next: string) {
    setSelectedCandidateId(next || undefined);
    setModelSearch('');
  }

  function changeResponseFeature(next: 'text_chat' | 'text_reasoning') {
    if (next === responseFeature) return;
    const matchingCandidate = selectedCandidate
      ? responseCandidates.find((candidate) =>
        candidate.parameterSchema.productFeature === next &&
        candidate.providerName === selectedCandidate.providerName &&
        candidate.connectionName === selectedCandidate.connectionName &&
        candidate.modelName === selectedCandidate.modelName &&
        candidate.available
      )
      : undefined;
    setResponseFeature(next);
    setSelectedCandidateId(matchingCandidate?.candidateId);
    setModelSearch('');
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
    setHistoryOpen(false);
  }

  function replaceConversation(conversation: ConversationDto) {
    setConversations((items) => items.map((item) =>
      item.conversationId === conversation.conversationId ? conversation : item
    ));
  }

  async function mutateConversation(
    conversation: ConversationDto,
    operation: 'rename' | 'delete'
  ) {
    if (!chat || conversation.readOnly || busy) return;
    const nextTitle = renameTitle.trim();
    if (operation === 'rename' && (!nextTitle || nextTitle === conversation.title)) return;
    setBusy(true);
    setNotice('');
    try {
      const result = operation === 'rename'
        ? await chat.renameConversation(conversation.conversationId, conversation.revision, nextTitle)
        : await chat.deleteConversation(conversation.conversationId, conversation.revision);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      if (operation === 'delete') {
        const remaining = conversations.filter((item) => item.conversationId !== conversation.conversationId);
        setConversations(remaining);
        if (selectedId === conversation.conversationId) {
          setSelectedId(undefined);
          setInput('');
          clearResponseDraftState();
        }
        setNotice('对话已删除；已登记的项目上下文和历史固定版本保持不变。');
      } else {
        replaceConversation(result.value);
        setRenamingConversationId(undefined);
        setNotice('对话名称已更新。');
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
      !session ||
      (selected && (selected.readOnly || selected.status !== 'active')) ||
      !input.trim() ||
      !selectedCandidateId ||
      !selectedCandidate?.available ||
      cancelRequested ||
      responseInProgress ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setNotice('');
    clearResponseDraftState();
    const content = input.trim();
    try {
      let targetConversation = selected;
      if (!targetConversation) {
        const createdConversation = await chat.createConversation(
          conversationTitleFromMessage(content),
          true
        );
        if (!createdConversation.ok) {
          setNotice(errorMessages[createdConversation.error.code]);
          return;
        }
        targetConversation = createdConversation.value;
        setConversations((items) => [targetConversation!, ...items]);
        setSelectedId(targetConversation.conversationId);
      }
      const saved = await chat.addUserMessage(
        targetConversation.conversationId,
        targetConversation.revision,
        content
      );
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
        setNotice(describeChatError(created.error));
        return;
      }
      let draft = created.value;
      const parameterized = await chat.replaceResponseParameters(
        draft.responseDraftId,
        draft.revision,
        {}
      );
      if (!parameterized.ok) {
        setNotice(describeChatError(parameterized.error));
        return;
      }
      draft = parameterized.value;
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
          setNotice(describeChatError(replaced.error));
          return;
        }
        draft = replaced.value;
      }
      setResponseDraft(draft);
      if (duplicateIncludedContexts) {
        setNotice('已勾选内容重复的上下文，可能挤占输出长度。');
      }
      const prepared = await chat.prepareResponseSubmission(
        draft.responseDraftId,
        draft.revision,
        selectedCandidateId
      );
      if (!prepared.ok) {
        setNotice(describeChatError(prepared.error));
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
        setNotice(describeChatError(submitted.error));
        return;
      }
      setResponseExecution(submitted.value);
      setNotice('已发送，正在接收回复。');
      const refreshed = await chat.getConversation(targetConversation.conversationId);
      if (refreshed.ok) replaceConversation(refreshed.value);
    } catch {
      setNotice('发送失败，请重试。若状态未知，请查看任务中心调用记录。');
    } finally {
      setBusy(false);
    }
  }

  async function cancelResponse() {
    if (
      !chat ||
      !selected ||
      !responseExecution ||
      !responseInProgress ||
      busy ||
      cancelRequested
    ) return;
    const pendingExecution = responseExecution;
    const cancelledAt = new Date().toISOString();
    cancelRequestedRef.current = true;
    setCancelRequested(true);
    setResponseExecution({
      ...pendingExecution,
      state: 'cancelled',
      updatedAt: cancelledAt
    });
    setConversations((items) => items.map((conversation) =>
      conversation.conversationId === selected.conversationId
        ? {
            ...conversation,
            messages: conversation.messages.map((message) =>
              message.messageId === pendingExecution.assistantMessageId
                ? { ...message, state: 'cancelled', updatedAt: cancelledAt }
                : message
            )
          }
        : conversation
    ));
    setNotice('已发出停止请求，正在确认…');
    try {
      let expectedRevision = selected.revision;
      let result = await chat.cancelAssistantResponse(
        selected.conversationId,
        pendingExecution.assistantMessageId,
        expectedRevision
      );
      if (
        !result.ok &&
        result.error.code === 'revision_conflict' &&
        result.error.currentRevision !== undefined
      ) {
        expectedRevision = result.error.currentRevision;
        result = await chat.cancelAssistantResponse(
          selected.conversationId,
          pendingExecution.assistantMessageId,
          expectedRevision
        );
      }
      if (!result.ok) {
        setNotice(describeChatError(result.error));
        setResponseExecution(pendingExecution);
        const refreshed = await chat.getConversation(selected.conversationId);
        if (refreshed.ok) replaceConversation(refreshed.value);
        return;
      }
      replaceConversation(result.value);
      const assistant = result.value.messages.find(
        (message) => message.messageId === pendingExecution.assistantMessageId
      );
      setResponseExecution((current) => current ? {
        ...current,
        state: 'cancelled',
        content: assistant?.content ?? current.content,
        updatedAt: assistant?.updatedAt ?? current.updatedAt
      } : current);
      setNotice('回复已停止，已接收的部分内容已保留。');
    } catch {
      setNotice('停止回复失败，请重试。');
      setResponseExecution(pendingExecution);
      const refreshed = await chat.getConversation(selected.conversationId);
      if (refreshed.ok) replaceConversation(refreshed.value);
    } finally {
      cancelRequestedRef.current = false;
      setCancelRequested(false);
    }
  }

  async function copyMessage(message: MessageDto) {
    try {
      await navigator.clipboard.writeText(message.content);
      setNotice('消息内容已复制。');
    } catch {
      setNotice('复制失败，请手动选择消息内容。');
    }
  }

  async function toggleContextUsage(
    candidate: ProjectContextCandidateDto,
    include: boolean
  ) {
    if (!chat || busy || responseInProgress) return;
    if (!include) {
      setIncludedContextIds((current) =>
        current.filter((contextId) => contextId !== candidate.contextId)
      );
      setNotice('已从下一次回复移除该上下文；上下文库内容保持不变。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.getProjectContextRevision(candidate.contextId, candidate.revision);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setViewedContexts((current) => ({ ...current, [candidate.contextId]: result.value }));
      setIncludedContextIds((current) =>
        current.includes(candidate.contextId) ? current : [...current, candidate.contextId]
      );
      setNotice('该上下文将用于下一次回复。');
    } catch {
      setNotice('读取项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function deleteContext(candidate: ProjectContextCandidateDto) {
    if (!chat || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.deleteProjectContext(candidate.contextId, candidate.revision);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setRegisteredContexts((current) =>
        current.filter((context) => context.contextId !== candidate.contextId)
      );
      setIncludedContextIds((current) =>
        current.filter((contextId) => contextId !== candidate.contextId)
      );
      setViewedContexts((current) => {
        const next = { ...current };
        delete next[candidate.contextId];
        return next;
      });
      setNotice('项目上下文已删除；历史固定版本未被改写。');
    } catch {
      setNotice('删除项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function renameContext(candidate: ProjectContextCandidateDto) {
    if (!chat || !contextRename.trim() || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const current = await chat.getProjectContext(candidate.contextId);
      if (!current.ok) {
        setNotice(errorMessages[current.error.code]);
        return;
      }
      const labels = composeContextLabels(
        contextRename,
        current.value.labels.slice(1).join(',')
      );
      const result = await chat.updateProjectContext(
        candidate.contextId,
        current.value.revision,
        current.value.contentSnapshot,
        labels
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      const candidates = await chat.listProjectContextCandidates();
      if (candidates.ok) setRegisteredContexts(candidates.value);
      setViewedContexts((items) => ({ ...items, [candidate.contextId]: result.value }));
      setRenamingContextId(undefined);
      setContextRename('');
      setNotice('上下文名称已更新。');
    } catch {
      setNotice('重命名项目上下文失败，请重试。');
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
      setNotice(checked ? '消息内容已加入上下文草稿。' : '消息内容已从上下文草稿移除。');
    } catch {
      setNotice('更新上下文草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function registerContext() {
    if (
      !chat ||
      !contextDraft ||
      !contextDraft.canRegister ||
      !contextName.trim() ||
      busy
    ) return;
    setBusy(true);
    try {
      const labels = composeContextLabels(contextName, contextLabels);
      const labeled = JSON.stringify(contextDraft.labels) === JSON.stringify(labels)
        ? { ok: true as const, value: contextDraft }
        : await chat.updateContextDraftLabels(
          contextDraft.draftId,
          contextDraft.revision,
          labels
        );
      if (!labeled.ok) {
        setNotice(errorMessages[labeled.error.code]);
        return;
      }
      const result = await chat.registerContextDraft(
        labeled.value.draftId,
        labeled.value.revision,
        true
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      const candidates = await chat.listProjectContextCandidates();
      if (candidates.ok) setRegisteredContexts(candidates.value);
      setViewedContexts((current) => ({
        ...current,
        [result.value.contextId]: result.value
      }));
      setIncludedContextIds((current) =>
        current.includes(result.value.contextId)
          ? current
          : [...current, result.value.contextId]
      );
      setContextDraft(undefined);
      setContextName('');
      setContextLabels('');
      setContextTab('selected');
      setNotice('项目上下文已登记，并将用于下一次回复。');
    } catch {
      setNotice('登记项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="uc-chat-page" aria-labelledby="chat-page-title">
      <section className="uc-chat-page__conversation" aria-label="当前对话">
        <header className="uc-chat-page__header">
          <div className="uc-chat-page__title-block">
            <div className="uc-page-skeleton__heading-row">
              <Whisper placement="bottomStart" speaker={<Tooltip>{selected?.title ?? '新对话'}</Tooltip>} trigger="hover">
                <h1 className="uc-page-skeleton__title" id="chat-page-title">{selected?.title ?? '新对话'}</h1>
              </Whisper>
              {selected ? (
                <StatusPill tone={selected.readOnly ? 'warning' : 'info'}>
                  {selected.readOnly ? '旧记录只读' : '项目级'}
                </StatusPill>
              ) : null}
            </div>
            <span>{session?.projectName ? `当前项目：${session.projectName}` : '尚未打开项目'}</span>
          </div>
          <div className="uc-chat-page__header-actions">
            <Button
              aria-label="打开对话列表"
              aria-expanded={historyOpen}
              onClick={() => {
                setContextOpen(false);
                setHistoryOpen(true);
              }}
              variant="ghost"
            >
              <LuMessagesSquare aria-hidden="true" /> 对话列表
            </Button>
            <Button
              aria-label="打开项目上下文"
              aria-expanded={contextOpen}
              disabled={!session}
              onClick={() => {
                setHistoryOpen(false);
                setContextOpen(true);
              }}
              variant="ghost"
            >
              <LuPanelRight aria-hidden="true" /> 上下文
              {includedContextIds.length > 0 ? <b>{includedContextIds.length}</b> : null}
            </Button>
          </div>
        </header>

        <div className="uc-chat-page__conversation-banner">
          {selected?.readOnly ? (
            <div className="uc-chat-page__readonly-banner">
              <span>旧记录保持只读，可复制到当前项目后继续。</span>
              <Button disabled={!session || busy} onClick={() => void copyLegacyConversation()} variant="secondary">复制到当前项目</Button>
            </div>
          ) : null}
        </div>

        <div className="uc-chat-page__messages" aria-live="polite">
          <div className="uc-chat-page__messages-inner">
            {!selected ? (
              <div className="uc-chat-page__empty">
                <LuMessagesSquare aria-hidden="true" />
                <strong>开始新的对话</strong>
                <p>选择模型并发送第一条消息，名称将自动生成。</p>
              </div>
            ) : displayMessages.length === 0 ? (
              <div className="uc-chat-page__empty">
                <LuMessagesSquare aria-hidden="true" />
                <strong>开始这段对话</strong>
                <p>在下方选择模型，然后发送第一条消息。</p>
              </div>
            ) : (
              <ol className="uc-chat-page__message-list">
                {displayMessages.map((item) => {
                  const isCurrentAssistant = item.role === 'assistant' &&
                    item.messageId === responseExecution?.assistantMessageId;
                  const executionDuration = responseExecution
                    ? formatExecutionDuration(responseExecution.createdAt, responseExecution.updatedAt)
                    : '';
                  const reasoningMode = responseExecution?.productFeature === 'text_reasoning';
                  const activityLabel = cancelRequested
                    ? '正在停止'
                    : responseExecution?.state === 'pending'
                      ? reasoningMode ? '正在思考' : '正在处理'
                      : responseExecution?.state === 'streaming'
                        ? reasoningMode ? '思考完成，正在回答' : '正在回答'
                        : responseExecution?.state === 'completed'
                          ? `已处理${executionDuration ? ` ${executionDuration}` : ''}`
                          : responseExecution?.state === 'cancelled'
                            ? '已停止'
                            : '处理失败';
                  return (
                    <li className={`uc-chat-page__message-item uc-chat-page__message-item--${item.role}`} key={item.messageId}>
                      {isCurrentAssistant ? (
                        <section className="uc-chat-page__activity" aria-label="AI 工作过程">
                          <button
                            aria-expanded={activityExpanded}
                            onClick={() => setActivityExpanded((expanded) => !expanded)}
                            type="button"
                          >
                            <LuBrainCircuit aria-hidden="true" />
                            <span>{activityLabel}</span>
                            <LuChevronDown aria-hidden="true" />
                          </button>
                          {activityExpanded ? (
                            <div className="uc-chat-page__activity-detail">
                              <span>{reasoningMode ? '推理模式' : '普通对话'}</span>
                              <p>
                                {cancelRequested
                                  ? '停止请求已发送，正在确认并保留已经接收的内容。'
                                  : reasoningMode
                                  ? '当前模型未通过公开接口返回可展示的思考正文。'
                                  : responseInProgress
                                    ? '模型正在生成回答，可点击输入框右侧按钮立即停止。'
                                    : '回答处理已经结束。'}
                              </p>
                            </div>
                          ) : null}
                        </section>
                      ) : null}
                      <div className="uc-chat-page__message-heading">
                        <strong>{item.role === 'user' ? '你' : '助手'}</strong>
                        {item.state !== 'completed' ? (
                          <StatusPill tone={messageStatusTone(item)}>{messageStatusLabel(item)}</StatusPill>
                        ) : null}
                      </div>
                      <p>
                        {item.content || (item.state === 'streaming' || item.state === 'pending' ? '正在接收…' : '尚无内容')}
                        {item.state === 'streaming' ? <span className="uc-chat-page__caret" aria-hidden="true">▌</span> : null}
                      </p>
                      <div className="uc-chat-page__message-meta">
                        <time dateTime={item.createdAt}>{formatMessageTime(item.createdAt)}</time>
                        {item.content ? (
                          <button aria-label="复制消息" onClick={() => void copyMessage(item)} title="复制" type="button">
                            <LuCopy aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>

        <div className="uc-chat-page__composer-region">
          <section className="uc-chat-page__composer" aria-labelledby="chat-composer-title">
            <h2 className="uc-visually-hidden" id="chat-composer-title">发送消息</h2>
            <textarea
              aria-label="对话输入"
              disabled={!canCompose}
              maxLength={8000}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!responseInProgress && !cancelRequested) void sendMessage();
                }
              }}
              placeholder={!session ? '请先打开项目' : selectedCandidate ? '随心输入，Enter 发送，Shift + Enter 换行' : '先选择模型，再输入内容发送'}
              ref={composerRef}
              rows={1}
              value={input}
            />
            <div className="uc-chat-page__composer-toolbar">
              <div className="uc-chat-page__composer-actions">
                <ModelSelect
                  appearance="subtle"
                  ariaLabel="模型设置"
                  className="uc-chat-page__model-tool"
                  disabled={!canCompose || busy || cancelRequested || responseInProgress}
                  label="选择模型"
                  listboxHeader={(
                    <div className="uc-chat-page__model-picker-header">
                      <section className="uc-chat-page__reply-mode-section">
                        <div className="uc-chat-page__model-menu-heading">
                          <span>回复方式</span>
                        </div>
                        <div aria-label="选择回复方式" className="uc-chat-page__reply-mode" role="radiogroup">
                          <button
                            aria-checked={responseFeature === 'text_chat'}
                            onClick={() => changeResponseFeature('text_chat')}
                            role="radio"
                            type="button"
                          >
                            <strong>普通对话</strong>
                            <small>响应更快，适合日常问答与创作</small>
                          </button>
                          <button
                            aria-checked={responseFeature === 'text_reasoning'}
                            onClick={() => changeResponseFeature('text_reasoning')}
                            role="radio"
                            type="button"
                          >
                            <strong>深度推理</strong>
                            <small>适合复杂分析，响应时间可能更长</small>
                          </button>
                        </div>
                      </section>
                      <section className="uc-chat-page__model-list-section">
                        <div className="uc-chat-page__model-menu-heading">
                          <span>选择模型</span>
                          <small>{featureCandidates.filter((candidate) => candidate.available).length} 个可用</small>
                        </div>
                        <Input
                          aria-label="搜索文本模型"
                          onChange={setModelSearch}
                          placeholder="搜索模型或服务商"
                          value={modelSearch}
                        />
                      </section>
                    </div>
                  )}
                  listboxMaxHeight={250}
                  noResultsText={candidatesLoading
                    ? '正在加载可用模型…'
                    : modelSearch
                      ? '没有匹配的模型'
                      : `暂无支持${responseFeature === 'text_reasoning' ? '深度推理' : '普通对话'}的模型`}
                  onChange={changeCandidate}
                  onClose={() => setModelSearch('')}
                  options={filteredModelCandidates.map((candidate) => ({
                    id: candidate.candidateId,
                    label: candidate.modelName,
                    available: candidate.available,
                    providerName: candidate.providerName,
                    connectionName: candidate.connectionName,
                    unavailableReasons: candidate.unavailableReasons
                  }))}
                  placeholder={(
                    <span className="uc-chat-page__model-value">
                      <span>{candidatesLoading ? '加载模型…' : '选择模型'}</span>
                      <small>{responseFeature === 'text_reasoning' ? '推理' : '普通'}</small>
                    </span>
                  )}
                  popupClassName="uc-chat-page__model-picker-popup"
                  reasonLabels={unavailableLabels}
                  renderValue={(option) => (
                    <span className="uc-chat-page__model-value">
                      <span>{option.label}</span>
                      <small>{responseFeature === 'text_reasoning' ? '推理' : '普通'}</small>
                    </span>
                  )}
                  searchable={false}
                  showEmptyState={false}
                  value={selectedCandidateId ?? ''}
                />
                {input.length >= 7000 ? <span className="uc-chat-page__composer-count">{input.length} / 8000</span> : null}
                <button
                  aria-label={responseInProgress ? cancelRequested ? '正在停止生成' : '停止生成' : '发送消息'}
                  className={`uc-chat-page__submit${responseInProgress ? ' uc-chat-page__submit--stop' : ''}`}
                  disabled={responseInProgress ? busy || cancelRequested : (!chat || !canCompose || !input.trim() || !selectedCandidate?.available || busy || cancelRequested)}
                  onClick={() => responseInProgress ? void cancelResponse() : void sendMessage()}
                  title={responseInProgress ? cancelRequested ? '正在停止' : '停止生成' : '发送'}
                  type="button"
                >
                  {responseInProgress ? <LuSquare aria-hidden="true" /> : <LuArrowUp aria-hidden="true" />}
                </button>
              </div>
            </div>
          </section>
          {selected && !canCompose && session ? <p className="uc-chat-page__notice">当前对话不可写，请从对话列表选择其他记录。</p> : null}
          {canCompose && featureCandidates.length === 0 && !candidatesLoading ? (
            <p className="uc-chat-page__notice">当前回复方式没有可选模型。请切换回复方式，或到「模型与服务商」添加并启用兼容模型。</p>
          ) : null}
        </div>
        <p className="uc-chat-page__message" aria-live="polite">{notice}</p>
      </section>

      <Drawer
        className="uc-chat-page__side-drawer uc-chat-page__history-drawer"
        onClose={() => setHistoryOpen(false)}
        open={historyOpen}
        placement="right"
        size="xs"
      >
        <Drawer.Header>
          <Drawer.Title>对话列表</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body>
          {loading ? (
            <EmptyState busy description="正在读取本地对话历史。" icon="读" title="读取中" />
          ) : conversations.length === 0 ? (
            <EmptyState description="发送第一条消息后，对话会自动保存在这里。" icon="对" title="暂无历史对话" />
          ) : (
            <div className="uc-chat-page__history-list">
              {conversationGroups.map(([label, items]) => (
                <section className="uc-chat-page__history-group" key={label}>
                  <h3>{label}</h3>
                  {items.map((conversation) => (
                    <div
                      aria-current={conversation.conversationId === selectedId ? 'true' : undefined}
                      className="uc-chat-page__history-row"
                      key={conversation.conversationId}
                    >
                      <Whisper
                        placement="left"
                        speaker={<Tooltip>{conversation.title}</Tooltip>}
                        trigger="hover"
                      >
                        <button
                          className="uc-chat-page__history-item"
                          onClick={() => {
                            selectConversation(conversation.conversationId);
                            setHistoryOpen(false);
                          }}
                          type="button"
                        >
                          <strong>{conversation.title}</strong>
                        </button>
                      </Whisper>
                      {!conversation.readOnly ? (
                        <ActionMenu
                          ariaLabel={`管理对话：${conversation.title}`}
                          className="uc-chat-page__history-menu"
                          items={[
                            { key: 'rename', label: '重命名' },
                            {
                              key: 'delete',
                              label: '删除',
                              icon: <LuTrash2 aria-hidden="true" />,
                              danger: true,
                              separatorBefore: true
                            }
                          ]}
                          onSelect={(eventKey) => {
                            if (eventKey === 'rename') {
                              setRenameTitle(conversation.title);
                              setRenamingConversationId(conversation.conversationId);
                              return;
                            }
                            if (eventKey === 'delete') {
                              setDeleteTarget({ kind: 'conversation', value: conversation });
                            }
                          }}
                          toggleClassName="uc-chat-page__icon-button"
                        />
                      ) : null}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </Drawer.Body>
      </Drawer>

      <Modal
        className="uc-chat-page__rename-dialog"
        onClose={() => setRenamingConversationId(undefined)}
        open={Boolean(renamingConversation)}
        size="xs"
      >
        <Modal.Header>
          <Modal.Title>重命名对话</Modal.Title>
        </Modal.Header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (renamingConversation) void mutateConversation(renamingConversation, 'rename');
          }}
        >
          <Modal.Body>
            <Input
              aria-label="对话名称"
              autoFocus
              maxLength={200}
              onChange={setRenameTitle}
              value={renameTitle}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button disabled={busy || !renameTitle.trim()} type="submit">保存</Button>
            <Button disabled={busy} onClick={() => setRenamingConversationId(undefined)} variant="secondary">取消</Button>
          </Modal.Footer>
        </form>
      </Modal>

      <Drawer
        className="uc-chat-page__side-drawer uc-chat-page__context-drawer"
        onClose={() => setContextOpen(false)}
        open={contextOpen}
        placement="right"
        size="xs"
      >
        <Drawer.Header>
          <Drawer.Title>项目上下文</Drawer.Title>
          <span className="uc-chat-page__drawer-subtitle">{session?.projectName ?? '尚未打开项目'}</span>
        </Drawer.Header>
        <Drawer.Body>
          <div className="uc-chat-page__context">
            <Card className="uc-chat-page__context-target">
              <small>目标项目</small>
              <strong>{session?.projectName ?? '尚未打开项目'}</strong>
              <span>上下文库 {registeredContexts.length} 项 · 本次使用 {includedContextIds.length} 项</span>
            </Card>
            <div className="uc-chat-page__context-tabs" role="tablist" aria-label="上下文视图">
              <button aria-selected={contextTab === 'selected'} onClick={() => setContextTab('selected')} role="tab" type="button">本次使用 {includedContextIds.length}</button>
              <button aria-selected={contextTab === 'library'} onClick={() => setContextTab('library')} role="tab" type="button">上下文库</button>
            </div>

            {contextTab === 'selected' ? (
              <section className="uc-chat-page__response-contexts" aria-label="本次使用的上下文">
                {duplicateIncludedContexts ? <p className="uc-chat-page__notice">选择了内容相同的多项上下文，可能挤占输出长度。</p> : null}
                {selectedContexts.length === 0 ? (
                  <EmptyState description="到上下文库勾选需要用于下一次回复的内容。" icon="引" readOnly title="本次没有使用上下文" />
                ) : selectedContexts.map((context) => {
                  const viewed = viewedContexts[context.contextId];
                  return (
                    <Card key={context.contextId}>
                      <div><strong>{contextDisplayName(context.labels)}</strong></div>
                      {contextDisplayTags(context.labels) ? <small>标签：{contextDisplayTags(context.labels)}</small> : null}
                      <p>{viewed?.contentSnapshot ?? context.contentPreview}</p>
                      <Button disabled={busy || responseInProgress} onClick={() => void toggleContextUsage(context, false)} variant="secondary">从本次移除</Button>
                    </Card>
                  );
                })}
                <p className="uc-chat-page__notice">这里只控制下一次发送；从本次移除不会删除上下文库内容。</p>
              </section>
            ) : (
              <>
                <Input aria-label="搜索项目上下文" onChange={(value) => setContextSearch(value)} placeholder="搜索名称、标签或内容" value={contextSearch} />
                <section className="uc-chat-page__response-contexts" aria-label="项目上下文库">
                  {filteredContexts.length === 0 ? (
                    <EmptyState description={registeredContexts.length ? '没有匹配的上下文。' : '可从当前对话的已完成消息登记。'} icon="库" readOnly title={registeredContexts.length ? '未找到' : '上下文库为空'} />
                  ) : filteredContexts.map((context) => {
                    const viewed = viewedContexts[context.contextId];
                    const included = includedContextIds.includes(context.contextId);
                    return (
                      <Card className="uc-chat-page__context-library-card" key={context.contextId}>
                        <div className="uc-chat-page__context-card-heading">
                          <button
                            aria-pressed={included}
                            className="uc-chat-page__context-use"
                            disabled={busy || responseInProgress}
                            onClick={() => void toggleContextUsage(context, !included)}
                            type="button"
                          >
                            <span aria-hidden="true" className="uc-chat-page__context-checkbox">{included ? <LuCheck /> : null}</span>
                            <span>
                              <strong>{contextDisplayName(context.labels)}</strong>
                              <small>{included ? '将用于下一次回复' : '点击用于下一次回复'}</small>
                            </span>
                          </button>
                          <ActionMenu
                            ariaLabel={`管理上下文：${contextDisplayName(context.labels)}`}
                            className="uc-chat-page__context-card-menu-wrap"
                            items={[
                              { key: 'rename', label: '重命名' },
                              {
                                key: 'delete',
                                label: '从上下文库删除',
                                danger: true,
                                separatorBefore: true
                              }
                            ]}
                            onSelect={(eventKey) => {
                              if (eventKey === 'rename') {
                                setRenamingContextId(context.contextId);
                                setContextRename(contextDisplayName(context.labels) === '未命名上下文' ? '' : contextDisplayName(context.labels));
                                return;
                              }
                              if (eventKey === 'delete') {
                                setDeleteTarget({ kind: 'context', value: context });
                              }
                            }}
                            toggleClassName="uc-chat-page__icon-button"
                          />
                        </div>
                        {contextDisplayTags(context.labels) ? <small>标签：{contextDisplayTags(context.labels)}</small> : null}
                        <p>{viewed?.contentSnapshot ?? context.contentPreview}</p>
                        {renamingContextId === context.contextId ? (
                          <div className="uc-chat-page__context-rename">
                            <Input
                              aria-label="上下文名称"
                              autoFocus
                              maxLength={40}
                              onChange={setContextRename}
                              placeholder="输入上下文名称"
                              value={contextRename}
                            />
                            <Button disabled={busy || !contextRename.trim()} onClick={() => void renameContext(context)} variant="secondary">保存</Button>
                            <Button disabled={busy} onClick={() => {
                              setRenamingContextId(undefined);
                              setContextRename('');
                            }} variant="ghost">取消</Button>
                          </div>
                        ) : null}
                      </Card>
                    );
                  })}
                </section>

                <section className="uc-chat-page__context-register" aria-labelledby="context-register-title">
                  <h3 id="context-register-title">登记新的项目上下文</h3>
                  {!session ? (
                    <EmptyState description="打开项目后才能登记上下文。" icon="项" readOnly title="需要目标项目" />
                  ) : !selected || selected.readOnly ? (
                    <EmptyState description="请选择当前项目中的可写对话。" icon="摘" readOnly title="不可登记" />
                  ) : completedMessages.length === 0 ? (
                    <EmptyState description="只有已完成消息可以登记。" icon="摘" readOnly title="没有可登记消息" />
                  ) : (
                    <fieldset className="uc-chat-page__selection-list" disabled={busy}>
                      <legend>选择要沉淀的消息</legend>
                      {completedMessages.map((item) => (
                        <Checkbox
                          checked={Boolean(contextDraft?.fragments.some((fragment) => fragment.messageId === item.messageId))}
                          key={item.messageId}
                          onChange={(_value, checked) => void toggleMessageSelection(item, checked)}
                        >
                          <span className="uc-chat-page__selection-copy">
                            <strong>{item.role === 'user' ? '用户' : '助手'}</strong>
                            <span className="uc-chat-page__selection-content">{item.content}</span>
                          </span>
                        </Checkbox>
                      ))}
                    </fieldset>
                  )}
                  {contextDraft ? (
                    <>
                      <Card className="uc-chat-page__context-preview">
                        <small>草稿预览</small>
                        <p>{contextDraft.contentPreview || '尚未选择内容'}</p>
                      </Card>
                      <label className="uc-chat-page__context-labels">
                        <span>上下文名称</span>
                        <Input
                          maxLength={40}
                          onChange={setContextName}
                          placeholder="例如：品牌语气与镜头约束"
                          value={contextName}
                        />
                      </label>
                      <details className="uc-chat-page__context-optional">
                        <summary>添加标签（可选）</summary>
                        <label className="uc-chat-page__context-labels">
                          <span>使用逗号分隔多个标签</span>
                          <Input
                            maxLength={500}
                            onChange={setContextLabels}
                            placeholder="例如：品牌、短视频、人物设定"
                            value={contextLabels}
                          />
                        </label>
                      </details>
                      <Button disabled={!contextDraft.canRegister || !contextName.trim() || busy} onClick={() => void registerContext()}>登记并用于本次回复</Button>
                    </>
                  ) : null}
                </section>
                <p className="uc-chat-page__notice">只有明确勾选的上下文会用于下一次回复；删除上下文库内容不会改写历史回复。</p>
              </>
            )}
          </div>
        </Drawer.Body>
      </Drawer>

      <Modal
        className="uc-chat-page__delete-dialog"
        onClose={() => setDeleteTarget(undefined)}
        open={Boolean(deleteTarget)}
        role="alertdialog"
        size="xs"
      >
        <Modal.Header>
          <Modal.Title>{deleteTarget?.kind === 'conversation' ? '删除这段对话？' : '删除这项上下文？'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>
            {deleteTarget?.kind === 'conversation'
              ? `「${deleteTarget.value.title}」将从历史对话中删除。已登记的项目上下文不会随之删除。`
              : '该项将从项目上下文库删除；历史对话里已经固定的引用版本不会被改写。'}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button disabled={busy} onClick={() => setDeleteTarget(undefined)} variant="secondary">取消</Button>
          <Button
            className="uc-chat-page__delete-confirm"
            disabled={busy || !deleteTarget}
            onClick={() => {
              const target = deleteTarget;
              setDeleteTarget(undefined);
              if (!target) return;
              if (target.kind === 'conversation') void mutateConversation(target.value, 'delete');
              else void deleteContext(target.value);
            }}
          >
            确认删除
          </Button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}
