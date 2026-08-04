import { useEffect, useState } from 'react';
import { LuSend, LuShieldCheck } from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { StatusPill } from '../../../components/StatusPill';
import type {
  VideoFeatureCandidateDto,
  VideoFeatureIpcErrorCode,
  VideoFeatureParameterFieldDto,
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
  readonly blockedRecovery?: {
    readonly label: string;
    readonly onClick: () => void;
  };
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
  blockedRecovery,
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
  const isQuick = draft.mode === 'quick_video';
  const parameterFields = (selectedCandidate?.parameterSchema.fields ?? []).filter((field) => {
    const condition = field.display?.visibleWhen;
    if (!condition) return true;
    const matches = featureSelection.parameterValues[condition.fieldId] === condition.value;
    return condition.operator === 'equals' ? matches : !matches;
  });
  const requiredParameters = parameterFields.filter((field) => field.required);
  const optionalParameters = parameterFields.filter((field) => !field.required);

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
    <div className="uc-image-feature-panel" data-quick={isQuick || undefined}>
      <label className="uc-image-quick__field">
        <span>生成模型</span>
        <select
          disabled={!api || dirty || loadState !== 'loaded' || candidates.length === 0}
          onChange={(event) => changeCandidate(event.target.value)}
          value={featureSelection.candidateId ?? ''}
        >
          <option value="">请选择服务候选</option>
          {candidates.map((candidate) => (
            <option key={candidate.candidateId} value={candidate.candidateId}>
              {candidate.modelName}
              {candidate.available ? '' : '（不可用）'}
            </option>
          ))}
        </select>
      </label>

      {loadState === 'loading' ? (
        <p className="uc-image-quick__hint" role="status">正在读取安全候选。</p>
      ) : loadState === 'loaded' && candidates.length === 0 ? (
        <p className="uc-image-quick__hint" role="status">
          当前没有匹配的服务候选，请在“模型与服务商”中完成连接与模型配置。
        </p>
      ) : null}

      {selectedCandidate ? (
        <>
          {!isQuick && <div className="uc-image-feature-panel__facts">
            <span>
              <strong>动态参数</strong>
              {parameterFields.length} 项 · 随模型能力加载
            </span>
            <StatusPill tone={selectedCandidate.available ? 'success' : 'warning'}>
              {selectedCandidate.available ? '可准备' : '当前不可用'}
            </StatusPill>
          </div>}
          {!selectedCandidate.available ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>不可用原因</strong>
              {selectedCandidate.unavailableReasons.map((reason) => (
                <span key={reason}>• {unavailableReasonLabels[reason] ?? reason}</span>
              ))}
            </div>
          ) : null}
          {!isQuick && <div className="uc-image-quick__parameters">
            {parameterFields.length === 0 ? (
              <p className="uc-image-quick__hint">当前表面没有需要用户填写的参数。</p>
            ) : requiredParameters.map((field) => (
              <ParameterField
                field={field}
                key={field.fieldId}
                onChange={(value) => changeParameter(field.fieldId, value)}
                value={featureSelection.parameterValues[field.fieldId]}
              />
            ))}
            {optionalParameters.length > 0 && (
              <details className="uc-dynamic-parameters__optional">
                <summary>可选参数（{optionalParameters.length}）</summary>
                <div className="uc-dynamic-parameters__grid">
                  {optionalParameters.map((field) => (
                    <ParameterField
                      field={field}
                      key={field.fieldId}
                      onChange={(value) => changeParameter(field.fieldId, value)}
                      value={featureSelection.parameterValues[field.fieldId]}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>}
        </>
      ) : null}

      {blockedReason && !isQuick ? (
        <div className="uc-image-quick__preflight" role="status">
          <strong>当前不能生成</strong>
          <span>{blockedReason}</span>
          {blockedRecovery ? (
            <Button onClick={blockedRecovery.onClick} variant="secondary">
              {blockedRecovery.label}
            </Button>
          ) : null}
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
        {busy ? '处理中' : preparation ? '确认并生成' : '生成视频'}
      </Button>
    </div>
  );
}

function ParameterField({
  field,
  value,
  onChange
}: {
  readonly field: VideoFeatureParameterFieldDto;
  readonly value: VideoWorkspaceParameterValueDto | undefined;
  readonly onChange: (value: VideoWorkspaceParameterValueDto | undefined) => void;
}) {
  const label = `${field.display?.label ?? field.labelId}${field.required ? '（必填）' : ''}`;
  if (field.valueType === 'boolean') {
    return (
      <label className="uc-image-quick__checkbox">
        <input
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span title={parameterHelp(field)}>{label}</span>
        <ParameterHelp field={field} />
      </label>
    );
  }
  if (field.valueType === 'enum') {
    return (
      <label className="uc-image-quick__field">
        <span title={parameterHelp(field)}>{label}</span>
        <select
          onChange={(event) => {
            const option = field.options?.find((item) => String(item) === event.target.value);
            onChange(option);
          }}
          value={value === undefined ? '' : String(value)}
        >
          <option value="">请选择</option>
          {field.options?.map((option) => (
            <option key={String(option)} value={String(option)}>{optionLabel(field, option)}</option>
          ))}
        </select>
        <ParameterHelp field={field} />
      </label>
    );
  }
  if (field.valueType === 'number' || field.valueType === 'integer') {
    return (
      <label className="uc-image-quick__field">
        <span title={parameterHelp(field)}>{label}</span>
        <input
          max={field.maximum}
          min={field.minimum}
          onChange={(event) => onChange(
            event.target.value === '' ? undefined : Number(event.target.value)
          )}
          step={field.valueType === 'integer' ? 1 : field.step}
          type="number"
          value={typeof value === 'number' ? value : ''}
        />
        <ParameterHelp field={field} />
      </label>
    );
  }
  if (field.valueType === 'string_array' || field.valueType === 'number_array') {
    return (
      <label className="uc-image-quick__field">
        <span title={parameterHelp(field)}>{label}</span>
        <input
          onChange={(event) => {
            const items = event.target.value.split(',').map((item) => item.trim()).filter(Boolean);
            onChange(items.length === 0
              ? undefined
              : field.valueType === 'number_array'
                ? items.map(Number)
                : items);
          }}
          placeholder="使用逗号分隔"
          type="text"
          value={Array.isArray(value) ? value.join(', ') : ''}
        />
        <ParameterHelp field={field} />
      </label>
    );
  }
  if (field.valueType === 'object') {
    return <ObjectParameterField field={field} onChange={onChange} value={value} />;
  }
  if (field.valueType === 'media_slot') {
    return (
      <label className="uc-image-quick__field">
        <span title={parameterHelp(field)}>{label}</span>
        <input disabled readOnly value="由当前草稿的受控图片提供" />
        <ParameterHelp field={field} />
      </label>
    );
  }
  return (
    <label className="uc-image-quick__field">
      <span title={parameterHelp(field)}>{label}</span>
      <input
        onChange={(event) => onChange(event.target.value || undefined)}
        type="text"
        value={typeof value === 'string' ? value : ''}
      />
      <ParameterHelp field={field} />
    </label>
  );
}

function ObjectParameterField({
  field,
  value,
  onChange
}: {
  readonly field: VideoFeatureParameterFieldDto;
  readonly value: VideoWorkspaceParameterValueDto | undefined;
  readonly onChange: (value: VideoWorkspaceParameterValueDto | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value));
    setInvalid(false);
  }, [value]);
  return (
    <label className="uc-image-quick__field">
      <span title={parameterHelp(field)}>{field.display?.label ?? field.labelId}{field.required ? '（必填）' : ''}</span>
      <textarea
        aria-invalid={invalid}
        onBlur={() => {
          if (!text.trim()) {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(text) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new TypeError('object required');
            }
            setInvalid(false);
            onChange(parsed as VideoWorkspaceParameterValueDto);
          } catch {
            setInvalid(true);
          }
        }}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        value={text}
      />
      {invalid ? <small role="alert">请输入有效的 JSON 对象。</small> : null}
      <ParameterHelp field={field} />
    </label>
  );
}

function ParameterHelp({ field }: { readonly field: VideoFeatureParameterFieldDto }) {
  const help = parameterHelp(field);
  return help ? <small className="uc-dynamic-parameters__help">{help}</small> : null;
}

function parameterHelp(field: VideoFeatureParameterFieldDto): string {
  const range = field.minimum !== undefined || field.maximum !== undefined
    ? `范围 ${field.minimum ?? '不限'}–${field.maximum ?? '不限'}${field.unitId ? ` ${field.unitId}` : ''}`
    : field.unitId ? `单位 ${field.unitId}` : '';
  return [field.display?.description, field.display?.note, range].filter(Boolean).join(' · ');
}

function optionLabel(field: VideoFeatureParameterFieldDto, value: string | number | boolean) {
  return field.display?.optionLabels?.find((option) => option.value === value)?.label ?? String(value);
}

function resetGeneration(): VideoWorkspaceDraftDto['generation'] {
  return {
    enhancement: { state: 'not_created', staleReasons: [] },
    preflight: { state: 'not_created', staleReasons: [] }
  };
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
