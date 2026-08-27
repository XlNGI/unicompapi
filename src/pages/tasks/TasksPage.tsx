import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Input, SelectPicker } from 'rsuite';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type { StatusTone } from '../../components/StatusPill';
import type {
  StorageCallDetailsDto,
  StorageReadModelIssueDto,
  StorageTaskDetailsDto,
  StorageTaskSummaryDto
} from '../../shared/storage-ipc';
import type { TaskReuseTarget } from '../../shared/task-reuse';
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
  formatCallFeeFormula,
  formatFeeAmount
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
  const [tasks, setTasks] = useState<readonly StorageTaskSummaryDto[]>([]);
  const [issues, setIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [details, setDetails] = useState<StorageTaskDetailsDto>();
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [reusingParameters, setReusingParameters] = useState(false);
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
        } else setMessage('读取任务失败，请重试');
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
      const [taskList, taskDetails] = await Promise.all([
        storage?.listTasks(),
        storage?.getTaskDetails(taskId)
      ]);
      if (taskList?.ok) {
        setTasks(taskList.value.items);
        setIssues(taskList.value.issues);
      }
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

interface ConsumptionTimeBar {
  readonly key: string;
  readonly label: string;
  readonly amount: number;
  readonly callCount: number;
  readonly ratio: number;
}

interface ProviderConsumptionSlice {
  readonly key: string;
  readonly label: string;
  readonly amount: number;
  readonly ratio: number;
  readonly color: string;
}

interface ConsumptionChartModel {
  readonly bars: readonly ConsumptionTimeBar[];
  readonly amountLabel: string;
  readonly chartMode: 'fee' | 'credit';
  readonly providerSlices: readonly ProviderConsumptionSlice[];
  readonly sampledCallCount: number;
  readonly successfulCallCount: number;
  readonly feeCallCount: number;
  readonly missingFeeCallCount: number;
  readonly missingPricingRuleCount: number;
  readonly missingUsageCount: number;
  readonly invalidFeeCount: number;
  readonly totalCallCount: number;
  readonly totalAmount: number;
}

function TaskConsumptionCharts() {
  const storage = window.unicomp?.storage;
  const [model, setModel] = useState<ConsumptionChartModel>({
    bars: [],
    amountLabel: '金额单位',
    chartMode: 'fee',
    providerSlices: [],
    sampledCallCount: 0,
    successfulCallCount: 0,
    feeCallCount: 0,
    missingFeeCallCount: 0,
    missingPricingRuleCount: 0,
    missingUsageCount: 0,
    invalidFeeCount: 0,
    totalCallCount: 0,
    totalAmount: 0
  });
  const [issues, setIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    setMessage('');
    setIssues([]);
    setLoading(true);

    if (!storage) {
      setMessage('当前运行环境未连接桌面调用记录能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void storage.listCallRecords({ limit: 200 })
      .then(async (result) => {
        if (!active) return;
        if (!result.ok) {
          setMessage('读取消费统计失败，请重试');
          return;
        }
        const details = await Promise.all(
          result.value.items.map(async (record) => {
            try {
              const detailsResult = await storage.getCallDetails(record.invocationAttemptId);
              return detailsResult.ok ? detailsResult.value : undefined;
            } catch {
              return undefined;
            }
          })
        );
        if (!active) return;
        setModel(buildConsumptionChartModel(
          details.filter((item): item is StorageCallDetailsDto => Boolean(item)),
          result.value.items.length,
          result.value.total
        ));
        setIssues(result.value.issues);
      })
      .catch(() => {
        if (active) setMessage('读取消费统计失败，请重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [storage]);

  const totalLabel = model.totalCallCount > model.sampledCallCount
    ? `最近 ${model.sampledCallCount} / ${model.totalCallCount} 次调用`
    : `${model.sampledCallCount} 次调用`;
  const chartSummary = model.chartMode === 'fee'
    ? `${totalLabel} · 成功 ${model.successfulCallCount} 次 · 已计费 ${model.feeCallCount} 次`
    : `${totalLabel} · 成功 ${model.successfulCallCount} 次 · 已记录积分消耗`;

  return (
    <section className="uc-task-center__charts" aria-label="消费统计">
      <Card className="uc-task-center__chart-card">
        <div className="uc-task-center__chart-heading">
          <div>
            <h2>消费柱状图</h2>
            <p>{loading ? '正在读取成功调用费用' : chartSummary}</p>
          </div>
          <StatusPill tone={model.bars.length > 0 ? 'success' : 'neutral'}>
            {formatFeeAmount(model.totalAmount)} {model.amountLabel}
          </StatusPill>
        </div>
        {loading ? (
          <p className="uc-task-center__muted" role="status">正在汇总消费数据…</p>
        ) : model.bars.length === 0 ? (
          <EmptyBarChart />
        ) : (
          <div className="uc-task-center__bar-chart" aria-label="按时间汇总的消费柱状图">
            {model.bars.map((bar) => (
              <div className="uc-task-center__bar-row" key={bar.key}>
                <span>{bar.label}</span>
                <div>
                  <i style={{ width: `${bar.ratio}%` }} />
                </div>
                <strong>{formatFeeAmount(bar.amount)} {model.amountLabel} · {bar.callCount} 次</strong>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="uc-task-center__chart-card uc-task-center__chart-card--donut">
        <div className="uc-task-center__chart-heading">
          <div>
            <h2>供应商消费占比</h2>
            <p>{loading ? '正在读取成功调用费用' : model.chartMode === 'fee' ? '按官方计费规则汇总' : '官方单价缺失，先按积分汇总'}</p>
          </div>
          <StatusPill>{model.providerSlices.length} 个供应商</StatusPill>
        </div>
        {loading ? (
          <p className="uc-task-center__muted" role="status">正在计算供应商占比…</p>
        ) : model.providerSlices.length === 0 ? (
          <EmptyDonutChart />
        ) : (
          <div className="uc-task-center__donut-layout">
            <div
              aria-label="供应商消费占比环形图"
              className="uc-task-center__donut"
              role="img"
              style={{
                '--uc-task-donut': donutGradient(model.providerSlices)
              } as CSSProperties & Record<'--uc-task-donut', string>}
            >
              <strong>{model.providerSlices.length}</strong>
              <span>供应商</span>
            </div>
            <div className="uc-task-center__donut-legend">
              {model.providerSlices.map((slice) => (
                <div key={slice.key}>
                  <i style={{ background: slice.color }} />
                  <span>{slice.label}</span>
                  <strong>{slice.ratio.toFixed(1)}% · {formatFeeAmount(slice.amount)} {model.amountLabel}</strong>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {!loading && (message || issues.length > 0) ? (
        <p className="uc-task-center__chart-note" role="status">
          {message || `部分项目无法纳入消费统计：${issues.map((issue) => issue.projectName).join('、')}`}
        </p>
      ) : null}
      {!loading && model.chartMode === 'fee' && model.missingFeeCallCount > 0 ? (
        <p className="uc-task-center__chart-note" role="status">
          {model.missingFeeCallCount} 次成功调用未纳入费用图表：
          缺官方价格规则 {model.missingPricingRuleCount} 次，
          缺响应体计费用量 {model.missingUsageCount} 次，
          格式异常 {model.invalidFeeCount} 次。
        </p>
      ) : null}
      {!loading && model.chartMode === 'credit' ? (
        <p className="uc-task-center__chart-note" role="status">
          当前成功调用有响应体积分用量，但缺少已核准官方单价；图表暂按积分展示，不折算金额。
        </p>
      ) : null}
    </section>
  );
}

function EmptyBarChart() {
  return (
    <div className="uc-task-center__bar-chart uc-task-center__bar-chart--empty" aria-label="暂无可计算费用的消费柱状图">
      {emptyBarLabels().map((label, index) => (
        <div className="uc-task-center__bar-row" key={label}>
          <span>{label}</span>
          <div>
            <i style={{ width: `${[18, 32, 24, 42, 28, 36, 22][index]}%` }} />
          </div>
          <strong>暂无</strong>
        </div>
      ))}
      <p className="uc-task-center__muted">暂无可计算费用；成功调用缺少官方价格规则或计费用量时不会计入。</p>
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
    return dailyBucketLabel(date.toISOString());
  });
}

function buildConsumptionChartModel(
  calls: readonly StorageCallDetailsDto[],
  sampledCallCount: number,
  totalCallCount: number
): ConsumptionChartModel {
  const feeTimeTotals = new Map<string, { label: string; amount: number; callCount: number }>();
  const creditTimeTotals = new Map<string, { label: string; amount: number; callCount: number }>();
  const providerTotals = new Map<string, number>();
  const creditProviderTotals = new Map<string, number>();
  const currencyLabels = new Set<string>();
  let successfulCallCount = 0;
  let feeCallCount = 0;
  let missingFeeCallCount = 0;
  let missingPricingRuleCount = 0;
  let missingUsageCount = 0;
  let invalidFeeCount = 0;

  for (const call of calls) {
    if (call.state !== 'completed') continue;
    successfulCallCount += 1;
    const fee = calculateSuccessfulCallFee(call);
    if (fee.state !== 'calculated') {
      missingFeeCallCount += 1;
      const credits = creditQuantity(call);
      if (credits !== undefined) {
        addConsumptionBucket(creditTimeTotals, call.createdAt, credits);
        addProviderConsumption(creditProviderTotals, call, credits);
      }
      if (!call.officialPricingRule && !call.officialUnitPrice) {
        missingPricingRuleCount += 1;
      } else if (fee.state === 'missing_inputs') {
        missingUsageCount += 1;
      } else {
        invalidFeeCount += 1;
      }
      continue;
    }
    feeCallCount += 1;
    currencyLabels.add(fee.currencyLabel);

    addConsumptionBucket(feeTimeTotals, call.createdAt, fee.fee);
    addProviderConsumption(providerTotals, call, fee.fee);
  }

  const chartMode = feeCallCount > 0 ? 'fee' : 'credit';
  const timeTotals = chartMode === 'fee' ? feeTimeTotals : creditTimeTotals;
  const selectedProviderTotals = chartMode === 'fee' ? providerTotals : creditProviderTotals;
  const timeGroups = [...timeTotals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-7);
  const maxAmount = Math.max(...timeGroups.map(([, value]) => value.amount), 0);
  const bars = timeGroups.map(([key, value]) => ({
    key,
    label: value.label,
    amount: value.amount,
    callCount: value.callCount,
    ratio: maxAmount > 0 ? Math.max(4, value.amount / maxAmount * 100) : 0
  }));
  const providerConsumptionTotals = [...selectedProviderTotals.entries()]
    .map(([provider, amount]) => ({ provider, amount }))
    .filter((item) => item.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 6);
  const totalAmount = [...selectedProviderTotals.values()].reduce((sum, amount) => sum + amount, 0);
  const colors = [
    'var(--uc-color-status-info)',
    'var(--uc-color-status-success)',
    'var(--uc-color-status-warning)',
    'var(--uc-color-status-danger)',
    'var(--uc-color-text-tertiary)',
    'var(--uc-color-border-strong)'
  ];

  return {
    bars,
    amountLabel: chartMode === 'fee'
      ? currencyLabels.size === 1 ? [...currencyLabels][0] : '金额单位'
      : '积分',
    chartMode,
    providerSlices: providerConsumptionTotals.map((item, index) => ({
      key: item.provider,
      label: item.provider,
      amount: item.amount,
      ratio: totalAmount > 0 ? item.amount / totalAmount * 100 : 0,
      color: colors[index % colors.length]
    })),
    sampledCallCount,
    successfulCallCount,
    feeCallCount,
    missingFeeCallCount,
    missingPricingRuleCount,
    missingUsageCount,
    invalidFeeCount,
    totalCallCount,
    totalAmount
  };
}

function addConsumptionBucket(
  totals: Map<string, { label: string; amount: number; callCount: number }>,
  createdAt: string,
  amount: number
): void {
  const timeKey = dailyBucketKey(createdAt);
  const currentTime = totals.get(timeKey) ?? {
    label: dailyBucketLabel(createdAt),
    amount: 0,
    callCount: 0
  };
  totals.set(timeKey, {
    ...currentTime,
    amount: currentTime.amount + amount,
    callCount: currentTime.callCount + 1
  });
}

function addProviderConsumption(
  totals: Map<string, number>,
  call: StorageCallDetailsDto,
  amount: number
): void {
  const providerLabel = call.providerName ?? call.providerId;
  const providerKey = providerLabel || '提交时显示名不可用';
  totals.set(providerKey, (totals.get(providerKey) ?? 0) + amount);
}

function creditQuantity(call: StorageCallDetailsDto): number | undefined {
  for (const fact of call.usage.facts) {
    if (
      !['credit_amount', 'credits', 'credit', 'point_amount', 'points', 'point']
        .includes(fact.metricId) &&
      !['credit', 'credits', 'point', 'points'].includes(fact.unit)
    ) {
      continue;
    }
    const quantity = Number(fact.quantity);
    if (Number.isFinite(quantity) && quantity > 0) return quantity;
  }
  return undefined;
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

function dailyBucketKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dailyBucketLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleDateString('zh-CN', {
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
    void storage.listCallRecords({ projectId: details.projectId, limit: 200 })
      .then(async (result) => {
        if (!active) return;
        if (!result.ok) {
          setMessage('读取调用记录失败，请重试');
          return;
        }
        const callDetails = await Promise.all(
          result.value.items
            .filter((record) => record.subjectKind === 'media')
            .map(async (record) => {
              try {
                const detailsResult = await storage.getCallDetails(record.invocationAttemptId);
                return detailsResult.ok ? detailsResult.value : undefined;
              } catch {
                return undefined;
              }
            })
        );
        if (!active) return;
        const taskCalls = callDetails.filter((call): call is StorageCallDetailsDto =>
          call?.subject.kind === 'media' && call.subject.taskId === details.taskId
        );
        setCalls(taskCalls.sort((left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        ));
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
