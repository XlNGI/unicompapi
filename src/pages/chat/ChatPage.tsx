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
import { Checkbox, Drawer, Input, Modal, SelectPicker, Tooltip, Whisper } from 'rsuite';
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
  ConversationWorkflowDto,
  MessageDto,
  ProjectContextCandidateDto,
  ProjectContextDetailDto,
  ProjectContextDraftPreviewDto
} from '../../shared/chat-context-ipc';
import type {
  WebResearchReferenceDto,
  WebResearchSessionDto
} from '../../shared/web-research-ipc';
import type { StorageProjectSessionDto } from '../../shared/storage-ipc';
import type { DocumentExtractionStatus } from '../../shared/document-attachment-ipc';
import { composeWorkflowRequirements, composeResearchInput } from './workflowInput';
import {
  composeDocumentRevisionInput,
  documentResponseParameterValues,
  documentKindInstruction,
  extractSectionHeadings,
  inferDocumentKind,
  resolvePresentationTemplate,
  type PresentationTemplateSelection,
  type DocumentKindOption
} from './documentDrafting';
import { PROJECT_SESSION_CHANGED_EVENT } from '../../ui/project-session-events';
import { failedResponseNotice } from '../../ui/chat-response-failure-notice';
import {
  parseDeterministicClearRevisionTarget,
  waitForDocumentResponseCompletion,
  type OfficeRequestAction
} from '../../application';
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
  workflow_not_found: '这项会话任务已不存在，请重新发送需求。',
  workflow_revision_conflict: '会话任务刚刚更新，请同步后重试。',
  workflow_not_ready: '会话任务尚未准备好，请先完成追问或确认。',
  planning_cancelled: '需求理解已停止，未开始后续执行。',
  attachment_unavailable: '所选附件已不可用，请重新选择资料。',
  attachment_changed: '所选附件内容已经变化，请重新导入后再使用。',
  attachment_unsupported: '当前无法读取这份附件，请提供可提取正文的文件。',
  attachment_scope_exceeded: '附件超出本次可完整处理的范围，请缩小资料范围或指定章节。',
  clarification_required: '请先补充会话任务所需的信息。',
  confirmation_expired: '任务确认已过期，请重新发送需求。',
  adapter_unavailable: '文本适配器当前不可用。',
  storage_error: '本地保存失败，请检查存储状态后重试。'
};

const documentErrorMessages: Record<string, string> = {
  invalid_request: '当前操作数据无效。',
  project_not_open: '请先打开项目。',
  conversation_not_found: '该对话已不存在。',
  conversation_not_active: '请先恢复已归档对话。',
  revision_conflict: '文档刚刚更新，请基于最新版本重试。',
  local_revision_not_supported:
    '这项修改不能安全地在本地直接执行，请检查目标是否唯一且已确认。',
  revision_scope_violation:
    '没有安全定位到要修改的范围，原文件未改变。请写明具体页、章节或表格。',
  revision_patch_failed:
    '这项修改无法套用到当前文档结构，原文件未改变。请缩小范围或明确目标。',
  unvalidated_output:
    '没有产生可验证的内容变化，原文件未改变。请补充希望改成什么内容。',
  invalid_outline: '文档大纲无效，请调整需求后重试。',
  page_count_mismatch: 'PPT 页数未达到明确要求，请减少单页内容后重试。',
  document_layout_overflow:
    '单个内容组过长，无法在可读字号下排版，请拆分内容后重试。',
  generation_cancelled: '文档生成已取消，未保存文件。',
  generation_failed: '文档生成或写入失败，未登记作品，请重试。',
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
  readonly value: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly label: string;
}[] = [
  { value: 'blueprint', label: '商务蓝' },
  { value: 'ink', label: '墨色' },
  { value: 'forest', label: '松绿' },
  { value: 'financing', label: '融资演讲稿' }
];

const presentationTemplateOptions: {
  readonly value: PresentationTemplateSelection;
  readonly label: string;
}[] = [
  { value: 'auto', label: '自动匹配' },
  { value: 'work_report', label: '工作汇报' },
  { value: 'natural_minimal', label: '自然简约' },
  { value: 'business_minimal', label: '极简商务' },
  { value: 'technology', label: '科技风' },
  { value: 'financing', label: '融资演讲稿' }
];

function rendererTrace(message: string, detail?: unknown): void {
  if (!import.meta.env.DEV) return;
  console.info('[chat-page]', message, detail ?? '');
}

function describeChatError(error: {
  readonly code: ChatContextIpcErrorCode;
  readonly message: string;
}): string {
  if (error.code.startsWith('attachment_')) return error.message;
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
  return documentErrorMessages[error.code] ?? '文档生成失败，请稍后重试。';
}

function documentGenerationMessage(
  status: MessageDto['documentGenerationStatus']
): string {
  if (!status) return '正在生成 Office 文档…';
  if (status.state === 'cancelled') return '文档生成已取消，未保存文件。';
  if (status.state === 'interrupted') {
    return '文档生成已中断，未保存文件，请重试。';
  }
  if (status.state !== 'failed') return '正在生成 Office 文档…';
  switch (status.errorCode) {
    case 'response_failed':
      return 'AI 内容生成未完成，文档未生成。';
    case 'invalid_outline':
      return 'AI 内容格式异常，文档未生成，请重试或切换模型。';
    case 'revision_scope_violation':
      return '没有安全定位到要修改的范围，原文件未改变。请写明具体页、章节或表格。';
    case 'revision_patch_failed':
      return '这项修改无法套用到当前文档结构，原文件未改变。请缩小范围或明确目标。';
    case 'unvalidated_output':
      return '没有产生可验证的内容变化，原文件未改变。请补充希望改成什么内容。';
    case 'page_count_mismatch':
      return 'PPT 页数未达到明确要求，文档未生成，请减少单页内容后重试。';
    case 'resource_limit':
    case 'document_layout_overflow':
      return '内容超出当前文档生成限制，请精简或拆分后重试。';
    case 'storage_error':
      return '本地保存失败，请检查存储状态后重试。';
    default:
      return '文档生成失败，未保存文件，请重试。';
  }
}

function isMachineReadableDocumentOutline(content: string): boolean {
  const text = content.trim();
  if (!text.startsWith('{')) return false;
  // Match partial streaming payloads too; the first chunk may only contain
  // `kind` before `sections` arrives.
  return /["'](?:kind|sections|title)\s*:/u.test(text);
}

function workflowQuestion(workflow: ConversationWorkflowDto): string {
  return workflow.pendingQuestions[0]?.question ??
    workflow.plan.ambiguities[0] ??
    '请补充具体目标后再继续。';
}

function workflowConfirmationDetails(
  workflow: ConversationWorkflowDto,
  conversation?: ConversationDto
): readonly string[] {
  if (workflow.status !== 'needs_confirmation' || workflow.plan.action !== 'revise') {
    return [];
  }
  const targetMessage = workflow.resolvedTarget?.artifactRef
    ? conversation?.messages.find(
        (message) => message.messageId === workflow.resolvedTarget?.artifactRef
      )
    : undefined;
  const document = targetMessage?.documentResult;
  const kind = document?.kind ?? (
    workflow.plan.documentKind && workflow.plan.documentKind !== 'auto'
      ? workflow.plan.documentKind
      : undefined
  );
  const details: string[] = [];
  if (document?.fileName) details.push(`文件：${document.fileName}`);
  const target = workflow.plan.targetHint;
  if (target?.unit === 'page' && target.ordinal !== undefined) {
    details.push(
      kind === 'ppt'
        ? `目标：PPT 物理第 ${target.ordinal} 张（含封面）`
        : `目标：第 ${target.ordinal} 页`
    );
  } else if (target?.unit === 'section' && target.ordinal !== undefined) {
    details.push(`目标：正文第 ${target.ordinal} 个 section`);
  } else if (target?.name) {
    details.push(`目标：${target.name}`);
  }
  const source = conversation?.messages.find(
    (message) => message.messageId === workflow.sourceMessageId
  )?.content ?? '';
  details.push(
    /(?:清空|清除|删除|删掉)/u.test(source)
      ? '操作：清空目标范围的正文内容'
      : '操作：按当前请求修改目标范围'
  );
  details.push('保留：其他页面与原文件不变，成功后生成新版文件');
  return details;
}

interface AttachmentDraft {
  readonly fileId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly status: DocumentExtractionStatus;
  readonly warnings: readonly string[];
}

interface ReadyDocumentWorkflowExecution {
  readonly workflow: ConversationWorkflowDto;
  readonly conversation: ConversationDto;
  readonly requirements: string;
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly action: OfficeRequestAction;
  readonly targetMessageId?: string;
  readonly useInternalSources: boolean;
  readonly researchReferences?: readonly WebResearchReferenceDto[];
}

export function ChatPage({
  initialConversationId,
  onConversationChange,
  initialCandidateId,
  onCandidateChange,
  onOpenLibrary
}: ChatPageProps) {
  const chat = window.unicomp?.chatContexts;
  const webResearch = window.unicomp?.webResearch;
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
    'blueprint' | 'ink' | 'forest' | 'financing'
  >('blueprint');
  const [presentationTemplate, setPresentationTemplate] =
    useState<PresentationTemplateSelection>('auto');
  const [documentGenerationActive, setDocumentGenerationActive] =
    useState(false);
  // Document requests stream a machine-readable outline internally. Keep that
  // payload out of the visible chat and show only the controlled progress copy.
  const [documentResponseActive, setDocumentResponseActive] = useState(false);
  const [documentCancelRequested, setDocumentCancelRequested] =
    useState(false);
  const [aiImagesEnabled, setAiImagesEnabled] = useState(false);
  const [imageCandidateOptions, setImageCandidateOptions] = useState<
    readonly { readonly candidateId: string; readonly label: string }[]
  >([]);
  const [selectedImageCandidateId, setSelectedImageCandidateId] =
    useState<string>();
  const [ragEnabled, setRagEnabled] = useState(false);
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [dragging, setDragging] = useState(false);
  const [responseFeature, setResponseFeature] = useState<'text_chat' | 'text_reasoning'>('text_chat');
  const [responseCandidates, setResponseCandidates] = useState<readonly ConversationResponseCandidateDto[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | undefined>(initialCandidateId);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [responseExecution, setResponseExecution] = useState<ConversationResponseExecutionDto>();
  const [responseStarting, setResponseStarting] = useState(false);
  const [activeWorkflow, setActiveWorkflow] = useState<ConversationWorkflowDto>();
  const [webResearchSession, setWebResearchSession] = useState<WebResearchSessionDto>();
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
  const [planningActive, setPlanningActive] = useState(false);
  const [planningCancelRequested, setPlanningCancelRequested] = useState(false);
  const [notice, setNotice] = useState('');
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const cancelAfterStartRef = useRef(false);
  const inputValueRef = useRef('');
  const workflowSubmissionInFlightRef = useRef(false);
  const planningCommandRef = useRef<{ readonly clientCommandId: string; cancelled: boolean }>();
  const workflowExecutionInFlightRef = useRef(false);
  const workflowResearchReferencesRef = useRef<{
    readonly workflowId: string;
    readonly references: readonly WebResearchReferenceDto[];
  }>();
  const composerScopeRef = useRef(0);
  const attachmentImportInFlightRef = useRef(false);
  const attachmentSelectionChangedRef = useRef(false);
  const sessionProjectIdRef = useRef<string>();
  const documentGenerationInFlightRef = useRef(false);
  const documentResponseUserIdsRef = useRef(new Set<string>());
  const documentOrchestrationCancelRef = useRef(false);
  const activeDocumentGenerationRef = useRef<{
    readonly conversationId: string;
    readonly expectedRevision: number;
    readonly messageId: string;
  }>();
  const responseFailureSafeCodeRef = useRef<{
    readonly executionId: string;
    readonly safeCode?: string;
  }>();
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
  const composerDocumentKind =
    documentKind !== 'auto'
      ? documentKind
      : input.trim()
        ? inferDocumentKind(input)
        : documentKind;

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
          if (sessionProjectIdRef.current !== sessionResult.value?.projectId) {
            sessionProjectIdRef.current = sessionResult.value?.projectId;
            resetComposerScope();
            updateInput('');
            setActiveWorkflow(undefined);
            setWebResearchSession(undefined);
          }
          setSession(sessionResult.value);
          if (sessionResult.value) {
            setNotice((current) => current === '请先打开项目。' ? '' : current);
          }
        }
        else setNotice('读取当前项目失败，请重试。');
        if (conversationResult.ok) {
          let loadedConversations = conversationResult.value;
          let reconciledInterruptedRun = false;
          if (sessionResult.ok && sessionResult.value && documentGeneration) {
            for (const conversation of loadedConversations) {
              for (const message of conversation.messages) {
                if (
                  message.documentGenerationStatus &&
                  ['generating_content', 'validating_outline', 'generating_file'].includes(
                    message.documentGenerationStatus.state
                  )
                ) {
                  const result = await documentGeneration.reconcileGeneration({
                    conversationId: conversation.conversationId,
                    expectedRevision: conversation.revision,
                    messageId: message.messageId
                  });
                  reconciledInterruptedRun ||= result.ok && result.value.interrupted;
                }
              }
            }
            if (reconciledInterruptedRun) {
              const refreshed = await chat.listConversations(true, false);
              if (refreshed.ok) loadedConversations = refreshed.value;
            }
          }
          setConversations(loadedConversations);
          setSelectedId((current) =>
            current && loadedConversations.some((item) => item.conversationId === current)
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
  }, [chat, documentGeneration, storage]);

  useEffect(() => {
    onConversationChange?.(selectedId);
  }, [onConversationChange, selectedId]);

  useEffect(() => {
    onCandidateChange?.(selectedCandidateId);
  }, [onCandidateChange, selectedCandidateId]);

  useEffect(() => {
    let active = true;
    if (!chat || !selected?.conversationId) {
      setActiveWorkflow(undefined);
      setWebResearchSession(undefined);
      return () => {
        active = false;
      };
    }
    void chat.getPendingWorkflow(selected.conversationId).then((result) => {
      if (!active) return;
      setActiveWorkflow(result.ok ? result.value ?? undefined : undefined);
      setWebResearchSession(undefined);
    }).catch(() => {
      if (active) setActiveWorkflow(undefined);
    });
    return () => {
      active = false;
    };
  }, [chat, selected?.conversationId]);

  useEffect(() => {
    let active = true;
    async function loadImageCandidates() {
      if (!documentMode || !aiImagesEnabled || !imageFeatures) return;
      const result = await imageFeatures.listQuickCandidates();
      if (!active || !result.ok) return;
      const options = result.value
        .filter((item) => item.available && canAutoGenerateImageCandidate(item))
        .map((item) => ({
          candidateId: item.candidateId,
          label: `${item.modelName}（${item.providerName}）`
        }));
      setImageCandidateOptions(options);
      setSelectedImageCandidateId((current) =>
        current && options.some((option) => option.candidateId === current)
          ? current
          : options[0]?.candidateId
      );
    }
    void loadImageCandidates();
    return () => {
      active = false;
    };
  }, [documentMode, aiImagesEnabled]);

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
      responseFailureSafeCodeRef.current = {
        executionId,
        ...(event.type === 'stream_failed' && event.safeCode
          ? { safeCode: event.safeCode }
          : {})
      };
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
    if (responseInProgress || busy || documentGenerationInFlightRef.current) {
      setNotice('请先停止当前回复，再开始新的对话。');
      return;
    }
    if (!confirmLeaveUnsentInput()) return;
    resetComposerScope();
    setSelectedId(undefined);
    setActiveWorkflow(undefined);
    setWebResearchSession(undefined);
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
    responseFailureSafeCodeRef.current = undefined;
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
    if (documentResponseUserIdsRef.current.has(userMessageId)) return;
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
    if (!input.trim() && attachments.length === 0) return true;
    return window.confirm('当前输入尚未发送，确定离开并丢弃吗？');
  }

  function resetComposerScope() {
    composerScopeRef.current += 1;
    documentResponseUserIdsRef.current.clear();
    setAttachments([]);
    attachmentSelectionChangedRef.current = false;
    setDocumentMode(false);
    setDocumentKind('auto');
    setRagEnabled(false);
    setAiImagesEnabled(false);
    setIncludedContextIds([]);
    setContextDraft(undefined);
    setViewedContexts({});
  }

  function selectConversation(conversationId: string) {
    if (conversationId === selectedId) return;
    if (responseInProgress || busy || documentGenerationInFlightRef.current) {
      setNotice('请先停止当前任务，再切换对话。');
      return;
    }
    if (!confirmLeaveUnsentInput()) return;
    resetComposerScope();
    updateInput('');
    setEditingMessageId(undefined);
    setSelectedId(conversationId);
    setActiveWorkflow(undefined);
    setWebResearchSession(undefined);
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
      cancelRequested ||
      responseInProgress ||
      busy
    ) {
      return;
    }
    if (editingMessageId) {
      if (!selectedCandidateId || !selectedCandidate?.available) {
        setNotice('请先选择一个可用模型。');
        return;
      }
      await startChatResponse(input.trim(), selected);
      return;
    }
    await submitWorkflowInput();
  }

  async function submitWorkflowInput() {
    if (workflowSubmissionInFlightRef.current) return;
    if (!chat || !session || !input.trim() || busy || responseInProgress) return;
    workflowSubmissionInFlightRef.current = true;
    const planningCommand = { clientCommandId: `chat-workflow-${crypto.randomUUID()}`, cancelled: false };
    planningCommandRef.current = planningCommand;
    setPlanningActive(true);
    setPlanningCancelRequested(false);
    const content = input.trim();
    const inputScope = composerScopeRef.current;
    const attachmentSelection = attachmentSelectionChangedRef.current
      ? { attachmentFileIds: attachments.map((attachment) => attachment.fileId) }
      : {};
    const semanticSelection = selectedCandidateId && selectedCandidate?.available
      ? { semanticCandidate: { candidateId: selectedCandidateId, productFeature: responseFeature } }
      : {};
    setWebResearchSession(undefined);
    setBusy(true);
    const answerCurrentWorkflow = activeWorkflow && selected &&
      ['needs_clarification', 'needs_confirmation', 'ready'].includes(activeWorkflow.status);
    setNotice(answerCurrentWorkflow ? '正在合并补充信息…' : '正在理解需求…');
    let ready:
      | { readonly workflow: ConversationWorkflowDto; readonly conversation: ConversationDto }
      | undefined;
    try {
      const result = answerCurrentWorkflow
        ? await chat.answerWorkflow({
            clientCommandId: planningCommand.clientCommandId,
            workflowId: activeWorkflow.workflowId,
            expectedWorkflowRevision: activeWorkflow.revision,
            expectedConversationRevision: selected.revision,
            content,
            ...attachmentSelection,
            ...semanticSelection
          })
        : await chat.startWorkflow({
            clientCommandId: planningCommand.clientCommandId,
            conversation: selected
              ? {
                  conversationId: selected.conversationId,
                  expectedRevision: selected.revision
                }
              : null,
            title: conversationTitleFromMessage(content),
            content,
            ...attachmentSelection,
            ...semanticSelection,
            ...(documentMode
              ? {
                  intentHint: {
                    kind: 'document' as const,
                    documentKind
                  }
                }
              : {})
          });
      if (inputScope !== composerScopeRef.current) return;
      if (planningCommand.cancelled) {
        if (result.ok) {
          const cancelled = await chat.cancelWorkflow(result.value.workflow.workflowId, result.value.workflow.revision);
          replaceConversation(result.value.conversation);
          setSelectedId(result.value.conversation.conversationId);
          setActiveWorkflow(cancelled.ok ? undefined : result.value.workflow);
          if (!cancelled.ok) {
            setNotice(describeChatError(cancelled.error));
            return;
          }
        }
        setNotice('需求理解已停止，未开始后续执行。');
        return;
      }
      if (!result.ok) {
        setNotice(describeChatError(result.error));
        return;
      }
      replaceConversation(result.value.conversation);
      setSelectedId(result.value.conversation.conversationId);
      setActiveWorkflow(result.value.workflow);
      attachmentSelectionChangedRef.current = false;
      updateInput('');
      if (result.value.workflow.status === 'cancelled') {
        setActiveWorkflow(undefined);
        setWebResearchSession(undefined);
        setDocumentMode(false);
        setNotice('任务已取消，可以直接发送新的需求。');
        return;
      }
      if (result.value.workflow.status === 'needs_clarification') {
        setNotice(workflowQuestion(result.value.workflow));
        return;
      }
      if (result.value.workflow.status === 'needs_confirmation') {
        setNotice('请确认当前任务计划后再执行。');
        return;
      }
      if (result.value.workflow.status !== 'ready') {
        setNotice('会话任务当前不可执行，请重新发送需求。');
        return;
      }
      ready = result.value;
    } catch {
      setNotice(planningCommand.cancelled
        ? '需求理解已停止，未开始后续执行。'
        : errorMessages.storage_error);
    } finally {
      setBusy(false);
      workflowSubmissionInFlightRef.current = false;
      if (planningCommandRef.current === planningCommand) {
        planningCommandRef.current = undefined;
        setPlanningActive(false);
        setPlanningCancelRequested(false);
      }
    }
    if (ready) await executeReadyWorkflow(ready.workflow, ready.conversation);
  }

  async function cancelWorkflowPlanning() {
    const command = planningCommandRef.current;
    if (!chat || !command || command.cancelled) return;
    command.cancelled = true;
    setPlanningCancelRequested(true);
    setNotice('正在停止需求理解…');
    try {
      const result = await chat.cancelPlanning({ clientCommandId: command.clientCommandId });
      if (!result.ok) setNotice('已停止后续执行，正在等待当前模型调用结束。');
    } catch {
      setNotice('已停止后续执行，正在等待当前模型调用结束。');
    }
  }

  async function executeReadyWorkflow(
    workflow: ConversationWorkflowDto,
    conversation: ConversationDto,
    suppliedResearchReferences?: readonly WebResearchReferenceDto[]
  ) {
    if (workflowExecutionInFlightRef.current) return;
    workflowExecutionInFlightRef.current = true;
    const executionScope = composerScopeRef.current;
    documentOrchestrationCancelRef.current = false;
    let currentWorkflow = workflow;
    let currentConversation = conversation;
    let sequenceReferences = suppliedResearchReferences;
    try {
      // The allowed Office kinds bound the sequence to at most three deliveries.
      for (let step = 0; step < 3; step += 1) {
        if (documentOrchestrationCancelRef.current || executionScope !== composerScopeRef.current) return;
        const delivered = await executeWorkflowStep(
          currentWorkflow, currentConversation, sequenceReferences
        );
        if (executionScope !== composerScopeRef.current) return;
        if (!chat) return;
        if (!delivered || documentOrchestrationCancelRef.current) {
          if (currentWorkflow.plan.kind === 'document') {
            if (documentOrchestrationCancelRef.current) {
              const latest = await chat.getWorkflow(currentWorkflow.workflowId);
              if (latest.ok && latest.value.status !== 'completed' && latest.value.status !== 'cancelled') {
                const cancelled = await chat.cancelWorkflow(latest.value.workflowId, latest.value.revision);
                setActiveWorkflow(cancelled.ok ? undefined : latest.value);
                if (!cancelled.ok) setNotice(describeChatError(cancelled.error));
              } else if (latest.ok) {
                setActiveWorkflow(undefined);
              }
              return;
            }
            const pending = await chat.getPendingWorkflow(currentConversation.conversationId);
            if (pending.ok) {
              if (pending.value && pending.value.workflowId !== currentWorkflow.workflowId) return;
              if (documentOrchestrationCancelRef.current && pending.value) {
                const cancelled = await chat.cancelWorkflow(pending.value.workflowId, pending.value.revision);
                setActiveWorkflow(cancelled.ok ? undefined : pending.value);
                if (!cancelled.ok) setNotice(describeChatError(cancelled.error));
              } else {
                setActiveWorkflow(pending.value ?? undefined);
              }
            }
          }
          return;
        }
        setBusy(true);
        const [pending, refreshed] = await Promise.all([
          chat.getPendingWorkflow(currentConversation.conversationId),
          chat.getConversation(currentConversation.conversationId)
        ]);
        if (refreshed.ok) replaceConversation(refreshed.value);
        if (!pending.ok || !refreshed.ok) {
          setNotice('本项已交付，后续任务状态未能同步；请刷新后继续。');
          return;
        }
        if (pending.value && pending.value.workflowId !== currentWorkflow.workflowId) {
          setActiveWorkflow(undefined);
          return;
        }
        setActiveWorkflow(pending.value ?? undefined);
        if (documentOrchestrationCancelRef.current && pending.value) {
          const cancelled = await chat.cancelWorkflow(pending.value.workflowId, pending.value.revision);
          setActiveWorkflow(cancelled.ok ? undefined : pending.value);
          if (!cancelled.ok) setNotice(describeChatError(cancelled.error));
          return;
        }
        if (!pending.value || pending.value.status !== 'ready') return;
        if (pending.value.workflowId !== currentWorkflow.workflowId) return;
        const deliveredKind = currentWorkflow.plan.documentKind;
        if (pending.value.plan.documentKind === deliveredKind ||
            !pending.value.deliveries?.some((delivery) =>
              delivery.kind === deliveredKind && delivery.status === 'completed')) {
          setNotice('本项已交付，但后续任务进度尚未确认；请刷新核对，避免重复生成。');
          return;
        }
        currentWorkflow = pending.value;
        currentConversation = refreshed.value;
        if (workflowResearchReferencesRef.current?.workflowId === workflow.workflowId) {
          sequenceReferences = workflowResearchReferencesRef.current.references;
        }
        setNotice('上一项已交付，正在准备下一份文档…');
      }
    } catch {
      setNotice('任务状态未能确认，请刷新后核对；已交付作品已保留，请勿重复发送。');
    } finally {
      workflowExecutionInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function executeWorkflowStep(
    workflow: ConversationWorkflowDto,
    conversation: ConversationDto,
    suppliedResearchReferences?: readonly WebResearchReferenceDto[]
  ): Promise<boolean | undefined> {
    let researchReferences = suppliedResearchReferences ?? [];
    if (!suppliedResearchReferences &&
        (workflow.plan.sourcePolicy === 'web' || workflow.plan.sourcePolicy === 'mixed')) {
      if (!webResearch) {
        await cancelUnsupportedWebWorkflow(workflow);
        return;
      }
      setBusy(true);
      setNotice('正在检查本地资料并准备联网预览…');
      try {
        const preview = await webResearch.preview({
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: workflow.revision,
          expectedConversationRevision: conversation.revision
        });
        if (!preview.ok) {
          await cancelUnsupportedWebWorkflow(
            workflow,
            `${preview.error.message}，任务已取消，未执行。`
          );
          return;
        }
        setWebResearchSession(preview.value);
        researchReferences = preview.value.references;
        if (preview.value.status === 'authorization_required') {
          setNotice('请确认联网检索的外发范围后再继续。');
          return;
        }
        if (preview.value.status === 'unavailable' || preview.value.status === 'failed') {
          await cancelUnsupportedWebWorkflow(
            workflow,
            '联网检索不可用，任务已取消，未执行。'
          );
          return;
        }
      } catch {
        await cancelUnsupportedWebWorkflow(
          workflow,
          '联网检索预览失败，任务已取消，未执行。'
        );
        return;
      } finally {
        setBusy(false);
      }
    }
    const source = conversation.messages.find(
      (message) => message.messageId === workflow.sourceMessageId
    );
    const sourceContent = source?.content ?? '';
    workflowResearchReferencesRef.current = { workflowId: workflow.workflowId, references: researchReferences };
    if (workflow.plan.kind === 'document') {
      const kind = workflow.plan.documentKind && workflow.plan.documentKind !== 'auto'
        ? workflow.plan.documentKind
        : inferDocumentKind(sourceContent);
      setDocumentKind(kind);
      setDocumentMode(true);
      const targetMessageId = workflow.resolvedTarget?.artifactRef ??
        (workflow.plan.targetHint?.unit === 'document'
          ? conversation.messages.find(
              (message) => message.documentResult?.fileName === workflow.plan.targetHint?.name
            )?.messageId
          : undefined);
      return sendDocumentMessage({
        workflow,
        conversation,
        requirements: composeWorkflowRequirements(workflow, sourceContent),
        kind,
        action: workflow.plan.action === 'revise' ? 'revise' : 'create',
        targetMessageId,
        useInternalSources: workflow.plan.sourcePolicy === 'internal' || ragEnabled,
        researchReferences
      });
    }
    if (!selectedCandidateId || !selectedCandidate?.available) {
      setActiveWorkflow(workflow);
      setNotice('需求已准备好，请选择一个可用模型后继续。');
      return;
    }
    if (workflow.plan.kind !== 'chat') {
      setNotice(workflowQuestion(workflow));
      return;
    }
    setDocumentMode(false);
    const researchText = composeResearchInput(
      composeWorkflowRequirements(workflow, sourceContent), researchReferences
    );
    await startChatResponse(researchText, conversation, workflow);
  }

  async function cancelUnsupportedWebWorkflow(
    workflow: ConversationWorkflowDto,
    successNotice = '当前版本尚未接入经授权的联网检索，任务已取消，未执行。'
  ) {
    if (!chat) return;
    setBusy(true);
    try {
      if (webResearch) {
        await webResearch.cancel({
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: workflow.revision
        }).catch(() => undefined);
      }
      const result = await chat.cancelWorkflow(
        workflow.workflowId,
        workflow.revision
      );
      if (!result.ok) {
        setActiveWorkflow(workflow);
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setActiveWorkflow(undefined);
      setWebResearchSession(undefined);
      setNotice(successNotice);
    } catch {
      setActiveWorkflow(workflow);
      setNotice(errorMessages.storage_error);
    } finally {
      setBusy(false);
    }
  }

  async function authorizeWebResearch() {
    if (!chat || !webResearch || !activeWorkflow || !selected || !webResearchSession || busy) return;
    if (webResearchSession.status !== 'authorization_required') return;
    setBusy(true);
    setNotice('正在提交联网授权…');
    try {
      const result = await webResearch.authorize({
        workflowId: activeWorkflow.workflowId,
        expectedWorkflowRevision: activeWorkflow.revision,
        expectedConversationRevision: selected.revision,
        planHash: webResearchSession.planHash,
        confirmed: true
      });
      if (!result.ok) {
        await cancelUnsupportedWebWorkflow(
          activeWorkflow,
          `${result.error.message}，任务已取消，未执行。`
        );
        return;
      }
      setWebResearchSession(result.value);
      if (result.value.status !== 'completed' && result.value.status !== 'local_ready') {
        await cancelUnsupportedWebWorkflow(
          activeWorkflow,
          '联网检索未完成，任务已取消，未执行。'
        );
        return;
      }
      await executeReadyWorkflow(activeWorkflow, selected, result.value.references);
    } catch {
      await cancelUnsupportedWebWorkflow(
        activeWorkflow,
        '联网授权或检索失败，任务已取消，未执行。'
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmActiveWorkflow() {
    if (!chat || !activeWorkflow || !selected || busy) return;
    setBusy(true);
    setNotice('正在确认任务…');
    let confirmed: ConversationWorkflowDto | undefined;
    let conversation: ConversationDto | undefined;
    try {
      const result = await chat.confirmWorkflow(
        activeWorkflow.workflowId,
        activeWorkflow.revision
      );
      if (!result.ok) {
        if (result.error.code === 'confirmation_expired') setActiveWorkflow(undefined);
        setNotice(errorMessages[result.error.code]);
        return;
      }
      const refreshed = await chat.getConversation(selected.conversationId);
      if (!refreshed.ok) {
        setNotice(errorMessages[refreshed.error.code]);
        return;
      }
      confirmed = result.value;
      conversation = refreshed.value;
      setActiveWorkflow(confirmed);
      replaceConversation(conversation);
    } catch {
      setNotice(errorMessages.storage_error);
    } finally {
      setBusy(false);
    }
    if (confirmed && conversation) {
      await executeReadyWorkflow(confirmed, conversation);
    }
  }

  async function continueActiveWorkflow() {
    if (!activeWorkflow || activeWorkflow.status !== 'ready' || !selected || busy) return;
    await executeReadyWorkflow(activeWorkflow, selected);
  }

  async function cancelActiveWorkflow() {
    if (!chat || !activeWorkflow || busy) return;
    setBusy(true);
    try {
      if (
        webResearch &&
        webResearchSession &&
        ['authorization_required', 'searching'].includes(webResearchSession.status)
      ) {
        await webResearch.cancel({
          workflowId: activeWorkflow.workflowId,
          expectedWorkflowRevision: activeWorkflow.revision
        }).catch(() => undefined);
      }
      const result = await chat.cancelWorkflow(
        activeWorkflow.workflowId,
        activeWorkflow.revision
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setActiveWorkflow(undefined);
      setWebResearchSession(undefined);
      setNotice('当前任务已取消。');
    } catch {
      setNotice(errorMessages.storage_error);
    } finally {
      setBusy(false);
    }
  }

  async function resumeFailedOfficeWorkflow() {
    if (!chat || !activeWorkflow || !selected || busy || responseInProgress) return;
    setBusy(true);
    let resumed: ConversationWorkflowDto | undefined;
    try {
      const result = await chat.resumeFailedWorkflow(
        activeWorkflow.workflowId,
        activeWorkflow.revision
      );
      if (!result.ok) {
        setNotice(describeChatError(result.error));
        return;
      }
      resumed = result.value;
      setActiveWorkflow(resumed);
    } catch {
      setNotice('任务状态未能同步，请刷新后确认。');
    } finally {
      setBusy(false);
    }
    if (resumed?.status === 'executing') {
      await retryLocalOfficeDelivery(resumed, selected);
    } else if (resumed) {
      await executeReadyWorkflow(resumed, selected);
    }
  }

  async function retryLocalOfficeDelivery(workflow: ConversationWorkflowDto, conversation: ConversationDto) {
    if (!chat || !documentGeneration || documentGenerationInFlightRef.current) return;
    const delivery = workflow.deliveries?.find((item) =>
      item.kind === workflow.plan.documentKind && item.status === 'executing');
    if (!delivery?.resultMessageId) {
      setNotice('缺少上次已完成的文档内容，请先核对任务记录。');
      return;
    }
    const executionScope = composerScopeRef.current;
    documentGenerationInFlightRef.current = true;
    documentOrchestrationCancelRef.current = false;
    setBusy(true);
    let next: { workflow: ConversationWorkflowDto; conversation: ConversationDto } | undefined;
    try {
      const refreshed = await chat.getConversation(conversation.conversationId);
      if (executionScope !== composerScopeRef.current) return;
      if (!refreshed.ok) {
        setNotice(describeChatError(refreshed.error));
        return;
      }
      const message = refreshed.value.messages.find((item) => item.messageId === delivery.resultMessageId);
      if (!message || message.role !== 'assistant' || message.state !== 'completed' || !message.content.trim()) {
        setNotice('上次文档内容尚未确认完成，已停止重试，请核对原任务。');
        return;
      }
      const generationContext = {
        conversationId: refreshed.value.conversationId,
        expectedRevision: refreshed.value.revision,
        messageId: delivery.resultMessageId
      };
      activeDocumentGenerationRef.current = generationContext;
      setDocumentGenerationActive(true);
      setDocumentCancelRequested(false);
      setNotice('正在用已完成的内容重试本地文档生成…');
      // The main process restores the persisted original template/images/options.
      const generated = await documentGeneration.generateFromMessage({ ...generationContext, kind: delivery.kind });
      if (executionScope !== composerScopeRef.current) return;
      const [latest, pending] = await Promise.all([
        chat.getConversation(conversation.conversationId),
        chat.getPendingWorkflow(conversation.conversationId)
      ]);
      if (latest.ok) replaceConversation(latest.value);
      if (pending.ok) setActiveWorkflow(pending.value?.workflowId === workflow.workflowId ? pending.value : undefined);
      if (!generated.ok) {
        setNotice(describeDocumentError(generated.error));
        return;
      }
      setNotice(`${documentKindLabel(delivery.kind)} 已交付。`);
      if (pending.ok && pending.value?.workflowId === workflow.workflowId && documentOrchestrationCancelRef.current) {
        const cancelled = await chat.cancelWorkflow(pending.value.workflowId, pending.value.revision);
        setActiveWorkflow(cancelled.ok ? undefined : pending.value);
        return;
      }
      if (latest.ok && pending.ok && pending.value?.workflowId === workflow.workflowId && pending.value.status === 'ready' &&
          pending.value.plan.documentKind !== delivery.kind &&
          pending.value.deliveries?.some((item) => item.kind === delivery.kind && item.status === 'completed')) {
        next = { workflow: pending.value, conversation: latest.value };
      }
    } catch {
      setNotice('本地生成状态未能确认，请核对当前任务；已完成的模型内容已保留。');
    } finally {
      activeDocumentGenerationRef.current = undefined;
      documentGenerationInFlightRef.current = false;
      setDocumentGenerationActive(false);
      setDocumentCancelRequested(false);
      setBusy(false);
    }
    if (next && !documentOrchestrationCancelRef.current) await executeReadyWorkflow(next.workflow, next.conversation);
  }

  async function startChatResponse(
    commandContent: string,
    conversation?: ConversationDto,
    workflow?: ConversationWorkflowDto
  ) {
    if (!chat || !selectedCandidateId || !selectedCandidate?.available) return;
    const executionScope = composerScopeRef.current;
    rendererTrace('sendMessage:start', {
      selectedId,
      editingMessageId,
      productFeature: responseFeature,
      candidateId: selectedCandidateId
    });
    setResponseStarting(true);
    setNotice('正在准备回复…');
    clearResponseDraftState();
    const commandEditingMessageId = workflow ? undefined : editingMessageId;
    try {
      const started = await chat.startResponse({
        clientCommandId: `chat-start-${crypto.randomUUID()}`,
        conversation: conversation
          ? {
              conversationId: conversation.conversationId,
              expectedRevision: conversation.revision,
              editedMessageId: commandEditingMessageId ?? null
            }
          : null,
        title: conversationTitleFromMessage(commandContent),
        content: commandContent,
        ...(!workflow && attachmentSelectionChangedRef.current
          ? { attachmentFileIds: attachments.map((attachment) => attachment.fileId) }
          : {}),
        ...(workflow
          ? {
              workflow: {
                workflowId: workflow.workflowId,
                expectedRevision: workflow.revision
              }
            }
          : {}),
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
      if (executionScope !== composerScopeRef.current) return;
      if (!started.ok) {
        rendererTrace('sendMessage:startResponse-error', {
          code: started.error.code,
          message: started.error.message
        });
        cancelAfterStartRef.current = false;
        cancelRequestedRef.current = false;
        setCancelRequested(false);
        setNotice(describeChatError(started.error));
        if (conversation) {
          const refreshed = await chat.getConversation(conversation.conversationId);
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
      setActiveWorkflow(undefined);
      setAttachments([]);
      attachmentSelectionChangedRef.current = false;
      setDocumentMode(false);
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
    if (!documentAttachments || !session || responseInProgress) return;
    const sourcePath = window.unicomp?.getPathForFile(file);
    if (!sourcePath) {
      setNotice('无法读取拖入的文件，请尝试使用本地选择。');
      return;
    }
    setNotice('');
    const inputScope = composerScopeRef.current;
    try {
      const result = await documentAttachments.importAttachment({ sourcePath });
      if (inputScope !== composerScopeRef.current) return;
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
        ...current.filter((attachment) => attachment.fileId !== result.value.fileId),
        {
          fileId: result.value.fileId,
          fileName: result.value.fileName,
          sizeBytes: result.value.sizeBytes,
          status: result.value.extraction.status,
          warnings: result.value.extraction.warnings
        }
      ]);
      attachmentSelectionChangedRef.current = true;
      if (result.value.extraction.status !== 'extracted') {
        setNotice(
          result.value.extraction.warnings.join('；') ||
          '附件已导入，但当前无法读取正文；请提供可提取文本的资料。'
        );
      }
    } catch {
      setNotice('附件导入失败，请重试。');
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
      void importDroppedFiles(files);
    }
  }

  async function importDroppedFiles(files: readonly File[]) {
    if (attachmentImportInFlightRef.current) return;
    if (attachments.length + files.length > 8) {
      setNotice('单次最多选择 8 份资料，请分次处理。');
      return;
    }
    attachmentImportInFlightRef.current = true;
    const inputScope = composerScopeRef.current;
    setBusy(true);
    try {
      for (const file of files) {
        if (inputScope !== composerScopeRef.current) break;
        await importDroppedFile(file);
      }
    } finally {
      attachmentImportInFlightRef.current = false;
      setBusy(false);
    }
  }

  function removeAttachment(fileId: string) {
    attachmentSelectionChangedRef.current = true;
    setAttachments((current) =>
      current.filter((attachment) => attachment.fileId !== fileId)
    );
  }

  async function sendDocumentMessage(execution: ReadyDocumentWorkflowExecution): Promise<boolean | undefined> {
    if (documentGenerationInFlightRef.current) return;
    const executionConversation = execution.conversation;
    const executionScope = composerScopeRef.current;
    if (
      !chat ||
      !documentGeneration ||
      !session ||
      executionConversation.readOnly ||
      executionConversation.status !== 'active' ||
      busy ||
      responseInProgress
    ) {
      return;
    }
    const requirements = execution.workflow.plan.deliverables && execution.workflow.plan.deliverables.length > 1
      ? `${execution.requirements}\n\n关联任务执行范围：当前仅生成 ${documentKindLabel(execution.kind)}。保留上述主题、数据依据和有效约束；其他 Office 交付物由应用另行顺序执行。本轮只返回当前文档的一份完整大纲。`
      : execution.requirements;
    const action = execution.action;
    const kind = execution.kind;
    const targetMessageId = execution.targetMessageId;
    const conversationDocumentMessages = executionConversation.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        message.state === 'completed' &&
        message.documentResult
    );
    const previousDocument =
      action === 'revise'
        ? targetMessageId
          ? conversationDocumentMessages.find(
              (item) => item.messageId === targetMessageId
            )
          : [...conversationDocumentMessages]
              .reverse()
              .find((item) => item.documentResult?.kind === kind)
        : undefined;
    if (action === 'revise' && !previousDocument) {
      setNotice(`请先生成或选择一份可修改的上一版 ${documentKindLabel(kind)}。`);
      return;
    }
    const sourceMessage = executionConversation.messages.find(
      (message) => message.messageId === execution.workflow.sourceMessageId
    );
    const previousAttachmentMessage = [...executionConversation.messages]
      .reverse()
      .find((message) => message.role === 'user' &&
        (message.attachmentSelection === 'replace' || message.attachments.length > 0));
    const documentImageAttachments = attachments.length > 0
      ? attachments.filter((attachment) => isImageFileName(attachment.fileName))
          .map((attachment) => ({ fileId: attachment.fileId, caption: attachment.fileName }))
      : (previousAttachmentMessage?.attachments ?? []).flatMap((attachment) =>
          attachment.kind === 'file_reference' && attachment.fileName && isImageFileName(attachment.fileName)
            ? [{ fileId: attachment.fileReferenceId, caption: attachment.fileName }]
            : []);
    const deterministicTarget = parseDeterministicClearRevisionTarget(
      sourceMessage?.content ?? ''
    );
    const workflowTarget = execution.workflow.plan.targetHint;
    const useDeterministicLocalRevision = Boolean(
      action === 'revise' &&
      previousDocument?.documentResult?.validatedContent &&
      deterministicTarget &&
      workflowTarget?.unit === deterministicTarget.unit &&
      workflowTarget.ordinal === deterministicTarget.ordinal &&
      workflowTarget.name === undefined &&
      execution.workflow.plan.sourcePolicy === 'none' &&
      attachments.length === 0 &&
      (execution.researchReferences?.length ?? 0) === 0
    );
    if (
      !useDeterministicLocalRevision &&
      (!selectedCandidateId || !selectedCandidate?.available)
    ) {
      setActiveWorkflow(execution.workflow);
      setNotice('这项文档任务需要模型生成内容，请选择一个可用模型后继续。');
      return;
    }
    documentGenerationInFlightRef.current = true;
    documentOrchestrationCancelRef.current = false;
    setDocumentCancelRequested(false);
    responseFailureSafeCodeRef.current = undefined;
    setBusy(true);
    setNotice(
      useDeterministicLocalRevision
        ? '正在本地校验并修改文档…'
        : 'AI 正在撰写文档内容…'
    );
    rendererTrace('sendDocumentMessage:start', JSON.stringify({
      selectedId: executionConversation.conversationId,
      documentKind,
      action,
      candidateId: selectedCandidateId,
      productFeature: responseFeature
    }));
    if (useDeterministicLocalRevision && previousDocument?.documentResult) {
      try {
        const prepared = await documentGeneration.prepareDeterministicRevision({
          conversationId: executionConversation.conversationId,
          expectedRevision: executionConversation.revision,
          workflowId: execution.workflow.workflowId,
          expectedWorkflowRevision: execution.workflow.revision,
          kind,
          parentWorkId: previousDocument.documentResult.workId
        });
        if (executionScope !== composerScopeRef.current) return;
        if (!prepared.ok) {
          setNotice(describeDocumentError(prepared.error));
          setActiveWorkflow(execution.workflow);
          return;
        }
        setActiveWorkflow(undefined);
        const preparedConversation = await chat.getConversation(
          prepared.value.conversationId
        );
        if (preparedConversation.ok) {
          replaceConversation(preparedConversation.value);
          setSelectedId(preparedConversation.value.conversationId);
        }
        const generationContext = {
          conversationId: prepared.value.conversationId,
          expectedRevision: prepared.value.expectedRevision,
          messageId: prepared.value.messageId
        };
        activeDocumentGenerationRef.current = generationContext;
        setDocumentGenerationActive(true);
        setDocumentCancelRequested(false);
        const generated = await documentGeneration.generateFromMessage({
          ...generationContext,
          kind,
          parentWorkId: previousDocument.documentResult.workId,
          ...(kind === 'ppt'
            ? {
                presentationTemplate: resolvePresentationTemplate(
                  presentationTemplate,
                  requirements
                )
              }
            : { theme: documentTheme }),
          images: []
        });
        if (executionScope !== composerScopeRef.current) return;
        if (!generated.ok) {
          setNotice(describeDocumentError(generated.error));
        } else {
          setNotice(
            `新版文档已生成，基于 ${previousDocument.documentResult.fileName} 修改，原文件已保留。`
          );
          setDocumentMode(false);
        }
        const refreshed = await chat.getConversation(
          prepared.value.conversationId
        );
        if (refreshed.ok) {
          replaceConversation(refreshed.value);
          setSelectedId(refreshed.value.conversationId);
        }
        return generated.ok;
      } catch {
        setNotice('本地文档修改失败，原文件未改变，请重试。');
      } finally {
        activeDocumentGenerationRef.current = undefined;
        setDocumentGenerationActive(false);
        setDocumentCancelRequested(false);
        documentGenerationInFlightRef.current = false;
        setBusy(false);
      }
      return;
    }
    if (!selectedCandidateId || !selectedCandidate) return;
    const modelCandidateId = selectedCandidateId;
    const modelCandidate = selectedCandidate;
    const revisionInput = composeDocumentRevisionInput(
      previousDocument?.documentResult?.validatedContent ?? previousDocument?.content,
      requirements,
      kind
    );
    const resolvedPresentationTemplate = resolvePresentationTemplate(
      presentationTemplate,
      requirements
    );
    const responseParameterValues = documentResponseParameterValues(modelCandidate);
    const combined = composeResearchInput(revisionInput, execution.researchReferences ?? []);
    const kindInstruction = documentKindInstruction(kind);
    const modelContent = `${combined}\n\n${kindInstruction}`;
    if (execution.useInternalSources && attachments.length === 0 && includedContextIds.length === 0 &&
        (previousAttachmentMessage?.attachments.length ?? 0) === 0 &&
        (execution.researchReferences?.length ?? 0) === 0) {
      setNotice('请先选择用于本次任务的附件或项目上下文，再继续生成。');
      setActiveWorkflow(execution.workflow);
      documentGenerationInFlightRef.current = false;
      setBusy(false);
      return;
    }
    setDocumentResponseActive(true);
    try {
      const startDocumentResponse = (
        conversation?: Pick<ConversationDto, 'conversationId' | 'revision'>
      ) =>
        chat.startResponse({
          clientCommandId: `chat-doc-${crypto.randomUUID()}`,
          conversation: conversation
            ? {
                conversationId: conversation.conversationId,
                expectedRevision: conversation.revision,
                editedMessageId: null
              }
            : null,
          title: conversationTitleFromMessage(requirements),
          content: modelContent,
          workflow: {
            workflowId: execution.workflow.workflowId,
            expectedRevision: execution.workflow.revision
          },
          productFeature: responseFeature,
          candidateId: modelCandidateId,
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
          parameterValues: responseParameterValues,
          confirmed: true
        });
      let started = await startDocumentResponse(executionConversation);
      if (executionScope !== composerScopeRef.current) return;
      if (!started.ok && started.error.code === 'revision_conflict') {
        setNotice('会话刚刚更新，正在同步后继续生成…');
        const refreshed = await chat.getConversation(executionConversation.conversationId);
        if (refreshed.ok) {
          replaceConversation(refreshed.value);
          setSelectedId(refreshed.value.conversationId);
          started = await startDocumentResponse(refreshed.value);
        }
      }
      if (!started.ok) {
        rendererTrace('sendDocumentMessage:startResponse-error', JSON.stringify({
          code: started.error.code
        }));
        setNotice(describeChatError(started.error));
        if (executionConversation) {
          const refreshedFailed = await chat.getConversation(executionConversation.conversationId);
          if (refreshedFailed.ok) replaceConversation(refreshedFailed.value);
        }
        return;
      }
      rendererTrace('sendDocumentMessage:startResponse-ok', JSON.stringify({
        conversationId: started.value.conversation.conversationId,
        executionState: started.value.execution.state,
        executionId: started.value.execution.responseExecutionId
      }));
      documentResponseUserIdsRef.current.add(started.value.execution.userMessageId);
      replaceConversation(started.value.conversation);
      setSelectedId(started.value.conversation.conversationId);
      setResponseExecution(started.value.execution);
      if (execution.workflow.deliveries && execution.workflow.deliveries.length > 1) {
        const executing = await chat.getWorkflow(execution.workflow.workflowId);
        if (executing.ok) setActiveWorkflow(executing.value);
      } else {
        setActiveWorkflow(undefined);
      }
      if (documentOrchestrationCancelRef.current) {
        await requestResponseCancellation(started.value.execution, started.value.conversation);
        return;
      }
      const prepared = await documentGeneration.prepareGeneration({
        conversationId: started.value.conversation.conversationId,
        expectedRevision: started.value.conversation.revision,
        messageId: started.value.execution.assistantMessageId,
        kind
      });
      if (!prepared.ok) {
        rendererTrace('sendDocumentMessage:prepare-error', JSON.stringify({
          code: prepared.error.code
        }));
        setNotice(describeDocumentError(prepared.error));
        await requestResponseCancellation(started.value.execution, started.value.conversation);
        return;
      } else {
        const preparedConversation = await chat.getConversation(
          started.value.conversation.conversationId
        );
        if (preparedConversation.ok) replaceConversation(preparedConversation.value);
      }
      updateInput('');
      setAttachments([]);
      const targetId = started.value.conversation.conversationId;
      const completion = await awaitDocumentCompletion(
        chat,
        started.value.execution.responseExecutionId
      );
      if (executionScope !== composerScopeRef.current) return;
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
        if (latest.ok && ['failed', 'cancelled', 'interrupted'].includes(terminal)) {
          await documentGeneration.reconcileGeneration({
            conversationId: targetId,
            expectedRevision: latest.value.revision,
            messageId: started.value.execution.assistantMessageId
          });
          const terminalConversation = await chat.getConversation(targetId);
          if (terminalConversation.ok) replaceConversation(terminalConversation.value);
        }
        const failedMessage = latest.ok
          ? [...latest.value.messages]
              .reverse()
              .find(
                (item) =>
                  item.role === 'assistant' &&
                  item.state === 'failed'
              )
          : undefined;
        const failureSafeCode = responseFailureSafeCodeRef.current as
          | { readonly executionId: string; readonly safeCode?: string }
          | undefined;
        setNotice(
          terminal === 'cancelled'
            ? 'AI 内容生成已取消，文档未生成。'
            : ['unknown', 'pending', 'streaming', 'interrupted'].includes(terminal)
              ? '模型调用结果尚未确认，文档未交付；请先核对调用状态和费用，避免重复发送。'
            : failedMessage
              ? failedResponseNotice(
                failedMessage,
                failureSafeCode?.executionId ===
                  started.value.execution.responseExecutionId
                  ? failureSafeCode.safeCode
                  : undefined
              )
              : 'AI 内容生成失败，文档未生成。'
        );
        return;
      }
      if (documentOrchestrationCancelRef.current) {
        setNotice('已停止后续文档步骤；已发生的模型调用请以调用记录为准。');
        return;
      }
      setNotice('正在生成本地 Office 文档…');
      const aiImages = await generateAiSlideImages(
        completion.content,
        documentImageAttachments.length
      );
      const documentImages = [
        ...documentImageAttachments,
        ...aiImages
      ];
      if (documentOrchestrationCancelRef.current) {
        setNotice('已停止后续文档步骤；已完成的配图和调用记录已保留。');
        return;
      }
      const runDocumentGeneration = async (generationContext: {
        readonly conversationId: string;
        readonly expectedRevision: number;
        readonly messageId: string;
      }) => {
        activeDocumentGenerationRef.current = generationContext;
        setDocumentGenerationActive(true);
        setDocumentCancelRequested(false);
        try {
          return await documentGeneration.generateFromMessage({
            ...generationContext,
            kind,
            ...(previousDocument?.documentResult
              ? { parentWorkId: previousDocument.documentResult.workId }
              : {}),
            ...(kind === 'ppt'
              ? { presentationTemplate: resolvedPresentationTemplate }
              : {}),
            ...(kind !== 'ppt' ? { theme: documentTheme } : {}),
            images: documentImages,
            ...(aiImagesEnabled ? { aiImages: true } : {})
          });
        } finally {
          activeDocumentGenerationRef.current = undefined;
          setDocumentGenerationActive(false);
          setDocumentCancelRequested(false);
        }
      };
      const generated = await runDocumentGeneration({
        conversationId: targetId,
        expectedRevision: refreshedBefore.value.revision,
        messageId: completion.assistantMessageId
      });
      if (executionScope !== composerScopeRef.current) return;
      rendererTrace('sendDocumentMessage:generate-result', JSON.stringify({
        ok: generated.ok,
        code: generated.ok ? undefined : generated.error.code
      }));
      if (!generated.ok) {
        setNotice(describeDocumentError(generated.error));
      } else {
        setNotice(
          previousDocument?.documentResult
            ? `新版文档已生成，基于 ${previousDocument.documentResult.fileName} 修改，原文件已保留。`
            : '文档已生成。'
        );
        setDocumentMode(false);
      }
      const refreshed = await chat.getConversation(targetId);
      if (refreshed.ok) {
        replaceConversation(refreshed.value);
        setSelectedId(refreshed.value.conversationId);
      }
      if (!generated.ok) {
        const pending = await chat.getPendingWorkflow(targetId);
        if (pending.ok) setActiveWorkflow(pending.value ?? undefined);
      }
      return generated.ok;
    } catch {
      setNotice('文档生成未能确认完成，请先核对当前任务状态，避免重复调用。');
    } finally {
      documentGenerationInFlightRef.current = false;
      setDocumentCancelRequested(false);
      setDocumentResponseActive(false);
      setBusy(false);
    }
  }

  async function awaitDocumentCompletion(
    api: NonNullable<typeof chat>,
    responseExecutionId: string
  ): Promise<ConversationResponseExecutionDto | undefined> {
    return waitForDocumentResponseCompletion({
      read: async () => {
        const result = await api.getResponseExecution(responseExecutionId);
        if (!result.ok) throw new Error(result.error.code);
        return result.value;
      },
      wait: (milliseconds) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds))
    });
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
          (item) =>
            item.candidateId === selectedImageCandidateId &&
            item.available &&
            canAutoGenerateImageCandidate(item)
        ) ??
        candidates.value.find(
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
      if (documentOrchestrationCancelRef.current) break;
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

  async function cancelDocumentGeneration() {
    documentOrchestrationCancelRef.current = true;
    const active = activeDocumentGenerationRef.current;
    if (documentCancelRequested) return;
    setDocumentCancelRequested(true);
    if (responseInProgress) {
      await cancelResponse();
      return;
    }
    if (!documentGeneration || !active) {
      setNotice('已请求停止后续步骤，正在等待当前调用返回；已发生的调用和费用以记录为准。');
      return;
    }
    setNotice('已发出文档停止请求，正在清理临时文件…');
    try {
      const result = await documentGeneration.cancelGeneration(active);
      if (!result.ok) {
        setNotice(describeDocumentError(result.error));
        setDocumentCancelRequested(false);
        return;
      }
      if (!result.value.cancelled) {
        setNotice('当前文档生成已结束，无需取消。');
        setDocumentCancelRequested(false);
      }
    } catch {
      setNotice('停止文档生成失败，请重试。');
      setDocumentCancelRequested(false);
    }
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
                  const isDocumentDraftMessage =
                    item.role === 'assistant' &&
                    (Boolean(item.documentResult) ||
                      Boolean(item.documentGenerationStatus));
                  const hideDocumentDraftContent =
                    item.role === 'assistant' &&
                    (isCurrentAssistant || documentResponseActive ||
                      Boolean(item.documentGenerationStatus) ||
                      (documentMode && ['pending', 'streaming'].includes(item.state))) &&
                    isMachineReadableDocumentOutline(item.content);
                  const activityLabel = (documentResponseActive || hideDocumentDraftContent)
                    ? documentGenerationMessage(item.documentGenerationStatus)
                    : cancelRequested
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
                          {isDocumentDraftMessage || hideDocumentDraftContent ? (
                            <p>
                              {item.documentResult
                                ? 'Office 文档已生成。'
                                : documentGenerationMessage(
                                    item.documentGenerationStatus
                                  )}
                            </p>
                          ) : (
                            <MarkdownMessage
                              content={item.content || (item.state === 'streaming' || item.state === 'pending' ? '正在接收…' : '尚无内容')}
                            />
                          )}
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
          {activeWorkflow ? (
            <div className="uc-chat-page__workflow-status" role="status">
              <div className="uc-chat-page__workflow-copy">
                <span>
                  {webResearchSession?.status === 'authorization_required'
                    ? `联网检索授权：${webResearchSession.authorization?.querySummary ?? '当前查询'}（允许域名：${webResearchSession.authorization?.allowedDomains.join('、') ?? '未配置'}）`
                    : activeWorkflow.status === 'needs_clarification'
                    ? workflowQuestion(activeWorkflow)
                    : activeWorkflow.status === 'needs_confirmation'
                      ? '这项任务需要确认后才能执行。'
                      : activeWorkflow.status === 'executing'
                        ? '正在按顺序完成文档，已交付的作品会保留。'
                        : activeWorkflow.status === 'failed'
                          ? '任务尚未全部完成，已交付的作品已保留。'
                          : '这项任务已准备好。'}
                </span>
                {activeWorkflow.deliveries && activeWorkflow.deliveries.length > 1 ? (
                  <div className="uc-chat-page__workflow-details" role="note">
                    {activeWorkflow.deliveries.map((delivery) => (
                      <span key={delivery.kind}>
                        {documentKindLabel(delivery.kind)}：{delivery.status === 'completed' ? '已交付'
                          : delivery.status === 'executing' ? '进行中'
                            : delivery.status === 'cancelled' ? '已取消'
                              : delivery.status === 'failed'
                                ? delivery.failureReason === 'execution_failed' ? '失败，可重试此项' : '结果待核对，请勿重复发送'
                                : '待执行'}
                      </span>
                    ))}
                  </div>
                ) : null}
                {activeWorkflow.status === 'needs_confirmation' ? (
                  <div className="uc-chat-page__workflow-details" role="note">
                    {workflowConfirmationDetails(activeWorkflow, selected).map((detail) => (
                      <span key={detail}>{detail}</span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="uc-chat-page__workflow-actions">
                {webResearchSession?.status === 'authorization_required' ? (
                  <Button
                    disabled={busy || responseInProgress}
                    onClick={() => void authorizeWebResearch()}
                  >
                    允许联网检索
                  </Button>
                ) : null}
                {activeWorkflow.status === 'needs_confirmation' ? (
                  <Button
                    disabled={busy || responseInProgress}
                    onClick={() => void confirmActiveWorkflow()}
                  >
                    确认并继续
                  </Button>
                ) : null}
                {activeWorkflow.status === 'ready' ? (
                  <Button
                    disabled={busy || responseInProgress || !selectedCandidate?.available}
                    onClick={() => void continueActiveWorkflow()}
                  >
                    继续执行
                  </Button>
                ) : null}
                {activeWorkflow.status === 'failed' && activeWorkflow.deliveries?.some(
                  (delivery) => delivery.status === 'failed' && delivery.failureReason === 'execution_failed'
                ) ? (
                  <Button disabled={busy || responseInProgress} onClick={() => void resumeFailedOfficeWorkflow()}>
                    重试失败文档
                  </Button>
                ) : null}
                <Button
                  disabled={busy || responseInProgress}
                  onClick={() => void cancelActiveWorkflow()}
                  variant="ghost"
                >
                  取消任务
                </Button>
              </div>
            </div>
          ) : null}
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
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!responseInProgress && !cancelRequested && !busy) {
                    void sendMessage();
                  }
                }
              }}
              placeholder={
                !session
                  ? '请先打开项目'
                  : documentMode
                    ? '输入需求，生成 Office 文档（可拖入图片/文档/EPUB 电子书）'
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
                    <span title={[attachment.fileName, ...attachment.warnings].join('；')}>
                      {attachment.fileName}{attachment.status !== 'extracted' ? '（正文未读取）' : ''}
                    </span>
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
                {documentMode && composerDocumentKind === 'ppt' ? (
                  <div className="uc-chat-page__presentation-template">
                    <SelectPicker
                      aria-label="PPT 模板"
                      cleanable={false}
                      data={presentationTemplateOptions}
                      disabled={!canCompose || !session || busy}
                      onChange={(value) => {
                        const option = presentationTemplateOptions.find(
                          (item) => item.value === value
                        );
                        if (option) setPresentationTemplate(option.value);
                      }}
                      placement="topStart"
                      popupClassName="uc-chat-page__presentation-template-popup"
                      preventOverflow
                      size="xs"
                      value={presentationTemplate}
                    />
                  </div>
                ) : null}
                {documentMode && composerDocumentKind !== 'ppt' ? (
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
                {documentMode && aiImagesEnabled && imageCandidateOptions.length > 0 ? (
                  <details className="uc-chat-page__image-model">
                    <summary>
                      {imageCandidateOptions.find(
                        (option) => option.candidateId === selectedImageCandidateId
                      )?.label ?? '配图模型'}
                    </summary>
                    <div
                      className="uc-chat-page__image-model-menu"
                      role="radiogroup"
                    >
                      {imageCandidateOptions.map((option) => (
                        <button
                          aria-checked={selectedImageCandidateId === option.candidateId}
                          disabled={!canCompose || !session || busy}
                          key={option.candidateId}
                          onClick={() =>
                            setSelectedImageCandidateId(option.candidateId)
                          }
                          role="radio"
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
                {documentMode ? (
                  <button
                    aria-pressed={ragEnabled}
                    className={`uc-chat-page__doc-mode${ragEnabled ? ' is-active' : ''}`}
                    disabled={!canCompose || !session || busy}
                    onClick={() => setRagEnabled((enabled) => !enabled)}
                    title="从项目附件中检索相关内容，作为文档生成依据（本地检索）"
                    type="button"
                  >
                    检索资料
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
                  aria-label={planningActive
                    ? planningCancelRequested ? '正在停止需求理解' : '停止需求理解'
                    : documentGenerationActive || (documentResponseActive && !responseInProgress)
                    ? documentCancelRequested ? '正在停止文档生成' : '停止文档生成'
                    : responseInProgress
                      ? cancelRequested ? '正在停止生成' : '停止生成'
                      : '发送消息'}
                  className={`uc-chat-page__submit${planningActive || responseInProgress || documentGenerationActive || documentResponseActive ? ' uc-chat-page__submit--stop' : ''}`}
                  disabled={planningActive
                    ? planningCancelRequested
                    : documentGenerationActive || (documentResponseActive && !responseInProgress)
                    ? documentCancelRequested
                    : responseInProgress
                      ? cancelRequested
                      : !chat ||
                        !canCompose ||
                        !input.trim() ||
                        busy ||
                        cancelRequested}
                  onClick={() =>
                    planningActive
                      ? void cancelWorkflowPlanning()
                      : documentGenerationActive || documentResponseActive
                      ? void cancelDocumentGeneration()
                      : responseInProgress
                        ? void cancelResponse()
                        : void sendMessage()
                  }
                  title={planningActive
                    ? planningCancelRequested ? '正在停止需求理解' : '停止需求理解'
                    : documentGenerationActive || (documentResponseActive && !responseInProgress)
                    ? documentCancelRequested ? '正在停止文档生成' : '停止文档生成'
                    : responseInProgress
                      ? cancelRequested ? '正在停止' : '停止生成'
                      : '发送'}
                  type="button"
                >
                  {planningActive || responseInProgress || documentGenerationActive || documentResponseActive
                    ? <LuSquare aria-hidden="true" />
                    : <LuArrowUp aria-hidden="true" />}
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
          <span>图片/文档/EPUB 电子书将作为依据，用于生成 Office 文档</span>
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
