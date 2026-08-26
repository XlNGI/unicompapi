import { useCallback, useEffect, useMemo, useState } from 'react';
import { LuPlus, LuRotateCcw, LuTrash2 } from 'react-icons/lu';
import { Input } from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { ControlledImageDropZone } from '../../../components/ControlledImageDropZone';
import { GenerationHistory } from '../../../components/GenerationHistory';
import type { SubmissionProgressPhase } from '../../../components/SubmissionProgressSteps';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceMaterialAssetDto,
  VideoWorkspaceMaterialPreviewDto,
  VideoWorkspaceMaterialSelectionDto
} from '../../../shared/video-workspace-ipc';
import { composeVideoPromptEnhancementInput } from '../../../shared/prompt-enhancement-input';
import { WorkspaceContextSelector } from '../WorkspaceContextSelector';
import { persistVideoWorkspaceDraft } from './persistVideoWorkspaceDraft';
import { VideoFeatureSubmissionPanel } from './VideoFeatureSubmissionPanel';
import { VideoPromptEnhancePanel } from './VideoPromptEnhancePanel';

const workspaceErrorMessages: Partial<Record<VideoWorkspaceIpcErrorCode, string>> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  draft_not_found: '当前视频草稿已不存在。',
  draft_conflict: '视频草稿已在其他操作中更新，请稍后重试。',
  material_target_not_found: '当前素材槽位已不存在，请刷新页面后重试。',
  material_target_mismatch: '当前素材目标与视频模式不匹配。',
  material_type_mismatch: '所选素材类型不符合当前槽位要求。',
  material_not_found: '已选素材记录不可用，请重新选择。',
  unsupported_image: '所选文件不是当前支持的图片。',
  unsupported_video: '所选文件不是当前支持的 MP4 或 MOV 视频。',
  media_unreadable: '所选素材无法读取或无法完成本地校验。',
  media_changed_during_selection: '所选素材在校验过程中发生变化，请重新选择。',
  preview_unavailable: '素材已丢失、变化或不可读，暂时无法预览。',
  workspace_storage_error: '本地视频草稿保存失败，请检查项目目录后重试。',
  invalid_request: '当前视频草稿数据无效，请刷新页面后重试。'
};

function describeWorkspaceError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  return workspaceErrorMessages[error.code as VideoWorkspaceIpcErrorCode] ?? error.message;
}

type ImageVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'image_to_video' }
>;

const imageSourceTarget = { kind: 'image_source' } as const;

interface VideoImageWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: ImageVideoDraftDto;
  readonly onClearUi?: () => void;
  readonly onDraftChange: (draft: ImageVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: ImageVideoDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onMessage: (message: string) => void;
}

export function VideoImageWorkspace({
  dirty,
  draft,
  onClearUi,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onMessage
}: VideoImageWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [material, setMaterial] = useState<VideoWorkspaceMaterialAssetDto>();
  const [preview, setPreview] = useState<VideoWorkspaceMaterialPreviewDto>();
  const [busy, setBusy] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [submissionProgress, setSubmissionProgress] = useState<{
    readonly phase: SubmissionProgressPhase;
    readonly failureMessage?: string;
  }>({ phase: 'idle' });
  const handleProgressChange = useCallback((
    phase: SubmissionProgressPhase,
    failureMessage?: string
  ) => {
    setSubmissionProgress({ phase, failureMessage });
  }, []);
  const generationInFlight = ['preparing', 'requesting', 'waiting'].includes(
    submissionProgress.phase
  );
  const legacySelections = useMemo(
    () => draft.imageToVideo.materials?.slots.flatMap(
      (slot) => slot.selection ? [slot.selection] : []
    ) ?? [],
    [draft.imageToVideo.materials]
  );
  const unsupportedContexts = draft.contextReferences.filter(
    (reference) =>
      reference.kind !== 'project_context' ||
      reference.contextRevision === undefined ||
      reference.includeInPrompt === undefined
  );
  const enhancementInput = composeVideoPromptEnhancementInput(draft);
  const enhancementContent = [...draft.prompt.systemSupplements]
    .reverse()
    .find((supplement) => supplement.source === 'enhancement')?.content;
  const enhancementSatisfied =
    !enhancementInput.required ||
    (Boolean(enhancementContent) &&
      draft.prompt.finalPrompt.trim() === enhancementContent?.trim());
  const blockedReason =
    draft.featureSelection != null &&
    draft.featureSelection.productFeature !== 'image_to_video'
      ? '当前草稿没有固定为图生视频，请重新保存草稿。'
      : draft.imageToVideo.materials
        ? '此旧草稿仍含动态素材槽位，请先明确迁移或移除。'
        : !draft.imageToVideo.source || draft.imageToVideo.source.mediaKind !== 'image'
          ? '图生视频必须选择恰好一张受控图片。'
          : unsupportedContexts.length > 0
          ? '草稿含有未固定版本或不受支持的旧上下文，请先清理。'
          : !enhancementSatisfied
            ? '已填写结构化提示词内容，请先完成提示词增强并确认最终提示词。'
          : undefined;

  useEffect(() => {
    let active = true;
    setMaterial(undefined);
    setPreview(undefined);
    if (!videoWorkspaces || !draft.imageToVideo.source) return;
    void Promise.all([
      videoWorkspaces.getMaterial(draft.draftId, imageSourceTarget),
      videoWorkspaces.createMaterialPreview(draft.draftId, imageSourceTarget)
    ]).then(([materialResult, previewResult]) => {
      if (!active) return;
      if (materialResult.ok) {
        setMaterial(materialResult.value);
      } else {
        onMessage(describeWorkspaceError(materialResult.error));
      }
      if (previewResult.ok) {
        setPreview(previewResult.value);
      } else {
        setPreview(undefined);
        onMessage(describeWorkspaceError(previewResult.error));
      }
    }).catch(() => {
      if (active) onMessage('项目图片读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [
    draft.draftId,
    draft.imageToVideo.source?.assetId,
    onMessage,
    videoWorkspaces
  ]);

  function changeDraft(next: ImageVideoDraftDto) {
    onDraftChange({
      ...next,
      state: 'editing',
      generation: emptyGeneration()
    });
  }

  // Heal drafts that lost featureSelection so submit candidates can load.
  useEffect(() => {
    if (draft.featureSelection != null) return;
    changeDraft({
      ...draft,
      featureSelection: {
        productFeature: 'image_to_video',
        parameterValues: {}
      }
    });
    // Intentionally only depends on absence of featureSelection.
  }, [draft.draftId, draft.featureSelection]);

  function changePrompt(field: 'originalInput' | 'finalPrompt', value: string) {
    const prompt = field === 'originalInput' && draft.prompt.systemSupplements.length === 0
      ? { ...draft.prompt, originalInput: value, finalPrompt: value }
      : { ...draft.prompt, [field]: value };
    changeDraft({ ...draft, prompt });
  }

  async function ensureSavedDraft(): Promise<ImageVideoDraftDto | undefined> {
    if (!videoWorkspaces) return undefined;
    if (!dirty && draft.state === 'saved') return draft;
    if (onFlushDraft) {
      if (!(await onFlushDraft())) return undefined;
      const refreshed = await videoWorkspaces.get(draft.draftId);
      if (!refreshed.ok || !refreshed.value) {
        onMessage('无法读取刚刚保存的视频草稿，请重试。');
        return undefined;
      }
      return refreshed.value as ImageVideoDraftDto;
    }
    const result = await persistVideoWorkspaceDraft(
      videoWorkspaces,
      draft,
      'saved'
    );
    if (!result.ok) {
      onMessage(describeWorkspaceError(result.error));
      return undefined;
    }
    onDraftPersisted(result.value as ImageVideoDraftDto);
    return result.value as ImageVideoDraftDto;
  }

  async function selectImage() {
    if (!videoWorkspaces || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await videoWorkspaces.selectMaterial(
        saved.draftId,
        imageSourceTarget,
        'image'
      );
      if (!result.ok) {
        onMessage(describeWorkspaceError(result.error));
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      onDraftPersisted(result.value.draft as ImageVideoDraftDto);
      setMaterial(result.value.material);
      const previewResult = await videoWorkspaces.createMaterialPreview(
        result.value.draft.draftId,
        imageSourceTarget
      );
      if (previewResult.ok) {
        setPreview(previewResult.value);
      } else {
        setPreview(undefined);
        onMessage(describeWorkspaceError(previewResult.error));
        return;
      }
      onMessage('图片已完成本地校验并登记到草稿。');
    } catch {
      onMessage('选择本地图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function importImage(file: File, dropToken?: string) {
    if (!videoWorkspaces || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await videoWorkspaces.importMaterial(
        saved.draftId,
        imageSourceTarget,
        'image',
        dropToken ?? file
      );
      if (!result.ok) {
        onMessage(describeWorkspaceError(result.error));
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      onDraftPersisted(result.value.draft as ImageVideoDraftDto);
      setMaterial(result.value.material);
      const previewResult = await videoWorkspaces.createMaterialPreview(
        result.value.draft.draftId,
        imageSourceTarget
      );
      if (!previewResult.ok) {
        setPreview(undefined);
        onMessage(describeWorkspaceError(previewResult.error));
        return;
      }
      setPreview(previewResult.value);
      onMessage('图片已完成本地校验并登记到草稿。');
    } catch {
      onMessage('拖入图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearImage() {
    if (!videoWorkspaces || busy || !draft.imageToVideo.source) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await videoWorkspaces.clearMaterial(
        saved.draftId,
        imageSourceTarget
      );
      if (!result.ok) {
        onMessage(describeWorkspaceError(result.error));
        return;
      }
      onDraftPersisted(result.value as ImageVideoDraftDto);
      setMaterial(undefined);
      setPreview(undefined);
      onMessage('当前图片已从草稿解除选择；原始文件未删除。');
    } catch {
      onMessage('清除图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function migrateLegacyMaterials() {
    const candidates = [
      ...(draft.imageToVideo.source ? [draft.imageToVideo.source] : []),
      ...legacySelections
    ];
    const unique = uniqueSelections(candidates);
    const source = unique.length === 1 && unique[0].mediaKind === 'image'
      ? unique[0]
      : undefined;
    changeDraft({
      ...draft,
      featureSelection: {
        productFeature: 'image_to_video',
        parameterValues: {}
      },
      imageToVideo: {
        ...draft.imageToVideo,
        source,
        materials: undefined
      }
    });
    onMessage(source
      ? '旧素材已明确迁移为唯一图片输入；自动保存后可重新选择服务。'
      : '旧素材槽位已明确移除；请重新选择一张图片。');
  }

  function removeUnsupportedContexts() {
    changeDraft({
      ...draft,
      contextReferences: draft.contextReferences.filter(
        (reference) =>
          reference.kind === 'project_context' &&
          reference.contextRevision !== undefined &&
          reference.includeInPrompt !== undefined
      )
    });
    onMessage('不受支持或未固定版本的旧上下文已移除；自动保存后可重新选择服务。');
  }

  return (
    <>
      <div className="uc-image-workbench__workspace uc-video-image__workspace uc-generation-two-pane">
        <section aria-label="提交前准备区域" className="uc-generation-two-pane__controls uc-generation-two-pane__preparation">
          <header className="uc-image-professional__pane-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>第一步 · 提交前准备</h2>
              <p>整理图片、创作要求、提示词、服务与参数后再生成。</p>
            </div>
          </header>
          <div className="uc-generation-two-pane__preparation-scroll uc-scrollbar">
          <div className="uc-generation-two-pane__preparation-flow">
        <Card className="uc-image-workbench__panel uc-video-image__source">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>创作输入</h2>
              <p>填写创作需求，并选择恰好一张已完成本地校验的图片。</p>
            </div>
          </header>
          <div className="uc-image-quick__field">
            <span>原始创作需求 <span className="uc-dynamic-parameters__required">必填</span></span>
            <div className="uc-image-professional__prompt-input has-reference">
              <Input
                aria-label="原始创作需求"
                as="textarea"
                className="uc-image-professional__prompt-textarea"
                maxLength={3000}
                onChange={(value) => changePrompt('originalInput', value)}
                placeholder="描述画面变化和期望效果"
                rows={8}
                value={draft.prompt.originalInput}
              />
              <ControlledImageDropZone
                disabled={!videoWorkspaces || busy}
                hasImage={Boolean(draft.imageToVideo.source)}
                onDropFile={(file, dropToken) => void importImage(file, dropToken)}
                onReject={onMessage}
              >
                <span className="uc-dynamic-parameters__required">首帧图片必填</span>
                <section
                  className={`uc-image-professional__reference${material ? ' has-image' : ' is-empty'}`}
                >
                  {preview?.mediaKind === 'image' ? (
                    <figure className="uc-image-professional__preview">
                      <div className="uc-image-professional__preview-media">
                        <img
                          alt={`图生视频输入：${material?.name ?? '本地图片'}`}
                          src={preview.url}
                        />
                        {material ? (
                          <span className="uc-image-professional__preview-meta">
                            {`${material.name} · ${material.width} × ${material.height}`}
                          </span>
                        ) : null}
                        <div className="uc-image-professional__preview-overlay">
                          <Button
                            aria-label="删除图片"
                            className="uc-image-professional__preview-delete"
                            disabled={busy}
                            onClick={() => void clearImage()}
                            variant="secondary"
                          >
                            <LuTrash2 aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </figure>
                  ) : (
                    <div className="uc-image-professional__placeholder">
                      <Button
                        aria-label="添加图片"
                        className="uc-image-professional__placeholder-button"
                        disabled={!videoWorkspaces || busy}
                        onClick={() => void selectImage()}
                        title="添加图片"
                        variant="secondary"
                      >
                        <LuPlus aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </section>
              </ControlledImageDropZone>
            </div>
            <small>{draft.prompt.originalInput.length} / 3000</small>
          </div>
          <div className="uc-image-professional__prompt-tools">
            <WorkspaceContextSelector
              compact
              disabled={busy}
              onChange={(contextReferences) => changeDraft({
                ...draft,
                contextReferences
              })}
              onMessage={onMessage}
              projectContextsOnly
              references={draft.contextReferences}
            />
            <VideoPromptEnhancePanel
              compact
              dirty={dirty}
              draft={draft}
              onDraftPersisted={(next) => onDraftPersisted(next as ImageVideoDraftDto)}
              onFlushDraft={onFlushDraft}
              onMessage={onMessage}
            />
          </div>
          {draft.imageToVideo.materials ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>发现旧动态素材槽位</strong>
              <span>
                {legacySelections.length === 1 && legacySelections[0].mediaKind === 'image'
                  ? '可以把唯一图片显式迁移为图生视频输入。'
                  : '不能无损迁移为单图输入；继续会明确移除旧槽位，请随后重新选图。'}
              </span>
              <Button onClick={migrateLegacyMaterials} variant="secondary">
                明确迁移旧素材
              </Button>
            </div>
          ) : null}
          {unsupportedContexts.length > 0 ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>发现旧上下文</strong>
              <span>图生视频只接受固定版本的项目上下文。</span>
              <Button onClick={removeUnsupportedContexts} variant="secondary">
                <LuTrash2 aria-hidden="true" />
                明确移除旧上下文
              </Button>
            </div>
          ) : null}
        </Card>

        {enhancementContent ? (
        <Card className="uc-image-workbench__panel uc-video-image__prompt">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>最终提示词</h2>
              <p>增强结果自动写入最终提示词；最终提示词是本次外发的唯一文本事实。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>最终提交提示词 <span className="uc-dynamic-parameters__required">必填</span></span>
            <Input
              as="textarea"
              maxLength={5000}
              onChange={(value) => changePrompt('finalPrompt', value)}
              rows={7}
              value={draft.prompt.finalPrompt}
            />
            <small>{draft.prompt.finalPrompt.length} / 5000</small>
          </label>
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={draft.prompt.finalPrompt === draft.prompt.originalInput}
              onClick={() => changePrompt('finalPrompt', draft.prompt.originalInput)}
              variant="secondary"
            >
              <LuRotateCcw aria-hidden="true" />
              恢复原始输入
            </Button>
          </div>
        </Card>
        ) : null}

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-video-image__submit">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">{enhancementContent ? '3' : '2'}</span>
            <div>
              <h2>模型、参数与提交流程</h2>
              <p>选择模型后由后台锁定接口与参数配置；填写参数后准备并提交。</p>
            </div>
          </header>
          <VideoFeatureSubmissionPanel
            actionHost={actionHost}
            blockedReason={blockedReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={(next) => onDraftChange(next as ImageVideoDraftDto)}
            onDraftPersisted={(next) => onDraftPersisted(next as ImageVideoDraftDto)}
            onFlushDraft={onFlushDraft}
            onMessage={onMessage}
            onProgressChange={handleProgressChange}
            onSubmissionComplete={(submission) => {
              setHistoryRefreshKey((key) => key + 1);
              if (submission.status === 'completed') {
                onClearUi?.();
              }
            }}
            showProgressSteps
          />
        </Card>
          </div>
          </div>
          <footer className="uc-image-professional__submit-bar">
            <span>
              {generationInFlight
                ? '请求处理中，请在右侧查看进度'
                : dirty || draft.state !== 'saved'
                  ? '正在保存当前配置'
                  : '当前配置已保存'}
            </span>
            <div className="uc-image-professional__submit-action" ref={setActionHost} />
          </footer>
        </section>

        <section aria-label="生成过程与作品区域" className="uc-generation-two-pane__result uc-generation-two-pane__output">
          <header className="uc-image-professional__pane-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>第二步 · 生成过程与作品</h2>
              <p>提交状态与通过本地校验的作品会保留在这里。</p>
            </div>
          </header>
          <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-video-image__canvas">
            <GenerationHistory
              draftId={draft.draftId}
              key={draft.draftId}
              mediaKind="video"
              projectId={draft.projectId}
              refreshKey={historyRefreshKey}
              submissionProgress={submissionProgress}
            />
          </Card>
        </section>
      </div>

    </>
  );
}

function uniqueSelections(
  selections: readonly VideoWorkspaceMaterialSelectionDto[]
): readonly VideoWorkspaceMaterialSelectionDto[] {
  return [...new Map(selections.map((selection) => [selection.assetId, selection])).values()];
}

function emptyGeneration(): ImageVideoDraftDto['generation'] {
  return {
    enhancement: { state: 'not_created', staleReasons: [] },
    preflight: { state: 'not_created', staleReasons: [] }
  };
}
