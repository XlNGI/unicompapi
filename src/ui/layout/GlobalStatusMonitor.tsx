import { useEffect, useMemo, useState } from 'react';
import {
  LuActivity,
  LuChevronDown,
  LuChevronUp,
  LuHardDrive
} from 'react-icons/lu';
import type {
  StorageLocalStorageSummaryDto
} from '../../shared/storage-ipc';
import { PROJECT_SESSION_CHANGED_EVENT } from '../project-session-events';
import { useTaskReadStore } from '../task-read-store';
import { summarizeTasks } from './TaskStatusDock';

export function GlobalStatusMonitor() {
  const storageApi = window.unicomp?.storage;
  const taskRead = useTaskReadStore();
  const [storage, setStorage] = useState<StorageLocalStorageSummaryDto>();
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!storageApi) {
        if (active) setStorageUnavailable(true);
        return;
      }
      try {
        const result = await storageApi.getLocalStorageSummary();
        if (!active) return;
        if (result.ok) {
          setStorage(result.value);
          setStorageUnavailable(false);
        } else {
          setStorageUnavailable(true);
        }
      } catch {
        if (active) setStorageUnavailable(true);
      }
    };
    const handleFocus = () => void refresh();
    const handleProjectChange = () => void refresh();
    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    const unsubscribe = storageApi?.onLocalStorageChanged(handleProjectChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener(PROJECT_SESSION_CHANGED_EVENT, handleProjectChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe?.();
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(PROJECT_SESSION_CHANGED_EVENT, handleProjectChange);
    };
  }, [storageApi]);

  const summary = useMemo(
    () => summarizeTasks(taskRead.tasks, Date.now()),
    [taskRead.tasks]
  );
  const projectUsageWarning = storage ? [
    storage.projectUsage.unavailableProjectCount > 0
      ? `${storage.projectUsage.unavailableProjectCount} 个项目未统计`
      : '',
    storage.projectUsage.truncated ? '项目文件过多，仅显示已统计部分' : ''
  ].filter(Boolean).join('；') : '';
  const storageStatus = storage
    ? [
        projectUsageWarning,
        storage.currentProject?.diskFreeBytes == null && storage.currentProject
          ? '磁盘可用空间暂不可用'
          : ''
      ].filter(Boolean).join('；') || (storage.currentProject ? '监控正常' : '尚未打开项目')
    : storageUnavailable
      ? '存储状态不可用'
      : '正在读取存储状态…';
  const storageStatusTone = storage
    ? projectUsageWarning || (storage.currentProject && storage.currentProject.diskFreeBytes == null)
      ? 'warning'
      : storage.currentProject
        ? 'success'
        : 'neutral'
    : storageUnavailable
      ? 'danger'
      : 'neutral';

  return (
    <section className="global-status-monitor" aria-label="全局状态监控">
      <div className="global-status-monitor__storage">
        <div className="global-status-monitor__heading">
          <LuHardDrive aria-hidden="true" />
          <strong>本地存储</strong>
        </div>
        <dl>
          <div>
            <dt title={storage
              ? `已登记 ${storage.projectUsage.projectCount} 个项目，包含项目内作品`
              : undefined}
            >
              全部项目占用
            </dt>
            <dd>{storage ? formatBytes(storage.projectUsage.totalBytes) : '—'}</dd>
          </div>
          <div>
            <dt title={storage?.currentProject?.projectName}>当前磁盘可用</dt>
            <dd>{storage?.currentProject?.diskFreeBytes == null
              ? '—'
              : formatBytes(storage.currentProject.diskFreeBytes)}</dd>
          </div>
        </dl>
        <div className="global-status-monitor__storage-project">
          <span>当前项目</span>
          <strong title={storage?.currentProject?.projectName}>
            {storage?.currentProject?.projectName ?? '—'}
          </strong>
          <small
            className={`global-status-monitor__storage-state global-status-monitor__storage-state--${storageStatusTone}`}
            role="status"
            title={storageStatus}
          >
            <span aria-hidden="true" />
            {storageStatus}
          </small>
        </div>
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
          <div
            aria-label={!taskRead.loading
              ? '任务状态统计'
              : taskRead.error
                ? '任务状态暂不可用'
                : '正在读取任务状态'}
            className="global-status-monitor__task-details"
            id="global-task-activity-details"
          >
            <dl
              aria-atomic="true"
              aria-live="polite"
              className="global-status-monitor__counts"
            >
              <TaskCount
                label="运行中"
                tone="active"
                value={!taskRead.loading ? summary.generating + summary.receiving : '—'}
              />
              <TaskCount label="需处理" tone="attention" value={!taskRead.loading ? summary.attention : '—'} />
              <TaskCount label="等待处理" tone="waiting" value={!taskRead.loading ? summary.waiting : '—'} />
              <TaskCount label="已完成" tone="completed" value={!taskRead.loading ? summary.completed : '—'} />
            </dl>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TaskCount({ label, tone, value }: {
  readonly label: string;
  readonly tone: 'active' | 'attention' | 'waiting' | 'completed';
  readonly value: number | string;
}) {
  return (
    <div>
      <dt><span className={`global-status-monitor__dot global-status-monitor__dot--${tone}`} />{label}</dt>
      <dd>{value}</dd>
    </div>
  );
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
