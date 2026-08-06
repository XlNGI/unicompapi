import { useEffect, useRef, useState } from 'react';
import { LuSend, LuShieldCheck } from 'react-icons/lu';
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
  VideoFeatureCandidateDto,
  VideoFeatureIpcErrorCode,
  VideoFeaturePreparationDto,
  VideoFeatureSubmissionDto
} from '../../../shared/video-feature-ipc';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceParameterValueDto
} from '../../../shared/video-workspace-ipc';

interface VideoFeatureSubmissionPanelProps {
  readonly dirty: boolean;
  readonly draft: VideoWorkspaceDraftDto;
  readonly blockedReason?: string;
  /** Text / image-to-video: show in-page 准备 → 请求中 → 等待上游 → 完成 progress. */
  readonly showProgressSteps?: boolean;
  readonly onDraftChange: (draft: VideoWorkspaceDraftDto) => void;
  readonly onDraftPersisted?: (draft: VideoWorkspaceDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onSubmissionComplete?: (submission: VideoFeatureSubmissionDto) => void;
}

const errorMessages: Record<VideoFeatureIpcErrorCode, string> = {
  invalid_request: '视频功能请求无效，请重新保存当前草稿。',
  project_not_open: '当前没有打开的项目。',
  draft_not_found: '当前视频草稿已不存在。',
  draft_revision_changed: '草稿已变化，请重新选择服务和参数。',
  subject_invalid: '当前提示词、素材或上下文不符合所选视频方式。',
  candidate_not_found: '所选服务候选已不存在，请重新选择。',
  candidate_unavailable: '所选服务当前不可用，没有发出请求。',
  route_selection_invalid: '本次服务选择已失效，请重新准备。',
  route_selection_expired: '本次服务选择已过期，请重新准备。',
  route_selection_consumed: '本次服务选择已经使用，不能重复提交。',
  stale_route_selection: '草稿或服务事实已变化，请重新准备。',
  confirmation_required: '请确认本次外发事实后再提交。',
  runtime_not_allowed: '视频提交运行时未就绪或未获准，没有发出请求。',
  authorization_not_claimed: '运行授权未取得，没有发出请求。',
  submission_failed_before_request: '请求发送前失败，没有产生远端结果。',
  submission_outcome_unknown: '提交结果未知，禁止自动重试。',
  adapter_contract_invalid: '视频适配器合同不匹配，已停止提交。',
  storage_error: '本地视频功能操作失败，请重试。'
};

function describeVideoFeatureError(
  error: { readonly code: VideoFeatureIpcErrorCode; readonly message: string }
): string {
  const fallback = errorMessages[error.code];
  const detail = error.message?.trim();
  if (!detail || detail === fallback) return fallback;
  // Prefer the concrete underlying message when the controller surfaced it.
  if (error.code === 'storage_error') return detail;
  return `${fallback}（${detail}）`;
}

const unavailableReasonLabels: Readonly<Record<string, string>> = {
  model_disabled: '模型未启用',
  model_not_present: '模型不在当前目录',
  connection_unavailable: '连接不可用',
  profile_unavailable: '功能档案未验证',
  feature_unsupported: '不支持当前视频方式',
  binding_unavailable: '协议适配器不可用',
  runtime_not_allowed: '在线运行未授权',
  subject_constraints_unsatisfied: '草稿约束不满足',
  schema_unsupported: '参数 Schema 无法解释'
};

export function VideoFeatureSubmissionPanel({
  dirty,
  draft,
  blockedReason,
  showProgressSteps = false,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onSubmissionComplete
}: VideoFeatureSubmissionPanelProps) {
  const api = window.unicomp?.videoFeatures;
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [candidates, setCandidates] = useState<readonly VideoFeatureCandidateDto[]>([]);
  const [preparation, setPreparation] = useState<VideoFeaturePreparationDto>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const featureSelection = draft.featureSelection ?? {
    productFeature: draft.mode === 'image_to_video'
      ? 'image_to_video' as const
      : 'text_to_video' as const,
    parameterValues: {}
  };
  const selectedCandidate = candidates.find(
    (candidate) => candidate.candidateId === featureSelection.candidateId
  );
  const parameterSignature = JSON.stringify(featureSelection.parameterValues ?? {});
  const busyRef = useRef(false);
  const draftRef = useRef(draft);
  busyRef.current = busy;
  draftRef.current = draft;

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
    blockedReason,
    draft.draftId,
    featureSelection.candidateId,
    featureSelection.productFeature,
    parameterSignature
  ]);

  useEffect(() => {
    let active = true;
    if (!api) return;
    if (blockedReason) {
      setCandidates([]);
      setLoadState('idle');
      return;
    }
    if (busyRef.current) return;
    const needsSave = dirty || draft.state !== 'saved';
    const delayMs = needsSave ? 350 : 0;
    setLoadState('loading');
    const timer = window.setTimeout(() => {
      void (async () => {
        if (busyRef.current) return;
        let draftId = draft.draftId;
        let draftUpdatedAt = draft.updatedAt;
        if (needsSave && videoWorkspaces) {
          const snapshot = draftRef.current;
          const saved = await videoWorkspaces.update({
            ...snapshot,
            state: 'saved'
          });
          if (!active || busyRef.current) return;
          if (!saved.ok) {
            setCandidates([]);
            setLoadState('loaded');
            onMessage(errorMessages[saved.error.code] ?? saved.error.message);
            return;
          }
          const latest = draftRef.current;
          const superseded =
            latest.draftId === snapshot.draftId && latest !== snapshot;
          if (!superseded) {
            draftId = saved.value.draftId;
            draftUpdatedAt = saved.value.updatedAt;
            onDraftPersisted?.(saved.value);
          } else {
            draftId = latest.draftId;
            draftUpdatedAt = latest.updatedAt;
            if (latest.state !== 'saved') {
              const again = await videoWorkspaces.update({
                ...latest,
                state: 'saved'
              });
              if (!active || busyRef.current) return;
              if (!again.ok) {
                setCandidates([]);
                setLoadState('loaded');
                onMessage(errorMessages[again.error.code] ?? again.error.message);
                return;
              }
              draftId = again.value.draftId;
              draftUpdatedAt = again.value.updatedAt;
              onDraftPersisted?.(again.value);
            }
          }
        }
        if (busyRef.current) return;
        const result = await api.listCandidates(draftId, draftUpdatedAt);
        if (!active || busyRef.current) return;
        if (!result.ok) {
          setCandidates([]);
          setLoadState('loaded');
          onMessage(describeVideoFeatureError(result.error));
          return;
        }
        setCandidates(result.value);
        setLoadState('loaded');
      })().catch(() => {
        if (!active || busyRef.current) return;
        setCandidates([]);
        setLoadState('loaded');
        onMessage('读取视频服务候选失败，请重试。');
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
    draft.draftId,
    draft.state,
    draft.updatedAt,
    featureSelection.productFeature,
    onDraftPersisted,
    onMessage,
    videoWorkspaces
  ]);

  function changeCandidate(candidateId: string) {
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    const sameSchema = candidate &&
      featureSelection.parameterSchemaId === candidate.parameterSchema.schemaId &&
      featureSelection.parameterSchemaRevision === candidate.parameterSchema.revision;
    onDraftChange({
      ...draft,
      state: 'editing',
      generation: resetGeneration(),
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
    value: VideoWorkspaceParameterValueDto | undefined
  ) {
    const parameterValues = { ...featureSelection.parameterValues } as Record<
      string,
      VideoWorkspaceParameterValueDto
    >;
    if (value === undefined) delete parameterValues[fieldId];
    else parameterValues[fieldId] = value;
    onDraftChange({
      ...draft,
      state: 'editing',
      generation: resetGeneration(),
      featureSelection: { ...featureSelection, parameterValues }
    });
  }

  async function ensureSavedDraft(): Promise<VideoWorkspaceDraftDto | undefined> {
    if (!videoWorkspaces) return undefined;
    const snapshot = draftRef.current;
    if (!dirty && snapshot.state === 'saved') return snapshot;
    const result = await videoWorkspaces.update({
      ...snapshot,
      state: 'saved'
    });
    if (!result.ok) {
      onMessage(errorMessages[result.error.code] ?? result.error.message);
      return undefined;
    }
    onDraftPersisted?.(result.value);
    return result.value;
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
      if (!result.ok && result.error.code === 'draft_revision_changed' && videoWorkspaces) {
        const refreshed = await videoWorkspaces.get(saved.draftId);
        if (refreshed.ok && refreshed.value) {
          saved = refreshed.value;
          onDraftPersisted?.(saved);
          result = await api.prepareSubmission(
            saved.draftId,
            saved.updatedAt,
            selectedCandidate.candidateId
          );
        }
      }
      if (!result.ok) {
        const message = describeVideoFeatureError(result.error);
        onMessage(message);
        if (showProgressSteps) {
          setProgressFailure(message);
          setProgressPhase('failed');
        }
        return;
      }
      setPreparation(result.value);
      setConfirmed(false);
      onMessage('准备完成：请勾选确认外发事实，再点击「确认并提交」。');
      if (showProgressSteps) setProgressPhase('ready');
    } catch {
      onMessage('准备视频提交失败，请重试。');
      if (showProgressSteps) {
        setProgressFailure('准备视频提交失败，请重试。');
        setProgressPhase('failed');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitPrepared(
    saved: VideoWorkspaceDraftDto,
    prepared: VideoFeaturePreparationDto
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
        const message = describeVideoFeatureError(result.error);
        onMessage(message);
        if (showProgressSteps) {
          setProgressFailure(message);
          setProgressPhase('failed');
        }
        return;
      }
      const feedback =
        result.value.feedback ??
        `提交状态：${result.value.status}`;
      onMessage(feedback);
      if (showProgressSteps) {
        if (result.value.status === 'completed') {
          setProgressPhase('completed');
        } else {
          setProgressFailure(feedback);
          setProgressPhase('failed');
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
    if (!api || !preparation || !confirmed || busy) return;
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
      onMessage('视频提交失败，请重试。');
      if (showProgressSteps) {
        setProgressFailure('视频提交失败，请重试。');
        setProgressPhase('failed');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="uc-image-feature-panel">
      <ModelSelect
        disabled={!api || loadState !== 'loaded'}
        emptyDescription={
          loadState === 'loading'
            ? '正在读取安全候选。'
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
            <span><strong>费用</strong>{costLabel(selectedCandidate.cost)}</span>
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
              changeParameter(fieldId, value as VideoWorkspaceParameterValueDto | undefined)
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
      ) : null}

      {preparation ? (
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
          <Checkbox
            checked={confirmed}
            className="uc-image-quick__checkbox"
            onChange={(_value, checked) => setConfirmed(checked)}
          >
            <span>我已核对并确认以上接收方、外发范围、内容与费用事实。</span>
          </Checkbox>
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
          Boolean(blockedReason) ||
          busy ||
          !selectedCandidate?.available ||
          (Boolean(preparation) && !confirmed)
        }
        onClick={() => void (preparation ? submit() : prepare())}
      >
        {preparation ? <LuSend aria-hidden="true" /> : <LuShieldCheck aria-hidden="true" />}
        {busy ? '处理中' : preparation ? '确认并提交' : '准备生成'}
      </Button>
      {showProgressSteps ? (
        <p className="uc-image-feature-panel__action-hint" role="status">
          {!selectedCandidate
            ? '下一步：选择可用模型；后台会按模型锁定 API 与参数合同。'
            : !selectedCandidate.available
              ? '所选模型当前不可用，请换一个或到「模型与服务商」检查连接授权。'
              : preparation && !confirmed
                ? '下一步：核对外发事实并勾选确认。'
                : preparation
                  ? '就绪：点击「确认并提交」发起请求。'
                  : busy
                    ? '正在处理…'
                    : '下一步：填写参数后点击「准备生成」。'}
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

function outboundScopeLabel(scope: VideoFeaturePreparationDto['confirmation']['outboundScope']) {
  if (scope === 'local_device') return '仅在本机';
  if (scope === 'local_network') return '局域网';
  if (scope === 'external_service') return '外部服务';
  return '未知';
}

function resetGeneration(): VideoWorkspaceDraftDto['generation'] {
  return {
    enhancement: { state: 'not_created', staleReasons: [] },
    preflight: { state: 'not_created', staleReasons: [] }
  };
}
