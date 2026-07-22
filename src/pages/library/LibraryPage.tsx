import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type { StatusTone } from '../../components/StatusPill';
import type {
  StorageLocalMediaHandleDto,
  StorageReadModelIssueDto,
  StorageWorkDetailsDto,
  StorageWorkSummaryDto
} from '../../shared/storage-ipc';
import '../../styles/pages.css';

interface LibraryPageProps {
  onNavigate?: (itemId: 'projects' | 'tasks') => void;
}

const fileStates: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: '待处理', tone: 'neutral' },
  writing: { label: '写入中', tone: 'info' },
  verifying: { label: '校验中', tone: 'info' },
  available: { label: '可用', tone: 'success' },
  missing: { label: '文件丢失', tone: 'warning' },
  read_only: { label: '只读', tone: 'warning' },
  disconnected: { label: '存储断开', tone: 'warning' },
  corrupted: { label: '文件损坏', tone: 'danger' },
  deleted: { label: '已删除', tone: 'danger' }
};

const mediaKinds: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频'
};

function fileState(state: string) {
  return fileStates[state] ?? { label: state, tone: 'neutral' as const };
}

function formatBytes(value?: number) {
  if (value === undefined) return '未记录';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function LibraryPage({ onNavigate }: LibraryPageProps) {
  const [works, setWorks] = useState<readonly StorageWorkSummaryDto[]>([]);
  const [issues, setIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [selectedWorkId, setSelectedWorkId] = useState<string>();
  const [details, setDetails] = useState<StorageWorkDetailsDto>();
  const [media, setMedia] = useState<StorageLocalMediaHandleDto>();
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [mediaFilter, setMediaFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const storage = window.unicomp?.storage;

  async function loadWorks() {
    if (!storage) return;
    const result = await storage.listWorks();
    if (!result.ok) {
      setMessage(`读取作品失败：${result.error.message}`);
      return;
    }
    setWorks(result.value.items);
    setIssues(result.value.issues);
    setSelectedWorkId((current) =>
      current && result.value.items.some((work) => work.workId === current)
        ? current
        : result.value.items[0]?.workId
    );
  }

  useEffect(() => {
    let active = true;
    if (!storage) {
      setMessage('当前运行环境未连接桌面作品能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void loadWorks()
      .catch(() => {
        if (active) setMessage('读取作品失败，请重试');
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
    setMedia(undefined);
    if (!storage || !selectedWorkId) {
      setDetails(undefined);
      return () => {
        active = false;
      };
    }

    setDetailsLoading(true);
    void storage.getWorkDetails(selectedWorkId)
      .then(async (result) => {
        if (!active) return;
        if (!result.ok) {
          setMessage(`读取作品详情失败：${result.error.message}`);
          return;
        }
        setDetails(result.value);
        if (!result.value) {
          setMessage('作品已不存在或所属项目当前不可用');
          return;
        }
        if (result.value.fileState !== 'available' || !mediaKinds[result.value.mediaKind]) return;
        const mediaResult = await storage.createWorkMediaHandle(selectedWorkId);
        if (!active) return;
        if (mediaResult.ok) setMedia(mediaResult.value);
        else setMessage(`作品预览不可用：${mediaResult.error.message}`);
      })
      .catch(() => {
        if (active) setMessage('读取作品详情失败，请重试');
      })
      .finally(() => {
        if (active) setDetailsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedWorkId, storage]);

  async function handleReveal() {
    if (!storage || !details || busy) return;
    setBusy(true);
    setMessage('');
    const result = await storage.revealWorkFile(details.workId);
    setMessage(result.ok ? '已在系统文件管理器中定位作品' : `无法定位作品：${result.error.message}`);
    setBusy(false);
  }

  async function handleRelink() {
    if (!storage || !details || busy) return;
    setBusy(true);
    setMessage('');
    const result = await storage.relinkFile(details.fileId);
    if (!result.ok) setMessage(`重新定位失败：${result.error.message}`);
    else if (result.value.cancelled) setMessage('已取消重新定位');
    else {
      setMessage('文件已重新定位，正在刷新作品状态');
      await loadWorks();
      const detailsResult = await storage.getWorkDetails(details.workId);
      if (detailsResult.ok) setDetails(detailsResult.value);
    }
    setBusy(false);
  }

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const filteredWorks = works.filter((work) =>
    (projectFilter === 'all' || work.projectId === projectFilter) &&
    (mediaFilter === 'all' || work.mediaKind === mediaFilter) &&
    (stateFilter === 'all' || work.fileState === stateFilter) &&
    (!normalizedQuery || [work.name, work.projectName, work.workId].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
    ))
  );
  const projects = Array.from(new Map(works.map((work) => [work.projectId, work.projectName])));

  return (
    <section className="uc-work-library" aria-labelledby="library-page-title">
      <header className="uc-work-library__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id="library-page-title">作品库</h1>
            <StatusPill tone="info">本地已登记作品</StatusPill>
          </div>
          <p className="uc-page-skeleton__description">
            查看已写入本地并登记的作品、来源与版本关系；异常文件保留记录并提供受控恢复入口。
          </p>
        </div>
        <StatusPill>{works.length} 个作品</StatusPill>
      </header>

      <Card className="uc-work-library__filters">
        <label>
          搜索作品
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="作品名、项目名或作品 ID"
            type="search"
            value={query}
          />
        </label>
        <label>
          所属项目
          <select onChange={(event) => setProjectFilter(event.target.value)} value={projectFilter}>
            <option value="all">全部项目</option>
            {projects.map(([projectId, projectName]) => (
              <option key={projectId} value={projectId}>{projectName}</option>
            ))}
          </select>
        </label>
        <label>
          媒体类型
          <select onChange={(event) => setMediaFilter(event.target.value)} value={mediaFilter}>
            <option value="all">全部类型</option>
            {Object.entries(mediaKinds).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          文件状态
          <select onChange={(event) => setStateFilter(event.target.value)} value={stateFilter}>
            <option value="all">全部状态</option>
            {Object.entries(fileStates).map(([value, state]) => (
              <option key={value} value={value}>{state.label}</option>
            ))}
          </select>
        </label>
      </Card>

      {issues.length > 0 && (
        <Card className="uc-work-library__issues" role="status">
          <h2>部分项目无法读取</h2>
          {issues.map((issue) => (
            <p key={issue.projectId}>
              {issue.projectName}：{issue.reason === 'unavailable' ? '项目失效或存储断开' : '作品数据损坏'}
            </p>
          ))}
        </Card>
      )}

      {loading ? (
        <EmptyState
          busy
          role="status"
          title="正在读取作品"
          description="正在汇总本地项目中已登记的作品记录。"
          icon="载"
        />
      ) : works.length === 0 ? (
        <EmptyState
          title="还没有正式作品"
          description="只有完成本地写入、校验并登记的结果才会出现在这里。"
          icon="作"
        />
      ) : (
        <div className="uc-work-library__workspace">
          <section className="uc-work-library__list" aria-labelledby="work-list-title">
            <h2 id="work-list-title">作品列表（{filteredWorks.length}）</h2>
            {filteredWorks.length === 0 ? (
              <p className="uc-work-library__muted">没有符合当前筛选条件的作品。</p>
            ) : (
              <div className="uc-work-library__grid">
                {filteredWorks.map((work) => {
                  const state = fileState(work.fileState);
                  return (
                    <button
                      aria-pressed={selectedWorkId === work.workId}
                      className="uc-work-library__work"
                      key={work.workId}
                      onClick={() => setSelectedWorkId(work.workId)}
                      type="button"
                    >
                      <span className="uc-work-library__work-preview" aria-hidden="true">
                        {mediaKinds[work.mediaKind]?.slice(0, 1) ?? '文'}
                      </span>
                      <span className="uc-work-library__work-heading">
                        <strong>{work.name}</strong>
                        <StatusPill tone={state.tone}>{state.label}</StatusPill>
                      </span>
                      <small>{work.projectName} · {mediaKinds[work.mediaKind] ?? work.mediaKind}</small>
                      <small>{new Date(work.createdAt).toLocaleString('zh-CN')}</small>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="uc-work-library__details" aria-labelledby="work-details-title">
            <h2 id="work-details-title">作品详情</h2>
            {detailsLoading ? (
              <p className="uc-work-library__muted" role="status">正在读取作品详情…</p>
            ) : details ? (
              <WorkDetails
                busy={busy}
                details={details}
                media={media}
                onNavigate={onNavigate}
                onRelink={handleRelink}
                onReveal={handleReveal}
              />
            ) : (
              <p className="uc-work-library__muted">选择左侧作品查看预览、来源和版本关系。</p>
            )}
          </section>
        </div>
      )}

      <p className="uc-work-library__message" aria-live="polite">{message}</p>
    </section>
  );
}

function WorkDetails({
  busy,
  details,
  media,
  onNavigate,
  onRelink,
  onReveal
}: {
  busy: boolean;
  details: StorageWorkDetailsDto;
  media?: StorageLocalMediaHandleDto;
  onNavigate?: LibraryPageProps['onNavigate'];
  onRelink: () => void;
  onReveal: () => void;
}) {
  const state = fileState(details.fileState);
  const canPreview = details.fileState === 'available' && media;

  return (
    <div className="uc-work-library__details-content">
      <div className="uc-work-library__preview">
        {canPreview && details.mediaKind === 'image' ? (
          <img alt={details.name} src={media.url} />
        ) : canPreview && details.mediaKind === 'video' ? (
          <video controls src={media.url} />
        ) : canPreview && details.mediaKind === 'audio' ? (
          <audio controls src={media.url} />
        ) : (
          <div role="status">
            <strong>{state.label}</strong>
            <span>{details.fileState === 'available' ? '当前媒体类型不支持内嵌预览' : '请先恢复本地文件后再预览'}</span>
          </div>
        )}
      </div>

      <div className="uc-work-library__details-heading">
        <div>
          <strong>{details.name}</strong>
          <small>{details.workId}</small>
        </div>
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>

      <dl className="uc-work-library__facts">
        <div><dt>来源项目</dt><dd>{details.projectName}</dd></div>
        <div><dt>媒体类型</dt><dd>{mediaKinds[details.mediaKind] ?? details.mediaKind}</dd></div>
        <div><dt>来源任务</dt><dd>{details.sourceTaskId}</dd></div>
        <div><dt>来源执行</dt><dd>{details.sourceExecutionId}</dd></div>
        <div><dt>父版本</dt><dd>{details.parentWorkId ?? '首个版本'}</dd></div>
        <div><dt>文件大小</dt><dd>{formatBytes(details.sizeBytes)}</dd></div>
        <div><dt>创建时间</dt><dd>{new Date(details.createdAt).toLocaleString('zh-CN')}</dd></div>
        <div><dt>最近校验</dt><dd>{details.verifiedAt ? new Date(details.verifiedAt).toLocaleString('zh-CN') : '未记录'}</dd></div>
      </dl>

      <div className="uc-work-library__actions">
        <Button onClick={() => onNavigate?.('projects')} variant="secondary">返回来源项目</Button>
        <Button onClick={() => onNavigate?.('tasks')} variant="secondary">查看来源任务</Button>
        {details.fileState === 'available' ? (
          <Button disabled={busy} onClick={onReveal} variant="secondary">在文件夹中显示</Button>
        ) : (
          <Button disabled={busy} onClick={onRelink}>{busy ? '请稍候…' : '重新定位文件'}</Button>
        )}
      </div>
    </div>
  );
}
