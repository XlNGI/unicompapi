import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../../components/StatusPill';
import type {
  StorageProjectSessionDto,
  StorageWorkSummaryDto
} from '../../../shared/storage-ipc';
import type {
  VideoEditorCanvasDto,
  VideoEditorClipDto,
  VideoEditorDraftDto,
  VideoEditorIpcErrorCode,
  VideoEditorIpcResult,
  VideoEditorSourcePreviewDto,
  VideoEditorSourceRegistrationStrategyDto,
  VideoEditorSourceStatusDto,
  VideoEditorUpdateDto
} from '../../../shared/video-editor-ipc';
import '../../../styles/pages.css';
import { videoCreationModes } from '../creationModes';

const mode = videoCreationModes[3];

const errorMessages: Partial<Record<VideoEditorIpcErrorCode, string>> = {
  project_not_open: '请先在“项目”页面新建或打开一个项目。',
  invalid_request: '编辑请求无效，当前草稿没有被修改。',
  draft_not_found: '该编辑草稿已不存在，请重新选择。',
  draft_conflict: '草稿已在其他操作中更新，请重新载入后继续。',
  source_not_found: '来源作品或视频草稿已不可用，源文件也可能不存在。',
  source_invalid: '来源不属于当前项目或不是可用视频。',
  clip_not_found: '所选片段已不存在，请重新选择。',
  work_not_found: '所选视频作品已不存在或不属于当前项目。',
  source_unavailable: '源文件当前不可用，请检查文件状态。',
  source_changed: '源文件内容已经变化，请重新定位并确认。',
  unsupported_video: '当前只支持经过内容校验的 MP4 或 MOV 视频。',
  media_unreadable: '无法读取所选视频，请检查文件后重试。',
  managed_copy_failed: '视频未能安全复制到项目，请检查存储空间。',
  relink_token_invalid: '重新定位确认已经失效，请重新选择文件。',
  relink_mismatch_confirmation_required: '候选文件与原文件不同，需要明确确认。',
  relink_candidate_too_short: '候选视频太短，无法覆盖当前片段的裁剪范围。',
  preview_unavailable: '原片预览不可用，请先恢复源文件。',
  adapter_unavailable: '预览代理引擎尚未审批，当前只能使用受控原片预览。',
  nothing_to_undo: '当前没有可撤销的操作。',
  nothing_to_redo: '当前没有可重做的操作。',
  workspace_storage_error: '草稿未能写入项目，请检查存储后继续。'
};

type EditorError = Extract<
  VideoEditorIpcResult<unknown>,
  { readonly ok: false }
>['error'];
type SaveState = 'saved' | 'editing' | 'saving' | 'failed' | 'conflict';
type MediaTab = 'timeline' | 'project';
type InspectorTab = 'clip' | 'canvas';

interface TimelineSegment {
  readonly clipId: string;
  readonly index: number;
  readonly startUs: number;
  readonly endUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  readonly speedNumerator: number;
  readonly speedDenominator: number;
}

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [drafts, setDrafts] = useState<readonly VideoEditorDraftDto[]>([]);
  const [currentDraft, setCurrentDraft] = useState<VideoEditorDraftDto>();
  const [videoWorks, setVideoWorks] = useState<readonly StorageWorkSummaryDto[]>([]);
  const [selectedWorkId, setSelectedWorkId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [sourceStatuses, setSourceStatuses] = useState<
    Readonly<Record<string, VideoEditorSourceStatusDto>>
  >({});
  const [preview, setPreview] = useState<VideoEditorSourcePreviewDto>();
  const [playheadUs, setPlayheadUs] = useState(0);
  const [title, setTitle] = useState('');
  const [mediaTab, setMediaTab] = useState<MediaTab>('timeline');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('clip');
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

      const [listResult, worksResult] = await Promise.all([
        videoEditors.list(),
        storage.listWorks()
      ]);
      if (!active) return;
      setLoading(false);
      if (!listResult.ok) {
        setMessage(errorMessage(listResult.error.code, '读取编辑草稿失败，请重试。'));
        return;
      }
      if (worksResult.ok) {
        const works = worksResult.value.items.filter(
          (work) =>
            work.projectId === sessionResult.value?.projectId &&
            work.mediaKind === 'video'
        );
        setVideoWorks(works);
        setSelectedWorkId(works[0]?.workId ?? '');
      }
      const sorted = sortDrafts(listResult.value);
      setDrafts(sorted);
      acceptDraft(sorted[0]);
    }

    void load().catch(() => {
      if (active) {
        setLoading(false);
        setMessage('读取基础编辑工作区失败，请重试。');
      }
    });
    return () => {
      active = false;
    };
  }, [storage, videoEditors]);

  useEffect(() => {
    let active = true;
    if (!videoEditors || !currentDraft || currentDraft.videoTrack.length === 0) {
      setSourceStatuses({});
      return () => {
        active = false;
      };
    }
    void Promise.all(
      currentDraft.videoTrack.map(async (clip) => {
        const result = await videoEditors.getSourceStatus(
          currentDraft.draftId,
          clip.clipId
        );
        return result.ok ? result.value : undefined;
      })
    ).then((statuses) => {
      if (!active) return;
      setSourceStatuses(
        Object.fromEntries(
          statuses
            .filter((status): status is VideoEditorSourceStatusDto => Boolean(status))
            .map((status) => [status.clipId, status])
        )
      );
    });
    return () => {
      active = false;
    };
  }, [currentDraft, videoEditors]);

  function acceptDraft(draft?: VideoEditorDraftDto, preferredClipId?: string) {
    setCurrentDraft(draft);
    setTitle(draft?.title ?? '');
    setSaveState('saved');
    setPreview(undefined);
    const nextClipId =
      preferredClipId &&
      draft?.videoTrack.some((clip) => clip.clipId === preferredClipId)
        ? preferredClipId
        : draft?.videoTrack[0]?.clipId ?? '';
    setSelectedClipId(nextClipId);
    setPlayheadUs(
      buildTimelineSegments(draft?.videoTrack ?? []).find(
        (segment) => segment.clipId === nextClipId
      )?.startUs ?? 0
    );
    if (!draft) return;
    setDrafts((items) =>
      sortDrafts(
        items.some((item) => item.draftId === draft.draftId)
          ? items.map((item) => (item.draftId === draft.draftId ? draft : item))
          : [...items, draft]
      )
    );
  }

  function handleError(error: EditorError) {
    if (error.recoverableDraft) {
      acceptDraft(error.recoverableDraft, selectedClipId);
      setSaveState('failed');
      setMessage(
        '修改仍保留在本机内存中，但尚未写入项目；继续编辑时会再次尝试保存。'
      );
      return;
    }
    setSaveState(error.code === 'draft_conflict' ? 'conflict' : 'saved');
    setMessage(errorMessage(error.code, '本地编辑操作未完成，请重试。'));
  }

  async function mutate(
    operation: () => Promise<VideoEditorIpcResult<VideoEditorDraftDto>>,
    successMessage: string,
    preferredClipId = selectedClipId
  ) {
    if (busy) return;
    setBusy(true);
    setSaveState('saving');
    setMessage('');
    try {
      const result = await operation();
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      acceptDraft(result.value, preferredClipId);
      setMessage(successMessage);
    } catch {
      setSaveState('failed');
      setMessage('本地编辑操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(command: VideoEditorUpdateDto, successMessage: string) {
    if (!videoEditors || !currentDraft) return;
    await mutate(
      () =>
        videoEditors.update(currentDraft.draftId, currentDraft.revision, command),
      successMessage
    );
  }

  async function createDraft() {
    if (!videoEditors || !session) return;
    await mutate(
      () => videoEditors.create({ kind: 'blank' }),
      '空白编辑草稿已创建；没有导入素材，也没有创建导出任务。',
      ''
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
        setMessage(errorMessage('draft_not_found', '编辑草稿已不存在。'));
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
    await runCommand(
      { kind: 'set_title', title: nextTitle },
      '草稿名称已自动保存。'
    );
  }

  async function selectSource(strategy: VideoEditorSourceRegistrationStrategyDto) {
    if (!videoEditors || !currentDraft || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoEditors.selectSource(
        currentDraft.draftId,
        currentDraft.revision,
        strategy
      );
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      if (result.value.cancelled) {
        setMessage('已取消选择视频，没有修改草稿。');
        return;
      }
      acceptDraft(result.value.draft, result.value.source?.clipId);
      setMediaTab('timeline');
      setMessage(
        strategy === 'managed_project_copy'
          ? '视频已校验并安全复制到当前项目。'
          : '视频已作为授权外部引用加入时间线。'
      );
    } catch {
      setMessage('选择视频失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function attachWork() {
    if (!videoEditors || !currentDraft || !selectedWorkId || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoEditors.attachWork(
        currentDraft.draftId,
        currentDraft.revision,
        selectedWorkId
      );
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      acceptDraft(result.value.draft, result.value.source?.clipId);
      setMediaTab('timeline');
      setMessage('项目视频作品已加入当前时间线，没有复制或覆盖原作品。');
    } catch {
      setMessage('添加项目视频作品失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function relinkSource(clipId: string) {
    if (!videoEditors || !currentDraft || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const prepared = await videoEditors.prepareRelink(
        currentDraft.draftId,
        clipId
      );
      if (!prepared.ok) {
        handleError(prepared.error);
        return;
      }
      if (prepared.value.cancelled) {
        setMessage('已取消重新定位，没有修改草稿。');
        return;
      }
      if (!prepared.value.token) {
        setMessage('重新定位确认句柄不可用，请重新选择文件。');
        return;
      }
      const acceptMismatch =
        prepared.value.matchesIdentity === false &&
        window.confirm(
          `候选视频与原文件不同：${relinkDifferenceLabel(prepared.value.differences)}。确认后将替换当前片段来源，仍可撤销。`
        );
      if (prepared.value.matchesIdentity === false && !acceptMismatch) {
        setMessage('未确认不匹配文件，草稿保持不变。');
        return;
      }
      const confirmed = await videoEditors.confirmRelink(
        currentDraft.draftId,
        clipId,
        prepared.value.token,
        acceptMismatch
      );
      if (!confirmed.ok) {
        handleError(confirmed.error);
        return;
      }
      acceptDraft(confirmed.value.draft, clipId);
      setMessage('片段源文件已重新定位；该修改可撤销。');
    } catch {
      setMessage('重新定位失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    if (!videoEditors || !currentDraft || !selectedClipId || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoEditors.createSourcePreview(
        currentDraft.draftId,
        selectedClipId
      );
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      setPreview(result.value);
      setMessage('已创建经过重新校验的短期原片预览。');
    } catch {
      setMessage('加载原片预览失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function requestProxy() {
    if (!videoEditors || !currentDraft || !selectedClipId || busy) return;
    setBusy(true);
    setMessage('正在检查预览代理缓存…');
    try {
      const result = await videoEditors.requestPreviewArtifact(
        currentDraft.draftId,
        selectedClipId,
        'proxy_video'
      );
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      setMessage('预览代理缓存已就绪。');
    } catch {
      setMessage('检查预览代理失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clearPreviewCache() {
    if (!videoEditors || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await videoEditors.clearPreviewCache();
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      setMessage('可重建的预览缓存已清除，草稿和源文件没有改变。');
    } catch {
      setMessage('清除预览缓存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const segments = buildTimelineSegments(currentDraft?.videoTrack ?? []);
  const totalDurationUs = segments.at(-1)?.endUs ?? 0;
  const selectedClip = currentDraft?.videoTrack.find(
    (clip) => clip.clipId === selectedClipId
  );
  const selectedSegment = segments.find(
    (segment) => segment.clipId === selectedClipId
  );
  const selectedIndex = selectedSegment?.index ?? -1;
  const hasLocalTitleChange =
    Boolean(currentDraft) && title.trim() !== currentDraft?.title;
  const operationBlocked = busy || hasLocalTitleChange;

  function selectClip(clipId: string) {
    setSelectedClipId(clipId);
    setPreview(undefined);
    setPlayheadUs(
      segments.find((segment) => segment.clipId === clipId)?.startUs ?? 0
    );
    setInspectorTab('clip');
  }

  function seekTimeline(nextUs: number) {
    setPlayheadUs(nextUs);
    if (!selectedClip || !selectedSegment || !videoRef.current) return;
    if (nextUs < selectedSegment.startUs || nextUs > selectedSegment.endUs) return;
    const timelineOffset = nextUs - selectedSegment.startUs;
    const sourceOffset = Number(
      (BigInt(timelineOffset) * BigInt(selectedSegment.speedNumerator)) /
        BigInt(selectedSegment.speedDenominator)
    );
    videoRef.current.currentTime =
      (selectedSegment.sourceInUs + sourceOffset) / 1_000_000;
  }

  function syncPlayheadFromPreview() {
    if (!videoRef.current || !selectedClip || !selectedSegment) return;
    const sourceUs = Math.min(
      selectedClip.sourceRange.outUs,
      Math.max(
        selectedClip.sourceRange.inUs,
        Math.round(videoRef.current.currentTime * 1_000_000)
      )
    );
    if (sourceUs === selectedClip.sourceRange.outUs) {
      videoRef.current.pause();
      videoRef.current.currentTime = sourceUs / 1_000_000;
    }
    const sourceOffset = sourceUs - selectedSegment.sourceInUs;
    const timelineOffset = Number(
      (BigInt(sourceOffset) * BigInt(selectedSegment.speedDenominator)) /
        BigInt(selectedSegment.speedNumerator)
    );
    setPlayheadUs(
      Math.min(selectedSegment.endUs, selectedSegment.startUs + timelineOffset)
    );
  }

  return (
    <section className="uc-video-editor" aria-labelledby={`${mode.id}-title`}>
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
                disabled={!session || loading || operationBlocked || drafts.length === 0}
                onChange={(event) => void openDraft(event.target.value)}
                value={currentDraft?.draftId ?? ''}
              >
                {drafts.length === 0 ? <option value="">暂无编辑草稿</option> : null}
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
            disabled={!videoEditors || !currentDraft?.canUndo || operationBlocked}
            onClick={() =>
              currentDraft &&
              void mutate(
                () => videoEditors!.undo(currentDraft.draftId, currentDraft.revision),
                '已撤销上一项编辑命令。'
              )
            }
            variant="ghost"
          >
            撤销
          </Button>
          <Button
            disabled={!videoEditors || !currentDraft?.canRedo || operationBlocked}
            onClick={() =>
              currentDraft &&
              void mutate(
                () => videoEditors!.redo(currentDraft.draftId, currentDraft.revision),
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
                  videoEditors!.copy(currentDraft.draftId, currentDraft.revision),
                '编辑草稿副本已创建；没有复制媒体文件或导出记录。'
              )
            }
            variant="secondary"
          >
            复制草稿
          </Button>
          <Button
            disabled={!currentDraft || !hasLocalTitleChange || !title.trim() || busy}
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
          <PanelHeading
            description="素材只通过 B2 受控端口登记，不读取 renderer 路径。"
            title="素材与片段"
          />
          <div className="uc-video-editor__tabs" role="tablist">
            <button
              aria-selected={mediaTab === 'timeline'}
              onClick={() => setMediaTab('timeline')}
              role="tab"
              type="button"
            >
              当前时间线
            </button>
            <button
              aria-selected={mediaTab === 'project'}
              disabled={!currentDraft}
              onClick={() => setMediaTab('project')}
              role="tab"
              type="button"
            >
              项目素材
            </button>
          </div>
          {mediaTab === 'timeline' ? (
            <MediaList
              draft={currentDraft}
              loading={loading}
              onRelink={(clipId) => void relinkSource(clipId)}
              onSelect={selectClip}
              selectedClipId={selectedClipId}
              session={session}
              statuses={sourceStatuses}
            />
          ) : (
            <ProjectVideoList
              onSelect={setSelectedWorkId}
              selectedWorkId={selectedWorkId}
              works={videoWorks}
            />
          )}
          {mediaTab === 'timeline' ? (
            <div className="uc-video-editor__source-actions">
              <Button
                disabled={!currentDraft || operationBlocked}
                onClick={() => void selectSource('external_reference')}
                variant="secondary"
              >
                引用本机视频
              </Button>
              <Button
                disabled={!currentDraft || operationBlocked}
                onClick={() => void selectSource('managed_project_copy')}
                variant="secondary"
              >
                复制到项目
              </Button>
            </div>
          ) : (
            <Button
              disabled={!currentDraft || !selectedWorkId || operationBlocked}
              onClick={() => void attachWork()}
              variant="secondary"
            >
              添加所选作品
            </Button>
          )}
          <p className="uc-video-editor__hint">
            导入只登记或复制视频并追加片段，不上传、不调用在线 AI、不创建任务。
          </p>
        </Card>

        <div className="uc-video-editor__center">
          <Card className="uc-video-editor__preview">
            <PanelHeading
              description={
                currentDraft
                  ? `${canvasLabel(currentDraft)} · ${selectedClip ? '当前片段已选择' : '请选择片段'}`
                  : '创建或打开草稿后显示真实画布意图。'
              }
              title="预览舞台"
            />
            {preview ? (
              <video
                className="uc-video-editor__video"
                controls
                key={preview.url}
                onLoadedMetadata={() => {
                  if (videoRef.current && selectedClip) {
                    videoRef.current.currentTime =
                      selectedClip.sourceRange.inUs / 1_000_000;
                  }
                }}
                onTimeUpdate={syncPlayheadFromPreview}
                ref={videoRef}
                src={preview.url}
              />
            ) : (
              <EmptyState
                description={
                  selectedClip
                    ? '点击“加载原片预览”后，主进程会重新校验源文件并返回短期句柄。'
                    : '当前没有已选择的视频片段。'
                }
                icon="预"
                readOnly
                title={selectedClip ? '等待加载受控预览' : '等待视频片段'}
              />
            )}
            <div className="uc-video-editor__transport">
              <Button
                disabled={!selectedClip || busy}
                onClick={() => void loadPreview()}
                variant="secondary"
              >
                加载原片预览
              </Button>
              <Button
                disabled={!selectedClip || busy}
                onClick={() => void requestProxy()}
                variant="ghost"
              >
                检查预览代理
              </Button>
              <span>
                {formatTime(playheadUs)} / {formatTime(totalDurationUs)}
              </span>
            </div>
          </Card>

          <Card className="uc-video-editor__timeline">
            <div className="uc-video-editor__timeline-heading">
              <PanelHeading
                description="片段起点由顺序、裁剪、速度和转场实时计算，不另存第二份事实。"
                title="轻量单轨时间线"
              />
              <div className="uc-video-editor__timeline-actions">
                <Button
                  disabled={
                    !selectedClip ||
                    !selectedSegment ||
                    playheadUs <= selectedSegment.startUs ||
                    playheadUs >= selectedSegment.endUs ||
                    operationBlocked
                  }
                  onClick={() => {
                    if (!selectedClip || !selectedSegment) return;
                    const timelineOffset = playheadUs - selectedSegment.startUs;
                    const sourceOffset = Number(
                      (BigInt(timelineOffset) *
                        BigInt(selectedSegment.speedNumerator)) /
                        BigInt(selectedSegment.speedDenominator)
                    );
                    void runCommand(
                      {
                        kind: 'split_clip',
                        clipId: selectedClip.clipId,
                        atSourceUs: selectedClip.sourceRange.inUs + sourceOffset
                      },
                      '已在播放头位置分割片段。'
                    );
                  }}
                  variant="ghost"
                >
                  分割
                </Button>
                <Button
                  disabled={!selectedClip || operationBlocked}
                  onClick={() =>
                    selectedClip &&
                    void runCommand(
                      { kind: 'remove_clip', clipId: selectedClip.clipId },
                      '片段已从主轨移除，源文件没有删除。'
                    )
                  }
                  variant="ghost"
                >
                  删除
                </Button>
                <Button
                  disabled={!selectedClip || operationBlocked}
                  onClick={() =>
                    selectedClip &&
                    void runCommand(
                      { kind: 'duplicate_clip', clipId: selectedClip.clipId },
                      '片段已复制到主轨。'
                    )
                  }
                  variant="ghost"
                >
                  复制片段
                </Button>
                <Button
                  disabled={selectedIndex <= 0 || operationBlocked}
                  onClick={() =>
                    selectedClip &&
                    void runCommand(
                      {
                        kind: 'move_clip',
                        clipId: selectedClip.clipId,
                        toIndex: selectedIndex - 1
                      },
                      '片段已向前移动。'
                    )
                  }
                  variant="ghost"
                >
                  左移
                </Button>
                <Button
                  disabled={
                    selectedIndex < 0 ||
                    selectedIndex >= (currentDraft?.videoTrack.length ?? 0) - 1 ||
                    operationBlocked
                  }
                  onClick={() =>
                    selectedClip &&
                    void runCommand(
                      {
                        kind: 'move_clip',
                        clipId: selectedClip.clipId,
                        toIndex: selectedIndex + 1
                      },
                      '片段已向后移动。'
                    )
                  }
                  variant="ghost"
                >
                  右移
                </Button>
                <Button
                  disabled={!currentDraft?.removedClips.length || operationBlocked}
                  onClick={() => {
                    const removed = currentDraft?.removedClips.at(-1);
                    if (!removed) return;
                    void runCommand(
                      {
                        kind: 'restore_clip',
                        clipId: removed.clip.clipId,
                        targetIndex: Math.min(
                          removed.previousIndex,
                          currentDraft?.videoTrack.length ?? 0
                        )
                      },
                      '最近删除的片段已恢复。'
                    );
                  }}
                  variant="ghost"
                >
                  恢复删除
                </Button>
                <Button disabled title="等待 A3" variant="ghost">
                  文字
                </Button>
                <Button disabled title="等待 A3" variant="ghost">
                  音乐
                </Button>
              </div>
            </div>
            <div className="uc-video-editor__ruler" aria-hidden="true">
              <span>00:00.000</span>
              <span>{segments.length} 个片段</span>
              <span>{formatTime(totalDurationUs)}</span>
            </div>
            <input
              aria-label="时间线播放头"
              className="uc-video-editor__playhead"
              disabled={totalDurationUs === 0}
              max={Math.max(1, totalDurationUs)}
              min="0"
              onChange={(event) => seekTimeline(Number(event.target.value))}
              step="1000"
              type="range"
              value={Math.min(playheadUs, Math.max(1, totalDurationUs))}
            />
            <VideoTimelineTrack
              onSelect={selectClip}
              segments={segments}
              selectedClipId={selectedClipId}
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
                  ? [{ id: currentDraft.backgroundMusic.fileId, label: '背景音乐' }]
                  : []
              }
              label="背景音乐"
            />
          </Card>
        </div>

        <Card className="uc-video-editor__inspector">
          <PanelHeading
            description="表单只提交领域命令；成功 DTO 是唯一持久化事实。"
            title="属性面板"
          />
          <div className="uc-video-editor__tabs" role="tablist">
            <button
              aria-selected={inspectorTab === 'clip'}
              onClick={() => setInspectorTab('clip')}
              role="tab"
              type="button"
            >
              片段
            </button>
            <button
              aria-selected={inspectorTab === 'canvas'}
              disabled={!currentDraft}
              onClick={() => setInspectorTab('canvas')}
              role="tab"
              type="button"
            >
              画面
            </button>
            <button disabled role="tab" title="等待 A3" type="button">
              声音
            </button>
            <button disabled role="tab" title="等待 A3" type="button">
              文字
            </button>
          </div>
          <label className="uc-video-editor__title-field">
            <span>草稿名称</span>
            <input
              disabled={!currentDraft}
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
          {inspectorTab === 'clip' ? (
            selectedClip ? (
              <ClipInspector
                busy={operationBlocked}
                clip={selectedClip}
                onCommand={(command, successMessage) =>
                  void runCommand(command, successMessage)
                }
                onInvalid={setMessage}
                onRelink={() => void relinkSource(selectedClip.clipId)}
                status={sourceStatuses[selectedClip.clipId]}
              />
            ) : (
              <EmptyState
                description="从素材区或视频主轨选择一个片段。"
                icon="属"
                readOnly
                title="尚未选择片段"
              />
            )
          ) : currentDraft ? (
            <CanvasInspector
              busy={operationBlocked}
              canvas={currentDraft.canvas}
              onCommand={(canvas) =>
                void runCommand(
                  { kind: 'set_canvas', canvas },
                  '画布设置已保存。'
                )
              }
              onInvalid={setMessage}
              sourceClip={currentDraft.videoTrack[0]}
            />
          ) : (
            <EmptyState
              description="打开草稿后才能编辑画布。"
              icon="画"
              readOnly
              title="暂无画布设置"
            />
          )}
        </Card>
      </div>

      <Card className="uc-video-editor__status" role="status">
        <StatusPill tone={saveStateTones[saveState]}>
          {saveStateLabels[saveState]}
        </StatusPill>
        <span>草稿：{currentDraft ? `revision ${currentDraft.revision}` : '无'}</span>
        <span>
          源文件：
          {currentDraft
            ? sourceSummary(currentDraft, sourceStatuses)
            : '无'}
        </span>
        <span>预览：{preview ? '原片就绪' : '未加载'}</span>
        <span>时间线：{formatTime(totalDurationUs)}</span>
        <Button
          disabled={!currentDraft || busy}
          onClick={() => void clearPreviewCache()}
          variant="ghost"
        >
          清除预览缓存
        </Button>
        {saveState === 'conflict' ? (
          <Button
            disabled={busy}
            onClick={() =>
              currentDraft && void openDraft(currentDraft.draftId)
            }
            variant="secondary"
          >
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
  onRelink,
  onSelect,
  selectedClipId,
  session,
  statuses
}: {
  readonly draft?: VideoEditorDraftDto;
  readonly loading: boolean;
  readonly onRelink: (clipId: string) => void;
  readonly onSelect: (clipId: string) => void;
  readonly selectedClipId: string;
  readonly session?: StorageProjectSessionDto;
  readonly statuses: Readonly<Record<string, VideoEditorSourceStatusDto>>;
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
        description="使用下面的受控入口添加本机视频或项目视频作品。"
        icon="材"
        readOnly
        title="当前时间线没有素材"
      />
    );
  }
  return (
    <ul className="uc-video-editor__media-list">
      {draft.videoTrack.map((clip, index) => {
        const status = statuses[clip.clipId];
        const display = sourceStatusDisplay(status);
        return (
          <li
            className={
              selectedClipId === clip.clipId
                ? 'uc-video-editor__media-item--selected'
                : undefined
            }
            key={clip.clipId}
          >
            <button
              className="uc-video-editor__media-select"
              onClick={() => onSelect(clip.clipId)}
              type="button"
            >
              <span aria-hidden="true">视</span>
              <span>
                <strong>片段 {index + 1}</strong>
                <small>
                  {clip.source.identity.container.toUpperCase()} ·{' '}
                  {clip.source.identity.width}×{clip.source.identity.height} ·{' '}
                  {formatTime(effectiveClipDurationUs(clip))}
                </small>
              </span>
            </button>
            <StatusPill tone={display.tone}>{display.label}</StatusPill>
            {status?.relinkRequired ? (
              <Button onClick={() => onRelink(clip.clipId)} variant="ghost">
                重新定位
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ProjectVideoList({
  onSelect,
  selectedWorkId,
  works
}: {
  readonly onSelect: (workId: string) => void;
  readonly selectedWorkId: string;
  readonly works: readonly StorageWorkSummaryDto[];
}) {
  if (works.length === 0) {
    return (
      <EmptyState
        description="当前项目还没有已登记的视频作品。"
        icon="作"
        readOnly
        title="暂无项目视频作品"
      />
    );
  }
  return (
    <div className="uc-video-editor__project-works">
      {works.map((work) => (
        <button
          aria-pressed={selectedWorkId === work.workId}
          key={work.workId}
          onClick={() => onSelect(work.workId)}
          type="button"
        >
          <strong>{work.name}</strong>
          <small>{work.fileState === 'available' ? '本地可用' : work.fileState}</small>
        </button>
      ))}
    </div>
  );
}

function VideoTimelineTrack({
  onSelect,
  segments,
  selectedClipId
}: {
  readonly onSelect: (clipId: string) => void;
  readonly segments: readonly TimelineSegment[];
  readonly selectedClipId: string;
}) {
  return (
    <div className="uc-video-editor__track">
      <strong>视频主轨</strong>
      <div>
        {segments.length ? (
          segments.map((segment) => (
            <button
              aria-pressed={selectedClipId === segment.clipId}
              key={segment.clipId}
              onClick={() => onSelect(segment.clipId)}
              style={{ flexGrow: Math.max(1, segment.durationUs) }}
              type="button"
            >
              <strong>{segment.index + 1}</strong>
              <small>{formatTime(segment.durationUs)}</small>
            </button>
          ))
        ) : (
          <small>暂无内容</small>
        )}
      </div>
    </div>
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

function ClipInspector({
  busy,
  clip,
  onCommand,
  onInvalid,
  onRelink,
  status
}: {
  readonly busy: boolean;
  readonly clip: VideoEditorClipDto;
  readonly onCommand: (command: VideoEditorUpdateDto, message: string) => void;
  readonly onInvalid: (message: string) => void;
  readonly onRelink: () => void;
  readonly status?: VideoEditorSourceStatusDto;
}) {
  function submitTrim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const startUs = millisecondsToUs(formNumber(form, 'trimStartMs'));
    const endUs = millisecondsToUs(formNumber(form, 'trimEndMs'));
    if (
      !Number.isSafeInteger(startUs) ||
      !Number.isSafeInteger(endUs) ||
      startUs < 0 ||
      endUs <= startUs
    ) {
      onInvalid('裁剪范围无效：结束时间必须大于开始时间。');
      return;
    }
    onCommand(
      {
        kind: 'trim_clip',
        clipId: clip.clipId,
        sourceRange: { inUs: startUs, outUs: endUs }
      },
      '片段裁剪范围已保存。'
    );
  }

  function submitSpeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const percent = Math.round(formNumber(event.currentTarget, 'speedPercent'));
    if (!Number.isSafeInteger(percent) || percent <= 0) {
      onInvalid('速度必须是大于 0 的整数百分比。');
      return;
    }
    onCommand(
      {
        kind: 'set_clip_speed',
        clipId: clip.clipId,
        speed: { numerator: percent, denominator: 100 }
      },
      '片段速度已保存。'
    );
  }

  function submitTransform(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const cropEnabled = new FormData(form).has('cropEnabled');
    const transform = {
      scalePermille: percentToPermille(formNumber(form, 'scalePercent')),
      positionXPermille: percentToPermille(formNumber(form, 'positionXPercent')),
      positionYPermille: percentToPermille(formNumber(form, 'positionYPercent')),
      rotationMilliDegrees: Math.round(formNumber(form, 'rotationDegrees') * 1000),
      flipX: new FormData(form).has('flipX'),
      flipY: new FormData(form).has('flipY'),
      crop: cropEnabled
        ? {
            xPermille: percentToPermille(formNumber(form, 'cropXPercent')),
            yPermille: percentToPermille(formNumber(form, 'cropYPercent')),
            widthPermille: percentToPermille(formNumber(form, 'cropWidthPercent')),
            heightPermille: percentToPermille(formNumber(form, 'cropHeightPercent'))
          }
        : null
    };
    if (
      !Object.values(transform)
        .filter((value) => typeof value === 'number')
        .every(Number.isSafeInteger)
    ) {
      onInvalid('画面变换包含无效数值。');
      return;
    }
    onCommand(
      { kind: 'set_clip_transform', clipId: clip.clipId, transform },
      '片段画面变换已保存。'
    );
  }

  const display = sourceStatusDisplay(status);
  return (
    <div className="uc-video-editor__inspector-content">
      <dl className="uc-video-editor__facts">
        <Fact label="源状态" value={display.label} />
        <Fact
          label="来源方式"
          value={status ? referenceKindLabel(status.referenceKind) : '检查中'}
        />
        <Fact
          label="源时长"
          value={formatTime(clip.source.identity.durationUs)}
        />
        <Fact
          label="当前时长"
          value={formatTime(effectiveClipDurationUs(clip))}
        />
      </dl>
      {status?.issues.length ? (
        <p className="uc-video-editor__source-issue">
          {status.issues.join('；')}
        </p>
      ) : null}
      {status?.relinkRequired ? (
        <Button disabled={busy} onClick={onRelink} variant="secondary">
          重新定位源文件
        </Button>
      ) : null}

      <form className="uc-video-editor__form" key={`trim-${clip.clipId}-${clip.sourceRange.inUs}`} onSubmit={submitTrim}>
        <h3>裁剪</h3>
        <label>
          开始（毫秒）
          <input
            defaultValue={clip.sourceRange.inUs / 1000}
            min="0"
            name="trimStartMs"
            step="1"
            type="number"
          />
        </label>
        <label>
          结束（毫秒）
          <input
            defaultValue={clip.sourceRange.outUs / 1000}
            min="1"
            name="trimEndMs"
            step="1"
            type="number"
          />
        </label>
        <Button disabled={busy} type="submit">保存裁剪</Button>
      </form>

      <form className="uc-video-editor__form" key={`speed-${clip.clipId}-${clip.speed.numerator}`} onSubmit={submitSpeed}>
        <h3>速度</h3>
        <label>
          速度百分比
          <input
            defaultValue={(clip.speed.numerator / clip.speed.denominator) * 100}
            min="1"
            name="speedPercent"
            step="1"
            type="number"
          />
        </label>
        <Button disabled={busy} type="submit">保存速度</Button>
      </form>

      <form className="uc-video-editor__form" key={`transform-${clip.clipId}-${JSON.stringify(clip.transform)}`} onSubmit={submitTransform}>
        <h3>画面变换</h3>
        <label>缩放（%）<input defaultValue={clip.transform.scalePermille / 10} min="0.1" name="scalePercent" step="0.1" type="number" /></label>
        <label>水平位置（%）<input defaultValue={clip.transform.positionXPermille / 10} name="positionXPercent" step="0.1" type="number" /></label>
        <label>垂直位置（%）<input defaultValue={clip.transform.positionYPermille / 10} name="positionYPercent" step="0.1" type="number" /></label>
        <label>旋转（度）<input defaultValue={clip.transform.rotationMilliDegrees / 1000} name="rotationDegrees" step="0.001" type="number" /></label>
        <label className="uc-video-editor__check"><input defaultChecked={clip.transform.flipX} name="flipX" type="checkbox" />水平翻转</label>
        <label className="uc-video-editor__check"><input defaultChecked={clip.transform.flipY} name="flipY" type="checkbox" />垂直翻转</label>
        <label className="uc-video-editor__check"><input defaultChecked={clip.transform.crop !== null} name="cropEnabled" type="checkbox" />启用裁切</label>
        <label>裁切 X（%）<input defaultValue={(clip.transform.crop?.xPermille ?? 0) / 10} min="0" name="cropXPercent" step="0.1" type="number" /></label>
        <label>裁切 Y（%）<input defaultValue={(clip.transform.crop?.yPermille ?? 0) / 10} min="0" name="cropYPercent" step="0.1" type="number" /></label>
        <label>裁切宽度（%）<input defaultValue={(clip.transform.crop?.widthPermille ?? 1000) / 10} min="0.1" name="cropWidthPercent" step="0.1" type="number" /></label>
        <label>裁切高度（%）<input defaultValue={(clip.transform.crop?.heightPermille ?? 1000) / 10} min="0.1" name="cropHeightPercent" step="0.1" type="number" /></label>
        <Button disabled={busy} type="submit">保存画面变换</Button>
      </form>

      <label className="uc-video-editor__disabled-field">
        基础转场
        <select disabled>
          <option>无转场（媒体引擎尚未审批）</option>
        </select>
      </label>
    </div>
  );
}

function CanvasInspector({
  busy,
  canvas,
  onCommand,
  onInvalid,
  sourceClip
}: {
  readonly busy: boolean;
  readonly canvas: VideoEditorCanvasDto;
  readonly onCommand: (canvas: VideoEditorCanvasDto) => void;
  readonly onInvalid: (message: string) => void;
  readonly sourceClip?: VideoEditorClipDto;
}) {
  const sourceRatio = reducedRatio(
    sourceClip?.source.identity.width ?? 1,
    sourceClip?.source.identity.height ?? 1
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ratioKind = data.get('ratioKind');
    const numerator = Math.round(formNumber(form, 'ratioNumerator'));
    const denominator = Math.round(formNumber(form, 'ratioDenominator'));
    const strengthPermille = percentToPermille(
      formNumber(form, 'blurStrengthPercent')
    );
    if (
      ratioKind === 'ratio' &&
      (!Number.isSafeInteger(numerator) ||
        !Number.isSafeInteger(denominator) ||
        numerator <= 0 ||
        denominator <= 0)
    ) {
      onInvalid('自定义画布比例必须是两个正整数。');
      return;
    }
    onCommand({
      aspectRatio:
        ratioKind === 'ratio'
          ? { kind: 'ratio', numerator, denominator }
          : { kind: 'source' },
      transformPolicy: data.get('transformPolicy') === 'fill' ? 'fill' : 'fit',
      background:
        data.get('backgroundKind') === 'blur_source'
          ? { kind: 'blur_source', strengthPermille }
          : { kind: 'solid', color: String(data.get('backgroundColor')) }
    });
  }

  const ratio =
    canvas.aspectRatio.kind === 'ratio'
      ? canvas.aspectRatio
      : { kind: 'ratio' as const, ...sourceRatio };
  return (
    <form
      className="uc-video-editor__form"
      key={JSON.stringify(canvas)}
      onSubmit={submit}
    >
      <h3>画布</h3>
      <label>
        比例来源
        <select
          defaultValue={canvas.aspectRatio.kind}
          name="ratioKind"
        >
          <option value="source">跟随首个源视频</option>
          <option value="ratio">自定义比例</option>
        </select>
      </label>
      <label>比例宽<input defaultValue={ratio.numerator} min="1" name="ratioNumerator" step="1" type="number" /></label>
      <label>比例高<input defaultValue={ratio.denominator} min="1" name="ratioDenominator" step="1" type="number" /></label>
      <label>
        适配方式
        <select defaultValue={canvas.transformPolicy} name="transformPolicy">
          <option value="fit">适应画布</option>
          <option value="fill">填满画布</option>
        </select>
      </label>
      <label>
        背景
        <select defaultValue={canvas.background.kind} name="backgroundKind">
          <option value="solid">纯色</option>
          <option value="blur_source">源画面模糊</option>
        </select>
      </label>
      <label>
        背景颜色
        <input
          defaultValue={
            canvas.background.kind === 'solid'
              ? canvas.background.color
              : '#000000'
          }
          name="backgroundColor"
          type="color"
        />
      </label>
      <label>
        模糊强度（%）
        <input
          defaultValue={
            canvas.background.kind === 'blur_source'
              ? canvas.background.strengthPermille / 10
              : 50
          }
          max="100"
          min="0"
          name="blurStrengthPercent"
          step="0.1"
          type="number"
        />
      </label>
      <Button disabled={busy} type="submit">保存画布设置</Button>
    </form>
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

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function buildTimelineSegments(
  clips: readonly Pick<
    VideoEditorClipDto,
    'clipId' | 'sourceRange' | 'speed' | 'transitionToNext'
  >[]
): readonly TimelineSegment[] {
  let cursorUs = 0;
  return clips.map((clip, index) => {
    const durationUs = effectiveClipDurationUs(clip);
    const segment = {
      clipId: clip.clipId,
      index,
      startUs: cursorUs,
      endUs: cursorUs + durationUs,
      durationUs,
      sourceInUs: clip.sourceRange.inUs,
      speedNumerator: clip.speed.numerator,
      speedDenominator: clip.speed.denominator
    };
    cursorUs =
      segment.endUs -
      (clip.transitionToNext.kind === 'none'
        ? 0
        : clip.transitionToNext.durationUs);
    return segment;
  });
}

function effectiveClipDurationUs(
  clip: Pick<VideoEditorClipDto, 'sourceRange' | 'speed'>
): number {
  return Number(
    (BigInt(clip.sourceRange.outUs - clip.sourceRange.inUs) *
      BigInt(clip.speed.denominator)) /
      BigInt(clip.speed.numerator)
  );
}

function formatTime(valueUs: number): string {
  const milliseconds = Math.max(0, Math.floor(valueUs / 1000));
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function canvasLabel(draft: VideoEditorDraftDto): string {
  const aspectRatio =
    draft.canvas.aspectRatio.kind === 'source'
      ? '跟随源比例'
      : `${draft.canvas.aspectRatio.numerator}:${draft.canvas.aspectRatio.denominator}`;
  return `${aspectRatio} · ${draft.canvas.transformPolicy === 'fit' ? '适应画布' : '填满画布'}`;
}

function sortDrafts(
  drafts: readonly VideoEditorDraftDto[]
): readonly VideoEditorDraftDto[] {
  return [...drafts].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

function errorMessage(code: VideoEditorIpcErrorCode, fallback: string): string {
  return errorMessages[code] ?? fallback;
}

function sourceStatusDisplay(
  status?: VideoEditorSourceStatusDto
): { readonly label: string; readonly tone: StatusTone } {
  if (!status) return { label: '检查中', tone: 'info' };
  switch (status.state) {
    case 'available':
      return {
        label: status.matchesIdentity === false ? '内容已变化' : '可用',
        tone: status.matchesIdentity === false ? 'danger' : 'success'
      };
    case 'missing':
      return { label: '文件丢失', tone: 'warning' };
    case 'corrupted':
      return { label: '内容已变化', tone: 'danger' };
    case 'disconnected':
      return { label: '存储已断开', tone: 'warning' };
    default:
      return { label: status.state, tone: status.relinkRequired ? 'warning' : 'neutral' };
  }
}

function sourceSummary(
  draft: VideoEditorDraftDto,
  statuses: Readonly<Record<string, VideoEditorSourceStatusDto>>
): string {
  if (draft.videoTrack.length === 0) return '无';
  const abnormal = draft.videoTrack.filter(
    (clip) => statuses[clip.clipId]?.relinkRequired
  ).length;
  const pending = draft.videoTrack.filter((clip) => !statuses[clip.clipId]).length;
  if (abnormal) return `${abnormal} 个需恢复`;
  if (pending) return '检查中';
  return '全部可用';
}

function referenceKindLabel(
  kind: VideoEditorSourceStatusDto['referenceKind']
): string {
  switch (kind) {
    case 'external_reference':
      return '授权外部引用';
    case 'managed_project_copy':
      return '项目托管副本';
    case 'managed_work':
      return '项目视频作品';
  }
}

function relinkDifferenceLabel(
  differences:
    | {
        readonly content: boolean;
        readonly size: boolean;
        readonly duration: boolean;
        readonly container: boolean;
        readonly dimensions: boolean;
      }
    | undefined
): string {
  if (!differences) return '身份信息不同';
  const labels = [
    differences.content && '内容',
    differences.size && '大小',
    differences.duration && '时长',
    differences.container && '容器',
    differences.dimensions && '尺寸'
  ].filter(Boolean);
  return labels.length ? labels.join('、') : '身份信息不同';
}

function formNumber(form: HTMLFormElement, name: string): number {
  return Number(new FormData(form).get(name));
}

function millisecondsToUs(value: number): number {
  return Math.round(value * 1000);
}

function percentToPermille(value: number): number {
  return Math.round(value * 10);
}

function reducedRatio(width: number, height: number) {
  let left = width;
  let right = height;
  while (right) [left, right] = [right, left % right];
  return { numerator: width / left, denominator: height / left };
}
