import { useEffect, useRef, useState } from 'react';
import { LuSend, LuShieldCheck } from 'react-icons/lu';
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
  /**
   * Professional image: do not infer text/reference feature from draft.input.
   * Until the user explicitly picks a feature, hide model and parameter UI.
   */
  readonly requireExplicitFeature?: boolean;
  /** Professional image: show in-page 准备 → 请求中 → 等待上游 → 完成 progress. */
  readonly showProgressSteps?: boolean;
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
  requireExplicitFeature = false,
  showProgressSteps = false,
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
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const explicitFeature =
    draft.featureSelection?.productFeature === 'text_to_image' ||
    draft.featureSelection?.productFeature === 'reference_to_image'
      ? draft.featureSelection.productFeature
      : undefined;
  const awaitingFeatureChoice = requireExplicitFeature && !explicitFeature;
  const featureSelection =
    !awaitingFeatureChoice && draft.featureSelection
      ? draft.featureSelection
      : requireExplicitFeature
        ? {
            productFeature: 'text_to_image' as const,
            parameterValues: {}
          }
        : draft.featureSelection ?? {
            productFeature: draft.mode === 'professional_image' && draft.input
              ? 'reference_to_image' as const
              : 'text_to_image' as const,
            parameterValues: {}
          };
  const selectedCandidate = candidates.find(
    (candidate) => candidate.candidateId === featureSelection.candidateId
  );
  const parameterSignature = JSON.stringify(featureSelection.parameterValues ?? {});
  const busyRef = useRef(false);
  busyRef.current = busy;

  // Only invalidate a prepared confirmation when route-binding facts change.
  // Do NOT clear it on draft.updatedAt / autosave, or prepare appears stuck.
  useEffect(() => {
    if (busyRef.current) return;
    setPreparation(undefined);
    setConfirmed(false);
    setProgressPhase((phase) =>
      phase === 'ready' ? 'idle' : phase
    );
  }, [
    awaitingFeatureChoice,
    blockedReason,
    draft.draftId,
    featureSelection.candidateId,
    featureSelection.productFeature,
    parameterSignature
  ]);

  useEffect(() => {
    let active = true;
    if (awaitingFeatureChoice) {
      setCandidates([]);
      setLoadState('idle');
      return;
    }
    if (!api) return;
    if (blockedReason) {
      setCandidates([]);
      setLoadState('idle');
      return;
    }
    if (oneShot && draft.prompt.finalPrompt.trim().length === 0) {
      setCandidates([]);
      setLoadState('idle');
      return;
    }
    // Avoid racing prepare/submit: autosave + listCandidates must not run mid-flight.
    if (busyRef.current) return;
    const needsSave = dirty || draft.state !== 'saved';
    const delayMs = needsSave ? 350 : 0;
    setLoadState('loading');
    const timer = window.setTimeout(() => {
      void (async () => {
        if (busyRef.current) return;
        let draftId = draft.draftId;
        let draftUpdatedAt = draft.updatedAt;
        if (needsSave && imageWorkspaces) {
          const saved = await imageWorkspaces.update({
            ...draft,
            state: 'saved'
          });
          if (!active || busyRef.current) return;
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
        if (busyRef.current) return;
        const result = await api.listCandidates(draftId, draftUpdatedAt);
        if (!active || busyRef.current) return;
        if (!result.ok) {
          setCandidates([]);
          setLoadState('loaded');
          onMessage(errorMessages[result.error.code]);
          return;
        }
        setCandidates(result.value);
        setLoadState('loaded');
      })().catch(() => {
        if (!active || busyRef.current) return;
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
    awaitingFeatureChoice,
    blockedReason,
    dirty,
    draft.draftId,
    draft.prompt.finalPrompt,
    draft.state,
    draft.updatedAt,
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
    busyRef.current = true;
    onMessage('');
    if (showProgressSteps) {
      setProgressFailure(undefined);
      setProgressPhase('preparing');
    }
    try {
      let saved = await ensureSavedDraft();
      if (!saved) {
        if (showProgressSteps) setProgressPhase('failed');
        return;
      }
      let result = await api.prepareSubmission(
        saved.draftId,
        saved.updatedAt,
        selectedCandidate.candidateId
      );
      // Autosave may bump revision between ensureSavedDraft and prepare; retry once.
      if (!result.ok && result.error.code === 'draft_revision_changed' && imageWorkspaces) {
        const refreshed = await imageWorkspaces.get(saved.draftId);
        if (refreshed.ok && refreshed.value) {
          saved = refreshed.value as GenerationImageDraftDto;
          onDraftPersisted?.(saved);
          result = await api.prepareSubmission(
            saved.draftId,
            saved.updatedAt,
            selectedCandidate.candidateId
          );
        }
      }
      if (!result.ok) {
        onMessage(errorMessages[result.error.code]);
        if (showProgressSteps) {
          setProgressFailure(errorMessages[result.error.code]);
          setProgressPhase('failed');
        }
        return;
      }
      setPreparation(result.value);
      setConfirmed(oneShot);
      onMessage(
        oneShot
          ? '已准备生成。'
          : '准备完成：请勾选确认外发事实，再点击「确认并提交」。'
      );
      if (showProgressSteps && !oneShot) setProgressPhase('ready');
      if (oneShot) {
        await submitPrepared(saved, result.value);
      }
    } catch {
      onMessage('准备图片提交失败，请重试。');
      if (showProgressSteps) {
        setProgressFailure('准备图片提交失败，请重试。');
        setProgressPhase('failed');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitPrepared(
    saved: GenerationImageDraftDto,
    prepared: ImageFeaturePreparationDto
  ) {
    if (!api) return;
    if (showProgressSteps) {
      setProgressFailure(undefined);
      setProgressPhase('requesting');
    }
    const promoteWaiting =
      showProgressSteps && typeof window !== 'undefined'
        ? window.setTimeout(() => setProgressPhase('waiting'), 120)
        : undefined;
    try {
      const result = await api.submitDraft(
        saved.draftId,
        saved.updatedAt,
        prepared.routeSelectionToken,
        prepared.confirmation.confirmationId,
        true
      );
      if (!result.ok) {
        const message =
          result.error.message?.trim() ||
          errorMessages[result.error.code] ||
          '图片提交失败';
        onMessage(message);
        if (showProgressSteps) {
          setProgressFailure(message);
          setProgressPhase('failed');
        }
        return;
      }
      const urls = result.value.resultImageUrls ?? [];
      const failed =
        result.value.status !== 'completed' &&
        result.value.status !== 'provider_accepted';
      const feedback =
        result.value.feedback ??
        result.value.localResultError ??
        (urls.length > 0
          ? `提交完成（${result.value.status}），已保存图片 URL。`
          : `提交状态：${result.value.status}`);
      onMessage(feedback);
      if (showProgressSteps) {
        if (failed || result.value.localResultError) {
          setProgressFailure(feedback);
          setProgressPhase('failed');
        } else {
          setProgressPhase('completed');
        }
      }
      onSubmissionComplete?.(result.value);
      setPreparation(undefined);
      setConfirmed(false);
    } finally {
      if (promoteWaiting !== undefined) window.clearTimeout(promoteWaiting);
    }
  }

  async function submit() {
    if (!api || !preparation || (!confirmed && !oneShot) || busy) return;
    setBusy(true);
    busyRef.current = true;
    onMessage('');
    try {
      const saved = await ensureSavedDraft();
      if (!saved) {
        if (showProgressSteps) setProgressPhase('failed');
        return;
      }
      await submitPrepared(saved, preparation);
    } catch {
      onMessage('图片提交失败，请重试。');
      if (showProgressSteps) {
        setProgressFailure('图片提交失败，请重试。');
        setProgressPhase('failed');
      }
    } finally {
      busyRef.current = false;
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
            result.error.message?.trim() ||
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
        if (submission.feedback || submission.localResultError) {
          onMessage(
            `${submission.feedback ?? submission.localResultError}${
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
      {awaitingFeatureChoice ? (
        <p className="uc-image-quick__hint" role="status">
          请先在上方选择文生图或图生图；选定功能后才会显示可用模型与参数。
        </p>
      ) : (
        <>
      <ModelSelect
        disabled={!api || loadState !== 'loaded'}
        emptyDescription={
          loadState === 'loading'
            ? '正在读取安全候选。'
            : oneShot && draft.prompt.finalPrompt.trim().length === 0
              ? '请先填写提示词，再读取可选模型。'
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
            disabled={busy}
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

      {showProgressSteps ? (
        <SubmissionProgressSteps
          failureMessage={progressFailure}
          phase={progressPhase}
        />
      ) : null}

      <Button
        className="uc-image-feature-panel__primary"
        disabled={
          oneShot
            ? busy
            : Boolean(blockedReason) ||
              busy ||
              !selectedCandidate?.available ||
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
        </>
      )}
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
