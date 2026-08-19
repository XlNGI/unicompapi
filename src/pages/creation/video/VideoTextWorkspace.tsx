import { useCallback, useState } from 'react';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { Input, SelectPicker } from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { GenerationResultPreview } from '../../../components/GenerationResultPreview';
import { StatusPill } from '../../../components/StatusPill';
import type { SubmissionProgressPhase } from '../../../components/SubmissionProgressSteps';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceShotDto
} from '../../../shared/video-workspace-ipc';
import { composeVideoPromptEnhancementInput } from '../../../shared/prompt-enhancement-input';
import { WorkspaceContextSelector } from '../WorkspaceContextSelector';
import { VideoFeatureSubmissionPanel } from './VideoFeatureSubmissionPanel';
import { VideoPromptEnhancePanel } from './VideoPromptEnhancePanel';

type TextVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'text_to_video' }
>;

interface VideoTextWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: TextVideoDraftDto;
  readonly onClearUi?: () => void;
  readonly onDraftChange: (draft: TextVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: TextVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

export function VideoTextWorkspace({
  dirty,
  draft,
  onClearUi,
  onDraftChange,
  onDraftPersisted,
  onMessage
}: VideoTextWorkspaceProps) {
  const [resultWorkId, setResultWorkId] = useState<string>();
  const [resultUrls, setResultUrls] = useState<readonly string[]>([]);
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [submissionProgress, setSubmissionProgress] = useState<SubmissionProgressPhase>('idle');
  const handleProgressChange = useCallback((phase: SubmissionProgressPhase) => {
    if (phase === 'preparing') {
      setResultWorkId(undefined);
      setResultUrls([]);
    }
    setSubmissionProgress(phase);
  }, []);
  const generationInFlight = ['preparing', 'requesting', 'waiting'].includes(submissionProgress);
  const generationPreviewCopy = submissionProgress === 'preparing'
    ? { title: '正在准备视频生成', description: '正在锁定本次参数、素材与提交事实。' }
    : submissionProgress === 'requesting'
      ? { title: '正在提交生成请求', description: '请求正在安全提交，请保持应用运行。' }
      : { title: '正在生成视频', description: '服务商正在处理，完成后将校验并登记到本地。' };
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
    draft.featureSelection.productFeature !== 'text_to_video'
      ? '当前草稿没有固定为文生视频，请重新保存草稿。'
      : draft.textToVideo.materials
        ? '此旧草稿含素材槽位；文生视频必须移除全部素材后才能提交。'
        : unsupportedContexts.length > 0
          ? '草稿含有未固定版本或不受支持的旧上下文，请先清理。'
          : !enhancementSatisfied
            ? '已填写结构化提示词内容，请先完成提示词增强并确认最终提示词。'
          : undefined;

  function changeDraft(next: TextVideoDraftDto) {
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

  function addShot() {
    const nextOrder = draft.textToVideo.shots.length + 1;
    changeDraft({
      ...draft,
      textToVideo: {
        ...draft.textToVideo,
        shots: [
          ...draft.textToVideo.shots,
          { id: `shot-${Date.now()}`, order: nextOrder, description: '' }
        ],
        storyboard: emptyStoryboard()
      }
    });
  }

  function updateShot(shotId: string, patch: Partial<VideoWorkspaceShotDto>) {
    changeDraft({
      ...draft,
      textToVideo: {
        ...draft.textToVideo,
        shots: draft.textToVideo.shots.map((shot) =>
          shot.id === shotId ? { ...shot, ...patch } : shot
        ),
        storyboard: emptyStoryboard()
      }
    });
  }

  function removeShot(shotId: string) {
    const shots = draft.textToVideo.shots
      .filter((shot) => shot.id !== shotId)
      .map((shot, index) => ({ ...shot, order: index + 1 }));
    changeDraft({
      ...draft,
      textToVideo: { ...draft.textToVideo, shots, storyboard: emptyStoryboard() }
    });
  }

  function removeLegacyMaterials() {
    changeDraft({
      ...draft,
      textToVideo: { ...draft.textToVideo, materials: undefined }
    });
    onMessage('旧素材槽位已从当前草稿移除；自动保存后可重新选择服务。');
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
      <div className="uc-image-workbench__workspace uc-video-text__workspace uc-generation-two-pane">
        <section aria-label="提交前准备区域" className="uc-generation-two-pane__controls uc-generation-two-pane__preparation">
          <header className="uc-image-professional__pane-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>第一步 · 提交前准备</h2>
              <p>整理创作需求、提示词、服务与参数后再生成。</p>
            </div>
          </header>
          <div className="uc-generation-two-pane__preparation-scroll uc-scrollbar">
          <div className="uc-generation-two-pane__preparation-flow">
        <Card className="uc-image-workbench__panel uc-video-text__source">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>文字需求、项目上下文与镜头计划</h2>
              <p>文生视频固定为无素材输入；镜头计划在第一步整理，最终提示词在第二步确认。</p>
            </div>
          </header>
          <div className="uc-image-quick__field">
            <span>文字来源</span>
            <SelectPicker
              aria-label="文字来源"
              cleanable={false}
              data={[
                { value: 'short_idea', label: '简短创意' },
                { value: 'long_form', label: '长文本脚本' }
              ]}
              onChange={(value) => changeDraft({
                ...draft,
                textToVideo: {
                  ...draft.textToVideo,
                  sourceKind: value as 'short_idea' | 'long_form'
                }
              })}
              searchable={false}
              value={draft.textToVideo.sourceKind}
            />
          </div>
          <label className="uc-image-quick__field">
            <span>原始需求</span>
            <Input
              as="textarea"
              maxLength={4000}
              onChange={(value) => changePrompt('originalInput', value)}
              rows={7}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 4000</small>
          </label>
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
          <div className="uc-image-quick__result-actions">
            <Button onClick={addShot} variant="secondary">
              <LuPlus aria-hidden="true" />
              添加镜头
            </Button>
          </div>
          <div className="uc-video-text__shot-list">
            {draft.textToVideo.shots.map((shot) => (
              <section className="uc-video-text__shot" key={shot.id}>
                <div className="uc-video-text__shot-heading">
                  <strong>镜头 {shot.order}</strong>
                  <Button
                    aria-label={`删除镜头 ${shot.order}`}
                    onClick={() => removeShot(shot.id)}
                    title="删除镜头"
                    variant="ghost"
                  >
                    <LuTrash2 aria-hidden="true" />
                  </Button>
                </div>
                <label className="uc-image-quick__field">
                  <span>画面描述</span>
                  <Input
                    as="textarea"
                    onChange={(value) => updateShot(shot.id, { description: value })}
                    rows={3}
                    value={shot.description}
                  />
                </label>
              </section>
            ))}
          </div>
          {unsupportedContexts.length > 0 ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>发现旧上下文</strong>
              <span>文生视频只接受固定版本的项目上下文。</span>
              <Button onClick={removeUnsupportedContexts} variant="secondary">
                <LuTrash2 aria-hidden="true" />
                明确移除旧上下文
              </Button>
            </div>
          ) : null}
          {draft.textToVideo.materials ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>发现旧素材槽位</strong>
              <span>文生视频不再接收图片、视频或其他参考素材。</span>
              <Button onClick={removeLegacyMaterials} variant="secondary">
                <LuTrash2 aria-hidden="true" />
                明确移除旧素材槽位
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-video-text__prompt">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>最终提示词</h2>
              <p>最终提示词是本次外发的唯一文本事实，可在这里直接编辑。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>最终提示词</span>
            <Input
              as="textarea"
              maxLength={6000}
              onChange={(value) => changePrompt('finalPrompt', value)}
              rows={8}
              value={draft.prompt.finalPrompt}
            />
            <small>{draft.prompt.finalPrompt.length} / 6000</small>
          </label>
          <VideoPromptEnhancePanel
            dirty={dirty}
            draft={draft}
            onDraftPersisted={(next) => onDraftPersisted(next as TextVideoDraftDto)}
            onMessage={onMessage}
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-video-text__submit">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>模型、参数与提交流程</h2>
              <p>选择模型后由后台锁定接口与参数配置；填写参数后准备并提交。</p>
            </div>
          </header>
          <VideoFeatureSubmissionPanel
            actionHost={actionHost}
            blockedReason={blockedReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={(next) => onDraftChange(next as TextVideoDraftDto)}
            onDraftPersisted={(next) => onDraftPersisted(next as TextVideoDraftDto)}
            onMessage={onMessage}
            onProgressChange={handleProgressChange}
            onSubmissionComplete={(submission) => {
              setResultWorkId(submission.workId);
              setResultUrls(submission.resultVideoUrls ?? []);
              if (submission.status === 'completed') {
                onClearUi?.();
              }
            }}
            showProgressSteps
          />
        </Card>
          </div>
          </div>
          <footer className="uc-image-professional__submit-bar">
            <span>
              {generationInFlight
                ? '请求处理中，请在右侧查看进度'
                : dirty || draft.state !== 'saved'
                  ? '正在保存当前配置'
                  : '草稿已保存，可以提交'}
            </span>
            <div className="uc-image-professional__submit-action" ref={setActionHost} />
          </footer>
        </section>

        <section aria-label="生成过程与作品区域" className="uc-generation-two-pane__result uc-generation-two-pane__output">
          <header className="uc-image-professional__pane-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>第二步 · 生成过程与作品</h2>
              <p>提交状态与通过本地校验的作品会保留在这里。</p>
            </div>
          </header>
          <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-video-text__canvas">
            <GenerationResultPreview
              loading={generationInFlight}
              loadingDescription={generationPreviewCopy.description}
              loadingTitle={generationPreviewCopy.title}
              mediaKind="video"
              remoteUrls={resultUrls}
              workId={resultWorkId}
            />
          </Card>
        </section>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="info">调用记录</StatusPill>
        <p>
          快速/文生/图生视频共用同一提交与调用记录流程；上下文或参数变化会使旧选择令牌失效。
        </p>
      </Card>
    </>
  );
}

function emptyGeneration(): TextVideoDraftDto['generation'] {
  return {
    enhancement: { state: 'not_created', staleReasons: [] },
    preflight: { state: 'not_created', staleReasons: [] }
  };
}

function emptyStoryboard(): TextVideoDraftDto['textToVideo']['storyboard'] {
  return {
    state: 'not_created',
    staleReasons: [],
    frameAssetIds: []
  };
}
