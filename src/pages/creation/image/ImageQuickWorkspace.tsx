import { useState } from 'react';
import { LuArrowRight, LuSparkles } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { GenerationImageDraftDto } from './ImageGenerationControls';
import { ImageFeatureSubmissionPanel } from './ImageFeatureSubmissionPanel';

interface ImageQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted?: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToProfessional?: () => void;
}

export function ImageQuickWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigateToProfessional
}: ImageQuickWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [busy, setBusy] = useState(false);
  const [resultUrls, setResultUrls] = useState<readonly string[]>([]);
  const [workId, setWorkId] = useState<string>();
  const legacyReason = draft.input
    ? '此旧草稿含图片输入，快速生图不能提交；请迁移到专业生图。'
    : draft.contextReferences.length > 0
      ? '此旧草稿含上下文，快速生图不能提交；请迁移到专业生图。'
      : undefined;

  function changePrompt(value: string) {
    setResultUrls([]);
    setWorkId(undefined);
    onDraftChange({
      ...draft,
      state: 'editing',
      prompt: {
        originalInput: value,
        systemSupplements: [],
        finalPrompt: value
      },
      featureSelection: {
        productFeature: 'text_to_image',
        parameterValues:
          draft.featureSelection?.productFeature === 'text_to_image'
            ? draft.featureSelection.parameterValues
            : {}
      },
      generation: {}
    });
  }

  async function enterProfessional() {
    if (!imageWorkspaces || busy || dirty) return;
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
      <div className="uc-image-workbench__workspace uc-image-quick__workspace">
        <Card className="uc-image-workbench__panel uc-image-quick__composer">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>输入一句话生成图片</h2>
              <p>选模型、填提示词后点生成；无需先新建或手动确认多步草稿。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的图片</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changePrompt(event.target.value)}
              placeholder="例如：雪山日落下的露营海报"
              rows={7}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>
          <div className="uc-image-feature-panel__mode-fact">
            <LuSparkles aria-hidden="true" />
            <div>
              <strong>文生图</strong>
              <span>0 份图片素材 · 0 份上下文</span>
            </div>
          </div>
          {legacyReason ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>旧草稿需要迁移</strong>
              <span>{legacyReason}</span>
              <Button
                disabled={!imageWorkspaces || busy || dirty}
                onClick={() => void enterProfessional()}
                variant="secondary"
              >
                <LuArrowRight aria-hidden="true" />
                迁移到专业生图
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-image-quick__inspector">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>模型与生成</h2>
              <p>选择服务后一键生成；调用记录会保存返回的图片 URL。</p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            blockedReason={legacyReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onDraftPersisted={onDraftPersisted}
            onMessage={onMessage}
            onSubmissionComplete={(submission) => {
              setResultUrls(submission.resultImageUrls ?? []);
              setWorkId(submission.workId);
            }}
            oneShot
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-image-quick__stage">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>生成结果</h2>
              <p>展示服务商返回的图片 URL；任务中心调用记录同步可见。</p>
            </div>
          </header>
          {resultUrls.length === 0 && !workId ? (
            <EmptyState
              description="填写提示词并选择模型后点生成。"
              icon="画"
              readOnly
              title="尚无生成结果"
            />
          ) : (
            <div className="uc-image-quick__result-list">
              {resultUrls.map((url) => (
                <article key={url} className="uc-image-quick__result-item">
                  <strong>图片 URL</strong>
                  <a href={url} rel="noreferrer" target="_blank">{url}</a>
                  <img alt="生成结果预览" src={url} />
                </article>
              ))}
              {workId ? (
                <p className="uc-image-quick__hint" role="status">
                  本地作品已登记：{workId}
                </p>
              ) : null}
            </div>
          )}
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={busy || dirty}
              onClick={() => void enterProfessional()}
              variant="secondary"
            >
              <LuArrowRight aria-hidden="true" />
              进入专业创作
            </Button>
          </div>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="info">调用记录</StatusPill>
        <p>
          每次生成都会写入任务中心调用记录，并保存可展示的图片 URL；本地校验作品另行登记。
        </p>
      </Card>
    </>
  );
}
