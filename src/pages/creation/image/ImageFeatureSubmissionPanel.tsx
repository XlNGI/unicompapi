import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuSend, LuRefreshCw } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import {
  DynamicParameterForm,
  toDynamicParameterFields,
  validateDynamicParameterValues,
  type DynamicParameterBufferFlush,
  type DynamicParameterFormHandle,
  type DynamicParameterValue
} from '../../../components/DynamicParameterForm';
import { reportParameterInputCandidateRequest } from '../../../ui/parameter-input-performance-probe';
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
import {
  describeUnconfirmedGenerationOutcome,
  isUnconfirmedGenerationOutcome
} from '../../../ui/notifications/generation-failure-reasons';
import { CreationAdvancedSection } from '../CreationAdvancedSection';
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
  /** Professional image: tuck optional model parameters behind an on-demand section. */
  readonly collapseParameters?: boolean;
  /** Optional fixed action host used by the professional two-pane workspace. */
  readonly actionHost?: HTMLElement | null;
  readonly onProgressChange?: (
    phase: SubmissionProgressPhase,
    failureMessage?: string
  ) => void;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted?: (draft: GenerationImageDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onNavigateToProviders?: () => void;
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
  collapseParameters = false,
  actionHost,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onNavigateToProviders,
  onMessage,
  onProgressChange,
  onSubmissionComplete
}: ImageFeatureSubmissionPanelProps) {
  const api = window.unicomp?.imageFeatures;
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const [candidates, setCandidates] = useState<readonly ImageFeatureCandidateDto[]>([]);
  const [candidateScope, setCandidateScope] = useState('');
  const [loadedRevision, setLoadedRevision] = useState('');
  const [requestKey, setRequestKey] = useState('');
  const [retry, setRetry] = useState(0);
  const [navigationError, setNavigationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'failed'>('idle');
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const [parameterInputErrors, setParameterInputErrors] = useState<Readonly<Record<string, string>>>({});
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
  const scope = `${draft.draftId}:${featureSelection.productFeature}`;
  const currentCandidates = candidateScope === scope ? candidates : [];
  const missingPrompt = !draft.prompt.finalPrompt.trim();
  const missingImage = featureSelection.productFeature === 'reference_to_image' && !draft.input;
  const inputRequired = missingPrompt && missingImage
    ? '请输入提示词，并添加一张参考图。'
    : missingPrompt ? '请输入提示词。' : missingImage ? '请添加一张参考图。' : undefined;
  const needsSave = dirty || draft.state !== 'saved';
  const candidatesReady = candidateScope === scope && loadedRevision === draft.updatedAt &&
    loadState === 'loaded' && !needsSave && !inputRequired && !blockedReason && Boolean(api);
  const selectedCandidate = currentCandidates.find(
    (candidate) => candidate.candidateId === featureSelection.candidateId
  );
  const busyRef = useRef(false);
  const draftRef = useRef(draft);
  const parameterFormRef = useRef<DynamicParameterFormHandle>(null);
  // Commits are composed from refs, never from a render closure: the form can
  // commit two fields in one tick (flush before submit), and the effective
  // feature selection may be synthesized rather than taken from the draft.
  const featureSelectionRef = useRef(featureSelection);
  busyRef.current = busy;
  draftRef.current = draft;
  featureSelectionRef.current = featureSelection;
  const selectedUnavailableReasons = selectedCandidate?.unavailableReasons.filter(
    isVisibleModelUnavailableReason
  ) ?? [];
  const dynamicParameterFields = selectedCandidate
    ? toDynamicParameterFields(selectedCandidate.parameterSchema.fields)
    : [];
  const parameterValidation = validateDynamicParameterValues(
    dynamicParameterFields,
    featureSelection.parameterValues as Readonly<Record<string, DynamicParameterValue | undefined>>,
    parameterInputErrors
  );
  const parameterForm = (
    <DynamicParameterForm
      ref={parameterFormRef}
      disabled={busy}
      emptyHint="当前表面没有需要用户填写的参数。"
      fields={dynamicParameterFields}
      errors={parameterValidation.errors}
      surface="image_generation"
      onInputErrorChange={(fieldId, error) => {
        setParameterInputErrors((current) => {
          const next = { ...current };
          if (error) next[fieldId] = error;
          else delete next[fieldId];
          return next;
        });
      }}
      onChange={(fieldId, value) =>
        changeParameter(fieldId, value as ImageWorkspaceParameterValueDto | undefined)
      }
      values={featureSelection.parameterValues as Readonly<
        Record<string, DynamicParameterValue | undefined>
      >}
    />
  );

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
    if (!trackProgress) return;
    setProgressFailure(undefined);
    setProgressPhase('idle');
  }, [draft.draftId, trackProgress]);

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
      clearGenerationMessage();
      return;
    }
    if (submission.status === 'provider_accepted') {
      clearGenerationMessage();
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
    setNavigationError('');
    if (!api) {
      setLoadState('failed');
      return;
    }
    if (blockedReason || inputRequired) {
      setLoadState('idle');
      return;
    }
    // Avoid racing prepare/submit: autosave + listCandidates must not run mid-flight.
    if (busyRef.current) return;
    if (needsSave) {
      // Retain the visible selection while waiting for the saved revision.
      return;
    }
    setLoadState('loading');
    setRequestKey(`${scope}:${draft.updatedAt}`);
    const timer = window.setTimeout(() => {
      void (async () => {
        if (busyRef.current) return;
        const snapshot = draftRef.current;
        const draftId = snapshot.draftId;
        const draftUpdatedAt = snapshot.updatedAt;
        if (busyRef.current) return;
        reportParameterInputCandidateRequest();
        const result = await api.listCandidates(draftId, draftUpdatedAt);
        if (!active || busyRef.current) return;
        if (!result.ok) {
          setLoadState('failed');
          return;
        }
        setCandidates(result.value);
        setCandidateScope(scope);
        setLoadedRevision(draftUpdatedAt);
        setLoadState('loaded');
      })().catch(() => {
        if (!active || busyRef.current) return;
        setLoadState('failed');
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    api,
    awaitingFeatureChoice,
    inputRequired,
    scope,
    retry,
    busy,
    needsSave,
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
    const candidate = currentCandidates.find((item) => item.candidateId === candidateId);
    const snapshot = draftRef.current;
    const selection = featureSelectionRef.current;
    const sameSchema = candidate &&
      selection.parameterSchemaId === candidate.parameterSchema.schemaId &&
      selection.parameterSchemaRevision === candidate.parameterSchema.revision;
    const nextValues = {
      ...(!oneShot
        ? defaultUnsetWatermarkParameter(candidate?.parameterSchema.fields ?? [])
        : {}),
      ...(sameSchema ? selection.parameterValues : {})
    };
    onMessage('');
    setParameterInputErrors({});
    const next: GenerationImageDraftDto = {
      ...snapshot,
      state: 'editing',
      generation: {},
      featureSelection: {
        productFeature: selection.productFeature,
        ...(candidate
          ? {
              candidateId: candidate.candidateId,
              parameterSchemaId: candidate.parameterSchema.schemaId,
              parameterSchemaRevision: candidate.parameterSchema.revision
            }
          : {}),
        parameterValues: nextValues
      }
    };
    draftRef.current = next;
    onDraftChange(next);
  }

  function changeParameter(
    fieldId: string,
    value: ImageWorkspaceParameterValueDto | undefined
  ) {
    setParameterInputErrors((current) => {
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
    // Compose from the latest snapshot rather than the render closure: the
    // parameter form may commit two fields in the same tick (flush before
    // submit), and both changes must survive.
    const snapshot = draftRef.current;
    const selection = featureSelectionRef.current;
    const parameterValues = { ...selection.parameterValues } as Record<
      string,
      ImageWorkspaceParameterValueDto
    >;
    if (value === undefined) delete parameterValues[fieldId];
    else parameterValues[fieldId] = value;
    const next: GenerationImageDraftDto = {
      ...snapshot,
      state: 'editing',
      generation: {},
      featureSelection: { ...selection, parameterValues }
    };
    draftRef.current = next;
    onDraftChange(next);
  }

  /**
   * Commits whatever the user has typed but not yet blurred. Called before
   * every save/submit so a focused control can never be left behind, and so an
   * invalid intermediate value blocks the request instead of being dispatched.
   */
  function commitPendingParameterEdits(): DynamicParameterBufferFlush {
    const handle = parameterFormRef.current;
    if (!handle) return { values: {}, committedFieldIds: [], errors: {}, valid: true };
    return handle.flush();
  }

  /**
   * Full schema validation over the values that would actually be saved, after
   * the pending buffers have been committed.
   */
  function validateSubmittedParameters(pendingEdits: DynamicParameterBufferFlush) {
    return validateDynamicParameterValues(
      dynamicParameterFields,
      pendingEdits.values as Readonly<Record<string, DynamicParameterValue | undefined>>,
      pendingEdits.errors
    );
  }

  async function ensureSavedDraft(): Promise<GenerationImageDraftDto | undefined> {
    if (!imageWorkspaces) return undefined;
    const snapshot = draftRef.current;
    if (!dirty && snapshot.state === 'saved') return snapshot;
    if (onFlushDraft) {
      if (!(await onFlushDraft())) return undefined;
      const refreshed = await imageWorkspaces.get(snapshot.draftId);
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
    if (!api || !selectedCandidate || busy || !candidatesReady) return;
    // Commit the control the user is still typing in, then run the full schema
    // validation on the merged values. An invalid intermediate state never
    // leaves this function.
    const pendingEdits = commitPendingParameterEdits();
    const submittedValidation = validateSubmittedParameters(pendingEdits);
    if (!submittedValidation.valid) {
      setParameterInputErrors(pendingEdits.errors);
      showSubmissionError(submittedValidation.firstError ?? '请先修正动态参数。');
      return;
    }
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
      clearGenerationMessage();
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
    if (busyRef.current || !candidatesReady) return;
    const pendingEdits = commitPendingParameterEdits();
    const submittedValidation = validateSubmittedParameters(pendingEdits);
    if (!submittedValidation.valid) {
      setParameterInputErrors(pendingEdits.errors);
      showGenerationError(submittedValidation.firstError ?? '请先修正动态参数。');
      return;
    }
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
    clearGenerationMessage();
    if (trackProgress) {
      setProgressFailure(undefined);
      setProgressPhase('requesting');
    }
    try {
      if (api.generateQuickImage) {
        const parameterValues: Record<string, string | number | boolean | readonly string[]> = {
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

  async function navigateToProviders() {
    setNavigationError('');
    const snapshot = draftRef.current;
    try {
      const pending = commitPendingParameterEdits();
      if (!pending.valid || (onFlushDraft && !(await onFlushDraft()))) {
        setNavigationError('草稿尚未保存，请稍后重试。');
        return;
      }
      if (draftRef.current.draftId !== snapshot.draftId) return;
      onNavigateToProviders?.();
    } catch {
      setNavigationError('保存草稿失败，请重试。');
    }
  }

  const featureName = featureSelection.productFeature === 'reference_to_image' ? '图生图' : '文生图';
  const feedback: { title: string; description?: string; warning: boolean; action?: 'retry' | 'providers' } | undefined =
    inputRequired ? { title: '请补全生成内容', description: inputRequired, warning: true }
    : blockedReason ? { title: '当前不能生成', description: blockedReason, warning: true }
    : busy ? { title: '正在提交生成请求…', warning: false }
    : needsSave ? { title: '正在保存草稿，保存后读取模型。', warning: false }
    : !api ? { title: '模型读取失败', description: '当前运行环境未连接桌面图片功能。', warning: true }
    : loadState === 'failed' && requestKey === `${scope}:${draft.updatedAt}` ? { title: '模型读取失败', description: '未能读取当前功能的模型，请重试。', warning: true, action: 'retry' }
    : !candidatesReady ? { title: '正在读取模型…', warning: false }
    : currentCandidates.length === 0 ? {
        title: `暂无可用的${featureName}模型`,
        description: `当前没有可供本项目选择的${featureName}模型，请到模型与服务商检查连接及模型配置。`,
        warning: true, action: 'providers'
      }
    : !selectedCandidate ? { title: '请选择模型', warning: false }
    : !selectedCandidate.available ? { title: '所选模型当前不可用', description: selectedUnavailableReasons.map((reason) => unavailableReasonLabels[reason] ?? '其他不可用原因').join('、') || '请检查模型与连接状态。', warning: true }
    : !parameterValidation.valid ? { title: '请修正模型参数', description: parameterValidation.firstError, warning: true }
    : undefined;

  const primaryAction = (
    <Button
      className="uc-image-feature-panel__primary"
      disabled={
        !candidatesReady ||
        busy ||
        !parameterValidation.valid ||
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
        disabled={!candidatesReady || currentCandidates.length === 0 || busy}
        showEmptyState={false}
        onChange={changeCandidate}
        options={currentCandidates.map((candidate) => ({
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
          {oneShot && dynamicParameterFields.length === 0 ? (
            <p className="uc-image-feature-panel__action-hint" role="status">
              快速生图使用服务默认参数（含默认输出尺寸），无需填写动态参数。
            </p>
          ) : (
            collapseParameters && dynamicParameterFields.length > 0 ? (
              <CreationAdvancedSection
                defaultOpen={!parameterValidation.valid}
                note={`${dynamicParameterFields.length} 项`}
                title="模型参数"
              >
                {parameterForm}
              </CreationAdvancedSection>
            ) : parameterForm
          )}
        </>
      ) : null}

      {feedback ? (
        <div className={feedback.warning ? 'uc-image-quick__preflight' : 'uc-image-feature-panel__action-hint'} role="status">
          <strong>{feedback.title}</strong>
          {feedback.description ? <span>{feedback.description}</span> : null}
          {feedback.action === 'retry' ? (
            <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}><LuRefreshCw aria-hidden="true" />重试读取</Button>
          ) : feedback.action === 'providers' && onNavigateToProviders ? (
            <Button variant="secondary" onClick={() => void navigateToProviders()}>模型与服务商</Button>
          ) : null}
          {navigationError ? <span>{navigationError}</span> : null}
        </div>
      ) : null}

      {showProgressSteps ? (
        <SubmissionProgressSteps
          failureMessage={progressFailure}
          phase={progressPhase}
        />
      ) : null}

      {actionHost ? createPortal(primaryAction, actionHost) : primaryAction}
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

/**
 * The professional parameter form renders optional boolean switches as
 * "off" by default, but omitting the field would let the provider apply its
 * own default (Seedream 5.0 defaults to a watermark). Send an explicit
 * "watermark: false" when the schema exposes the switch and the user has not
 * chosen a value, so the visible "off" state matches the request.
 */
function defaultUnsetWatermarkParameter(
  fields: readonly {
    readonly fieldId: string;
    readonly valueType?: string;
    readonly kind?: string;
    readonly required?: boolean;
    readonly exposure?: string;
  }[]
): Readonly<Record<string, boolean>> {
  const field = fields.find((candidate) => candidate.fieldId === 'watermark');
  const valueType = field?.valueType ?? field?.kind;
  const required = field?.required === true || field?.exposure === 'user_required';
  if (!field || required || valueType !== 'boolean') return {};
  return { watermark: false };
}
