import { useEffect, useState } from 'react';
import {
  LuImage,
  LuImagePlus,
  LuPencil,
  LuSave,
  LuScanSearch,
  LuScanText,
  LuShieldCheck,
  LuSparkles
} from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../../components/StatusPill';
import type { ImagePreflightDto } from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceAnalysisStaleReasonDto,
  ImageWorkspaceDraftDto,
  ImageWorkspaceInputAssetDto,
  ImageWorkspaceObservationSetDto
} from '../../../shared/image-workspace-ipc';
import {
  emptyImageConfirmations,
  imageSubmissionErrorMessages,
  ImageSubmissionConfirmations
} from './ImageGenerationControls';
import { ImageRegionFields } from './ImageRegionFields';
import { ImageFeatureSubmissionPanel } from './ImageFeatureSubmissionPanel';

type UnderstandingDraftDto = Extract<
  ImageWorkspaceDraftDto,
  { readonly mode: 'image_understanding' }
>;

type UnderstandingTargetMode =
  | 'professional_image'
  | 'image_editing'
  | 'image_to_prompt';

interface ImageUnderstandingWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: UnderstandingDraftDto;
  readonly onDraftChange: (draft: UnderstandingDraftDto) => void;
  readonly onDraftPersisted: (draft: UnderstandingDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigate?: (mode: UnderstandingTargetMode) => void;
}

const observationSections: readonly {
  readonly key: keyof ImageWorkspaceObservationSetDto;
  readonly title: string;
  readonly description: string;
  readonly tone: StatusTone;
}[] = [
  {
    key: 'visibleFacts',
    title: '可见事实',
    description: '图片中可以直接看到的内容',
    tone: 'success'
  },
  {
    key: 'modelInferences',
    title: '模型推断',
    description: '基于图像的合理推断，仅供参考',
    tone: 'info'
  },
  {
    key: 'uncertainties',
    title: '不确定',
    description: '证据不足，无法确定的内容',
    tone: 'warning'
  },
  {
    key: 'unrecognized',
    title: '无法识别',
    description: '当前能力无法完成的内容',
    tone: 'neutral'
  }
];

const staleReasonLabels: Record<
  ImageWorkspaceAnalysisStaleReasonDto,
  string
> = {
  input_changed: '源图片已变化',
  region_changed: '识别区域已变化',
  purpose_changed: '识别目的已变化',
  requirements_changed: '识别要求已变化'
};

const understandingErrorMessages = {
  ...imageSubmissionErrorMessages,
  capability_unverified: '图片识别能力尚未验证。',
  parameter_schema_missing: '图片识别模型没有可用的能力 Schema。',
  adapter_unavailable: '没有配置真实图片识别适配器，当前不会外发或分析。'
};

export function ImageUnderstandingWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigate
}: ImageUnderstandingWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const imageSubmissions = window.unicomp?.imageSubmissions;
  const [input, setInput] = useState<ImageWorkspaceInputAssetDto>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [preflight, setPreflight] = useState<ImagePreflightDto>();
  const [selectedModelId, setSelectedModelId] = useState('');
  const [confirmations, setConfirmations] = useState(emptyImageConfirmations);
  const [revisionTargetId, setRevisionTargetId] = useState('');
  const [revisionContent, setRevisionContent] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === selectedModelId
  );
  const analysis = draft.understanding;

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
      if (active) onMessage('源图片读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, draft.input?.assetId, imageWorkspaces, onMessage]);

  useEffect(() => {
    setPreflight(undefined);
    setSelectedModelId('');
    setConfirmations(emptyImageConfirmations);
  }, [draft.updatedAt]);

  function changeDraft(next: UnderstandingDraftDto) {
    setPreflight(undefined);
    setSelectedModelId('');
    setConfirmations(emptyImageConfirmations);
    onDraftChange({
      ...next,
      state:
        next.understanding.analysisState === 'stale' ? 'stale' : 'editing'
    });
  }

  async function selectSource() {
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
      onDraftPersisted(result.value.draft as UnderstandingDraftDto);
      setInput(result.value.input);
      const preview = await imageWorkspaces.createInputPreview(draft.draftId);
      setPreviewUrl(preview.ok ? preview.value.url : '');
      onMessage('源图片已登记到当前项目；没有上传或自动分析。');
    } catch {
      onMessage('选择源图片失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function changePurpose(value: string) {
    if (!draft.input) return;
    changeDraft({
      ...draft,
      input: {
        ...draft.input,
        purpose: value.trim() ? value : undefined
      }
    });
  }

  async function checkRecognition() {
    if (!imageSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(understandingErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setSelectedModelId(result.value.candidates[0]?.modelId ?? '');
      setConfirmations(emptyImageConfirmations);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建识别任务。'
          : '检查通过：请核对并确认全部提交事实。'
      );
    } catch {
      onMessage('识别条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function addRevision() {
    const content = revisionContent.trim();
    if (
      !imageWorkspaces ||
      !content ||
      dirty ||
      busy ||
      analysis.analysisState === 'not_analyzed'
    ) return;
    setBusy(true);
    try {
      const result = await imageWorkspaces.addUnderstandingRevision({
        draftId: draft.draftId,
        expectedDraftUpdatedAt: draft.updatedAt,
        targetObservationId: revisionTargetId || undefined,
        content
      });
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onDraftPersisted(result.value as UnderstandingDraftDto);
      setRevisionTargetId('');
      setRevisionContent('');
      onMessage('用户修订已独立保存，模型原始结果未被覆盖。');
    } catch {
      onMessage('保存修订失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function deriveDraft(targetMode: UnderstandingTargetMode) {
    if (!imageWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.deriveFromResult(
        draft.draftId,
        draft.updatedAt,
        analysis.resultRevision,
        targetMode
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onMessage('已创建派生草稿；没有创建或提交任务。');
      onNavigate?.(targetMode);
    } catch {
      onMessage('创建派生草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const targetObservation = observationSections
    .flatMap((section) => analysis.observations[section.key])
    .find((observation) => observation.id === revisionTargetId);

  return (
    <>
      <div className="uc-image-understanding__layout">
        <div className="uc-image-understanding__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>源图片与识别范围</h2>
              <p>只处理一张经过主进程授权的本地图片。</p>
            </div>
          </header>
          <div className="uc-image-quick__reference">
            <div>
              <strong>单张源图片</strong>
              <span>
                {input
                  ? `${input.name} · ${input.width} × ${input.height}`
                  : '选择图片不会自动上传、分析或创建任务。'}
              </span>
            </div>
            <Button
              disabled={!imageWorkspaces || dirty || busy}
              onClick={() => void selectSource()}
              variant="secondary"
            >
              <LuImagePlus aria-hidden="true" />
              {input ? '重新选择图片' : '选择一张图片'}
            </Button>
          </div>
          <label className="uc-image-quick__field">
            <span>识别目的或自定义问题</span>
            <textarea
              disabled={!draft.input}
              maxLength={500}
              onChange={(event) => changePurpose(event.target.value)}
              placeholder="例如：提取画面中的可见文字，并说明哪些内容无法确认"
              rows={4}
              value={draft.input?.purpose ?? ''}
            />
            <small>{draft.input?.purpose?.length ?? 0} / 500</small>
          </label>
          <ImageRegionFields
            disabled={!draft.input}
            label="启用区域识别（不勾选时识别全图）"
            onChange={(region) => {
              if (draft.input) {
                changeDraft({
                  ...draft,
                  input: { ...draft.input, region }
                });
              }
            }}
            region={draft.input?.region}
          />
          <label className="uc-image-quick__field">
            <span>结果保存范围</span>
            <select
              onChange={(event) =>
                changeDraft({
                  ...draft,
                  understanding: {
                    ...analysis,
                    saveScope: event.target.value as
                      | 'draft_only'
                      | 'project_context'
                  }
                })
              }
              value={analysis.saveScope}
            >
              <option value="draft_only">仅保存到当前草稿</option>
              <option value="project_context">标记为项目上下文</option>
            </select>
          </label>
          <p className="uc-image-quick__hint">
            “项目上下文”当前只记录保存范围；项目上下文登记端口尚未提供。
          </p>
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再选择图片或检查识别条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-understanding__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>图片预览与区域</h2>
              <p>虚线框表示当前草稿保存的归一化识别区域。</p>
            </div>
          </header>
          {previewUrl ? (
            <figure className="uc-image-understanding__preview">
              <div>
                <img alt={`源图片：${input?.name ?? '本地图片'}`} src={previewUrl} />
                {draft.input?.region ? (
                  <span
                    aria-label="当前识别区域"
                    style={{
                      left: `${draft.input.region.x * 100}%`,
                      top: `${draft.input.region.y * 100}%`,
                      width: `${draft.input.region.width * 100}%`,
                      height: `${draft.input.region.height * 100}%`
                    }}
                  />
                ) : null}
              </div>
              <figcaption>受控本地预览，不代表识别结果。</figcaption>
            </figure>
          ) : (
            <EmptyState
              description="选择一张源图片后，这里会显示受控本地预览。"
              icon="图"
              readOnly
              title="尚未选择源图片"
            />
          )}
        </Card>

        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>识别服务与透明信息</h2>
              <p>模型和外发范围只来自真实能力预检。</p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onDraftPersisted={onDraftPersisted}
            onMessage={onMessage}
          />
          <div className="uc-image-specialized__legacy-submission">
          <Button
            disabled={!imageSubmissions || !draft.input || dirty || busy}
            onClick={() => void checkRecognition()}
            variant="secondary"
          >
            <LuShieldCheck aria-hidden="true" />
            检查识别条件
          </Button>
          {preflight ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {preflight.blockers.length
                  ? '当前无法开始识别'
                  : '识别条件已通过'}
              </strong>
              {preflight.blockers.map((blocker) => (
                <span key={blocker}>
                  · {understandingErrorMessages[blocker]}
                </span>
              ))}
            </div>
          ) : null}
          {preflight?.candidates.length ? (
            <label className="uc-image-quick__field">
              <span>图片识别模型</span>
              <select
                onChange={(event) => {
                  setSelectedModelId(event.target.value);
                  setConfirmations(emptyImageConfirmations);
                }}
                value={selectedModelId}
              >
                {preflight.candidates.map((candidate) => (
                  <option key={candidate.modelId} value={candidate.modelId}>
                    {candidate.modelName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selectedCandidate ? (
            <ImageSubmissionConfirmations
              candidate={selectedCandidate}
              confirmations={confirmations}
              finalPrompt={
                draft.input?.purpose ?? '未填写，自全图整理可确认信息'
              }
              onChange={setConfirmations}
              promptLabel="识别目的"
            />
          ) : null}
          <Button disabled>
            <LuScanSearch aria-hidden="true" />
            开始识别
          </Button>
          <p className="uc-image-quick__hint">
            当前没有真实图片识别适配器；不会创建任务、上传图片或伪造结果。
          </p>
          </div>
        </Card>
        </div>

        <Card className="uc-image-understanding__results">
        <header className="uc-image-understanding__results-heading">
          <div>
            <h2>结构化识别结果</h2>
            <p>模型原始结果与用户修改记录分别保存，互不覆盖。</p>
          </div>
          <StatusPill
            tone={
              analysis.analysisState === 'current'
                ? 'success'
                : analysis.analysisState === 'stale'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {analysis.analysisState === 'current'
              ? '结果有效'
              : analysis.analysisState === 'stale'
                ? '结果已过期'
                : '尚未分析'}
          </StatusPill>
        </header>
        {analysis.analysisState === 'stale' ? (
          <div className="uc-image-quick__preflight" role="status">
            <strong>旧结果仅供参考，请重新识别</strong>
            {analysis.staleReasons.map((reason) => (
              <span key={reason}>· {staleReasonLabels[reason]}</span>
            ))}
          </div>
        ) : null}
        <div className="uc-image-understanding__result-grid">
          {observationSections.map((section) => (
            <section key={section.key}>
              <div>
                <StatusPill tone={section.tone}>{section.title}</StatusPill>
                <span>{section.description}</span>
              </div>
              {analysis.observations[section.key].length ? (
                <ul>
                  {analysis.observations[section.key].map((observation) => (
                    <li key={observation.id}>
                      <span>{observation.content}</span>
                      <Button
                        onClick={() => {
                          setRevisionTargetId(observation.id);
                          setRevisionContent('');
                        }}
                        variant="ghost"
                      >
                        <LuPencil aria-hidden="true" />
                        修订此项
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>当前没有此类真实结果。</p>
              )}
            </section>
          ))}
          <section>
            <div>
              <StatusPill tone="info">用户修改</StatusPill>
              <span>保留独立修订记录，不覆盖模型原始结论</span>
            </div>
            {analysis.userRevisions.length ? (
              <ul>
                {analysis.userRevisions.map((revision) => (
                  <li key={revision.id}>
                    <span>{revision.content}</span>
                    <small>
                      {revision.targetObservationId
                        ? `修订目标：${revision.targetObservationId}`
                        : '补充说明'}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>当前没有用户修改记录。</p>
            )}
          </section>
        </div>
        <div className="uc-image-understanding__revision">
          <label className="uc-image-quick__field">
            <span>修改记录</span>
            <textarea
              disabled={analysis.analysisState === 'not_analyzed'}
              maxLength={500}
              onChange={(event) => setRevisionContent(event.target.value)}
              placeholder={
                targetObservation
                  ? `修订：${targetObservation.content}`
                  : '选择“修订此项”，或直接添加一条补充说明'
              }
              rows={3}
              value={revisionContent}
            />
          </label>
          <Button
            disabled={
              analysis.analysisState === 'not_analyzed' ||
              !revisionContent.trim()
            }
            onClick={() => void addRevision()}
            variant="secondary"
          >
            <LuSave aria-hidden="true" />
            保存为独立修订
          </Button>
        </div>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice">
        <StatusPill tone="warning">后续操作</StatusPill>
        <p>切换模式只创建派生草稿，不会自动创建或提交任务。</p>
        <div className="uc-image-quick__result-actions">
          <Button
            disabled={dirty || busy}
            onClick={() => void deriveDraft('image_to_prompt')}
            variant="secondary"
          >
            <LuScanText aria-hidden="true" />
            转为提示词草稿
          </Button>
          <Button
            disabled={!draft.input || dirty || busy}
            onClick={() => void deriveDraft('image_editing')}
            variant="secondary"
          >
            <LuImage aria-hidden="true" />
            进入图片编辑
          </Button>
          <Button
            disabled={dirty || busy}
            onClick={() => void deriveDraft('professional_image')}
            variant="secondary"
          >
            <LuSparkles aria-hidden="true" />
            进入专业生图
          </Button>
        </div>
      </Card>
    </>
  );
}
