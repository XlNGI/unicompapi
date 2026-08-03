import { useState } from 'react';
import { LuArrowRight, LuSparkles } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { VideoWorkspaceDraftDto } from '../../../shared/video-workspace-ipc';
import { VideoFeatureSubmissionPanel } from './VideoFeatureSubmissionPanel';

type QuickVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'quick_video' }
>;

interface VideoQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: QuickVideoDraftDto;
  readonly onDraftChange: (draft: QuickVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToTextToVideo?: () => void;
  readonly onNavigateToImageToVideo?: (draftId: string) => void;
}

export function VideoQuickWorkspace({
  dirty,
  draft,
  onDraftChange,
  onMessage,
  onNavigateToTextToVideo,
  onNavigateToImageToVideo
}: VideoQuickWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [busy, setBusy] = useState(false);
  const legacyReference = draft.quick.reference;
  const hasLegacyContexts = draft.contextReferences.length > 0;
  const legacyReason = legacyReference?.mediaKind === 'video'
    ? '此旧草稿含视频参考，当前没有可无损迁移的生视频功能。'
    : legacyReference?.mediaKind === 'image'
      ? '此旧草稿含图片输入，快速视频不能提交；请迁移到图生视频。'
      : hasLegacyContexts
        ? '此旧草稿含上下文，快速视频不能提交；请迁移到文生视频。'
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
        productFeature: 'text_to_video',
        parameterValues:
          draft.featureSelection?.productFeature === 'text_to_video'
            ? draft.featureSelection.parameterValues
            : {}
      },
      generation: emptyGeneration()
    });
  }

  async function migrateLegacyDraft() {
    if (!videoWorkspaces || busy || dirty || !legacyReason) return;
    const targetMode = legacyReference?.mediaKind === 'image'
      ? 'image_to_video' as const
      : !legacyReference && hasLegacyContexts
        ? 'text_to_video' as const
        : undefined;
    if (!targetMode) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoWorkspaces.derive(draft.draftId, targetMode);
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onMessage('已创建专业视频派生草稿；没有创建或提交任务。');
      if (targetMode === 'image_to_video') {
        onNavigateToImageToVideo?.(result.value.draftId);
      } else {
        onNavigateToTextToVideo?.();
      }
    } catch {
      onMessage('迁移旧快速视频草稿失败，请重试。');
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
              <h2>输入一句话生成视频</h2>
              <p>快速视频固定为纯文生视频，只发送明确保存的文字需求。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的视频</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changePrompt(event.target.value)}
              placeholder="例如：海边日出时，一辆复古列车沿悬崖缓慢驶过"
              rows={7}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>
          <div className="uc-image-feature-panel__mode-fact">
            <LuSparkles aria-hidden="true" />
            <div>
              <strong>文生视频</strong>
              <span>0 份图片素材 · 0 份视频素材 · 0 份上下文</span>
            </div>
          </div>
          {legacyReason ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>旧草稿需要迁移</strong>
              <span>{legacyReason}</span>
              {legacyReference?.mediaKind !== 'video' ? (
                <Button
                  disabled={!videoWorkspaces || busy || dirty}
                  onClick={() => void migrateLegacyDraft()}
                  variant="secondary"
                >
                  <LuArrowRight aria-hidden="true" />
                  {legacyReference ? '迁移到图生视频' : '迁移到文生视频'}
                </Button>
              ) : null}
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
          <VideoFeatureSubmissionPanel
            blockedReason={legacyReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={(next) => onDraftChange(next as QuickVideoDraftDto)}
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
            description="在线视频运行尚未获准，当前没有真实生成结果。"
            icon="视"
            readOnly
            title="尚无真实生成结果"
          />
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={busy || dirty}
              onClick={onNavigateToTextToVideo}
              variant="secondary"
            >
              <LuArrowRight aria-hidden="true" />
              进入专业文生视频
            </Button>
          </div>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="warning">在线运行未授权</StatusPill>
        <p>主进程运行授权关闭时不会创建请求、费用或假结果。</p>
      </Card>
    </>
  );
}

function emptyGeneration(): QuickVideoDraftDto['generation'] {
  return {
    enhancement: { state: 'not_created', staleReasons: [] },
    preflight: { state: 'not_created', staleReasons: [] }
  };
}
