import type {
  ImagePreflightCandidateDto,
  ImageSubmissionConfirmationDto,
  ImageSubmissionErrorCode
} from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceParameterValueDto
} from '../../../shared/image-workspace-ipc';
import type {
  ProviderCapabilitySummaryDto,
  ProviderRegistryDto
} from '../../../shared/provider-ipc';

export type GenerationImageDraftDto = Extract<
  ImageWorkspaceDraftDto,
  { readonly generation: object }
>;

export const imageSubmissionErrorMessages: Record<
  ImageSubmissionErrorCode,
  string
> = {
  project_not_open: '当前没有打开的项目。',
  invalid_request: '提交信息无效，请检查当前草稿。',
  draft_not_found: '当前草稿已不存在。',
  draft_not_submittable: '请填写创作需求并保存草稿后再检查。',
  input_required: '当前操作需要一张图片输入。',
  no_route_candidate: '没有符合当前用途的已启用模型路由。',
  capability_unverified: '图片生成能力尚未验证。',
  parameter_schema_missing: '模型没有可用的动态参数 Schema。',
  parameters_invalid: '动态参数缺失或超出模型声明范围。',
  confirmation_required: '请逐项确认接收方、外发范围、费用、提示词和模型。',
  task_not_found: '图片任务已不存在。',
  execution_not_found: '执行记录已不存在。',
  invalid_execution_state: '当前执行状态不允许此操作。',
  adapter_unavailable: '没有配置真实图片生成适配器，当前不会外发或生成。',
  download_failed: '结果下载失败，未保存为项目作品。',
  result_verification_failed: '结果校验失败，未保存为项目作品。',
  submission_storage_error: '任务或结果写入本地项目失败。'
};

export const emptyImageConfirmations: ImageSubmissionConfirmationDto = {
  recipient: false,
  outboundScope: false,
  cost: false,
  finalPrompt: false,
  model: false
};

export function ImageGenerationModelFields({
  draft,
  registry,
  onDraftChange
}: {
  readonly draft: GenerationImageDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
}) {
  const modelOptions = getGenerationModelOptions(registry);
  const selectedOption = modelOptions.find(
    (option) => option.modelId === draft.generation.model?.modelId
  );

  function changeModel(modelId: string) {
    const option = modelOptions.find(
      (candidate) =>
        candidate.modelId === modelId &&
        !candidate.reason &&
        candidate.evidence
    );
    onDraftChange({
      ...draft,
      generation: option?.evidence
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
    });
  }

  function changeParameter(
    key: string,
    value: ImageWorkspaceParameterValueDto | undefined
  ) {
    if (!selectedOption?.evidence || selectedOption.reason) return;
    const values = {
      ...(draft.generation.parameters?.values ?? {})
    } as Record<string, ImageWorkspaceParameterValueDto>;
    if (value === undefined) delete values[key];
    else values[key] = value;
    onDraftChange({
      ...draft,
      generation: {
        model: {
          modelId: selectedOption.modelId,
          capabilityEvidenceId: selectedOption.evidence.evidenceId
        },
        parameters: {
          capabilityEvidenceId: selectedOption.evidence.evidenceId,
          values
        }
      }
    });
  }

  return (
    <>
      <label className="uc-image-quick__field">
        <span>图片生成模型</span>
        <select
          disabled={modelOptions.length === 0}
          onChange={(event) => changeModel(event.target.value)}
          value={draft.generation.model?.modelId ?? ''}
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
          没有图片生成模型或路由；请先在“模型与服务商”页面完成配置。
        </p>
      ) : null}
      {selectedOption?.evidence && !selectedOption.reason ? (
        <div className="uc-image-quick__parameters">
          {selectedOption.evidence.parameterSchema?.fields.map((field) => (
            <DynamicParameterField
              field={field}
              key={field.key}
              onChange={(value) => changeParameter(field.key, value)}
              value={draft.generation.parameters?.values[field.key]}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

export function ImageSubmissionConfirmations({
  candidate,
  confirmations,
  finalPrompt,
  onChange
}: {
  readonly candidate: ImagePreflightCandidateDto;
  readonly confirmations: ImageSubmissionConfirmationDto;
  readonly finalPrompt: string;
  readonly onChange: (confirmations: ImageSubmissionConfirmationDto) => void;
}) {
  return (
    <fieldset className="uc-image-quick__confirmations">
      <legend>逐项确认本次提交</legend>
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
        checked={confirmations.cost}
        label="费用状态：未知，以服务商账单为准"
        onChange={(checked) => onChange({ ...confirmations, cost: checked })}
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

interface GenerationModelOption {
  readonly modelId: string;
  readonly modelName: string;
  readonly evidence?: ProviderCapabilitySummaryDto;
  readonly reason?: string;
}

function getGenerationModelOptions(
  registry?: ProviderRegistryDto
): readonly GenerationModelOption[] {
  if (!registry) return [];
  const routeModelIds = new Set(
    registry.routingPreferences
      .filter(
        (route) => route.enabled && route.purpose === 'image_generation'
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
            capability.capability === 'image_generation'
        )
    )
    .map<GenerationModelOption>((model) => {
      const evidenceItems = registry.capabilities.filter(
        (capability) =>
          capability.modelId === model.modelId &&
          capability.capability === 'image_generation'
      );
      const evidence =
        evidenceItems.find((capability) =>
          ['verified_supported', 'user_confirmed'].includes(capability.state)
        ) ?? evidenceItems[0];
      const connection = registry.connections.find(
        (item) => item.connectionId === model.connectionId
      );
      const reason = !model.enabled
        ? '模型已停用'
        : !routeModelIds.has(model.modelId)
          ? '未启用图片生成路由'
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
  readonly value?: ImageWorkspaceParameterValueDto;
  readonly onChange: (
    value: ImageWorkspaceParameterValueDto | undefined
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
                  ) as ImageWorkspaceParameterValueDto)
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
