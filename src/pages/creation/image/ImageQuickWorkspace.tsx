import { useEffect, useState } from 'react';
import {
  LuArrowRight,
  LuBadgeCheck,
  LuCircleDollarSign,
  LuCirclePlay,
  LuCloud,
  LuFolderInput,
  LuImagePlus,
  LuListPlus,
  LuRefreshCw,
  LuShieldCheck,
  LuSparkles,
  LuVideo
} from 'react-icons/lu';
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
import { useImageSubmissionFlow } from './useImageSubmissionFlow';

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
  const [inputPreviewUrl, setInputPreviewUrl] = useState('');
  const [preflight, setPreflight] = useState<ImagePreflightDto>();
  const [confirmations, setConfirmations] = useState(emptyImageConfirmations);
  const [busy, setBusy] = useState(false);
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === draft.generation.model?.modelId
  );
  const outboundScope = selectedCandidate
    ? {
        local_device: '仅在本机处理',
        local_network: '仅在局域网处理',
        external_service: '将发送到外部服务',
        unknown: '发送范围未知'
      }[selectedCandidate.outboundScope]
    : '检查后确认发送范围';
  const submission = useImageSubmissionFlow({
    draftId: draft.draftId,
    draftUpdatedAt: draft.updatedAt,
    preflight,
    candidate: selectedCandidate,
    confirmations,
    busy,
    setBusy,
    onMessage,
    errorMessages: submissionErrorMessages
  });

  useEffect(() => {
    let active = true;
    setInput(undefined);
    setInputPreviewUrl('');
    if (!imageWorkspaces || !draft.input) return;

    async function loadInput() {
      const [inputResult, previewResult] = await Promise.all([
        imageWorkspaces!.getInput(draft.draftId),
        imageWorkspaces!.createInputPreview(draft.draftId)
      ]);
      if (!active) return;
      if (inputResult.ok) setInput(inputResult.value);
      if (previewResult.ok) setInputPreviewUrl(previewResult.value.url);
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
      setInputPreviewUrl(preview.ok ? preview.value.url : '');
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
      <div className="uc-image-workbench__workspace uc-image-quick__workspace">
        <Card className="uc-image-workbench__panel uc-image-quick__composer">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>输入一句话，UniComp AI 为你生成图片</h2>
              <p>支持自然语言描述和一张可选参考图。</p>
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
          <div className="uc-image-quick__composer-actions">
            <div className="uc-image-quick__reference">
              {inputPreviewUrl ? (
                <img
                  alt={`参考图：${input?.name ?? '本地图片'}`}
                  className="uc-image-quick__reference-preview"
                  src={inputPreviewUrl}
                />
              ) : null}
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
                <LuImagePlus aria-hidden="true" />
                {input ? '重新选择参考图' : '添加参考图'}
              </Button>
            </div>
            <Button
              className="uc-image-quick__primary-action"
              disabled={!imageSubmissions || dirty || busy}
              onClick={() => void checkSubmission()}
            >
              <LuSparkles aria-hidden="true" />
              检查并准备生成
            </Button>
          </div>
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再选择图片或检查提交条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-quick__delivery-strip">
          <div>
            <LuCloud aria-hidden="true" />
            <span>将发送至</span>
            <strong>{selectedCandidate?.recipientName ?? '检查后确认接收方'}</strong>
            <small>{selectedCandidate?.modelName ?? '模型尚未确认'}</small>
          </div>
          <div>
            <LuCircleDollarSign aria-hidden="true" />
            <span>费用状态</span>
            <strong>未知</strong>
            <small>以服务商账单为准</small>
          </div>
          <div>
            <LuShieldCheck aria-hidden="true" />
            <span>数据离开本机</span>
            <strong>{outboundScope}</strong>
            <small>提交前必须再次确认</small>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-image-quick__inspector">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>服务、参数与提交确认</h2>
              <p>所有动态能力、费用、外发范围和阻断原因均来自真实预检。</p>
            </div>
          </header>
          <ImageGenerationModelFields
            draft={draft}
            onDraftChange={changeDraft}
            registry={registry}
          />
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
            <Button
              disabled={!submission.canCreateTask}
              onClick={() => void submission.createTask()}
            >
              <LuListPlus aria-hidden="true" />
              创建图片任务
            </Button>
            <Button
              disabled={!submission.task || busy}
              onClick={() => void submission.createExecution()}
              variant="secondary"
            >
              <LuCirclePlay aria-hidden="true" />
              创建执行记录
            </Button>
            <Button
              disabled={!submission.execution || submission.execution.state !== 'created' || busy}
              onClick={() => void submission.invokeExecution()}
            >
              <LuSparkles aria-hidden="true" />
              提交图片生成
            </Button>
            <Button
              disabled={!submission.execution || submission.execution.state !== 'remote_completed' || busy}
              onClick={() => void submission.receiveResult()}
              variant="secondary"
            >
              <LuBadgeCheck aria-hidden="true" />
              校验并登记结果
            </Button>
            <Button
              disabled={!submission.work || busy}
              onClick={() => void submission.createVideoDraft()}
              variant="secondary"
            >
              <LuVideo aria-hidden="true" />
              创建图生视频草稿
            </Button>
          </div>
          {submission.execution ? (
            <p className="uc-image-quick__hint" role="status">
              执行 #{submission.execution.attempt}：{submission.execution.state}
              {submission.work ? `；已登记 ${submission.work.name}` : ''}
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-image-quick__stage">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>生成结果</h2>
              <p>只显示主进程登记的真实结果；参考图不会出现在这里。</p>
            </div>
          </header>
          <EmptyState
            description={
              submission.work
                ? `${submission.work.name} 已校验并登记；当前结果接口未提供本地预览。`
                : '完成真实提交并接收结果后，生成图片会显示在这里。'
            }
            icon="画"
            readOnly
            title={
              submission.work
                ? '结果已登记，暂无本地预览'
                : '尚无真实生成结果'
            }
          />
          <div className="uc-image-quick__result-actions">
            <Button disabled variant="secondary">
              <LuRefreshCw aria-hidden="true" />
              重新生成
            </Button>
            <Button disabled variant="secondary">
              <LuFolderInput aria-hidden="true" />
              {submission.work ? '已登记到项目' : '保存到项目'}
            </Button>
            <Button
              disabled={dirty || busy}
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
        <StatusPill tone={preflight?.blockers.length === 0 ? 'success' : 'warning'}>
          {preflight?.blockers.length === 0 ? '等待明确确认' : '真实能力状态'}
        </StatusPill>
        <p>
          图片提交和结果接收只在注册表、凭证与能力门禁全部通过后可用；页面不会显示假进度或未校验结果。
        </p>
      </Card>
    </>
  );
}
