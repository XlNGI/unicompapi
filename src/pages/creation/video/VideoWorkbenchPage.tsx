import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { StorageProjectSessionDto } from '../../../shared/storage-ipc';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode
} from '../../../shared/video-workspace-ipc';
import '../../../styles/pages.css';
import type { VideoCreationMode } from '../creationModes';
import { VideoQuickWorkspace } from './VideoQuickWorkspace';
import { VideoImageWorkspace } from './VideoImageWorkspace';
import { VideoTextWorkspace } from './VideoTextWorkspace';

const workspaceErrorMessages: Record<VideoWorkspaceIpcErrorCode, string> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  invalid_request: '当前视频草稿数据无效，请刷新页面后重试。',
  draft_not_found: '视频草稿已不存在，请刷新页面后重试。',
  draft_conflict: '视频草稿已在其他位置更新，请刷新页面后重试。',
  material_target_not_found: '当前素材槽位已不存在，请刷新页面后重试。',
  material_target_mismatch: '当前素材目标与视频模式不匹配。',
  material_type_mismatch: '所选素材类型不符合当前槽位要求。',
  material_not_found: '已选素材记录不可用，请重新选择。',
  unsupported_image: '所选文件不是当前支持的图片。',
  unsupported_video: '所选文件不是当前支持的 MP4 或 MOV 视频。',
  media_unreadable: '所选素材无法读取或无法完成本地校验。',
  media_changed_during_selection: '所选素材在校验过程中发生变化，请重新选择。',
  preview_unavailable: '素材已丢失、变化或不可读，暂时无法预览。',
  workspace_storage_error: '本地视频草稿保存失败，请检查项目目录后重试。'
};

const draftStateLabels: Record<VideoWorkspaceDraftDto['state'], string> = {
  editing: '编辑中',
  saved: '已保存',
  stale: '内容已过期',
  archived: '已归档'
};

interface VideoWorkbenchPageProps {
  readonly mode: VideoCreationMode;
  readonly onNavigateToTextToVideo?: () => void;
  readonly onNavigateToImageToVideo?: (draftId: string) => void;
  readonly preferredDraftId?: string;
}

export function VideoWorkbenchPage({
  mode,
  onNavigateToTextToVideo,
  onNavigateToImageToVideo,
  preferredDraftId
}: VideoWorkbenchPageProps) {
  const storage = window.unicomp?.storage;
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const workspaceMode =
    'workspaceMode' in mode ? mode.workspaceMode : undefined;
  const usesFlowAutosave =
    workspaceMode === 'text_to_video' || workspaceMode === 'image_to_video';
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [drafts, setDrafts] = useState<readonly VideoWorkspaceDraftDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedDraftId, setSelectedDraftId] = useState(preferredDraftId);
  const currentDraft =
    drafts.find((draft) => draft.draftId === selectedDraftId) ??
    drafts[drafts.length - 1];
  const currentDraftRef = useRef(currentDraft);
  currentDraftRef.current = currentDraft;
  const autoSaveGeneration = useRef(0);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setMessage('');
      setSession(undefined);
      setDrafts([]);
      setDirty(false);

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
          const modeDrafts = draftResult.value.filter(
            (draft) => draft.mode === workspaceMode
          );
          setDrafts(modeDrafts);
          setSelectedDraftId((current) =>
            preferredDraftId &&
            modeDrafts.some((draft) => draft.draftId === preferredDraftId)
              ? preferredDraftId
              : current &&
                  modeDrafts.some((draft) => draft.draftId === current)
                ? current
                : modeDrafts[modeDrafts.length - 1]?.draftId
          );
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
  }, [preferredDraftId, storage, videoWorkspaces, workspaceMode]);

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
      setSelectedDraftId(result.value.draftId);
      setDirty(false);
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
      setDirty(false);
      setMessage('视频草稿已保存到当前项目；没有创建或提交任务。');
    } catch {
      setMessage('保存本地视频草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function replaceCurrentDraft(
    draft: VideoWorkspaceDraftDto,
    hasUnsavedChanges: boolean
  ) {
    setDrafts((items) =>
      items.map((item) => (item.draftId === draft.draftId ? draft : item))
    );
    setDirty(hasUnsavedChanges);
  }

  useEffect(() => {
    if (!usesFlowAutosave || !dirty || !videoWorkspaces || !session) return;
    const generation = ++autoSaveGeneration.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        const snapshot = currentDraftRef.current;
        if (
          !snapshot ||
          (snapshot.mode !== 'text_to_video' && snapshot.mode !== 'image_to_video')
        ) {
          return;
        }
        setAutoSaving(true);
        try {
          const result = await videoWorkspaces.update({
            ...snapshot,
            state: 'saved'
          });
          if (generation !== autoSaveGeneration.current) return;
          if (!result.ok) {
            setMessage(workspaceErrorMessages[result.error.code]);
            return;
          }
          const latest = currentDraftRef.current;
          const superseded =
            latest !== undefined &&
            latest.draftId === snapshot.draftId &&
            latest !== snapshot;
          if (superseded) return;
          setDrafts((items) =>
            items.map((draft) =>
              draft.draftId === result.value.draftId ? result.value : draft
            )
          );
          setDirty(false);
        } catch {
          if (generation === autoSaveGeneration.current) {
            setMessage('自动保存草稿失败，请稍后重试。');
          }
        } finally {
          if (generation === autoSaveGeneration.current) {
            setAutoSaving(false);
          }
        }
      })();
    }, 400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [dirty, session, usesFlowAutosave, videoWorkspaces, currentDraft]);

  const projectStatus = loading
    ? '正在读取'
    : session
      ? workspaceMode
        ? '项目内本地草稿'
        : '阶段 7 未接入'
      : '未打开项目';
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
            {usesFlowAutosave ? (
              <StatusPill tone={autoSaving || dirty ? 'info' : 'success'}>
                {autoSaving || dirty ? '正在自动保存…' : '已自动保存'}
              </StatusPill>
            ) : (
              <Button
                disabled={
                  !currentDraft ||
                  (!dirty &&
                    (currentDraft.state === 'saved' ||
                      currentDraft.state === 'stale')) ||
                  currentDraft.state === 'archived' ||
                  busy
                }
                onClick={() => void saveDraft()}
              >
                保存本地草稿
              </Button>
            )}
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
          {usesFlowAutosave
            ? '文生/图生视频会在后台自动保存草稿；请直接选模型、填参数并提交。不会自动外发。'
            : workspaceMode
              ? '本页面只操作当前项目内视频草稿；不会自动上传、分析、生成或提交任务。'
              : '基础编辑只保留冻结入口；阶段 6 不创建编辑草稿、时间线或导出任务。'}
        </p>
      </Card>

      {currentDraft?.mode === 'quick_video' ? (
        <VideoQuickWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onMessage={setMessage}
          onNavigateToImageToVideo={onNavigateToImageToVideo}
          onNavigateToTextToVideo={onNavigateToTextToVideo}
        />
      ) : currentDraft?.mode === 'text_to_video' ? (
        <VideoTextWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
        />
      ) : currentDraft?.mode === 'image_to_video' ? (
        <VideoImageWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
        />
      ) : (
        <>
      <div className="uc-image-workbench__workspace">
        <Card className="uc-image-workbench__panel">
          <PanelHeading
            description={
              workspaceMode
                ? '素材、上下文和镜头只采用当前受控端口提供的真实事实。'
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
            ) : (
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
                ? '创建项目内本地草稿后，这里将承载素材预览与真实结果状态。'
                : '阶段 7 未接入；这里不会显示可操作的假时间线或示例剪辑结果。'
            }
            icon={workspaceMode ? '视' : '线'}
            readOnly
            title={
              workspaceMode
                ? '预览区暂无内容'
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
                  label="视频服务候选"
                  value="草稿自动保存后按功能读取"
                />
                <CapabilityFact
                  label="视频生成能力"
                  value="按当前功能与已保存草稿事实读取"
                />
                <CapabilityFact label="动态参数" value="由安全参数定义提供" />
                <CapabilityFact
                  label="素材边界"
                  value="快速与文生视频无素材；图生视频恰好一张图片"
                />
                <CapabilityFact label="运行授权" value="连接可用时按运行时策略判定" />
                <CapabilityFact label="费用与外发范围" value="未知" />
              </dl>
              <p className="uc-image-quick__hint">
                创建草稿后，页面会按功能读取匹配的安全候选；提交流程在页内展示。
              </p>
            </>
          ) : (
            <EmptyState
              description="需要先批准编辑草稿定义、媒体引擎接口、预览与导出分层、恢复和跨平台测试方案。"
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
            ? '当前使用安全候选、动态参数、受控素材和确认提交端口；运行授权关闭时不会发出请求，也不会伪造进度或结果。'
            : '基础编辑将在阶段 7 独立开发；当前入口不会修改源视频，也不会自动执行编辑。'}
        </p>
      </Card>
        </>
      )}
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
