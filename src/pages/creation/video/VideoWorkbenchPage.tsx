import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import type { StorageProjectSessionDto } from '../../../shared/storage-ipc';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceStaleReasonDto
} from '../../../shared/video-workspace-ipc';
import '../../../styles/pages.css';
import type { VideoCreationMode } from '../creationModes';

const workspaceErrorMessages: Record<VideoWorkspaceIpcErrorCode, string> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  invalid_request: '当前视频草稿数据无效，请刷新页面后重试。',
  draft_not_found: '视频草稿已不存在，请刷新页面后重试。',
  draft_conflict: '视频草稿已在其他位置更新，请刷新页面后重试。',
  workspace_storage_error: '本地视频草稿保存失败，请检查项目目录后重试。'
};

const draftStateLabels: Record<VideoWorkspaceDraftDto['state'], string> = {
  editing: '编辑中',
  saved: '已保存',
  stale: '内容已过期',
  archived: '已归档'
};

const preflightStateLabels: Record<
  VideoWorkspaceDraftDto['generation']['preflight']['state'],
  string
> = {
  not_created: '尚未检查',
  current: '检查结果有效',
  stale: '旧预检已过期'
};

const staleReasonLabels: Record<VideoWorkspaceStaleReasonDto, string> = {
  prompt_changed: '提示词已变化',
  materials_changed: '素材已变化',
  context_changed: '上下文已变化',
  shot_plan_changed: '镜头方案已变化',
  requirements_changed: '关键要求已变化',
  model_changed: '模型已变化',
  parameters_changed: '参数已变化'
};

interface VideoWorkbenchPageProps {
  readonly mode: VideoCreationMode;
}

export function VideoWorkbenchPage({ mode }: VideoWorkbenchPageProps) {
  const storage = window.unicomp?.storage;
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const providers = window.unicomp?.providers;
  const workspaceMode =
    'workspaceMode' in mode ? mode.workspaceMode : undefined;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [drafts, setDrafts] = useState<readonly VideoWorkspaceDraftDto[]>([]);
  const [registry, setRegistry] = useState<ProviderRegistryDto>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const currentDraft = drafts[drafts.length - 1];

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setMessage('');
      setSession(undefined);
      setDrafts([]);
      setRegistry(undefined);

      if (!storage) {
        setMessage('当前运行环境未连接桌面项目工作区。');
        setLoading(false);
        return;
      }

      try {
        const sessionResult = await storage.getProjectSession();
        if (!active) return;
        if (!sessionResult.ok) {
          setMessage('无法读取当前项目，请返回项目页面重试。');
          return;
        }
        setSession(sessionResult.value);
        if (!sessionResult.value) return;

        if (workspaceMode) {
          if (!videoWorkspaces) {
            setMessage('当前运行环境未连接桌面视频工作区。');
            return;
          }
          const draftResult = await videoWorkspaces.list();
          if (!active) return;
          if (!draftResult.ok) {
            setMessage(workspaceErrorMessages[draftResult.error.code]);
            return;
          }
          setDrafts(
            draftResult.value.filter(
              (draft) => draft.mode === workspaceMode
            )
          );
        }

        if (providers && workspaceMode) {
          const registryResult = await providers
            .getRegistry()
            .catch(() => undefined);
          if (!active) return;
          if (registryResult?.ok) setRegistry(registryResult.value);
        }
      } catch {
        if (active) setMessage('读取本地视频工作区失败，请重试。');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [providers, storage, videoWorkspaces, workspaceMode]);

  async function createDraft() {
    if (!videoWorkspaces || !session || !workspaceMode || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoWorkspaces.create(workspaceMode);
      if (!result.ok) {
        setMessage(workspaceErrorMessages[result.error.code]);
        return;
      }
      setDrafts((items) => [...items, result.value]);
      setMessage('本地视频草稿已创建；没有上传素材，也没有创建任务。');
    } catch {
      setMessage('创建本地视频草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!videoWorkspaces || !currentDraft || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoWorkspaces.update({
        ...currentDraft,
        state: currentDraft.state === 'stale' ? 'stale' : 'saved'
      });
      if (!result.ok) {
        setMessage(workspaceErrorMessages[result.error.code]);
        return;
      }
      setDrafts((items) =>
        items.map((draft) =>
          draft.draftId === result.value.draftId ? result.value : draft
        )
      );
      setMessage('视频草稿已保存到当前项目；没有创建或提交任务。');
    } catch {
      setMessage('保存本地视频草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const videoRouteModelIds = new Set(
    registry?.routingPreferences
      .filter((route) => route.enabled && route.purpose === 'video_generation')
      .map((route) => route.modelId) ?? []
  );
  const videoRouteModelCount = registry
    ? registry.models.filter(
        (model) => model.enabled && videoRouteModelIds.has(model.modelId)
      ).length
    : undefined;
  const projectStatus = loading
    ? '正在读取'
    : session
      ? workspaceMode
        ? '项目内本地草稿'
        : '阶段 7 未接入'
      : '未打开项目';
  const preflight = currentDraft?.generation.preflight;
  const preflightLabel = preflight
    ? preflight.state === 'stale' && preflight.staleReasons.length > 0
      ? `${preflightStateLabels.stale}：${preflight.staleReasons
          .map((reason) => staleReasonLabels[reason])
          .join('、')}`
      : preflightStateLabels[preflight.state]
    : '尚未创建草稿';

  return (
    <section
      className="uc-image-workbench uc-video-workbench"
      aria-labelledby={`${mode.id}-title`}
    >
      <header className="uc-image-workbench__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id={`${mode.id}-title`}>
              {mode.label}
            </h1>
            <StatusPill tone={session && workspaceMode ? 'info' : 'warning'}>
              {projectStatus}
            </StatusPill>
          </div>
          <p className="uc-page-skeleton__description">{mode.description}</p>
        </div>
        {workspaceMode ? (
          <div className="uc-image-workbench__header-actions">
            <Button
              disabled={!session || busy}
              onClick={() => void createDraft()}
              variant="secondary"
            >
              {busy ? '请稍候…' : '新建本地草稿'}
            </Button>
            <Button
              disabled={
                !currentDraft ||
                currentDraft.state === 'saved' ||
                currentDraft.state === 'archived' ||
                busy
              }
              onClick={() => void saveDraft()}
            >
              保存本地草稿
            </Button>
          </div>
        ) : null}
      </header>

      <Card className="uc-image-workbench__project-strip">
        <div className="uc-image-workbench__project-fact">
          <span>当前项目</span>
          <strong>{session?.projectName ?? '尚未打开项目'}</strong>
        </div>
        <div className="uc-image-workbench__project-fact">
          <span>当前模式草稿</span>
          <strong>
            {workspaceMode
              ? session
                ? `${drafts.length} 个`
                : '不可创建'
              : '阶段 6 不创建'}
          </strong>
        </div>
        <div className="uc-image-workbench__project-fact">
          <span>当前状态</span>
          <strong>
            {workspaceMode
              ? currentDraft
                ? draftStateLabels[currentDraft.state]
                : '无本地草稿'
              : '等待阶段 7 准入'}
          </strong>
        </div>
        <p>
          {workspaceMode
            ? '本页面只操作当前项目内视频草稿；不会自动上传、分析、生成或提交任务。'
            : '基础编辑只保留冻结入口；阶段 6 不创建编辑草稿、时间线或导出任务。'}
        </p>
      </Card>

      <div className="uc-image-workbench__workspace">
        <Card className="uc-image-workbench__panel">
          <PanelHeading
            description={
              workspaceMode
                ? '素材、上下文和镜头只接受后续受控端口提供的事实。'
                : '阶段 7 技术架构批准前不建立编辑草稿。'
            }
            number="1"
            title={workspaceMode ? '输入与上下文' : '编辑入口边界'}
          />
          {workspaceMode ? (
            loading ? (
              <EmptyState
                busy
                description="正在读取当前项目和本地视频草稿。"
                icon="读"
                role="status"
                title="正在读取视频工作区"
              />
            ) : !session ? (
              <EmptyState
                description="请先前往“项目”页面新建或打开项目，再创建视频草稿。"
                icon="项"
                readOnly
                title="需要先打开项目"
              />
            ) : !currentDraft ? (
              <EmptyState
                action={
                  <Button disabled={busy} onClick={() => void createDraft()}>
                    创建本地草稿
                  </Button>
                }
                description={mode.emptyDescription}
                icon={mode.icon}
                title={mode.emptyTitle}
              />
            ) : (
              <div className="uc-image-workbench__draft">
                <div className="uc-image-workbench__draft-status">
                  <StatusPill
                    tone={currentDraft.state === 'saved' ? 'success' : 'info'}
                  >
                    {draftStateLabels[currentDraft.state]}
                  </StatusPill>
                  <span>
                    {currentDraft.origin.kind === 'derived'
                      ? '派生草稿'
                      : '新建草稿'}
                  </span>
                </div>
                <EmptyState
                  description="模式输入将在对应页面任务中接入；当前草稿不读取未选择的素材或上下文。"
                  icon={mode.icon}
                  readOnly
                  title="本地视频草稿已就绪"
                />
              </div>
            )
          ) : (
            <EmptyState
              description="阶段 6 不实现时间线、媒体引擎、代理预览、编辑命令或导出。"
              icon="编"
              readOnly
              title="基础编辑将在阶段 7 实现"
            />
          )}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas">
          <PanelHeading
            description="只展示经过主进程授权和本地校验的真实媒体。"
            number="2"
            title={workspaceMode ? '预览与结果' : '时间线与预览'}
          />
          <EmptyState
            description={
              workspaceMode
                ? currentDraft
                  ? 'B2 受控素材预览和 B4 正式作品尚未接入；不会显示示例视频或伪造进度。'
                  : '创建项目内本地草稿后，这里将承载素材预览与真实结果状态。'
                : '阶段 7 未接入；这里不会显示可操作的假时间线或示例剪辑结果。'
            }
            icon={workspaceMode ? '视' : '线'}
            readOnly
            title={
              workspaceMode
                ? currentDraft
                  ? '受控预览与结果尚未接入'
                  : '预览区暂无内容'
                : '编辑器不可用'
            }
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <PanelHeading
            description="只展示当前可以确认的动态事实与阻断原因。"
            number="3"
            title={workspaceMode ? '服务与动态能力' : '阶段 7 准入'}
          />
          {workspaceMode ? (
            <>
              <dl className="uc-image-workbench__capability-list">
                <CapabilityFact
                  label="已启用视频路由"
                  value={
                    videoRouteModelCount === undefined
                      ? '状态未知'
                      : videoRouteModelCount === 0
                        ? '未发现'
                        : `${videoRouteModelCount} 个`
                  }
                />
                <CapabilityFact label="视频生成能力" value="未知，等待 B3 预检" />
                <CapabilityFact label="动态参数与素材限制" value="尚未提供" />
                <CapabilityFact label="素材异常状态" value="等待 B2 受控媒体端口" />
                <CapabilityFact label="预检状态" value={preflightLabel} />
                <CapabilityFact label="在线适配器" value="不可用" />
                <CapabilityFact label="费用与外发范围" value="未知" />
              </dl>
              <Button disabled>能力预检未接入，无法提交</Button>
            </>
          ) : (
            <EmptyState
              description="需要先批准编辑草稿 Schema、媒体引擎接口、预览与导出分层、恢复和跨平台测试方案。"
              icon="锁"
              readOnly
              title="尚未满足实现准入"
            />
          )}
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="warning">真实离线状态</StatusPill>
        <p>
          {workspaceMode
            ? '当前仅支持项目内视频草稿的创建、读取和保存。素材、预检、提交、进度和结果等待 B2/B3/B4 与真实适配器。'
            : '基础编辑将在阶段 7 独立开发；当前入口不会修改源视频，也不会自动执行编辑。'}
        </p>
      </Card>
      <p className="uc-image-workbench__message" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

function PanelHeading({
  description,
  number,
  title
}: {
  readonly description: string;
  readonly number: string;
  readonly title: string;
}) {
  return (
    <header className="uc-image-workbench__panel-heading">
      <span aria-hidden="true">{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

function CapabilityFact({
  label,
  value
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
