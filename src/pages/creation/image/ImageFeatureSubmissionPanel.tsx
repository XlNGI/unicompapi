import { useEffect, useState } from 'react';
import { LuSend, LuShieldCheck } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import {
  DynamicParameterForm,
  toDynamicParameterFields,
  type DynamicParameterValue
} from '../../../components/DynamicParameterForm';
import { ModelSelect } from '../../../components/ModelSelect';
import { StatusPill } from '../../../components/StatusPill';
import type {
  ImageFeatureCandidateDto,
  ImageFeatureIpcErrorCode,
  ImageFeaturePreparationDto,
  ImageFeatureSubmissionDto
} from '../../../shared/image-feature-ipc';
import type {
  ImageWorkspaceParameterValueDto
} from '../../../shared/image-workspace-ipc';
import type { GenerationImageDraftDto } from './ImageGenerationControls';

interface ImageFeatureSubmissionPanelProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly blockedReason?: string;
  readonly oneShot?: boolean;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted?: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onSubmissionComplete?: (submission: ImageFeatureSubmissionDto) => void;
}

const errorMessages: Record<ImageFeatureIpcErrorCode, string> = {
  invalid_request: '图片功能请求无效，请重新保存当前草稿。',
  project_not_open: '当前没有打开的项目。',
  draft_not_found: '当前图片草稿已不存在。',
  draft_revision_changed: '草稿已变化，请重新选择服务和参数。',
  subject_invalid: '当前提示词、素材或上下文不符合所选生图方式。',
  candidate_not_found: '所选服务候选已不存在，请重新选择。',
  candidate_unavailable: '所选服务当前不可用，没有发出请求。',
  route_selection_invalid: '本次服务选择已失效，请重新准备。',
  route_selection_expired: '本次服务选择已过期，请重新准备。',
  route_selection_consumed: '本次服务选择已经使用，不能重复提交。',
  stale_route_selection: '草稿或服务事实已变化，请重新准备。',
  confirmation_required: '请确认本次外发事实后再提交。',
  runtime_not_allowed: '在线图片运行尚未获准，没有发出请求。',
  authorization_not_claimed: '运行授权未取得，没有发出请求。',
  submission_failed_before_request: '请求发送前失败，没有产生远端结果。',
  submission_outcome_unknown: '提交结果未知，禁止自动重试。',
  adapter_contract_invalid: '图片适配器合同不匹配，已停止提交。',
  storage_error: '本地图片功能操作失败，请重试。'
};

const unavailableReasonLabels: Readonly<Record<string, string>> = {
  model_disabled: '模型未启用',
  model_not_present: '模型不在当前目录',
  connection_unavailable: '连接不可用',
  profile_unavailable: '功能档案未验证',
  feature_unsupported: '不支持当前生图方式',
  binding_unavailable: '协议适配器不可用',
  runtime_not_allowed: '在线运行未授权',
  subject_constraints_unsatisfied: '草稿约束不满足',
  schema_unsupported: '参数 Schema 无法解释'
};

export function ImageFeatureSubmissionPanel({
  dirty,
  draft,
  blockedReason,
  oneShot = false,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onSubmissionComplete
}: ImageFeatureSubmissionPanelProps) {
  const api = window.unicomp?.imageFeatures;
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [candidates, setCandidates] = useState<readonly ImageFeatureCandidateDto[]>([]);
  const [preparation, setPreparation] = useState<ImageFeaturePreparationDto>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const featureSelection = draft.featureSelection ?? {
    productFeature: draft.mode === 'professional_image' && draft.input
      ? 'reference_to_image' as const
      : 'text_to_image' as const,
    parameterValues: {}
  };
  const selectedCandidate = candidates.find(
    (candidate) => candidate.candidateId === featureSelection.candidateId
  );

  useEffect(() => {
    let active = true;
    setPreparation(undefined);
    setConfirmed(false);
    if (!api || blockedReason) return;
    if (!oneShot && (dirty || draft.state !== 'saved')) return;
    if (oneShot && draft.prompt.finalPrompt.trim().length === 0) {
      setCandidates([]);
      setLoadState('idle');
      return;
    }
    const delayMs = oneShot && (dirty || draft.state !== 'saved') ? 350 : 0;
    setLoadState('loading');
    const timer = window.setTimeout(() => {
      void (async () => {
        let draftId = draft.draftId;
        let draftUpdatedAt = draft.updatedAt;
        if (oneShot && (dirty || draft.state !== 'saved') && imageWorkspaces) {
          const saved = await imageWorkspaces.update({
            ...draft,
            state: 'saved'
          });
          if (!active) return;
          if (!saved.ok) {
            setCandidates([]);
            setLoadState('loaded');
            onMessage(errorMessages[saved.error.code] ?? saved.error.message);
            return;
          }
          draftId = saved.value.draftId;
          draftUpdatedAt = saved.value.updatedAt;
          onDraftPersisted?.(saved.value as GenerationImageDraftDto);
        }
        const result = await api.listCandidates(draftId, draftUpdatedAt);
        if (!active) return;
        if (!result.ok) {
          setCandidates([]);
          setLoadState('loaded');
          onMessage(errorMessages[result.error.code]);
          return;
        }
        setCandidates(result.value);
        setLoadState('loaded');
      })().catch(() => {
        if (!active) return;
        setCandidates([]);
        setLoadState('loaded');
        onMessage('读取图片服务候选失败，请重试。');
      });
    }, delayMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    api,
    blockedReason,
    dirty,
    draft,
    featureSelection.productFeature,
    imageWorkspaces,
    onDraftPersisted,
    onMessage,
    oneShot
  ]);

  function changeCandidate(candidateId: string) {
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    const sameSchema = candidate &&
      featureSelection.parameterSchemaId === candidate.parameterSchema.schemaId &&
      featureSelection.parameterSchemaRevision === candidate.parameterSchema.revision;
    onDraftChange({
      ...draft,
      state: 'editing',
      generation: {},
      featureSelection: {
        productFeature: featureSelection.productFeature,
        ...(candidate
          ? {
              candidateId: candidate.candidateId,
              parameterSchemaId: candidate.parameterSchema.schemaId,
              parameterSchemaRevision: candidate.parameterSchema.revision
            }
          : {}),
        parameterValues: sameSchema ? featureSelection.parameterValues : {}
      }
    });
  }

  function changeParameter(
    fieldId: string,
    value: ImageWorkspaceParameterValueDto | undefined
  ) {
    const parameterValues = { ...featureSelection.parameterValues } as Record<
      string,
      ImageWorkspaceParameterValueDto
    >;
    if (value === undefined) delete parameterValues[fieldId];
    else parameterValues[fieldId] = value;
    onDraftChange({
      ...draft,
      state: 'editing',
      generation: {},
      featureSelection: { ...featureSelection, parameterValues }
    });
  }

  async function ensureSavedDraft(): Promise<GenerationImageDraftDto | undefined> {
    if (!imageWorkspaces) return undefined;
    if (!dirty && draft.state === 'saved') return draft;
    const result = await imageWorkspaces.update({
      ...draft,
      state: 'saved'
    });
    if (!result.ok) {
      onMessage(errorMessages[result.error.code] ?? result.error.message);
      return undefined;
    }
    onDraftPersisted?.(result.value as GenerationImageDraftDto);
    return result.value as GenerationImageDraftDto;
  }

  async function prepare() {
    if (!api || !selectedCandidate || busy || blockedReason) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      const result = await api.prepareSubmission(
        saved.draftId,
        saved.updatedAt,
        selectedCandidate.candidateId
      );
      if (!result.ok) {
        onMessage(errorMessages[result.error.code]);
        return;
      }
      setPreparation(result.value);
      setConfirmed(oneShot);
      onMessage(oneShot ? '已准备生成。' : '已固定本次服务选择，请核对外发事实。');
      if (oneShot) {
        await submitPrepared(saved, result.value);
      }
    } catch {
      onMessage('准备图片提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function submitPrepared(
    saved: GenerationImageDraftDto,
    prepared: ImageFeaturePreparationDto
  ) {
    if (!api) return;
    const result = await api.submitDraft(
      saved.draftId,
      saved.updatedAt,
      prepared.routeSelectionToken,
      prepared.confirmation.confirmationId,
      true
    );
    if (!result.ok) {
      onMessage(errorMessages[result.error.code]);
      return;
    }
    const urls = result.value.resultImageUrls ?? [];
    onMessage(
      urls.length > 0
        ? `提交完成（${result.value.status}），已保存图片 URL。`
        : `提交状态：${result.value.status}`
    );
    onSubmissionComplete?.(result.value);
    setPreparation(undefined);
    setConfirmed(false);
  }

  async function submit() {
    if (!api || !preparation || (!confirmed && !oneShot) || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) return;
      await submitPrepared(saved, preparation);
    } catch {
      onMessage('图片提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function generateOneShot() {
    if (busy) return;
    if (!api) {
      onMessage('当前运行环境未连接桌面图片功能。');
      return;
    }
    if (blockedReason) {
      onMessage(blockedReason);
      return;
    }
    if (!selectedCandidate) {
      onMessage('请先选择可用的服务商 / 连接 / 模型。');
      return;
    }
    if (!selectedCandidate.available) {
      onMessage(
        `所选模型当前不可用：${
          selectedCandidate.unavailableReasons
            .map((reason) => unavailableReasonLabels[reason] ?? reason)
            .join('、') || '未知原因'
        }`
      );
      return;
    }
    const prompt = draft.prompt.finalPrompt.trim();
    if (prompt.length === 0) {
      onMessage('请先填写提示词。');
      return;
    }
    setBusy(true);
    onMessage('正在生成…');
    try {
      if (api.generateQuickImage) {
        const result = await api.generateQuickImage(
          prompt,
          selectedCandidate.candidateId,
          featureSelection.parameterValues as Readonly<
            Record<string, string | number | boolean | readonly string[]>
          >
        );
        if (!result.ok) {
          onMessage(
            `${errorMessages[result.error.code]}（${result.error.code}）`
          );
          return;
        }
        onDraftPersisted?.({
          ...draft,
          draftId: result.value.draftId,
          updatedAt: result.value.draftUpdatedAt,
          state: 'saved',
          prompt: {
            originalInput: prompt,
            systemSupplements: [],
            finalPrompt: prompt
          },
          featureSelection: {
            productFeature: 'text_to_image',
            candidateId: selectedCandidate.candidateId,
            parameterSchemaId: selectedCandidate.parameterSchema.schemaId,
            parameterSchemaRevision: selectedCandidate.parameterSchema.revision,
            parameterValues: featureSelection.parameterValues
          }
        } as GenerationImageDraftDto);
        const submission = result.value.submission;
        const urls = submission.resultImageUrls ?? [];
        const status = submission.status;
        if (submission.localResultError) {
          onMessage(
            `${submission.localResultError}${
              urls.length > 0 ? `；调用记录中的 URL：${urls[0]}` : ''
            }`
          );
        } else if (status !== 'completed' && status !== 'provider_accepted') {
          onMessage(
            `生成未完成：${status}${
              urls.length > 0 ? '；已记录部分结果 URL。' : '。请打开任务中心查看时间线。'
            }`
          );
        } else if (urls.length > 0 || submission.workId) {
          onMessage(
            urls.length > 0
              ? '生成完成，已写入调用记录与图片 URL。'
              : `生成完成，本地作品：${submission.workId}`
          );
        } else {
          onMessage(
            `生成状态：${status}，但没有图片 URL 也没有本地作品。请打开任务中心查看时间线。`
          );
        }
        onSubmissionComplete?.(submission);
        return;
      }
      await prepare();
    } catch (error) {
      onMessage(
        error instanceof Error && error.message.trim().length > 0
          ? `一键生成失败：${error.message}`
          : '一键生成失败，请重试。'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="uc-image-feature-panel">
      <ModelSelect
        disabled={
          !api ||
          loadState !== 'loaded' ||
          (!oneShot && dirty)
        }
        emptyDescription={
          loadState === 'loading'
            ? '正在读取安全候选。'
            : oneShot && draft.prompt.finalPrompt.trim().length === 0
              ? '请先填写提示词，再读取可选模型。'
              : !oneShot && (dirty || draft.state !== 'saved')
                ? '请先保存本地草稿，再读取候选或准备生成。'
                : '当前没有匹配的服务候选，请在“模型与服务商”中完成连接与模型配置。'
        }
        emptyTitle={loadState === 'loading' ? '正在读取' : '没有可选模型'}
        hint={loadState === 'loading' ? '正在读取安全候选。' : undefined}
        onChange={changeCandidate}
        options={candidates.map((candidate) => ({
          id: candidate.candidateId,
          label: `${candidate.providerName} · ${candidate.connectionName} · ${candidate.modelName}`,
          available: candidate.available,
          unavailableReasons: candidate.unavailableReasons
        }))}
        reasonLabels={unavailableReasonLabels}
        value={featureSelection.candidateId ?? ''}
      />

      {selectedCandidate ? (
        <>
          <div className="uc-image-feature-panel__facts">
            <span>
              <strong>已锁定参数合同</strong>
              {selectedCandidate.parameterSchema.schemaId} · revision {selectedCandidate.parameterSchema.revision}
            </span>
            <span>
              <strong>费用</strong>
              {costLabel(selectedCandidate.cost)}
            </span>
            <StatusPill tone={selectedCandidate.available ? 'success' : 'warning'}>
              {selectedCandidate.available ? '可准备' : '当前不可用'}
            </StatusPill>
          </div>
          {!selectedCandidate.available ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>不可用原因</strong>
              {selectedCandidate.unavailableReasons.map((reason) => (
                <span key={reason}>• {unavailableReasonLabels[reason] ?? reason}</span>
              ))}
            </div>
          ) : null}
          <DynamicParameterForm
            disabled={busy || dirty}
            emptyHint="当前表面没有需要用户填写的参数。"
            fields={toDynamicParameterFields(selectedCandidate.parameterSchema.fields)}
            onChange={(fieldId, value) =>
              changeParameter(fieldId, value as ImageWorkspaceParameterValueDto | undefined)
            }
            values={featureSelection.parameterValues as Readonly<
              Record<string, DynamicParameterValue | undefined>
            >}
          />
        </>
      ) : null}

      {blockedReason ? (
        <div className="uc-image-quick__preflight" role="status">
          <strong>当前不能生成</strong>
          <span>{blockedReason}</span>
        </div>
      ) : !oneShot && (dirty || draft.state !== 'saved') ? (
        <p className="uc-image-quick__hint" role="status">
          请先保存本地草稿，再读取候选或准备生成。
        </p>
      ) : oneShot && draft.prompt.finalPrompt.trim().length === 0 ? (
        <p className="uc-image-quick__hint" role="status">
          请先填写提示词，再选择模型并生成。
        </p>
      ) : null}

      {!oneShot && preparation ? (
        <fieldset className="uc-image-quick__confirmations">
          <legend>确认本次外发</legend>
          <dl className="uc-image-feature-panel__confirmation-facts">
            <div><dt>接收方</dt><dd>{preparation.confirmation.recipientName}</dd></div>
            <div><dt>服务路由</dt><dd>{preparation.confirmation.providerName} / {preparation.confirmation.connectionName} / {preparation.confirmation.modelName}</dd></div>
            <div><dt>外发范围</dt><dd>{outboundScopeLabel(preparation.confirmation.outboundScope)}</dd></div>
            <div><dt>内容</dt><dd>{preparation.confirmation.contentCategories.join('、') || '无'}</dd></div>
            <div><dt>数量</dt><dd>{preparation.confirmation.parameterFieldCount} 个参数 · {preparation.confirmation.materialCount} 份素材 · {preparation.confirmation.contextCount} 份上下文</dd></div>
            <div><dt>费用</dt><dd>{costLabel(preparation.confirmation.cost)}</dd></div>
          </dl>
          <label className="uc-image-quick__checkbox">
            <input
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>我已核对并确认以上接收方、外发范围、内容与费用事实。</span>
          </label>
        </fieldset>
      ) : null}

      <Button
        className="uc-image-feature-panel__primary"
        disabled={
          oneShot
            ? busy
            : Boolean(blockedReason) ||
              busy ||
              !selectedCandidate?.available ||
              dirty ||
              (Boolean(preparation) && !confirmed)
        }
        onClick={() => void (oneShot
          ? generateOneShot()
          : preparation
            ? submit()
            : prepare())}
      >
        {oneShot || preparation
          ? <LuSend aria-hidden="true" />
          : <LuShieldCheck aria-hidden="true" />}
        {busy
          ? '处理中'
          : oneShot
            ? '生成'
            : preparation
              ? '确认并提交'
              : '准备生成'}
      </Button>
      {oneShot ? (
        <p className="uc-image-feature-panel__action-hint" role="status">
          {!selectedCandidate
            ? '下一步：在上方选择可用模型。'
            : !selectedCandidate.available
              ? '所选模型当前不可用，请换一个或到「模型与服务商」检查连接授权。'
              : draft.prompt.finalPrompt.trim().length === 0
                ? '下一步：填写左侧提示词。'
                : busy
                  ? '正在向主进程提交…'
                  : '就绪：点击「生成」发起请求。'}
        </p>
      ) : null}
    </div>
  );
}

function costLabel(cost: { readonly state: string; readonly summary?: string }): string {
  if (cost.state === 'known') return cost.summary ?? '费用已知';
  if (cost.state === 'not_applicable') return '不适用';
  return '未知，以服务商账单为准';
}

function outboundScopeLabel(scope: ImageFeaturePreparationDto['confirmation']['outboundScope']) {
  if (scope === 'local_device') return '仅在本机';
  if (scope === 'local_network') return '局域网';
  if (scope === 'external_service') return '外部服务';
  return '未知';
}
