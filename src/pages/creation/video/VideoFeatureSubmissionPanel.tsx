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
  VideoFeatureCandidateDto,
  VideoFeatureIpcErrorCode,
  VideoFeaturePreparationDto
} from '../../../shared/video-feature-ipc';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceParameterValueDto
} from '../../../shared/video-workspace-ipc';

interface VideoFeatureSubmissionPanelProps {
  readonly dirty: boolean;
  readonly draft: VideoWorkspaceDraftDto;
  readonly blockedReason?: string;
  readonly onDraftChange: (draft: VideoWorkspaceDraftDto) => void;
  readonly onMessage: (message: string) => void;
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
  runtime_not_allowed: '在线视频运行尚未获准，没有发出请求。',
  authorization_not_claimed: '运行授权未取得，没有发出请求。',
  submission_failed_before_request: '请求发送前失败，没有产生远端结果。',
  submission_outcome_unknown: '提交结果未知，禁止自动重试。',
  adapter_contract_invalid: '视频适配器合同不匹配，已停止提交。',
  storage_error: '本地视频功能操作失败，请重试。'
};

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
  onDraftChange,
  onMessage
}: VideoFeatureSubmissionPanelProps) {
  const api = window.unicomp?.videoFeatures;
  const [candidates, setCandidates] = useState<readonly VideoFeatureCandidateDto[]>([]);
  const [preparation, setPreparation] = useState<VideoFeaturePreparationDto>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const featureSelection = draft.featureSelection ?? {
    productFeature: draft.mode === 'image_to_video'
      ? 'image_to_video' as const
      : 'text_to_video' as const,
    parameterValues: {}
  };
  const selectedCandidate = candidates.find(
    (candidate) => candidate.candidateId === featureSelection.candidateId
  );

  useEffect(() => {
    let active = true;
    setPreparation(undefined);
    setConfirmed(false);
    if (!api || dirty || draft.state !== 'saved' || blockedReason) return;
    setLoadState('loading');
    void api.listCandidates(draft.draftId, draft.updatedAt).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setCandidates([]);
        setLoadState('loaded');
        onMessage(errorMessages[result.error.code]);
        return;
      }
      setCandidates(result.value);
      setLoadState('loaded');
    }).catch(() => {
      if (!active) return;
      setCandidates([]);
      setLoadState('loaded');
      onMessage('读取视频服务候选失败，请重试。');
    });
    return () => {
      active = false;
    };
  }, [
    api,
    blockedReason,
    dirty,
    draft.draftId,
    draft.state,
    draft.updatedAt,
    featureSelection.productFeature,
    onMessage
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

  async function prepare() {
    if (!api || !selectedCandidate || dirty || busy || blockedReason) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await api.prepareSubmission(
        draft.draftId,
        draft.updatedAt,
        selectedCandidate.candidateId
      );
      if (!result.ok) {
        onMessage(errorMessages[result.error.code]);
        return;
      }
      setPreparation(result.value);
      setConfirmed(false);
      onMessage('已固定本次服务选择，请核对外发事实。');
    } catch {
      onMessage('准备视频提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!api || !preparation || !confirmed || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await api.submitDraft(
        draft.draftId,
        draft.updatedAt,
        preparation.routeSelectionToken,
        preparation.confirmation.confirmationId,
        true
      );
      if (!result.ok) {
        onMessage(errorMessages[result.error.code]);
        return;
      }
      onMessage(`提交状态：${result.value.status}`);
      setPreparation(undefined);
      setConfirmed(false);
    } catch {
      onMessage('视频提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="uc-image-feature-panel">
      <ModelSelect
        disabled={!api || dirty || loadState !== 'loaded'}
        emptyDescription={
          loadState === 'loading'
            ? '正在读取安全候选。'
            : dirty || draft.state !== 'saved'
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
            disabled={busy || dirty}
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
      ) : dirty || draft.state !== 'saved' ? (
        <p className="uc-image-quick__hint" role="status">
          请先保存本地草稿，再读取候选或准备生成。
        </p>
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
          Boolean(blockedReason) ||
          dirty ||
          busy ||
          !selectedCandidate?.available ||
          (Boolean(preparation) && !confirmed)
        }
        onClick={() => void (preparation ? submit() : prepare())}
      >
        {preparation ? <LuSend aria-hidden="true" /> : <LuShieldCheck aria-hidden="true" />}
        {busy ? '处理中' : preparation ? '确认并提交' : '准备生成'}
      </Button>
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
