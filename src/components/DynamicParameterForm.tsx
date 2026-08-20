import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { LuInfo } from 'react-icons/lu';
import { Input, InputNumber, SelectPicker, Toggle } from 'rsuite';

export type DynamicParameterValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | Readonly<Record<string, unknown>>;

export interface DynamicParameterField {
  readonly fieldId: string;
  readonly labelId: string;
  readonly valueType: string;
  readonly required: boolean;
  readonly options?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
}

const parameterLabels: Readonly<Record<string, string>> = {
  aspectRatio: '画面比例',
  aspect_ratio: '画面比例',
  audio: '音频',
  background: '背景',
  detail: '识别精度',
  duration: '视频时长',
  fps: '帧率',
  frames: '帧数',
  height: '高度',
  imageSize: '图像尺寸',
  include_usage: '包含用量信息',
  input_fidelity: '输入保真度',
  max_tokens: '最大生成长度',
  max_completion_tokens: '最大完成长度',
  mode: '生成模式',
  negative_prompt: '反向提示词',
  n: '生成数量',
  output_compression: '输出压缩率',
  output_format: '输出格式',
  prompt: '提示词',
  quality: '画面质量',
  ratio: '画面比例',
  reasoning_effort: '推理强度',
  resolution: '分辨率',
  response_format: '返回格式',
  seconds: '时长（秒）',
  seed: '随机种子',
  size: '输出尺寸',
  stop: '停止词',
  stream: '流式返回',
  style: '画面风格',
  temperature: '随机性',
  thinking: '深度思考',
  top_p: '核采样范围',
  watermark: '添加水印',
  width: '宽度'
};

/** Short usage notes exposed from each parameter's info control. */
const parameterDescriptions: Readonly<Record<string, string>> = {
  aspect_ratio: '控制画面宽高比例；未选时由服务商默认。',
  aspectRatio: '控制画面宽高比例；未选时由服务商默认。',
  audio: '是否在结果中附带音频；取决于当前模型是否支持。',
  background: '背景处理方式（如透明/不透明）；仅部分模型有效。',
  detail: '影响识别精细程度；通常越高越慢、费用可能更高。',
  duration: '生成视频的目标时长（秒）；未填时使用服务商默认值。',
  seconds: 'OpenAI 兼容格式的时长（秒）；未填时使用服务商默认值。',
  fps: '视频帧率；未填时使用服务商默认值。',
  mode: '生成模式；按当前模型支持的选项填写，未填时使用服务商默认值。',
  resolution: '输出分辨率档位（如 720p / 1080p）；未填时使用服务商默认值。',
  frames: '目标帧数；与时长、帧率相关，按模型能力填写。',
  height: '输出高度（像素）；常与宽度一起约束画面比例。',
  imageSize: '输出图像尺寸档位；按模型支持的选项选择。',
  include_usage: '是否在响应中附带用量信息，便于核对计费。',
  input_fidelity: '参考图保真度；越高越贴近原图，主要用于编辑类模型。',
  max_tokens: '限制模型最多可生成的文本长度；建议 256–8192，上限 128000；未填时使用服务商默认值。',
  max_completion_tokens: '推理模型的最大输出长度；建议 256–8192，上限 128000；未填时使用服务商默认值。',
  negative_prompt: '希望画面避免出现的内容描述。',
  n: '一次请求生成几张图；不填时远端通常默认为 1。请按服务商限额选择。',
  output_compression: '输出压缩程度；数值含义以当前模型文档为准。',
  output_format: '结果图片容器格式（如 png / jpeg / webp）。',
  prompt: '描述期望画面的文本；越具体通常越稳定。',
  quality: '画质档位；更高档位可能更清晰，也可能更慢或更贵。',
  ratio: '控制画面宽高比例；未选时由服务商默认。',
  reasoning_effort: '推理强度（如 low / medium / high）；更高通常更慢。',
  response_format: '结果返回方式：链接（url）便于预览下载；Base64（b64_json）适合内嵌落盘。',
  seed: '随机种子；相同种子便于复现近似结果，留空则由服务商随机。',
  size: '输出宽×高，格式如 1280x720（用英文字母 x）。未填时使用服务商默认值。',
  stop: '遇到该停止词时结束生成；未填则不额外限制。',
  stream: '是否流式返回中间结果；图片生成通常关闭。',
  style: '画面风格倾向（如鲜艳 / 自然）；仅部分模型支持。',
  temperature: '文本随机性；越高越发散，越低越稳定。',
  thinking: '是否启用更深推理；开启后可能更慢。',
  top_p: '核采样范围；与随机性一起影响多样性。',
  watermark: '是否在结果图上添加水印；开启后可能无法获得无水印成品。',
  width: '输出宽度（像素）；常与高度一起约束画面比例。'
};

const parameterOptionLabels: Readonly<Record<string, string>> = {
  auto: '自动',
  b64_json: 'Base64 数据',
  disabled: '关闭',
  enabled: '开启',
  false: '关闭',
  high: '高',
  low: '低',
  max: '最高',
  medium: '中',
  natural: '自然',
  none: '无',
  opaque: '不透明',
  standard: '标准',
  transparent: '透明',
  true: '开启',
  url: '链接',
  vivid: '鲜艳',
  xhigh: '超高'
};

const preservedFormatOptions = new Set([
  'bmp', 'gif', 'jpeg', 'jpg', 'mov', 'mp4', 'png', 'wav', 'webm', 'webp'
]);

/** Convert an internal parameter key to a user-facing Chinese label. */
export function displayParameterKey(value: string): string {
  const key = value
    .replace(/^provider\.parameter\./, '')
    .replace(/^provider\./, '');
  if (parameterLabels[key]) return parameterLabels[key];
  return /[\u3400-\u9fff]/.test(key) ? key : '其他参数';
}

/** Usage note for a parameter field; empty when unknown. */
export function displayParameterDescription(value: string): string | undefined {
  const key = value
    .replace(/^provider\.parameter\./, '')
    .replace(/^provider\./, '');
  return parameterDescriptions[key];
}

/** Keep submitted option values unchanged while localizing their visible labels. */
export function displayParameterOption(
  value: string | number | boolean,
  index = 0
): string {
  const text = String(value);
  const normalized = text.toLowerCase();
  if (parameterOptionLabels[normalized]) return parameterOptionLabels[normalized];
  if (
    !/[A-Za-z]/.test(text) ||
    preservedFormatOptions.has(normalized) ||
    /^\d+[pk]$/i.test(text) ||
    /^\d+x\d+$/i.test(text) ||
    /^\d+:\d+$/u.test(text)
  ) {
    return text;
  }
  return `其他选项 ${index + 1}`;
}

export interface DynamicParameterFormProps {
  readonly fields: readonly DynamicParameterField[];
  readonly values: Readonly<Record<string, DynamicParameterValue | undefined>>;
  readonly disabled?: boolean;
  readonly emptyHint?: string;
  readonly onChange: (fieldId: string, value: DynamicParameterValue | undefined) => void;
}

export function DynamicParameterForm({
  fields,
  values,
  disabled = false,
  emptyHint = '本次不需要用户参数，采用服务商默认值。',
  onChange
}: DynamicParameterFormProps) {
  if (fields.length === 0) {
    return <p className="uc-model-select__hint" role="status">{emptyHint}</p>;
  }
  return (
    <div className="uc-dynamic-parameters" aria-label="模型参数">
      {fields.map((field) => (
        <ParameterField
          disabled={disabled}
          field={field}
          key={field.fieldId}
          onChange={(value) => onChange(field.fieldId, value)}
          value={values[field.fieldId]}
        />
      ))}
    </div>
  );
}

export function toDynamicParameterFields(
  fields: readonly {
    readonly fieldId?: string;
    readonly key?: string;
    readonly labelId?: string;
    readonly label?: string;
    readonly valueType?: string;
    readonly kind?: string;
    readonly exposure?: string;
    readonly required: boolean;
    readonly options?: readonly (string | number | boolean)[];
    readonly minimum?: number;
    readonly maximum?: number;
    readonly step?: number;
  }[]
): readonly DynamicParameterField[] {
  return fields.map((field, index) => {
    const fieldId = field.fieldId ?? field.key ?? `field-${index}`;
    return {
      fieldId,
      labelId: field.labelId ?? field.label ?? fieldId,
      valueType: field.valueType ?? field.kind ?? 'string',
      required: field.required === true || field.exposure === 'user_required',
      ...(field.options ? { options: field.options } : {}),
      ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
      ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      ...(field.step === undefined ? {} : { step: field.step })
    };
  });
}

function parameterLabel(field: DynamicParameterField): {
  readonly text: string;
  readonly required: boolean;
} {
  return {
    text: displayParameterKey(field.fieldId || field.labelId),
    required: field.required
  };
}

function ParameterLabel({ field }: { readonly field: DynamicParameterField }) {
  const { text, required } = parameterLabel(field);
  const description = displayParameterDescription(field.fieldId || field.labelId);
  const descriptionId = useId();
  return (
    <span className="uc-dynamic-parameters__heading">
      <span className="uc-dynamic-parameters__label">
        <span className="uc-dynamic-parameters__key">{text}</span>
        {description ? (
          <span className="uc-dynamic-parameters__info-wrap">
            <button
              aria-describedby={descriptionId}
              aria-label={`${text}参数说明`}
              className="uc-dynamic-parameters__info"
              type="button"
            >
              <LuInfo aria-hidden="true" />
            </button>
            <span
              className="uc-dynamic-parameters__tooltip"
              id={descriptionId}
              role="tooltip"
            >
              {description}
            </span>
          </span>
        ) : null}
        {required ? (
          <span aria-label="必填" className="uc-dynamic-parameters__required">
            必填
          </span>
        ) : null}
      </span>
    </span>
  );
}

function parameterConstraint(field: DynamicParameterField): string | undefined {
  if (field.valueType === 'number' || field.valueType === 'integer') {
    const range = field.minimum !== undefined && field.maximum !== undefined
      ? `${field.minimum} - ${field.maximum}`
      : field.minimum !== undefined
        ? `不小于 ${field.minimum}`
        : field.maximum !== undefined
          ? `不大于 ${field.maximum}`
          : undefined;
    const step = field.valueType === 'integer'
      ? '仅限整数'
      : field.step !== undefined
        ? `步长 ${field.step}`
        : undefined;
    return [range, step].filter(Boolean).join(' · ') || undefined;
  }
  if (field.valueType === 'string_array' || field.valueType === 'number_array') {
    return field.valueType === 'number_array'
      ? '输入多个数值时使用逗号分隔'
      : '输入多项内容时使用逗号分隔';
  }
  if (field.valueType === 'object') return '使用 JSON 对象格式';
  return undefined;
}

function ParameterMeta({ field }: { readonly field: DynamicParameterField }) {
  const constraint = parameterConstraint(field);
  if (!constraint) return null;
  return <span className="uc-dynamic-parameters__constraint">{constraint}</span>;
}

function ParameterShell({
  children,
  field,
  filled,
  invalid = false
}: {
  readonly children: ReactNode;
  readonly field: DynamicParameterField;
  readonly filled: boolean;
  readonly invalid?: boolean;
}) {
  return (
    <div
      className="uc-dynamic-parameters__field"
      data-filled={filled || undefined}
      data-invalid={invalid || undefined}
      data-value-type={field.valueType}
    >
      <div className="uc-dynamic-parameters__field-header">
        <ParameterLabel field={field} />
        <span className="uc-dynamic-parameters__value-state">
          {filled ? '已设置' : '使用默认值'}
        </span>
      </div>
      <div className="uc-dynamic-parameters__control">{children}</div>
      <ParameterMeta field={field} />
    </div>
  );
}

function ParameterField({
  field,
  value,
  disabled,
  onChange
}: {
  readonly field: DynamicParameterField;
  readonly value: DynamicParameterValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DynamicParameterValue | undefined) => void;
}) {
  if (field.valueType === 'boolean') {
    return (
      <div className="uc-dynamic-parameters__field uc-dynamic-parameters__field--boolean" data-filled>
        <ParameterLabel field={field} />
        <Toggle
          checked={value === true}
          checkedChildren="开启"
          disabled={disabled}
          label={displayParameterKey(field.fieldId || field.labelId)}
          onChange={onChange}
          unCheckedChildren="关闭"
        />
      </div>
    );
  }
  if (field.valueType === 'enum') {
    const data = (field.options ?? []).map((option, index) => ({
      value: String(option),
      label: displayParameterOption(option, index)
    }));
    return (
      <ParameterShell field={field} filled={value !== undefined}>
        <SelectPicker
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          block
          cleanable={!field.required}
          data={data}
          disabled={disabled}
          onChange={(next) => {
            const option = field.options?.find((item) => String(item) === next);
            onChange(option);
          }}
          placeholder={field.required ? '请选择（必填）' : '请选择'}
          searchable={false}
          value={value === undefined ? null : String(value)}
        />
      </ParameterShell>
    );
  }
  if (field.valueType === 'number' || field.valueType === 'integer') {
    return (
      <ParameterShell field={field} filled={typeof value === 'number'}>
        <InputNumber
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          disabled={disabled}
          max={field.maximum}
          min={field.minimum}
          onChange={(next) => onChange(
            next === null || next === '' ? undefined : Number(next)
          )}
          required={field.required}
          step={field.valueType === 'integer' ? 1 : field.step}
          value={typeof value === 'number' ? value : ''}
        />
      </ParameterShell>
    );
  }
  if (field.valueType === 'string_array' || field.valueType === 'number_array') {
    return (
      <ParameterShell field={field} filled={Array.isArray(value) && value.length > 0}>
        <Input
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          disabled={disabled}
          onChange={(next) => {
            const items = next.split(',').map((item) => item.trim()).filter(Boolean);
            onChange(items.length === 0
              ? undefined
              : field.valueType === 'number_array'
                ? items.map(Number)
                : items);
          }}
          placeholder={field.required ? '请输入（必填）' : '留空使用服务默认值'}
          required={field.required}
          value={Array.isArray(value) ? value.join(', ') : ''}
        />
      </ParameterShell>
    );
  }
  if (field.valueType === 'object') {
    return <ObjectParameterField disabled={disabled} field={field} onChange={onChange} value={value} />;
  }
  if (field.valueType === 'media_slot') {
    return (
      <ParameterShell field={field} filled>
        <Input
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          disabled
          readOnly
          value="由当前草稿的受控素材提供"
        />
      </ParameterShell>
    );
  }
  return (
    <ParameterShell field={field} filled={typeof value === 'string' && value.length > 0}>
      <Input
        aria-label={displayParameterKey(field.fieldId || field.labelId)}
        disabled={disabled}
        onChange={(next) => onChange(next || undefined)}
        placeholder={field.required ? '请输入（必填）' : '留空使用服务默认值'}
        required={field.required}
        value={typeof value === 'string' ? value : ''}
      />
    </ParameterShell>
  );
}

function ObjectParameterField({
  field,
  value,
  disabled,
  onChange
}: {
  readonly field: DynamicParameterField;
  readonly value: DynamicParameterValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DynamicParameterValue | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value));
    setInvalid(false);
  }, [value]);
  return (
    <ParameterShell field={field} filled={text.trim().length > 0} invalid={invalid}>
      <Input
        aria-label={displayParameterKey(field.fieldId || field.labelId)}
        aria-invalid={invalid}
        as="textarea"
        disabled={disabled}
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
            onChange(parsed as Readonly<Record<string, unknown>>);
          } catch {
            setInvalid(true);
          }
        }}
        onChange={(next) => setText(next)}
        placeholder={field.required ? '{ "key": "value" }（必填）' : '{ "key": "value" }'}
        rows={3}
        value={text}
      />
      {invalid ? <small role="alert">请输入有效的 JSON 对象。</small> : null}
    </ParameterShell>
  );
}
