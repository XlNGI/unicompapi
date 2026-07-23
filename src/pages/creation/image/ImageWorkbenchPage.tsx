import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceIpcErrorCode
} from '../../../shared/image-workspace-ipc';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import type { StorageProjectSessionDto } from '../../../shared/storage-ipc';
import '../../../styles/pages.css';
import type { ImageCreationMode } from '../creationModes';
import { ImageProfessionalWorkspace } from './ImageProfessionalWorkspace';
import { ImageQuickWorkspace } from './ImageQuickWorkspace';
import { ImageUnderstandingWorkspace } from './ImageUnderstandingWorkspace';

const workspaceErrorMessages: Record<ImageWorkspaceIpcErrorCode, string> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  invalid_request: '当前草稿数据无效，请刷新页面后重试。',
  draft_not_found: '草稿已不存在，请刷新页面后重试。',
  draft_conflict: '草稿已在其他位置更新，请刷新页面后重试。',
  input_not_found: '当前草稿没有可用的图片输入。',
  image_unreadable: '所选图片无法读取或未通过本地校验。',
  unsupported_image: '所选文件不是当前可安全读取的本地图片。',
  preview_unavailable: '图片已移动、变化或不可读取，暂时无法预览。',
  workspace_storage_error: '本地草稿保存失败，请检查项目目录后重试。'
};

const draftStateLabels: Record<ImageWorkspaceDraftDto['state'], string> = {
  editing: '编辑中',
  saved: '已保存',
  stale: '内容已过期',
  archived: '已归档'
};

interface ImageWorkbenchPageProps {
  mode: ImageCreationMode;
  onNavigateToProfessional?: () => void;
  onNavigateToImageMode?: (
    mode: 'professional_image' | 'image_editing' | 'image_to_prompt'
  ) => void;
}

export function ImageWorkbenchPage({
  mode,
  onNavigateToProfessional,
  onNavigateToImageMode
}: ImageWorkbenchPageProps) {
  const storage = window.unicomp?.storage;
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const providers = window.unicomp?.providers;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [drafts, setDrafts] = useState<readonly ImageWorkspaceDraftDto[]>([]);
  const [enabledModelCount, setEnabledModelCount] = useState<number>();
  const [providerRegistry, setProviderRegistry] =
    useState<ProviderRegistryDto>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const currentDraft = drafts[drafts.length - 1];
  const isGenerationImage =
    mode.workspaceMode === 'quick_image' ||
    mode.workspaceMode === 'professional_image';

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setMessage('');
      setSession(undefined);
      setDrafts([]);
      setEnabledModelCount(undefined);
      setProviderRegistry(undefined);
      setDirty(false);

      if (!storage || !imageWorkspaces) {
        setMessage('当前运行环境未连接桌面图片工作区。');
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

        const draftResult = await imageWorkspaces.list();
        if (!active) return;
        if (!draftResult.ok) {
          setMessage(workspaceErrorMessages[draftResult.error.code]);
          return;
        }
        setDrafts(
          draftResult.value.filter((draft) => draft.mode === mode.workspaceMode)
        );

        if (providers) {
          const registryResult = await providers
            .getRegistry()
            .catch(() => undefined);
          if (!active) return;
          if (registryResult?.ok) {
            setProviderRegistry(registryResult.value);
            setEnabledModelCount(
              registryResult.value.models.filter((model) => model.enabled).length
            );
          }
        }
      } catch {
        if (active) setMessage('读取本地图片工作区失败，请重试。');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [imageWorkspaces, mode.workspaceMode, providers, storage]);

  async function createDraft() {
    if (!imageWorkspaces || !session || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await imageWorkspaces.create(mode.workspaceMode);
      if (!result.ok) {
        setMessage(workspaceErrorMessages[result.error.code]);
        return;
      }
      setDrafts((items) => [...items, result.value]);
      setDirty(false);
      setMessage('本地草稿已创建；没有上传图片，也没有创建任务。');
    } catch {
      setMessage('创建本地草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!imageWorkspaces || !currentDraft || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await imageWorkspaces.update({
        ...currentDraft,
        state:
          (currentDraft.mode === 'image_understanding' &&
            currentDraft.understanding.analysisState === 'stale') ||
          (currentDraft.mode === 'image_to_prompt' &&
            currentDraft.imageToPrompt.analysisState === 'stale')
            ? 'stale'
            : 'saved'
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
      setMessage('草稿已保存到当前项目；没有创建或提交任务。');
    } catch {
      setMessage('保存本地草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function replaceCurrentDraft(
    draft: ImageWorkspaceDraftDto,
    hasUnsavedChanges: boolean
  ) {
    setDrafts((items) =>
      items.map((item) => (item.draftId === draft.draftId ? draft : item))
    );
    setDirty(hasUnsavedChanges);
  }

  const projectStatus = loading
    ? '正在读取'
    : session
      ? '项目内本地草稿'
      : '未打开项目';

  return (
    <section className="uc-image-workbench" aria-labelledby={`${mode.id}-title`}>
      <header className="uc-image-workbench__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id={`${mode.id}-title`}>
              {mode.label}
            </h1>
            <StatusPill tone={session ? 'info' : 'warning'}>
              {projectStatus}
            </StatusPill>
          </div>
          <p className="uc-page-skeleton__description">{mode.description}</p>
        </div>
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
        </div>
      </header>

      <Card className="uc-image-workbench__project-strip">
        <div className="uc-image-workbench__project-fact">
          <span>当前项目</span>
          <strong>{session?.projectName ?? '尚未打开项目'}</strong>
        </div>
        <div className="uc-image-workbench__project-fact">
          <span>当前模式草稿</span>
          <strong>{session ? `${drafts.length} 个` : '不可创建'}</strong>
        </div>
        <div className="uc-image-workbench__project-fact">
          <span>当前状态</span>
          <strong>
            {currentDraft ? draftStateLabels[currentDraft.state] : '无本地草稿'}
          </strong>
        </div>
        <p>本页面只操作当前项目内草稿；不会自动上传、分析、生成或提交任务。</p>
      </Card>

      {currentDraft?.mode === 'quick_image' ? (
        <ImageQuickWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
          onNavigateToProfessional={onNavigateToProfessional}
          registry={providerRegistry}
        />
      ) : currentDraft?.mode === 'professional_image' ? (
        <ImageProfessionalWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
          registry={providerRegistry}
        />
      ) : currentDraft?.mode === 'image_understanding' ? (
        <ImageUnderstandingWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
          onNavigate={onNavigateToImageMode}
        />
      ) : (
        <>
      <div className="uc-image-workbench__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>输入与上下文</h2>
              <p>单次工作区最多关联一张图片。</p>
            </div>
          </header>
          {loading ? (
            <EmptyState
              busy
              description="正在读取当前项目和本地草稿。"
              icon="读"
              role="status"
              title="正在读取图片工作区"
            />
          ) : !session ? (
            <EmptyState
              description="请先前往“项目”页面新建或打开项目，再创建图片草稿。"
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
                <StatusPill tone={currentDraft.state === 'saved' ? 'success' : 'info'}>
                  {draftStateLabels[currentDraft.state]}
                </StatusPill>
                <span>
                  {currentDraft.origin.kind === 'derived'
                    ? '派生草稿'
                    : '新建草稿'}
                </span>
              </div>
              <EmptyState
                action={<Button disabled>选择一张图片</Button>}
                description={
                  currentDraft.input
                    ? '已保存项目内图片引用；受控预览将在 B2 接入。'
                    : '本地单图选择与文件校验尚未接入；当前不会读取或上传图片。'
                }
                icon={currentDraft.input ? '图' : '＋'}
                readOnly
                title={
                  currentDraft.input
                    ? `已关联${currentDraft.input.role === 'source' ? '源图' : '参考图'}`
                    : '当前没有图片输入'
                }
              />
            </div>
          )}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>画布与预览</h2>
              <p>只显示经过主进程授权的本地媒体。</p>
            </div>
          </header>
          <EmptyState
            description={
              currentDraft
                ? 'B2 受控图片预览尚未接入；这里不会显示示例图或伪造结果。'
                : '创建项目内本地草稿后，这里将承载输入图片、区域与结果状态。'
            }
            icon="画"
            readOnly
            title={currentDraft ? '受控预览尚未接入' : '画布暂无内容'}
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>服务与能力</h2>
              <p>只展示当前可确认的动态事实。</p>
            </div>
          </header>
          <dl className="uc-image-workbench__capability-list">
            <div>
              <dt>已启用模型</dt>
              <dd>
                {enabledModelCount === undefined
                  ? '状态未知'
                  : enabledModelCount === 0
                    ? '未发现'
                    : `${enabledModelCount} 个`}
              </dd>
            </div>
            <div>
              <dt>图片能力</dt>
              <dd>
                {isGenerationImage
                  ? '待创建草稿后预检'
                  : '未知，等待 B3 预检'}
              </dd>
            </div>
            <div>
              <dt>动态参数</dt>
              <dd>
                {isGenerationImage
                  ? '由模型能力 Schema 动态提供'
                  : '尚未提供 Schema'}
              </dd>
            </div>
            <div>
              <dt>在线适配器</dt>
              <dd>{isGenerationImage ? '待预检' : '不可用'}</dd>
            </div>
            <div>
              <dt>费用与外发范围</dt>
              <dd>未知</dd>
            </div>
          </dl>
          <Button disabled>
            {isGenerationImage
              ? '创建并保存草稿后检查'
              : '能力预检未接入，无法提交'}
          </Button>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="warning">真实离线状态</StatusPill>
        <p>
          {isGenerationImage
            ? '创建项目内草稿后，可填写需求、选择单张参考图并检查真实提交条件。'
            : '当前仅支持项目内图片草稿的创建、读取和保存。选图、预览、模型预检与任务提交等待 B2/B3。'}
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
