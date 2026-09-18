import { SelectPicker } from './Pickers';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { ReactNode } from 'react';
import { LuInfo } from 'react-icons/lu';
import { Input, InputNumber, Toggle, Tooltip, Whisper } from 'rsuite';
import type {
  DynamicParameterField,
  DynamicParameterValue
} from './dynamic-parameter-validation';
import {
  applyParameterFieldInput,
  createParameterFieldBuffer,
  flushParameterFieldBuffers,
  hasPendingParameterBuffer,
  isBufferedParameterValueType,
  serializeParameterFieldValue,
  type DynamicParameterBufferFlush,
  type DynamicParameterFieldBuffer
} from './dynamic-parameter-buffer';
import {
  createParameterInputProbe,
  emitParameterInputSummary,
  setActiveParameterInputProbe,
  type ParameterInputControlKind,
  type ParameterInputSurface
} from '../ui/parameter-input-performance-probe';

export type {
  DynamicParameterField,
  DynamicParameterValue
} from './dynamic-parameter-validation';
export { validateDynamicParameterValues } from './dynamic-parameter-validation';
export type { DynamicParameterBufferFlush } from './dynamic-parameter-buffer';

/**
 * Idle delay after the last keystroke before the stable value is handed to the
 * parent. It replaces "every keystroke replaces the whole draft": the user
 * stops typing, the value is committed, and only then does the draft become
 * dirty, queue an autosave and allow a candidate refresh.
 */
const PARAMETER_COMMIT_IDLE_MS = 600;

const parameterLabels: Readonly<Record<string, string>> = {
  aspectRatio: '画面比例',
  aspect_ratio: '画面比例',
  audio: '音频',
  background: '背景',
  camera_fixed: '固定运镜',
  detail: '识别精度',
  duration: '视频时长',
  duration_seconds: '视频时长（秒）',
  generation_mode: '生成模式',
  fps: '帧率',
  frames: '帧数',
  generate_audio: '生成音频',
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
  prompt_extend: '提示词扩展',
  quality: '画面质量',
  ratio: '画面比例',
  reasoning_effort: '推理强度',
  resolution: '分辨率',
  response_format: '返回格式',
  return_last_frame: '返回尾帧',
  seconds: '视频时长（秒）',
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
  camera_fixed: '是否固定镜头运动；仅当前模型合同支持时才会发送。',
  detail: '影响识别精细程度；通常越高越慢、费用可能更高。',
  duration: '生成视频的目标时长（秒）；未填时使用服务商默认值。',
  seconds: 'OpenAI 兼容格式的时长（秒）；未填时使用服务商默认值。',
  fps: '视频帧率；未填时使用服务商默认值。',
  mode: '生成模式；按当前模型支持的选项填写，未填时使用服务商默认值。',
  resolution: '输出分辨率档位（如 720p / 1080p）；未填时使用服务商默认值。',
  frames: '目标帧数；与时长、帧率相关，按模型能力填写。',
  generate_audio: '是否让模型生成音频；仅当前模型合同支持时才会发送。',
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
  return_last_frame: '是否返回生成视频的最后一帧；仅当前模型合同支持时才会发送。',
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
  return key;
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
  _index = 0
): string {
  const text = String(value);
  const normalized = text.toLowerCase();
  if (text === '-1') return '自动（按服务默认）';
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
  return text;
}

export interface DynamicParameterFormProps {
  readonly fields: readonly DynamicParameterField[];
  readonly values: Readonly<Record<string, DynamicParameterValue | undefined>>;
  readonly disabled?: boolean;
  readonly emptyHint?: string;
  readonly errors?: Readonly<Record<string, string | undefined>>;
  readonly onInputErrorChange?: (fieldId: string, error?: string) => void;
  readonly onChange: (fieldId: string, value: DynamicParameterValue | undefined) => void;
  /** Diagnostic surface; only used by the development-time probe. */
  readonly surface?: ParameterInputSurface;
}

/**
 * Imperative handle. The parent calls `flush()` before it saves or submits, so
 * the value the user just typed is committed even when the control still has
 * focus. It is deliberately synchronous: the submit path needs the stable
 * values in the same tick, not after another render.
 */
export interface DynamicParameterFormHandle {
  flush(): DynamicParameterBufferFlush;
}

function controlKindForValueType(valueType: string): ParameterInputControlKind {
  switch (valueType) {
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'string_array':
    case 'number_array':
      return 'array';
    case 'object':
      return 'json';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enum';
    case 'media_slot':
      return 'media_slot';
    default:
      return 'text';
  }
}

export const DynamicParameterForm = forwardRef<
  DynamicParameterFormHandle,
  DynamicParameterFormProps
>(function DynamicParameterForm({
  fields,
  values,
  disabled = false,
  emptyHint = '本次不需要用户参数，采用服务商默认值。',
  errors = {},
  surface = 'video_generation',
  onInputErrorChange,
  onChange
}, ref) {
  const [buffers, setBuffers] = useState<
    Readonly<Record<string, DynamicParameterFieldBuffer | undefined>>
  >({});
  // Every ref below exists so the callbacks and the imperative handle never read
  // a stale render closure: a commit triggered by blur, idle or submit must use
  // the newest text and the newest parent value.
  const buffersRef = useRef(buffers);
  const valuesRef = useRef(values);
  const fieldsRef = useRef(fields);
  const onChangeRef = useRef(onChange);
  const onInputErrorChangeRef = useRef(onInputErrorChange);
  const reportedErrorsRef = useRef<Record<string, string | undefined>>({});
  const idleTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSettleRef = useRef(false);
  buffersRef.current = buffers;
  valuesRef.current = values;
  fieldsRef.current = fields;
  onChangeRef.current = onChange;
  onInputErrorChangeRef.current = onInputErrorChange;

  const probe = useMemo(
    () => createParameterInputProbe({ surface, emit: emitParameterInputSummary }),
    [surface]
  );

  useEffect(() => {
    setActiveParameterInputProbe(probe);
    return () => setActiveParameterInputProbe(undefined);
  }, [probe]);

  // Keep each buffer aligned with the parent value unless the user is editing
  // it. A model switch that keeps the schema keeps the user's text; a switch
  // that changes the schema resyncs to the (cleared) draft value.
  useEffect(() => {
    setBuffers((current) => {
      let changed = false;
      const next: Record<string, DynamicParameterFieldBuffer | undefined> = {};
      for (const field of fields) {
        if (!isBufferedParameterValueType(field.valueType)) continue;
        const existing = current[field.fieldId];
        const parentValue = values[field.fieldId];
        if (!existing || !existing.edited) {
          const fresh = createParameterFieldBuffer(field, parentValue);
          if (!existing || existing.text !== fresh.text) changed = true;
          next[field.fieldId] = fresh;
          continue;
        }
        const edited = existing.text !== serializeParameterFieldValue(field, parentValue);
        if (edited !== existing.edited) changed = true;
        next[field.fieldId] = edited === existing.edited ? existing : { ...existing, edited };
      }
      if (!changed && Object.keys(current).length === Object.keys(next).length) {
        return current;
      }
      return next;
    });
  }, [fields, values]);

  // Local errors are the only thing a keystroke may report upward, and only
  // when the message actually changes.
  useEffect(() => {
    const reported = reportedErrorsRef.current;
    const changed: Array<{ fieldId: string; error?: string }> = [];
    for (const field of fields) {
      if (!isBufferedParameterValueType(field.valueType)) continue;
      const next = buffers[field.fieldId]?.error;
      const previous = reported[field.fieldId];
      if (previous === next) continue;
      if (next === undefined) delete reported[field.fieldId];
      else reported[field.fieldId] = next;
      changed.push({ fieldId: field.fieldId, ...(next === undefined ? {} : { error: next }) });
    }
    for (const item of changed) onInputErrorChangeRef.current?.(item.fieldId, item.error);
  }, [buffers, fields]);

  // The rendered text is the measurement point: this layout effect runs after
  // the DOM has the new text, so `settle()` records input → visible.
  useLayoutEffect(() => {
    if (!pendingSettleRef.current) return;
    pendingSettleRef.current = false;
    probe.settle();
  });

  const clearIdleTimer = useCallback((fieldId: string) => {
    const timer = idleTimersRef.current.get(fieldId);
    if (timer === undefined) return;
    clearTimeout(timer);
    idleTimersRef.current.delete(fieldId);
  }, []);

  /**
   * After a commit the buffer is re-serialized from the committed value, so
   * "1." becomes "1" and the field is no longer considered edited. Only
   * committed fields are touched: invalid text must stay exactly as typed.
   */
  const normalizeCommittedBuffers = useCallback((
    fieldIds: readonly string[],
    committed: Readonly<Record<string, DynamicParameterValue | undefined>>
  ) => {
    if (fieldIds.length === 0) return;
    setBuffers((current) => {
      let changed = false;
      const next: Record<string, DynamicParameterFieldBuffer | undefined> = { ...current };
      for (const fieldId of fieldIds) {
        const field = fieldsRef.current.find((item) => item.fieldId === fieldId);
        const existing = current[fieldId];
        if (!field || !existing) continue;
        const normalized = createParameterFieldBuffer(field, committed[fieldId]);
        if (existing.text === normalized.text && !existing.edited) continue;
        next[fieldId] = normalized;
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  const commitField = useCallback((fieldId: string) => {
    clearIdleTimer(fieldId);
    const field = fieldsRef.current.find((item) => item.fieldId === fieldId);
    const buffer = buffersRef.current[fieldId];
    if (!field || !buffer || !buffer.edited) return;
    // An invalid intermediate keeps its text and its message; it must not
    // overwrite a good value in the draft.
    if (buffer.blocked || buffer.error) return;
    probe.parentCommit();
    normalizeCommittedBuffers([fieldId], { [fieldId]: buffer.pending });
    onChangeRef.current(fieldId, buffer.pending);
  }, [clearIdleTimer, normalizeCommittedBuffers, probe]);

  // Navigation and model switches happen long before the idle boundary on a
  // fast click, so the last stable value is committed on unmount too.
  useEffect(() => () => {
    for (const timer of idleTimersRef.current.values()) clearTimeout(timer);
    idleTimersRef.current.clear();
    const pending = buffersRef.current;
    if (!hasPendingParameterBuffer(pending)) return;
    const flushed = flushParameterFieldBuffers(fieldsRef.current, pending, valuesRef.current);
    for (const fieldId of flushed.committedFieldIds) {
      onChangeRef.current(fieldId, flushed.values[fieldId]);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    flush(): DynamicParameterBufferFlush {
      for (const timer of idleTimersRef.current.values()) clearTimeout(timer);
      idleTimersRef.current.clear();
      const flushed = flushParameterFieldBuffers(
        fieldsRef.current,
        buffersRef.current,
        valuesRef.current
      );
      normalizeCommittedBuffers(flushed.committedFieldIds, flushed.values);
      for (const fieldId of flushed.committedFieldIds) {
        probe.parentCommit();
        onChangeRef.current(fieldId, flushed.values[fieldId]);
      }
      return flushed;
    }
  }), [normalizeCommittedBuffers, probe]);

  const handleBufferedInput = useCallback((fieldId: string, text: string) => {
    const field = fieldsRef.current.find((item) => item.fieldId === fieldId);
    if (!field) return;
    probe.begin(controlKindForValueType(field.valueType));
    pendingSettleRef.current = true;
    setBuffers((current) => {
      const existing = current[fieldId];
      if (existing && existing.text === text) return current;
      return {
        ...current,
        [fieldId]: applyParameterFieldInput(field, valuesRef.current[fieldId], text)
      };
    });
    clearIdleTimer(fieldId);
    const timer = setTimeout(() => {
      idleTimersRef.current.delete(fieldId);
      commitField(fieldId);
    }, PARAMETER_COMMIT_IDLE_MS);
    idleTimersRef.current.set(fieldId, timer);
  }, [clearIdleTimer, commitField, probe]);

  const handleDiscreteChange = useCallback((
    field: DynamicParameterField,
    value: DynamicParameterValue | undefined
  ) => {
    probe.begin(controlKindForValueType(field.valueType));
    pendingSettleRef.current = true;
    probe.parentCommit();
    onChangeRef.current(field.fieldId, value);
  }, [probe]);

  // Counts parameter-area renders for the pending keystroke only.
  probe.parameterAreaRender();

  if (fields.length === 0) {
    return <p className="uc-model-select__hint" role="status">{emptyHint}</p>;
  }
  return (
    <div className="uc-dynamic-parameters-container">
      <div className="uc-dynamic-parameters" aria-label="模型参数">
        {fields.map((field) => (
          <ParameterField
            buffer={buffers[field.fieldId]}
            disabled={disabled}
            error={errors[field.fieldId]}
            field={field}
            key={field.fieldId}
            onCommit={() => commitField(field.fieldId)}
            onDiscreteChange={(value) => handleDiscreteChange(field, value)}
            onInput={(text) => handleBufferedInput(field.fieldId, text)}
            value={values[field.fieldId]}
          />
        ))}
      </div>
    </div>
  );
});

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
  const constraint = parameterConstraint(field);
  const descriptionId = useId();
  return (
    <span className="uc-dynamic-parameters__heading">
      <span className="uc-dynamic-parameters__label">
        <span className="uc-dynamic-parameters__key">{text}</span>
        {description || constraint ? (
          <span className="uc-dynamic-parameters__info-wrap">
            <Whisper
              placement="auto"
              preventOverflow
              trigger={['hover', 'focus']}
              speaker={(
                <Tooltip className="uc-dynamic-parameters__tooltip" id={descriptionId} role="tooltip">
                  {description ? <span>{description}</span> : null}
                  {constraint ? <span className="uc-dynamic-parameters__constraint"><strong>填写要求</strong>{constraint}</span> : null}
                </Tooltip>
              )}
              container={() => document.body}
            >
            <button
              aria-describedby={descriptionId}
              aria-label={`${text}参数详情`}
              className="uc-dynamic-parameters__info"
              type="button"
            >
              <LuInfo aria-hidden="true" />
            </button>
            </Whisper>
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

function ParameterShell({
  children,
  error,
  field,
}: {
  readonly children: ReactNode;
  readonly error?: string;
  readonly field: DynamicParameterField;
}) {
  return (
    <div
      className="uc-dynamic-parameters__field"
      data-invalid={Boolean(error) || undefined}
      data-value-type={field.valueType}
    >
      <ParameterLabel field={field} />
      <div className="uc-dynamic-parameters__control">
        {children}
        {error ? <small role="alert">{error}</small> : null}
      </div>
    </div>
  );
}

function ParameterField({
  field,
  value,
  buffer,
  disabled,
  error,
  onInput,
  onCommit,
  onDiscreteChange
}: {
  readonly field: DynamicParameterField;
  readonly value: DynamicParameterValue | undefined;
  readonly buffer?: DynamicParameterFieldBuffer;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onInput: (text: string) => void;
  readonly onCommit: () => void;
  readonly onDiscreteChange: (value: DynamicParameterValue | undefined) => void;
}) {
  const pickerRef = useRef<React.ElementRef<typeof SelectPicker>>(null);
  useEffect(() => {
    // Dismiss on workspace scrolling, but allow the option list itself to scroll.
    const closePicker = (event: Event) => {
      const picker = pickerRef.current;
      if (event.target instanceof Node && picker?.overlay?.contains(event.target)) return;
      picker?.close?.();
    };
    window.addEventListener('scroll', closePicker, true);
    return () => window.removeEventListener('scroll', closePicker, true);
  }, []);
  const text = buffer ? buffer.text : serializeParameterFieldValue(field, value);
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onCommit();
  };
  if (field.valueType === 'boolean') {
    return (
      <ParameterShell error={error} field={field}>
        <Toggle
          aria-invalid={Boolean(error)}
          checked={value === true}
          checkedChildren="开启"
          disabled={disabled}
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          onChange={(next) => onDiscreteChange(next)}
          unCheckedChildren="关闭"
        />
      </ParameterShell>
    );
  }
  if (field.valueType === 'enum') {
    const data = (field.options ?? []).map((option, index) => ({
      value: String(option),
      label: displayParameterOption(option, index)
    }));
    return (
      <ParameterShell error={error} field={field}>
        <SelectPicker
          ref={pickerRef}
          aria-invalid={Boolean(error)}
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          block
          cleanable={!field.required}
          data={data}
          disabled={disabled}
          onChange={(next) => {
            const option = field.options?.find((item) => String(item) === next);
            onDiscreteChange(option);
          }}
          placeholder={field.required ? '请选择（必填）' : '请选择'}
          searchable={false}
          value={value === undefined ? null : String(value)}
          placement="autoVerticalStart"
          popupClassName="uc-dynamic-parameters__popup"
          listboxMaxHeight={200}
          preventOverflow
        />
      </ParameterShell>
    );
  }
  if (field.valueType === 'number' || field.valueType === 'integer') {
    return (
      <ParameterShell error={error} field={field}>
        <InputNumber
          aria-invalid={Boolean(error)}
          aria-label={displayParameterKey(field.fieldId || field.labelId)}
          disabled={disabled}
          max={field.maximum}
          min={field.minimum}
          onBlur={onCommit}
          onChange={(next) => onInput(next === null ? '' : String(next))}
          onKeyDown={commitOnEnter}
          required={field.required}
          step={field.valueType === 'integer' ? 1 : field.step}
          value={text}
        />
      </ParameterShell>
    );
  }
  if (field.valueType === 'string_array' || field.valueType === 'number_array') {
    return <ArrayParameterField
      disabled={disabled}
      error={error}
      field={field}
      onCommit={onCommit}
      onInput={onInput}
      text={text}
    />;
  }
  if (field.valueType === 'object') {
    return <ObjectParameterField
      disabled={disabled}
      error={error}
      field={field}
      onCommit={onCommit}
      onInput={onInput}
      text={text}
    />;
  }
  if (field.valueType === 'media_slot') {
    return (
      <ParameterShell error={error} field={field}>
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
    <ParameterShell error={error} field={field}>
      <Input
        aria-label={displayParameterKey(field.fieldId || field.labelId)}
        aria-invalid={Boolean(error)}
        disabled={disabled}
        onBlur={onCommit}
        onChange={(next) => onInput(next)}
        onKeyDown={commitOnEnter}
        placeholder={field.required ? '请输入（必填）' : '可留空'}
        required={field.required}
        value={text}
      />
    </ParameterShell>
  );
}

function ObjectParameterField({
  field,
  text,
  disabled,
  error,
  onInput,
  onCommit
}: {
  readonly field: DynamicParameterField;
  readonly text: string;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onInput: (text: string) => void;
  readonly onCommit: () => void;
}) {
  return (
    <ParameterShell error={error} field={field}>
      <Input
        aria-label={displayParameterKey(field.fieldId || field.labelId)}
        aria-invalid={Boolean(error)}
        as="textarea"
        disabled={disabled}
        onBlur={onCommit}
        onChange={(next) => onInput(next)}
        placeholder={field.required ? '{ "key": "value" }（必填）' : '{ "key": "value" }'}
        rows={3}
        value={text}
      />
    </ParameterShell>
  );
}

function ArrayParameterField({
  field,
  text,
  disabled,
  error,
  onInput,
  onCommit
}: {
  readonly field: DynamicParameterField;
  readonly text: string;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onInput: (text: string) => void;
  readonly onCommit: () => void;
}) {
  return (
    <ParameterShell error={error} field={field}>
      <Input
        aria-label={displayParameterKey(field.fieldId || field.labelId)}
        aria-invalid={Boolean(error)}
        disabled={disabled}
        onBlur={onCommit}
        onChange={(next) => onInput(next)}
        placeholder={field.required ? '请输入（必填）' : '可留空'}
        required={field.required}
        value={text}
      />
    </ParameterShell>
  );
}
