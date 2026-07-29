import { useEffect, useState } from 'react';
import {
  LuBadgeCheck,
  LuCirclePlay,
  LuGitBranch,
  LuImagePlus,
  LuListPlus,
  LuSave,
  LuScanText,
  LuShieldCheck,
  LuSparkles,
  LuVideo
} from 'react-icons/lu';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill } from '../../../components/StatusPill';
import type { ImagePreflightDto } from '../../../shared/image-submission-ipc';
import type {
  ImageWorkspaceInputAssetDto
} from '../../../shared/image-workspace-ipc';
import type { ProviderRegistryDto } from '../../../shared/provider-ipc';
import {
  emptyImageConfirmations,
  ImageEditingModelFields,
  imageSubmissionErrorMessages,
  ImageSubmissionConfirmations,
  type EditingImageDraftDto
} from './ImageGenerationControls';
import { ImageRegionFields } from './ImageRegionFields';
import { useImageSubmissionFlow } from './useImageSubmissionFlow';

type EditingTargetMode = 'professional_image' | 'image_to_prompt';
type EditingListKey = 'mustKeep' | 'mustChange' | 'prohibited';

interface ImageEditingWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: EditingImageDraftDto;
  readonly registry?: ProviderRegistryDto;
  readonly onDraftChange: (draft: EditingImageDraftDto) => void;
  readonly onDraftPersisted: (draft: EditingImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigate?: (mode: EditingTargetMode) => void;
  readonly onVideoDraftCreated?: (draftId: string) => void;
}

const editingErrorMessages = {
  ...imageSubmissionErrorMessages,
  capability_unverified: '图片编辑能力尚未验证。',
  parameter_schema_missing: '图片编辑模型没有可用的动态参数 Schema。',
  adapter_unavailable: '没有配置真实图片编辑适配器，当前不会外发或修改图片。'
};

const editingLists: readonly {
  readonly key: EditingListKey;
  readonly title: string;
  readonly placeholder: string;
}[] = [
  {
    key: 'mustKeep',
    title: '必须保留内容',
    placeholder: '每行一项，例如：\n人物主体的位置与姿态\n原图整体构图'
  },
  {
    key: 'mustChange',
    title: '必须修改内容',
    placeholder: '每行一项，例如：\n移除右侧杂物\n将天空改为晴天'
  },
  {
    key: 'prohibited',
    title: '禁止出现内容',
    placeholder: '每行一项，例如：\n新增人物\n改变人物面部'
  }
];

export function ImageEditingWorkspace({
  dirty,
  draft,
  registry,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigate,
  onVideoDraftCreated
}: ImageEditingWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const imageSubmissions = window.unicomp?.imageSubmissions;
  const [input, setInput] = useState<ImageWorkspaceInputAssetDto>();
  const [previewUrl, setPreviewUrl] = useState('');
  const [preflight, setPreflight] = useState<ImagePreflightDto>();
  const [confirmations, setConfirmations] = useState(emptyImageConfirmations);
  const [busy, setBusy] = useState(false);
  const selectedCandidate = preflight?.candidates.find(
    (candidate) => candidate.modelId === draft.editing.model?.modelId
  );
  const submission = useImageSubmissionFlow({
    draftId: draft.draftId,
    draftUpdatedAt: draft.updatedAt,
    preflight,
    candidate: selectedCandidate,
    confirmations,
    busy,
    setBusy,
    onMessage,
    onVideoDraftCreated,
    errorMessages: editingErrorMessages
  });

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
      if (active) onMessage('原图读取失败，请重新选择。');
    });
    return () => {
      active = false;
    };
  }, [draft.draftId, draft.input?.assetId, imageWorkspaces, onMessage]);

  useEffect(() => {
    setPreflight(undefined);
    setConfirmations(emptyImageConfirmations);
  }, [draft.updatedAt]);

  function changeDraft(next: EditingImageDraftDto) {
    setPreflight(undefined);
    setConfirmations(emptyImageConfirmations);
    onDraftChange({ ...next, state: 'editing' });
  }

  async function selectSource() {
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
      onDraftPersisted(result.value.draft as EditingImageDraftDto);
      setInput(result.value.input);
      const preview = await imageWorkspaces.createInputPreview(draft.draftId);
      setPreviewUrl(preview.ok ? preview.value.url : '');
      onMessage('原图已登记到当前项目；没有上传、修改或创建任务。');
    } catch {
      onMessage('选择原图失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  function changeRequirement(value: string) {
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

  function changeList(key: EditingListKey, value: string) {
    changeDraft({
      ...draft,
      editing: {
        ...draft.editing,
        [key]: value
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
      }
    });
  }

  async function checkEditing() {
    if (!imageSubmissions || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageSubmissions.preflight(draft.draftId);
      if (!result.ok) {
        onMessage(editingErrorMessages[result.error.code]);
        return;
      }
      setPreflight(result.value);
      setConfirmations(emptyImageConfirmations);
      onMessage(
        result.value.blockers.length
          ? '检查完成：当前存在阻断项，没有创建编辑任务。'
          : '检查通过：请核对并确认全部提交事实。'
      );
    } catch {
      onMessage('编辑条件检查失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function deriveDraft(targetMode: EditingTargetMode) {
    if (!imageWorkspaces || dirty || busy) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.derive(draft.draftId, targetMode);
      if (!result.ok) {
        onMessage(result.error.message);
        return;
      }
      onMessage('已创建派生草稿；没有创建或提交任务。');
      onNavigate?.(targetMode);
    } catch {
      onMessage('创建派生草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="uc-image-editing__workspace">
        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>原图与编辑要求</h2>
              <p>所有成功结果都将成为新版本，原图不会被覆盖。</p>
            </div>
          </header>
          <div className="uc-image-quick__reference">
            <div>
              <strong>单张原图</strong>
              <span>
                {input
                  ? `${input.name} · ${input.width} × ${input.height}`
                  : '请选择一张经过主进程校验的本地图片。'}
              </span>
            </div>
            <Button
              disabled={!imageWorkspaces || dirty || busy}
              onClick={() => void selectSource()}
              variant="secondary"
            >
              <LuImagePlus aria-hidden="true" />
              {input ? '更换原图' : '选择一张原图'}
            </Button>
          </div>
          <label className="uc-image-quick__field">
            <span>原始编辑要求</span>
            <textarea
              maxLength={1000}
              onChange={(event) => changeRequirement(event.target.value)}
              placeholder="描述需要修改、删除或替换的内容"
              rows={5}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>
          {editingLists.map((field) => (
            <label className="uc-image-quick__field" key={field.key}>
              <span>{field.title}</span>
              <textarea
                maxLength={1000}
                onChange={(event) => changeList(field.key, event.target.value)}
                placeholder={field.placeholder}
                rows={4}
                value={draft.editing[field.key].join('\n')}
              />
            </label>
          ))}
          {dirty ? (
            <p className="uc-image-quick__hint" role="status">
              请先点击页面顶部“保存本地草稿”，再更换原图或检查编辑条件。
            </p>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-editing__canvas">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>原图预览与编辑区域</h2>
              <p>虚线框表示当前草稿保存的归一化编辑区域。</p>
            </div>
          </header>
          {previewUrl ? (
            <figure className="uc-image-understanding__preview">
              <div>
                <img alt={`编辑原图：${input?.name ?? '本地图片'}`} src={previewUrl} />
                {draft.input?.region ? (
                  <span
                    aria-label="当前编辑区域"
                    style={{
                      left: `${draft.input.region.x * 100}%`,
                      top: `${draft.input.region.y * 100}%`,
                      width: `${draft.input.region.width * 100}%`,
                      height: `${draft.input.region.height * 100}%`
                    }}
                  />
                ) : null}
              </div>
              <figcaption>受控原图预览；原始文件不会被覆盖。</figcaption>
            </figure>
          ) : (
            <EmptyState
              description="选择一张原图后，这里会显示受控本地预览。"
              icon="图"
              readOnly
              title="尚未选择原图"
            />
          )}
          <ImageRegionFields
            disabled={!draft.input}
            label="启用编辑区域（不勾选时编辑全图）"
            onChange={(region) => {
              if (draft.input) {
                changeDraft({
                  ...draft,
                  input: { ...draft.input, region }
                });
              }
            }}
            region={draft.input?.region}
          />
          <div className="uc-image-quick__reference">
            <div>
              <strong>可选蒙版</strong>
              <span>
                {draft.editing.maskAssetId
                  ? `已登记蒙版 Asset：${draft.editing.maskAssetId}`
                  : '当前 DTO 尚未提供受控蒙版选择接口。'}
              </span>
            </div>
            <Button disabled variant="secondary">
              <LuImagePlus aria-hidden="true" />
              选择蒙版
            </Button>
          </div>
        </Card>

        <Card className="uc-image-workbench__panel">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>模型、参数与确认</h2>
              <p>模型和参数只来自本机注册表中的真实能力事实。</p>
            </div>
          </header>
          <ImageEditingModelFields
            draft={draft}
            onDraftChange={changeDraft}
            registry={registry}
          />
          <Button
            disabled={!imageSubmissions || !draft.input || dirty || busy}
            onClick={() => void checkEditing()}
            variant="secondary"
          >
            <LuShieldCheck aria-hidden="true" />
            检查编辑条件
          </Button>
          {preflight ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>
                {preflight.blockers.length
                  ? '当前无法提交编辑'
                  : '编辑条件已通过'}
              </strong>
              {preflight.blockers.map((blocker) => (
                <span key={blocker}>· {editingErrorMessages[blocker]}</span>
              ))}
            </div>
          ) : null}
          {selectedCandidate ? (
            <ImageSubmissionConfirmations
              candidate={selectedCandidate}
              confirmations={confirmations}
              finalPrompt={draft.prompt.finalPrompt}
              onChange={setConfirmations}
              promptLabel="最终编辑要求"
            />
          ) : null}
          <div className="uc-image-quick__submission-actions">
            <Button
              disabled={!submission.canCreateTask}
              onClick={() => void submission.createTask()}
            >
              <LuListPlus aria-hidden="true" />
              创建图片编辑任务
            </Button>
            <Button
              disabled={!submission.task || Boolean(submission.execution) || busy}
              onClick={() => void submission.createExecution()}
              variant="secondary"
            >
              <LuCirclePlay aria-hidden="true" />
              创建执行记录
            </Button>
            <Button
              disabled={
                !submission.execution ||
                submission.execution.state !== 'created' ||
                busy
              }
              onClick={() => void submission.invokeExecution()}
            >
              <LuSparkles aria-hidden="true" />
              提交图片编辑
            </Button>
            <Button
              disabled={
                !submission.execution ||
                submission.execution.state !== 'remote_completed' ||
                busy
              }
              onClick={() => void submission.receiveResult()}
              variant="secondary"
            >
              <LuBadgeCheck aria-hidden="true" />
              校验并登记新版本
            </Button>
            <Button
              disabled={!submission.work || busy}
              onClick={() => void submission.createVideoDraft()}
              variant="secondary"
            >
              <LuVideo aria-hidden="true" />
              创建图生视频草稿
            </Button>
          </div>
          {submission.execution ? (
            <p className="uc-image-quick__hint" role="status">
              执行 #{submission.execution.attempt}：{submission.execution.state}
              {submission.work ? `；已登记 ${submission.work.name}` : ''}
            </p>
          ) : null}
          <p className="uc-image-quick__hint">
            图片编辑只在能力、凭证和提交确认全部通过后执行；原图永远不会被覆盖。
          </p>
        </Card>
      </div>

      <Card className="uc-image-editing__lineage">
        <header className="uc-image-understanding__results-heading">
          <div>
            <h2>版本关系</h2>
            <p>原图、父草稿、父作品和后续新版本保持可追溯。</p>
          </div>
          <StatusPill tone="info">
            {draft.editing.lineage ? '已有父版本' : '当前原图起点'}
          </StatusPill>
        </header>
        <dl className="uc-image-workbench__capability-list">
          <div>
            <dt>源 Asset</dt>
            <dd>
              {draft.editing.lineage?.parentAssetId ??
                draft.input?.assetId ??
                '尚未选择'}
            </dd>
          </div>
          <div>
            <dt>父草稿</dt>
            <dd>{draft.editing.lineage?.parentDraftId ?? '无'}</dd>
          </div>
          <div>
            <dt>父作品</dt>
            <dd>{draft.editing.lineage?.parentWorkId ?? '无'}</dd>
          </div>
          <div>
            <dt>当前结果</dt>
            <dd>{submission.work?.name ?? '尚无已校验编辑结果'}</dd>
          </div>
        </dl>
        <EmptyState
          description="真实编辑完成并通过结果校验后，才会登记新作品版本。"
          icon="版"
          readOnly
          title="原图保持不变"
        />
        <div className="uc-image-quick__result-actions">
          <Button disabled>
            <LuSave aria-hidden="true" />
            {submission.work ? '新版本已登记到项目' : '保存新版本到项目'}
          </Button>
          <Button disabled variant="secondary">
            <LuGitBranch aria-hidden="true" />
            继续编辑新分支
          </Button>
        </div>
      </Card>

      <Card className="uc-image-workbench__notice">
        <StatusPill tone="warning">后续操作</StatusPill>
        <p>切换模式只创建派生草稿，不会自动创建或提交任务。</p>
        <div className="uc-image-quick__result-actions">
          <Button
            disabled={dirty || busy}
            onClick={() => void deriveDraft('image_to_prompt')}
            variant="secondary"
          >
            <LuScanText aria-hidden="true" />
            转为提示词草稿
          </Button>
          <Button
            disabled={dirty || busy}
            onClick={() => void deriveDraft('professional_image')}
            variant="secondary"
          >
            <LuSparkles aria-hidden="true" />
            进入专业生图
          </Button>
        </div>
      </Card>
    </>
  );
}
