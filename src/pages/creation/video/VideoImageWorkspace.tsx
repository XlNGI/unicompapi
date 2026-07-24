import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import type {
  VideoExecutionDto,
  VideoPreflightDto,
  VideoTaskCreatedDto
} from '../../../shared/video-submission-ipc';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceMaterialAssetDto,
  VideoWorkspaceMaterialPreviewDto,
  VideoWorkspaceMaterialSlotDto,
  VideoWorkspaceStaleReasonDto
} from '../../../shared/video-workspace-ipc';
import {
  allVideoConfirmationsAccepted,
  emptyVideoConfirmations,
  VideoGenerationModelFields,
  videoSubmissionErrorMessages,
  VideoSubmissionConfirmations
} from './VideoGenerationControls';

type ImageVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'image_to_video' }
>;

interface VideoImageWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: ImageVideoDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: ImageVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: ImageVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

const artifactStateLabels = {
  not_created: '尚未生成',
  current: '当前有效',
  stale: '旧内容已过期'
} as const;

const staleReasonLabels: Record<VideoWorkspaceStaleReasonDto, string> = {
  prompt_changed: '提示词已变化',
  materials_changed: '素材已变化',
  context_changed: '上下文已变化',
  shot_plan_changed: '镜头方案已变化',
  requirements_changed: '变化要求已变化',
  model_changed: '模型已变化',
  parameters_changed: '参数已变化'
};

export function VideoImageWorkspace({
  dirty,
  draft,
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage
}: VideoImageWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const videoSubmissions = window.unicomp?.videoSubmissions;
  const [materials, setMaterials] = useState<
    Readonly<Record<string, VideoWorkspaceMaterialAssetDto>>
  >({});
  const [previews, setPreviews] = useState<
    Readonly<Record<string, VideoWorkspaceMaterialPreviewDto>>
  >({});
  const [preflight, setPreflight] = useState<VideoPreflightDto>();
  const [confirmations, setConfirmations] = useState(emptyVideoConfirmations);
  const [task, setTask] = useState<VideoTaskCreatedDto>();
  const [execution, setExecution] = useState<VideoExecutionDto>();
  const [busy, setBusy] = useState(false);
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === draft.generation.model?.modelId
  );
  const selectedEvidence = registry?.capabilities.find(
    (capability) =>
      capability.evidenceId ===
      draft.generation.model?.capabilityEvidenceId
  );
  const imageSchema = selectedEvidence?.videoGenerationSchema?.modes.find(
    (mode) => mode.mode === 'image_to_video'
  );
  const materialKey = useMemo(
    () =>
      JSON.stringify(
        draft.imageToVideo.materials?.slots.map((slot) => ({
          id: slot.id,
          assetId: slot.selection?.assetId
        })) ?? []
      ),
    [draft.imageToVideo.materials?.slots]
  );
  const blockers = [
    ...(preflight?.blockers ?? []),
    ...(selectedCandidate?.blockers ?? [])
  ].filter((blocker, index, items) => items.indexOf(blocker) === index);

  useEffect(() => {
    let active = true;
    setMaterials({});
    setPreviews({});
    const slots = draft.imageToVideo.materials?.slots ?? [];
    if (!videoWorkspaces || slots.every((slot) => !slot.selection)) return;

    async function loadMaterials() {
      const loaded = await Promise.all(
        slots
          .filter((slot) => slot.selection)
          .map(async (slot) => {
            const target = { kind: 'slot' as const, slotId: slot.id };
            const [materialResult, previewResult] = await Promise.all([
              videoWorkspaces!.getMaterial(draft.draftId, target),
              videoWorkspaces!.createMaterialPreview(draft.draftId, target)
            ]);
            return {
              slotId: slot.id,
              material: materialResult.ok ? materialResult.value : undefined,
              preview: previewResult.ok ? previewResult.value : undefined
            };
          })
      );
      if (!active) return;
      setMaterials(
        Object.fromEntries(
          loaded.flatMap((item) =>
            item.material ? [[item.slotId, item.material]] : []
          )
        )
      );
      setPreviews(
        Object.fromEntries(
          loaded.flatMap((item) =>
            item.preview ? [[item.slotId, item.preview]] : []
          )
        )
      );
      if (loaded.some((item) => !item.material || !item.preview)) {
        onMessage('部分已选素材当前不可读取或预览，请重新选择。');
      }
    }

    void loadMaterials().catch(() => {
      if (active) onMessage('已选素材读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, materialKey, onMessage, videoWorkspaces]);

  useEffect(() => {
    setPreflight(undefined);
    setConfirmations(emptyVideoConfirmations);
    setTask(undefined);
    setExecution(undefined);
  }, [draft.updatedAt]);

  function changeDraft(next: ImageVideoDraftDto) {
    setPreflight(undefined);
    setConfirmations(emptyVideoConfirmations);
    setTask(undefined);
    setExecution(undefined);
    onDraftChange({ ...next, state: 'editing' });
  }

  function changeOriginalInput(value: string) {
    changeDraft({
      ...draft,
      prompt: {
        ...draft.prompt,
        originalInput: value,
        finalPrompt:
          draft.prompt.systemSupplements.length === 0
            ? value
            : draft.prompt.finalPrompt
      }
    });
  }

  function changeModel(selection: {
    readonly model?: ImageVideoDraftDto['generation']['model'];
    readonly parameters?: ImageVideoDraftDto['generation']['parameters'];
  }) {
    const evidence = registry?.capabilities.find(
      (capability) =>
        capability.evidenceId === selection.model?.capabilityEvidenceId
    );
    const schema = evidence?.videoGenerationSchema?.modes.find(
      (mode) => mode.mode === 'image_to_video'
    );
    const previousSlots = new Map(
      draft.imageToVideo.materials?.slots.map((slot) => [slot.id, slot]) ?? []
    );
    const slots =
      schema?.mode === 'image_to_video'
        ? schema.materialSlots.map((slot) => {
            const previous = previousSlots.get(slot.id);
            const selectionStillValid =
              previous?.role === slot.role &&
              previous.selection &&
              slot.acceptedMediaKinds.includes(previous.selection.mediaKind);
            return {
              ...slot,
              selection: selectionStillValid
                ? previous.selection
                : undefined
            };
          })
        : undefined;
    changeDraft({
      ...draft,
      generation: {
        ...draft.generation,
        model: selection.model,
        parameters: selection.parameters
      },
      imageToVideo: {
        ...draft.imageToVideo,
        materials:
          selection.model && slots
            ? {
                capabilityEvidenceId:
                  selection.model.capabilityEvidenceId,
                slots
              }
            : undefined
      }
    });
  }

  async function selectMaterial(
    slot: VideoWorkspaceMaterialSlotDto,
    mediaKind: 'image' | 'video'
  ) {
    if (!videoWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const target = { kind: 'slot' as const, slotId: slot.id };
      const result = await videoWorkspaces.selectMaterial(
        draft.draftId,
        target,
        mediaKind
      );
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      if (result.value.cancelled || !result.value.draft) return;
      onDraftPersisted(result.value.draft as ImageVideoDraftDto);
      if (result.value.material) {
        setMaterials((items) => ({
          ...items,
          [slot.id]: result.value.material!
        }));
      }
      const previewResult = await videoWorkspaces.createMaterialPreview(
        draft.draftId,
        target
      );
      setPreviews((items) => {
        const next = { ...items };
        if (previewResult.ok) next[slot.id] = previewResult.value;
        else delete next[slot.id];
        return next;
      });
      onMessage(
        previewResult.ok
          ? '素材已绑定到当前动态槽位；没有上传、识图、增强或创建任务。'
          : `素材已登记，但预览不可用：${previewResult.error.message}`
      );
    } catch {
      onMessage('选择槽位素材失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearMaterial(slotId: string) {
    if (!videoWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoWorkspaces.clearMaterial(draft.draftId, {
        kind: 'slot',
        slotId
      });
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onDraftPersisted(result.value as ImageVideoDraftDto);
      setMaterials((items) => {
        const next = { ...items };
        delete next[slotId];
        return next;
      });
      setPreviews((items) => {
        const next = { ...items };
        delete next[slotId];
        return next;
      });
      onMessage('素材已从当前槽位移除；历史素材登记没有被删除。');
    } catch {
      onMessage('移除槽位素材失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function changeRequirements(
    key: 'mustKeep' | 'allowedChanges' | 'prohibited',
    values: readonly string[]
  ) {
    changeDraft({
      ...draft,
      imageToVideo: {
        ...draft.imageToVideo,
        [key]: values
      }
    });
  }

  function changeMotion(
    key:
      | 'subjectAction'
      | 'cameraMovement'
      | 'pace'
      | 'depthOfField',
    value: string
  ) {
    changeDraft({
      ...draft,
      imageToVideo: {
        ...draft.imageToVideo,
        [key]: value
      }
    });
  }

  async function checkSubmission() {
    if (!videoSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setConfirmations(emptyVideoConfirmations);
      setTask(undefined);
      setExecution(undefined);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建任务。'
          : '检查完成：请核对候选模型阻断项和全部提交事实。'
      );
    } catch {
      onMessage('提交条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    if (
      !videoSubmissions ||
      !preflight ||
      !selectedCandidate ||
      blockers.length ||
      !allVideoConfirmationsAccepted(confirmations) ||
      busy
    ) {
      return;
    }
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.createTask(
        draft.draftId,
        preflight.draftUpdatedAt,
        selectedCandidate.modelId,
        confirmations
      );
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setTask(result.value);
      setExecution(undefined);
      onMessage('视频任务已创建；尚未创建执行记录，也没有调用远端。');
    } catch {
      onMessage('创建视频任务失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function createExecution() {
    if (!videoSubmissions || !task || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.createExecution(task.taskId);
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setExecution(result.value);
      onMessage('本地执行记录已创建；尚未调用远端视频服务。');
    } catch {
      onMessage('创建执行记录失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function invokeExecution() {
    if (!videoSubmissions || !execution || execution.state !== 'created' || busy)
      return;
    setBusy(true);
    onMessage('');
    try {
      const result = await videoSubmissions.invokeExecution(
        execution.executionId
      );
      if (!result.ok) {
        onMessage(videoSubmissionErrorMessages[result.error.code]);
        return;
      }
      setExecution(result.value);
      onMessage(`远端调用已返回真实状态：${result.value.state}。`);
    } catch {
      onMessage('提交视频生成失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const materialCount = Object.keys(materials).length;
  const requiredSlotCount =
    draft.imageToVideo.materials?.slots.filter((slot) => slot.required)
      .length ?? 0;

  return (
    <>
      <div className="uc-image-professional__workspace uc-video-image__workspace">
        <div className="uc-video-image__main">
          <div className="uc-video-image__work-grid">
            <Card className="uc-image-workbench__panel uc-video-image__materials">
              <PanelHeading
                description="槽位、角色、数量、必填状态和媒体类型只来自能力 Schema。"
                number="1"
                title="动态素材槽位"
              />
              <dl className="uc-image-workbench__capability-list">
                <Fact
                  label="当前模式能力"
                  value={
                    imageSchema?.mode === 'image_to_video'
                      ? '已读取真实 Schema'
                      : '等待模型能力事实'
                  }
                />
                <Fact
                  label="动态槽位"
                  value={
                    draft.imageToVideo.materials
                      ? `${draft.imageToVideo.materials.slots.length} 个；${requiredSlotCount} 个必需`
                      : '尚未建立'
                  }
                />
              </dl>
              {draft.imageToVideo.materials?.slots.length ? (
                <div className="uc-image-professional__contexts">
                  {draft.imageToVideo.materials.slots.map((slot) => (
                    <MaterialSlot
                      busy={busy}
                      dirty={dirty}
                      key={slot.id}
                      material={materials[slot.id]}
                      onClear={() => void clearMaterial(slot.id)}
                      onSelect={(mediaKind) =>
                        void selectMaterial(slot, mediaKind)
                      }
                      preview={previews[slot.id]}
                      slot={slot}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  description="选择具有图生视频模式 Schema 的模型后，页面才会建立真实素材槽位。"
                  icon="材"
                  readOnly
                  title="尚无动态素材槽位"
                />
              )}
              <div className="uc-image-quick__result-actions">
                <Button disabled variant="secondary">
                  识别图片（缺少独立端口）
                </Button>
              </div>
              <p className="uc-image-quick__hint">
                选择素材只进行本地登记与预览，不会自动识图、增强提示词或生成视频。
              </p>
              {dirty ? (
                <p className="uc-image-quick__hint" role="status">
                  请先保存本地草稿，再选择素材或检查提交条件。
                </p>
              ) : null}
            </Card>

            <Card className="uc-image-workbench__panel uc-video-image__requirements">
              <PanelHeading
                description="每行一项；离开输入框后写入当前本地草稿。"
                number="2"
                title="内容保持与变化要求"
              />
              <div className="uc-video-image__requirements-grid">
                <RequirementField
                  label="必须保持"
                  onChange={(values) =>
                    changeRequirements('mustKeep', values)
                  }
                  values={draft.imageToVideo.mustKeep}
                />
                <RequirementField
                  label="允许变化"
                  onChange={(values) =>
                    changeRequirements('allowedChanges', values)
                  }
                  values={draft.imageToVideo.allowedChanges}
                />
                <RequirementField
                  label="必须避免"
                  onChange={(values) =>
                    changeRequirements('prohibited', values)
                  }
                  values={draft.imageToVideo.prohibited}
                />
              </div>
            </Card>

            <Card className="uc-image-workbench__panel uc-video-image__motion">
              <PanelHeading
                description="这些内容由用户明确填写，不根据图片自动推断。"
                number="3"
                title="动作与镜头设计"
              />
              <label className="uc-image-quick__field">
                <span>用户原始输入</span>
                <textarea
                  onChange={(event) =>
                    changeOriginalInput(event.target.value)
                  }
                  placeholder="描述希望图片如何运动，以及视频整体氛围"
                  rows={5}
                  value={draft.prompt.originalInput}
                />
              </label>
              <div className="uc-video-image__motion-grid">
                <TextField
                  label="主体动作"
                  onChange={(value) => changeMotion('subjectAction', value)}
                  value={draft.imageToVideo.subjectAction}
                />
                <TextField
                  label="运镜"
                  onChange={(value) => changeMotion('cameraMovement', value)}
                  value={draft.imageToVideo.cameraMovement}
                />
                <TextField
                  label="节奏"
                  onChange={(value) => changeMotion('pace', value)}
                  value={draft.imageToVideo.pace}
                />
                <TextField
                  label="景深"
                  onChange={(value) => changeMotion('depthOfField', value)}
                  value={draft.imageToVideo.depthOfField}
                />
              </div>
            </Card>

            <Card className="uc-image-workbench__panel uc-video-image__prompt">
              <PanelHeading
                description="三层内容分别展示和保存；旧增强状态不会被静默覆盖。"
                number="4"
                title="提示词三层"
              />
              <dl className="uc-image-workbench__capability-list">
                <Fact
                  label="提示词增强状态"
                  value={describeArtifact(draft.generation.enhancement)}
                />
                <Fact
                  label="草稿预检状态"
                  value={describeArtifact(draft.generation.preflight)}
                />
              </dl>
              <div className="uc-image-professional__prompt-columns">
                <section>
                  <StatusPill tone="info">用户原始输入</StatusPill>
                  <p>{draft.prompt.originalInput || '尚未填写动作描述。'}</p>
                </section>
                <section>
                  <StatusPill tone="neutral">系统补充内容</StatusPill>
                  {draft.prompt.systemSupplements.length ? (
                    <ul>
                      {draft.prompt.systemSupplements.map(
                        (supplement, index) => (
                          <li key={`${supplement.source}-${index}`}>
                            <small>{supplement.source}</small>
                            <span>{supplement.content}</span>
                          </li>
                        )
                      )}
                    </ul>
                  ) : (
                    <p>没有真实增强结果；系统不会编造补充内容。</p>
                  )}
                </section>
                <section>
                  <StatusPill tone="success">最终提交提示词</StatusPill>
                  <textarea
                    aria-label="最终提交提示词"
                    onChange={(event) =>
                      changeDraft({
                        ...draft,
                        prompt: {
                          ...draft.prompt,
                          finalPrompt: event.target.value
                        }
                      })
                    }
                    rows={8}
                    value={draft.prompt.finalPrompt}
                  />
                </section>
              </div>
              <Button disabled variant="secondary">
                增强提示词（缺少真实端口）
              </Button>
            </Card>
          </div>
        </div>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-video-image__submit">
          <PanelHeading
            description="模型、参数、费用、外发和提交边界只来自本机真实 DTO。"
            number="5"
            title="动态能力、确认与提交"
          />
          <VideoGenerationModelFields
            mode="image_to_video"
            model={draft.generation.model}
            onChange={changeModel}
            parameters={draft.generation.parameters}
            registry={registry}
          />
          <Button
            disabled={!videoSubmissions || dirty || busy}
            onClick={() => void checkSubmission()}
            variant="secondary"
          >
            检查提交条件
          </Button>
          {preflight ? (
            <>
              <StatusPill tone={blockers.length ? 'warning' : 'success'}>
                {blockers.length ? '当前无法提交' : '提交条件已通过'}
              </StatusPill>
              {blockers.length ? (
                <ul className="uc-image-quick__blockers">
                  {blockers.map((blocker) => (
                    <li key={blocker}>
                      {videoSubmissionErrorMessages[blocker]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {selectedCandidate ? (
            <VideoSubmissionConfirmations
              candidate={selectedCandidate}
              confirmations={confirmations}
              finalPrompt={draft.prompt.finalPrompt}
              materialSummary={`${materialCount} 个受控槽位素材`}
              onChange={setConfirmations}
            />
          ) : null}
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={
                !selectedCandidate ||
                blockers.length > 0 ||
                !allVideoConfirmationsAccepted(confirmations) ||
                busy
              }
              onClick={() => void createTask()}
            >
              创建视频任务
            </Button>
            <Button
              disabled={!task || busy}
              onClick={() => void createExecution()}
              variant="secondary"
            >
              创建执行记录
            </Button>
            <Button
              disabled={!execution || execution.state !== 'created' || busy}
              onClick={() => void invokeExecution()}
            >
              提交视频生成
            </Button>
          </div>
          {task ? (
            <p className="uc-image-quick__hint" role="status">
              本地任务已创建
              {execution
                ? `；执行 #${execution.attempt}：${execution.state}`
                : '；尚未创建执行记录'}
            </p>
          ) : null}
          <section className="uc-video-image__handoff">
            <strong>结果与基础编辑边界</strong>
            <p>
              只有视频结果正式下载、校验并登记为 Work 后才能进入基础编辑；B4 结果登记端口已具备，但当前没有可接收的真实结果，阶段 7 编辑器也未实现。
            </p>
            <Button disabled variant="secondary">
              进入基础编辑（等待正式 Work 与阶段 7）
            </Button>
          </section>
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone={blockers.length === 0 && preflight ? 'success' : 'warning'}>
          {blockers.length === 0 && preflight ? '等待明确确认' : '真实能力状态'}
        </StatusPill>
        <p>
          当前没有图片识别、提示词增强或真实视频适配器；B4 结果登记端口保持真实不可用状态，页面只保存可追溯本地草稿、受控素材和真实阻断。
        </p>
      </Card>
    </>
  );
}

function describeArtifact(artifact: {
  readonly state: keyof typeof artifactStateLabels;
  readonly staleReasons: readonly VideoWorkspaceStaleReasonDto[];
}) {
  if (artifact.state !== 'stale' || artifact.staleReasons.length === 0) {
    return artifactStateLabels[artifact.state];
  }
  return `${artifactStateLabels.stale}：${artifact.staleReasons
    .map((reason) => staleReasonLabels[reason])
    .join('、')}`;
}

function PanelHeading({
  description,
  number,
  title
}: {
  readonly description: string;
  readonly number: string;
  readonly title: string;
}) {
  return (
    <header className="uc-image-workbench__panel-heading">
      <span aria-hidden="true">{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

function Fact({
  label,
  value
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RequirementField({
  label,
  values,
  onChange
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
}) {
  const initialValue = values.join('\n');
  return (
    <label className="uc-image-quick__field">
      <span>{label}</span>
      <textarea
        defaultValue={initialValue}
        key={initialValue}
        onBlur={(event) => {
          const next = event.target.value
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean);
          if (JSON.stringify(next) !== JSON.stringify(values)) onChange(next);
        }}
        placeholder="每行填写一项"
        rows={5}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="uc-image-quick__field">
      <span>{label}</span>
      <input
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function MaterialSlot({
  busy,
  dirty,
  material,
  preview,
  slot,
  onClear,
  onSelect
}: {
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly material?: VideoWorkspaceMaterialAssetDto;
  readonly preview?: VideoWorkspaceMaterialPreviewDto;
  readonly slot: VideoWorkspaceMaterialSlotDto;
  readonly onClear: () => void;
  readonly onSelect: (mediaKind: 'image' | 'video') => void;
}) {
  return (
    <section className="uc-image-professional__context">
      <div>
        <strong>
          {slot.role} {slot.required ? '（必需）' : '（可选）'}
        </strong>
        <span>
          接受：
          {slot.acceptedMediaKinds
            .map((kind) => (kind === 'image' ? '图片' : '视频'))
            .join('、')}
        </span>
        <span>
          {material
            ? `${material.name} · ${material.width} × ${material.height}`
            : '尚未选择素材'}
        </span>
      </div>
      {preview?.mediaKind === 'image' ? (
        <figure className="uc-image-quick__preview">
          <img alt={`槽位素材：${material?.name ?? slot.role}`} src={preview.url} />
          <figcaption>受控本地图片预览。</figcaption>
        </figure>
      ) : preview?.mediaKind === 'video' ? (
        <figure className="uc-image-quick__preview">
          <video controls preload="metadata" src={preview.url}>
            当前环境不支持视频预览。
          </video>
          <figcaption>受控本地视频预览。</figcaption>
        </figure>
      ) : null}
      <div className="uc-image-quick__result-actions">
        {slot.acceptedMediaKinds.includes('image') ? (
          <Button
            disabled={dirty || busy}
            onClick={() => onSelect('image')}
            variant="secondary"
          >
            选择图片
          </Button>
        ) : null}
        {slot.acceptedMediaKinds.includes('video') ? (
          <Button
            disabled={dirty || busy}
            onClick={() => onSelect('video')}
            variant="secondary"
          >
            选择视频
          </Button>
        ) : null}
        {slot.selection ? (
          <Button
            disabled={dirty || busy}
            onClick={onClear}
            variant="secondary"
          >
            移除素材
          </Button>
        ) : null}
      </div>
    </section>
  );
}
