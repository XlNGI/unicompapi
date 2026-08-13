import { useState } from 'react';
import { LuArrowRight, LuSparkles } from 'react-icons/lu';
import { Input } from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { GenerationResultPreview } from '../../../components/GenerationResultPreview';
import { StatusPill } from '../../../components/StatusPill';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode
} from '../../../shared/video-workspace-ipc';
import { VideoFeatureSubmissionPanel } from './VideoFeatureSubmissionPanel';

type QuickVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'quick_video' }
>;

interface VideoQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: QuickVideoDraftDto;
  readonly onDraftChange: (draft: QuickVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: QuickVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToTextToVideo?: () => void;
  readonly onNavigateToImageToVideo?: (draftId: string) => void;
}

const workspaceErrorMessages: Partial<Record<VideoWorkspaceIpcErrorCode, string>> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  draft_not_found: '当前视频草稿已不存在。',
  draft_conflict: '视频草稿已在其他操作中更新，请稍后重试。',
  workspace_storage_error: '本地视频草稿保存失败，请检查项目目录后重试。',
  invalid_request: '当前视频草稿数据无效，请刷新页面后重试。'
};

function describeWorkspaceError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  return workspaceErrorMessages[error.code as VideoWorkspaceIpcErrorCode] ?? error.message;
}

export function VideoQuickWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigateToTextToVideo,
  onNavigateToImageToVideo
}: VideoQuickWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [busy, setBusy] = useState(false);
  const [resultWorkId, setResultWorkId] = useState<string>();
  const [resultUrls, setResultUrls] = useState<readonly string[]>([]);
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
        onMessage(describeWorkspaceError(result.error));
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
              <p>快速视频固定为纯文生视频；选模型、填参数后直接生成，与文生/图生共用流程。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的视频</span>
            <Input
              as="textarea"
              maxLength={1000}
              onChange={(value) => changePrompt(value)}
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
              <h2>服务与提交</h2>
              <p>选择模型后由后台锁定 API；快速视频使用服务默认参数，可直接生成。</p>
            </div>
          </header>
          <VideoFeatureSubmissionPanel
            blockedReason={legacyReason}
            dirty={dirty}
            draft={draft}
            oneShot
            onDraftChange={(next) => onDraftChange(next as QuickVideoDraftDto)}
            onDraftPersisted={(next) => onDraftPersisted(next as QuickVideoDraftDto)}
            onMessage={onMessage}
            onSubmissionComplete={(submission) => {
              setResultWorkId(submission.workId);
              setResultUrls(submission.resultVideoUrls ?? []);
            }}
            showProgressSteps
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-image-quick__stage">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>生成结果</h2>
              <p>展示服务商返回的结果 URL；本地校验作品另行登记。</p>
            </div>
          </header>
          <GenerationResultPreview
            emptyDescription="填写提示词并选择模型后准备并提交。"
            emptyTitle="尚无生成结果"
            mediaKind="video"
            remoteUrls={resultUrls}
            workId={resultWorkId}
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
        <StatusPill tone="info">调用记录</StatusPill>
        <p>
          快速/文生/图生视频共用同一提交与调用记录流程；每次提交都会写入任务中心。
        </p>
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
