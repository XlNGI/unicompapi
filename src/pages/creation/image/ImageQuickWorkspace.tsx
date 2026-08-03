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
  readonly onMessage: (message: string) => void;
  readonly onNavigateToProfessional?: () => void;
}

export function ImageQuickWorkspace({
  dirty,
  draft,
  onDraftChange,
  onMessage,
  onNavigateToProfessional
}: ImageQuickWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [busy, setBusy] = useState(false);
  const legacyReason = draft.input
    ? '此旧草稿含图片输入，快速生图不能提交；请迁移到专业生图。'
    : draft.contextReferences.length > 0
      ? '此旧草稿含上下文，快速生图不能提交；请迁移到专业生图。'
      : undefined;

  function changePrompt(value: string) {
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
              <p>快速生图固定为纯文生图，只发送明确保存的文字需求。</p>
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
              <h2>服务、参数与提交确认</h2>
              <p>候选和参数来自固定草稿 revision 的安全功能路由。</p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            blockedReason={legacyReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onMessage={onMessage}
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-image-quick__stage">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>生成结果</h2>
              <p>只显示主进程完成本地校验并登记的真实作品。</p>
            </div>
          </header>
          <EmptyState
            description="在线图片运行尚未获准，当前没有真实生成结果。"
            icon="画"
            readOnly
            title="尚无真实生成结果"
          />
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
        <StatusPill tone="warning">在线运行未授权</StatusPill>
        <p>
          页面可以展示真实候选和阻断原因；主进程运行授权关闭时不会创建请求、费用或假结果。
        </p>
      </Card>
    </>
  );
}
