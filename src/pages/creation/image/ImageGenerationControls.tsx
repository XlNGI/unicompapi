import { Checkbox, Input, InputNumber, SelectPicker } from 'rsuite';
import type {
  ImagePreflightCandidateDto,
  ImageSubmissionConfirmationDto,
  ImageSubmissionErrorCode
} from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceModelDto,
  ImageWorkspaceParameterValueDto,
  ImageWorkspaceParametersDto
} from '../../../shared/image-workspace-ipc';
import type {
  ProviderCapabilitySummaryDto,
  ProviderRegistryDto
} from '../../../shared/provider-ipc';

export type GenerationImageDraftDto = Extract<
  ImageWorkspaceDraftDto,
  { readonly generation: object }
>;

export type EditingImageDraftDto = Extract<
  ImageWorkspaceDraftDto,
  { readonly mode: 'image_editing' }
>;

export const imageSubmissionErrorMessages: Record<
  ImageSubmissionErrorCode,
  string
> = {
  submission_outcome_unknown:
    'Submission outcome is unknown. Create a new task only after confirming the charge status.',
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
  return (
    <ImageModelFields
      label="图片生成模型"
      model={draft.generation.model}
      onChange={(generation) => onDraftChange({ ...draft, generation })}
      parameters={draft.generation.parameters}
      purpose={draft.input ? 'reference_to_image' : 'image_generation'}
      registry={registry}
    />
  );
}

export function ImageEditingModelFields({
  draft,
  registry,
  onDraftChange
}: {
  readonly draft: EditingImageDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: EditingImageDraftDto) => void;
}) {
  return (
    <ImageModelFields
      label="图片编辑模型"
      model={draft.editing.model}
      onChange={(selection) =>
        onDraftChange({
          ...draft,
          editing: { ...draft.editing, ...selection }
        })
      }
      parameters={draft.editing.parameters}
      purpose="image_editing"
      registry={registry}
    />
  );
}

function ImageModelFields({
  label,
  model,
  parameters,
  purpose,
  registry,
  onChange
}: {
  readonly label: string;
  readonly model?: ImageWorkspaceModelDto;
  readonly parameters?: ImageWorkspaceParametersDto;
  readonly purpose:
    | 'image_generation'
    | 'reference_to_image'
    | 'image_editing';
  readonly registry?: ProviderRegistryDto;
  readonly onChange: (selection: {
    readonly model?: ImageWorkspaceModelDto;
    readonly parameters?: ImageWorkspaceParametersDto;
  }) => void;
}) {
  const modelOptions = getModelOptions(registry, purpose);
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
              values: defaultParameterValues(option.evidence.parameterSchema)
            }
          }
        : {}
    );
  }

  function changeParameter(
    key: string,
    value: ImageWorkspaceParameterValueDto | undefined
  ) {
    if (!selectedOption?.evidence || selectedOption.reason) return;
    const values = {
      ...(parameters?.values ?? {})
    } as Record<string, ImageWorkspaceParameterValueDto>;
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
      <div className="uc-image-quick__field">
        <span>{label || '选择模型'}</span>
        <SelectPicker
          aria-label="选择模型"
          block
          data={modelOptions.map((option) => ({
            value: option.modelId,
            label: `${option.label}${option.reason ? `（${option.reason}）` : ''}`,
            disabled: Boolean(option.reason)
          }))}
          disabled={modelOptions.length === 0}
          onChange={(value) => changeModel(value ?? '')}
          placeholder="请选择模型"
          searchable={false}
          value={model?.modelId ?? ''}
        />
      </div>
      {modelOptions.length === 0 ? (
        <p className="uc-image-quick__hint">
          没有符合当前用途的模型或路由；请先在“模型与服务商”页面完成配置。
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

export function ImageSubmissionConfirmations({
  candidate,
  confirmations,
  finalPrompt,
  promptLabel = '最终提示词',
  onChange
}: {
  readonly candidate: ImagePreflightCandidateDto;
  readonly confirmations: ImageSubmissionConfirmationDto;
  readonly finalPrompt: string;
  readonly promptLabel?: string;
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
        label={`${promptLabel}：${finalPrompt}`}
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
  readonly label: string;
  readonly evidence?: ProviderCapabilitySummaryDto;
  readonly reason?: string;
}

function getModelOptions(
  registry: ProviderRegistryDto | undefined,
  purpose: 'image_generation' | 'reference_to_image' | 'image_editing'
): readonly GenerationModelOption[] {
  if (!registry) return [];
  const routeModelIds = new Set(
    registry.routingPreferences
      .filter((route) => route.enabled && route.purpose === purpose)
      .map((route) => route.modelId)
  );

  return registry.models
    .filter(
      (model) =>
        routeModelIds.has(model.modelId) ||
        registry.capabilities.some(
          (capability) =>
            capability.modelId === model.modelId &&
            capability.capability === purpose
        )
    )
    .map<GenerationModelOption>((model) => {
      const evidenceItems = registry.capabilities.filter(
        (capability) =>
          capability.modelId === model.modelId &&
          capability.capability === purpose
      );
      const accepted = evidenceItems
        .filter((capability) =>
          ['verified_supported', 'user_confirmed'].includes(capability.state)
        )
        .sort((left, right) => right.revision - left.revision);
      const evidence = accepted.find(
        (capability) => capability.evidenceId === model.capabilityEvidenceId
      ) ?? accepted[0] ?? evidenceItems[0];
      const connection = registry.connections.find(
        (item) => item.connectionId === model.connectionId
      );
      const provider = registry.providers.find(
        (item) => item.providerId === model.providerId
      );
      const reason = !model.enabled
        ? '模型已停用'
        : !routeModelIds.has(model.modelId)
          ? '未启用当前用途路由'
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
        label: `${provider?.name ?? '服务商'} · ${connection?.name ?? '连接'} · ${model.displayName}`,
        evidence,
        reason
      };
    });
}

function defaultParameterValues(
  schema: ProviderCapabilitySummaryDto['parameterSchema']
): Record<string, ImageWorkspaceParameterValueDto> {
  const values: Record<string, ImageWorkspaceParameterValueDto> = {};
  for (const field of schema?.fields ?? []) {
    if (!field.required) continue;
    if (field.kind === 'boolean') values[field.key] = false;
    else if (field.kind === 'enum' && field.options?.[0] !== undefined) {
      values[field.key] = field.options[0];
    } else if (
      (field.kind === 'number' || field.kind === 'integer') &&
      field.minimum !== undefined
    ) {
      values[field.key] = field.minimum;
    }
  }
  return values;
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
      <Checkbox
        checked={value === true}
        className="uc-image-quick__checkbox"
        onChange={(_value, checked) => onChange(checked)}
      >
        <span>
          {field.label}
          {field.required ? '（必填）' : ''}
        </span>
      </Checkbox>
    );
  }

  if (field.kind === 'enum') {
    return (
      <div className="uc-image-quick__field">
        <span>
          {field.label}
          {field.required ? '（必填）' : ''}
        </span>
        <SelectPicker
          aria-label={field.label}
          block
          cleanable={!field.required}
          data={(field.options ?? []).map((option) => ({
            value: JSON.stringify(option),
            label: String(option)
          }))}
          onChange={(next) =>
            onChange(
              next
                ? (JSON.parse(next) as ImageWorkspaceParameterValueDto)
                : undefined
            )
          }
          placeholder="请选择"
          searchable={false}
          value={value === undefined ? null : JSON.stringify(value)}
        />
      </div>
    );
  }

  const numeric = field.kind === 'number' || field.kind === 'integer';
  if (numeric) {
    return (
      <label className="uc-image-quick__field">
        <span>
          {field.label}
          {field.required ? '（必填）' : ''}
        </span>
        <InputNumber
          max={field.maximum}
          min={field.minimum}
          onChange={(next) =>
            onChange(next === null || next === '' ? undefined : Number(next))
          }
          step={field.kind === 'integer' ? 1 : undefined}
          value={typeof value === 'number' ? value : ''}
        />
      </label>
    );
  }
  return (
    <label className="uc-image-quick__field">
      <span>
        {field.label}
        {field.required ? '（必填）' : ''}
      </span>
      <Input
        onChange={(next) => onChange(next === '' ? undefined : next)}
        value={typeof value === 'string' ? value : ''}
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
    <Checkbox
      checked={checked}
      className="uc-image-quick__checkbox"
      onChange={(_value, nextChecked) => onChange(nextChecked)}
    >
      <span>{label}</span>
    </Checkbox>
  );
}
