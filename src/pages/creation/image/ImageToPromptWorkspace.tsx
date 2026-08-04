import { useEffect, useState } from 'react';
import {
  LuImage,
  LuImagePlus,
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

type ImageToPromptDraftDto = Extract<
  ImageWorkspaceDraftDto,
  { readonly mode: 'image_to_prompt' }
>;

type PromptTargetMode = 'professional_image' | 'image_editing';

interface ImageToPromptWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: ImageToPromptDraftDto;
  readonly onDraftChange: (draft: ImageToPromptDraftDto) => void;
  readonly onDraftPersisted: (draft: ImageToPromptDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigate?: (mode: PromptTargetMode) => void;
}

const resultSections: readonly {
  readonly key: keyof ImageWorkspaceObservationSetDto;
  readonly title: string;
  readonly description: string;
  readonly tone: StatusTone;
}[] = [
  {
    key: 'visibleFacts',
    title: '图片可见事实',
    description: '图片中能够直接确认的内容',
    tone: 'success'
  },
  {
    key: 'modelInferences',
    title: '模型推断',
    description: '基于画面的推断，仅供参考',
    tone: 'info'
  },
  {
    key: 'uncertainties',
    title: '不确定项',
    description: '证据不足，需要用户判断',
    tone: 'warning'
  },
  {
    key: 'unrecognized',
    title: '无法识别',
    description: '当前能力无法确认的内容',
    tone: 'neutral'
  }
];

const staleReasonLabels: Record<
  ImageWorkspaceAnalysisStaleReasonDto,
  string
> = {
  input_changed: '源图片已变化',
  region_changed: '分析区域已变化',
  purpose_changed: '目标用途已变化',
  requirements_changed: '补充要求已变化'
};

const promptErrorMessages = {
  ...imageSubmissionErrorMessages,
  capability_unverified: '图片转提示词能力尚未验证。',
  parameter_schema_missing: '图片转提示词模型没有可用的能力 Schema。',
  adapter_unavailable:
    '没有配置真实图片转提示词适配器，当前不会外发或生成提示词。'
};

export function ImageToPromptWorkspace({
  dirty,
  draft,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigate
}: ImageToPromptWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const imageSubmissions = window.unicomp?.imageSubmissions;
  const [input, setInput] = useState<ImageWorkspaceInputAssetDto>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [preflight, setPreflight] = useState<ImagePreflightDto>();
  const [selectedModelId, setSelectedModelId] = useState('');
  const [confirmations, setConfirmations] = useState(emptyImageConfirmations);
  const [busy, setBusy] = useState(false);
  const analysis = draft.imageToPrompt;
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === selectedModelId
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

  function changeDraft(next: ImageToPromptDraftDto) {
    setPreflight(undefined);
    setSelectedModelId('');
    setConfirmations(emptyImageConfirmations);
    onDraftChange({
      ...next,
      state: next.imageToPrompt.analysisState === 'stale' ? 'stale' : 'editing'
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
      onDraftPersisted(result.value.draft as ImageToPromptDraftDto);
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
    changeDraft({
      ...draft,
      imageToPrompt: { ...analysis, purpose: value }
    });
  }

  function changeRequirements(value: string) {
    changeDraft({
      ...draft,
      imageToPrompt: {
        ...analysis,
        requirements: value
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
      }
    });
  }

  async function checkAnalysis() {
    if (!imageSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(promptErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setSelectedModelId(result.value.candidates[0]?.modelId ?? '');
      setConfirmations(emptyImageConfirmations);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建分析任务。'
          : '检查通过：请核对并确认全部提交事实。'
      );
    } catch {
      onMessage('分析条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function deriveDraft(targetMode: PromptTargetMode) {
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

  const hasResults = resultSections.some(
    (section) => analysis.observations[section.key].length > 0
  );

  return (
    <>
      <div className="uc-image-to-prompt__layout">
        <div className="uc-image-to-prompt__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>源图片与分析设置</h2>
              <p>单次只处理一张经过主进程授权的本地图片。</p>
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
              {input ? '更换图片' : '选择一张图片'}
            </Button>
          </div>
          <label className="uc-image-quick__field">
            <span>目标用途</span>
            <textarea
              maxLength={500}
              onChange={(event) => changePurpose(event.target.value)}
              placeholder="例如：用于专业生图，保留真实构图和光线"
              rows={4}
              value={analysis.purpose}
            />
            <small>{analysis.purpose.length} / 500</small>
          </label>
          <label className="uc-image-quick__field">
            <span>补充要求（每行一项）</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changeRequirements(event.target.value)}
              placeholder="例如：&#10;保留人物和雪山&#10;排除文字与水印"
              rows={5}
              value={analysis.requirements.join('\n')}
            />
          </label>
          <ImageRegionFields
            disabled={!draft.input}
            label="启用分析区域（不勾选时分析全图）"
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
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再更换图片或检查分析条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>图片预览与分析范围</h2>
              <p>虚线框表示当前草稿保存的归一化分析区域。</p>
            </div>
          </header>
          {previewUrl ? (
            <figure className="uc-image-understanding__preview">
              <div>
                <img alt={`提示词源图：${input?.name ?? '本地图片'}`} src={previewUrl} />
                {draft.input?.region ? (
                  <span
                    aria-label="当前分析区域"
                    style={{
                      left: `${draft.input.region.x * 100}%`,
                      top: `${draft.input.region.y * 100}%`,
                      width: `${draft.input.region.width * 100}%`,
                      height: `${draft.input.region.height * 100}%`
                    }}
                  />
                ) : null}
              </div>
              <figcaption>受控本地预览，不代表分析或生成结果。</figcaption>
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
              <h2>分析服务与外发确认</h2>
              <p>模型、接收方和费用只来自真实能力预检。</p>
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
            disabled={
              !imageSubmissions ||
              !draft.input ||
              !analysis.purpose.trim() ||
              dirty ||
              busy
            }
            onClick={() => void checkAnalysis()}
            variant="secondary"
          >
            <LuShieldCheck aria-hidden="true" />
            检查分析条件
          </Button>
          {preflight ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {preflight.blockers.length
                  ? '当前无法开始分析'
                  : '分析条件已通过'}
              </strong>
              {preflight.blockers.map((blocker) => (
                <span key={blocker}>· {promptErrorMessages[blocker]}</span>
              ))}
            </div>
          ) : null}
          {preflight?.candidates.length ? (
            <label className="uc-image-quick__field">
              <span>图片转提示词模型</span>
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
              finalPrompt={analysis.purpose}
              onChange={setConfirmations}
              promptLabel="目标用途"
            />
          ) : null}
          <Button disabled>
            <LuScanText aria-hidden="true" />
            {analysis.analysisState === 'stale'
              ? '重新分析并更新草稿'
              : '分析图片并生成提示词草稿'}
          </Button>
          <p className="uc-image-quick__hint">
            当前没有真实图片转提示词适配器；不会创建任务、上传图片或伪造草稿。
          </p>
          </div>
        </Card>
        </div>

        <Card className="uc-image-to-prompt__results">
        <header className="uc-image-understanding__results-heading">
          <div>
            <h2>分析结果与提示词草稿</h2>
            <p>事实、推断、不确定项、系统补充和最终草稿互不覆盖。</p>
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
              ? '分析结果有效'
              : analysis.analysisState === 'stale'
                ? '分析结果已过期'
                : '尚未分析'}
          </StatusPill>
        </header>
        {analysis.analysisState === 'stale' ? (
          <div className="uc-image-quick__preflight" role="status">
            <strong>旧分析与旧草稿仅供参考</strong>
            {analysis.staleReasons.map((reason) => (
              <span key={reason}>· {staleReasonLabels[reason]}</span>
            ))}
          </div>
        ) : null}
        {!hasResults && analysis.analysisState === 'not_analyzed' ? (
          <EmptyState
            description="完成真实能力预检并接入分析适配器后，结果才会出现在这里。"
            icon="析"
            readOnly
            title="图片已加载，尚未分析"
          />
        ) : (
          <div className="uc-image-to-prompt__result-grid">
            {resultSections.map((section) => (
              <section key={section.key}>
                <div>
                  <StatusPill tone={section.tone}>{section.title}</StatusPill>
                  <span>{section.description}</span>
                </div>
                {analysis.observations[section.key].length ? (
                  <ul>
                    {analysis.observations[section.key].map((observation) => (
                      <li key={observation.id}>{observation.content}</li>
                    ))}
                  </ul>
                ) : (
                  <p>当前没有此类真实结果。</p>
                )}
              </section>
            ))}
            <section>
              <div>
                <StatusPill tone="info">系统补充</StatusPill>
                <span>由真实分析过程追加的结构化建议</span>
              </div>
              {draft.prompt.systemSupplements.length ? (
                <ul>
                  {draft.prompt.systemSupplements.map((supplement, index) => (
                    <li key={`${supplement.source}-${index}`}>
                      {supplement.content}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>当前没有真实系统补充。</p>
              )}
            </section>
          </div>
        )}
        <label className="uc-image-quick__field">
          <span>最终提示词草稿（可编辑）</span>
          <textarea
            disabled={analysis.analysisState === 'not_analyzed'}
            maxLength={3000}
            onChange={(event) =>
              changeDraft({
                ...draft,
                prompt: {
                  ...draft.prompt,
                  finalPrompt: event.target.value
                }
              })
            }
            placeholder="真实分析结果生成后，可在这里检查和编辑提示词草稿"
            rows={10}
            value={draft.prompt.finalPrompt}
          />
          <small>{draft.prompt.finalPrompt.length} / 3000</small>
        </label>
        <p className="uc-image-quick__hint">
          使用页面顶部“保存本地草稿”保存修改；提示词草稿不是作品，也不会自动生成图片。
        </p>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice">
        <StatusPill tone="warning">后续操作</StatusPill>
        <p>切换模式只创建派生草稿，不会自动创建或提交任务。</p>
        <div className="uc-image-quick__result-actions">
          <Button
            disabled={dirty || busy}
            onClick={() => void deriveDraft('professional_image')}
            variant="secondary"
          >
            <LuSparkles aria-hidden="true" />
            进入专业生图草稿
          </Button>
          <Button
            disabled={!draft.input || dirty || busy}
            onClick={() => void deriveDraft('image_editing')}
            variant="secondary"
          >
            <LuImage aria-hidden="true" />
            进入图片编辑草稿
          </Button>
        </div>
      </Card>
    </>
  );
}
