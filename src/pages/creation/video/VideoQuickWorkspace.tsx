import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import type {
  VideoExecutionDto,
  VideoPreflightDto,
  VideoTaskCreatedDto
} from '../../../shared/video-submission-ipc';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceMaterialAssetDto,
  VideoWorkspaceMaterialPreviewDto
} from '../../../shared/video-workspace-ipc';
import {
  allVideoConfirmationsAccepted,
  emptyVideoConfirmations,
  VideoGenerationModelFields,
  videoSubmissionErrorMessages,
  VideoSubmissionConfirmations
} from './VideoGenerationControls';

type QuickVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'quick_video' }
>;

interface VideoQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: QuickVideoDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: QuickVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: QuickVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToTextToVideo?: () => void;
}

const quickReferenceTarget = { kind: 'quick_reference' } as const;

export function VideoQuickWorkspace({
  dirty,
  draft,
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigateToTextToVideo
}: VideoQuickWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const videoSubmissions = window.unicomp?.videoSubmissions;
  const [material, setMaterial] = useState<VideoWorkspaceMaterialAssetDto>();
  const [preview, setPreview] = useState<VideoWorkspaceMaterialPreviewDto>();
  const [preflight, setPreflight] = useState<VideoPreflightDto>();
  const [confirmations, setConfirmations] = useState(emptyVideoConfirmations);
  const [task, setTask] = useState<VideoTaskCreatedDto>();
  const [execution, setExecution] = useState<VideoExecutionDto>();
  const [busy, setBusy] = useState(false);
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === draft.generation.model?.modelId
  );
  const selectedEvidence = registry?.capabilities.find(
    (capability) =>
      capability.evidenceId ===
      draft.generation.model?.capabilityEvidenceId
  );
  const quickSchema = selectedEvidence?.videoGenerationSchema?.modes.find(
    (mode) => mode.mode === 'quick_video'
  );
  const acceptedMediaKinds =
    quickSchema?.mode === 'quick_video'
      ? (quickSchema.reference?.acceptedMediaKinds ?? [])
      : [];
  const blockers = [
    ...(preflight?.blockers ?? []),
    ...(selectedCandidate?.blockers ?? [])
  ].filter((blocker, index, items) => items.indexOf(blocker) === index);

  useEffect(() => {
    let active = true;
    setMaterial(undefined);
    setPreview(undefined);
    if (!videoWorkspaces || !draft.quick.reference) return;

    async function loadReference() {
      const [materialResult, previewResult] = await Promise.all([
        videoWorkspaces!.getMaterial(draft.draftId, quickReferenceTarget),
        videoWorkspaces!.createMaterialPreview(
          draft.draftId,
          quickReferenceTarget
        )
      ]);
      if (!active) return;
      if (materialResult.ok) setMaterial(materialResult.value);
      if (previewResult.ok) setPreview(previewResult.value);
    }

    void loadReference().catch(() => {
      if (active) onMessage('参考素材读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [
    draft.draftId,
    draft.quick.reference?.assetId,
    onMessage,
    videoWorkspaces
  ]);

  useEffect(() => {
    setPreflight(undefined);
    setConfirmations(emptyVideoConfirmations);
    setTask(undefined);
    setExecution(undefined);
  }, [draft.updatedAt]);

  function changeDraft(next: QuickVideoDraftDto) {
    setPreflight(undefined);
    setConfirmations(emptyVideoConfirmations);
    setTask(undefined);
    setExecution(undefined);
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

  async function selectReference(mediaKind: 'image' | 'video') {
    if (!videoWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoWorkspaces.selectMaterial(
        draft.draftId,
        quickReferenceTarget,
        mediaKind
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      onDraftPersisted(result.value.draft as QuickVideoDraftDto);
      setMaterial(result.value.material);
      const previewResult = await videoWorkspaces.createMaterialPreview(
        draft.draftId,
        quickReferenceTarget
      );
      setPreview(previewResult.ok ? previewResult.value : undefined);
      onMessage(
        '参考素材已在当前项目登记；没有上传、分析、识别或创建任务。'
      );
    } catch {
      onMessage('选择参考素材失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearReference() {
    if (!videoWorkspaces || dirty || busy || !draft.quick.reference) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoWorkspaces.clearMaterial(
        draft.draftId,
        quickReferenceTarget
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onDraftPersisted(result.value as QuickVideoDraftDto);
      setMaterial(undefined);
      setPreview(undefined);
      onMessage('参考素材已从当前草稿移除；历史素材登记没有被删除。');
    } catch {
      onMessage('移除参考素材失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function checkSubmission() {
    if (!videoSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setConfirmations(emptyVideoConfirmations);
      setTask(undefined);
      setExecution(undefined);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建任务。'
          : '检查完成：请核对候选模型的阻断项和全部提交事实。'
      );
    } catch {
      onMessage('提交条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    if (
      !videoSubmissions ||
      !preflight ||
      !selectedCandidate ||
      blockers.length ||
      !allVideoConfirmationsAccepted(confirmations) ||
      busy
    ) {
      return;
    }
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.createTask(
        draft.draftId,
        preflight.draftUpdatedAt,
        selectedCandidate.modelId,
        confirmations
      );
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setTask(result.value);
      setExecution(undefined);
      onMessage('视频任务已创建；尚未创建执行记录，也没有调用远端。');
    } catch {
      onMessage('创建视频任务失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function createExecution() {
    if (!videoSubmissions || !task || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.createExecution(task.taskId);
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setExecution(result.value);
      onMessage('本地执行记录已创建；尚未调用远端视频服务。');
    } catch {
      onMessage('创建执行记录失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function invokeExecution() {
    if (!videoSubmissions || !execution || execution.state !== 'created' || busy)
      return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.invokeExecution(
        execution.executionId
      );
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setExecution(result.value);
      onMessage(`远端调用已返回真实状态：${result.value.state}。`);
    } catch {
      onMessage('提交视频生成失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function enterTextToVideo() {
    if (!videoWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoWorkspaces.derive(
        draft.draftId,
        'text_to_video'
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onMessage('已创建文生视频派生草稿；没有创建或提交视频任务。');
      onNavigateToTextToVideo?.();
    } catch {
      onMessage('创建文生视频派生草稿失败，请重试。');
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
              <p>快速模式不自动增强，原始输入与最终提示词同步保存。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的视频</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changePrompt(event.target.value)}
              placeholder="例如：雪山日落下的露营短视频，镜头缓慢推进"
              rows={6}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>

          <div className="uc-image-quick__reference">
            <div>
              <strong>单个参考素材（可选）</strong>
              <span>
                {material
                  ? `${material.name} · ${material.width} × ${material.height}`
                  : acceptedMediaKinds.length
                    ? `当前能力接受：${acceptedMediaKinds
                        .map((kind) => (kind === 'image' ? '图片' : '视频'))
                        .join('、')}`
                    : draft.generation.model
                      ? '当前模型能力未声明可用参考素材。'
                      : '先选择模型，素材类型才能由动态能力决定。'}
              </span>
            </div>
            <div className="uc-image-quick__result-actions">
              {acceptedMediaKinds.includes('image') ? (
                <Button
                  disabled={dirty || busy}
                  onClick={() => void selectReference('image')}
                  variant="secondary"
                >
                  选择图片
                </Button>
              ) : null}
              {acceptedMediaKinds.includes('video') ? (
                <Button
                  disabled={dirty || busy}
                  onClick={() => void selectReference('video')}
                  variant="secondary"
                >
                  选择视频
                </Button>
              ) : null}
              {draft.quick.reference ? (
                <Button
                  disabled={dirty || busy}
                  onClick={() => void clearReference()}
                  variant="secondary"
                >
                  移除素材
                </Button>
              ) : null}
            </div>
          </div>
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再选择素材或检查提交条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>参考预览与结果</h2>
              <p>只显示受控本地素材和正式登记的真实视频结果。</p>
            </div>
          </header>
          {preview?.mediaKind === 'image' ? (
            <figure className="uc-image-quick__preview">
              <img
                alt={`参考素材：${material?.name ?? '本地图片'}`}
                src={preview.url}
              />
              <figcaption>受控本地图片预览，不代表生成结果。</figcaption>
            </figure>
          ) : preview?.mediaKind === 'video' ? (
            <figure className="uc-image-quick__preview">
              <video controls preload="metadata" src={preview.url}>
                当前环境不支持视频预览。
              </video>
              <figcaption>受控本地视频预览，不代表生成结果。</figcaption>
            </figure>
          ) : (
            <EmptyState
              description="参考素材不是必填项；B4 正式登记端口已具备，当前没有真实适配器返回的视频结果。"
              icon="视"
              readOnly
              title="尚无真实视频结果"
            />
          )}
          <p className="uc-image-quick__hint">
            结果数量不设固定默认值，只接受当前模型能力事实。
          </p>
          <div className="uc-image-quick__result-actions">
            <Button disabled variant="secondary">
              重新生成（等待真实结果）
            </Button>
            <Button disabled variant="secondary">
              保存结果（等待真实结果）
            </Button>
            <Button
              disabled={dirty || busy}
              onClick={() => void enterTextToVideo()}
              variant="secondary"
            >
              进入文生视频
            </Button>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>模型、预检与提交</h2>
              <p>动态参数和阻断原因全部来自本机真实能力 DTO。</p>
            </div>
          </header>
          <VideoGenerationModelFields
            mode="quick_video"
            model={draft.generation.model}
            onChange={(selection) =>
              changeDraft({
                ...draft,
                generation: {
                  ...draft.generation,
                  model: selection.model,
                  parameters: selection.parameters
                }
              })
            }
            parameters={draft.generation.parameters}
            registry={registry}
          />
          <Button
            disabled={!videoSubmissions || dirty || busy}
            onClick={() => void checkSubmission()}
            variant="secondary"
          >
            检查提交条件
          </Button>
          {preflight ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {blockers.length ? '当前无法提交' : '提交条件已通过'}
              </strong>
              {blockers.map((blocker) => (
                <span key={blocker}>
                  • {videoSubmissionErrorMessages[blocker]}
                </span>
              ))}
            </div>
          ) : null}
          {selectedCandidate ? (
            <VideoSubmissionConfirmations
              candidate={selectedCandidate}
              confirmations={confirmations}
              finalPrompt={draft.prompt.finalPrompt}
              materialSummary={
                material ? `1 个受控素材：${material.name}` : '未选择参考素材'
              }
              onChange={setConfirmations}
            />
          ) : null}
          <div className="uc-image-quick__submission-actions">
            <Button
              disabled={
                !preflight ||
                !selectedCandidate ||
                blockers.length > 0 ||
                !allVideoConfirmationsAccepted(confirmations) ||
                Boolean(task) ||
                busy
              }
              onClick={() => void createTask()}
              variant="secondary"
            >
              创建视频任务
            </Button>
            <Button
              disabled={!task || Boolean(execution) || busy}
              onClick={() => void createExecution()}
              variant="secondary"
            >
              创建执行记录
            </Button>
            <Button
              disabled={!execution || execution.state !== 'created' || busy}
              onClick={() => void invokeExecution()}
            >
              提交视频生成
            </Button>
          </div>
          {task ? (
            <p className="uc-image-quick__hint" role="status">
              本地任务已创建
              {execution
                ? `；执行 #${execution.attempt}：${execution.state}`
                : '；尚未创建执行记录'}
            </p>
          ) : null}
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone={blockers.length === 0 && preflight ? 'success' : 'warning'}>
          {blockers.length === 0 && preflight ? '等待明确确认' : '真实能力状态'}
        </StatusPill>
        <p>
          默认没有真实视频适配器，只允许保存草稿和查看阻断原因；不会伪造进度、费用、结果或成功状态。
        </p>
      </Card>
    </>
  );
}
