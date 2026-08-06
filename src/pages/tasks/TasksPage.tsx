import { useEffect, useState } from 'react';
import { Input, SelectPicker } from 'rsuite';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type { StatusTone } from '../../components/StatusPill';
import type {
  StorageReadModelIssueDto,
  StorageTaskDetailsDto,
  StorageTaskSummaryDto
} from '../../shared/storage-ipc';
import '../../styles/pages.css';
import { CallRecordsView } from './CallRecordsView';

interface TasksPageProps {
  onNavigate?: (itemId: 'projects' | 'library') => void;
}

const taskStates: Record<string, { label: string; tone: StatusTone }> = {
  created: { label: '已创建', tone: 'neutral' },
  submitting: { label: '正在提交', tone: 'info' },
  queued: { label: '排队中', tone: 'info' },
  processing: { label: '处理中', tone: 'info' },
  validating_sources: { label: '正在校验素材', tone: 'info' },
  preparing_media: { label: '正在准备媒体', tone: 'info' },
  encoding: { label: '正在编码', tone: 'info' },
  writing_file: { label: '正在写入文件', tone: 'info' },
  verifying_file: { label: '正在校验文件', tone: 'info' },
  registering_work: { label: '正在登记作品', tone: 'info' },
  remote_completed: { label: '远端完成', tone: 'info' },
  downloading: { label: '下载中', tone: 'info' },
  writing: { label: '本地保存中', tone: 'info' },
  verifying: { label: '校验中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  cancel_requested: { label: '正在请求取消', tone: 'warning' },
  cancelled: { label: '已取消', tone: 'neutral' },
  cancellation_unknown: { label: '取消状态未知', tone: 'warning' },
  needs_user_action: { label: '需要处理', tone: 'warning' },
  interrupted: { label: '执行已中断', tone: 'warning' },
  recovery_required: { label: '需要恢复', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  expired: { label: '已过期', tone: 'danger' }
};

const taskKinds: Record<string, string> = {
  image_generation: '图片生成',
  image_analysis: '图片识别',
  image_editing: '图片编辑',
  image_to_prompt: '图片转提示词',
  video_generation: '视频生成',
  video_editing: '视频编辑'
};

function taskState(state?: string) {
  return state ? (taskStates[state] ?? { label: state, tone: 'neutral' as const }) : {
    label: '等待执行',
    tone: 'neutral' as const
  };
}

export function TasksPage({ onNavigate }: TasksPageProps) {
  const [view, setView] = useState<'tasks' | 'calls'>('tasks');
  const [tasks, setTasks] = useState<readonly StorageTaskSummaryDto[]>([]);
  const [issues, setIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [details, setDetails] = useState<StorageTaskDetailsDto>();
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const storage = window.unicomp?.storage;

  useEffect(() => {
    let active = true;
    if (!storage) {
      setMessage('当前运行环境未连接桌面任务能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void storage.listTasks()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setTasks(result.value.items);
          setIssues(result.value.issues);
          setSelectedTaskId(result.value.items[0]?.taskId);
        } else setMessage(`读取任务失败：${result.error.message}`);
      })
      .catch(() => {
        if (active) setMessage('读取任务失败，请重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [storage]);

  useEffect(() => {
    let active = true;
    if (!storage || !selectedTaskId) {
      setDetails(undefined);
      return () => {
        active = false;
      };
    }

    setDetailsLoading(true);
    void storage.getTaskDetails(selectedTaskId)
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setDetails(result.value);
          if (!result.value) setMessage('任务已不存在或所属项目当前不可用');
        } else setMessage(`读取任务详情失败：${result.error.message}`);
      })
      .catch(() => {
        if (active) setMessage('读取任务详情失败，请重试');
      })
      .finally(() => {
        if (active) setDetailsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedTaskId, storage]);

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const filteredTasks = tasks.filter((task) =>
    (projectFilter === 'all' || task.projectId === projectFilter) &&
    (stateFilter === 'all' || task.latestExecutionState === stateFilter) &&
    (!normalizedQuery || [task.taskId, task.kind, task.projectName].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
    ))
  );
  const projects = Array.from(new Map(tasks.map((task) => [task.projectId, task.projectName])));

  return (
    <section className="uc-task-center" aria-labelledby="tasks-page-title">
      <header className="uc-task-center__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id="tasks-page-title">任务中心</h1>
            <StatusPill tone="info">全局视图</StatusPill>
          </div>
          <p className="uc-page-skeleton__description">
            {view === 'tasks'
              ? '查看所有本地项目中的真实任务状态、来源和提交内容。'
              : '查看每次服务商调用的状态、上游用量和本地结果事实。'}
          </p>
        </div>
        <StatusPill>{view === 'tasks' ? `${tasks.length} 个任务` : '只读调用事实'}</StatusPill>
      </header>

      <div aria-label="任务中心视图" className="uc-task-center__view-tabs" role="tablist">
        <button
          aria-controls="task-records-panel"
          aria-selected={view === 'tasks'}
          id="task-records-tab"
          onClick={() => setView('tasks')}
          role="tab"
          type="button"
        >
          任务
        </button>
        <button
          aria-controls="call-records-panel"
          aria-selected={view === 'calls'}
          id="call-records-tab"
          onClick={() => setView('calls')}
          role="tab"
          type="button"
        >
          调用记录
        </button>
      </div>

      {view === 'tasks' ? (
        <div
          aria-labelledby="task-records-tab"
          className="uc-task-center__tab-panel"
          id="task-records-panel"
          role="tabpanel"
        >
          <Card className="uc-task-center__filters">
        <label>
          搜索任务
          <Input
            onChange={(value) => setQuery(value)}
            placeholder="任务 ID、类型或项目名称"
            type="search"
            value={query}
          />
        </label>
        <div className="uc-rsuite-field">
          所属项目
          <SelectPicker
            aria-label="所属项目"
            cleanable={false}
            data={[
              { value: 'all', label: '全部项目' },
              ...projects.map(([projectId, projectName]) => ({ value: projectId, label: projectName }))
            ]}
            onChange={(value) => setProjectFilter(value ?? 'all')}
            searchable={false}
            value={projectFilter}
          />
        </div>
        <div className="uc-rsuite-field">
          任务状态
          <SelectPicker
            aria-label="任务状态"
            cleanable={false}
            data={[
              { value: 'all', label: '全部状态' },
              ...Object.entries(taskStates).map(([value, state]) => ({ value, label: state.label }))
            ]}
            onChange={(value) => setStateFilter(value ?? 'all')}
            searchable={false}
            value={stateFilter}
          />
        </div>
          </Card>

      {issues.length > 0 && (
        <Card className="uc-task-center__issues" role="status">
          <h2>部分项目无法读取</h2>
          {issues.map((issue) => (
            <p key={issue.projectId}>
              {issue.projectName}：{issue.reason === 'unavailable' ? '项目失效或断盘' : '任务数据损坏'}
            </p>
          ))}
        </Card>
      )}

      {loading ? (
        <EmptyState
          busy
          role="status"
          title="正在读取任务"
          description="正在汇总最近项目中的本地任务记录。"
          icon="载"
        />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="还没有任务"
          description="草稿不会出现在这里；只有最终确认后创建的真实任务才进入任务中心。"
          icon="任"
        />
      ) : (
        <div className="uc-task-center__workspace">
          <section className="uc-task-center__list" aria-labelledby="task-list-title">
            <h2 id="task-list-title">任务列表（{filteredTasks.length}）</h2>
            {filteredTasks.length === 0 ? (
              <p className="uc-task-center__muted">没有符合当前筛选条件的任务。</p>
            ) : (
              filteredTasks.map((task) => {
                const state = taskState(task.latestExecutionState);
                return (
                  <button
                    aria-pressed={selectedTaskId === task.taskId}
                    className="uc-task-center__task"
                    key={task.taskId}
                    onClick={() => setSelectedTaskId(task.taskId)}
                    type="button"
                  >
                    <span>
                      <strong>{taskKinds[task.kind] ?? task.kind}</strong>
                      <small>{task.projectName}</small>
                    </span>
                    <StatusPill tone={state.tone}>{state.label}</StatusPill>
                    <small>{new Date(task.createdAt).toLocaleString('zh-CN')}</small>
                    <small>{task.executionCount} 次执行</small>
                  </button>
                );
              })
            )}
          </section>

          <section className="uc-task-center__details" aria-labelledby="task-details-title">
            <h2 id="task-details-title">任务详情</h2>
            {detailsLoading ? (
              <p className="uc-task-center__muted" role="status">正在读取任务详情…</p>
            ) : details ? (
              <TaskDetails details={details} onNavigate={onNavigate} />
            ) : (
              <p className="uc-task-center__muted">选择左侧任务查看提交内容和真实状态。</p>
            )}
          </section>
        </div>
      )}

          <p className="uc-task-center__message" aria-live="polite">{message}</p>
        </div>
      ) : (
        <CallRecordsView onNavigate={onNavigate} />
      )}
    </section>
  );
}

function TaskDetails({
  details,
  onNavigate
}: {
  details: StorageTaskDetailsDto;
  onNavigate?: TasksPageProps['onNavigate'];
}) {
  const state = taskState(details.latestExecutionState);
  const retryability = details.retryability === 'retryable'
    ? '可重试'
    : details.retryability === 'not_retryable'
      ? '不可恢复'
      : '重试性未知';

  return (
    <div className="uc-task-center__details-content">
      <div className="uc-task-center__details-heading">
        <div>
          <strong>{taskKinds[details.kind] ?? details.kind}</strong>
          <small>{details.taskId}</small>
        </div>
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>
      <dl className="uc-task-center__facts">
        <div><dt>所属项目</dt><dd>{details.projectName}</dd></div>
        <div><dt>创建时间</dt><dd>{new Date(details.createdAt).toLocaleString('zh-CN')}</dd></div>
        <div><dt>执行次数</dt><dd>{details.executionCount}</dd></div>
        <div><dt>恢复能力</dt><dd>{retryability}</dd></div>
      </dl>
      <div className="uc-task-center__prompt">
        <h3>原始输入</h3>
        <p>{details.originalInput}</p>
      </div>
      <div className="uc-task-center__prompt">
        <h3>最终提示词</h3>
        <p>{details.finalPrompt}</p>
      </div>
      <div className="uc-task-center__actions">
        <Button onClick={() => onNavigate?.('projects')} variant="secondary">返回来源项目</Button>
        <Button onClick={() => onNavigate?.('library')} variant="secondary">查看已登记作品</Button>
      </div>
    </div>
  );
}
