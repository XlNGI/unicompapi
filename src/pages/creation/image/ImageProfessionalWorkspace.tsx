import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LuFileImage,
  LuPlus,
  LuRotateCcw,
  LuTrash2,
  LuType
} from 'react-icons/lu';
import { Input } from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { GenerationHistory } from '../../../components/GenerationHistory';
import { ControlledImageDropZone } from '../../../components/ControlledImageDropZone';
import { StatusPill } from '../../../components/StatusPill';
import type { SubmissionProgressPhase } from '../../../components/SubmissionProgressSteps';
import { composeImagePromptEnhancementInput } from '../../../shared/prompt-enhancement-input';
import { hasInvalidImageReference, remapDeletedImageReferences } from '../../../shared/image-reference-prompt';
import { CreationAdvancedSection } from '../CreationAdvancedSection';
import { WorkspaceContextSelector } from '../WorkspaceContextSelector';
import type { GenerationImageDraftDto } from './ImageGenerationControls';
import { ImageFeatureSubmissionPanel } from './ImageFeatureSubmissionPanel';
import { ImagePromptEnhancePanel } from './ImagePromptEnhancePanel';

interface ImageProfessionalWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted: (draft: GenerationImageDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onNavigateToProviders?: () => void;
  readonly onMessage: (message: string) => void;
  readonly onBlockingReasonChange?: (reason?: string) => void;
}

export function ImageProfessionalWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onNavigateToProviders,
  onMessage,
  onBlockingReasonChange
}: ImageProfessionalWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [previewUrls, setPreviewUrls] = useState<Readonly<Record<string, string>>>({});
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
    setHistoryRefreshKey(0);
    setExpectedTaskId(undefined);
    setExpectedWorkId(undefined);
    setSubmissionProgress({ phase: 'idle' });
  }, [draft.draftId]);
  const productFeature = draft.featureSelection?.productFeature === 'text_to_image' ||
    draft.featureSelection?.productFeature === 'reference_to_image'
    ? draft.featureSelection.productFeature
    : undefined;

  const unsupportedContexts = draft.contextReferences.filter(
    (reference) =>
      reference.kind !== 'project_context' ||
      reference.contextRevision === undefined ||
      reference.includeInPrompt === undefined
  );
  const enhancementInput = composeImagePromptEnhancementInput(draft);
  const enhancementContent = [...draft.prompt.systemSupplements]
    .reverse()
    .find((supplement) => supplement.source === 'enhancement')?.content;
  const enhancementSatisfied =
    !enhancementInput.required ||
    (Boolean(enhancementContent) &&
      draft.prompt.finalPrompt.trim() === enhancementContent?.trim());
  const referenceImages = draft.referenceImages ?? (draft.input ? [draft.input] : []);
  const blockedReason = !productFeature
    ? '请先明确选择文生图或图生图。'
    : productFeature === 'text_to_image' && referenceImages.length > 0
      ? '文生图不能包含图片，请先清除当前图片。'
      : productFeature === 'reference_to_image' && referenceImages.length === 0
        ? '图生图至少需要一张参考图片。'
        : hasInvalidImageReference(draft.prompt.finalPrompt)
          ? '提示词包含已删除图片的失效引用，请修改提示词后再提交。'
        : unsupportedContexts.length > 0
          ? '草稿含有未固定版本或不受支持的旧上下文，请先清理。'
          : !enhancementSatisfied
            ? '已填写结构化提示词内容，请先完成提示词增强并确认最终提示词。'
            : undefined;

  useEffect(() => {
    onBlockingReasonChange?.(blockedReason);
    return () => onBlockingReasonChange?.(undefined);
  }, [blockedReason, onBlockingReasonChange]);

  useEffect(() => {
    let active = true;
    if (!imageWorkspaces || referenceImages.length === 0) {
      setPreviewUrls({});
      setPreviewFailures({});
      return;
    }
    void Promise.all(
      referenceImages.map(async (reference) => [
        reference.assetId,
        await imageWorkspaces.createInputPreview(draft.draftId, reference.assetId)
      ] as const)
    ).then((previewResults) => {
      if (!active) return;
      setPreviewUrls(Object.fromEntries(
        previewResults.flatMap(([assetId, result]) => result.ok ? [[assetId, result.value.url]] : [])
      ));
      setPreviewFailures(Object.fromEntries(
        previewResults.flatMap(([assetId, result]) => result.ok ? [] : [[assetId, true]])
      ));
    }).catch(() => {
      if (active) onMessage('项目图片读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, draft.input?.assetId, referenceImages.map((reference) => reference.assetId).join(','), imageWorkspaces, onMessage]);

  function changeDraft(next: GenerationImageDraftDto) {
    onDraftChange({ ...next, state: 'editing' });
  }

  function selectFeature(nextFeature: 'text_to_image' | 'reference_to_image') {
    if (nextFeature === productFeature) return;
    if (nextFeature === 'text_to_image' && referenceImages.length > 0) {
      onMessage('切换文生图前请先清除当前图片。');
      return;
    }
    changeDraft({
      ...draft,
      generation: {},
      featureSelection: {
        productFeature: nextFeature,
        parameterValues: {}
      }
    });
    onMessage('生图方式已更改；请保存草稿后重新选择服务和参数。');
  }

  function changeOriginalInput(value: string) {
    changeDraft({
      ...draft,
      prompt: {
        ...draft.prompt,
        originalInput: value,
        finalPrompt:
          draft.prompt.systemSupplements.length === 0
            ? value
            : draft.prompt.finalPrompt
      }
    });
  }

  async function ensureSavedDraft(): Promise<GenerationImageDraftDto | undefined> {
    if (!imageWorkspaces) return undefined;
    if (!dirty && draft.state === 'saved') return draft;
    if (onFlushDraft) {
      if (!(await onFlushDraft())) return undefined;
      const refreshed = await imageWorkspaces.get(draft.draftId);
      if (!refreshed.ok || !refreshed.value) {
        onMessage('无法读取刚刚保存的图片草稿，请重试。');
        return undefined;
      }
      return refreshed.value as GenerationImageDraftDto;
    }
    const result = await imageWorkspaces.update({
      ...draft,
      state: 'saved'
    });
    if (!result.ok) {
      onMessage('保存草稿失败，请重试。');
      return undefined;
    }
    onDraftPersisted(result.value as GenerationImageDraftDto);
    return result.value as GenerationImageDraftDto;
  }

  async function selectReference() {
    if (
      !imageWorkspaces ||
      productFeature !== 'reference_to_image' ||
      busy
    ) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await imageWorkspaces.selectInput(saved.draftId);
      if (!result.ok) {
        onMessage('选择图片失败，请重试。');
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      const selected = result.value.draft.input;
      if (selected && referenceImages.some((reference) => reference.assetId === selected.assetId)) {
        await imageWorkspaces.clearInput(saved.draftId);
        onMessage('这张图片已经在参考列表中。');
        return;
      }
      const next = selected
        ? {
            ...result.value.draft,
            input: undefined,
            referenceImages: [...referenceImages, selected]
          }
        : result.value.draft;
      const preview = selected
        ? await imageWorkspaces.createInputPreview(result.value.draft.draftId, selected.assetId)
        : undefined;
      const persisted = await imageWorkspaces.update(next as GenerationImageDraftDto);
      if (!persisted.ok) {
        onMessage('参考图片写入草稿失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as GenerationImageDraftDto);
      setPreviewUrls((current) => preview?.ok && selected ? { ...current, [selected.assetId]: preview.value.url } : current);
      setPreviewFailures((current) => {
        if (!selected) return current;
        const next = { ...current };
        if (preview?.ok) delete next[selected.assetId];
        else next[selected.assetId] = true;
        return next;
      });
      onMessage('图片已复制并登记到当前项目；没有上传、分析或生成。');
    } catch {
      onMessage('选择图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function importReference(
    file: File,
    dropToken?: string
  ) {
    if (
      !imageWorkspaces ||
      productFeature !== 'reference_to_image' ||
      busy
    ) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await imageWorkspaces.importInput(
        saved.draftId,
        dropToken ?? file
      );
      if (!result.ok) {
        onMessage('拖入图片失败，请重试。');
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      const selected = result.value.draft.input;
      if (selected && referenceImages.some((reference) => reference.assetId === selected.assetId)) {
        await imageWorkspaces.clearInput(saved.draftId);
        onMessage('这张图片已经在参考列表中。');
        return;
      }
      const next = selected
        ? {
            ...result.value.draft,
            input: undefined,
            referenceImages: [...referenceImages, selected]
          }
        : result.value.draft;
      const preview = selected
        ? await imageWorkspaces.createInputPreview(result.value.draft.draftId, selected.assetId)
        : undefined;
      const persisted = await imageWorkspaces.update(next as GenerationImageDraftDto);
      if (!persisted.ok) {
        onMessage('参考图片写入草稿失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as GenerationImageDraftDto);
      setPreviewUrls((current) => preview?.ok && selected ? { ...current, [selected.assetId]: preview.value.url } : current);
      setPreviewFailures((current) => {
        if (!selected) return current;
        const next = { ...current };
        if (preview?.ok) delete next[selected.assetId];
        else next[selected.assetId] = true;
        return next;
      });
      onMessage('图片已完成本地校验并登记到当前项目。');
    } catch {
      onMessage('拖入图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function useWorkAsReference(workId: string) {
    if (
      !imageWorkspaces ||
      productFeature !== 'reference_to_image' ||
      busy
    ) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await imageWorkspaces.useWorkAsInput(saved.draftId, workId);
      if (!result.ok || result.value.cancelled || !result.value.draft) {
        onMessage('添加本地作品失败，请确认作品文件仍然可用。');
        return;
      }
      const selected = result.value.draft.input;
      if (selected && referenceImages.some((reference) => reference.assetId === selected.assetId)) {
        await imageWorkspaces.clearInput(saved.draftId);
        onMessage('这张图片已经在参考列表中。');
        return;
      }
      const next = selected
        ? {
            ...result.value.draft,
            input: undefined,
            referenceImages: [...referenceImages, selected]
          }
        : result.value.draft;
      const preview = selected
        ? await imageWorkspaces.createInputPreview(saved.draftId, selected.assetId)
        : undefined;
      const persisted = await imageWorkspaces.update(next as GenerationImageDraftDto);
      if (!persisted.ok) {
        onMessage('参考图片写入草稿失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as GenerationImageDraftDto);
      setPreviewUrls((current) => preview?.ok && selected ? { ...current, [selected.assetId]: preview.value.url } : current);
      setPreviewFailures((current) => {
        if (!selected) return current;
        const next = { ...current };
        if (preview?.ok) delete next[selected.assetId];
        else next[selected.assetId] = true;
        return next;
      });
      onMessage('本地作品已重新校验并添加为当前参考图。');
    } catch {
      onMessage('添加本地作品失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function removeReference(index: number) {
    if (!imageWorkspaces || referenceImages.length === 0 || busy) return;
    if (index < 0 || index >= referenceImages.length) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const remaining = referenceImages.filter((_, itemIndex) => itemIndex !== index);
      const persisted = await imageWorkspaces.update({
        ...saved,
        input: undefined,
        referenceImages: remaining.length > 0 ? remaining : undefined,
        prompt: {
          ...saved.prompt,
          originalInput: remapDeletedImageReferences(saved.prompt.originalInput, index + 1),
          finalPrompt: remapDeletedImageReferences(saved.prompt.finalPrompt, index + 1)
        },
        state: 'editing'
      });
      if (!persisted.ok) {
        onMessage('清除参考图片失败，请重试。');
        return;
      }
      onDraftPersisted(persisted.value as GenerationImageDraftDto);
      setPreviewUrls({});
      onMessage('参考图片已移除并重新编号；原始文件未删除。');
    } catch {
      onMessage('清除图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function clearUnsupportedContexts() {
    changeDraft({
      ...draft,
      contextReferences: draft.contextReferences.filter(
        (reference) =>
          reference.kind === 'project_context' &&
          reference.contextRevision !== undefined &&
          reference.includeInPrompt !== undefined
      )
    });
    onMessage('已从草稿清除不受支持或未固定版本的旧上下文。');
  }

  return (
    <>
      <div className="uc-image-professional__workspace uc-generation-two-pane uc-creation-simple">
        <section
          aria-label="提交前准备区域"
          className="uc-image-professional__before-pane"
        >
          <header className="uc-image-professional__pane-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>第一步 · 提交前准备</h2>
              <p>按顺序完成创作输入、提示词增强、服务与参数设置。</p>
            </div>
            <StatusPill tone="info">独立滚动</StatusPill>
          </header>

          <div className="uc-image-professional__before-scroll uc-scrollbar">
        <Card className="uc-image-workbench__panel uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>创作方式与输入</h2>
              <p>生图方式、参考图片和项目上下文均需明确选择并保存。</p>
            </div>
          </header>

          <div aria-label="生图方式" className="uc-image-feature-mode" role="group">
            <button
              aria-pressed={productFeature === 'text_to_image'}
              className="uc-image-feature-mode__option"
              onClick={() => selectFeature('text_to_image')}
              type="button"
            >
              <LuType aria-hidden="true" />
              <span><strong>文生图</strong><small>仅文字输入</small></span>
            </button>
            <button
              aria-pressed={productFeature === 'reference_to_image'}
              className="uc-image-feature-mode__option"
              onClick={() => selectFeature('reference_to_image')}
              type="button"
            >
              <LuFileImage aria-hidden="true" />
              <span><strong>图生图</strong><small>一张或多张参考图片</small></span>
            </button>
          </div>

          <div className="uc-image-quick__field">
            {productFeature === 'reference_to_image' ? (
              <div className="uc-image-professional__reference-field">
                <span>参考图片 <small>已添加 {referenceImages.length} 张</small></span>
                <ControlledImageDropZone
                  disabled={!imageWorkspaces || busy}
                  hasImage={referenceImages.length > 0}
                  onDropFile={(file, dropToken) => void importReference(file, dropToken)}
                  onDropWork={(workId) => void useWorkAsReference(workId)}
                  onReject={onMessage}
                >
                  <section
                    className={`uc-image-professional__reference${referenceImages.length > 0 ? ' has-image' : ' is-empty'}`}
                  >
                    {referenceImages.length > 0 ? (
                      <div className="uc-image-professional__reference-strip">
                        {referenceImages.map((reference, index) => (
                          <div className="uc-image-professional__reference-item" key={reference.assetId}>
                            <div className="uc-image-professional__reference-thumbnail">
                              {previewUrls[reference.assetId] ? (
                                <img alt={`图${index + 1}`} src={previewUrls[reference.assetId]} />
                              ) : (
                                <span className="uc-image-professional__reference-status">
                                  {previewFailures[reference.assetId] ? '预览失败' : '读取中'}
                                </span>
                              )}
                              <Button
                                aria-label={`删除图${index + 1}`}
                                className="uc-image-professional__reference-delete"
                                disabled={busy}
                                onClick={() => void removeReference(index)}
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
                          disabled={busy}
                          onClick={() => void selectReference()}
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
                          disabled={!imageWorkspaces || busy}
                          onClick={() => void selectReference()}
                          title="添加图片"
                          variant="secondary"
                        >
                          <LuPlus />
                        </Button>
                      </div>
                    )}
                  </section>
                </ControlledImageDropZone>
              </div>
            ) : null}
            <span>原始创作需求</span>
            <div className="uc-image-professional__prompt-input">
              <Input
                aria-label="原始创作需求"
                as="textarea"
                className="uc-image-professional__prompt-textarea"
                maxLength={1000}
                onChange={(value) => changeOriginalInput(value)}
                placeholder="描述主体、场景、氛围和创作用途"
                rows={8}
                value={draft.prompt.originalInput}
              />
            </div>
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </div>

          <CreationAdvancedSection
            defaultOpen={unsupportedContexts.length > 0}
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
              <ImagePromptEnhancePanel
                compact
                dirty={dirty}
                draft={draft}
                onFlushDraft={onFlushDraft}
                onDraftPersisted={(next) =>
                  onDraftPersisted(next as GenerationImageDraftDto)
                }
                onMessage={onMessage}
              />
            </div>
            {unsupportedContexts.length > 0 ? (
              <div className="uc-image-quick__preflight" role="status">
                <strong>发现旧上下文引用</strong>
                <span>专业生图只接受固定版本的项目上下文。</span>
                <Button onClick={clearUnsupportedContexts} variant="secondary">
                  <LuTrash2 aria-hidden="true" />
                  清理旧上下文
                </Button>
              </div>
            ) : null}
          </CreationAdvancedSection>

        </Card>

        {enhancementContent ? (
        <Card className="uc-image-workbench__panel uc-image-quick__compact-card">
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
          <div className="uc-image-professional__prompt-columns">
            <section>
              <StatusPill tone="success">最终提交提示词</StatusPill>
              <Input
                aria-label="最终提交提示词"
                as="textarea"
                maxLength={2000}
                onChange={(value) => changeDraft({
                  ...draft,
                  prompt: { ...draft.prompt, finalPrompt: value }
                })}
                rows={9}
                value={draft.prompt.finalPrompt}
              />
              <small>{draft.prompt.finalPrompt.length} / 2000</small>
            </section>
          </div>
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={draft.prompt.finalPrompt === draft.prompt.originalInput}
              onClick={() => changeDraft({
                ...draft,
                prompt: { ...draft.prompt, finalPrompt: draft.prompt.originalInput }
              })}
              variant="secondary"
            >
              <LuRotateCcw aria-hidden="true" />
              恢复原始输入
            </Button>
          </div>
          </CreationAdvancedSection>
        </Card>
        ) : null}

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">{enhancementContent ? '3' : '2'}</span>
            <div>
              <h2>服务与参数</h2>
              <p>
                {productFeature
                  ? '候选只基于当前生图方式和已保存草稿事实。'
                  : '请先选择文生图或图生图，再显示可用模型与参数。'}
              </p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            blockedReason={blockedReason}
            className="uc-image-feature-panel--compact"
            collapseParameters
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onDraftPersisted={onDraftPersisted}
            onFlushDraft={onFlushDraft}
            onNavigateToProviders={onNavigateToProviders}
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
            requireExplicitFeature
            showCandidateFacts={false}
          />
        </Card>
          </div>

        </section>

        <Card
          aria-label="生成过程与作品区域"
          className="uc-image-professional__after-pane"
        >
          <GenerationHistory
            draftId={draft.draftId}
            key={draft.projectId}
            mediaKind="image"
            workspaceMode="professional_image"
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
