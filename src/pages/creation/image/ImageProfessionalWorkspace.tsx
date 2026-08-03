import { useEffect, useState } from 'react';
import {
  LuFileImage,
  LuImagePlus,
  LuRotateCcw,
  LuTrash2,
  LuType
} from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ImageWorkspaceInputAssetDto } from '../../../shared/image-workspace-ipc';
import { WorkspaceContextSelector } from '../WorkspaceContextSelector';
import type { GenerationImageDraftDto } from './ImageGenerationControls';
import { ImageFeatureSubmissionPanel } from './ImageFeatureSubmissionPanel';

interface ImageProfessionalWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

const supplementSourceLabels: Readonly<Record<string, string>> = {
  project_context: '项目上下文',
  selected_context: '已选上下文',
  style: '风格补充',
  structure: '结构补充',
  constraint: '约束补充',
  translation: '翻译补充',
  model_format: '模型格式'
};

export function ImageProfessionalWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onMessage
}: ImageProfessionalWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [input, setInput] = useState<ImageWorkspaceInputAssetDto>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
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
  const blockedReason = !productFeature
    ? '请先明确选择文生图或图生图。'
    : productFeature === 'text_to_image' && draft.input
      ? '文生图不能包含图片，请先清除当前图片。'
      : productFeature === 'reference_to_image' && !draft.input
        ? '图生图必须选择恰好一张图片。'
        : unsupportedContexts.length > 0
          ? '草稿含有未固定 revision 或不受支持的旧上下文，请先清理。'
          : undefined;

  useEffect(() => {
    let active = true;
    setInput(undefined);
    setPreviewUrl('');
    if (!imageWorkspaces || !draft.input) return;
    void Promise.all([
      imageWorkspaces.getInput(draft.draftId),
      imageWorkspaces.createInputPreview(draft.draftId)
    ]).then(([inputResult, previewResult]) => {
      if (!active) return;
      if (inputResult.ok) setInput(inputResult.value);
      if (previewResult.ok) setPreviewUrl(previewResult.value.url);
    }).catch(() => {
      if (active) onMessage('项目图片读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, draft.input?.assetId, imageWorkspaces, onMessage]);

  function changeDraft(next: GenerationImageDraftDto) {
    onDraftChange({ ...next, state: 'editing' });
  }

  function selectFeature(nextFeature: 'text_to_image' | 'reference_to_image') {
    if (nextFeature === productFeature) return;
    if (nextFeature === 'text_to_image' && draft.input) {
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

  function changeReferencePurpose(value: string) {
    if (!draft.input) return;
    changeDraft({
      ...draft,
      input: {
        ...draft.input,
        purpose: value.trim() ? value : undefined
      }
    });
  }

  async function selectReference() {
    if (
      !imageWorkspaces ||
      productFeature !== 'reference_to_image' ||
      dirty ||
      busy
    ) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.selectInput(draft.draftId);
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      onDraftPersisted(result.value.draft as GenerationImageDraftDto);
      setInput(result.value.input);
      const preview = await imageWorkspaces.createInputPreview(draft.draftId);
      setPreviewUrl(preview.ok ? preview.value.url : '');
      onMessage('图片已复制并登记到当前项目；没有上传、分析或生成。');
    } catch {
      onMessage('选择图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearReference() {
    if (!imageWorkspaces || !draft.input || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.clearInput(draft.draftId);
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onDraftPersisted(result.value as GenerationImageDraftDto);
      setInput(undefined);
      setPreviewUrl('');
      onMessage('已从当前草稿清除图片引用；项目内原始素材记录保持不变。');
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
    onMessage('已从草稿清除不受支持或未固定 revision 的旧上下文。');
  }

  return (
    <>
      <div className="uc-image-professional__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>创作方式与输入</h2>
              <p>生图方式、图片和项目上下文均需明确选择并保存。</p>
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
              <span><strong>图生图</strong><small>恰好一张图片</small></span>
            </button>
          </div>

          <label className="uc-image-quick__field">
            <span>原始创作需求</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changeOriginalInput(event.target.value)}
              placeholder="描述主体、场景、氛围和创作用途"
              rows={5}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>

          {productFeature === 'reference_to_image' ? (
            <section className="uc-image-professional__reference">
              <div className="uc-image-quick__reference">
                <div>
                  <strong>项目图片</strong>
                  <span>
                    {input
                      ? `${input.name} · ${input.width} × ${input.height}`
                      : '选择后只复制并登记到当前项目，不会自动外发。'}
                  </span>
                </div>
                <div className="uc-image-feature-panel__media-actions">
                  <Button
                    disabled={!imageWorkspaces || dirty || busy}
                    onClick={() => void selectReference()}
                    variant="secondary"
                  >
                    <LuImagePlus aria-hidden="true" />
                    {input ? '替换图片' : '选择图片'}
                  </Button>
                  <Button
                    disabled={!imageWorkspaces || !draft.input || dirty || busy}
                    onClick={() => void clearReference()}
                    variant="secondary"
                  >
                    <LuTrash2 aria-hidden="true" />
                    清除图片
                  </Button>
                </div>
              </div>
              {previewUrl ? (
                <figure className="uc-image-professional__preview">
                  <img alt={`项目图片：${input?.name ?? '本地图片'}`} src={previewUrl} />
                  <figcaption>受控本地预览，不代表生成结果。</figcaption>
                </figure>
              ) : null}
              <label className="uc-image-quick__field">
                <span>图片用途</span>
                <input
                  disabled={!draft.input}
                  maxLength={200}
                  onChange={(event) => changeReferencePurpose(event.target.value)}
                  placeholder="例如：仅参考构图，不复制人物"
                  value={draft.input?.purpose ?? ''}
                />
              </label>
            </section>
          ) : null}

          <WorkspaceContextSelector
            disabled={busy}
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
              <strong>发现旧上下文引用</strong>
              <span>专业生图只接受固定 revision 的 ProjectContext。</span>
              <Button onClick={clearUnsupportedContexts} variant="secondary">
                <LuTrash2 aria-hidden="true" />
                清理旧上下文
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>提示词增强对比</h2>
              <p>原始输入、系统补充和最终提示词互不覆盖。</p>
            </div>
          </header>
          <div className="uc-image-professional__prompt-columns">
            <section>
              <StatusPill tone="info">用户原始输入</StatusPill>
              <p>{draft.prompt.originalInput || '尚未填写原始创作需求。'}</p>
            </section>
            <section>
              <StatusPill tone="neutral">系统补充内容</StatusPill>
              {draft.prompt.systemSupplements.length ? (
                <ul>
                  {draft.prompt.systemSupplements.map((supplement, index) => (
                    <li key={`${supplement.source}-${index}`}>
                      <small>{supplementSourceLabels[supplement.source] ?? supplement.source}</small>
                      <span>{supplement.content}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>没有真实增强结果；系统不会自动编造补充内容。</p>
              )}
            </section>
            <section>
              <StatusPill tone="success">最终提交提示词</StatusPill>
              <textarea
                aria-label="最终提交提示词"
                maxLength={2000}
                onChange={(event) => changeDraft({
                  ...draft,
                  prompt: { ...draft.prompt, finalPrompt: event.target.value }
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
          <EmptyState
            description="只有通过安全路由提交并完成本地文件校验后，结果才会登记为作品。"
            icon="画"
            readOnly
            title="尚无真实生成结果"
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>服务、参数与确认</h2>
              <p>候选只基于当前生图方式和已保存草稿事实。</p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            blockedReason={blockedReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onMessage={onMessage}
          />
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="warning">在线运行未授权</StatusPill>
        <p>
          候选、参数、图片、上下文和外发确认相互独立；任何事实变化都会使旧选择令牌失效。
        </p>
      </Card>
    </>
  );
}
