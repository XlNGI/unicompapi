import type {
  VideoPreflightCandidateDto,
  VideoSubmissionConfirmationDto,
  VideoSubmissionErrorCode
} from '../../../shared/video-submission-ipc';
import type {
  VideoWorkspaceDtoMode,
  VideoWorkspaceModelDto,
  VideoWorkspaceParameterValueDto,
  VideoWorkspaceParametersDto
} from '../../../shared/video-workspace-ipc';
import type {
  ProviderCapabilitySummaryDto,
  ProviderRegistryDto
} from '../../../shared/provider-ipc';

export const videoSubmissionErrorMessages: Record<
  VideoSubmissionErrorCode,
  string
> = {
  submission_outcome_unknown:
    'Submission outcome is unknown. Create a new task only after confirming the charge status.',
  project_not_open: '当前没有打开的项目。',
  invalid_request: '提交信息无效，请检查当前草稿。',
  draft_not_found: '当前视频草稿已不存在。',
  draft_not_submittable: '请填写创作需求并保存草稿后再检查。',
  prompt_required: '请先填写最终提交提示词。',
  no_route_candidate: '没有符合视频生成用途的已启用模型路由。',
  capability_unverified: '视频生成能力尚未验证。',
  capability_snapshot_stale: '当前模型能力快照已过期，请重新选择模型。',
  parameter_schema_missing: '模型没有可用的动态参数 Schema。',
  mode_schema_missing: '模型没有视频模式能力 Schema。',
  mode_schema_invalid: '模型的视频模式能力声明无效。',
  mode_unsupported: '所选模型不支持当前视频模式。',
  parameters_invalid: '动态参数缺失或超出模型声明范围。',
  material_slots_stale: '素材槽位已过期，请重新选择模型和素材。',
  material_required: '当前能力要求的素材尚未选择。',
  material_invalid: '已选素材与当前能力要求不匹配或本地文件不可用。',
  shot_plan_invalid: '镜头方案不符合当前模型的动态能力要求。',
  confirmation_required: '请逐项确认接收方、外发、素材、费用、提示词和模型。',
  task_not_found: '视频任务已不存在。',
  execution_not_found: '视频执行记录已不存在。',
  invalid_execution_state: '当前执行状态不允许此操作。',
  adapter_unavailable: '没有配置真实视频生成适配器，当前不会外发或生成。',
  result_discovery_failed: '无法读取远端完成事实或视频结果清单。',
  download_failed: '视频结果下载失败，未登记为作品。',
  result_verification_failed: '视频结果未通过本地媒体与完整性校验。',
  result_registration_failed: '视频文件已保留，但作品登记失败。',
  submission_storage_error: '任务或执行记录写入本地项目失败。'
};

export const emptyVideoConfirmations: VideoSubmissionConfirmationDto = {
  recipient: false,
  outboundScope: false,
  materials: false,
  costPrivacyRegion: false,
  finalPrompt: false,
  model: false
};

export function allVideoConfirmationsAccepted(
  confirmations: VideoSubmissionConfirmationDto
) {
  return Object.values(confirmations).every(Boolean);
}

export function VideoGenerationModelFields({
  mode,
  model,
  parameters,
  registry,
  onChange
}: {
  readonly mode: VideoWorkspaceDtoMode;
  readonly model?: VideoWorkspaceModelDto;
  readonly parameters?: VideoWorkspaceParametersDto;
  readonly registry?: ProviderRegistryDto;
  readonly onChange: (selection: {
    readonly model?: VideoWorkspaceModelDto;
    readonly parameters?: VideoWorkspaceParametersDto;
  }) => void;
}) {
  const modelOptions = getVideoModelOptions(registry, mode);
  const selectedOption = modelOptions.find(
    (option) => option.modelId === model?.modelId
  );

  function changeModel(modelId: string) {
    const option = modelOptions.find(
      (candidate) =>
        candidate.modelId === modelId &&
        !candidate.reason &&
        candidate.evidence
    );
    onChange(
      option?.evidence
        ? {
            model: {
              modelId: option.modelId,
              capabilityEvidenceId: option.evidence.evidenceId
            },
            parameters: {
              capabilityEvidenceId: option.evidence.evidenceId,
              values: {}
            }
          }
        : {}
    );
  }

  function changeParameter(
    key: string,
    value: VideoWorkspaceParameterValueDto | undefined
  ) {
    if (!selectedOption?.evidence || selectedOption.reason) return;
    const values = {
      ...(parameters?.values ?? {})
    } as Record<string, VideoWorkspaceParameterValueDto>;
    if (value === undefined) delete values[key];
    else values[key] = value;
    onChange({
      model: {
        modelId: selectedOption.modelId,
        capabilityEvidenceId: selectedOption.evidence.evidenceId
      },
      parameters: {
        capabilityEvidenceId: selectedOption.evidence.evidenceId,
        values
      }
    });
  }

  return (
    <>
      <label className="uc-image-quick__field">
        <span>视频生成模型</span>
        <select
          disabled={modelOptions.length === 0}
          onChange={(event) => changeModel(event.target.value)}
          value={model?.modelId ?? ''}
        >
          <option value="">请选择模型</option>
          {modelOptions.map((option) => (
            <option
              disabled={Boolean(option.reason)}
              key={option.modelId}
              value={option.modelId}
            >
              {option.modelName}
              {option.reason ? `（${option.reason}）` : ''}
            </option>
          ))}
        </select>
      </label>
      {modelOptions.length === 0 ? (
        <p className="uc-image-quick__hint">
          没有符合当前视频模式的模型或路由；请先在“模型与服务商”页面完成配置。
        </p>
      ) : null}
      {selectedOption?.evidence && !selectedOption.reason ? (
        <div className="uc-image-quick__parameters">
          {selectedOption.evidence.parameterSchema?.fields.map((field) => (
            <DynamicParameterField
              field={field}
              key={field.key}
              onChange={(value) => changeParameter(field.key, value)}
              value={parameters?.values[field.key]}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

export function VideoSubmissionConfirmations({
  candidate,
  confirmations,
  finalPrompt,
  materialSummary,
  onChange
}: {
  readonly candidate: VideoPreflightCandidateDto;
  readonly confirmations: VideoSubmissionConfirmationDto;
  readonly finalPrompt: string;
  readonly materialSummary: string;
  readonly onChange: (confirmations: VideoSubmissionConfirmationDto) => void;
}) {
  return (
    <fieldset className="uc-image-quick__confirmations">
      <legend>逐项确认本次视频提交</legend>
      <Confirmation
        checked={confirmations.recipient}
        label={`接收方：${candidate.recipientName}`}
        onChange={(checked) =>
          onChange({ ...confirmations, recipient: checked })
        }
      />
      <Confirmation
        checked={confirmations.outboundScope}
        label={`外发范围：${candidate.outboundScope}`}
        onChange={(checked) =>
          onChange({ ...confirmations, outboundScope: checked })
        }
      />
      <Confirmation
        checked={confirmations.materials}
        label={`素材范围：${materialSummary}`}
        onChange={(checked) =>
          onChange({ ...confirmations, materials: checked })
        }
      />
      <Confirmation
        checked={confirmations.costPrivacyRegion}
        label="费用、隐私与地区状态：未知，以服务商事实为准"
        onChange={(checked) =>
          onChange({ ...confirmations, costPrivacyRegion: checked })
        }
      />
      <Confirmation
        checked={confirmations.finalPrompt}
        label={`最终提示词：${finalPrompt}`}
        onChange={(checked) =>
          onChange({ ...confirmations, finalPrompt: checked })
        }
      />
      <Confirmation
        checked={confirmations.model}
        label={`模型：${candidate.modelName}`}
        onChange={(checked) => onChange({ ...confirmations, model: checked })}
      />
    </fieldset>
  );
}

interface VideoModelOption {
  readonly modelId: string;
  readonly modelName: string;
  readonly evidence?: ProviderCapabilitySummaryDto;
  readonly reason?: string;
}

function getVideoModelOptions(
  registry: ProviderRegistryDto | undefined,
  mode: VideoWorkspaceDtoMode
): readonly VideoModelOption[] {
  if (!registry) return [];
  const routeModelIds = new Set(
    registry.routingPreferences
      .filter(
        (route) => route.enabled && route.purpose === 'video_generation'
      )
      .map((route) => route.modelId)
  );

  return registry.models
    .filter(
      (model) =>
        routeModelIds.has(model.modelId) ||
        registry.capabilities.some(
          (capability) =>
            capability.modelId === model.modelId &&
            capability.capability === 'video_generation'
        )
    )
    .map<VideoModelOption>((model) => {
      const evidenceItems = registry.capabilities.filter(
        (capability) =>
          capability.modelId === model.modelId &&
          capability.capability === 'video_generation'
      );
      const evidence =
        evidenceItems.find((capability) =>
          ['verified_supported', 'user_confirmed'].includes(capability.state)
        ) ?? evidenceItems[0];
      const connection = registry.connections.find(
        (item) => item.connectionId === model.connectionId
      );
      const modeSchema = evidence?.videoGenerationSchema?.modes.find(
        (item) => item.mode === mode
      );
      const reason = !model.enabled
        ? '模型已停用'
        : !routeModelIds.has(model.modelId)
          ? '未启用视频生成路由'
          : connection?.state !== 'available'
            ? '连接不可用'
            : !evidence
              ? '能力未知'
              : !['verified_supported', 'user_confirmed'].includes(
                    evidence.state
                  )
                ? '能力未验证'
                : !evidence.parameterSchema
                  ? '缺少参数 Schema'
                  : !modeSchema
                    ? '不支持当前模式'
                    : undefined;
      return {
        modelId: model.modelId,
        modelName: model.displayName,
        evidence,
        reason
      };
    });
}

type ParameterField = NonNullable<
  ProviderCapabilitySummaryDto['parameterSchema']
>['fields'][number];

function DynamicParameterField({
  field,
  value,
  onChange
}: {
  readonly field: ParameterField;
  readonly value?: VideoWorkspaceParameterValueDto;
  readonly onChange: (
    value: VideoWorkspaceParameterValueDto | undefined
  ) => void;
}) {
  if (field.kind === 'boolean') {
    return (
      <label className="uc-image-quick__checkbox">
        <input
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>
          {field.label}
          {field.required ? '（必填）' : ''}
        </span>
      </label>
    );
  }

  if (field.kind === 'enum') {
    return (
      <label className="uc-image-quick__field">
        <span>
          {field.label}
          {field.required ? '（必填）' : ''}
        </span>
        <select
          onChange={(event) =>
            onChange(
              event.target.value
                ? (JSON.parse(
                    event.target.value
                  ) as VideoWorkspaceParameterValueDto)
                : undefined
            )
          }
          value={value === undefined ? '' : JSON.stringify(value)}
        >
          <option value="">请选择</option>
          {field.options?.map((option) => (
            <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const numeric = field.kind === 'number' || field.kind === 'integer';
  return (
    <label className="uc-image-quick__field">
      <span>
        {field.label}
        {field.required ? '（必填）' : ''}
      </span>
      <input
        max={field.maximum}
        min={field.minimum}
        onChange={(event) =>
          onChange(
            event.target.value === ''
              ? undefined
              : numeric
                ? Number(event.target.value)
                : event.target.value
          )
        }
        step={field.kind === 'integer' ? 1 : undefined}
        type={numeric ? 'number' : 'text'}
        value={
          typeof value === 'string' || typeof value === 'number' ? value : ''
        }
      />
    </label>
  );
}

function Confirmation({
  checked,
  label,
  onChange
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="uc-image-quick__checkbox">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}
