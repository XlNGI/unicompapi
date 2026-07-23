import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type {
  ImagePreflightDto,
  ImageSubmissionConfirmationDto,
  ImageSubmissionErrorCode
} from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceInputAssetDto,
  ImageWorkspaceParameterValueDto
} from '../../../shared/image-workspace-ipc';
import type {
  ProviderCapabilitySummaryDto,
  ProviderRegistryDto
} from '../../../shared/provider-ipc';

type QuickImageDraftDto = Extract<
  ImageWorkspaceDraftDto,
  { readonly generation: object }
>;

interface ImageQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: QuickImageDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: QuickImageDraftDto) => void;
  readonly onDraftPersisted: (draft: QuickImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToProfessional?: () => void;
}

const submissionErrorMessages: Record<ImageSubmissionErrorCode, string> = {
  project_not_open: '当前没有打开的项目。',
  invalid_request: '提交信息无效，请检查当前草稿。',
  draft_not_found: '当前草稿已不存在。',
  draft_not_submittable: '请填写一句话需求并保存草稿后再检查。',
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

const emptyConfirmations: ImageSubmissionConfirmationDto = {
  recipient: false,
  outboundScope: false,
  cost: false,
  finalPrompt: false,
  model: false
};

export function ImageQuickWorkspace({
  dirty,
  draft,
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigateToProfessional
}: ImageQuickWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const imageSubmissions = window.unicomp?.imageSubmissions;
  const [input, setInput] = useState<ImageWorkspaceInputAssetDto>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [preflight, setPreflight] = useState<ImagePreflightDto>();
  const [confirmations, setConfirmations] = useState(emptyConfirmations);
  const [busy, setBusy] = useState(false);
  const modelOptions = getQuickModelOptions(registry);
  const selectedOption = modelOptions.find(
    (option) => option.modelId === draft.generation.model?.modelId
  );
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === draft.generation.model?.modelId
  );

  useEffect(() => {
    let active = true;
    setInput(undefined);
    setPreviewUrl('');
    if (!imageWorkspaces || !draft.input) return;

    async function loadInput() {
      const [inputResult, previewResult] = await Promise.all([
        imageWorkspaces!.getInput(draft.draftId),
        imageWorkspaces!.createInputPreview(draft.draftId)
      ]);
      if (!active) return;
      if (inputResult.ok) setInput(inputResult.value);
      if (previewResult.ok) setPreviewUrl(previewResult.value.url);
    }

    void loadInput().catch(() => {
      if (active) onMessage('参考图读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, draft.input?.assetId, imageWorkspaces, onMessage]);

  useEffect(() => {
    setPreflight(undefined);
    setConfirmations(emptyConfirmations);
  }, [draft.updatedAt]);

  function changeDraft(next: QuickImageDraftDto) {
    setPreflight(undefined);
    setConfirmations(emptyConfirmations);
    onDraftChange({ ...next, state: 'editing' });
  }

  function changePrompt(value: string) {
    changeDraft({
      ...draft,
      prompt: {
        originalInput: value,
        systemSupplements: [],
        finalPrompt: value
      }
    });
  }

  function changeModel(modelId: string) {
    const option = modelOptions.find(
      (candidate) =>
        candidate.modelId === modelId &&
        !candidate.reason &&
        candidate.evidence
    );
    changeDraft({
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
    changeDraft({
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

  async function selectReference() {
    if (!imageWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.selectInput(draft.draftId);
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      onDraftPersisted(result.value.draft as QuickImageDraftDto);
      setInput(result.value.input);
      const preview = await imageWorkspaces.createInputPreview(draft.draftId);
      setPreviewUrl(preview.ok ? preview.value.url : '');
      onMessage('参考图已复制并登记到当前项目；没有上传、分析或生成。');
    } catch {
      onMessage('选择参考图失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function checkSubmission() {
    if (!imageSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(submissionErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setConfirmations(emptyConfirmations);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建任务。'
          : '检查通过：请核对并确认全部提交事实。'
      );
    } catch {
      onMessage('提交条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function enterProfessional() {
    if (!imageWorkspaces || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.derive(
        draft.draftId,
        'professional_image'
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onMessage('已创建专业生图派生草稿；没有创建或提交任务。');
      onNavigateToProfessional?.();
    } catch {
      onMessage('创建专业生图派生草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="uc-image-workbench__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>一句话需求</h2>
              <p>原始输入与最终提示词分别保存；快速模式不自动增强。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的图片</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changePrompt(event.target.value)}
              placeholder="例如：雪山日落下的露营海报"
              rows={6}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>
          <div className="uc-image-quick__reference">
            <div>
              <strong>单张参考图（可选）</strong>
              <span>
                {input
                  ? `${input.name} · ${input.width} × ${input.height}`
                  : '选择后只复制到当前项目，不会上传或分析。'}
              </span>
            </div>
            <Button
              disabled={!imageWorkspaces || dirty || busy}
              onClick={() => void selectReference()}
              variant="secondary"
            >
              {input ? '重新选择参考图' : '选择一张参考图'}
            </Button>
          </div>
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再选择图片或检查提交条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>参考与结果</h2>
              <p>只显示受控本地预览和主进程登记的真实结果。</p>
            </div>
          </header>
          {previewUrl ? (
            <figure className="uc-image-quick__preview">
              <img alt={`参考图：${input?.name ?? '本地图片'}`} src={previewUrl} />
              <figcaption>本地参考图预览，不代表生成结果。</figcaption>
            </figure>
          ) : (
            <EmptyState
              description="填写一句话需求后可直接生成；参考图不是必填项。"
              icon="画"
              readOnly
              title="尚无真实生成结果"
            />
          )}
          <div className="uc-image-quick__result-actions">
            <Button disabled variant="secondary">
              保存到项目
            </Button>
            <Button disabled variant="secondary">
              重新生成
            </Button>
            <Button
              disabled={dirty || busy}
              onClick={() => void enterProfessional()}
              variant="secondary"
            >
              进入专业创作
            </Button>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>模型、参数与确认</h2>
              <p>模型、参数和阻断原因全部来自本机真实 DTO。</p>
            </div>
          </header>
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
          <Button
            disabled={!imageSubmissions || dirty || busy}
            onClick={() => void checkSubmission()}
            variant="secondary"
          >
            检查提交条件
          </Button>
          {preflight ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {preflight.blockers.length ? '当前无法提交' : '提交条件已通过'}
              </strong>
              {preflight.blockers.map((blocker) => (
                <span key={blocker}>• {submissionErrorMessages[blocker]}</span>
              ))}
            </div>
          ) : null}
          {selectedCandidate ? (
            <fieldset className="uc-image-quick__confirmations">
              <legend>逐项确认本次提交</legend>
              <Confirmation
                checked={confirmations.recipient}
                label={`接收方：${selectedCandidate.recipientName}`}
                onChange={(checked) =>
                  setConfirmations({ ...confirmations, recipient: checked })
                }
              />
              <Confirmation
                checked={confirmations.outboundScope}
                label={`外发范围：${selectedCandidate.outboundScope}`}
                onChange={(checked) =>
                  setConfirmations({ ...confirmations, outboundScope: checked })
                }
              />
              <Confirmation
                checked={confirmations.cost}
                label="费用状态：未知，以服务商账单为准"
                onChange={(checked) =>
                  setConfirmations({ ...confirmations, cost: checked })
                }
              />
              <Confirmation
                checked={confirmations.finalPrompt}
                label={`最终提示词：${draft.prompt.finalPrompt}`}
                onChange={(checked) =>
                  setConfirmations({ ...confirmations, finalPrompt: checked })
                }
              />
              <Confirmation
                checked={confirmations.model}
                label={`模型：${selectedCandidate.modelName}`}
                onChange={(checked) =>
                  setConfirmations({ ...confirmations, model: checked })
                }
              />
            </fieldset>
          ) : null}
          <div className="uc-image-quick__submission-actions">
            <Button disabled>
              提交任务
            </Button>
          </div>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone={preflight?.blockers.length === 0 ? 'success' : 'warning'}>
          {preflight?.blockers.length === 0 ? '等待明确确认' : '真实能力状态'}
        </StatusPill>
        <p>
          当前没有真实图片适配器，只支持保存草稿和查看阻断原因；不会创建任务、显示假进度或假结果。
        </p>
      </Card>
    </>
  );
}

interface QuickModelOption {
  readonly modelId: string;
  readonly modelName: string;
  readonly evidence?: ProviderCapabilitySummaryDto;
  readonly reason?: string;
}

function getQuickModelOptions(
  registry?: ProviderRegistryDto
): readonly QuickModelOption[] {
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
    .map<QuickModelOption>((model) => {
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
