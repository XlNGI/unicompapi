import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuSend } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import {
  DynamicParameterForm,
  toDynamicParameterFields,
  type DynamicParameterValue
} from '../../../components/DynamicParameterForm';
import {
  isVisibleModelUnavailableReason,
  ModelSelect
} from '../../../components/ModelSelect';
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
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceParameterValueDto
} from '../../../shared/video-workspace-ipc';
import { persistVideoWorkspaceDraft } from './persistVideoWorkspaceDraft';
import {
  describeUnconfirmedGenerationOutcome,
  isUnconfirmedGenerationOutcome
} from '../../../ui/notifications/generation-failure-reasons';

interface VideoFeatureSubmissionPanelProps {
  readonly className?: string;
  readonly dirty: boolean;
  readonly draft: VideoWorkspaceDraftDto;
  readonly blockedReason?: string;
  /** Quick video: hide dynamic params and use provider defaults. */
  readonly oneShot?: boolean;
  /** Text / image-to-video: show in-page 准备 → 请求中 → 等待上游 → 完成 progress. */
  readonly showProgressSteps?: boolean;
  /** Hosts the primary action in the workbench footer when provided. */
  readonly actionHost?: HTMLDivElement | null;
  /** Exposes real submit stages to the result preview without changing execution state. */
  readonly onProgressChange?: (
    phase: SubmissionProgressPhase,
    failureMessage?: string
  ) => void;
  readonly onDraftChange: (draft: VideoWorkspaceDraftDto) => void;
  readonly onDraftPersisted?: (draft: VideoWorkspaceDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onMessage: (message: string) => void;
  readonly onSubmissionComplete?: (submission: VideoFeatureSubmissionDto) => void;
}

const errorMessages: Partial<Record<VideoFeatureIpcErrorCode, string>> &
  Partial<Record<VideoWorkspaceIpcErrorCode, string>> = {
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
  authorization_not_claimed: '运行授权未取得，没有发出请求。',
  submission_failed_before_request: '请求发送前失败，没有产生远端结果。',
  submission_outcome_unknown: '提交结果未知，禁止自动重试。',
  adapter_contract_invalid: '视频适配器合同不匹配，已停止提交。',
  storage_error: '本地视频功能操作失败，请重试。'
};

const workspaceErrorMessages: Partial<Record<VideoWorkspaceIpcErrorCode, string>> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  draft_not_found: '当前视频草稿已不存在。',
  draft_conflict: '视频草稿已在其他操作中更新，请稍后重试。',
  workspace_storage_error: '本地视频草稿保存失败，请检查项目目录后重试。',
  invalid_request: '当前视频草稿数据无效，请刷新页面后重试。'
};

function describeWorkspacePersistError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  return (
    workspaceErrorMessages[error.code as VideoWorkspaceIpcErrorCode] ??
    errorMessages[error.code as VideoFeatureIpcErrorCode] ??
    error.message
  );
}

function describeVideoFeatureError(
  error: { readonly code: VideoFeatureIpcErrorCode; readonly message: string }
): string {
  return errorMessages[error.code] ?? '视频功能操作失败，请重试。';
}

const unavailableReasonLabels: Readonly<Record<string, string>> = {
  model_disabled: '模型未启用',
  model_not_present: '模型不在当前目录',
  connection_unavailable: '连接不可用',
  profile_unavailable: '功能档案未验证',
  feature_unsupported: '不支持当前视频方式',
  binding_unavailable: '协议适配器不可用',
  subject_constraints_unsatisfied: '草稿约束不满足',
  schema_unsupported: '参数定义无法识别'
};

export function VideoFeatureSubmissionPanel({
  className = '',
  dirty,
  draft,
  blockedReason,
  oneShot = false,
  showProgressSteps = false,
  actionHost,
  onProgressChange,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onMessage,
  onSubmissionComplete
}: VideoFeatureSubmissionPanelProps) {
  const api = window.unicomp?.videoFeatures;
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [candidates, setCandidates] = useState<readonly VideoFeatureCandidateDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const trackProgress = showProgressSteps || Boolean(onProgressChange);
  const featureSelection = draft.featureSelection ?? {
    productFeature: draft.mode === 'image_to_video'
      ? 'image_to_video' as const
      : 'text_to_video' as const,
    parameterValues: {}
  };
  const selectedCandidate = candidates.find(
    (candidate) => candidate.candidateId === featureSelection.candidateId
  );
  const busyRef = useRef(false);
  const draftRef = useRef(draft);
  const onMessageRef = useRef(onMessage);
  busyRef.current = busy;
  draftRef.current = draft;
  onMessageRef.current = onMessage;
  const selectedUnavailableReasons = selectedCandidate?.unavailableReasons.filter(
    isVisibleModelUnavailableReason
  ) ?? [];

  function silentlyFinishRuntimeGate() {
    onMessage('');
    if (trackProgress) {
      setProgressFailure(undefined);
      setProgressPhase('idle');
    }
  }

  useEffect(() => {
    onProgressChange?.(progressPhase, progressFailure);
  }, [onProgressChange, progressFailure, progressPhase]);

  useEffect(() => {
    setProgressPhase('idle');
    setProgressFailure(undefined);
  }, [draft.draftId]);

  function clearGenerationMessage() {
    onMessage('');
  }

  function showGenerationError(description: string) {
    onMessage(description);
  }

  function showSubmissionError(description: string) {
    onMessage(description);
  }

  function showGenerationUncertain(description: string) {
    onMessage(description);
  }

  function showSubmissionOutcome(submission: VideoFeatureSubmissionDto) {
    const urls = submission.resultVideoUrls ?? [];
    const rawFeedback = submission.feedback ?? submission.localResultError;
    const safeFeedback = rawFeedback && isUserFacingVideoFeedback(rawFeedback)
      ? rawFeedback
      : undefined;
    if (isUnconfirmedGenerationOutcome(submission.status, submission.safeCode)) {
      showGenerationUncertain(
        describeUnconfirmedGenerationOutcome(submission.safeCode)
      );
      return;
    }
    if (submission.status === 'failed_before_submission') {
      showSubmissionError(safeFeedback ?? '请求发送前失败，没有进入生成阶段。');
      return;
    }
    if (submission.localResultError) {
      showGenerationError(safeFeedback ?? '远端结果未能完成本地登记，请打开任务中心查看详情。');
      return;
    }
    if (submission.status === 'completed' && (urls.length > 0 || submission.workId)) {
      clearGenerationMessage();
      return;
    }
    if (submission.status === 'provider_accepted') {
      clearGenerationMessage();
      return;
    }
    showGenerationError(
      safeFeedback ?? (submission.status === 'completed'
        ? '任务已结束，但没有返回视频链接或本地作品，请打开任务中心查看详情。'
        : `生成未完成：${submissionStatusLabel(submission.status)}。请打开任务中心查看时间线。`)
    );
  }

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
    if (needsSave) {
      // Keep the active parameter contract mounted while autosave persists edits.
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    const timer = window.setTimeout(() => {
      void (async () => {
        if (busyRef.current) return;
        const draftId = draft.draftId;
        const draftUpdatedAt = draft.updatedAt;
        if (busyRef.current) return;
        const result = await api.listCandidates(draftId, draftUpdatedAt);
        if (!active || busyRef.current) return;
        if (!result.ok) {
          setCandidates([]);
          setLoadState('loaded');
          onMessageRef.current(describeVideoFeatureError(result.error));
          return;
        }
        setCandidates(result.value);
        setLoadState('loaded');
      })().catch(() => {
        if (!active || busyRef.current) return;
        setCandidates([]);
        setLoadState('loaded');
        onMessageRef.current('读取视频服务候选失败，请重试。');
      });
    }, 0);
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
    videoWorkspaces
  ]);

  function changeCandidate(candidateId: string) {
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    const sameSchema = candidate &&
      featureSelection.parameterSchemaId === candidate.parameterSchema.schemaId &&
      featureSelection.parameterSchemaRevision === candidate.parameterSchema.revision;
    const allowedFields = new Set(
      (candidate?.parameterSchema.fields ?? []).map((field) => field.fieldId)
    );
    const keptValues = sameSchema
      ? Object.fromEntries(
          Object.entries(featureSelection.parameterValues ?? {}).filter(([key]) =>
            allowedFields.has(key)
          )
        )
      : {};
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
        parameterValues: keptValues
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
    if (onFlushDraft) {
      if (!(await onFlushDraft())) return undefined;
      const refreshed = await videoWorkspaces.get(snapshot.draftId);
      if (!refreshed.ok || !refreshed.value) {
        showSubmissionError('无法读取刚刚保存的视频草稿，请重试。');
        return undefined;
      }
      return refreshed.value;
    }
    const result = await persistVideoWorkspaceDraft(
      videoWorkspaces,
      snapshot,
      'saved'
    );
    if (!result.ok) {
      showSubmissionError(describeWorkspacePersistError(result.error));
      return undefined;
    }
    onDraftPersisted?.(result.value);
    return result.value;
  }

  async function prepare() {
    if (!api || !selectedCandidate || busy || blockedReason) return;
    setBusy(true);
    busyRef.current = true;
    clearGenerationMessage();
    if (trackProgress) {
      setProgressFailure(undefined);
      setProgressPhase('preparing');
    }
    try {
      let saved = await ensureSavedDraft();
      if (!saved) {
        if (trackProgress) setProgressPhase('submission_failed');
        return;
      }
      clearGenerationMessage();
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
        if (result.error.code === 'runtime_not_allowed') {
          silentlyFinishRuntimeGate();
          return;
        }
        const message = describeVideoFeatureError(result.error);
        showSubmissionError(message);
        if (trackProgress) {
          setProgressFailure(message);
          setProgressPhase('submission_failed');
        }
        return;
      }
      clearGenerationMessage();
      await submitPrepared(saved, result.value);
    } catch {
      showSubmissionError('准备视频提交失败，请重试。');
      if (trackProgress) {
        setProgressFailure('准备视频提交失败，请重试。');
        setProgressPhase('submission_failed');
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
    clearGenerationMessage();
    if (trackProgress) {
      setProgressFailure(undefined);
      setProgressPhase('requesting');
    }
    const result = await api.submitDraft(
      saved.draftId,
      saved.updatedAt,
      prepared.routeSelectionToken,
      prepared.confirmation.confirmationId,
      true
    );
    if (!result.ok) {
      if (result.error.code === 'runtime_not_allowed') {
        silentlyFinishRuntimeGate();
        return;
      }
      const message = describeVideoFeatureError(result.error);
      const uncertain = result.error.code === 'submission_outcome_unknown';
      if (uncertain) {
        showGenerationUncertain(describeUnconfirmedGenerationOutcome());
      } else {
        showSubmissionError(message);
      }
      if (trackProgress) {
        setProgressFailure(uncertain ? describeUnconfirmedGenerationOutcome() : message);
        setProgressPhase(uncertain ? 'submission_uncertain' : 'submission_failed');
      }
      return;
    }
    const uncertain = isUnconfirmedGenerationOutcome(
      result.value.status,
      result.value.safeCode
    );
    const rawFeedback = result.value.feedback;
    const feedback = rawFeedback && !/[A-Za-z_]/u.test(rawFeedback)
      ? rawFeedback
      : `提交状态：${submissionStatusLabel(result.value.status)}`;
    showSubmissionOutcome(result.value);
    if (trackProgress) {
      if (uncertain) {
        setProgressFailure(describeUnconfirmedGenerationOutcome(result.value.safeCode));
        setProgressPhase('uncertain');
      } else if (result.value.status === 'completed') {
        setProgressPhase('completed');
      } else if (result.value.status === 'provider_accepted') {
        setProgressPhase('waiting');
      } else {
        setProgressFailure(feedback);
        setProgressPhase(
          result.value.status === 'failed_before_submission'
            ? 'submission_failed'
            : 'failed'
        );
      }
    }
    onSubmissionComplete?.(result.value);
  }

  return (
    <div className={`uc-image-feature-panel${className ? ` ${className}` : ''}`}>
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
          label: candidate.modelName,
          providerName: candidate.providerName,
          connectionName: candidate.connectionName,
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
              参数配置版本 {selectedCandidate.parameterSchema.revision}
            </span>
            <span><strong>费用</strong>{costLabel(selectedCandidate.cost)}</span>
            <StatusPill tone={selectedCandidate.available ? 'success' : 'warning'}>
              {selectedCandidate.available ? '可准备' : '当前不可用'}
            </StatusPill>
          </div>
          {!selectedCandidate.available && selectedUnavailableReasons.length > 0 ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>不可用原因</strong>
              {selectedUnavailableReasons.map((reason) => (
                <span key={reason}>• {unavailableReasonLabels[reason] ?? '其他不可用原因'}</span>
              ))}
            </div>
          ) : null}
          {oneShot ? (
            <p className="uc-model-select__hint" role="status">
              快速视频使用服务默认参数，无需填写动态参数。
            </p>
          ) : (
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
          )}
        </>
      ) : null}

      {blockedReason ? (
        <div className="uc-image-quick__preflight" role="status">
          <strong>当前不能生成</strong>
          <span>{blockedReason}</span>
        </div>
      ) : null}

      {showProgressSteps ? (
        <SubmissionProgressSteps
          failureMessage={progressFailure}
          phase={progressPhase}
        />
      ) : null}

      {actionHost ? createPortal(
        <Button
          className="uc-image-feature-panel__primary"
          disabled={
            Boolean(blockedReason) ||
            busy ||
            !selectedCandidate?.available
          }
          onClick={() => void prepare()}
        >
          <LuSend aria-hidden="true" />
          {busy ? '处理中' : '生成'}
        </Button>,
        actionHost
      ) : <Button
        className="uc-image-feature-panel__primary"
        disabled={
          Boolean(blockedReason) ||
          busy ||
          !selectedCandidate?.available
        }
        onClick={() => void prepare()}
      >
        <LuSend aria-hidden="true" />
        {busy ? '处理中' : '生成'}
      </Button>}
      {showProgressSteps ? (
        <p className="uc-image-feature-panel__action-hint" role="status">
          {!selectedCandidate
            ? '下一步：选择可用模型；后台会按模型锁定接口与参数配置。'
            : !selectedCandidate.available
              ? '所选模型当前不可用，请换一个或到「模型与服务商」检查连接授权。'
              : busy
                ? '正在处理…'
                : '下一步：填写参数后点击「生成」。'}
        </p>
      ) : null}
    </div>
  );
}

function isUserFacingVideoFeedback(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return false;
  // Prefer curated Chinese runtime copy; allow brief Latin only inside parentheses.
  if (/^(远端|视频|凭证|请求|本地|轮询|服务商)/u.test(text)) return true;
  return !/[A-Za-z_]/u.test(text);
}

function submissionStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    submitting: '正在提交',
    provider_accepted: '服务商已接受',
    running: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown_outcome: '结果未知'
  };
  return labels[status] ?? '未知提交状态';
}

function costLabel(cost: { readonly state: string; readonly summary?: string }): string {
  if (cost.state === 'known') return cost.summary ?? '费用已知';
  if (cost.state === 'not_applicable') return '不适用';
  return '未知，以服务商账单为准';
}


function resetGeneration(): VideoWorkspaceDraftDto['generation'] {
  return {
    enhancement: { state: 'not_created', staleReasons: [] },
    preflight: { state: 'not_created', staleReasons: [] }
  };
}
