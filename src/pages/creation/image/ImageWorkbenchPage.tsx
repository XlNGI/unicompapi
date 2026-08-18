import { useEffect, useRef, useState } from 'react';
import {
  LuFilePlus2,
  LuImagePlus,
  LuSave,
  LuShieldCheck
} from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceIpcErrorCode,
  ImageWorkspaceDtoMode
} from '../../../shared/image-workspace-ipc';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import type { StorageProjectSessionDto } from '../../../shared/storage-ipc';
import '../../../styles/pages.css';
import type { ImageCreationMode } from '../creationModes';
import { ImageEditingWorkspace } from './ImageEditingWorkspace';
import { ImageProfessionalWorkspace } from './ImageProfessionalWorkspace';
import { ImageQuickWorkspace } from './ImageQuickWorkspace';
import { ImageToPromptWorkspace } from './ImageToPromptWorkspace';
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

const modePresentation: Record<
  ImageWorkspaceDtoMode,
  { readonly number: string; readonly badge: string }
> = {
  quick_image: { number: '01', badge: '简约模式' },
  professional_image: { number: '02', badge: '专业模式' },
  image_understanding: { number: '03', badge: '理解图片内容' },
  image_editing: { number: '04', badge: '专业模式' },
  image_to_prompt: { number: '05', badge: '专业模式' }
};

interface ImageWorkbenchPageProps {
  mode: ImageCreationMode;
  preferredDraftId?: string;
  onNavigateToProfessional?: () => void;
  onVideoDraftCreated?: (draftId: string) => void;
  onNavigateToImageMode?: (
    mode: ImageWorkspaceDtoMode
  ) => void;
}

export function ImageWorkbenchPage({
  mode,
  preferredDraftId,
  onNavigateToProfessional,
  onVideoDraftCreated,
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
  const [autoSaveRevision, setAutoSaveRevision] = useState(0);
  const [autoSaving, setAutoSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedDraftId, setSelectedDraftId] = useState(preferredDraftId);
  const currentDraft =
    drafts.find((draft) => draft.draftId === selectedDraftId) ??
    drafts[drafts.length - 1];
  const isQuickImage = mode.workspaceMode === 'quick_image';
  const isProfessionalImage = mode.workspaceMode === 'professional_image';
  const isGenerationImage =
    isQuickImage ||
    isProfessionalImage;
  const presentation = modePresentation[mode.workspaceMode];
  const currentDraftRef = useRef(currentDraft);
  currentDraftRef.current = currentDraft;
  const autoSaveGeneration = useRef(0);
  const autoSaveRevisionRef = useRef(autoSaveRevision);
  autoSaveRevisionRef.current = autoSaveRevision;

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
        let modeDrafts = draftResult.value.filter(
          (draft) => draft.mode === mode.workspaceMode
        );
        if (mode.workspaceMode === 'quick_image' && modeDrafts.length === 0) {
          const created = await imageWorkspaces.create('quick_image');
          if (!active) return;
          if (created.ok) {
            modeDrafts = [created.value];
          }
        }
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
  }, [imageWorkspaces, mode.workspaceMode, preferredDraftId, providers, storage]);

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
      setSelectedDraftId(result.value.draftId);
      setDirty(false);
      setMessage('本地草稿已创建；没有上传图片，也没有创建任务。');
    } catch {
      setMessage('创建本地草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearUiAfterGeneration() {
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
      setSelectedDraftId(result.value.draftId);
      setDirty(false);
      setMessage('生成已完成；当前输入已清空，原草稿和结果已保留。');
    } catch {
      setMessage('生成后创建新草稿失败，请重试。');
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
    if (hasUnsavedChanges) {
      setAutoSaveRevision((revision) => revision + 1);
    }
  }

  useEffect(() => {
    if (!isProfessionalImage || !dirty || !imageWorkspaces || !session) return;
    const generation = ++autoSaveGeneration.current;
    const revision = autoSaveRevisionRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        const snapshot = currentDraftRef.current;
        if (!snapshot || snapshot.mode !== 'professional_image') return;
        setAutoSaving(true);
        try {
          const result = await imageWorkspaces.update({
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
            autoSaveRevisionRef.current !== revision ||
            (latest !== undefined && latest.draftId !== snapshot.draftId);
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
  }, [autoSaveRevision, dirty, imageWorkspaces, isProfessionalImage, session]);

  const projectStatus = loading
    ? '正在读取'
    : session
      ? '项目内本地草稿'
      : '未打开项目';

  return (
    <section
      className="uc-image-workbench"
      data-mode={mode.workspaceMode}
      aria-labelledby={`${mode.id}-title`}
    >
      <header className="uc-image-workbench__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id={`${mode.id}-title`}>
              {mode.workspaceMode === 'quick_image' ? null : (
                <span aria-hidden="true">{presentation.number}</span>
              )}{' '}
              {mode.label}
            </h1>
            <StatusPill tone="info">{presentation.badge}</StatusPill>
            {mode.workspaceMode === 'quick_image' ? null : (
              <StatusPill tone={session ? 'info' : 'warning'}>
                {projectStatus}
              </StatusPill>
            )}
          </div>
          <p className="uc-page-skeleton__description">{mode.description}</p>
        </div>
        <div className="uc-image-workbench__header-actions">
          {isQuickImage ? null : (
          <div className="uc-image-workbench__draft-actions">
          <Button
            disabled={!session || busy}
            onClick={() => void createDraft()}
            variant="secondary"
          >
            <LuFilePlus2 aria-hidden="true" />
            {busy ? '请稍候…' : '新建本地草稿'}
          </Button>
          {isProfessionalImage ? (
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
              variant="secondary"
            >
              <LuSave aria-hidden="true" />
              保存本地草稿
            </Button>
          )}
          </div>
          )}
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
        <p>
          {isProfessionalImage
            ? '专业生图会在后台自动保存草稿；请直接选功能、模型、参数并提交。不会自动外发或创建任务。'
            : '本页面只操作当前项目内草稿；不会自动上传、分析、生成或提交任务。'}
        </p>
      </Card>

      {currentDraft?.mode === 'quick_image' ? (
        <ImageQuickWorkspace
          dirty={dirty}
          draft={currentDraft}
          onClearUi={() => void clearUiAfterGeneration()}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
          onNavigateToProfessional={onNavigateToProfessional}
        />
      ) : currentDraft?.mode === 'professional_image' ? (
        <ImageProfessionalWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
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
      ) : currentDraft?.mode === 'image_editing' ? (
        <ImageEditingWorkspace
          dirty={dirty}
          draft={currentDraft}
          onDraftChange={(draft) => replaceCurrentDraft(draft, true)}
          onDraftPersisted={(draft) => replaceCurrentDraft(draft, false)}
          onMessage={setMessage}
          onNavigate={onNavigateToImageMode}
          onVideoDraftCreated={onVideoDraftCreated}
          registry={providerRegistry}
        />
      ) : currentDraft?.mode === 'image_to_prompt' ? (
        <ImageToPromptWorkspace
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
              <h2>{isQuickImage ? '文字需求' : '输入与上下文'}</h2>
              <p>
                {isQuickImage
                  ? '快速生图固定为纯文生图，不接收图片或上下文。'
                  : '单次工作区最多关联一张图片。'}
              </p>
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
                  <LuFilePlus2 aria-hidden="true" />
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
                action={
                  <Button disabled>
                    <LuImagePlus aria-hidden="true" />
                    选择一张图片
                  </Button>
                }
                description={
                  currentDraft.input
                    ? '已保存项目内图片引用；仅在本地文件校验通过时提供受控预览。'
                    : '当前草稿尚未关联图片；不会自动读取或上传文件。'
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
              <h2>{isQuickImage ? '结果预览' : '画布与预览'}</h2>
              <p>
                {isQuickImage
                  ? '只显示通过本地文件校验并登记的真实生成结果。'
                  : '只显示经过主进程授权的本地媒体。'}
              </p>
            </div>
          </header>
          <EmptyState
            description={
              isQuickImage
                ? '创建项目内草稿后，这里将显示通过本地校验并登记的真实生成结果。'
                : currentDraft
                ? '仅显示经过主进程授权并通过本地校验的真实图片；不可用时保留异常状态。'
                : '创建项目内本地草稿后，这里将承载输入图片、区域与结果状态。'
            }
            icon="画"
            readOnly
            title={
              isQuickImage
                ? '暂无生成结果'
                : currentDraft
                  ? '当前没有可用预览'
                  : '画布暂无内容'
            }
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
                  : '按当前模式能力事实检查'}
              </dd>
            </div>
            <div>
              <dt>动态参数</dt>
              <dd>
                {isGenerationImage
                  ? '由模型能力定义动态提供'
                  : '由当前模式能力事实提供'}
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
            <LuShieldCheck aria-hidden="true" />
            {isGenerationImage
              ? '创建并保存草稿后检查'
              : '保存草稿后检查真实提交条件'}
          </Button>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="warning">真实离线状态</StatusPill>
        <p>
          {isQuickImage
            ? '创建项目内草稿后，可填写文字需求并检查真实提交条件。'
            : isGenerationImage
              ? '创建项目内草稿后，可填写需求、选择单张图片并检查真实提交条件。'
            : '当前模式使用受控单图、能力预检和提交端口；没有真实适配器时会明确阻断，不会伪造任务或结果。'}
        </p>
      </Card>
        </>
      )}
      {message ? (
        <Card className="uc-image-workbench__message-card" role="status">
          <StatusPill tone="info">状态</StatusPill>
          <p className="uc-image-workbench__message" aria-live="polite">
            {message}
          </p>
        </Card>
      ) : (
        <p className="uc-image-workbench__message" aria-live="polite" />
      )}
    </section>
  );
}
