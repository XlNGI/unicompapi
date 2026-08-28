import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Input, SelectPicker } from 'rsuite';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type { StatusTone } from '../../components/StatusPill';
import type {
  StorageCallDetailsDto,
  StorageConsumptionProviderSliceDto,
  StorageConsumptionSummaryDto,
  StorageReadModelIssueDto,
  StorageTaskDetailsDto
} from '../../shared/storage-ipc';
import type { TaskReuseTarget } from '../../shared/task-reuse';
import { refreshTaskReadStore, useTaskReadStore } from '../../ui/task-read-store';
import '../../styles/pages.css';
import {
  callState,
  displayRoute,
  featureLabels,
  formatTimestamp,
  type TaskCenterNavigate,
  usageLabels
} from './CallRecordsView';
import { TaskCenterWorkspace } from './TaskCenterWorkspace';
import {
  calculateSuccessfulCallFee,
  formatCallFee,
  formatCallFeeFormula
} from './call-fees';

interface TasksPageProps {
  onNavigate?: TaskCenterNavigate;
  onReuseParameters?: (target: TaskReuseTarget) => void;
}

const taskStates: Record<string, { label: string; tone: StatusTone }> = {
  created: { label: '已创建', tone: 'neutral' },
  submitting: { label: '正在提交', tone: 'info' },
  submission_outcome_unknown: { label: '提交结果未知', tone: 'warning' },
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
  return state ? (taskStates[state] ?? { label: '未知任务状态', tone: 'neutral' as const }) : {
    label: '等待执行',
    tone: 'neutral' as const
  };
}

export function TasksPage({ onNavigate, onReuseParameters }: TasksPageProps) {
  const { tasks, issues, loading, error } = useTaskReadStore();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [details, setDetails] = useState<StorageTaskDetailsDto>();
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [reusingParameters, setReusingParameters] = useState(false);
  const [message, setMessage] = useState('');
  const storage = window.unicomp?.storage;

  useEffect(() => {
    if (!selectedTaskId && tasks.length > 0) setSelectedTaskId(tasks[0]?.taskId);
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (error) setMessage('读取任务失败，请重试');
  }, [error]);

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
        } else setMessage('读取任务详情失败，请重试');
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

  async function recoverResult(taskId: string, mediaKind: 'image' | 'video') {
    const features = mediaKind === 'image'
      ? window.unicomp?.imageFeatures
      : window.unicomp?.videoFeatures;
    if (!features || recovering) return;
    setRecovering(true);
    setMessage(`正在重新接收已生成的${mediaKind === 'image' ? '图片' : '视频'}结果…`);
    try {
      const result = await features.recoverResult(taskId);
      if (!result.ok) {
        setMessage(`重新接收失败：${result.error.message}`);
        return;
      }
      setMessage(`${mediaKind === 'image' ? '图片' : '视频'}结果已下载、校验并登记到作品库。`);
      const [, taskDetails] = await Promise.all([
        refreshTaskReadStore(),
        storage?.getTaskDetails(taskId)
      ]);
      if (taskDetails?.ok) setDetails(taskDetails.value);
    } catch {
      setMessage('重新接收失败，请稍后重试。');
    } finally {
      setRecovering(false);
    }
  }

  async function reuseParameters(details: StorageTaskDetailsDto) {
    if (!storage || reusingParameters) return;
    setReusingParameters(true);
    setMessage('');
    try {
      const sessionResult = await storage.getProjectSession();
      if (!sessionResult.ok || !sessionResult.value) {
        setMessage('当前没有打开项目，无法复制参数。');
        return;
      }
      if (sessionResult.value.projectId !== details.projectId) {
        setMessage('不可跨项目复制参数：请先打开该任务所属项目。');
        return;
      }
      const imageResult = await window.unicomp?.imageWorkspaces?.list();
      if (imageResult?.ok) {
        const draft = imageResult.value.find(
          (item) => item.draftId === details.sourceDraftId
        );
        if (draft) {
          onReuseParameters?.({
            mediaKind: 'image',
            draftId: draft.draftId,
            mode: draft.mode
          });
          return;
        }
      }
      const videoResult = await window.unicomp?.videoWorkspaces?.list();
      if (videoResult?.ok) {
        const draft = videoResult.value.find(
          (item) => item.draftId === details.sourceDraftId
        );
        if (draft) {
          onReuseParameters?.({
            mediaKind: 'video',
            draftId: draft.draftId,
            mode: draft.mode
          });
          return;
        }
      }
      const editorResult = await window.unicomp?.videoEditors?.list();
      if (editorResult?.ok) {
        const draft = editorResult.value.find(
          (item) => item.draftId === details.sourceDraftId
        );
        if (draft) {
          onReuseParameters?.({
            mediaKind: 'video',
            draftId: draft.draftId,
            mode: 'video_editing'
          });
          return;
        }
      }
      setMessage('该任务对应的原草稿已不存在，无法复制参数。');
    } catch {
      setMessage('读取原草稿失败，无法复制参数。');
    } finally {
      setReusingParameters(false);
    }
  }

  return (
    <section className="uc-task-center" aria-labelledby="tasks-page-title">
      <header className="uc-task-center__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id="tasks-page-title">任务中心</h1>
            <StatusPill tone="info">全局视图</StatusPill>
          </div>
          <p className="uc-page-skeleton__description">
            查看所有本地项目中的真实任务状态、来源、提交内容和对应调用事实。
          </p>
        </div>
        <StatusPill>{tasks.length} 个任务</StatusPill>
      </header>

      <TaskConsumptionCharts />

      <Card className="uc-task-center__filters">
        <label>
          搜索任务
          <Input
            onChange={(value) => setQuery(value)}
            placeholder="任务编号、类型或项目名称"
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
        <TaskCenterWorkspace
          details={(
            <>
              <h2 id="task-details-title">任务时间线</h2>
              {detailsLoading ? (
                <p className="uc-task-center__muted" role="status">正在读取任务详情…</p>
              ) : details ? (
                <TaskDetails
                  details={details}
                  onNavigate={onNavigate}
                  onRecoverResult={() => void recoverResult(
                    details.taskId,
                    details.canRecoverImageResult ? 'image' : 'video'
                  )}
                  recovering={recovering}
                  reusingParameters={reusingParameters}
                  onReuseParameters={() => void reuseParameters(details)}
                />
              ) : (
                <p className="uc-task-center__muted">选择左侧任务查看提交内容、真实状态和调用记录。</p>
              )}
            </>
          )}
          detailsLabelledBy="task-details-title"
          list={(
            <>
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
                        <strong>{taskKinds[task.kind] ?? '其他任务'}</strong>
                        <small>{task.projectName}</small>
                      </span>
                      <StatusPill tone={state.tone}>{state.label}</StatusPill>
                      <small>{new Date(task.createdAt).toLocaleString('zh-CN')}</small>
                      <small>{task.executionCount} 次执行</small>
                    </button>
                  );
                })
              )}
            </>
          )}
          listLabelledBy="task-list-title"
        />
      )}

      <p className="uc-task-center__message" aria-live="polite">{message}</p>
    </section>
  );
}

interface ProviderConsumptionSlice {
  readonly key: string;
  readonly label: string;
  readonly amount: string;
  readonly ratio: number;
  readonly color: string;
}

function TaskConsumptionCharts() {
  const storage = window.unicomp?.storage;
  const [summary, setSummary] = useState<StorageConsumptionSummaryDto>();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => storage?.onLocalStorageChanged(() => {
    setRefreshRevision((current) => current + 1);
  }), [storage]);

  useEffect(() => {
    let active = true;
    setMessage('');
    setLoading(true);

    if (!storage) {
      setMessage('当前运行环境未连接桌面调用记录能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    const timer = window.setTimeout(() => {
      void storage.getConsumptionSummary()
        .then((result) => {
          if (!active) return;
          if (!result.ok) {
            setMessage('读取消费统计失败，请重试');
            return;
          }
          setSummary(result.value);
        })
        .catch(() => {
          if (active) setMessage('读取消费统计失败，请重试');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refreshRevision, storage]);

  const providerSlices = summary ? consumptionProviderSlices(summary.providerSlices) : [];
  const maximumBucketAmount = Math.max(
    ...(summary?.timeBuckets.map((bucket) => Number(bucket.amount)) ?? []),
    0
  );
  const hasRenminbiAmount = Number(summary?.totalAmount ?? '0') > 0;
  const chartSummary = summary
    ? `近 ${summary.period.calendarDays} 日 · 调用 ${summary.totalCallCount} 次 · 成功 ${summary.successfulCallCount} 次 · 人民币计入 ${summary.includedCallCount} 次`
    : '尚未读取消费摘要';

  return (
    <section className="uc-task-center__charts" aria-label="消费统计">
      <Card className="uc-task-center__chart-card">
        <div className="uc-task-center__chart-heading">
          <div>
            <h2>人民币消费柱状图</h2>
            <p>{loading ? '正在读取成功调用费用' : chartSummary}</p>
          </div>
          <StatusPill tone={hasRenminbiAmount ? 'success' : 'neutral'}>
            {formatRenminbiAmount(summary?.totalAmount ?? '0')}
          </StatusPill>
        </div>
        {loading ? (
          <p className="uc-task-center__muted" role="status">正在汇总消费数据…</p>
        ) : !summary || !hasRenminbiAmount ? (
          <EmptyBarChart dates={summary?.timeBuckets.map((bucket) => bucket.date)} />
        ) : (
          <div className="uc-task-center__bar-chart" aria-label="按时间汇总的消费柱状图">
            {summary.timeBuckets.map((bucket) => (
              <div className="uc-task-center__bar-row" key={bucket.date}>
                <span>{dailyBucketLabel(bucket.date)}</span>
                <div>
                  <i style={{ width: `${consumptionBarRatio(bucket.amount, maximumBucketAmount)}%` }} />
                </div>
                <strong>{formatRenminbiAmount(bucket.amount)} · {bucket.callCount} 次</strong>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="uc-task-center__chart-card uc-task-center__chart-card--donut">
        <div className="uc-task-center__chart-heading">
          <div>
            <h2>供应商人民币消费占比</h2>
            <p>{loading ? '正在读取成功调用费用' : '按人民币本地估算汇总，前 5 个供应商外归入“其他”'}</p>
          </div>
          <StatusPill>{providerSlices.length} 个分组</StatusPill>
        </div>
        {loading ? (
          <p className="uc-task-center__muted" role="status">正在计算供应商占比…</p>
        ) : providerSlices.length === 0 ? (
          <EmptyDonutChart />
        ) : (
          <div className="uc-task-center__donut-layout">
            <div
              aria-label="供应商消费占比环形图"
              className="uc-task-center__donut"
              role="img"
              style={{
                '--uc-task-donut': donutGradient(providerSlices)
              } as CSSProperties & Record<'--uc-task-donut', string>}
            >
              <strong>{providerSlices.length}</strong>
              <span>分组</span>
            </div>
            <div className="uc-task-center__donut-legend">
              {providerSlices.map((slice) => (
                <div key={slice.key}>
                  <i style={{ background: slice.color }} />
                  <span>{slice.label}</span>
                  <strong>{slice.ratio.toFixed(2)}% · {formatRenminbiAmount(slice.amount)}</strong>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {!loading && (message || (summary?.issues.length ?? 0) > 0) ? (
        <p className="uc-task-center__chart-note" role="status">
          {message || `部分项目无法纳入消费统计：${summary?.issues.map((issue) => issue.projectName).join('、')}`}
        </p>
      ) : null}
      {!loading && summary && summary.pendingConversionCallCount > 0 ? (
        <p className="uc-task-center__chart-note" role="status">
          {summary.pendingConversionCallCount} 次非人民币费用待换算，未混入人民币总额
          {summary.pendingCurrencies.length > 0
            ? `（${summary.pendingCurrencies.map((item) => `${item.currencyCode} ${item.callCount} 次`).join('、')}）`
            : ''}。
        </p>
      ) : null}
      {!loading && summary && (
        summary.missingPricingRuleCount > 0 ||
        summary.missingUsageCount > 0 ||
        summary.invalidFeeCount > 0
      ) ? (
        <p className="uc-task-center__chart-note" role="status">
          成功调用中另有：缺官方价格规则 {summary.missingPricingRuleCount} 次，
          缺响应体计费用量 {summary.missingUsageCount} 次，格式异常 {summary.invalidFeeCount} 次。
        </p>
      ) : null}
      {!loading && summary?.conversionSources.map((source) => (
        <p className="uc-task-center__chart-note" key={source.sourceCurrencyCode} role="status">
          {source.sourceCurrencyCode} → 人民币换算来源：{source.sourceTitle}（核对于 {source.sourceCheckedAt}）。
        </p>
      ))}
      {!loading && summary ? (
        <p className="uc-task-center__chart-note" role="note">
          金额为基于本地调用事实、已核准价格与换算事实生成的估算，不等于服务商正式账单。
        </p>
      ) : null}
    </section>
  );
}

function EmptyBarChart({ dates }: { readonly dates?: readonly string[] }) {
  const labels = dates?.map(dailyBucketLabel) ?? emptyBarLabels();
  return (
    <div className="uc-task-center__bar-chart uc-task-center__bar-chart--empty" aria-label="暂无可计算费用的消费柱状图">
      {labels.map((label, index) => (
        <div className="uc-task-center__bar-row" key={label}>
          <span>{label}</span>
          <div>
            <i style={{ width: `${[18, 32, 24, 42, 28, 36, 22][index]}%` }} />
          </div>
          <strong>暂无</strong>
        </div>
      ))}
      <p className="uc-task-center__muted">暂无可纳入的人民币估算；非人民币费用在缺少已核准换算事实时保持待换算。</p>
    </div>
  );
}

function EmptyDonutChart() {
  return (
    <div className="uc-task-center__donut-layout uc-task-center__donut-layout--empty">
      <div
        aria-label="暂无可计算费用的供应商消费占比环形图"
        className="uc-task-center__donut uc-task-center__donut--empty"
        role="img"
      >
        <strong>0</strong>
        <span>供应商</span>
      </div>
      <div className="uc-task-center__donut-legend">
        <div>
          <i />
          <span>暂无可计算费用</span>
          <strong>0%</strong>
        </div>
      </div>
    </div>
  );
}

function emptyBarLabels(): readonly string[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return dailyBucketLabel(date.toISOString().slice(0, 10));
  });
}

function consumptionProviderSlices(
  slices: readonly StorageConsumptionProviderSliceDto[]
): readonly ProviderConsumptionSlice[] {
  const colors = [
    'var(--uc-color-status-info)',
    'var(--uc-color-status-success)',
    'var(--uc-color-status-warning)',
    'var(--uc-color-status-danger)',
    'var(--uc-color-text-tertiary)',
    'var(--uc-color-border-strong)'
  ];

  return slices.map((slice, index) => ({
    key: slice.key,
    label: slice.label,
    amount: slice.amount,
    ratio: slice.ratioBasisPoints / 100,
    color: colors[index % colors.length]
  }));
}

function donutGradient(slices: readonly ProviderConsumptionSlice[]): string {
  let cursor = 0;
  const segments = slices.map((slice) => {
    const start = cursor;
    const end = cursor + slice.ratio / 100 * 360;
    cursor = end;
    return `${slice.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
  });
  return `conic-gradient(${segments.join(', ')})`;
}

function consumptionBarRatio(amount: string, maximumAmount: number): number {
  const value = Number(amount);
  return value > 0 && maximumAmount > 0 ? Math.max(4, value / maximumAmount * 100) : 0;
}

function formatRenminbiAmount(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '人民币金额不可用';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(amount) < 1 && amount !== 0 ? 4 : 2
  }).format(amount);
}

function dailyBucketLabel(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleDateString('zh-CN', {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit'
  });
}

function TaskDetails({
  details,
  onNavigate,
  onRecoverResult,
  recovering,
  reusingParameters,
  onReuseParameters
}: {
  details: StorageTaskDetailsDto;
  onNavigate?: TasksPageProps['onNavigate'];
  onRecoverResult: () => void;
  recovering: boolean;
  reusingParameters: boolean;
  onReuseParameters: () => void;
}) {
  const state = taskState(details.latestExecutionState);

  return (
    <div className="uc-task-center__details-content">
      <div className="uc-task-center__details-heading">
        <div>
          <strong>{taskKinds[details.kind] ?? '其他任务'}</strong>
          <small>{details.taskId}</small>
        </div>
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>
      <TaskUnifiedTimeline details={details} />
      <div className="uc-task-center__actions">
        <Button
          disabled={reusingParameters}
          loading={reusingParameters}
          onClick={onReuseParameters}
          variant="secondary"
        >
          复用参数
        </Button>
        {(details.canRecoverImageResult || details.canRecoverVideoResult) && (
          <Button
            disabled={recovering}
            loading={recovering}
            onClick={onRecoverResult}
          >
            重新接收结果
          </Button>
        )}
        <Button onClick={() => onNavigate?.('projects')} variant="secondary">返回来源项目</Button>
        <Button onClick={() => onNavigate?.('library')} variant="secondary">查看已登记作品</Button>
      </div>
    </div>
  );
}

function TaskUnifiedTimeline({ details }: { readonly details: StorageTaskDetailsDto }) {
  const storage = window.unicomp?.storage;
  const [calls, setCalls] = useState<readonly StorageCallDetailsDto[]>([]);
  const [issues, setIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    setCalls([]);
    setIssues([]);
    setMessage('');

    if (!storage) {
      setMessage('当前运行环境未连接桌面调用记录能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    void storage.getTaskTimeline(details.projectId, details.taskId)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setMessage('读取调用记录失败，请重试');
          return;
        }
        setCalls(result.value.items);
        setIssues(result.value.issues);
      })
      .catch(() => {
        if (active) setMessage('读取调用记录失败，请重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [details.projectId, details.taskId, storage]);

  const retryability = details.retryability === 'retryable'
    ? '可重试'
    : details.retryability === 'not_retryable'
      ? '不可恢复'
      : '重试性未知';

  return (
    <section className="uc-task-center__task-timeline">
      {issues.length > 0 ? (
        <div className="uc-task-center__call-issues" role="status">
          {issues.map((issue) => (
            <p key={issue.projectId}>
              {issue.projectName}：{issue.reason === 'unavailable'
                ? '项目失效或断盘'
                : '调用数据损坏或缺少精确参数定义'}
            </p>
          ))}
        </div>
      ) : null}

      <ol className="uc-task-center__timeline uc-task-center__unified-timeline">
        <TimelineItem
          time={formatTimestamp(details.createdAt)}
          title="创建任务"
          tone={taskState(details.latestExecutionState).tone}
        >
          <dl className="uc-task-center__timeline-facts">
            <div><dt>所属项目</dt><dd>{details.projectName}</dd></div>
            <div><dt>执行次数</dt><dd>{details.executionCount} 次</dd></div>
            <div><dt>恢复能力</dt><dd>{retryability}</dd></div>
          </dl>
        </TimelineItem>

        <TimelineItem time={formatTimestamp(details.createdAt)} title="确认输入" tone="neutral">
          <div className="uc-task-center__timeline-prompts">
            <div>
              <strong>原始输入</strong>
              <p>{details.originalInput}</p>
            </div>
            <div>
              <strong>最终提示词</strong>
              <p>{details.finalPrompt}</p>
            </div>
          </div>
        </TimelineItem>

        {loading ? (
          <TimelineItem title="读取调用记录" tone="info">
            <p className="uc-task-center__muted" role="status">正在归并该任务的调用记录…</p>
          </TimelineItem>
        ) : calls.length === 0 ? (
          <TimelineItem title="调用记录" tone="neutral">
            <p className="uc-task-center__muted">
              当前任务没有可展示的业务调用记录；预检、候选读取和连接验证不会计入这里。
            </p>
          </TimelineItem>
        ) : (
          calls.flatMap((call) => callTimelineItems(call))
        )}
      </ol>

      {message ? (
        <p className="uc-task-center__message" aria-live="polite">{message}</p>
      ) : null}
    </section>
  );
}

function TimelineItem({
  children,
  time,
  title,
  tone
}: {
  readonly children: ReactNode;
  readonly time?: string;
  readonly title: string;
  readonly tone: StatusTone;
}) {
  return (
    <li className={`uc-task-center__timeline-item uc-task-center__timeline-item--${tone}`}>
      <span aria-hidden="true" />
      <div className="uc-task-center__timeline-card">
        <div className="uc-task-center__timeline-card-heading">
          <strong>{title}</strong>
          {time ? <small>{time}</small> : null}
        </div>
        {children}
      </div>
    </li>
  );
}

function callTimelineItems(call: StorageCallDetailsDto) {
  const fee = calculateSuccessfulCallFee(call);
  const items = call.timeline.map((event) => (
    <TimelineItem
      key={`${call.invocationAttemptId}:${event.sequence}`}
      time={formatTimestamp(event.occurredAt)}
      title={`${featureLabels[call.productFeature] ?? '其他功能'} · ${callEventLabel(event.type)}`}
      tone={callEventTone(event.type)}
    >
      <div className="uc-task-center__timeline-call-summary">
        <StatusPill tone={callState(call.state).tone}>{callState(call.state).label}</StatusPill>
        <span>{displayRoute(call)}</span>
        <span>{formatDuration(call.durationMs)}</span>
      </div>
      {event.safeCode ? (
        <code className="uc-task-center__timeline-code">技术代码：{event.safeCode}</code>
      ) : null}
    </TimelineItem>
  ));

  return [
    ...items,
    <TimelineItem
      key={`${call.invocationAttemptId}:facts`}
      time={formatTimestamp(call.updatedAt)}
      title={`${featureLabels[call.productFeature] ?? '其他功能'} · 用量与结果`}
      tone={callState(call.state).tone}
    >
      <dl className="uc-task-center__timeline-facts">
        <div><dt>用量</dt><dd>{usageLabels[call.usageAvailability] ?? '用量状态未知'}</dd></div>
        <div><dt>费用</dt><dd>{formatCallFee(fee)}</dd></div>
        <div><dt>本地结果</dt><dd>{callResultLabel(call)}</dd></div>
        <div><dt>重试归属</dt><dd>{call.retryOfInvocationAttemptId ?? '首次调用'}</dd></div>
      </dl>
      {fee.state === 'calculated' ? (
        <p className="uc-task-center__timeline-fee">{formatCallFeeFormula(fee)}</p>
      ) : null}
      {call.usage.facts.length > 0 ? (
        <dl className="uc-task-center__timeline-usage">
          {call.usage.facts.map((fact) => (
            <div key={`${fact.metricId}:${fact.unit}`}>
              <dt>{usageMetricLabel(fact.metricId)}</dt>
              <dd>{fact.quantity} {usageUnitLabel(fact.unit)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </TimelineItem>
  ];
}

function callEventLabel(type: string): string {
  const labels: Readonly<Record<string, string>> = {
    submission_started: '开始提交',
    submission_failed_before_request: '请求发出前失败',
    provider_accepted: '服务商已接受',
    provider_progressed: '状态更新',
    cancel_requested: '请求取消',
    cancelled: '已取消',
    result_received: '已接收结果',
    completed: '调用完成',
    failed: '调用失败',
    outcome_unknown: '结果未知'
  };
  return labels[type] ?? '状态更新';
}

function callEventTone(type: string): StatusTone {
  if (type === 'completed' || type === 'result_received') return 'success';
  if (type === 'submission_failed_before_request' || type === 'failed') return 'danger';
  if (type === 'cancel_requested' || type === 'outcome_unknown') return 'warning';
  if (type === 'cancelled') return 'neutral';
  return 'info';
}

function formatDuration(value?: string): string {
  if (!value) return '尚未结束';
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '耗时不可用';
  if (milliseconds < 1000) return `${milliseconds} 毫秒`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainder} 秒`;
}

function usageMetricLabel(metric: string): string {
  const labels: Readonly<Record<string, string>> = {
    input_tokens: '输入文本用量',
    output_tokens: '输出文本用量',
    prompt_tokens: '提示词用量',
    completion_tokens: '输出用量',
    total_tokens: '总文本用量',
    cached_tokens: '缓存用量',
    reasoning_tokens: '推理用量',
    credit_amount: '积分用量',
    cash_amount: '现金扣费',
    cash_list_price: '原价金额',
    package_unit_amount: '资源包用量',
    input_images: '输入图片数',
    output_images: '输出图片数',
    image_count: '输出图片数',
    video_seconds: '视频时长',
    duration_ms: '处理时长'
  };
  return labels[metric] ?? metric;
}

function usageUnitLabel(unit: string): string {
  const labels: Readonly<Record<string, string>> = {
    token: '文本单位',
    tokens: '文本单位',
    credit: '积分',
    credits: '积分',
    provider_unit: '资源包单位',
    currency_amount: '金额',
    image: '张',
    images: '张',
    millisecond: '毫秒',
    milliseconds: '毫秒',
    second: '秒',
    seconds: '秒',
    byte: '字节',
    bytes: '字节'
  };
  return labels[unit] ?? unit;
}

function callResultLabel(call: StorageCallDetailsDto): string {
  if (call.resultRegistration.state === 'registered') {
    return `已登记 ${call.resultRegistration.workIds.length} 个作品`;
  }
  if (call.resultRegistration.state === 'not_applicable') return '无需登记作品';
  if (call.localResultCount > 0) return `${call.localResultCount} 个本地结果，尚未登记`;
  return '没有本地结果';
}
