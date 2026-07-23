import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ImagePreflightDto } from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceInputAssetDto
} from '../../../shared/image-workspace-ipc';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import {
  emptyImageConfirmations,
  ImageGenerationModelFields,
  imageSubmissionErrorMessages as submissionErrorMessages,
  ImageSubmissionConfirmations,
  type GenerationImageDraftDto
} from './ImageGenerationControls';

interface ImageQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToProfessional?: () => void;
}

export function ImageQuickWorkspace({
  dirty,
  draft,
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigateToProfessional
}: ImageQuickWorkspaceProps) {
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

  function changePrompt(value: string) {
    changeDraft({
      ...draft,
      prompt: {
        originalInput: value,
        systemSupplements: [],
        finalPrompt: value
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
        onMessage(submissionErrorMessages[result.error.code]);
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

  async function enterProfessional() {
    if (!imageWorkspaces || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.derive(
        draft.draftId,
        'professional_image'
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onMessage('已创建专业生图派生草稿；没有创建或提交任务。');
      onNavigateToProfessional?.();
    } catch {
      onMessage('创建专业生图派生草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="uc-image-workbench__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>一句话需求</h2>
              <p>原始输入与最终提示词分别保存；快速模式不自动增强。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的图片</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changePrompt(event.target.value)}
              placeholder="例如：雪山日落下的露营海报"
              rows={6}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>
          <div className="uc-image-quick__reference">
            <div>
              <strong>单张参考图（可选）</strong>
              <span>
                {input
                  ? `${input.name} · ${input.width} × ${input.height}`
                  : '选择后只复制到当前项目，不会上传或分析。'}
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
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再选择图片或检查提交条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>参考与结果</h2>
              <p>只显示受控本地预览和主进程登记的真实结果。</p>
            </div>
          </header>
          {previewUrl ? (
            <figure className="uc-image-quick__preview">
              <img alt={`参考图：${input?.name ?? '本地图片'}`} src={previewUrl} />
              <figcaption>本地参考图预览，不代表生成结果。</figcaption>
            </figure>
          ) : (
            <EmptyState
              description="填写一句话需求后可直接生成；参考图不是必填项。"
              icon="画"
              readOnly
              title="尚无真实生成结果"
            />
          )}
          <div className="uc-image-quick__result-actions">
            <Button disabled variant="secondary">
              保存到项目
            </Button>
            <Button disabled variant="secondary">
              重新生成
            </Button>
            <Button
              disabled={dirty || busy}
              onClick={() => void enterProfessional()}
              variant="secondary"
            >
              进入专业创作
            </Button>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>模型、参数与确认</h2>
              <p>模型、参数和阻断原因全部来自本机真实 DTO。</p>
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
                <span key={blocker}>• {submissionErrorMessages[blocker]}</span>
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
          <div className="uc-image-quick__submission-actions">
            <Button disabled>
              提交任务
            </Button>
          </div>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone={preflight?.blockers.length === 0 ? 'success' : 'warning'}>
          {preflight?.blockers.length === 0 ? '等待明确确认' : '真实能力状态'}
        </StatusPill>
        <p>
          当前没有真实图片适配器，只支持保存草稿和查看阻断原因；不会创建任务、显示假进度或假结果。
        </p>
      </Card>
    </>
  );
}
