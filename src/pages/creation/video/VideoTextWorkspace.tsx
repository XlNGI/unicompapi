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
  VideoWorkspaceShotDto
} from '../../../shared/video-workspace-ipc';
import {
  allVideoConfirmationsAccepted,
  emptyVideoConfirmations,
  VideoGenerationModelFields,
  videoSubmissionErrorMessages,
  VideoSubmissionConfirmations
} from './VideoGenerationControls';

type TextVideoDraftDto = Extract<
  VideoWorkspaceDraftDto,
  { readonly mode: 'text_to_video' }
>;

interface VideoTextWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: TextVideoDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: TextVideoDraftDto) => void;
  readonly onDraftPersisted: (draft: TextVideoDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

const contextSections = [
  {
    kind: 'project_asset',
    title: '项目素材',
    description: '只使用用户明确选择的当前项目素材。'
  },
  {
    kind: 'project_context',
    title: '项目上下文',
    description: '不会自动读取整个项目历史。'
  },
  {
    kind: 'saved_conversation',
    title: '已保存的对话上下文',
    description: '不会读取未保存或未选择的对话。'
  }
] as const;

const artifactStateLabels = {
  not_created: '尚未生成',
  current: '当前有效',
  stale: '旧内容已过期'
} as const;

export function VideoTextWorkspace({
  dirty,
  draft,
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage
}: VideoTextWorkspaceProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const videoSubmissions = window.unicomp?.videoSubmissions;
  const [materials, setMaterials] = useState<
    Readonly<Record<string, VideoWorkspaceMaterialAssetDto>>
  >({});
  const [previews, setPreviews] = useState<
    Readonly<Record<string, VideoWorkspaceMaterialPreviewDto>>
  >({});
  const [newShotDescription, setNewShotDescription] = useState('');
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
  const textSchema = selectedEvidence?.videoGenerationSchema?.modes.find(
    (mode) => mode.mode === 'text_to_video'
  );
  const shotPlan =
    textSchema?.mode === 'text_to_video' ? textSchema.shotPlan : undefined;
  const materialKey = useMemo(
    () =>
      JSON.stringify(
        draft.textToVideo.materials?.slots.map((slot) => ({
          id: slot.id,
          assetId: slot.selection?.assetId
        })) ?? []
      ),
    [draft.textToVideo.materials?.slots]
  );
  const blockers = [
    ...(preflight?.blockers ?? []),
    ...(selectedCandidate?.blockers ?? [])
  ].filter((blocker, index, items) => items.indexOf(blocker) === index);

  useEffect(() => {
    let active = true;
    setMaterials({});
    setPreviews({});
    const slots = draft.textToVideo.materials?.slots ?? [];
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

  function changeDraft(next: TextVideoDraftDto) {
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
    readonly model?: TextVideoDraftDto['generation']['model'];
    readonly parameters?: TextVideoDraftDto['generation']['parameters'];
  }) {
    const evidence = registry?.capabilities.find(
      (capability) =>
        capability.evidenceId === selection.model?.capabilityEvidenceId
    );
    const schema = evidence?.videoGenerationSchema?.modes.find(
      (mode) => mode.mode === 'text_to_video'
    );
    const previousSlots = new Map(
      draft.textToVideo.materials?.slots.map((slot) => [slot.id, slot]) ?? []
    );
    const slots =
      schema?.mode === 'text_to_video'
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
      textToVideo: {
        ...draft.textToVideo,
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
      onDraftPersisted(result.value.draft as TextVideoDraftDto);
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
        '素材已绑定到当前动态槽位；没有上传、分析、增强或创建任务。'
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
      onDraftPersisted(result.value as TextVideoDraftDto);
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

  function addShot() {
    const description = newShotDescription.trim();
    if (
      !description ||
      shotPlan?.supported === false ||
      (shotPlan?.maximumShots !== undefined &&
        draft.textToVideo.shots.length >= shotPlan.maximumShots)
    ) {
      return;
    }
    changeDraft({
      ...draft,
      textToVideo: {
        ...draft.textToVideo,
        shots: [
          ...draft.textToVideo.shots,
          {
            id: `shot-${crypto.randomUUID()}`,
            order: draft.textToVideo.shots.length + 1,
            description
          }
        ]
      }
    });
    setNewShotDescription('');
  }

  function updateShot(shotId: string, patch: Partial<VideoWorkspaceShotDto>) {
    changeDraft({
      ...draft,
      textToVideo: {
        ...draft.textToVideo,
        shots: draft.textToVideo.shots.map((shot) =>
          shot.id === shotId ? { ...shot, ...patch } : shot
        )
      }
    });
  }

  function moveShot(shotId: string, offset: -1 | 1) {
    const shots = [...draft.textToVideo.shots];
    const index = shots.findIndex((shot) => shot.id === shotId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= shots.length) return;
    [shots[index], shots[target]] = [shots[target], shots[index]];
    changeDraft({
      ...draft,
      textToVideo: {
        ...draft.textToVideo,
        shots: shots.map((shot, shotIndex) => ({
          ...shot,
          order: shotIndex + 1
        }))
      }
    });
  }

  function removeShot(shotId: string) {
    changeDraft({
      ...draft,
      textToVideo: {
        ...draft.textToVideo,
        shots: draft.textToVideo.shots
          .filter((shot) => shot.id !== shotId)
          .map((shot, index) => ({ ...shot, order: index + 1 }))
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

  return (
    <>
      <div className="uc-image-professional__workspace">
        <Card className="uc-image-workbench__panel">
          <PanelHeading
            description="短创意和长文本分别保存，不自动读取任何上下文。"
            number="1"
            title="输入来源与显式上下文"
          />
          <div className="uc-image-quick__result-actions">
            <Button
              onClick={() =>
                changeDraft({
                  ...draft,
                  textToVideo: {
                    ...draft.textToVideo,
                    sourceKind: 'short_idea'
                  }
                })
              }
              variant={
                draft.textToVideo.sourceKind === 'short_idea'
                  ? 'primary'
                  : 'secondary'
              }
            >
              短创意
            </Button>
            <Button
              onClick={() =>
                changeDraft({
                  ...draft,
                  textToVideo: {
                    ...draft.textToVideo,
                    sourceKind: 'long_form'
                  }
                })
              }
              variant={
                draft.textToVideo.sourceKind === 'long_form'
                  ? 'primary'
                  : 'secondary'
              }
            >
              长文本 / 故事 / 脚本
            </Button>
          </div>
          <label className="uc-image-quick__field">
            <span>
              {draft.textToVideo.sourceKind === 'short_idea'
                ? '短创意'
                : '长文本、故事或脚本'}
            </span>
            <textarea
              onChange={(event) => changeOriginalInput(event.target.value)}
              placeholder={
                draft.textToVideo.sourceKind === 'short_idea'
                  ? '用几句话描述人物、场景、动作与氛围'
                  : '粘贴或输入需要整理为镜头草稿的长文本'
              }
              rows={8}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} 个字符</small>
          </label>

          <div className="uc-image-professional__contexts">
            {contextSections.map((section) => {
              const count = draft.contextReferences.filter(
                (reference) => reference.kind === section.kind
              ).length;
              return (
                <section
                  className="uc-image-professional__context"
                  key={section.kind}
                >
                  <div>
                    <strong>{section.title}</strong>
                    <span>{section.description}</span>
                  </div>
                  <div className="uc-image-professional__context-action">
                    <Button disabled variant="secondary">
                      选择{section.title}
                    </Button>
                    <span>已明确选择 {count} 项</span>
                  </div>
                </section>
              );
            })}
          </div>
          <p className="uc-image-quick__hint">
            当前 DTO 没有上下文候选列表接口，因此不能新增选择，也不会自动读取。
          </p>
        </Card>

        <Card className="uc-image-workbench__panel">
          <PanelHeading
            description="槽位、角色、必填状态和媒体类型只来自能力 Schema。"
            number="2"
            title="动态素材槽位"
          />
          {draft.textToVideo.materials?.slots.length ? (
            <div className="uc-image-professional__contexts">
              {draft.textToVideo.materials.slots.map((slot) => (
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
              description="选择具有文生视频模式 Schema 的模型后，页面才会显示真实素材槽位。"
              icon="材"
              readOnly
              title="尚无动态素材槽位"
            />
          )}
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先保存本地草稿，再选择素材或检查提交条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel">
          <PanelHeading
            description="镜头草稿只保存在当前项目，不会创建远端任务。"
            number="3"
            title="镜头方案与分镜状态"
          />
          <dl className="uc-image-workbench__capability-list">
            <Fact
              label="镜头方案支持"
              value={
                shotPlan
                  ? shotPlan.supported
                    ? '当前能力支持'
                    : '当前能力不支持'
                  : '状态未知'
              }
            />
            <Fact
              label="镜头数量约束"
              value={
                shotPlan
                  ? `${shotPlan.required ? '必需' : '可选'} · 最少 ${
                      shotPlan.minimumShots ?? '未知'
                    } · 最多 ${shotPlan.maximumShots ?? '未知'}`
                  : '等待能力事实'
              }
            />
            <Fact
              label="分镜草稿"
              value={artifactStateLabels[draft.textToVideo.storyboard.state]}
            />
            <Fact
              label="分镜画面"
              value={
                draft.textToVideo.storyboard.frameAssetIds.length
                  ? `${draft.textToVideo.storyboard.frameAssetIds.length} 项`
                  : '尚未生成'
              }
            />
          </dl>
          <div className="uc-image-quick__reference">
            <label className="uc-image-quick__field">
              <span>新增镜头描述</span>
              <input
                onChange={(event) => setNewShotDescription(event.target.value)}
                placeholder="先填写镜头内容，再添加到本地草稿"
                value={newShotDescription}
              />
            </label>
            <Button
              disabled={
                !newShotDescription.trim() ||
                shotPlan?.supported === false ||
                (shotPlan?.maximumShots !== undefined &&
                  draft.textToVideo.shots.length >= shotPlan.maximumShots)
              }
              onClick={addShot}
              variant="secondary"
            >
              添加镜头
            </Button>
          </div>
          <div className="uc-image-professional__contexts">
            {draft.textToVideo.shots.map((shot, index) => (
              <ShotEditor
                index={index}
                key={shot.id}
                onMove={(offset) => moveShot(shot.id, offset)}
                onRemove={() => removeShot(shot.id)}
                onUpdate={(patch) => updateShot(shot.id, patch)}
                shot={shot}
                total={draft.textToVideo.shots.length}
              />
            ))}
          </div>
          {draft.textToVideo.shots.length === 0 ? (
            <p className="uc-image-quick__hint">当前没有本地镜头草稿。</p>
          ) : null}
          <div className="uc-image-quick__result-actions">
            <Button disabled variant="secondary">
              生成镜头草稿（缺少真实端口）
            </Button>
            <Button disabled variant="secondary">
              生成分镜草稿（缺少真实端口）
            </Button>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel">
          <PanelHeading
            description="三层内容分别展示和保存，系统补充不会覆盖用户原文。"
            number="4"
            title="提示词三层"
          />
          <div className="uc-image-professional__prompt-columns">
            <section>
              <StatusPill tone="info">用户原始输入</StatusPill>
              <p>{draft.prompt.originalInput || '尚未填写文本来源。'}</p>
            </section>
            <section>
              <StatusPill tone="neutral">系统补充内容</StatusPill>
              {draft.prompt.systemSupplements.length ? (
                <ul>
                  {draft.prompt.systemSupplements.map((supplement, index) => (
                    <li key={`${supplement.source}-${index}`}>
                      <small>{supplement.source}</small>
                      <span>{supplement.content}</span>
                    </li>
                  ))}
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
                rows={9}
                value={draft.prompt.finalPrompt}
              />
            </section>
          </div>
          <Button disabled variant="secondary">
            增强提示词（缺少真实端口）
          </Button>
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities">
          <PanelHeading
            description="模型、参数、费用和外发范围只来自本机真实 DTO。"
            number="5"
            title="动态能力、确认与提交"
          />
          <VideoGenerationModelFields
            mode="text_to_video"
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
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {blockers.length ? '当前无法提交' : '提交条件已通过'}
              </strong>
              {blockers.map((blocker) => (
                <span key={blocker}>
                  • {videoSubmissionErrorMessages[blocker]}
                </span>
              ))}
            </div>
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
          <div className="uc-image-quick__submission-actions">
            <Button
              disabled={
                !preflight ||
                !selectedCandidate ||
                blockers.length > 0 ||
                !allVideoConfirmationsAccepted(confirmations) ||
                Boolean(task) ||
                busy
              }
              onClick={() => void createTask()}
              variant="secondary"
            >
              创建视频任务
            </Button>
            <Button
              disabled={!task || Boolean(execution) || busy}
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
        </Card>
      </div>

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone={blockers.length === 0 && preflight ? 'success' : 'warning'}>
          {blockers.length === 0 && preflight ? '等待明确确认' : '真实能力状态'}
        </StatusPill>
        <p>
          当前没有上下文候选、提示词增强、镜头生成或真实视频适配器；页面只保存可追溯本地草稿并展示真实阻断。
        </p>
      </Card>
    </>
  );
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

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
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

function ShotEditor({
  index,
  shot,
  total,
  onMove,
  onRemove,
  onUpdate
}: {
  readonly index: number;
  readonly shot: VideoWorkspaceShotDto;
  readonly total: number;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onUpdate: (patch: Partial<VideoWorkspaceShotDto>) => void;
}) {
  function optional(value: string) {
    return value.trim() ? value : undefined;
  }

  return (
    <section className="uc-image-professional__context">
      <div>
        <strong>镜头 {index + 1}</strong>
        <label className="uc-image-quick__field">
          <span>镜头描述</span>
          <textarea
            onChange={(event) => onUpdate({ description: event.target.value })}
            rows={3}
            value={shot.description}
          />
        </label>
        <label className="uc-image-quick__field">
          <span>主体动作</span>
          <input
            onChange={(event) =>
              onUpdate({ action: optional(event.target.value) })
            }
            value={shot.action ?? ''}
          />
        </label>
        <label className="uc-image-quick__field">
          <span>运镜</span>
          <input
            onChange={(event) =>
              onUpdate({ cameraMovement: optional(event.target.value) })
            }
            value={shot.cameraMovement ?? ''}
          />
        </label>
        <label className="uc-image-quick__field">
          <span>节奏</span>
          <input
            onChange={(event) =>
              onUpdate({ pace: optional(event.target.value) })
            }
            value={shot.pace ?? ''}
          />
        </label>
        <label className="uc-image-quick__field">
          <span>景深</span>
          <input
            onChange={(event) =>
              onUpdate({ depthOfField: optional(event.target.value) })
            }
            value={shot.depthOfField ?? ''}
          />
        </label>
      </div>
      <div className="uc-image-quick__result-actions">
        <Button
          disabled={index === 0}
          onClick={() => onMove(-1)}
          variant="secondary"
        >
          上移
        </Button>
        <Button
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          variant="secondary"
        >
          下移
        </Button>
        <Button onClick={onRemove} variant="secondary">
          删除镜头
        </Button>
      </div>
    </section>
  );
}
