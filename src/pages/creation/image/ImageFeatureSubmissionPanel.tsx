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
  ImageFeatureCandidateDto,
  ImageFeatureIpcErrorCode,
  ImageFeaturePreparationDto,
  ImageFeatureSubmissionDto
} from '../../../shared/image-feature-ipc';
import type {
  ImageWorkspaceIpcErrorCode,
  ImageWorkspaceParameterValueDto
} from '../../../shared/image-workspace-ipc';
import { useGlobalNotifications } from '../../../ui/notifications/GlobalNotificationProvider';
import {
  describeUnconfirmedGenerationOutcome,
  isUnconfirmedGenerationOutcome
} from '../../../ui/notifications/generation-failure-reasons';
import type { GenerationImageDraftDto } from './ImageGenerationControls';

interface ImageFeatureSubmissionPanelProps {
  readonly className?: string;
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly blockedReason?: string;
  readonly oneShot?: boolean;
  /**
   * Professional image: do not infer text/reference feature from draft.input.
   * Until the user explicitly picks a feature, hide model and parameter UI.
   */
  readonly requireExplicitFeature?: boolean;
  /** Professional image: omit the redundant candidate contract summary card. */
  readonly showCandidateFacts?: boolean;
  /** Professional image: show in-page 准备 → 提交中 → 生成中 → 完成 progress. */
  readonly showProgressSteps?: boolean;
  /** Optional fixed action host used by the professional two-pane workspace. */
  readonly actionHost?: HTMLElement | null;
  readonly onProgressChange?: (
    phase: SubmissionProgressPhase,
    failureMessage?: string
  ) => void;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted?: (draft: GenerationImageDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onMessage: (message: string) => void;
  readonly onSubmissionComplete?: (submission: ImageFeatureSubmissionDto) => void;
}

const errorMessages: Partial<Record<ImageFeatureIpcErrorCode, string>> &
  Partial<Record<ImageWorkspaceIpcErrorCode, string>> = {
  invalid_request: '图片功能请求无效，请重新保存当前草稿。',
  project_not_open: '当前没有打开的项目。',
  draft_not_found: '当前图片草稿已不存在。',
  draft_revision_changed: '草稿已变化，请重新选择服务和参数。',
  subject_invalid: '当前输入不适用于所选模型，请修改提示词或切换模型。',
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
  subject_constraints_unsatisfied: '草稿约束不满足',
  schema_unsupported: '参数定义无法识别'
};

export function ImageFeatureSubmissionPanel({
  className = '',
  dirty,
  draft,
  blockedReason,
  oneShot = false,
  requireExplicitFeature = false,
  showCandidateFacts = true,
  showProgressSteps = false,
  actionHost,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onMessage,
  onProgressChange,
  onSubmissionComplete
}: ImageFeatureSubmissionPanelProps) {
  const api = window.unicomp?.imageFeatures;
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const notifications = useGlobalNotifications();
  const [candidates, setCandidates] = useState<readonly ImageFeatureCandidateDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const trackProgress = showProgressSteps || Boolean(onProgressChange);
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
  const busyRef = useRef(false);
  const draftRef = useRef(draft);
  const onMessageRef = useRef(onMessage);
  busyRef.current = busy;
  draftRef.current = draft;
  onMessageRef.current = onMessage;
  const generationNotificationId = `image-generation:${draft.draftId}`;
  const selectedUnavailableReasons = selectedCandidate?.unavailableReasons.filter(
    isVisibleModelUnavailableReason
  ) ?? [];

  function silentlyFinishRuntimeGate() {
    notifications.dismiss(generationNotificationId);
    if (trackProgress) {
      setProgressFailure(undefined);
      setProgressPhase('idle');
    }
  }

  useEffect(() => {
    onProgressChange?.(progressPhase, progressFailure);
  }, [onProgressChange, progressFailure, progressPhase]);

  useEffect(() => {
    if (!trackProgress) return;
    setProgressFailure(undefined);
    setProgressPhase('idle');
  }, [draft.draftId, trackProgress]);

  function showGenerationProgress(
    description: string,
    title = '图片生成中',
    trackTask = false,
    taskId?: string
  ) {
    onMessage('');
    notifications.show({
      id: generationNotificationId,
      kind: 'progress',
      title,
      description,
      ...(trackTask ? {
        tracking: {
          mediaKind: 'image' as const,
          sourceDraftId: draft.draftId,
          ...(taskId ? { taskId } : {})
        }
      } : {})
    });
  }

  function showGenerationError(description: string) {
    onMessage('');
    notifications.show({
      id: generationNotificationId,
      kind: 'error',
      title: '图片生成失败',
      description
    });
  }

  function showSubmissionError(description: string) {
    onMessage('');
    notifications.show({
      id: generationNotificationId,
      kind: 'error',
      title: '图片提交失败',
      description
    });
  }

  function showGenerationUncertain(description: string) {
    onMessage('');
    notifications.show({
      id: generationNotificationId,
      kind: 'warning',
      title: '图片生成状态待确认',
      description
    });
  }

  function showSubmissionOutcome(submission: ImageFeatureSubmissionDto) {
    const urls = submission.resultImageUrls ?? [];
    const rawFeedback = submission.feedback ?? submission.localResultError;
    const safeFeedback = rawFeedback && !/[A-Za-z_]/u.test(rawFeedback)
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
      onMessage('');
      notifications.show({
        id: generationNotificationId,
        kind: 'success',
        title: '已成功生成',
        description: safeFeedback ?? (submission.workId
          ? '图片已完成本地校验并登记到作品库。'
          : '图片结果已返回，链接已写入调用记录。')
      });
      return;
    }
    if (submission.status === 'provider_accepted') {
      showGenerationProgress(
        safeFeedback ?? '提交成功，服务商正在排队或生成；真实结果以任务中心为准。',
        '图片生成中',
        true,
        submission.taskId
      );
      return;
    }
    const status = submissionStatusLabel(submission.status);
    showGenerationError(
      safeFeedback ?? (submission.status === 'completed'
        ? '任务已结束，但没有返回图片链接或本地作品，请打开任务中心查看详情。'
        : `生成未完成：${status}。请打开任务中心查看时间线。`)
    );
  }

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
    // Avoid racing prepare/submit: autosave + listCandidates must not run mid-flight.
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
        const snapshot = draft;
        const draftId = snapshot.draftId;
        const draftUpdatedAt = snapshot.updatedAt;
        if (busyRef.current) return;
        const result = await api.listCandidates(draftId, draftUpdatedAt);
        if (!active || busyRef.current) return;
        if (!result.ok) {
          setCandidates([]);
          setLoadState('loaded');
          onMessageRef.current(
            errorMessages[result.error.code] ?? '读取图片服务候选失败，请重试。'
          );
          return;
        }
        setCandidates(result.value);
        setLoadState('loaded');
      })().catch(() => {
        if (!active || busyRef.current) return;
        setCandidates([]);
        setLoadState('loaded');
        onMessageRef.current('读取图片服务候选失败，请重试。');
      });
    }, 0);
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
    draft.featureSelection?.candidateId,
    draft.prompt.originalInput,
    draft.state,
    draft.updatedAt,
    featureSelection.productFeature,
    imageWorkspaces,
    oneShot
  ]);

  // Quick image hides the parameter form; defaults are applied only at submit time.

  function changeCandidate(candidateId: string) {
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    const sameSchema = candidate &&
      featureSelection.parameterSchemaId === candidate.parameterSchema.schemaId &&
      featureSelection.parameterSchemaRevision === candidate.parameterSchema.revision;
    const nextValues = oneShot
      ? {}
      : {
          ...defaultQuickImageParameterValues(candidate?.parameterSchema.fields ?? []),
          ...(sameSchema ? featureSelection.parameterValues : {})
        };
    onMessage('');
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
        parameterValues: nextValues
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
    if (onFlushDraft) {
      if (!(await onFlushDraft())) return undefined;
      const refreshed = await imageWorkspaces.get(draft.draftId);
      if (!refreshed.ok || !refreshed.value) {
        showSubmissionError('无法读取刚刚保存的图片草稿，请重试。');
        return undefined;
      }
      return refreshed.value as GenerationImageDraftDto;
    }
    const result = await imageWorkspaces.update({
      ...draft,
      state: 'saved'
    });
    if (!result.ok) {
      showSubmissionError(errorMessages[result.error.code] ?? '保存图片草稿失败，请重试。');
      return undefined;
    }
    onDraftPersisted?.(result.value as GenerationImageDraftDto);
    return result.value as GenerationImageDraftDto;
  }

  async function prepare() {
    if (!api || !selectedCandidate || busy || blockedReason) return;
    setBusy(true);
    busyRef.current = true;
    showGenerationProgress('正在保存当前草稿并准备安全提交信息。', '图片提交准备中');
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
      showGenerationProgress('正在向主进程准备安全提交信息。', '图片提交准备中');
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
        if (result.error.code === 'runtime_not_allowed') {
          silentlyFinishRuntimeGate();
          return;
        }
        const message = errorMessages[result.error.code] ?? '图片提交准备失败，请重试。';
        showSubmissionError(message);
        if (trackProgress) {
          setProgressFailure(message);
          setProgressPhase('submission_failed');
        }
        return;
      }
      showGenerationProgress('提交信息已准备完成，正在继续生成。', '图片提交中');
      await submitPrepared(saved, result.value);
    } catch {
      showSubmissionError('准备图片提交失败，请重试。');
      if (trackProgress) {
        setProgressFailure('准备图片提交失败，请重试。');
        setProgressPhase('submission_failed');
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
    showGenerationProgress('正在向主进程提交生成请求。', '图片提交中');
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
      const message =
        errorMessages[result.error.code] ||
        '图片提交失败';
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
    const failed =
      result.value.status !== 'completed' &&
      result.value.status !== 'provider_accepted';
    const rawFeedback = result.value.feedback ?? result.value.localResultError;
    const feedback = rawFeedback && !/[A-Za-z_]/u.test(rawFeedback)
      ? rawFeedback
      : failed
        ? '图片提交未完成，请检查任务状态。'
        : '图片提交已受理。';
    showSubmissionOutcome(result.value);
    if (trackProgress) {
      if (uncertain) {
        setProgressFailure(describeUnconfirmedGenerationOutcome(result.value.safeCode));
        setProgressPhase('uncertain');
      } else if (failed || result.value.localResultError) {
        setProgressFailure(feedback);
        setProgressPhase(
          result.value.status === 'failed_before_submission'
            ? 'submission_failed'
            : 'failed'
        );
      } else if (result.value.status === 'provider_accepted') {
        setProgressPhase('waiting');
      } else {
        setProgressPhase('completed');
      }
    }
    onSubmissionComplete?.(result.value);
  }

  async function generateOneShot() {
    if (busyRef.current) return;
    if (!api) {
      showGenerationError('当前运行环境未连接桌面图片功能。');
      return;
    }
    if (blockedReason) {
      showGenerationError(blockedReason);
      return;
    }
    if (!selectedCandidate) {
      showGenerationError('请先选择可用的服务商 / 连接 / 模型。');
      return;
    }
    if (!selectedCandidate.available) {
      if (selectedUnavailableReasons.length > 0) {
        showGenerationError(
          `所选模型当前不可用：${selectedUnavailableReasons
            .map((reason) => unavailableReasonLabels[reason] ?? '其他不可用原因')
            .join('、')}`
        );
      }
      return;
    }
    const prompt = draft.prompt.finalPrompt.trim();
    if (prompt.length === 0) {
      showGenerationError('请先填写提示词。');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    showGenerationProgress('正在向主进程提交生成请求。', '图片提交中');
    if (trackProgress) {
      setProgressFailure(undefined);
      setProgressPhase('requesting');
    }
    try {
      if (api.generateQuickImage) {
        const parameterValues: Record<string, string | number | boolean | readonly string[]> = {
          ...defaultQuickImageParameterValues(selectedCandidate.parameterSchema.fields),
          ...(featureSelection.parameterValues as Readonly<
            Record<string, string | number | boolean | readonly string[]>
          >)
        };
        const result = await api.generateQuickImage(
          prompt,
          selectedCandidate.candidateId,
          parameterValues
        );
        if (!result.ok) {
          if (result.error.code === 'runtime_not_allowed') {
            silentlyFinishRuntimeGate();
            return;
          }
          if (result.error.code === 'submission_outcome_unknown') {
            showGenerationUncertain(describeUnconfirmedGenerationOutcome());
          } else {
            showSubmissionError(
              errorMessages[result.error.code] || '图片提交失败，请重试。'
            );
          }
          if (trackProgress) {
            const uncertain = result.error.code === 'submission_outcome_unknown';
            setProgressFailure(
              uncertain
                ? describeUnconfirmedGenerationOutcome()
                : errorMessages[result.error.code] || '图片提交失败，请重试。'
            );
            setProgressPhase(uncertain ? 'submission_uncertain' : 'submission_failed');
          }
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
            parameterValues
          }
        } as GenerationImageDraftDto);
        const submission = result.value.submission;
        showSubmissionOutcome(submission);
        if (trackProgress) {
          const uncertain = isUnconfirmedGenerationOutcome(
            submission.status,
            submission.safeCode
          );
          if (uncertain) {
            setProgressFailure(describeUnconfirmedGenerationOutcome(submission.safeCode));
            setProgressPhase('uncertain');
          } else if (submission.status === 'provider_accepted') {
            setProgressPhase('waiting');
          } else if (submission.status === 'completed') {
            setProgressPhase('completed');
          } else {
            setProgressFailure('图片提交未完成，请检查任务状态。');
            setProgressPhase('failed');
          }
        }
        onSubmissionComplete?.(submission);
        return;
      }
      await prepare();
    } catch {
      showSubmissionError('图片提交失败，请重试。');
      if (trackProgress) {
        setProgressFailure('图片提交失败，请重试。');
        setProgressPhase('submission_failed');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const primaryAction = (
    <Button
      className="uc-image-feature-panel__primary"
      disabled={
        oneShot
          ? Boolean(blockedReason) || busy || !selectedCandidate?.available
          : Boolean(blockedReason) ||
            busy ||
            !selectedCandidate?.available
      }
      onClick={() => void (oneShot
        ? generateOneShot()
        : prepare())}
    >
      <LuSend aria-hidden="true" />
      {busy ? '处理中' : '生成'}
    </Button>
  );

  return (
    <div className={`uc-image-feature-panel${className ? ` ${className}` : ''}`}>
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
            : '先在“模型与服务商”添加并启用图像模型，再回到这里选择。'
        }
        emptyTitle={loadState === 'loading' ? '正在读取模型' : '尚未配置可用模型'}
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
          {showCandidateFacts ? (
            <div className="uc-image-feature-panel__facts">
              <span>
                <strong>已锁定参数合同</strong>
                参数配置版本 {selectedCandidate.parameterSchema.revision}
              </span>
              <span>
                <strong>费用</strong>
                {costLabel(selectedCandidate.cost)}
              </span>
              <StatusPill tone={selectedCandidate.available ? 'success' : 'warning'}>
                {selectedCandidate.available ? '可准备' : '当前不可用'}
              </StatusPill>
            </div>
          ) : null}
          {!selectedCandidate.available && selectedUnavailableReasons.length > 0 ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>不可用原因</strong>
              {selectedUnavailableReasons.map((reason) => (
                <span key={reason}>• {unavailableReasonLabels[reason] ?? '其他不可用原因'}</span>
              ))}
            </div>
          ) : null}
          {oneShot ? (
            <p className="uc-image-feature-panel__action-hint" role="status">
              快速生图使用服务默认参数（含默认输出尺寸），无需填写动态参数。
            </p>
          ) : (
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

      {actionHost ? createPortal(primaryAction, actionHost) : primaryAction}
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

function submissionStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    created: '已创建',
    submitting: '正在提交',
    provider_accepted: '服务商已接受',
    running: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown_outcome: '结果未知'
  };
  return labels[status] ?? '未知生成状态';
}

function costLabel(cost: { readonly state: string; readonly summary?: string }): string {
  if (cost.state === 'known') return cost.summary ?? '费用已知';
  if (cost.state === 'not_applicable') return '不适用';
  return '未知，以服务商账单为准';
}

function defaultQuickImageParameterValues(
  fields: readonly {
    readonly fieldId: string;
    readonly required?: boolean;
    readonly exposure?: string;
    readonly options?: readonly (string | number | boolean)[];
  }[]
): Readonly<Record<string, string | number | boolean>> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    if (field.fieldId === 'size' && field.options && field.options.length > 0) {
      values.size = field.options[0] as string | number | boolean;
      continue;
    }
    const required = field.required === true || field.exposure === 'user_required';
    if (!required || !field.options || field.options.length < 1) continue;
    const first = field.options[0];
    if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean') {
      values[field.fieldId] = first;
    }
  }
  return values;
}
