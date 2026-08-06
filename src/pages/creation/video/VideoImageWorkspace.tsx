import { useEffect, useMemo, useState } from 'react';
import { LuImagePlus, LuTrash2 } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { GenerationResultPreview } from '../../../components/GenerationResultPreview';
import { StatusPill } from '../../../components/StatusPill';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceMaterialAssetDto,
  VideoWorkspaceMaterialPreviewDto,
  VideoWorkspaceMaterialSelectionDto
} from '../../../shared/video-workspace-ipc';
import { WorkspaceContextSelector } from '../WorkspaceContextSelector';
import { persistVideoWorkspaceDraft } from './persistVideoWorkspaceDraft';
import { VideoFeatureSubmissionPanel } from './VideoFeatureSubmissionPanel';

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
  readonly onDraftChange: (draft: ImageVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: ImageVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

export function VideoImageWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onMessage
}: VideoImageWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [material, setMaterial] = useState<VideoWorkspaceMaterialAssetDto>();
  const [preview, setPreview] = useState<VideoWorkspaceMaterialPreviewDto>();
  const [busy, setBusy] = useState(false);
  const [resultWorkId, setResultWorkId] = useState<string>();
  const [resultUrls, setResultUrls] = useState<readonly string[]>([]);
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
  const blockedReason = draft.featureSelection?.productFeature !== 'image_to_video'
    ? '当前草稿没有固定为图生视频，请重新保存草稿。'
    : draft.imageToVideo.materials
      ? '此旧草稿仍含动态素材槽位，请先明确迁移或移除。'
      : !draft.imageToVideo.source || draft.imageToVideo.source.mediaKind !== 'image'
        ? '图生视频必须选择恰好一张受控图片。'
        : unsupportedContexts.length > 0
          ? '草稿含有未固定 revision 或不受支持的旧上下文，请先清理。'
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
      if (materialResult.ok) setMaterial(materialResult.value);
      if (previewResult.ok) setPreview(previewResult.value);
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

  function changePrompt(field: 'originalInput' | 'finalPrompt', value: string) {
    const prompt = field === 'originalInput' && draft.prompt.systemSupplements.length === 0
      ? { ...draft.prompt, originalInput: value, finalPrompt: value }
      : { ...draft.prompt, [field]: value };
    changeDraft({ ...draft, prompt });
  }

  async function ensureSavedDraft(): Promise<ImageVideoDraftDto | undefined> {
    if (!videoWorkspaces) return undefined;
    if (!dirty && draft.state === 'saved') return draft;
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
      setPreview(undefined);
      onMessage('图片已完成本地校验并登记到草稿。');
    } catch {
      onMessage('选择本地图片失败，请重试。');
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
      <div className="uc-image-workbench__workspace uc-video-image__workspace">
        <Card className="uc-image-workbench__panel uc-video-image__source">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>唯一图片与项目上下文</h2>
              <p>图生视频只接收一张已完成本地校验的图片，可显式选择固定上下文。</p>
            </div>
          </header>
          <section className="uc-image-quick__reference">
            <div>
              <strong>图片输入</strong>
              <span>
                {material
                  ? `${material.name} · ${material.width} × ${material.height}`
                  : draft.imageToVideo.source
                    ? '图片记录待读取'
                    : '尚未选择图片'}
              </span>
            </div>
            <div className="uc-image-quick__result-actions">
              <Button
                disabled={!videoWorkspaces || busy}
                onClick={() => void selectImage()}
                variant="secondary"
              >
                <LuImagePlus aria-hidden="true" />
                {draft.imageToVideo.source ? '更换图片' : '选择图片'}
              </Button>
              <Button
                disabled={!draft.imageToVideo.source || busy}
                onClick={() => void clearImage()}
                title="清除图片"
                variant="ghost"
              >
                <LuTrash2 aria-hidden="true" />
              </Button>
            </div>
          </section>
          {preview?.mediaKind === 'image' ? (
            <div className="uc-image-quick__preview">
              <img alt={`图生视频输入：${material?.name ?? '本地图片'}`} src={preview.url} />
            </div>
          ) : null}
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
          <WorkspaceContextSelector
            disabled={false}
            onChange={(contextReferences) => changeDraft({
              ...draft,
              contextReferences
            })}
            onMessage={onMessage}
            projectContextsOnly
            references={draft.contextReferences}
          />
          {unsupportedContexts.length > 0 ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>发现旧上下文</strong>
              <span>图生视频只接受固定 revision 的项目上下文。</span>
              <Button onClick={removeUnsupportedContexts} variant="secondary">
                <LuTrash2 aria-hidden="true" />
                明确移除旧上下文
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-video-image__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>运动描述与约束</h2>
              <p>最终提示词与保持、允许、禁止项共同保存在当前草稿。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>原始需求</span>
            <textarea
              maxLength={3000}
              onChange={(event) => changePrompt('originalInput', event.target.value)}
              rows={5}
              value={draft.prompt.originalInput}
            />
          </label>
          <label className="uc-image-quick__field">
            <span>最终提示词</span>
            <textarea
              maxLength={5000}
              onChange={(event) => changePrompt('finalPrompt', event.target.value)}
              rows={7}
              value={draft.prompt.finalPrompt}
            />
          </label>
          <div className="uc-image-quick__parameters">
            <TextField
              label="主体动作"
              onChange={(subjectAction) => changeDraft({
                ...draft,
                imageToVideo: { ...draft.imageToVideo, subjectAction }
              })}
              value={draft.imageToVideo.subjectAction}
            />
            <TextField
              label="镜头运动"
              onChange={(cameraMovement) => changeDraft({
                ...draft,
                imageToVideo: { ...draft.imageToVideo, cameraMovement }
              })}
              value={draft.imageToVideo.cameraMovement}
            />
            <TextField
              label="节奏"
              onChange={(pace) => changeDraft({
                ...draft,
                imageToVideo: { ...draft.imageToVideo, pace }
              })}
              value={draft.imageToVideo.pace}
            />
            <TextField
              label="景深"
              onChange={(depthOfField) => changeDraft({
                ...draft,
                imageToVideo: { ...draft.imageToVideo, depthOfField }
              })}
              value={draft.imageToVideo.depthOfField}
            />
          </div>
          <ListField
            label="必须保持"
            onChange={(mustKeep) => changeDraft({
              ...draft,
              imageToVideo: { ...draft.imageToVideo, mustKeep }
            })}
            value={draft.imageToVideo.mustKeep}
          />
          <ListField
            label="允许变化"
            onChange={(allowedChanges) => changeDraft({
              ...draft,
              imageToVideo: { ...draft.imageToVideo, allowedChanges }
            })}
            value={draft.imageToVideo.allowedChanges}
          />
          <ListField
            label="禁止变化"
            onChange={(prohibited) => changeDraft({
              ...draft,
              imageToVideo: { ...draft.imageToVideo, prohibited }
            })}
            value={draft.imageToVideo.prohibited}
          />
          <GenerationResultPreview
            mediaKind="video"
            remoteUrls={resultUrls}
            workId={resultWorkId}
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-video-image__submit">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>模型、参数与提交流程</h2>
              <p>选择模型后由后台锁定 API 与参数合同；填写参数后准备并提交。</p>
            </div>
          </header>
          <VideoFeatureSubmissionPanel
            blockedReason={blockedReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={(next) => onDraftChange(next as ImageVideoDraftDto)}
            onDraftPersisted={(next) => onDraftPersisted(next as ImageVideoDraftDto)}
            onMessage={onMessage}
            onSubmissionComplete={(submission) => {
              setResultWorkId(submission.workId);
              setResultUrls(submission.resultVideoUrls ?? []);
            }}
            showProgressSteps
          />
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="info">调用记录</StatusPill>
        <p>
          快速/文生/图生视频共用同一提交与调用记录流程；图片、参数或上下文变化会使旧选择令牌失效。
        </p>
      </Card>
    </>
  );
}

function TextField({
  label,
  value,
  onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="uc-image-quick__field">
      <span>{label}</span>
      <input onChange={(event) => onChange(event.target.value)} type="text" value={value} />
    </label>
  );
}

function ListField({
  label,
  value,
  onChange
}: {
  readonly label: string;
  readonly value: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
}) {
  return (
    <label className="uc-image-quick__field">
      <span>{label}</span>
      <input
        onChange={(event) => onChange(
          event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
        )}
        placeholder="使用逗号分隔"
        type="text"
        value={value.join(', ')}
      />
    </label>
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
