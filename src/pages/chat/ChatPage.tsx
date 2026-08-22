import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArchive,
  LuArchiveRestore,
  LuArrowDown,
  LuArrowUp,
  LuBrainCircuit,
  LuCheck,
  LuChevronDown,
  LuCopy,
  LuFileText,
  LuMessageSquarePlus,
  LuMessagesSquare,
  LuPaperclip,
  LuPanelRight,
  LuPencil,
  LuSquare,
  LuTrash2,
  LuX
} from 'react-icons/lu';
import { Checkbox, Drawer, Input, Modal, Tooltip, Whisper } from 'rsuite';
import { ActionMenu } from '../../components/ActionMenu';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { ModelSelect } from '../../components/ModelSelect';
import { StatusPill } from '../../components/StatusPill';
import type {
  ChatContextIpcErrorCode,
  ConversationDto,
  ConversationResponseCandidateDto,
  ConversationResponseExecutionDto,
  ConversationResponseStreamEventDto,
  MessageDto,
  ProjectContextCandidateDto,
  ProjectContextDetailDto,
  ProjectContextDraftPreviewDto
} from '../../shared/chat-context-ipc';
import type { StorageProjectSessionDto } from '../../shared/storage-ipc';
import type { DocumentExtractionStatus } from '../../shared/document-attachment-ipc';
import type { DocumentThemeColorsDto } from '../../shared/document-attachment-ipc';
import {
  composeDocumentRevisionInput,
  extractSectionHeadings,
  inferDocumentKind,
  type DocumentKindOption
} from './documentDrafting';
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
  response_execution_not_active: '当前回复没有可控制的活动请求，请刷新后确认状态。',
  response_execution_in_progress: '该会话已有回复正在进行，请等待完成或先停止。',
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
  message_not_editable: '只有最后一次已停止回复对应的用户消息可以编辑。',
  message_revision_changed: '消息内容已变化，请重新选择。',
  selection_out_of_range: '所选消息范围已经失效。',
  revision_conflict: '内容已在其他位置更新，请刷新后重试。',
  explicit_confirmation_required: '请先明确确认预览。',
  adapter_unavailable: '文本适配器当前不可用。',
  storage_error: '本地保存失败，请检查存储状态后重试。'
};

const documentErrorMessages: Record<string, string> = {
  invalid_request: '当前操作数据无效。',
  project_not_open: '请先打开项目。',
  conversation_not_found: '该对话已不存在。',
  conversation_not_active: '请先恢复已归档对话。',
  revision_conflict: '内容已变化，请重试。',
  invalid_outline: '文档大纲无效，请调整需求后重试。',
  generation_failed: '文档生成失败，请重试。',
  ai_images_unavailable: 'AI 配图执行器尚未接入，请先关闭“AI 配图”开关。',
  work_not_found: '文档作品不存在。',
  file_unavailable: '文档文件不可用。',
  storage_error: '本地保存失败，请检查存储状态。'
};

const documentKindOptions: readonly {
  readonly value: DocumentKindOption;
  readonly label: string;
}[] = [
  { value: 'auto', label: '自动' },
  { value: 'word', label: 'Word' },
  { value: 'excel', label: 'Excel' },
  { value: 'ppt', label: 'PPT' }
];

const documentThemeOptions: readonly {
  readonly value: 'blueprint' | 'ink' | 'forest';
  readonly label: string;
}[] = [
  { value: 'blueprint', label: '商务蓝' },
  { value: 'ink', label: '墨色' },
  { value: 'forest', label: '松绿' }
];

function rendererTrace(message: string, detail?: unknown): void {
  if (!import.meta.env.DEV) return;
  console.info('[chat-page]', message, detail ?? '');
}

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
  if (message.state === 'failed' && message.content.trim()) {
    return '已中断';
  }
  return messageStateLabels[message.state];
}

function failedResponseNotice(message?: MessageDto, safeCode?: string): string {
  const partial = Boolean(message?.content.trim());
  const preserved = partial ? '，已保留接收到的内容' : '';
  const diagnostic = safeCode ? `（${safeCode}）` : '';
  if (safeCode?.includes('finish.content_filter')) {
    return `回答被模型安全策略提前结束${diagnostic}${preserved}。请调整问题后重试。`;
  }
  if (safeCode?.includes('finish.tool_calls')) {
    return `模型请求调用工具，但当前会话未配置该工具${diagnostic}${preserved}。请调整问题后重试。`;
  }
  if (safeCode?.includes('finish.insufficient_system_resource')) {
    return `模型服务资源不足${diagnostic}${preserved}。请稍后重试或切换模型。`;
  }
  if (message?.failureReason === 'truncated') {
    return `回答达到当前输出长度上限${preserved}。可以继续追问，或调整输出长度后重试。`;
  }
  if (message?.failureReason === 'interrupted') {
    return `模型连接中断${preserved}，请检查网络后重试。`;
  }
  if (message?.failureReason === 'invalid_response') {
    return `模型返回的数据格式异常${preserved}，请重试或切换模型。`;
  }
  if (message?.failureReason === 'unavailable') {
    return `模型连接超时或服务暂时不可用${preserved}，请稍后重试或切换模型。`;
  }
  return `模型请求未正常完成${diagnostic}${preserved}，请重试。`;
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

function findEditableCancelledUserMessage(
  conversation?: ConversationDto
): MessageDto | undefined {
  if (!conversation || conversation.readOnly || conversation.status !== 'active') {
    return undefined;
  }
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role !== 'user') continue;
    const following = conversation.messages.slice(index + 1);
    return message.state === 'completed' &&
      following.length > 0 &&
      following.every((item) => item.role === 'assistant' && item.state === 'cancelled')
      ? message
      : undefined;
  }
  return undefined;
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
  readonly initialConversationId?: string;
  readonly onConversationChange?: (conversationId?: string) => void;
  readonly initialCandidateId?: string;
  readonly onCandidateChange?: (candidateId?: string) => void;
  readonly onOpenLibrary?: () => void;
}

function formatBytes(value?: number): string {
  if (value === undefined) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function documentKindLabel(kind: 'word' | 'excel' | 'ppt'): string {
  return kind === 'word' ? 'Word 文档' : kind === 'excel' ? 'Excel 表格' : 'PPT 演示';
}

function isImageFileName(fileName: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(fileName);
}

function canAutoGenerateImageCandidate(candidate: {
  readonly parameterSchema: {
    readonly fields: readonly {
      readonly required: boolean;
      readonly defaultPolicy: string;
    }[];
  };
}): boolean {
  return candidate.parameterSchema.fields.every(
    (field) =>
      !field.required || field.defaultPolicy !== 'require_user_value'
  );
}

function describeDocumentError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  return `${documentErrorMessages[error.code] ?? error.message}（${error.code}）`;
}

interface AttachmentDraft {
  readonly fileId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly status: DocumentExtractionStatus;
  readonly preview: string;
}

export function ChatPage({
  initialConversationId,
  onConversationChange,
  initialCandidateId,
  onCandidateChange,
  onOpenLibrary
}: ChatPageProps) {
  const chat = window.unicomp?.chatContexts;
  const documentGeneration = window.unicomp?.documentGeneration;
  const documentAttachments = window.unicomp?.documentAttachments;
  const imageFeatures = window.unicomp?.imageFeatures;
  const storage = window.unicomp?.storage;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [conversations, setConversations] = useState<readonly ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialConversationId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renamingConversationId, setRenamingConversationId] = useState<string>();
  const [input, setInput] = useState('');
  const [documentMode, setDocumentMode] = useState(false);
  const [documentKind, setDocumentKind] = useState<DocumentKindOption>('auto');
  const [documentTheme, setDocumentTheme] = useState<
    'blueprint' | 'ink' | 'forest'
  >('blueprint');
  const [aiImagesEnabled, setAiImagesEnabled] = useState(false);
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [templateFileId, setTemplateFileId] = useState<string>();
  const [templateColors, setTemplateColors] = useState<DocumentThemeColorsDto>();
  const [dragging, setDragging] = useState(false);
  const [responseFeature, setResponseFeature] = useState<'text_chat' | 'text_reasoning'>('text_chat');
  const [responseCandidates, setResponseCandidates] = useState<readonly ConversationResponseCandidateDto[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | undefined>(initialCandidateId);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [responseExecution, setResponseExecution] = useState<ConversationResponseExecutionDto>();
  const [responseStarting, setResponseStarting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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
  const messagesRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const cancelAfterStartRef = useRef(false);
  const inputValueRef = useRef('');
  const followOutputRef = useRef(true);
  const responseExecutionSnapshotRef = useRef(responseExecution);
  responseExecutionSnapshotRef.current = responseExecution;

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
  const editableCancelledUserMessage = useMemo(
    () => findEditableCancelledUserMessage(selected),
    [selected]
  );
  const featureCandidates = responseCandidates.filter(
    (candidate) => candidate.parameterSchema.productFeature === responseFeature
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
        reasoningContent: responseExecution.reasoningContent || message.reasoningContent,
        content: responseExecution.content || message.content
      };
    });
  }, [selected, responseExecution]);
  const lastDisplayMessage = displayMessages[displayMessages.length - 1];
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
    responseStarting ||
    (responseExecution && ['pending', 'streaming'].includes(responseExecution.state))
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
          chat.listConversations(true, false)
        ]);
        if (!active) return;
        if (sessionResult.ok) {
          setSession(sessionResult.value);
          if (sessionResult.value) {
            setNotice((current) => current === '请先打开项目。' ? '' : current);
          }
        }
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
    onConversationChange?.(selectedId);
  }, [onConversationChange, selectedId]);

  useEffect(() => {
    onCandidateChange?.(selectedCandidateId);
  }, [onCandidateChange, selectedCandidateId]);

  useEffect(() => {
    setRenameTitle(selected?.title ?? '');
  }, [selected?.title]);

  useEffect(() => {
    const activeConversationId = responseExecutionSnapshotRef.current?.conversationId;
    const keepActiveResponse = Boolean(
      activeConversationId &&
      activeConversationId === selected?.conversationId
    );
    rendererTrace('effect:conversation-change', {
      selectedConversationId: selected?.conversationId,
      activeConversationId,
      keepActiveResponse
    });
    if (!keepActiveResponse) {
      setContextDraft(undefined);
      setContextName('');
      setContextLabels('');
      setEditingMessageId(undefined);
      clearResponseDraftState();
    }
    followOutputRef.current = true;
    setShowScrollToBottom(false);
  }, [selected?.conversationId]);

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
        setSelectedCandidateId((current) => {
          const candidate = current
            ? distinctCandidates.find((item) => item.candidateId === current)
            : undefined;
          return candidate?.available ? candidate.candidateId : undefined;
        });
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
    const execution = responseExecutionSnapshotRef.current;
    if (!chat || !execution || !['pending', 'streaming'].includes(execution.state)) {
      return;
    }
    rendererTrace('effect:response-subscription-setup', {
      executionId: execution.responseExecutionId,
      state: execution.state,
      streamSequence: execution.streamSequence
    });
    let active = true;
    let terminalReceived = false;
    let animationFrame: number | undefined;
    let unsubscribe: (() => void) | undefined;
    let queuedEvents: ConversationResponseStreamEventDto[] = [];
    let latestSequence = execution.streamSequence;
    const executionId = execution.responseExecutionId;
    const conversationId = execution.conversationId;
    const userMessageId = execution.userMessageId;

    const flushEvents = () => {
      animationFrame = undefined;
      if (!active || queuedEvents.length === 0) return;
      const events = queuedEvents;
      queuedEvents = [];
      rendererTrace('flushEvents', {
        count: events.length,
        sequences: events.map((event) => event.sequence)
      });
      setResponseExecution((current) => {
        if (!current || current.responseExecutionId !== executionId) return current;
        return events.reduce<ConversationResponseExecutionDto>((next, event) => {
          const state = event.type === 'stream_completed' ? 'completed'
            : event.type === 'stream_cancelled' ? 'cancelled'
              : event.type === 'stream_failed' ? 'failed'
                : event.type === 'stream_interrupted' ? 'interrupted'
                  : event.type === 'stream_started' || event.type === 'stream_resumed'
                    ? 'streaming'
                    : next.state;
          return {
            ...next,
            state,
            streamSequence: event.sequence,
            reasoningContent: `${next.reasoningContent}${event.reasoningDelta ?? ''}`,
            content: `${next.content}${event.contentDelta ?? ''}`,
            updatedAt: event.occurredAt
          };
        }, current);
      });
    };

    const handleTerminalEvent = (event: ConversationResponseStreamEventDto) => {
      terminalReceived = true;
      rendererTrace('terminalEvent', {
        sequence: event.sequence,
        type: event.type,
        safeCode: event.safeCode
      });
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      flushEvents();
      unsubscribe?.();
      cancelRequestedRef.current = false;
      setCancelRequested(false);
      void chat.getConversation(conversationId).then((result) => {
        if (!active || !result.ok) return;
        replaceConversation(result.value);
        const assistant = result.value.messages.find(
          (message) => message.messageId === event.assistantMessageId
        );
        if (event.type === 'stream_completed') setNotice('');
        else if (event.type === 'stream_cancelled') {
          setNotice('回复已停止。');
          restoreCancelledInput(result.value, userMessageId);
        }
        else if (event.type === 'stream_interrupted') setNotice('回复被中断，请重试。');
        else setNotice(failedResponseNotice(assistant, event.safeCode));
      });
    };

    const onEvent = (event: ConversationResponseStreamEventDto) => {
      if (
        !active ||
        terminalReceived ||
        event.responseExecutionId !== executionId ||
        event.sequence <= latestSequence
      ) return;
      rendererTrace('onEvent', {
        sequence: event.sequence,
        type: event.type,
        contentDeltaLength: event.contentDelta?.length ?? 0,
        reasoningDeltaLength: event.reasoningDelta?.length ?? 0
      });
      latestSequence = event.sequence;
      queuedEvents.push(event);
      if (['stream_completed', 'stream_cancelled', 'stream_failed', 'stream_interrupted'].includes(event.type)) {
        handleTerminalEvent(event);
        return;
      }
      if (animationFrame === undefined) {
        animationFrame = window.requestAnimationFrame(flushEvents);
      }
    };

    unsubscribe = chat.subscribeResponseEvents(executionId, latestSequence, onEvent);
    if (terminalReceived) unsubscribe();
    return () => {
      rendererTrace('effect:response-subscription-cleanup', {
        executionId,
        hadUnsubscribe: Boolean(unsubscribe)
      });
      active = false;
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      unsubscribe?.();
    };
  }, [chat, responseExecution?.responseExecutionId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!input.trim()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [input]);

  function startNewConversation() {
    if (responseInProgress) {
      setNotice('请先停止当前回复，再开始新的对话。');
      return;
    }
    if (!confirmLeaveUnsentInput()) return;
    setSelectedId(undefined);
    updateInput('');
    setEditingMessageId(undefined);
    setHistoryOpen(false);
    setContextOpen(false);
    setIncludedContextIds([]);
    setContextDraft(undefined);
    setNotice(session ? '' : '请先打开项目。');
    clearResponseDraftState();
  }

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages || !followOutputRef.current) return;
    messages.scrollTop = messages.scrollHeight;
    setShowScrollToBottom(false);
  }, [
    lastDisplayMessage?.content,
    lastDisplayMessage?.reasoningContent,
    lastDisplayMessage?.state,
    selectedId
  ]);

  function clearResponseDraftState() {
    rendererTrace('clearResponseDraftState', {
      clearedExecutionId: responseExecutionSnapshotRef.current?.responseExecutionId,
      clearedConversationId: responseExecutionSnapshotRef.current?.conversationId
    });
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    setResponseExecution(undefined);
  }

  function updateInput(value: string) {
    inputValueRef.current = value;
    setInput(value);
  }

  function focusComposer() {
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function startEditingCancelledMessage(message: MessageDto) {
    if (responseInProgress || cancelRequested || busy) return;
    if (inputValueRef.current.trim() && !confirmLeaveUnsentInput()) return;
    setEditingMessageId(message.messageId);
    updateInput(message.content);
    setNotice('');
    focusComposer();
  }

  function restoreCancelledInput(
    conversation: ConversationDto,
    userMessageId: string
  ) {
    const message = findEditableCancelledUserMessage(conversation);
    if (message?.messageId !== userMessageId || inputValueRef.current.trim()) return;
    setEditingMessageId(message.messageId);
    updateInput(message.content);
    focusComposer();
  }

  function cancelMessageEditing() {
    setEditingMessageId(undefined);
    updateInput('');
    focusComposer();
  }

  function changeCandidate(next: string) {
    setSelectedCandidateId(next || undefined);
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
  }

  function confirmLeaveUnsentInput(): boolean {
    if (!input.trim()) return true;
    return window.confirm('当前输入尚未发送，确定离开并丢弃吗？');
  }

  function selectConversation(conversationId: string) {
    if (conversationId === selectedId) return;
    if (!confirmLeaveUnsentInput()) return;
    updateInput('');
    setEditingMessageId(undefined);
    setSelectedId(conversationId);
    setHistoryOpen(false);
  }

  function replaceConversation(conversation: ConversationDto) {
    setConversations((items) => items.some(
      (item) => item.conversationId === conversation.conversationId
    )
      ? items.map((item) =>
          item.conversationId === conversation.conversationId ? conversation : item
        )
      : [conversation, ...items]);
  }

  async function mutateConversation(
    conversation: ConversationDto,
    operation: 'rename' | 'archive' | 'restore' | 'delete'
  ) {
    if (!chat || conversation.readOnly || busy) return;
    const nextTitle = renameTitle.trim();
    if (operation === 'rename' && (!nextTitle || nextTitle === conversation.title)) return;
    setBusy(true);
    setNotice('');
    try {
      const result = operation === 'rename'
        ? await chat.renameConversation(conversation.conversationId, conversation.revision, nextTitle)
        : operation === 'archive'
          ? await chat.archiveConversation(conversation.conversationId, conversation.revision)
          : operation === 'restore'
            ? await chat.restoreConversation(conversation.conversationId, conversation.revision)
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
          updateInput('');
          setEditingMessageId(undefined);
          clearResponseDraftState();
        }
        setNotice('');
      } else {
        replaceConversation(result.value);
        if (operation === 'rename') setRenamingConversationId(undefined);
        setNotice('');
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
      setNotice('');
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
    rendererTrace('sendMessage:start', {
      selectedId,
      editingMessageId,
      productFeature: responseFeature,
      candidateId: selectedCandidateId
    });
    setResponseStarting(true);
    setNotice('正在准备回复…');
    clearResponseDraftState();
    const commandContent = input.trim();
    const commandEditingMessageId = editingMessageId;
    try {
      const started = await chat.startResponse({
        clientCommandId: `chat-start-${crypto.randomUUID()}`,
        conversation: selected
          ? {
              conversationId: selected.conversationId,
              expectedRevision: selected.revision,
              editedMessageId: commandEditingMessageId ?? null
            }
          : null,
        title: conversationTitleFromMessage(commandContent),
        content: commandContent,
        productFeature: responseFeature,
        candidateId: selectedCandidateId,
        contextSelections: includedContextIds.flatMap((contextId) => {
          const context = viewedContexts[contextId];
          return context
            ? [{
                contextId,
                contextRevision: context.revision,
                includeInPrompt: true
              }]
            : [];
        }),
        parameterValues: {},
        confirmed: true
      });
      if (!started.ok) {
        rendererTrace('sendMessage:startResponse-error', {
          code: started.error.code,
          message: started.error.message
        });
        cancelAfterStartRef.current = false;
        cancelRequestedRef.current = false;
        setCancelRequested(false);
        setNotice(describeChatError(started.error));
        if (selected) {
          const refreshed = await chat.getConversation(selected.conversationId);
          if (refreshed.ok) replaceConversation(refreshed.value);
        }
        return;
      }
      rendererTrace('sendMessage:startResponse-ok', {
        conversationId: started.value.conversation.conversationId,
        executionId: started.value.execution.responseExecutionId,
        executionState: started.value.execution.state,
        selectedIdChanged: selectedId !== started.value.conversation.conversationId
      });
      replaceConversation(started.value.conversation);
      setSelectedId(started.value.conversation.conversationId);
      setResponseExecution(started.value.execution);
      setActivityExpanded(responseFeature === 'text_reasoning');
      updateInput('');
      setEditingMessageId(undefined);
      setNotice('');
      if (cancelAfterStartRef.current) {
        cancelAfterStartRef.current = false;
        setResponseStarting(false);
        await requestResponseCancellation(
          started.value.execution,
          started.value.conversation
        );
      }
      return;
    } catch {
      cancelAfterStartRef.current = false;
      cancelRequestedRef.current = false;
      setCancelRequested(false);
      setNotice(errorMessages.storage_error);
      return;
    } finally {
      setResponseStarting(false);
    }

  }

  async function importDroppedFile(file: File) {
    if (!documentAttachments || !session || busy || responseInProgress) return;
    const sourcePath = window.unicomp?.getPathForFile(file);
    if (!sourcePath) {
      setNotice('无法读取拖入的文件，请尝试使用本地选择。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const result = await documentAttachments.importAttachment({ sourcePath });
      if (!result.ok) {
        setNotice(
          result.error.code === 'too_large'
            ? '附件超过大小上限，请压缩后重试。'
            : result.error.code === 'unsupported_format'
              ? '不支持该附件格式。'
              : errorMessages.storage_error
        );
        return;
      }
      setAttachments((current) => [
        ...current,
        {
          fileId: result.value.fileId,
          fileName: result.value.fileName,
          sizeBytes: result.value.sizeBytes,
          status: result.value.extraction.status,
          preview: result.value.extraction.preview
        }
      ]);
    } catch {
      setNotice('附件导入失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function hasDraggedFiles(event: React.DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handlePageDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!session || !hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
    if (!documentMode) setDocumentMode(true);
  }

  function handlePageDragOver(event: React.DragEvent<HTMLElement>) {
    if (session && hasDraggedFiles(event)) event.preventDefault();
  }

  function handlePageDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function handlePageDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    if (!session || busy || responseInProgress) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      setDocumentMode(true);
      files.forEach((file) => void importDroppedFile(file));
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.fileId !== fileId)
    );
    if (templateFileId === fileId) {
      setTemplateFileId(undefined);
      setTemplateColors(undefined);
    }
  }

  async function toggleTemplate(attachment: AttachmentDraft) {
    if (!documentAttachments) return;
    if (templateFileId === attachment.fileId) {
      setTemplateFileId(undefined);
      setTemplateColors(undefined);
      return;
    }
    try {
      const result = await documentAttachments.extractTheme({
        fileId: attachment.fileId
      });
      if (!result.ok) {
        setNotice('该文件无法作为样式模板，请上传含主题的 PPTX。');
        return;
      }
      setTemplateFileId(attachment.fileId);
      setTemplateColors(result.value);
      setNotice(`已应用模板「${attachment.fileName}」的主题色。`);
    } catch {
      setNotice('读取模板主题失败，请重试。');
    }
  }

  async function sendDocumentMessage() {
    if (
      !chat ||
      !documentGeneration ||
      !session ||
      (selected && (selected.readOnly || selected.status !== 'active')) ||
      !input.trim() ||
      !selectedCandidateId ||
      !selectedCandidate?.available ||
      busy ||
      responseInProgress
    ) {
      return;
    }
    setBusy(true);
    setNotice('AI 正在撰写文档内容…');
    rendererTrace('sendDocumentMessage:start', JSON.stringify({
      selectedId,
      documentKind,
      candidateId: selectedCandidateId,
      productFeature: responseFeature
    }));
    const requirements = input.trim();
    const attachmentText = attachments
      .filter((attachment) => attachment.status === 'extracted')
      .map(
        (attachment) =>
          `【附件：${attachment.fileName}】\n${attachment.preview.slice(0, 2000)}`
      )
      .join('\n\n');
    const previousDocument = selected
      ? [...selected.messages]
          .reverse()
          .find(
            (item) =>
              item.role === 'assistant' &&
              item.state === 'completed' &&
              item.documentResult
          )
      : undefined;
    const revisionInput = composeDocumentRevisionInput(
      previousDocument?.content,
      requirements
    );
    const combined = attachmentText
      ? `${revisionInput}\n\n${attachmentText}`
      : revisionInput;
    const kind = documentKind === 'auto'
      ? inferDocumentKind(requirements)
      : documentKind;
    try {
      const started = await chat.startResponse({
        clientCommandId: `chat-doc-${crypto.randomUUID()}`,
        conversation: selected
          ? {
              conversationId: selected.conversationId,
              expectedRevision: selected.revision,
              editedMessageId: null
            }
          : null,
        title: conversationTitleFromMessage(requirements),
        content: combined,
        productFeature: responseFeature,
        candidateId: selectedCandidateId,
        contextSelections: includedContextIds.flatMap((contextId) => {
          const context = viewedContexts[contextId];
          return context
            ? [{
                contextId,
                contextRevision: context.revision,
                includeInPrompt: true
              }]
            : [];
        }),
        parameterValues: {},
        confirmed: true
      });
      if (!started.ok) {
        rendererTrace('sendDocumentMessage:startResponse-error', JSON.stringify({
          code: started.error.code,
          message: started.error.message
        }));
        if (started.error.code === 'revision_conflict' && selected) {
          const refreshed = await chat.getConversation(selected.conversationId);
          if (refreshed.ok) {
            replaceConversation(refreshed.value);
            setSelectedId(refreshed.value.conversationId);
          }
          setNotice('会话已更新并刷新，请再次发送。');
          return;
        }
        setNotice(describeDocumentError(started.error));
        if (selected) {
          const refreshedFailed = await chat.getConversation(selected.conversationId);
          if (refreshedFailed.ok) replaceConversation(refreshedFailed.value);
        }
        return;
      }
      rendererTrace('sendDocumentMessage:startResponse-ok', JSON.stringify({
        conversationId: started.value.conversation.conversationId,
        executionState: started.value.execution.state,
        executionId: started.value.execution.responseExecutionId
      }));
      replaceConversation(started.value.conversation);
      setSelectedId(started.value.conversation.conversationId);
      setResponseExecution(started.value.execution);
      updateInput('');
      setAttachments([]);
      setTemplateFileId(undefined);
      setTemplateColors(undefined);
      const targetId = started.value.conversation.conversationId;
      const completion = await awaitDocumentCompletion(
        chat,
        started.value.execution.responseExecutionId
      );
      rendererTrace('sendDocumentMessage:completion', JSON.stringify({
        completed: Boolean(completion),
        state: completion?.state
      }));
      const refreshedBefore = await chat.getConversation(targetId);
      if (!refreshedBefore.ok) {
        setNotice('刷新对话失败，请重试。');
        return;
      }
      replaceConversation(refreshedBefore.value);
      if (!completion) {
        const finalCheck = await chat.getResponseExecution(
          started.value.execution.responseExecutionId
        );
        const terminal = finalCheck.ok ? finalCheck.value.state : 'unknown';
        rendererTrace('sendDocumentMessage:terminal-state', JSON.stringify({
          terminal,
          finalCheckOk: finalCheck.ok
        }));
        const latest = await chat.getConversation(targetId);
        const failedMessage = latest.ok
          ? [...latest.value.messages]
              .reverse()
              .find(
                (item) =>
                  item.role === 'assistant' &&
                  item.state === 'failed'
              )
          : undefined;
        setNotice(
          terminal === 'cancelled'
            ? 'AI 内容生成已取消，文档未生成。'
            : failedMessage
              ? failedResponseNotice(failedMessage)
              : 'AI 内容生成失败，文档未生成。'
        );
        return;
      }
      setNotice('正在生成本地 Office 文档…');
      const aiImages = await generateAiSlideImages(
        completion.content,
        attachments.filter((attachment) => isImageFileName(attachment.fileName)).length
      );
      const generated = await documentGeneration.generateFromMessage({
        conversationId: targetId,
        expectedRevision: refreshedBefore.value.revision,
        messageId: completion.assistantMessageId,
        kind,
        theme: documentTheme,
        images: [
          ...attachments
            .filter((attachment) => isImageFileName(attachment.fileName))
            .map((attachment) => ({
              fileId: attachment.fileId,
              caption: attachment.fileName
            })),
          ...aiImages
        ],
        ...(templateColors ? { customTheme: templateColors } : {}),
        ...(aiImagesEnabled ? { aiImages: true } : {})
      });
      rendererTrace('sendDocumentMessage:generate-result', JSON.stringify({
        ok: generated.ok,
        code: generated.ok ? undefined : generated.error.code,
        message: generated.ok ? undefined : generated.error.message
      }));
      if (!generated.ok) {
        setNotice(describeDocumentError(generated.error));
      } else {
        setNotice('文档已生成。');
      }
      const refreshed = await chat.getConversation(targetId);
      if (refreshed.ok) {
        replaceConversation(refreshed.value);
        setSelectedId(refreshed.value.conversationId);
      }
      setDocumentMode(false);
    } catch {
      setNotice('文档生成失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function awaitDocumentCompletion(
    api: NonNullable<typeof chat>,
    responseExecutionId: string
  ): Promise<ConversationResponseExecutionDto | undefined> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      const result = await api.getResponseExecution(responseExecutionId);
      if (!result.ok) continue;
      if (result.value.state === 'completed') return result.value;
      if (
        result.value.state === 'failed' ||
        result.value.state === 'cancelled' ||
        result.value.state === 'interrupted'
      ) {
        return undefined;
      }
    }
    return undefined;
  }

  async function generateAiSlideImages(
    content: string,
    userImageCount: number
  ): Promise<readonly { readonly workId: string; readonly caption: string }[]> {
    rendererTrace('generateAiSlideImages:start', JSON.stringify({
      aiImagesEnabled,
      hasFeatures: Boolean(imageFeatures),
      contentLength: content.length,
      userImageCount
    }));
    if (!aiImagesEnabled || !imageFeatures) return [];
    if (
      !window.confirm(
        'AI 配图将调用你已配置的图片模型为文档分节生成配图，可能消耗模型额度。继续？'
      )
    ) {
      setNotice('已取消 AI 配图。');
      return [];
    }
    const candidates = await imageFeatures.listQuickCandidates();
    rendererTrace('generateAiSlideImages:candidates', JSON.stringify({
      ok: candidates.ok,
      count: candidates.ok ? candidates.value.length : 0,
      available: candidates.ok
        ? candidates.value.filter((item) => item.available).length
        : 0
    }));
    const candidate = candidates.ok
      ? candidates.value.find(
          (item) => item.available && canAutoGenerateImageCandidate(item)
        )
      : undefined;
    if (!candidate) {
      setNotice(
        '可用图片模型都需要必填参数（如尺寸），AI 配图无法自动取值，已跳过；请先到快速生图配置参数。'
      );
      return [];
    }
    const headings = extractSectionHeadings(content).slice(
      0,
      Math.max(0, 6 - userImageCount)
    );
    rendererTrace('generateAiSlideImages:headings', JSON.stringify(headings));
    const generated: { readonly workId: string; readonly caption: string }[] = [];
    for (const heading of headings) {
      try {
        const result = await imageFeatures.generateQuickImage(
          `为演示文稿「${heading}」一页生成纯图形插画配图，风格与内容契合；画面中绝对不能出现任何文字、字母、数字、标点、标题或水印`,
          candidate.candidateId,
          {}
        );
        rendererTrace('generateAiSlideImages:image', JSON.stringify({
          heading,
          ok: result.ok,
          code: result.ok ? undefined : result.error.code,
          workId: result.ok ? result.value.submission.workId : undefined,
          safeCode: result.ok ? result.value.submission.safeCode : undefined
        }));
        if (result.ok && result.value.submission.workId) {
          generated.push({
            workId: result.value.submission.workId,
            caption: heading
          });
        }
      } catch {
        // 单张配图失败不阻断整体生成。
      }
    }
    if (headings.length > 0 && generated.length === 0) {
      setNotice('AI 配图生成失败，文档将不包含 AI 配图。');
    }
    rendererTrace('generateAiSlideImages:result', JSON.stringify({
      generatedCount: generated.length
    }));
    return generated;
  }

  async function cancelResponse() {
    if (responseStarting) {
      if (cancelRequested) return;
      cancelAfterStartRef.current = true;
      cancelRequestedRef.current = true;
      setCancelRequested(true);
      setNotice('已发出停止请求，正在等待执行建立…');
      return;
    }
    if (
      !chat ||
      !selected ||
      !responseExecution ||
      !responseInProgress ||
      busy ||
      cancelRequested
    ) return;
    await requestResponseCancellation(responseExecution, selected);
  }

  async function requestResponseCancellation(
    pendingExecution: ConversationResponseExecutionDto,
    conversation: ConversationDto
  ) {
    if (!chat) return;
    cancelRequestedRef.current = true;
    setCancelRequested(true);
    setNotice('已发出停止请求，正在确认…');
    let awaitingTerminalEvent = false;
    try {
      const result = await chat.cancelResponseExecution(
        pendingExecution.responseExecutionId
      );
      if (!result.ok) {
        setNotice(describeChatError(result.error));
        const refreshed = await chat.getConversation(conversation.conversationId);
        if (refreshed.ok) replaceConversation(refreshed.value);
        return;
      }
      setResponseExecution(result.value);
      if (['pending', 'streaming'].includes(result.value.state)) {
        awaitingTerminalEvent = true;
        return;
      }
      const refreshed = await chat.getConversation(conversation.conversationId);
      if (refreshed.ok) {
        replaceConversation(refreshed.value);
        if (result.value.state === 'cancelled') {
          restoreCancelledInput(refreshed.value, pendingExecution.userMessageId);
        }
      }
      setNotice(
        result.value.state === 'cancelled'
          ? '回复已停止。'
          : result.value.state === 'completed'
            ? '回复已完成。'
            : '停止请求未能确认，请重试。'
      );
    } catch {
      setNotice('停止回复失败，请重试。');
      const refreshed = await chat.getConversation(conversation.conversationId);
      if (refreshed.ok) replaceConversation(refreshed.value);
    } finally {
      if (!awaitingTerminalEvent) {
        cancelRequestedRef.current = false;
        setCancelRequested(false);
      }
    }
  }

  async function copyMessage(message: MessageDto) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.messageId);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === message.messageId ? undefined : current);
      }, 1_600);
    } catch {
      setNotice('复制失败，请手动选择消息内容。');
    }
  }

  async function openDocumentWork(workId: string) {
    if (!documentGeneration) return;
    try {
      const result = await documentGeneration.openDocument(workId);
      if (!result.ok) {
        setNotice(
          result.error.code === 'work_not_found'
            ? '文档作品不存在。'
            : result.error.code === 'file_unavailable'
              ? '文档文件当前不可用。'
              : '打开文档失败，请重试。'
        );
      }
    } catch {
      setNotice('打开文档失败，请重试。');
    }
  }

  function handleMessagesScroll() {
    const messages = messagesRef.current;
    if (!messages) return;
    const distanceToBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const nearBottom = distanceToBottom <= 72;
    followOutputRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  }

  function scrollMessagesToBottom() {
    const messages = messagesRef.current;
    if (!messages) return;
    followOutputRef.current = true;
    messages.scrollTop = messages.scrollHeight;
    setShowScrollToBottom(false);
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
      setNotice('');
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
      setNotice('');
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
      setNotice('');
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
      setNotice('');
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
      setNotice('');
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
      setNotice('');
    } catch {
      setNotice('登记项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="chat-page-title"
      className="uc-chat-page"
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
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
            <Whisper placement="bottom" speaker={<Tooltip>新对话</Tooltip>} trigger="hover">
              <Button
                aria-label="新建对话"
                disabled={!session || busy}
                onClick={startNewConversation}
                variant="ghost"
              >
                <LuMessageSquarePlus aria-hidden="true" />
              </Button>
            </Whisper>
            <Whisper placement="bottom" speaker={<Tooltip>对话列表</Tooltip>} trigger="hover">
              <Button
                aria-label="打开对话列表"
                aria-expanded={historyOpen}
                onClick={() => {
                  setContextOpen(false);
                  setHistoryOpen(true);
                }}
                variant="ghost"
              >
                <LuMessagesSquare aria-hidden="true" />
              </Button>
            </Whisper>
            <Whisper placement="bottom" speaker={<Tooltip>项目上下文</Tooltip>} trigger="hover">
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
                <LuPanelRight aria-hidden="true" />
                {includedContextIds.length > 0 ? <b>{includedContextIds.length}</b> : null}
              </Button>
            </Whisper>
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

        <div
          className="uc-chat-page__messages"
          onScroll={handleMessagesScroll}
          ref={messagesRef}
        >
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
                  const reasoningContent = item.role === 'assistant'
                    ? item.reasoningContent
                    : undefined;
                  const canEditCancelledMessage = item.role === 'user' &&
                    item.messageId === editableCancelledUserMessage?.messageId &&
                    !responseInProgress &&
                    !cancelRequested;
                  const activityLabel = cancelRequested
                    ? '正在停止'
                    : responseExecution?.state === 'pending'
                      ? reasoningMode ? '正在推理' : '正在处理'
                      : responseExecution?.state === 'streaming'
                        ? reasoningContent && !item.content ? '正在思考' : '正在回答'
                        : responseExecution?.state === 'completed'
                          ? `已处理${executionDuration ? ` ${executionDuration}` : ''}`
                          : responseExecution?.state === 'cancelled'
                            ? '已停止'
                            : item.content ? '回答已中断' : '处理失败';
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
                              <span>
                                {reasoningContent
                                  ? '模型返回的思考内容'
                                  : reasoningMode ? '推理模式' : '普通对话'}
                              </span>
                              {reasoningContent ? (
                                <MarkdownMessage content={reasoningContent} />
                              ) : (
                                <p>
                                  {cancelRequested
                                    ? '停止请求已发送，正在确认并保留已经接收的内容。'
                                    : reasoningMode
                                      ? '正在等待模型接口返回可展示的思考内容。'
                                      : responseInProgress
                                        ? '模型正在生成回答，可点击输入框右侧按钮立即停止。'
                                        : '回答处理已经结束。'}
                                </p>
                              )}
                            </div>
                          ) : null}
                        </section>
                      ) : null}
                      {item.state !== 'completed' && !isCurrentAssistant ? (
                        <div className="uc-chat-page__message-heading">
                          <strong>{item.role === 'user' ? '你' : '助手'}</strong>
                          <StatusPill tone={messageStatusTone(item)}>{messageStatusLabel(item)}</StatusPill>
                        </div>
                      ) : null}
                      {item.role === 'assistant' && reasoningContent && !isCurrentAssistant ? (
                        <details className="uc-chat-page__reasoning">
                          <summary>
                            <LuBrainCircuit aria-hidden="true" />
                            <span>模型返回的思考内容</span>
                          </summary>
                          <div className="uc-chat-page__reasoning-content">
                            <MarkdownMessage content={reasoningContent} />
                          </div>
                        </details>
                      ) : null}
                      {item.role === 'assistant' ? (
                        <div className="uc-chat-page__message-content">
                          <MarkdownMessage
                            content={item.content || (item.state === 'streaming' || item.state === 'pending' ? '正在接收…' : '尚无内容')}
                          />
                          {item.state === 'streaming' ? <span className="uc-chat-page__caret" aria-hidden="true">▌</span> : null}
                        </div>
                      ) : (
                        <p className="uc-chat-page__message-bubble">{item.content}</p>
                      )}
                      {item.role === 'assistant' && item.documentResult ? (
                        <section className="uc-chat-page__document-card" aria-label="生成的 Office 文档">
                          <LuFileText aria-hidden="true" />
                          <div className="uc-chat-page__document-card-main">
                            <strong>{item.documentResult.fileName}</strong>
                            <small>
                              {documentKindLabel(item.documentResult.kind)} ·{' '}
                              {formatBytes(item.documentResult.sizeBytes)}
                            </small>
                          </div>
                          <div className="uc-chat-page__document-card-actions">
                            <Button
                              disabled={busy}
                              onClick={() => void openDocumentWork(item.documentResult!.workId)}
                              title="用系统默认程序打开"
                              variant="secondary"
                            >
                              打开
                            </Button>
                            {onOpenLibrary ? (
                              <Button onClick={onOpenLibrary} title="在作品库中查看" variant="ghost">
                                作品库
                              </Button>
                            ) : null}
                          </div>
                        </section>
                      ) : null}
                      {item.state === 'completed' ? (
                        <div className="uc-chat-page__message-meta">
                          <time dateTime={item.createdAt}>{formatMessageTime(item.createdAt)}</time>
                          {canEditCancelledMessage ? (
                            <Button
                              aria-label="编辑并重新发送"
                              disabled={busy}
                              onClick={() => startEditingCancelledMessage(item)}
                              title="编辑并重新发送"
                              variant="ghost"
                            >
                              <LuPencil aria-hidden="true" />
                            </Button>
                          ) : null}
                          {item.content ? (
                            <Button
                              aria-label={copiedMessageId === item.messageId ? '已复制' : '复制消息'}
                              onClick={() => void copyMessage(item)}
                              title={copiedMessageId === item.messageId ? '已复制' : '复制'}
                              variant="ghost"
                            >
                              {copiedMessageId === item.messageId ? <LuCheck aria-hidden="true" /> : <LuCopy aria-hidden="true" />}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {showScrollToBottom ? (
            <Button
              aria-label="回到最新消息"
              className="uc-chat-page__scroll-to-bottom"
              onClick={scrollMessagesToBottom}
              title="回到最新消息"
              variant="secondary"
            >
              <LuArrowDown aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        <div className="uc-chat-page__composer-region">
          {notice ? (
            <p className="uc-chat-page__message" aria-live="polite" role="status">
              {notice}
            </p>
          ) : null}
          <section
            aria-labelledby="chat-composer-title"
            className={`uc-chat-page__composer${documentMode ? ' uc-chat-page__composer--document' : ''}`}
          >
            <h2 className="uc-visually-hidden" id="chat-composer-title">发送消息</h2>
            <textarea
              aria-label={editingMessageId ? '编辑已停止的消息' : '对话输入'}
              disabled={!canCompose}
              maxLength={8000}
              onChange={(event) => updateInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!responseInProgress && !cancelRequested && !busy) {
                    if (documentMode) void sendDocumentMessage();
                    else void sendMessage();
                  }
                }
              }}
              placeholder={
                !session
                  ? '请先打开项目'
                  : documentMode
                    ? '输入需求，生成 Office 文档（可拖入图片/文档）'
                    : selectedCandidate
                      ? '询问 UniComp AI'
                      : '选择模型后输入问题'
              }
              ref={composerRef}
              rows={1}
              value={input}
            />
            {attachments.length > 0 ? (
              <ul className="uc-chat-page__attachments">
                {attachments.map((attachment) => (
                  <li key={attachment.fileId}>
                    <LuPaperclip aria-hidden="true" />
                    <span title={attachment.fileName}>{attachment.fileName}</span>
                    {/\.pptx$/i.test(attachment.fileName) ? (
                      <button
                        aria-pressed={templateFileId === attachment.fileId}
                        className={templateFileId === attachment.fileId ? 'is-template' : ''}
                        disabled={busy}
                        onClick={() => void toggleTemplate(attachment)}
                        title={
                          templateFileId === attachment.fileId
                            ? '取消作为样式模板'
                            : '作为样式模板'
                        }
                        type="button"
                      >
                        {templateFileId === attachment.fileId ? '模板' : '模板'}
                      </button>
                    ) : null}
                    <button
                      aria-label={`移除附件 ${attachment.fileName}`}
                      disabled={busy}
                      onClick={() => removeAttachment(attachment.fileId)}
                      type="button"
                    >
                      <LuX aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="uc-chat-page__composer-toolbar">
              <div className="uc-chat-page__composer-actions">
                {editingMessageId ? (
                  <Button
                    aria-label="取消编辑"
                    className="uc-chat-page__cancel-edit"
                    disabled={busy || cancelRequested || responseInProgress}
                    onClick={cancelMessageEditing}
                    title="取消编辑"
                    variant="ghost"
                  >
                    <LuX aria-hidden="true" />
                  </Button>
                ) : null}
                <button
                  aria-pressed={documentMode}
                  className={`uc-chat-page__doc-mode${documentMode ? ' is-active' : ''}`}
                  disabled={!canCompose || !session || busy || cancelRequested || responseInProgress}
                  onClick={() => setDocumentMode((mode) => !mode)}
                  title={documentMode ? '退出文档生成模式' : '生成 Office 文档（Word/Excel/PPT）'}
                  type="button"
                >
                  <LuFileText aria-hidden="true" />
                  <span>文档</span>
                </button>
                {documentMode ? (
                  <div
                    aria-label="文档类型"
                    className="uc-chat-page__doc-kind"
                    role="radiogroup"
                  >
                    {documentKindOptions.map((option) => (
                      <button
                        aria-checked={documentKind === option.value}
                        className={documentKind === option.value ? 'is-active' : ''}
                        disabled={!canCompose || !session || busy}
                        key={option.value}
                        onClick={() => setDocumentKind(option.value)}
                        role="radio"
                        title={
                          option.value === 'auto'
                            ? '根据需求自动判断文档类型'
                            : option.label
                        }
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {documentMode ? (
                  <div
                    aria-label="文档主题"
                    className="uc-chat-page__doc-kind"
                    role="radiogroup"
                  >
                    {documentThemeOptions.map((option) => (
                      <button
                        aria-checked={documentTheme === option.value}
                        className={documentTheme === option.value ? 'is-active' : ''}
                        disabled={!canCompose || !session || busy}
                        key={option.value}
                        onClick={() => setDocumentTheme(option.value)}
                        role="radio"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {documentMode ? (
                  <button
                    aria-pressed={aiImagesEnabled}
                    className={`uc-chat-page__doc-mode${aiImagesEnabled ? ' is-active' : ''}`}
                    disabled={!canCompose || !session || busy}
                    onClick={() => setAiImagesEnabled((enabled) => !enabled)}
                    title="用已配置的图片模型为缺图分节生成配图，消耗模型额度，生成前需确认"
                    type="button"
                  >
                    AI 配图
                  </button>
                ) : null}
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
                      </section>
                    </div>
                  )}
                  listboxMaxHeight={250}
                  noResultsText={candidatesLoading
                    ? '正在加载可用模型…'
                    : '没有匹配的模型'}
                  onChange={changeCandidate}
                  options={featureCandidates.map((candidate) => ({
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
                  searchPlaceholder="搜索模型或服务商"
                  showEmptyState={false}
                  value={selectedCandidateId ?? ''}
                />
                {input.length >= 7000 ? <span className="uc-chat-page__composer-count">{input.length} / 8000</span> : null}
                <button
                  aria-label={responseInProgress ? cancelRequested ? '正在停止生成' : '停止生成' : '发送消息'}
                  className={`uc-chat-page__submit${responseInProgress ? ' uc-chat-page__submit--stop' : ''}`}
                  disabled={responseInProgress
                    ? busy || cancelRequested
                    : !chat ||
                      !canCompose ||
                      !input.trim() ||
                      (!documentMode && !selectedCandidate?.available) ||
                      busy ||
                      cancelRequested}
                  onClick={() =>
                    responseInProgress
                      ? void cancelResponse()
                      : documentMode
                        ? void sendDocumentMessage()
                        : void sendMessage()
                  }
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
      </section>
      {dragging ? (
        <div className="uc-chat-page__drop-overlay" aria-hidden="true">
          <LuPaperclip aria-hidden="true" />
          <strong>松开鼠标导入附件</strong>
          <span>图片/文档将作为依据，用于生成 Office 文档</span>
        </div>
      ) : null}

      <Drawer
        backdropClassName="uc-chat-page__drawer-backdrop"
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
                            ...(conversation.status === 'active'
                              ? [{
                                key: 'archive',
                                label: '归档',
                                icon: <LuArchive aria-hidden="true" />
                              }]
                              : [{
                                key: 'restore',
                                label: '恢复对话',
                                icon: <LuArchiveRestore aria-hidden="true" />
                              }]),
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
                            if (eventKey === 'archive' || eventKey === 'restore') {
                              void mutateConversation(conversation, eventKey);
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
        backdropClassName="uc-chat-page__drawer-backdrop"
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
