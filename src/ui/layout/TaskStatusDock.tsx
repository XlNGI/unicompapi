import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, Whisper } from 'rsuite';
import {
  LuArrowUpRight,
  LuChevronDown,
  LuChevronUp,
  LuCircleAlert,
  LuCircleCheck,
  LuClock3,
  LuDownload,
  LuImage,
  LuListTodo,
  LuLoaderCircle,
  LuPanelBottom,
  LuRefreshCw,
  LuVideo
} from 'react-icons/lu';
import { StatusPill, type StatusTone } from '../../components/StatusPill';
import type { StorageTaskSummaryDto } from '../../shared/storage-ipc';
import type { NavigationItemId } from '../navigation/navigationItems';
import type { ProjectStatusSnapshot } from '../status/ProjectStatusContext';
import { refreshTaskReadStore, tasksForProject, useTaskReadStore } from '../task-read-store';

const visibleTerminalDurationMs = 10 * 60 * 1_000;
const visibleActiveDurationMs = 60 * 60 * 1_000;
const maximumVisibleTasks = 4;

const receivingStates = new Set([
  'remote_completed', 'downloading', 'writing', 'verifying',
  'writing_file', 'verifying_file', 'registering_work'
]);
const generatingStates = new Set([
  'submitting', 'processing', 'encoding', 'cancel_requested'
]);
const waitingStates = new Set([
  'created', 'queued', 'validating_sources', 'preparing_media'
]);
const attentionStates = new Set([
  'submission_outcome_unknown', 'cancellation_unknown', 'needs_user_action',
  'interrupted', 'recovery_required', 'expired'
]);

export type TaskDisplayGroup =
  | 'attention'
  | 'failed'
  | 'receiving'
  | 'generating'
  | 'waiting'
  | 'completed'
  | 'cancelled'
  | 'inactive';

interface TaskStatusDockProps {
  readonly fallbackStatus: ProjectStatusSnapshot;
  readonly onNavigate: (itemId: NavigationItemId) => void;
}

export interface TaskStatusSummary {
  readonly attention: number;
  readonly completed: number;
  readonly generating: number;
  readonly inProgress: number;
  readonly receiving: number;
  readonly visibleTasks: readonly StorageTaskSummaryDto[];
  readonly waiting: number;
}

const taskKindLabels: Readonly<Record<string, string>> = {
  image_generation: '图片生成',
  image_analysis: '图片识别',
  image_editing: '图片编辑',
  image_to_prompt: '图片转提示词',
  video_generation: '视频生成',
  video_editing: '视频编辑'
};

export function TaskStatusDock({ fallbackStatus, onNavigate }: TaskStatusDockProps) {
  const { currentProjectId, tasks, loading, error, issues } = useTaskReadStore();
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dockRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const refreshInFlight = useRef(false);
  const focusPanelOnOpen = useRef(false);

  async function refreshTasks() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await refreshTaskReadStore();
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }

  function closePanel() {
    setExpanded(false);
    toggleRef.current?.focus();
  }

  function navigateFromDock(itemId: NavigationItemId) {
    setExpanded(false);
    onNavigate(itemId);
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    if (focusPanelOnOpen.current) {
      refreshRef.current?.focus();
      focusPanelOnOpen.current = false;
    }
    const collapseOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !dockRef.current?.contains(target)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', collapseOnOutsidePointer);
    const collapseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closePanel();
    };
    document.addEventListener('keydown', collapseOnEscape);
    return () => {
      document.removeEventListener('pointerdown', collapseOnOutsidePointer);
      document.removeEventListener('keydown', collapseOnEscape);
    };
  }, [expanded]);

  const currentProjectTasks = useMemo(
    () => tasksForProject(tasks, currentProjectId),
    [currentProjectId, tasks]
  );
  const summary = useMemo(
    () => summarizeTasks(currentProjectTasks, now),
    [currentProjectTasks, now]
  );
  const incomplete = issues.some((issue) => issue.projectId === currentProjectId);
  const unavailable = error || loading || incomplete;
  const summaryText = error ? '任务状态读取失败'
    : loading ? '正在读取任务'
    : incomplete ? '任务数据不完整'
    : !currentProjectId ? '未打开项目'
    : summary.inProgress > 0 ? `处理中 ${summary.inProgress}`
    : summary.attention > 0 ? '近期任务'
    : summary.completed > 0 ? `近期完成 ${summary.completed}`
    : '无近期任务';
  const summaryTone = error || incomplete || summary.attention > 0 ? 'warning'
    : summary.inProgress > 0 || loading ? 'info'
    : summary.completed > 0 ? 'success' : 'neutral';
  const SummaryIcon = error || incomplete ? LuCircleAlert
    : loading || summary.inProgress > 0 ? LuLoaderCircle
    : summary.attention > 0 ? LuCircleAlert
    : summary.completed > 0 ? LuCircleCheck : LuListTodo;
  const panelMessage = error ? '无法确认最新任务状态，请刷新后重试。'
    : loading ? '正在读取任务状态。'
    : incomplete ? '当前项目的部分任务记录无法读取，已读取的内容可能不完整。'
    : !currentProjectId ? '尚未打开项目。'
    : summary.visibleTasks.length === 0 ? '当前项目暂无近期任务，完整历史可在任务中心查看。' : undefined;
  const taskPanelId = 'uc-global-task-status-panel';

  return (
    <div className="uc-project-status-dock" ref={dockRef}>
      {expanded ? (
        <section aria-label="近期任务" className="uc-task-status-panel" id={taskPanelId}>
          <header className="uc-task-status-panel__header">
            <div>
              <strong>近期任务</strong>
              {currentProjectId ? <span>当前项目</span> : null}
              {!loading && !error ? <span>显示 {summary.visibleTasks.length} 条</span> : null}
            </div>
            <div className="uc-task-status-panel__tools">
            <Whisper placement="topEnd" speaker={<Tooltip>刷新任务状态</Tooltip>} trigger={['hover', 'focus']}>
              <span className="uc-task-status-tooltip">
                <button aria-label="刷新任务状态" className="uc-task-status-toggle" aria-disabled={refreshing || loading} onClick={() => { if (!loading) void refreshTasks(); }} ref={refreshRef} type="button">
                  <LuRefreshCw aria-hidden="true" className={refreshing ? 'uc-task-status-spinner' : undefined} />
                </button>
              </span>
            </Whisper>
            <Whisper placement="topEnd" speaker={<Tooltip>收起任务面板</Tooltip>} trigger={['hover', 'focus']}>
              <button aria-label="收起任务面板" className="uc-task-status-toggle" onClick={closePanel} type="button">
                <LuChevronDown aria-hidden="true" />
              </button>
            </Whisper>
            </div>
          </header>
          <div className="uc-task-status-panel__list">
            {panelMessage ? <p className="uc-task-status-panel__message" role="status">{panelMessage}</p> : null}
            {!loading && !error && summary.visibleTasks.map((task) => (
              <TaskStatusRow key={task.taskId} onNavigate={navigateFromDock} task={task} />
            ))}
          </div>
        </section>
      ) : null}

      <aside className="uc-project-status-bar" aria-label="项目与任务状态">
        <div className={`uc-project-status-bar__scene uc-project-status-bar__scene--${fallbackStatus.tone}`} role={fallbackStatus.role}>
          <LuPanelBottom aria-hidden="true" />
          <div className="uc-project-status-bar__content">{fallbackStatus.content}</div>
        </div>
          <div className={`uc-task-status-summary uc-task-status-summary--${summaryTone}`} role="status" aria-atomic="true">
            <SummaryIcon aria-hidden="true" className={!error && !incomplete && (loading || summary.inProgress > 0) ? 'uc-task-status-spinner' : undefined} />
            <span>{summaryText}</span>
            {!unavailable && summary.attention > 0 ? (
              <span className="uc-task-status-summary__attention">
                需处理 {summary.attention}
              </span>
            ) : null}
          </div>
          <button className="uc-task-status-link" onClick={() => navigateFromDock('tasks')} type="button">
            <LuListTodo aria-hidden="true" />任务中心
          </button>
          <Whisper placement="topEnd" speaker={<Tooltip>{expanded ? '收起任务面板' : '展开任务面板'}</Tooltip>} trigger={['hover', 'focus']}>
          <span className="uc-task-status-tooltip">
          <button
            aria-controls={expanded ? taskPanelId : undefined}
            aria-expanded={expanded}
            className="uc-task-status-toggle"
            aria-label={expanded ? '收起任务面板' : '展开任务面板'}
            onClick={(event) => {
              focusPanelOnOpen.current = !expanded && event.detail === 0;
              setExpanded((value) => !value);
            }}
            ref={toggleRef}
            type="button"
          >
            {expanded ? <LuChevronDown aria-hidden="true" /> : <LuChevronUp aria-hidden="true" />}
          </button>
          </span>
          </Whisper>
      </aside>
    </div>
  );
}

function TaskStatusRow({ task, onNavigate }: {
  readonly task: StorageTaskSummaryDto;
  readonly onNavigate: (itemId: NavigationItemId) => void;
}) {
  const group = taskDisplayGroup(task.latestExecutionState);
  const presentation = taskPresentation(group, task.latestExecutionState);
  const Icon = task.kind.startsWith('video_')
    ? LuVideo
    : task.kind.startsWith('image_')
      ? LuImage
      : presentation.icon;

  return (
    <article className={`uc-task-status-row uc-task-status-row--${group}`}>
      <span className="uc-task-status-row__icon" aria-hidden="true"><Icon /></span>
      <div className="uc-task-status-row__identity">
        <div className="uc-task-status-row__heading">
          <strong>{taskKindLabels[task.kind] ?? '其他任务'}</strong>
          <StatusPill tone={presentation.tone}><presentation.icon aria-hidden="true" />{presentation.label}</StatusPill>
        </div>
        <div className="uc-task-status-row__metadata">
          <span>{presentation.description}</span>
          <span className="uc-task-status-row__time">{task.latestExecutionUpdatedAt ? '更新于' : '创建于'} {formatUpdatedAt(task)}</span>
        </div>
      </div>
      <div className="uc-task-status-row__actions">
        {group === 'completed' ? (
          <button onClick={() => onNavigate('library')} type="button">打开作品库<LuArrowUpRight aria-hidden="true" /></button>
        ) : (
          <button onClick={() => onNavigate('tasks')} type="button">打开任务中心<LuArrowUpRight aria-hidden="true" /></button>
        )}
      </div>
    </article>
  );
}

export function summarizeTasks(
  tasks: readonly StorageTaskSummaryDto[],
  now: number
): TaskStatusSummary {
  const currentTasks = tasks.filter((task) => {
    const group = taskDisplayGroup(task.latestExecutionState);
    if (group === 'cancelled' || group === 'inactive') return false;
    const updatedAt = Date.parse(task.latestExecutionUpdatedAt ?? task.createdAt);
    const visibleDuration = isTransientTerminalTask(task)
      ? visibleTerminalDurationMs
      : visibleActiveDurationMs;
    return Number.isFinite(updatedAt) && now - updatedAt <= visibleDuration;
  });
  const sorted = [...currentTasks].sort((left, right) => {
    const priorityDifference = taskPriority(left) - taskPriority(right);
    return priorityDifference !== 0
      ? priorityDifference
      : taskUpdatedAt(right) - taskUpdatedAt(left);
  });
  const countGroup = (group: TaskDisplayGroup) => currentTasks.filter(
    (task) => taskDisplayGroup(task.latestExecutionState) === group
  ).length;
  const receiving = countGroup('receiving');
  const generating = countGroup('generating');
  const waiting = countGroup('waiting');
  return {
    attention: countGroup('attention') + countGroup('failed'),
    completed: countGroup('completed'),
    generating,
    inProgress: receiving + generating + waiting,
    receiving,
    visibleTasks: sorted.slice(0, maximumVisibleTasks),
    waiting
  };
}

function isTransientTerminalTask(task: StorageTaskSummaryDto): boolean {
  return task.latestExecutionState === 'completed' ||
    task.latestExecutionState === 'failed' ||
    task.latestExecutionState === 'expired';
}

export function taskDisplayGroup(state = ''): TaskDisplayGroup {
  if (!state) return 'inactive';
  if (attentionStates.has(state)) return 'attention';
  if (state === 'failed') return 'failed';
  if (receivingStates.has(state)) return 'receiving';
  if (generatingStates.has(state)) return 'generating';
  if (waitingStates.has(state)) return 'waiting';
  if (state === 'completed') return 'completed';
  if (state === 'cancelled') return 'cancelled';
  return 'attention';
}

export function taskPriority(task: StorageTaskSummaryDto): number {
  return ({
    attention: 0,
    failed: 1,
    receiving: 2,
    generating: 3,
    waiting: 4,
    completed: 5,
    cancelled: 6,
    inactive: 7
  } as const)[taskDisplayGroup(task.latestExecutionState)];
}

function taskPresentation(group: TaskDisplayGroup, state = ''): {
  readonly description: string;
  readonly icon: typeof LuListTodo;
  readonly label: string;
  readonly tone: StatusTone;
} {
  if (group === 'attention') return {
    description: attentionDescription(state), icon: LuCircleAlert, label: '需要处理', tone: 'warning'
  };
  if (group === 'failed') return {
    description: '任务执行失败，请查看详情后处理', icon: LuCircleAlert, label: '失败', tone: 'danger'
  };
  if (group === 'receiving') return {
    description: '正在下载、校验并保存生成结果', icon: LuDownload, label: '接收并校验', tone: 'info'
  };
  if (group === 'generating') return {
    description: state === 'submitting' ? '正在提交生成请求' : '服务正在生成内容',
    icon: LuLoaderCircle,
    label: '生成中',
    tone: 'info'
  };
  if (group === 'waiting') return {
    description: state === 'validating_sources' ? '正在校验本地素材' : '等待开始处理',
    icon: LuClock3,
    label: '等待处理',
    tone: 'neutral'
  };
  if (group === 'completed') return {
    description: '已下载、校验并保存到本地作品库', icon: LuCircleCheck, label: '已完成', tone: 'success'
  };
  return { description: '任务已取消', icon: LuListTodo, label: '已取消', tone: 'neutral' };
}

function attentionDescription(state: string): string {
  return ({
    submission_outcome_unknown: '提交结果未知，需要确认服务端状态',
    cancellation_unknown: '取消结果未知，需要确认服务端状态',
    needs_user_action: '任务需要用户处理后才能继续',
    interrupted: '任务已中断，需要检查后恢复',
    recovery_required: '本地恢复未完成，需要继续处理',
    expired: '远端结果已过期，无法继续接收'
  } as Record<string, string>)[state] ?? '任务状态异常，需要查看详情';
}

function taskUpdatedAt(task: StorageTaskSummaryDto): number {
  const timestamp = Date.parse(task.latestExecutionUpdatedAt ?? task.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatUpdatedAt(task: StorageTaskSummaryDto): string {
  const parsed = Date.parse(task.latestExecutionUpdatedAt ?? task.createdAt);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(parsed)
    : '时间未知';
}
