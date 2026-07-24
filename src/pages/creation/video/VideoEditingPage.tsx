import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../../components/StatusPill';
import type { StorageProjectSessionDto } from '../../../shared/storage-ipc';
import type {
  VideoEditorDraftDto,
  VideoEditorIpcErrorCode,
  VideoEditorIpcResult
} from '../../../shared/video-editor-ipc';
import '../../../styles/pages.css';
import { videoCreationModes } from '../creationModes';

const mode = videoCreationModes[3];

const errorMessages: Partial<Record<VideoEditorIpcErrorCode, string>> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  invalid_request: '编辑请求无效，当前草稿没有被修改。',
  draft_not_found: '该编辑草稿已不存在，请重新选择。',
  draft_conflict: '草稿已在其他操作中更新，请重新载入后继续。',
  source_not_found: '来源作品或视频草稿已不可用，未创建编辑草稿。',
  source_invalid: '来源不属于当前项目或不是可用视频。',
  nothing_to_undo: '当前没有可撤销的操作。',
  nothing_to_redo: '当前没有可重做的操作。',
  workspace_storage_error: '草稿未能写入项目，请检查存储后继续。'
};

type SaveState =
  | 'saved'
  | 'editing'
  | 'saving'
  | 'failed'
  | 'conflict';

const saveStateLabels: Record<SaveState, string> = {
  saved: '已自动保存',
  editing: '有未保存修改',
  saving: '保存中',
  failed: '保存失败，修改仍保留',
  conflict: '版本冲突'
};

const saveStateTones: Record<SaveState, StatusTone> = {
  saved: 'success',
  editing: 'warning',
  saving: 'info',
  failed: 'danger',
  conflict: 'danger'
};

export function VideoEditingPage() {
  const storage = window.unicomp?.storage;
  const videoEditors = window.unicomp?.videoEditors;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [drafts, setDrafts] = useState<readonly VideoEditorDraftDto[]>([]);
  const [currentDraft, setCurrentDraft] = useState<VideoEditorDraftDto>();
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      if (!storage || !videoEditors) {
        if (active) {
          setLoading(false);
          setMessage('本地编辑端口不可用，请在 Electron 桌面应用中打开。');
        }
        return;
      }

      const sessionResult = await storage.getProjectSession();
      if (!active) return;
      if (!sessionResult.ok) {
        setLoading(false);
        setMessage('读取当前项目失败，请返回“项目”页面重试。');
        return;
      }
      setSession(sessionResult.value);
      if (!sessionResult.value) {
        setLoading(false);
        return;
      }

      const listResult = await videoEditors.list();
      if (!active) return;
      setLoading(false);
      if (!listResult.ok) {
        setMessage(
          errorMessages[listResult.error.code] ?? '读取编辑草稿失败，请重试。'
        );
        return;
      }
      const sorted = sortDrafts(listResult.value);
      setDrafts(sorted);
      acceptDraft(sorted[0]);
    }

    void load().catch(() => {
      if (active) {
        setLoading(false);
        setMessage('读取基础编辑草稿失败，请重试。');
      }
    });
    return () => {
      active = false;
    };
  }, [storage, videoEditors]);

  function acceptDraft(draft?: VideoEditorDraftDto) {
    setCurrentDraft(draft);
    setTitle(draft?.title ?? '');
    setSaveState('saved');
    if (!draft) return;
    setDrafts((items) =>
      sortDrafts(
        items.some((item) => item.draftId === draft.draftId)
          ? items.map((item) =>
              item.draftId === draft.draftId ? draft : item
            )
          : [...items, draft]
      )
    );
  }

  function handleError(
    error: Extract<
      VideoEditorIpcResult<VideoEditorDraftDto>,
      { readonly ok: false }
    >['error']
  ) {
    if (error.recoverableDraft) {
      acceptDraft(error.recoverableDraft);
      setSaveState('failed');
      setMessage(
        '修改仍保留在本机内存中，但尚未写入项目；继续编辑时会再次尝试保存。'
      );
      return;
    }
    if (error.code === 'draft_conflict') setSaveState('conflict');
    setMessage(errorMessages[error.code] ?? '本地编辑操作未完成，请重试。');
  }

  async function mutate(
    operation: () => Promise<VideoEditorIpcResult<VideoEditorDraftDto>>,
    successMessage: string
  ) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await operation();
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      acceptDraft(result.value);
      setMessage(successMessage);
    } catch {
      setSaveState('failed');
      setMessage('本地编辑操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    if (!videoEditors || !session) return;
    await mutate(
      () => videoEditors.create({ kind: 'blank' }),
      '空白编辑草稿已创建；没有导入素材，也没有创建导出任务。'
    );
  }

  async function openDraft(draftId: string) {
    if (!videoEditors || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoEditors.get(draftId);
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      if (!result.value) {
        setMessage(errorMessages.draft_not_found ?? '编辑草稿已不存在。');
        return;
      }
      acceptDraft(result.value);
      setMessage('已打开项目内编辑草稿。');
    } catch {
      setMessage('打开编辑草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function commitTitle() {
    if (!videoEditors || !currentDraft || busy) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setTitle(currentDraft.title);
      setSaveState('saved');
      setMessage('草稿名称不能为空，已恢复原名称。');
      return;
    }
    if (nextTitle === currentDraft.title) {
      setTitle(nextTitle);
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    await mutate(
      () =>
        videoEditors.update(currentDraft.draftId, currentDraft.revision, {
          kind: 'set_title',
          title: nextTitle
        }),
      '草稿名称已自动保存。'
    );
  }

  async function reloadDraft() {
    if (!currentDraft) return;
    await openDraft(currentDraft.draftId);
  }

  const hasLocalTitleChange =
    Boolean(currentDraft) && title.trim() !== currentDraft?.title;
  const operationBlocked = busy || hasLocalTitleChange;

  return (
    <section
      className="uc-video-editor"
      aria-labelledby={`${mode.id}-title`}
    >
      <header className="uc-video-editor__header">
        <div className="uc-video-editor__identity">
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id={`${mode.id}-title`}>
              {mode.label}
            </h1>
            <StatusPill
              tone={
                loading
                  ? 'info'
                  : session
                    ? saveStateTones[saveState]
                    : 'warning'
              }
            >
              {loading
                ? '读取中'
                : session
                  ? saveStateLabels[saveState]
                  : '未打开项目'}
            </StatusPill>
          </div>
          <div className="uc-video-editor__draft-picker">
            <label>
              <span>编辑草稿</span>
              <select
                disabled={
                  !session ||
                  loading ||
                  operationBlocked ||
                  drafts.length === 0
                }
                onChange={(event) => void openDraft(event.target.value)}
                value={currentDraft?.draftId ?? ''}
              >
                {drafts.length === 0 ? (
                  <option value="">暂无编辑草稿</option>
                ) : null}
                {drafts.map((draft) => (
                  <option key={draft.draftId} value={draft.draftId}>
                    {draft.title}
                  </option>
                ))}
              </select>
            </label>
            <span>项目：{session?.projectName ?? '尚未打开项目'}</span>
          </div>
        </div>

        <div className="uc-video-editor__header-actions">
          <Button
            disabled={!session || loading || operationBlocked}
            onClick={() => void createDraft()}
            variant="secondary"
          >
            新建草稿
          </Button>
          <Button
            aria-label="撤销"
            disabled={
              !videoEditors ||
              !currentDraft?.canUndo ||
              operationBlocked
            }
            onClick={() =>
              currentDraft &&
              void mutate(
                () =>
                  videoEditors!.undo(
                    currentDraft.draftId,
                    currentDraft.revision
                  ),
                '已撤销上一项编辑命令。'
              )
            }
            variant="ghost"
          >
            撤销
          </Button>
          <Button
            aria-label="重做"
            disabled={
              !videoEditors ||
              !currentDraft?.canRedo ||
              operationBlocked
            }
            onClick={() =>
              currentDraft &&
              void mutate(
                () =>
                  videoEditors!.redo(
                    currentDraft.draftId,
                    currentDraft.revision
                  ),
                '已重做上一项编辑命令。'
              )
            }
            variant="ghost"
          >
            重做
          </Button>
          <Button
            disabled={!videoEditors || !currentDraft || operationBlocked}
            onClick={() =>
              currentDraft &&
              void mutate(
                () =>
                  videoEditors!.copy(
                    currentDraft.draftId,
                    currentDraft.revision
                  ),
                '编辑草稿副本已创建；没有复制媒体文件或导出记录。'
              )
            }
            variant="secondary"
          >
            复制草稿
          </Button>
          <Button
            disabled={
              !currentDraft ||
              !hasLocalTitleChange ||
              !title.trim() ||
              busy
            }
            onClick={() => void commitTitle()}
          >
            保存草稿
          </Button>
          <Button disabled title="等待 B4 导出契约" variant="secondary">
            导出设置
          </Button>
          <Button disabled title="等待 B4 导出契约">
            导出视频
          </Button>
        </div>
      </header>

      <div className="uc-video-editor__workspace">
        <Card className="uc-video-editor__media-bin">
          <PanelHeading description="只显示当前草稿的真实素材事实。" title="素材与片段" />
          <div className="uc-video-editor__tabs" role="tablist">
            <button aria-selected="true" role="tab" type="button">
              当前时间线
            </button>
            <button
              aria-selected="false"
              disabled
              role="tab"
              title="等待 B2 项目素材端口"
              type="button"
            >
              项目素材
            </button>
          </div>
          <MediaList draft={currentDraft} loading={loading} session={session} />
          <Button disabled title="等待 B2 受控源文件端口" variant="secondary">
            添加视频素材
          </Button>
          <p className="uc-video-editor__hint">
            A1 不读取文件路径，也不创建代理、缩略图或导出任务。
          </p>
        </Card>

        <div className="uc-video-editor__center">
          <Card className="uc-video-editor__preview">
            <PanelHeading
              description={
                currentDraft
                  ? canvasLabel(currentDraft)
                  : '创建或打开草稿后显示真实画布意图。'
              }
              title="预览舞台"
            />
            <EmptyState
              description={
                currentDraft
                  ? 'B2 预览媒体端口尚未接入；这里不会显示示例视频或伪造画面。'
                  : '当前没有已打开的编辑草稿。'
              }
              icon="预"
              readOnly
              title={
                currentDraft ? '预览能力尚未接入' : '等待编辑草稿'
              }
            />
            <div className="uc-video-editor__transport">
              <Button disabled variant="ghost">上一帧</Button>
              <Button disabled variant="ghost">播放</Button>
              <Button disabled variant="ghost">下一帧</Button>
              <span>00:00.000 / 未知</span>
            </div>
          </Card>

          <Card className="uc-video-editor__timeline">
            <div className="uc-video-editor__timeline-heading">
              <PanelHeading
                description="所有编辑将在 A2 通过领域命令执行。"
                title="轻量单轨时间线"
              />
              <div className="uc-video-editor__timeline-actions">
                {['分割', '删除', '复制片段', '排序', '裁剪', '文字', '音乐'].map(
                  (label) => (
                    <Button
                      disabled
                      key={label}
                      title="等待 A2/A3 与 B2 端口"
                      variant="ghost"
                    >
                      {label}
                    </Button>
                  )
                )}
              </div>
            </div>
            <div className="uc-video-editor__ruler" aria-hidden="true">
              <span>00:00</span>
              <span>时间线由领域事实驱动</span>
              <span>结束</span>
            </div>
            <TimelineTrack
              items={
                currentDraft?.videoTrack.map((clip, index) => ({
                  id: clip.clipId,
                  label: `片段 ${index + 1}`
                })) ?? []
              }
              label="视频主轨"
            />
            <TimelineTrack
              items={
                currentDraft?.textTrack.map((text) => ({
                  id: text.textId,
                  label: text.content || '空文字层'
                })) ?? []
              }
              label="文字轨"
            />
            <TimelineTrack
              items={
                currentDraft?.backgroundMusic
                  ? [
                      {
                        id: currentDraft.backgroundMusic.fileId,
                        label: '背景音乐'
                      }
                    ]
                  : []
              }
              label="背景音乐"
            />
          </Card>
        </div>

        <Card className="uc-video-editor__inspector">
          <PanelHeading
            description="只展示 B1 草稿 DTO，不推测媒体能力。"
            title="属性面板"
          />
          <div className="uc-video-editor__tabs" role="tablist">
            {['片段', '画面', '声音', '文字'].map((label, index) => (
              <button
                aria-selected={index === 0}
                disabled
                key={label}
                role="tab"
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          {currentDraft ? (
            <>
              <label className="uc-video-editor__title-field">
                <span>草稿名称</span>
                <input
                  onBlur={() => void commitTitle()}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setSaveState('editing');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  value={title}
                />
              </label>
              <dl className="uc-video-editor__facts">
                <Fact label="Revision" value={String(currentDraft.revision)} />
                <Fact
                  label="来源"
                  value={sourceIntentLabel(currentDraft)}
                />
                <Fact
                  label="视频片段"
                  value={`${currentDraft.videoTrack.length} 个`}
                />
                <Fact
                  label="已移除片段"
                  value={`${currentDraft.removedClips.length} 个`}
                />
                <Fact
                  label="文字层"
                  value={`${currentDraft.textTrack.length} 个`}
                />
                <Fact
                  label="背景音乐"
                  value={currentDraft.backgroundMusic ? '已登记' : '无'}
                />
              </dl>
              <EmptyState
                description="A2 接入受控素材和领域命令后，才开放片段与画面属性。"
                icon="属"
                readOnly
                title="尚未选择片段"
              />
            </>
          ) : (
            <EmptyState
              description="打开草稿后显示真实 revision、来源与轨道事实。"
              icon="属"
              readOnly
              title="暂无可编辑属性"
            />
          )}
        </Card>
      </div>

      <Card className="uc-video-editor__status" role="status">
        <StatusPill tone={saveStateTones[saveState]}>
          {saveStateLabels[saveState]}
        </StatusPill>
        <span>
          草稿：{currentDraft ? '已打开' : '无'}
        </span>
        <span>
          源文件：{currentDraft ? '等待 B2 校验' : '无'}
        </span>
        <span>预览：尚未接入</span>
        <span>未导出修改：{currentDraft ? '有' : '无'}</span>
        {saveState === 'conflict' ? (
          <Button disabled={busy} onClick={() => void reloadDraft()} variant="secondary">
            重新载入
          </Button>
        ) : null}
      </Card>

      <p className="uc-video-editor__message" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

function MediaList({
  draft,
  loading,
  session
}: {
  readonly draft?: VideoEditorDraftDto;
  readonly loading: boolean;
  readonly session?: StorageProjectSessionDto;
}) {
  if (loading) {
    return (
      <EmptyState
        busy
        description="正在读取当前项目和编辑草稿。"
        icon="读"
        role="status"
        title="读取编辑工作区"
      />
    );
  }
  if (!session) {
    return (
      <EmptyState
        description="请先前往“项目”页面新建或打开项目。"
        icon="项"
        readOnly
        title="需要先打开项目"
      />
    );
  }
  if (!draft) {
    return (
      <EmptyState
        description="点击顶部“新建草稿”建立项目内空白 EditDraft。"
        icon="编"
        readOnly
        title="还没有编辑草稿"
      />
    );
  }
  if (draft.videoTrack.length === 0) {
    return (
      <EmptyState
        description="B1 草稿已就绪；A1 不伪造素材或时间线片段。"
        icon="材"
        readOnly
        title="当前时间线没有素材"
      />
    );
  }
  return (
    <ul className="uc-video-editor__media-list">
      {draft.videoTrack.map((clip, index) => (
        <li key={clip.clipId}>
          <span aria-hidden="true">视</span>
          <div>
            <strong>片段 {index + 1}</strong>
            <small>
              {clip.source.identity.container.toUpperCase()} ·{' '}
              {clip.source.identity.width}×{clip.source.identity.height}
            </small>
          </div>
          <StatusPill tone="neutral">已登记</StatusPill>
        </li>
      ))}
    </ul>
  );
}

function TimelineTrack({
  items,
  label
}: {
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly label: string;
}) {
  return (
    <div className="uc-video-editor__track">
      <strong>{label}</strong>
      <div>
        {items.length ? (
          items.map((item) => <span key={item.id}>{item.label}</span>)
        ) : (
          <small>暂无内容</small>
        )}
      </div>
    </div>
  );
}

function PanelHeading({
  description,
  title
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <header className="uc-video-editor__panel-heading">
      <h2>{title}</h2>
      <p>{description}</p>
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

function canvasLabel(draft: VideoEditorDraftDto): string {
  const aspectRatio =
    draft.canvas.aspectRatio.kind === 'source'
      ? '跟随源比例'
      : `${draft.canvas.aspectRatio.numerator}:${draft.canvas.aspectRatio.denominator}`;
  return `${aspectRatio} · ${draft.canvas.transformPolicy === 'fit' ? '适应画布' : '填满画布'}`;
}

function sourceIntentLabel(draft: VideoEditorDraftDto): string {
  switch (draft.sourceIntent.kind) {
    case 'blank':
      return '空白草稿';
    case 'from_work':
      return `视频作品 ${draft.sourceIntent.sourceWorkId}`;
    case 'from_video_draft':
      return `视频生成草稿 ${draft.sourceIntent.sourceDraftId}`;
  }
}

function sortDrafts(
  drafts: readonly VideoEditorDraftDto[]
): readonly VideoEditorDraftDto[] {
  return [...drafts].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}
