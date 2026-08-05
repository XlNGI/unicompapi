import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../components/StatusPill';
import type {
  StorageCallDetailsDto,
  StorageCallRecordFilterDto,
  StorageCallRecordSummaryDto,
  StorageReadModelIssueDto
} from '../../shared/storage-ipc';

interface CallRecordsViewProps {
  readonly onNavigate?: (itemId: 'projects' | 'library') => void;
}

interface CallFilters {
  readonly projectId: string;
  readonly productFeature: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly state: string;
  readonly createdFrom: string;
  readonly createdTo: string;
}

const emptyFilters: CallFilters = {
  projectId: 'all',
  productFeature: 'all',
  providerId: 'all',
  connectionId: 'all',
  modelId: 'all',
  state: 'all',
  createdFrom: '',
  createdTo: ''
};

const callStates: Record<string, { readonly label: string; readonly tone: StatusTone }> = {
  submitting: { label: '正在提交', tone: 'info' },
  failed_before_submission: { label: '提交前失败', tone: 'danger' },
  accepted: { label: '已接受', tone: 'info' },
  running: { label: '执行中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  unknown_outcome: { label: '结果未知', tone: 'warning' }
};

const featureLabels: Record<string, string> = {
  text_chat: '文本对话',
  text_to_image: '文生图',
  reference_to_image: '图生图',
  image_edit: '图片编辑',
  image_understanding: '图片识别',
  image_to_prompt: '图片转提示词',
  text_to_video: '文生视频',
  image_to_video: '图生视频',
  video_edit: '视频编辑'
};

const usageLabels: Record<string, string> = {
  reported_complete: '服务商已完整报告',
  reported_partial: '服务商仅部分报告',
  not_reported: '服务商未返回用量',
  invalid_response: '用量响应无效',
  unknown_outcome: '调用结果未知，用量无法确认',
  not_applicable: '不适用',
  not_collected_legacy: '历史记录未采集'
};

const eventLabels: Record<string, string> = {
  submission_started: '开始提交',
  submission_failed_before_request: '请求发出前失败',
  provider_accepted: '服务商已接受',
  provider_progressed: '服务商状态更新',
  cancel_requested: '已请求取消',
  cancelled: '已取消',
  result_received: '已接收结果',
  completed: '调用完成',
  failed: '调用失败',
  outcome_unknown: '调用结果未知'
};

export function CallRecordsView({ onNavigate }: CallRecordsViewProps) {
  const storage = window.unicomp?.storage;
  const [filters, setFilters] = useState<CallFilters>(emptyFilters);
  const [records, setRecords] = useState<readonly StorageCallRecordSummaryDto[]>([]);
  const [catalogRecords, setCatalogRecords] = useState<readonly StorageCallRecordSummaryDto[]>([]);
  const [issues, setIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string>();
  const [details, setDetails] = useState<StorageCallDetailsDto>();
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    if (!storage) {
      setMessage('当前运行环境未连接桌面调用记录能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    if (
      filters.createdFrom &&
      filters.createdTo &&
      filters.createdFrom > filters.createdTo
    ) {
      setMessage('开始日期不能晚于结束日期');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setMessage('');
    void storage.listCallRecords(toRequest(filters))
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setMessage(`读取调用记录失败：${result.error.message}`);
          return;
        }
        setRecords(result.value.items);
        setIssues(result.value.issues);
        setTotal(result.value.total);
        if (isEmptyFilter(filters)) setCatalogRecords(result.value.items);
        setSelectedCallId((current) =>
          current && result.value.items.some(
            (record) => record.invocationAttemptId === current
          )
            ? current
            : result.value.items[0]?.invocationAttemptId
        );
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
  }, [
    filters.connectionId,
    filters.createdFrom,
    filters.createdTo,
    filters.modelId,
    filters.productFeature,
    filters.projectId,
    filters.providerId,
    filters.state,
    storage
  ]);

  useEffect(() => {
    let active = true;
    if (!storage || !selectedCallId) {
      setDetails(undefined);
      return () => {
        active = false;
      };
    }

    setDetails(undefined);
    setDetailsLoading(true);
    void storage.getCallDetails(selectedCallId)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setMessage(`读取调用详情失败：${result.error.message}`);
          return;
        }
        setDetails(result.value);
        if (!result.value) setMessage('调用记录已不存在或所属项目当前不可用');
      })
      .catch(() => {
        if (active) setMessage('读取调用详情失败，请重试');
      })
      .finally(() => {
        if (active) setDetailsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedCallId, storage]);

  const options = useMemo(() => ({
    projects: uniqueOptions(catalogRecords, 'projectId', 'projectName'),
    features: uniqueValues(catalogRecords.map((record) => record.productFeature)),
    providers: uniqueOptions(catalogRecords, 'providerId', 'providerName'),
    connections: uniqueOptions(catalogRecords, 'connectionId', 'connectionName'),
    models: uniqueOptions(catalogRecords, 'modelId', 'modelName')
  }), [catalogRecords]);

  function changeFilter<TKey extends keyof CallFilters>(key: TKey, value: CallFilters[TKey]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div
      aria-labelledby="call-records-tab"
      className="uc-task-center__call-view"
      id="call-records-panel"
      role="tabpanel"
    >
      <Card className="uc-task-center__filters uc-task-center__call-filters">
        <SelectFilter
          label="所属项目"
          onChange={(value) => changeFilter('projectId', value)}
          options={options.projects}
          value={filters.projectId}
        />
        <SelectFilter
          label="调用功能"
          onChange={(value) => changeFilter('productFeature', value)}
          options={options.features.map((value) => ({
            value,
            label: featureLabels[value] ?? value
          }))}
          value={filters.productFeature}
        />
        <SelectFilter
          label="服务商"
          onChange={(value) => changeFilter('providerId', value)}
          options={options.providers}
          value={filters.providerId}
        />
        <SelectFilter
          label="连接"
          onChange={(value) => changeFilter('connectionId', value)}
          options={options.connections}
          value={filters.connectionId}
        />
        <SelectFilter
          label="模型"
          onChange={(value) => changeFilter('modelId', value)}
          options={options.models}
          value={filters.modelId}
        />
        <SelectFilter
          label="调用状态"
          onChange={(value) => changeFilter('state', value)}
          options={Object.entries(callStates).map(([value, item]) => ({
            value,
            label: item.label
          }))}
          value={filters.state}
        />
        <label>
          开始日期
          <input
            max={filters.createdTo || undefined}
            onChange={(event) => changeFilter('createdFrom', event.target.value)}
            type="date"
            value={filters.createdFrom}
          />
        </label>
        <label>
          结束日期
          <input
            min={filters.createdFrom || undefined}
            onChange={(event) => changeFilter('createdTo', event.target.value)}
            type="date"
            value={filters.createdTo}
          />
        </label>
      </Card>

      {issues.length > 0 ? (
        <Card className="uc-task-center__issues" role="status">
          <h2>部分项目的调用记录无法读取</h2>
          {issues.map((issue) => (
            <p key={issue.projectId}>
              {issue.projectName}：{issue.reason === 'unavailable'
                ? '项目失效或断盘'
                : '调用数据损坏或缺少精确 Schema'}
            </p>
          ))}
        </Card>
      ) : null}

      {loading ? (
        <EmptyState
          busy
          description="正在汇总项目级调用与上游用量事实。"
          icon="载"
          role="status"
          title="正在读取调用记录"
        />
      ) : records.length === 0 ? (
        <EmptyState
          description="预检、候选读取和连接验证不会创建业务调用记录。"
          icon="调"
          title="没有符合条件的调用"
        />
      ) : (
        <div className="uc-task-center__workspace">
          <section className="uc-task-center__list" aria-labelledby="call-list-title">
            <h2 id="call-list-title">调用列表（{records.length} / {total}）</h2>
            {records.map((record) => {
              const state = callState(record.state);
              return (
                <button
                  aria-pressed={selectedCallId === record.invocationAttemptId}
                  className="uc-task-center__task uc-task-center__call"
                  key={record.invocationAttemptId}
                  onClick={() => setSelectedCallId(record.invocationAttemptId)}
                  type="button"
                >
                  <span>
                    <strong>{featureLabels[record.productFeature] ?? record.productFeature}</strong>
                    <small>{record.projectName}</small>
                  </span>
                  <StatusPill tone={state.tone}>{state.label}</StatusPill>
                  <small>{displayRoute(record)}</small>
                  <small>{formatTimestamp(record.createdAt)}</small>
                  <small>{usageLabels[record.usageAvailability] ?? record.usageAvailability}</small>
                </button>
              );
            })}
          </section>

          <section className="uc-task-center__details" aria-labelledby="call-details-title">
            <h2 id="call-details-title">调用详情</h2>
            {detailsLoading ? (
              <p className="uc-task-center__muted" role="status">正在读取调用详情…</p>
            ) : details ? (
              <CallDetails details={details} onNavigate={onNavigate} />
            ) : (
              <p className="uc-task-center__muted">选择左侧调用查看脱敏时间线和用量事实。</p>
            )}
          </section>
        </div>
      )}

      <p className="uc-task-center__message" aria-live="polite">{message}</p>
    </div>
  );
}

function CallDetails({
  details,
  onNavigate
}: {
  readonly details: StorageCallDetailsDto;
  readonly onNavigate?: CallRecordsViewProps['onNavigate'];
}) {
  const state = callState(details.state);
  return (
    <div className="uc-task-center__details-content">
      <div className="uc-task-center__details-heading">
        <div>
          <strong>{featureLabels[details.productFeature] ?? details.productFeature}</strong>
          <small>{details.invocationAttemptId}</small>
        </div>
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>

      <dl className="uc-task-center__facts">
        <div><dt>所属项目</dt><dd>{details.projectName}</dd></div>
        <div><dt>提交时间</dt><dd>{formatTimestamp(details.createdAt)}</dd></div>
        <div><dt>服务商</dt><dd>{details.providerName ?? '提交时显示名不可用'}</dd></div>
        <div><dt>连接</dt><dd>{details.connectionName ?? '提交时显示名不可用'}</dd></div>
        <div><dt>模型</dt><dd>{details.modelName ?? '提交时显示名不可用'}</dd></div>
        <div><dt>总耗时</dt><dd>{formatDuration(details.durationMs)}</dd></div>
        <div><dt>调用对象</dt><dd>{details.subject.kind === 'media' ? '媒体任务' : '项目对话'}</dd></div>
        <div><dt>重试归属</dt><dd>{details.retryOfInvocationAttemptId ?? '首次调用'}</dd></div>
      </dl>

      <section className="uc-task-center__call-section">
        <h3>状态时间线</h3>
        <ol className="uc-task-center__timeline">
          {details.timeline.map((event) => (
            <li key={event.sequence}>
              <span aria-hidden="true" />
              <div>
                <strong>{eventLabels[event.type] ?? event.type}</strong>
                <small>{formatTimestamp(event.occurredAt)}</small>
                {event.safeCode ? <small>原因代码：{event.safeCode}</small> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="uc-task-center__call-section">
        <div className="uc-task-center__details-heading">
          <h3>上游用量</h3>
          <StatusPill tone={usageTone(details.usage.availability)}>
            {usageLabels[details.usage.availability] ?? details.usage.availability}
          </StatusPill>
        </div>
        {details.usage.facts.length === 0 ? (
          <p className="uc-task-center__muted">
            {usageLabels[details.usage.availability] ?? '没有可展示的上游用量事实。'}
          </p>
        ) : (
          <dl className="uc-task-center__usage-list">
            {details.usage.facts.map((fact) => (
              <div key={`${fact.metricId}:${fact.unit}`}>
                <dt>{fact.metricId}</dt>
                <dd>{fact.quantity} {fact.unit}</dd>
                <small>{usageSourceLabel(fact.source)}</small>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="uc-task-center__call-section">
        <div className="uc-task-center__details-heading">
          <h3>本地结果</h3>
          <StatusPill tone={registrationTone(details.resultRegistration.state)}>
            {registrationLabel(details.resultRegistration.state)}
          </StatusPill>
        </div>
        {details.localResults.length === 0 ? (
          <p className="uc-task-center__muted">当前调用没有已记录的本地结果属性。</p>
        ) : (
          <div className="uc-task-center__result-list">
            {details.localResults.map((result, index) => (
              <article key={`${result.observedAt}:${index}`}>
                <strong>{mediaLabel(result.mediaKind)} · {result.outputCount} 个结果</strong>
                <small>{localResultFacts(result)}</small>
                {result.resultImageUrl ? (
                  <p className="uc-task-center__result-url">
                    <strong>图片 URL</strong>
                    <a href={result.resultImageUrl} rel="noreferrer" target="_blank">
                      {result.resultImageUrl}
                    </a>
                  </p>
                ) : null}
                <small>{validationLabel(result.validationState)} · {formatTimestamp(result.observedAt)}</small>
              </article>
            ))}
          </div>
        )}
        {details.resultRegistration.workIds.length > 0 ? (
          <p className="uc-task-center__muted">
            已登记作品：{details.resultRegistration.workIds.join('、')}
          </p>
        ) : null}
      </section>

      <div className="uc-task-center__actions">
        <Button onClick={() => onNavigate?.('projects')} variant="secondary">返回来源项目</Button>
        {details.resultRegistration.state === 'registered' ? (
          <Button onClick={() => onNavigate?.('library')} variant="secondary">查看已登记作品</Button>
        ) : null}
      </div>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="all">全部</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function toRequest(filters: CallFilters): StorageCallRecordFilterDto {
  return {
    ...(filters.projectId === 'all' ? {} : { projectId: filters.projectId }),
    ...(filters.productFeature === 'all'
      ? {}
      : { productFeature: filters.productFeature }),
    ...(filters.providerId === 'all' ? {} : { providerId: filters.providerId }),
    ...(filters.connectionId === 'all'
      ? {}
      : { connectionId: filters.connectionId }),
    ...(filters.modelId === 'all' ? {} : { modelId: filters.modelId }),
    ...(filters.state === 'all' ? {} : { state: filters.state }),
    ...(filters.createdFrom
      ? { createdFrom: new Date(`${filters.createdFrom}T00:00:00`).toISOString() }
      : {}),
    ...(filters.createdTo
      ? { createdTo: new Date(`${filters.createdTo}T23:59:59.999`).toISOString() }
      : {}),
    offset: 0,
    limit: 200
  };
}

function isEmptyFilter(filters: CallFilters): boolean {
  return Object.entries(filters).every(([, value]) => value === 'all' || value === '');
}

function uniqueOptions(
  records: readonly StorageCallRecordSummaryDto[],
  idKey: 'projectId' | 'providerId' | 'connectionId' | 'modelId',
  nameKey: 'projectName' | 'providerName' | 'connectionName' | 'modelName'
) {
  return [...new Map(records.map((record) => [
    record[idKey],
    {
      value: record[idKey],
      label: record[nameKey] ?? '提交时显示名不可用'
    }
  ])).values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function uniqueValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function callState(state: string) {
  return callStates[state] ?? { label: state, tone: 'neutral' as const };
}

function displayRoute(record: StorageCallRecordSummaryDto): string {
  if (record.displayNameAvailability !== 'snapshotted') return '提交时路由显示名不可用';
  return [record.providerName, record.connectionName, record.modelName].filter(Boolean).join(' / ');
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString('zh-CN');
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

function usageTone(availability: string): StatusTone {
  if (availability === 'reported_complete' || availability === 'not_applicable') return 'success';
  if (availability === 'reported_partial' || availability === 'unknown_outcome') return 'warning';
  if (availability === 'invalid_response') return 'danger';
  return 'neutral';
}

function usageSourceLabel(source: string): string {
  if (source === 'provider_body') return '来源：服务商响应正文白名单字段';
  if (source === 'provider_header') return '来源：服务商响应头白名单字段';
  if (source === 'provider_usage_endpoint') return '来源：服务商用量接口白名单字段';
  return '来源不可用';
}

function registrationTone(state: string): StatusTone {
  if (state === 'registered' || state === 'not_applicable') return 'success';
  return 'warning';
}

function registrationLabel(state: string): string {
  if (state === 'registered') return '已登记作品';
  if (state === 'not_applicable') return '无需登记作品';
  return '尚未登记作品';
}

function mediaLabel(kind: string): string {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  return '文本';
}

function validationLabel(state: string): string {
  if (state === 'valid') return '本地校验通过';
  if (state === 'invalid') return '本地校验失败';
  return '等待本地校验';
}

function localResultFacts(result: StorageCallDetailsDto['localResults'][number]): string {
  const facts = [];
  if (result.width !== undefined && result.height !== undefined) {
    facts.push(`${result.width} × ${result.height}`);
  }
  if (result.durationMs) facts.push(`${result.durationMs} 毫秒`);
  if (result.byteLength) facts.push(`${result.byteLength} 字节`);
  return facts.join(' · ') || '没有额外的本地媒体属性';
}
