import { useEffect, useMemo, useState } from 'react';
import {
  LuActivity,
  LuChevronDown,
  LuChevronUp,
  LuHardDrive
} from 'react-icons/lu';
import { Button } from '../../components/Button';
import type { SettingsSystemStatusDto } from '../../shared/settings-ipc';
import type { StorageTaskSummaryDto } from '../../shared/storage-ipc';

const activeExecutionStates = new Set([
  'submitting',
  'queued',
  'processing',
  'validating_sources',
  'preparing_media',
  'encoding',
  'remote_completed',
  'downloading',
  'writing',
  'verifying',
  'writing_file',
  'verifying_file',
  'registering_work',
  'cancel_requested'
]);

const attentionExecutionStates = new Set([
  'submission_outcome_unknown',
  'cancellation_unknown',
  'needs_user_action',
  'interrupted',
  'recovery_required',
  'failed',
  'expired'
]);

interface GlobalStatusMonitorProps {
  readonly onOpenTasks: () => void;
}

export function GlobalStatusMonitor({ onOpenTasks }: GlobalStatusMonitorProps) {
  const storageApi = window.unicomp?.storage;
  const settingsApi = window.unicomp?.settings;
  const [tasks, setTasks] = useState<readonly StorageTaskSummaryDto[]>();
  const [tasksUnavailable, setTasksUnavailable] = useState(false);
  const [storage, setStorage] = useState<SettingsSystemStatusDto['storage']>();
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!storageApi) {
        if (active) setTasksUnavailable(true);
        return;
      }
      try {
        const result = await storageApi.listTasks();
        if (!active) return;
        if (result.ok) {
          setTasks(result.value.items);
          setTasksUnavailable(false);
        } else {
          setTasksUnavailable(true);
        }
      } catch {
        if (active) setTasksUnavailable(true);
      }
    };
    const handleFocus = () => void refresh();
    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener('focus', handleFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [storageApi]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!settingsApi) {
        if (active) setStorageUnavailable(true);
        return;
      }
      try {
        const result = await settingsApi.getSystemStatus();
        if (!active) return;
        if (result.ok) {
          setStorage(result.value.storage);
          setStorageUnavailable(false);
        } else {
          setStorageUnavailable(true);
        }
      } catch {
        if (active) setStorageUnavailable(true);
      }
    };
    const handleFocus = () => void refresh();
    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', handleFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [settingsApi]);

  const summary = useMemo(() => summarizeTasks(tasks ?? []), [tasks]);
  const availableBytes = storage?.directories
    .filter((directory) => directory.state === 'available' && directory.freeBytes !== null)
    .reduce<number | null>((maximum, directory) =>
      maximum === null ? directory.freeBytes : Math.max(maximum, directory.freeBytes ?? 0), null);

  return (
    <section className="global-status-monitor" aria-label="全局状态监控">
      <div className="global-status-monitor__storage">
        <div className="global-status-monitor__heading">
          <LuHardDrive aria-hidden="true" />
          <strong>本地存储</strong>
        </div>
        {storage ? (
          <dl>
            <div>
              <dt>应用文件</dt>
              <dd>{formatBytes(storage.appUsage.totalBytes)}</dd>
            </div>
            <div>
              <dt>可用空间</dt>
              <dd>{availableBytes == null ? '尚未统计' : formatBytes(availableBytes)}</dd>
            </div>
          </dl>
        ) : (
          <p>{storageUnavailable ? '存储状态不可用' : '正在读取存储状态…'}</p>
        )}
      </div>

      <div className="global-status-monitor__tasks">
        <button
          aria-controls="global-task-activity-details"
          aria-expanded={expanded}
          className="global-status-monitor__toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span>
            <LuActivity aria-hidden="true" />
            <strong>最近任务活动</strong>
          </span>
          {expanded ? <LuChevronDown aria-hidden="true" /> : <LuChevronUp aria-hidden="true" />}
        </button>

        {expanded ? (
          <div className="global-status-monitor__task-details" id="global-task-activity-details">
            {tasks ? (
              <>
                <dl className="global-status-monitor__counts">
                  <TaskCount label="运行中" tone="active" value={summary.active} />
                  <TaskCount label="需处理" tone="attention" value={summary.attention} />
                  <TaskCount label="等待处理" tone="waiting" value={summary.waiting} />
                  <TaskCount label="已完成" tone="completed" value={summary.completed} />
                </dl>
                <div className="global-status-monitor__recent">
                  <span>最近变化</span>
                  {summary.recent ? (
                    <>
                      <strong title={summary.recent.projectName}>{summary.recent.projectName}</strong>
                      <small>{executionStateLabel(summary.recent.latestExecutionState)}</small>
                    </>
                  ) : (
                    <small>暂无本地任务</small>
                  )}
                </div>
              </>
            ) : (
              <p>{tasksUnavailable ? '任务状态不可用' : '正在读取任务状态…'}</p>
            )}
            <Button onClick={onOpenTasks} variant="secondary">打开任务中心</Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TaskCount({ label, tone, value }: {
  readonly label: string;
  readonly tone: 'active' | 'attention' | 'waiting' | 'completed';
  readonly value: number;
}) {
  return (
    <div>
      <dt><span className={`global-status-monitor__dot global-status-monitor__dot--${tone}`} />{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function summarizeTasks(tasks: readonly StorageTaskSummaryDto[]) {
  const knownStates = new Set([...activeExecutionStates, ...attentionExecutionStates, 'created', 'completed', 'cancelled']);
  const recent = [...tasks].sort((left, right) =>
    taskUpdatedAt(right).localeCompare(taskUpdatedAt(left))
  )[0];
  return {
    active: tasks.filter((task) => activeExecutionStates.has(task.latestExecutionState ?? '')).length,
    attention: tasks.filter((task) =>
      attentionExecutionStates.has(task.latestExecutionState ?? '') ||
      Boolean(task.latestExecutionState && !knownStates.has(task.latestExecutionState))
    ).length,
    waiting: tasks.filter((task) => !task.latestExecutionState || task.latestExecutionState === 'created').length,
    completed: tasks.filter((task) => ['completed', 'cancelled'].includes(task.latestExecutionState ?? '')).length,
    recent
  };
}

function taskUpdatedAt(task: StorageTaskSummaryDto): string {
  return task.latestExecutionUpdatedAt ?? task.createdAt;
}

function executionStateLabel(state?: string): string {
  if (!state || state === 'created') return '等待处理';
  if (state === 'submitting') return '正在提交';
  if (state === 'queued') return '排队中';
  if (state === 'processing') return '生成中';
  if (['remote_completed', 'downloading', 'writing', 'verifying', 'writing_file', 'verifying_file', 'registering_work'].includes(state)) {
    return '结果处理中';
  }
  if (['validating_sources', 'preparing_media', 'encoding'].includes(state)) return '本地处理中';
  if (state === 'completed') return '已完成';
  if (state === 'cancelled') return '已取消';
  if (state === 'cancel_requested') return '取消处理中';
  if (attentionExecutionStates.has(state)) return '需要处理';
  return '状态待确认';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  }).format(value)} ${units[unit]}`;
}
