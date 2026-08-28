import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuCircleAlert,
  LuCircleCheck,
  LuClock3,
  LuDownload,
  LuImage,
  LuListTodo,
  LuLoaderCircle,
  LuVideo
} from 'react-icons/lu';
import { StatusPill, type StatusTone } from '../../components/StatusPill';
import type { StorageTaskSummaryDto } from '../../shared/storage-ipc';
import type { NavigationItemId } from '../navigation/navigationItems';
import type { ProjectStatusSnapshot } from '../status/ProjectStatusContext';
import { useTaskReadStore } from '../task-read-store';

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
  const { tasks } = useTaskReadStore();
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const collapseOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !dockRef.current?.contains(target)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', collapseOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', collapseOnOutsidePointer);
  }, [expanded]);

  const summary = useMemo(() => summarizeTasks(tasks, now), [now, tasks]);
  const showsTasks = summary.inProgress > 0 || summary.attention > 0 || summary.visibleTasks.length > 0;
  const taskPanelId = 'uc-global-task-status-panel';

  return (
    <div className="uc-project-status-dock" ref={dockRef}>
      {showsTasks && expanded ? (
        <section aria-label="生产任务" className="uc-task-status-panel" id={taskPanelId}>
          <header className="uc-task-status-panel__header">
            <div>
              <strong>生产任务</strong>
              <StatusPill tone="info">{summary.visibleTasks.length} 个任务</StatusPill>
              <span>任务会在后台继续运行，切换页面不会中断</span>
            </div>
            <button onClick={() => onNavigate('tasks')} type="button">全部任务</button>
          </header>
          <div className="uc-task-status-panel__list">
            {summary.visibleTasks.map((task) => (
              <TaskStatusRow key={task.taskId} now={now} onNavigate={onNavigate} task={task} />
            ))}
          </div>
        </section>
      ) : null}

      {showsTasks ? (
        <aside className="uc-project-status-bar uc-project-status-bar--tasks" role="status">
          {summary.inProgress > 0
            ? <LuLoaderCircle aria-hidden="true" className="uc-task-status-spinner" />
            : <LuCircleAlert aria-hidden="true" />}
          <div className="uc-task-status-summary" aria-live="polite">
            {summary.inProgress > 0
              ? <strong>正在处理 {summary.inProgress} 个任务</strong>
              : <strong>当前没有运行中的任务</strong>}
            {summary.attention > 0 ? (
              <span className="uc-task-status-summary__attention">
                · {summary.attention} 个需要处理
              </span>
            ) : null}
          </div>
          {summary.inProgress > 0 ? (
            <span aria-hidden="true" className="uc-task-status-progress"><span /></span>
          ) : null}
          <button className="uc-task-status-link" onClick={() => onNavigate('tasks')} type="button">
            任务中心
          </button>
          <button
            aria-controls={taskPanelId}
            aria-expanded={expanded}
            className="uc-task-status-toggle"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded ? '收起' : '展开'}
            <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
          </button>
        </aside>
      ) : (
        <aside className="uc-project-status-bar" role={fallbackStatus.role}>
          <StatusPill tone={fallbackStatus.tone}>{fallbackStatus.label}</StatusPill>
          <div className="uc-project-status-bar__content">{fallbackStatus.content}</div>
        </aside>
      )}
    </div>
  );
}

function TaskStatusRow({ task, now, onNavigate }: {
  readonly task: StorageTaskSummaryDto;
  readonly now: number;
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
        <strong>{taskKindLabels[task.kind] ?? '其他任务'} · {task.projectName}</strong>
        <small>{presentation.description}</small>
      </div>
      <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>
      <span className="uc-task-status-row__time">
        {group === 'generating' ? `已用时 ${formatElapsed(task.createdAt, now)}` : formatUpdatedAt(task)}
      </span>
      {group === 'generating' || group === 'receiving' ? (
        <span aria-hidden="true" className="uc-task-status-row__progress"><span /></span>
      ) : null}
      <div className="uc-task-status-row__actions">
        {group === 'completed' ? (
          <button onClick={() => onNavigate('library')} type="button">查看作品</button>
        ) : group === 'attention' || group === 'failed' ? (
          <button onClick={() => onNavigate('tasks')} type="button">去处理</button>
        ) : null}
        <button onClick={() => onNavigate('tasks')} type="button">查看详情</button>
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
    description: '正在下载、校验并保存生成结果', icon: LuDownload, label: '接收并校验', tone: 'warning'
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

function formatElapsed(createdAt: string, now: number): string {
  const timestamp = Date.parse(createdAt);
  const seconds = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 1_000)) : 0;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function formatUpdatedAt(task: StorageTaskSummaryDto): string {
  const parsed = Date.parse(task.latestExecutionUpdatedAt ?? task.createdAt);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(parsed)
    : '时间未知';
}
