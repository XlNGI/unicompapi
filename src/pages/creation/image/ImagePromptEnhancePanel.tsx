import { useEffect, useState } from 'react';
import { LuSend, LuShieldCheck, LuSparkles } from 'react-icons/lu';
import { Checkbox } from 'rsuite';
import { Button } from '../../../components/Button';
import {
  DynamicParameterForm,
  toDynamicParameterFields,
  type DynamicParameterValue
} from '../../../components/DynamicParameterForm';
import { ModelSelect } from '../../../components/ModelSelect';
import {
  SubmissionProgressSteps,
  type SubmissionProgressPhase
} from '../../../components/SubmissionProgressSteps';
import { StatusPill } from '../../../components/StatusPill';
import type {
  ImagePromptEnhanceCandidateDto,
  ImagePromptEnhanceIpcErrorCode,
  ImagePromptEnhancePreparationDto
} from '../../../shared/image-prompt-enhance-ipc';
import type { GenerationImageDraftDto } from './ImageGenerationControls';

interface ImagePromptEnhancePanelProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onDraftPersisted: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

const errorMessages: Partial<Record<ImagePromptEnhanceIpcErrorCode, string>> = {
  invalid_request: '提示词增强请求无效。',
  project_not_open: '当前没有打开的项目。',
  draft_not_found: '当前图片草稿已不存在。',
  draft_revision_changed: '草稿已变化，请重新准备增强。',
  subject_invalid: '当前草稿暂不可用，请稍后重试增强。',
  candidate_not_found: '所选文本模型已不存在。',
  candidate_unavailable: '所选文本模型当前不可用。',
  route_selection_invalid: '本次增强准备已失效。',
  route_selection_expired: '本次增强准备已过期。',
  route_selection_consumed: '本次增强准备已使用。',
  stale_route_selection: '草稿或提示词已变化，请重新准备。',
  confirmation_required: '请确认本次外发事实后再提交。',
  runtime_not_allowed: '在线文本运行尚未获准，没有发出请求。',
  authorization_not_claimed: '运行授权未取得，没有发出请求。',
  submission_failed_before_request: '增强请求发送前失败。',
  submission_outcome_unknown: '增强结果未知。',
  adapter_contract_invalid: '文本适配器合同不匹配。',
  empty_prompt: '请先填写原始创作需求。',
  empty_result: '增强未返回可用文本。',
  storage_error: '本地提示词增强失败，请重试。'
};

const unavailableReasonLabels: Readonly<Record<string, string>> = {
  model_disabled: '模型未启用',
  model_not_present: '模型不在当前目录',
  connection_unavailable: '连接不可用',
  profile_unavailable: '功能档案未验证',
  feature_unsupported: '不支持当前文本能力',
  binding_unavailable: '协议适配器不可用',
  runtime_not_allowed: '在线运行未授权',
  subject_constraints_unsatisfied: '约束不满足',
  schema_unsupported: '参数 Schema 无法解释'
};

export function ImagePromptEnhancePanel({
  dirty,
  draft,
  onDraftPersisted,
  onMessage
}: ImagePromptEnhancePanelProps) {
  const api = window.unicomp?.imagePromptEnhance;
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [productFeature, setProductFeature] = useState<'text_chat' | 'text_reasoning'>(
    'text_chat'
  );
  const [candidates, setCandidates] = useState<readonly ImagePromptEnhanceCandidateDto[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [parameterValues, setParameterValues] = useState<
    Readonly<Record<string, DynamicParameterValue | undefined>>
  >({});
  const [preparation, setPreparation] = useState<ImagePromptEnhancePreparationDto>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const selectedCandidate = candidates.find((item) => item.candidateId === candidateId);

  useEffect(() => {
    let active = true;
    setPreparation(undefined);
    setConfirmed(false);
    setCandidates([]);
    setCandidateId('');
    setParameterValues({});
    if (!api) {
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    const needsSave = dirty || draft.state !== 'saved';
    const timer = window.setTimeout(() => {
      void (async () => {
        let working = draft;
        if (needsSave && imageWorkspaces) {
          const saved = await imageWorkspaces.update({
            ...draft,
            state: 'saved'
          });
          if (!active) return;
          if (!saved.ok) {
            setLoadState('loaded');
            onMessage(errorMessages[saved.error.code] ?? saved.error.message);
            return;
          }
          working = saved.value as GenerationImageDraftDto;
          onDraftPersisted(working);
        }
        const result = await api.listCandidates(productFeature);
        if (!active) return;
        if (!result.ok) {
          setLoadState('loaded');
          onMessage(errorMessages[result.error.code] ?? result.error.message);
          return;
        }
        setCandidates(result.value);
        setLoadState('loaded');
      })().catch(() => {
        if (active) {
          setLoadState('loaded');
          onMessage('读取文本增强候选失败。');
        }
      });
    }, needsSave ? 350 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    api,
    dirty,
    draft,
    imageWorkspaces,
    onDraftPersisted,
    onMessage,
    productFeature
  ]);

  async function ensureSavedDraft(): Promise<GenerationImageDraftDto | undefined> {
    if (!imageWorkspaces) return undefined;
    if (!dirty && draft.state === 'saved') return draft;
    const result = await imageWorkspaces.update({
      ...draft,
      state: 'saved'
    });
    if (!result.ok) {
      onMessage(result.error.message);
      return undefined;
    }
    onDraftPersisted(result.value as GenerationImageDraftDto);
    return result.value as GenerationImageDraftDto;
  }

  async function prepare() {
    if (!api || !selectedCandidate || busy) return;
    setBusy(true);
    onMessage('');
    setProgressFailure(undefined);
    setProgressPhase('preparing');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) {
        setProgressPhase('failed');
        return;
      }
      const result = await api.prepare(
        saved.draftId,
        saved.updatedAt,
        productFeature,
        selectedCandidate.candidateId,
        Object.fromEntries(
          Object.entries(parameterValues).filter((entry) => entry[1] !== undefined)
        ) as Readonly<Record<string, string | number | boolean | readonly string[]>>
      );
      if (!result.ok) {
        const message = errorMessages[result.error.code] ?? result.error.message;
        onMessage(message);
        setProgressFailure(message);
        setProgressPhase('failed');
        return;
      }
      setPreparation(result.value);
      setConfirmed(false);
      setProgressPhase('ready');
      onMessage('已固定本次提示词增强服务选择，请核对外发事实。');
    } catch {
      onMessage('准备提示词增强失败，请重试。');
      setProgressFailure('准备提示词增强失败，请重试。');
      setProgressPhase('failed');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!api || !preparation || !confirmed || busy) return;
    setBusy(true);
    onMessage('');
    setProgressFailure(undefined);
    setProgressPhase('requesting');
    const promoteWaiting = window.setTimeout(() => setProgressPhase('waiting'), 120);
    try {
      const saved = await ensureSavedDraft();
      if (!saved) {
        setProgressPhase('failed');
        return;
      }
      const result = await api.submit(
        saved.draftId,
        saved.updatedAt,
        preparation.routeSelectionToken,
        preparation.confirmation.confirmationId,
        true
      );
      if (!result.ok) {
        const message = errorMessages[result.error.code] ?? result.error.message;
        onMessage(message);
        setProgressFailure(message);
        setProgressPhase('failed');
        return;
      }
      if (result.value.status !== 'completed' || !result.value.enhancedText) {
        const message = result.value.safeCode
          ? `提示词增强失败：${result.value.safeCode}`
          : '提示词增强未完成。';
        onMessage(message);
        setProgressFailure(message);
        setProgressPhase('failed');
        return;
      }
      const refreshed = await imageWorkspaces?.get(result.value.draftId);
      if (refreshed?.ok) {
        onDraftPersisted(refreshed.value as GenerationImageDraftDto);
      } else {
        onDraftPersisted({
          ...draft,
          draftId: result.value.draftId,
          updatedAt: result.value.draftUpdatedAt,
          state: 'saved',
          prompt: {
            ...draft.prompt,
            systemSupplements: [
              ...draft.prompt.systemSupplements.filter(
                (item) => item.source !== 'enhancement'
              ),
              {
                content: result.value.enhancedText,
                source: 'enhancement',
                sourceReference: 'prompt_enhance'
              }
            ]
          }
        });
      }
      setPreparation(undefined);
      setConfirmed(false);
      setProgressPhase('completed');
      onMessage('提示词增强完成，结果已写入系统补充；请确认后合并到最终提示词。');
    } catch {
      onMessage('提示词增强失败，请重试。');
      setProgressFailure('提示词增强失败，请重试。');
      setProgressPhase('failed');
    } finally {
      window.clearTimeout(promoteWaiting);
      setBusy(false);
    }
  }

  return (
    <section className="uc-image-prompt-enhance" aria-label="提示词增强">
      <header className="uc-image-prompt-enhance__heading">
        <LuSparkles aria-hidden="true" />
        <div>
          <strong>可选：提示词增强</strong>
          <p>选择文本模型改写原始需求，结果只写入系统补充，不创建图片任务。</p>
        </div>
      </header>

      <div aria-label="文本能力" className="uc-image-feature-mode" role="group">
        <button
          aria-pressed={productFeature === 'text_chat'}
          className="uc-image-feature-mode__option"
          onClick={() => setProductFeature('text_chat')}
          type="button"
        >
          <span><strong>文本对话</strong><small>text_chat</small></span>
        </button>
        <button
          aria-pressed={productFeature === 'text_reasoning'}
          className="uc-image-feature-mode__option"
          onClick={() => setProductFeature('text_reasoning')}
          type="button"
        >
          <span><strong>文本推理</strong><small>text_reasoning</small></span>
        </button>
      </div>

      <ModelSelect
        disabled={!api || loadState !== 'loaded'}
        emptyDescription={
          loadState === 'loading'
            ? '正在读取文本模型候选。'
            : '当前没有匹配的文本模型，请在“模型与服务商”中完成连接与模型配置。'
        }
        emptyTitle={loadState === 'loading' ? '正在读取' : '没有可选文本模型'}
        hint={loadState === 'loading' ? '正在读取文本模型候选。' : undefined}
        onChange={(nextId) => {
          setCandidateId(nextId);
          setParameterValues({});
          setPreparation(undefined);
          setConfirmed(false);
          setProgressPhase('idle');
        }}
        options={candidates.map((candidate) => ({
          id: candidate.candidateId,
          label: `${candidate.providerName} · ${candidate.connectionName} · ${candidate.modelName}`,
          available: candidate.available,
          unavailableReasons: candidate.unavailableReasons
        }))}
        reasonLabels={unavailableReasonLabels}
        value={candidateId}
      />

      {selectedCandidate ? (
        <>
          <div className="uc-image-feature-panel__facts">
            <span>
              <strong>已锁定参数合同</strong>
              {selectedCandidate.parameterSchema.schemaId} · revision{' '}
              {selectedCandidate.parameterSchema.revision}
            </span>
            <StatusPill tone={selectedCandidate.available ? 'success' : 'warning'}>
              {selectedCandidate.available ? '可准备' : '当前不可用'}
            </StatusPill>
          </div>
          <DynamicParameterForm
            disabled={busy}
            emptyHint="当前表面没有需要用户填写的参数。"
            fields={toDynamicParameterFields(selectedCandidate.parameterSchema.fields)}
            onChange={(fieldId, value) =>
              setParameterValues((current) => ({ ...current, [fieldId]: value }))
            }
            values={parameterValues}
          />
        </>
      ) : null}

      {draft.prompt.originalInput.trim().length === 0 ? (
        <p className="uc-image-quick__hint" role="status">
          请先填写原始创作需求。
        </p>
      ) : null}

      {preparation ? (
        <fieldset className="uc-image-quick__confirmations">
          <legend>确认本次提示词增强外发</legend>
          <dl className="uc-image-feature-panel__confirmation-facts">
            <div><dt>接收方</dt><dd>{preparation.confirmation.recipientName}</dd></div>
            <div>
              <dt>服务路由</dt>
              <dd>
                {preparation.confirmation.providerName} /{' '}
                {preparation.confirmation.connectionName} /{' '}
                {preparation.confirmation.modelName}
              </dd>
            </div>
            <div><dt>费用</dt><dd>{costLabel(preparation.confirmation.cost)}</dd></div>
          </dl>
          <Checkbox
            checked={confirmed}
            className="uc-image-quick__checkbox"
            onChange={(_value, checked) => setConfirmed(checked)}
          >
            <span>我已核对并确认以上接收方、内容与费用事实。</span>
          </Checkbox>
        </fieldset>
      ) : null}

      <SubmissionProgressSteps
        failureMessage={progressFailure}
        phase={progressPhase}
      />

      <Button
        disabled={
          busy ||
          !selectedCandidate?.available ||
          draft.prompt.originalInput.trim().length === 0 ||
          (Boolean(preparation) && !confirmed)
        }
        onClick={() => void (preparation ? submit() : prepare())}
      >
        {preparation ? <LuSend aria-hidden="true" /> : <LuShieldCheck aria-hidden="true" />}
        {busy ? '处理中' : preparation ? '确认并增强' : '准备增强'}
      </Button>
    </section>
  );
}

function costLabel(cost: { readonly state: string; readonly summary?: string }): string {
  if (cost.state === 'known') return cost.summary ?? '费用已知';
  if (cost.state === 'not_applicable') return '不适用';
  return '未知，以服务商账单为准';
}
