import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ImagePreflightDto } from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceContextDto,
  ImageWorkspaceInputAssetDto
} from '../../../shared/image-workspace-ipc';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import {
  emptyImageConfirmations,
  ImageGenerationModelFields,
  imageSubmissionErrorMessages,
  ImageSubmissionConfirmations,
  type GenerationImageDraftDto
} from './ImageGenerationControls';

interface ImageProfessionalWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

const contextSections: readonly {
  readonly kind: ImageWorkspaceContextDto['kind'];
  readonly title: string;
  readonly description: string;
  readonly action: string;
}[] = [
  {
    kind: 'project_asset',
    title: '项目素材',
    description: '只使用用户明确选择的当前项目素材。',
    action: '选择项目素材'
  },
  {
    kind: 'project_context',
    title: '项目上下文',
    description: '不默认读取整个项目历史。',
    action: '选择项目上下文'
  },
  {
    kind: 'saved_conversation',
    title: '已保存的对话上下文',
    description: '不使用未保存或其他项目的对话。',
    action: '选择已保存对话'
  }
];

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
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage
}: ImageProfessionalWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const imageSubmissions = window.unicomp?.imageSubmissions;
  const [input, setInput] = useState<ImageWorkspaceInputAssetDto>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [preflight, setPreflight] = useState<ImagePreflightDto>();
  const [confirmations, setConfirmations] = useState(emptyImageConfirmations);
  const [busy, setBusy] = useState(false);
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === draft.generation.model?.modelId
  );

  useEffect(() => {
    let active = true;
    setInput(undefined);
    setPreviewUrl('');
    if (!imageWorkspaces || !draft.input) return;

    async function loadInput() {
      const [inputResult, previewResult] = await Promise.all([
        imageWorkspaces!.getInput(draft.draftId),
        imageWorkspaces!.createInputPreview(draft.draftId)
      ]);
      if (!active) return;
      if (inputResult.ok) setInput(inputResult.value);
      if (previewResult.ok) setPreviewUrl(previewResult.value.url);
    }

    void loadInput().catch(() => {
      if (active) onMessage('参考图读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, draft.input?.assetId, imageWorkspaces, onMessage]);

  useEffect(() => {
    setPreflight(undefined);
    setConfirmations(emptyImageConfirmations);
  }, [draft.updatedAt]);

  function changeDraft(next: GenerationImageDraftDto) {
    setPreflight(undefined);
    setConfirmations(emptyImageConfirmations);
    onDraftChange({ ...next, state: 'editing' });
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
    if (!imageWorkspaces || dirty || busy) return;
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
      onMessage('参考图已复制并登记到当前项目；没有上传、分析或生成。');
    } catch {
      onMessage('选择参考图失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function checkSubmission() {
    if (!imageSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(imageSubmissionErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setConfirmations(emptyImageConfirmations);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建任务。'
          : '检查通过：请核对并确认全部提交事实。'
      );
    } catch {
      onMessage('提交条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="uc-image-professional__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>输入来源与上下文</h2>
              <p>只使用明确选择并保存在草稿中的内容。</p>
            </div>
          </header>
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

          <div className="uc-image-professional__contexts">
            {contextSections.map((section) => {
              const count = draft.contextReferences.filter(
                (reference) => reference.kind === section.kind
              ).length;
              return (
                <section
                  className="uc-image-professional__context"
                  key={section.kind}
                >
                  <div>
                    <strong>{section.title}</strong>
                    <span>{section.description}</span>
                  </div>
                  <div className="uc-image-professional__context-action">
                    <Button disabled variant="secondary">
                      {section.action}
                    </Button>
                    <span>已选 {count} 项</span>
                  </div>
                </section>
              );
            })}
          </div>
          <p className="uc-image-quick__hint">
            当前 DTO 尚未提供三类上下文的候选列表接口，因此不能新增选择。
          </p>

          <section className="uc-image-professional__reference">
            <div className="uc-image-quick__reference">
              <div>
                <strong>单张参考图</strong>
                <span>
                  {input
                    ? `${input.name} · ${input.width} × ${input.height}`
                    : '选择后只登记到当前项目，不会上传或分析。'}
                </span>
              </div>
              <Button
                disabled={!imageWorkspaces || dirty || busy}
                onClick={() => void selectReference()}
                variant="secondary"
              >
                {input ? '重新选择参考图' : '选择一张参考图'}
              </Button>
            </div>
            {previewUrl ? (
              <figure className="uc-image-professional__preview">
                <img
                  alt={`参考图：${input?.name ?? '本地图片'}`}
                  src={previewUrl}
                />
                <figcaption>受控本地预览，不代表生成结果。</figcaption>
              </figure>
            ) : null}
            <label className="uc-image-quick__field">
              <span>参考图用途</span>
              <input
                disabled={!draft.input}
                maxLength={200}
                onChange={(event) => changeReferencePurpose(event.target.value)}
                placeholder="例如：仅参考构图，不复制人物"
                value={draft.input?.purpose ?? ''}
              />
            </label>
          </section>
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再选择图片或检查提交条件。
            </p>
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
                      <small>
                        {supplementSourceLabels[supplement.source] ??
                          supplement.source}
                      </small>
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
                onChange={(event) =>
                  changeDraft({
                    ...draft,
                    prompt: {
                      ...draft.prompt,
                      finalPrompt: event.target.value
                    }
                  })
                }
                rows={9}
                value={draft.prompt.finalPrompt}
              />
              <small>{draft.prompt.finalPrompt.length} / 2000</small>
            </section>
          </div>
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={draft.prompt.systemSupplements.length === 0}
              onClick={() =>
                changeDraft({
                  ...draft,
                  prompt: {
                    ...draft.prompt,
                    finalPrompt: draft.prompt.originalInput
                  }
                })
              }
              variant="secondary"
            >
              恢复原始输入
            </Button>
            <Button
              disabled={draft.prompt.systemSupplements.length === 0}
              onClick={() =>
                changeDraft({
                  ...draft,
                  prompt: {
                    originalInput: draft.prompt.originalInput,
                    systemSupplements: [],
                    finalPrompt: draft.prompt.originalInput
                  }
                })
              }
              variant="secondary"
            >
              清除系统补充
            </Button>
            <Button disabled variant="secondary">
              重新增强
            </Button>
          </div>
          <EmptyState
            description="当前没有真实图片适配器，不显示示例结果或生成进度。"
            icon="画"
            readOnly
            title="尚无真实生成结果"
          />
          <div className="uc-image-quick__result-actions">
            <Button disabled variant="secondary">
              保存到项目
            </Button>
            <Button disabled variant="secondary">
              重新生成
            </Button>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>服务、参数与确认</h2>
              <p>模型和参数只来自本机能力事实。</p>
            </div>
          </header>
          <ImageGenerationModelFields
            draft={draft}
            onDraftChange={changeDraft}
            registry={registry}
          />
          <Button
            disabled={!imageSubmissions || dirty || busy}
            onClick={() => void checkSubmission()}
            variant="secondary"
          >
            检查提交条件
          </Button>
          {preflight ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {preflight.blockers.length ? '当前无法提交' : '提交条件已通过'}
              </strong>
              {preflight.blockers.map((blocker) => (
                <span key={blocker}>
                  • {imageSubmissionErrorMessages[blocker]}
                </span>
              ))}
            </div>
          ) : null}
          {selectedCandidate ? (
            <ImageSubmissionConfirmations
              candidate={selectedCandidate}
              confirmations={confirmations}
              finalPrompt={draft.prompt.finalPrompt}
              onChange={setConfirmations}
            />
          ) : null}
          <Button disabled>提交生成任务</Button>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="warning">真实能力状态</StatusPill>
        <p>
          当前只支持专业草稿、单张参考图、提示词分层和能力预检；缺少上下文选择接口和真实图片适配器，不会创建任务或伪造结果。
        </p>
      </Card>
    </>
  );
}
