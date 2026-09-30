import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuPlus, LuRotateCcw, LuTrash2 } from 'react-icons/lu';
import { BufferedPromptInput } from '../../../components/BufferedPromptInput';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { ControlledImageDropZone } from '../../../components/ControlledImageDropZone';
import { GenerationHistory } from '../../../components/GenerationHistory';
import type { SubmissionProgressPhase } from '../../../components/SubmissionProgressSteps';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceMaterialPreviewDto,
  VideoWorkspaceMaterialSelectionDto
} from '../../../shared/video-workspace-ipc';
import { composeVideoPromptEnhancementInput } from '../../../shared/prompt-enhancement-input';
import { remapDeletedImageReferences, hasInvalidImageReference } from '../../../shared/image-reference-prompt';
import { CreationAdvancedSection } from '../CreationAdvancedSection';
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
  readonly onDraftChange: (draft: ImageVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: ImageVideoDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onMessage: (message: string) => void;
}

export function VideoImageWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onMessage
}: VideoImageWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const draftRef = useRef(draft);
  const onMessageRef = useRef(onMessage);
  draftRef.current = draft;
  onMessageRef.current = onMessage;
  const [previews, setPreviews] = useState<Readonly<Record<string, VideoWorkspaceMaterialPreviewDto>>>({});
  const [previewFailures, setPreviewFailures] = useState<Readonly<Record<string, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [expectedWorkId, setExpectedWorkId] = useState<string>();
  const [expectedTaskId, setExpectedTaskId] = useState<string>();
  const [submissionProgress, setSubmissionProgress] = useState<{
    readonly phase: SubmissionProgressPhase;
    readonly failureMessage?: string;
  }>({ phase: 'idle' });
  const userTookOverRef = useRef(false);
  const lastProgressPhaseRef = useRef<SubmissionProgressPhase>('idle');
  const handleProgressChange = useCallback((
    phase: SubmissionProgressPhase,
    failureMessage?: string
  ) => {
    if ((phase === 'preparing' && lastProgressPhaseRef.current !== 'preparing') ||
      (phase === 'requesting' && lastProgressPhaseRef.current !== 'preparing' && lastProgressPhaseRef.current !== 'requesting')) {
      userTookOverRef.current = false;
      setExpectedTaskId(undefined);
      setExpectedWorkId(undefined);
    }
    lastProgressPhaseRef.current = phase;
    setSubmissionProgress({ phase, failureMessage });
  }, []);

  useEffect(() => {
    setExpectedTaskId(undefined);
    setSubmissionProgress({ phase: 'idle' });
    setExpectedWorkId(undefined);
  }, [draft.draftId]);

  const legacySelections = useMemo(
    () => draft.imageToVideo.materials?.slots.flatMap(
      (slot) => slot.selection ? [slot.selection] : []
    ) ?? [],
    [draft.imageToVideo.materials]
  );
  const referenceImages = draft.imageToVideo.referenceImages ?? (
    draft.imageToVideo.source ? [draft.imageToVideo.source] : []
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
      : referenceImages.length === 0 || referenceImages.some((reference) => reference.mediaKind !== 'image')
          ? '图生视频至少需要一张受控参考图片。'
          : hasInvalidImageReference(draft.prompt.finalPrompt)
            ? '提示词包含已删除图片的失效引用，请修改提示词后再提交。'
          : unsupportedContexts.length > 0
          ? '草稿含有未固定版本或不受支持的旧上下文，请先清理。'
          : !enhancementSatisfied
            ? '已填写结构化提示词内容，请先完成提示词增强并确认最终提示词。'
          : undefined;

  useEffect(() => {
    let active = true;
    if (!videoWorkspaces || referenceImages.length === 0) {
      setPreviews({});
      return;
    }
    void Promise.all(
      referenceImages.map(async (reference, referenceIndex) => [
        reference.assetId,
        await videoWorkspaces.createMaterialPreview(draft.draftId, {
          kind: 'image_source',
          referenceIndex
        })
      ] as const)
    ).then((previewResults) => {
      if (!active) return;
      const ready = Object.fromEntries(
        previewResults.flatMap(([assetId, result]) => result.ok ? [[assetId, result.value]] : [])
      );
      const failed = Object.fromEntries(
        previewResults.flatMap(([assetId, result]) => result.ok ? [] : [[assetId, true]])
      );
      setPreviews((current) => ({ ...current, ...ready }));
      setPreviewFailures((current) => {
        const next = { ...current };
        for (const assetId of Object.keys(ready)) delete next[assetId];
        return { ...next, ...failed };
      });
      for (const [, result] of previewResults) {
        if (!result.ok) onMessageRef.current(describeWorkspaceError(result.error));
      }
    }).catch(() => {
      if (active) onMessageRef.current('项目图片读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [
    draft.draftId,
    referenceImages.map((reference) => reference.assetId).join(','),
    videoWorkspaces
  ]);

  function changeDraft(next: ImageVideoDraftDto) {
    draftRef.current = next;
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
    const draft = draftRef.current;
    const prompt = field === 'originalInput' && draft.prompt.systemSupplements.length === 0
      ? { ...draft.prompt, originalInput: value, finalPrompt: value }
      : { ...draft.prompt, [field]: value };
    changeDraft({ ...draft, prompt });
  }

  async function ensureSavedDraft(): Promise<ImageVideoDraftDto | undefined> {
    if (!videoWorkspaces) return undefined;
    if (onFlushDraft) {
      if (!(await onFlushDraft())) return undefined;
      const refreshed = await videoWorkspaces.get(draft.draftId);
      if (!refreshed.ok || !refreshed.value) {
        onMessage('无法读取刚刚保存的视频草稿，请重试。');
        return undefined;
      }
      return refreshed.value as ImageVideoDraftDto;
    }
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
      const selected = (result.value.draft as ImageVideoDraftDto).imageToVideo.source;
      if (!selected) return;
      if (referenceImages.some((reference) => reference.assetId === selected.assetId)) {
        await videoWorkspaces.clearMaterial(saved.draftId, imageSourceTarget);
        onMessage('这张图片已经在参考列表中。');
        return;
      }
      const next = {
        ...(result.value.draft as ImageVideoDraftDto),
        imageToVideo: {
          ...(result.value.draft as ImageVideoDraftDto).imageToVideo,
          source: undefined,
          referenceImages: [
            ...referenceImages,
            { ...selected, role: 'reference' }
          ]
        }
      } as ImageVideoDraftDto;
      const persisted = await videoWorkspaces.update(next);
      if (!persisted.ok) {
        onMessage('参考图片写入草稿失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as ImageVideoDraftDto);
      const previewResult = await videoWorkspaces.createMaterialPreview(
        result.value.draft.draftId,
        { kind: 'image_source', referenceIndex: referenceImages.length }
      );
      if (previewResult.ok) {
        setPreviewFailures((current) => {
          const nextFailures = { ...current };
          delete nextFailures[selected.assetId];
          return nextFailures;
        });
        setPreviews((current) => ({ ...current, [selected.assetId]: previewResult.value }));
      } else {
        setPreviewFailures((current) => ({ ...current, [selected.assetId]: true }));
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
      const selected = (result.value.draft as ImageVideoDraftDto).imageToVideo.source;
      if (!selected) return;
      if (referenceImages.some((reference) => reference.assetId === selected.assetId)) {
        await videoWorkspaces.clearMaterial(saved.draftId, imageSourceTarget);
        onMessage('这张图片已经在参考列表中。');
        return;
      }
      const next = {
        ...(result.value.draft as ImageVideoDraftDto),
        imageToVideo: {
          ...(result.value.draft as ImageVideoDraftDto).imageToVideo,
          source: undefined,
          referenceImages: [
            ...referenceImages,
            { ...selected, role: 'reference' }
          ]
        }
      } as ImageVideoDraftDto;
      const persisted = await videoWorkspaces.update(next);
      if (!persisted.ok) {
        onMessage('参考图片写入草稿失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as ImageVideoDraftDto);
      const previewResult = await videoWorkspaces.createMaterialPreview(
        result.value.draft.draftId,
        { kind: 'image_source', referenceIndex: referenceImages.length }
      );
      if (!previewResult.ok) {
        setPreviewFailures((current) => ({ ...current, [selected.assetId]: true }));
        onMessage(describeWorkspaceError(previewResult.error));
        return;
      }
      setPreviewFailures((current) => {
        const nextFailures = { ...current };
        delete nextFailures[selected.assetId];
        return nextFailures;
      });
      setPreviews((current) => ({ ...current, [selected.assetId]: previewResult.value }));
      onMessage('图片已完成本地校验并登记到草稿。');
    } catch {
      onMessage('拖入图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function useWorkAsReference(workId: string) {
    if (!videoWorkspaces || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await videoWorkspaces.useWorkAsMaterial(
        saved.draftId,
        imageSourceTarget,
        workId
      );
      if (!result.ok) {
        onMessage(result.error.code === 'material_not_found'
          ? '当前项目里没有这张图片作品，或它不是图片。'
          : describeWorkspaceError(result.error));
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      const selected = (result.value.draft as ImageVideoDraftDto).imageToVideo.source;
      if (!selected) return;
      if (referenceImages.some((reference) => reference.assetId === selected.assetId)) {
        await videoWorkspaces.clearMaterial(saved.draftId, imageSourceTarget);
        onMessage('这张图片已经在参考列表中。');
        return;
      }
      const next = {
        ...(result.value.draft as ImageVideoDraftDto),
        imageToVideo: {
          ...(result.value.draft as ImageVideoDraftDto).imageToVideo,
          source: undefined,
          referenceImages: [
            ...referenceImages,
            { ...selected, role: 'reference' as const }
          ]
        }
      } as ImageVideoDraftDto;
      const persisted = await videoWorkspaces.update(next);
      if (!persisted.ok) {
        onMessage('参考图片写入草稿失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as ImageVideoDraftDto);
      const previewResult = await videoWorkspaces.createMaterialPreview(
        persisted.value.draftId,
        { kind: 'image_source', referenceIndex: referenceImages.length }
      );
      if (!previewResult.ok) {
        setPreviewFailures((current) => ({ ...current, [selected.assetId]: true }));
        onMessage('图片已加入，但预览失败。请确认文件仍在项目中。');
        return;
      }
      setPreviewFailures((current) => {
        const nextFailures = { ...current };
        delete nextFailures[selected.assetId];
        return nextFailures;
      });
      setPreviews((current) => ({ ...current, [selected.assetId]: previewResult.value }));
      onMessage('项目作品已完成校验并加入参考图。');
    } catch {
      onMessage('拖入项目作品失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearImage(index?: number) {
    if (!videoWorkspaces || busy || referenceImages.length === 0) return;
    if (index !== undefined && (index < 0 || index >= referenceImages.length)) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const removedIndex = index ?? 0;
      const remaining = referenceImages.filter((_, itemIndex) => itemIndex !== removedIndex);
      const updated = {
        ...saved,
        imageToVideo: {
          ...saved.imageToVideo,
          source: undefined,
          referenceImages: remaining.length > 0 ? remaining : undefined
        },
        prompt: {
          ...saved.prompt,
          originalInput: remapDeletedImageReferences(saved.prompt.originalInput, removedIndex + 1),
          finalPrompt: remapDeletedImageReferences(saved.prompt.finalPrompt, removedIndex + 1)
        },
        state: 'editing' as const
      } as ImageVideoDraftDto;
      const result = await videoWorkspaces.update(updated);
      if (!result.ok) {
        onMessage(describeWorkspaceError(result.error));
        return;
      }
      onDraftPersisted(result.value as ImageVideoDraftDto);
      setPreviews({});
      onMessage('参考图片已移除并重新编号；原始文件未删除。');
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
      <div className="uc-image-workbench__workspace uc-video-image__workspace uc-generation-two-pane uc-creation-simple">
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
        <Card className="uc-image-workbench__panel uc-video-image__source uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>创作输入</h2>
              <p>填写创作需求，并选择一张或多张已完成本地校验的参考图片。</p>
            </div>
          </header>
          <div className="uc-image-quick__field">
            <div className="uc-image-professional__reference-field">
              <span>参考图片 <small>已添加 {referenceImages.length} 张</small></span>
              <ControlledImageDropZone
                disabled={!videoWorkspaces || busy}
                hasImage={referenceImages.length > 0}
                onDropFile={(file, dropToken) => void importImage(file, dropToken)}
                onDropWork={(workId) => void useWorkAsReference(workId)}
                onReject={onMessage}
              >
                {referenceImages.length === 0 ? (
                  <span className="uc-dynamic-parameters__required">至少一张参考图片</span>
                ) : null}
                <section
                  className={`uc-image-professional__reference${referenceImages.length > 0 ? ' has-image' : ' is-empty'}`}
                >
                  {referenceImages.length > 0 ? (
                    <div className="uc-image-professional__reference-strip">
                      {referenceImages.map((reference, index) => (
                        <div className="uc-image-professional__reference-item" key={reference.assetId}>
                          <div className="uc-image-professional__reference-thumbnail">
                            {previews[reference.assetId]?.mediaKind === 'image' ? (
                              <img alt={`图${index + 1}`} src={previews[reference.assetId].url} />
                            ) : (
                              <span className="uc-image-professional__reference-status">
                                {previewFailures[reference.assetId] ? '预览失败' : '读取中'}
                              </span>
                            )}
                            <Button
                              aria-label={`删除图${index + 1}`}
                              className="uc-image-professional__reference-delete"
                              disabled={busy}
                              onClick={() => void clearImage(index)}
                              size="xs"
                              style={{
                                width: 24,
                                minWidth: 24,
                                height: 24,
                                minHeight: 24,
                                padding: 0,
                                border: '1px solid var(--uc-color-border-default)',
                                borderRadius: 'var(--uc-radius-6)',
                                background: 'var(--uc-color-surface-panel)',
                                color: 'var(--uc-color-text-primary)',
                                boxShadow: '0 1px 3px rgb(0 0 0 / 24%)'
                              }}
                              title={`删除图${index + 1}`}
                              variant="secondary"
                            >
                              <LuTrash2 aria-hidden="true" />
                            </Button>
                          </div>
                          <span className="uc-image-professional__reference-label">图{index + 1}</span>
                        </div>
                      ))}
                      <Button
                        aria-label="继续添加图片"
                        className="uc-image-professional__reference-add"
                        disabled={!videoWorkspaces || busy}
                        onClick={() => void selectImage()}
                        title="继续添加图片"
                        variant="secondary"
                      >
                        <LuPlus aria-hidden="true" />
                      </Button>
                    </div>
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
            <span>原始创作需求 <span className="uc-dynamic-parameters__required">必填</span></span>
            <div className="uc-image-professional__prompt-input">
              <BufferedPromptInput
                key={`${draft.draftId}:originalInput`}
                aria-label="原始创作需求"
                as="textarea"
                className="uc-image-professional__prompt-textarea"
                maxLength={3000}
                onChange={(value) => changePrompt('originalInput', value)}
                placeholder="描述画面变化和期望效果"
                rows={8}
                value={draft.prompt.originalInput}
              />
            </div>
            <small>{draft.prompt.originalInput.length} / 3000</small>
          </div>
          <CreationAdvancedSection
            defaultOpen={Boolean(draft.imageToVideo.materials) || unsupportedContexts.length > 0}
            note={`${draft.contextReferences.length} 份上下文`}
            title="上下文与提示词增强"
          >
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
          </CreationAdvancedSection>
        </Card>

        {enhancementContent ? (
        <Card className="uc-image-workbench__panel uc-video-image__prompt uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>最终提示词</h2>
            </div>
          </header>
          <CreationAdvancedSection
            defaultOpen
            note="已增强"
            title="最终提示词"
          >
          <label className="uc-image-quick__field">
            <span>最终提交提示词 <span className="uc-dynamic-parameters__required">必填</span></span>
            <BufferedPromptInput
              key={`${draft.draftId}:finalPrompt`}
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
          </CreationAdvancedSection>
        </Card>
        ) : null}

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-video-image__submit uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">{enhancementContent ? '3' : '2'}</span>
            <div>
              <h2>模型、参数与提交流程</h2>
              <p>选择模型后由后台锁定接口与参数配置；填写参数后准备并提交。</p>
            </div>
          </header>
          <VideoFeatureSubmissionPanel
            blockedReason={blockedReason}
            className="uc-image-feature-panel--compact"
            collapseParameters
            dirty={dirty}
            draft={draft}
            onDraftChange={(next) => onDraftChange(next as ImageVideoDraftDto)}
            onDraftPersisted={(next) => onDraftPersisted(next as ImageVideoDraftDto)}
            onFlushDraft={onFlushDraft}
            onMessage={onMessage}
            onProgressChange={handleProgressChange}
            onSubmissionComplete={(submission) => {
              setExpectedTaskId(submission.taskId);
              if (!userTookOverRef.current) {
                setExpectedWorkId(
                  submission.status === 'completed' ? submission.workId : undefined
                );
              } else {
                setExpectedWorkId(undefined);
              }
              setHistoryRefreshKey((key) => key + 1);
            }}
            showProgressSteps
          />
        </Card>
          </div>
          </div>
        </section>

        <Card
          aria-label="生成过程与作品区域"
          className="uc-generation-two-pane__result uc-image-professional__after-pane"
        >
          <GenerationHistory
            draftId={draft.draftId}
            key={draft.projectId}
            mediaKind="video"
            workspaceMode="image_to_video"
            projectId={draft.projectId}
            refreshKey={historyRefreshKey}
            expectedWorkId={expectedWorkId}
            expectedTaskId={expectedTaskId}
            userTookOverRef={userTookOverRef}
            submissionProgress={submissionProgress}
          />
        </Card>
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
