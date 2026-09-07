import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from 'react';
import {
  LuCheck,
  LuChevronDown,
  LuChevronUp,
  LuMaximize2,
  LuMinimize2,
  LuPause,
  LuPlay,
  LuZoomIn
} from 'react-icons/lu';
import {
  Checkbox,
  Dropdown,
  Input,
  InputNumber,
  Radio,
  RadioGroup,
  SelectPicker
} from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../../components/StatusPill';
import type {
  StorageApi,
  StorageLocalMediaHandleDto,
  StorageProjectSessionDto,
  StorageWorkSummaryDto
} from '../../../shared/storage-ipc';
import type {
  VideoEditorApi,
  VideoEditorBackgroundMusicPreviewDto,
  VideoEditorCanvasDto,
  VideoEditorBackgroundMusicDto,
  VideoEditorClipDto,
  VideoEditorCoverDto,
  VideoEditorDraftDto,
  VideoEditorExportPreflightDto,
  VideoEditorExportTaskDto,
  VideoEditorIpcErrorCode,
  VideoEditorIpcResult,
  VideoEditorOutputPreferenceDto,
  VideoEditorSourceRegistrationStrategyDto,
  VideoEditorSourceStatusDto,
  VideoEditorTextOverlayDto,
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
  work_not_found: '所选项目作品已不存在、类型不符或不属于当前项目。',
  source_unavailable: '源文件当前不可用，请检查文件状态。',
  source_changed: '源文件内容已经变化，请重新定位并确认。',
  unsupported_video: '当前只支持经过内容校验的 MP4 或 MOV 视频。',
  unsupported_audio: '当前背景音乐只支持经过内容校验的 PCM 或浮点 WAV 文件。',
  unsupported_image: '当前封面只支持经过内容校验的 PNG、JPEG、GIF、WebP 或 BMP 图片。',
  media_unreadable: '无法读取所选媒体，请检查文件后重试。',
  managed_copy_failed: '视频未能安全复制到项目，请检查存储空间。',
  relink_token_invalid: '重新定位确认已经失效，请重新选择文件。',
  relink_mismatch_confirmation_required: '候选文件与原文件不同，需要明确确认。',
  relink_candidate_too_short: '候选视频太短，无法覆盖当前片段的裁剪范围。',
  preview_unavailable: '原片预览不可用，请先恢复源文件。',
  adapter_unavailable: '当前未检测到经批准的本地媒体引擎，请检查本机工具链。',
  export_preflight_failed: '导出预检未通过，请按原因修复后重新检查。',
  export_not_found: '导出任务已不存在，请前往任务中心核对。',
  export_not_cancellable: '当前导出阶段不能取消。',
  export_not_retryable: '当前导出失败不能直接重试，请重新预检并创建新版本。',
  export_failed: '本地导出失败，原草稿和旧作品没有被覆盖。',
  nothing_to_undo: '当前没有可撤销的操作。',
  nothing_to_redo: '当前没有可重做的操作。',
  workspace_storage_error: '草稿未能写入项目，请检查存储后继续。'
};

const defaultTextFontFamily = 'Arial';

const canvasRatioPresets = [
  { key: '16:9', label: '16:9（西瓜视频）', numerator: 16, denominator: 9 },
  { key: '4:3', label: '4:3', numerator: 4, denominator: 3 },
  { key: '2.35:1', label: '2.35:1', numerator: 47, denominator: 20 },
  { key: '2:1', label: '2:1', numerator: 2, denominator: 1 },
  { key: '1.85:1', label: '1.85:1', numerator: 37, denominator: 20 },
  { key: '9:16', label: '9:16（抖音）', numerator: 9, denominator: 16 },
  { key: '3:4', label: '3:4', numerator: 3, denominator: 4 },
  { key: '9:19.5', label: '5.8寸', numerator: 6, denominator: 13 },
  { key: '1:1', label: '1:1', numerator: 1, denominator: 1 },
  { key: '1:2', label: '1:2', numerator: 1, denominator: 2 }
] as const;

type EditorError = Extract<
  VideoEditorIpcResult<unknown>,
  { readonly ok: false }
>['error'];
type SaveState = 'saved' | 'editing' | 'saving' | 'failed' | 'conflict';
type MediaTab = 'timeline' | 'project';
type InspectorTab = 'clip' | 'canvas' | 'audio' | 'text' | 'cover' | 'export';
type PreviewZoom = 'fit' | 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

interface PreviewMediaHandle {
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: string;
}

const previewZoomOptions: readonly {
  readonly key: PreviewZoom;
  readonly label: string;
}[] = [
  { key: 'fit', label: '适应' },
  { key: 0.5, label: '50%' },
  { key: 0.75, label: '75%' },
  { key: 1, label: '100%' },
  { key: 1.25, label: '125%' },
  { key: 1.5, label: '150%' },
  { key: 2, label: '200%' }
] as const;

interface VideoEditingPageProps {
  readonly onNavigate?: (itemId: 'tasks' | 'library') => void;
  readonly preferredDraftId?: string;
}

interface TimelineSegment {
  readonly clipId: string;
  readonly index: number;
  readonly startUs: number;
  readonly endUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
  readonly speedNumerator: number;
  readonly speedDenominator: number;
}

interface TimelineRulerTick {
  readonly timeUs: number;
  readonly leftPx: number;
  readonly label: string;
}

interface TimelineThumbnailSlot {
  readonly key: string;
  readonly clipId: string;
  readonly slotIndex: number;
  readonly sourceUs: number;
  readonly leftPx: number;
  readonly widthPx: number;
}

interface TimelineFrameRequest {
  readonly kind: 'poster' | 'timeline';
  readonly key: string;
  readonly clipId: string;
  readonly sourceUs: number;
}

interface ExtractedTimelineFrame {
  readonly request: TimelineFrameRequest;
  readonly frameUrl: string;
}

interface TimelineWheelZoomInput {
  readonly currentPixelsPerSecond: number;
  readonly deltaY: number;
  readonly pointerOffsetPx: number;
  readonly scrollLeft: number;
  readonly totalDurationUs: number;
  readonly viewportWidth: number;
}

interface TimelineHorizontalWheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly shiftKey: boolean;
  readonly viewportHeight: number;
}

interface TimelineEdgeAutoScrollInput {
  readonly clientX: number;
  readonly viewportLeft: number;
  readonly viewportWidth: number;
  readonly scrollLeft: number;
  readonly scrollWidth: number;
}

const timelineThumbnailWidthPx = 56;
const timelineThumbnailRenderWidthPx = 112;
const timelineThumbnailRenderHeightPx = 72;
const timelineFrameCacheLimit = 256;
const timelineFrameConcurrency = 2;
const timelineFrameDebounceMs = 60;
const timelineFramePresentationTimeoutMs = 48;
const timelineMaximumPixelsPerSecond = 1_000;
const timelineWheelSensitivity = 0.002;
const timelineRulerTargetGapPx = 96;

interface PendingPreviewSeek {
  readonly token: number;
  readonly clipId: string;
  readonly timelineUs: number;
  readonly sourceUs: number;
  readonly resumePlayback: boolean;
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

export function VideoEditingPage({
  onNavigate,
  preferredDraftId
}: VideoEditingPageProps) {
  const storage = window.unicomp?.storage;
  const videoEditors = window.unicomp?.videoEditors;
  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const timelineViewportRef = useRef<HTMLDivElement>(null);
  const timelineFitPixelsPerSecondRef = useRef(0);
  const timelineScrollFrameRef = useRef<number>();
  const timelinePendingScrollLeftRef = useRef(0);
  const timelineZoomScrollLeftRef = useRef<number>();
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [drafts, setDrafts] = useState<readonly VideoEditorDraftDto[]>([]);
  const [currentDraft, setCurrentDraft] = useState<VideoEditorDraftDto>();
  const [videoWorks, setVideoWorks] = useState<readonly StorageWorkSummaryDto[]>([]);
  const [imageWorks, setImageWorks] = useState<readonly StorageWorkSummaryDto[]>([]);
  const [selectedWorkId, setSelectedWorkId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [selectedTextId, setSelectedTextId] = useState('');
  const [sourceStatuses, setSourceStatuses] = useState<
    Readonly<Record<string, VideoEditorSourceStatusDto>>
  >({});
  const [preview, setPreview] = useState<PreviewMediaHandle>();
  const [musicPreview, setMusicPreview] =
    useState<VideoEditorBackgroundMusicPreviewDto>();
  const [playheadUs, setPlayheadUs] = useState(0);
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [title, setTitle] = useState('');
  const [mediaTab, setMediaTab] = useState<MediaTab>('timeline');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('clip');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [message, setMessage] = useState('');
  const [exportPreflight, setExportPreflight] =
    useState<VideoEditorExportPreflightDto>();
  const [exportTask, setExportTask] = useState<VideoEditorExportTaskDto>();
  const [exportMedia, setExportMedia] = useState<StorageLocalMediaHandleDto>();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportConfirmed, setExportConfirmed] = useState(false);
  const [frameUrls, setFrameUrls] = useState<Readonly<Record<string, string>>>({});
  const [timelineFrameUrls, setTimelineFrameUrls] = useState<
    Readonly<Record<string, string>>
  >({});
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [previewSeeking, setPreviewSeeking] = useState(false);
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>('fit');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelinePixelsPerSecond, setTimelinePixelsPerSecond] = useState(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [timelineFrameRefresh, setTimelineFrameRefresh] = useState(0);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const frameCacheRef = useRef<Map<string, string>>(new Map());
  const timelineFrameCacheRef = useRef<Map<string, string>>(new Map());
  const timelineFrameRequestRef = useRef(0);
  const previewCacheRef = useRef<Map<string, PreviewMediaHandle>>(new Map());
  const previewRequestRef = useRef(0);
  const previewSeekTokenRef = useRef(0);
  const pendingPreviewSeekRef = useRef<PendingPreviewSeek | undefined>(undefined);
  const previewHandleRef = useRef<
    { readonly clipId: string; readonly preview: PreviewMediaHandle } | undefined
  >(undefined);
  const timelinePlayingRef = useRef(false);
  const playbackSwitchingRef = useRef(false);

  useEffect(() => {
    if (!previewExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewExpanded(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [previewExpanded]);

  useEffect(() => {
    timelineFrameRequestRef.current += 1;
    revokeFrameUrlMap(frameCacheRef.current);
    revokeFrameUrlMap(timelineFrameCacheRef.current);
    setFrameUrls({});
    setTimelineFrameUrls({});
    return () => {
      timelineFrameRequestRef.current += 1;
      revokeFrameUrlMap(frameCacheRef.current);
      revokeFrameUrlMap(timelineFrameCacheRef.current);
    };
  }, [currentDraft?.draftId]);

  useEffect(() => {
    let active = true;

    async function load() {
      if (!storage || !videoEditors) {
        if (active) {
          setLoading(false);
      setMessage('本地编辑功能不可用，请在桌面应用中打开。');
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
        const projectWorks = worksResult.value.items.filter(
          (work) => work.projectId === sessionResult.value?.projectId
        );
        const works = projectWorks.filter((work) => work.mediaKind === 'video');
        setVideoWorks(works);
        setImageWorks(projectWorks.filter((work) => work.mediaKind === 'image'));
        setSelectedWorkId(works[0]?.workId ?? '');
      }
      const sorted = sortDrafts(listResult.value);
      setDrafts(sorted);
      const preferred = preferredDraftId
        ? sorted.find((draft) => draft.draftId === preferredDraftId)
        : undefined;
      acceptDraft(preferred ?? sorted[0]);
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
  }, [preferredDraftId, storage, videoEditors]);

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

  useEffect(() => {
    let active = true;
    setMusicPreview(undefined);
    if (
      !videoEditors ||
      typeof videoEditors.createBackgroundMusicPreview !== 'function' ||
      !currentDraft?.backgroundMusic
    ) {
      return () => {
        active = false;
      };
    }
    void videoEditors.createBackgroundMusicPreview(currentDraft.draftId)
      .then((result) => {
        if (!active) return;
        if (result.ok) setMusicPreview(result.value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [currentDraft?.backgroundMusic?.fileId, currentDraft?.draftId, videoEditors]);

  useEffect(() => {
    let active = true;
    setExportPreflight(undefined);
    setExportConfirmed(false);
    setExportMedia(undefined);
    setExportTask(undefined);
    if (!storage || !videoEditors || !session || !currentDraft) {
      return () => {
        active = false;
      };
    }
    void findLatestExportForDraft(
      storage,
      videoEditors,
      session.projectId,
      currentDraft.draftId
    ).then((task) => {
      if (active) setExportTask(task);
    }).catch(() => {
      if (active) setMessage('读取当前草稿的导出任务失败，请前往任务中心核对。');
    });
    return () => {
      active = false;
    };
  }, [currentDraft?.draftId, session, storage, videoEditors]);

  useEffect(() => {
    if (!videoEditors || !exportTask || !isExportPollingState(exportTask.state)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void videoEditors.getExport(exportTask.taskId).then((result) => {
        if (!active) return;
        if (result.ok) setExportTask(result.value);
        else setMessage(errorMessage(result.error.code, '刷新导出任务失败，请重试。'));
      }).catch(() => {
        if (active) setMessage('刷新导出任务失败，请前往任务中心核对。');
      });
    }, 800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [exportTask, videoEditors]);

  useEffect(() => {
    let active = true;
    setExportMedia(undefined);
    if (
      !storage ||
      exportTask?.state !== 'completed' ||
      !exportTask.workId
    ) {
      return () => {
        active = false;
      };
    }
    void storage.createWorkMediaHandle(exportTask.workId).then((result) => {
      if (!active) return;
      if (result.ok) setExportMedia(result.value);
      else setMessage('导出已完成，但作品预览暂不可用；可前往作品库核对。');
    }).catch(() => {
      if (active) setMessage('导出已完成，但作品预览暂不可用；可前往作品库核对。');
    });
    return () => {
      active = false;
    };
  }, [exportTask?.state, exportTask?.workId, storage]);

  function acceptDraft(
    draft?: VideoEditorDraftDto,
    preferredClipId?: string,
    preferredPlayheadUs?: number
  ) {
    timelinePlayingRef.current = false;
    setTimelinePlaying(false);
    videoRef.current?.pause();
    musicRef.current?.pause();
    setCurrentDraft(draft);
    setTitle(draft?.title ?? '');
    setSaveState('saved');
    setPreview(undefined);
    setPreviewUnavailable(false);
    previewHandleRef.current = undefined;
    previewCacheRef.current.clear();
    pendingPreviewSeekRef.current = undefined;
    playbackSwitchingRef.current = false;
    setPreviewSeeking(false);
    setTimelinePixelsPerSecond(0);
    setTimelineScrollLeft(0);
    timelineFitPixelsPerSecondRef.current = 0;
    timelineZoomScrollLeftRef.current = undefined;
    if (timelineViewportRef.current) timelineViewportRef.current.scrollLeft = 0;
    setExportPreflight(undefined);
    setExportConfirmed(false);
    const segments = buildTimelineSegments(draft?.videoTrack ?? []);
    const preferredSegment =
      preferredPlayheadUs === undefined
        ? undefined
        : segments.find(
            (segment) =>
              preferredPlayheadUs >= segment.startUs &&
              preferredPlayheadUs < segment.endUs
          );
    const nextClipId = preferredSegment?.clipId ?? (
      preferredClipId &&
      draft?.videoTrack.some((clip) => clip.clipId === preferredClipId)
        ? preferredClipId
        : draft?.videoTrack[0]?.clipId ?? ''
    );
    const nextSegment = segments.find((segment) => segment.clipId === nextClipId);
    const nextPlayheadUs =
      preferredPlayheadUs === undefined || !nextSegment
        ? nextSegment?.startUs ?? 0
        : Math.min(nextSegment.endUs, Math.max(nextSegment.startUs, preferredPlayheadUs));
    setSelectedClipId(nextClipId);
    setSelectedTextId((textId) =>
      draft?.textTrack.some((text) => text.textId === textId) ? textId : ''
    );
    setPlayheadUs(nextPlayheadUs);
    if (nextClipId) {
      void ensurePreview(nextClipId, false, draft, nextPlayheadUs);
    }
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
    preferredClipId = selectedClipId,
    preferredPlayheadUs?: number
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
      acceptDraft(
        result.value,
        preferredClipId,
        preferredPlayheadUs
      );
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
      successMessage,
      selectedClipId,
      command.kind === 'split_clip' ? playheadUs : undefined
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

  async function selectBackgroundMusic() {
    if (!videoEditors || !currentDraft || busy) return;
    setBusy(true);
    setSaveState('saving');
    setMessage('');
    try {
      const result = await videoEditors.selectBackgroundMusic(
        currentDraft.draftId,
        currentDraft.revision
      );
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      if (result.value.cancelled) {
        setSaveState('saved');
        setMessage('已取消选择音乐，草稿保持不变。');
        return;
      }
      acceptDraft(result.value.draft, selectedClipId);
      setInspectorTab('audio');
      setMessage('背景音乐已校验并保存；草稿仍只包含一条背景音乐。');
    } catch {
      setSaveState('failed');
      setMessage('选择背景音乐失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function selectCoverImage(
    prependToVideo: boolean,
    prependDurationUs?: number
  ) {
    if (!videoEditors || !currentDraft || busy) return;
    setBusy(true);
    setSaveState('saving');
    setMessage('');
    try {
      const result = await videoEditors.selectCoverImage(
        currentDraft.draftId,
        currentDraft.revision,
        prependToVideo,
        prependDurationUs
      );
      if (!result.ok) {
        handleError(result.error);
        return;
      }
      if (result.value.cancelled) {
        setSaveState('saved');
        setMessage('已取消选择封面，草稿保持不变。');
        return;
      }
      acceptDraft(result.value.draft, selectedClipId);
      setInspectorTab('cover');
      setMessage('本机图片已经过内容校验并设为封面。');
    } catch {
      setSaveState('failed');
      setMessage('选择本机封面失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function attachCoverWork(
    workId: string,
    prependToVideo: boolean,
    prependDurationUs?: number
  ) {
    if (!videoEditors || !currentDraft || !workId || busy) return;
    await mutate(
      () =>
        videoEditors.attachCoverWork(
          currentDraft.draftId,
          currentDraft.revision,
          workId,
          prependToVideo,
          prependDurationUs
        ),
      '项目图片作品已设为封面，没有复制或修改原作品。'
    );
    setInspectorTab('cover');
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

  function beginPreviewSeek(
    draft: VideoEditorDraftDto,
    clipId: string,
    timelineUs: number,
    resumePlayback = false
  ): PendingPreviewSeek {
    const pending = {
      token: ++previewSeekTokenRef.current,
      clipId,
      timelineUs,
      sourceUs: timelineToSourceUs(draft, clipId, timelineUs),
      resumePlayback
    };
    pendingPreviewSeekRef.current = pending;
    setPreviewSeeking(true);
    return pending;
  }

  function abandonPreviewSeek(token: number) {
    if (pendingPreviewSeekRef.current?.token !== token) return;
    pendingPreviewSeekRef.current = undefined;
    playbackSwitchingRef.current = false;
    setPreviewSeeking(false);
  }

  function completePreviewSeek() {
    const pending = pendingPreviewSeekRef.current;
    if (
      !pending ||
      !videoRef.current ||
      videoRef.current.seeking ||
      videoRef.current.dataset.previewClipId !== pending.clipId
    ) {
      return;
    }
    const sourceUs = Math.round(videoRef.current.currentTime * 1_000_000);
    if (Math.abs(sourceUs - pending.sourceUs) > 50_000) {
      applyPendingPreviewSeek();
      return;
    }
    pendingPreviewSeekRef.current = undefined;
    playbackSwitchingRef.current = false;
    setPreviewSeeking(false);
    setPlayheadUs(pending.timelineUs);
    if (pending.resumePlayback && timelinePlayingRef.current) {
      startCurrentPreviewPlayback(pending.clipId, pending.timelineUs);
    } else {
      syncBackgroundMusic(pending.timelineUs, false);
    }
  }

  function applyPendingPreviewSeek() {
    const pending = pendingPreviewSeekRef.current;
    if (
      !pending ||
      !videoRef.current ||
      videoRef.current.dataset.previewClipId !== pending.clipId ||
      videoRef.current.readyState < HTMLMediaElement.HAVE_METADATA ||
      videoRef.current.seeking
    ) {
      return;
    }
    const targetSeconds = pending.sourceUs / 1_000_000;
    if (
      videoRef.current.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      !videoRef.current.seeking &&
      Math.abs(videoRef.current.currentTime - targetSeconds) <= 0.001
    ) {
      completePreviewSeek();
      return;
    }
    videoRef.current.currentTime = pending.sourceUs / 1_000_000;
  }

  async function ensurePreview(
    clipId: string,
    force = false,
    draftOverride?: VideoEditorDraftDto,
    targetPlayheadUs = playheadUs,
    resumePlayback = false
  ): Promise<boolean> {
    const draft = draftOverride ?? currentDraft;
    if (!videoEditors || !draft || !clipId) return false;
    const clip = draft.videoTrack.find((item) => item.clipId === clipId);
    if (!clip) return false;
    const pendingSeek = beginPreviewSeek(
      draft,
      clipId,
      targetPlayheadUs,
      resumePlayback
    );
    const requestToken = ++previewRequestRef.current;
    const existing = previewHandleRef.current;
    const cacheKey = clipId;
    const cached = previewCacheRef.current.get(cacheKey);
    const reusable =
      existing?.clipId === clipId ? existing.preview : cached;
    if (
      !force &&
      reusable &&
      Number.isFinite(Date.parse(reusable.expiresAt)) &&
      Date.parse(reusable.expiresAt) - Date.now() > 30_000
    ) {
      previewHandleRef.current = { clipId, preview: reusable };
      setPreview(reusable);
      setPreviewUnavailable(false);
      if (existing?.clipId === clipId && videoRef.current) {
        applyPendingPreviewSeek();
      }
      return true;
    }
    try {
      const result = await videoEditors.createSourcePreview(draft.draftId, clipId);
      if (requestToken !== previewRequestRef.current) return false;
      if (!result.ok) {
        abandonPreviewSeek(pendingSeek.token);
        setPreviewUnavailable(!existing);
        if (resumePlayback) stopTimelinePlayback();
        setMessage(errorMessage(result.error.code, '当前片段预览暂不可用。'));
        return false;
      }
      const nextPreview: PreviewMediaHandle = {
        url: result.value.url,
        expiresAt: result.value.expiresAt,
        mimeType: result.value.mimeType
      };
      previewHandleRef.current = { clipId, preview: nextPreview };
      previewCacheRef.current.set(cacheKey, nextPreview);
      setPreview(nextPreview);
      setPreviewUnavailable(false);
      return true;
    } catch {
      if (requestToken === previewRequestRef.current) {
        abandonPreviewSeek(pendingSeek.token);
        if (resumePlayback) stopTimelinePlayback();
        setMessage('加载片段预览失败，请重试。');
      }
      return false;
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
      timelineFrameRequestRef.current += 1;
      revokeFrameUrlMap(frameCacheRef.current);
      revokeFrameUrlMap(timelineFrameCacheRef.current);
      previewCacheRef.current.clear();
      setFrameUrls({});
      setTimelineFrameUrls({});
      setTimelineFrameRefresh((value) => value + 1);
      setMessage('可重建的预览缓存已清除，草稿和源文件没有改变。');
    } catch {
      setMessage('清除预览缓存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function prepareExport() {
    if (!videoEditors || !currentDraft || exportBusy) return;
    setInspectorTab('export');
    setExportBusy(true);
    setExportConfirmed(false);
    setMessage('正在校验素材、字体、输出能力和目标要求…');
    try {
      const result = await videoEditors.preflightExport(
        currentDraft.draftId,
        currentDraft.revision
      );
      if (!result.ok) {
        if (result.error.code === 'draft_conflict') setSaveState('conflict');
        setMessage(errorMessage(result.error.code, '导出预检失败，请重试。'));
        return;
      }
      setExportPreflight(result.value);
      setMessage(
        result.value.ready
          ? '导出预检通过；请核对确认信息后再创建后台任务。'
          : '导出预检未通过，请按面板中的真实原因处理。'
      );
    } catch {
      setMessage('导出预检失败，请检查本机媒体工具链后重试。');
    } finally {
      setExportBusy(false);
    }
  }

  async function startExport() {
    if (
      !videoEditors ||
      !currentDraft ||
      !exportPreflight?.ready ||
      !exportConfirmed ||
      exportBusy
    ) return;
    setExportBusy(true);
    setMessage('正在创建冻结导出计划和后台任务…');
    try {
      const result = await videoEditors.startExport(
        currentDraft.draftId,
        currentDraft.revision
      );
      if (!result.ok) {
        if (result.error.code === 'draft_conflict') setSaveState('conflict');
        setMessage(errorMessage(result.error.code, '导出任务未能创建，请重试。'));
        return;
      }
      setExportTask(result.value);
      setExportConfirmed(false);
      setMessage('后台导出任务已创建；继续编辑不会改变本次冻结计划。');
    } catch {
      setMessage('创建导出任务失败，草稿和已有作品保持不变。');
    } finally {
      setExportBusy(false);
    }
  }

  async function cancelExport() {
    if (!videoEditors || !exportTask?.canCancel || exportBusy) return;
    setExportBusy(true);
    setMessage('正在请求媒体进程安全停止…');
    try {
      const result = await videoEditors.cancelExport(exportTask.taskId);
      if (!result.ok) {
        setMessage(errorMessage(result.error.code, '取消请求未完成，请重试。'));
        return;
      }
      setExportTask(result.value);
      setMessage('取消请求已记录；只有进程确认停止后才会显示已取消。');
    } catch {
      setMessage('取消请求失败，请前往任务中心核对真实状态。');
    } finally {
      setExportBusy(false);
    }
  }

  async function retryExport() {
    if (!videoEditors || !exportTask?.canRetry || exportBusy) return;
    setExportBusy(true);
    setMessage('正在基于原冻结计划创建新的导出尝试…');
    try {
      const result = await videoEditors.retryExport(exportTask.taskId);
      if (!result.ok) {
        setMessage(errorMessage(result.error.code, '导出重试未能创建。'));
        return;
      }
      setExportTask(result.value);
      setMessage(`第 ${result.value.attempt} 次导出尝试已创建；旧尝试记录仍然保留。`);
    } catch {
      setMessage('创建重试失败，原尝试记录保持不变。');
    } finally {
      setExportBusy(false);
    }
  }

  async function revealExport() {
    if (!storage || exportTask?.state !== 'completed' || !exportTask.workId || exportBusy) {
      return;
    }
    setExportBusy(true);
    try {
      const result = await storage.revealWorkFile(exportTask.workId);
      setMessage(
        result.ok
          ? '已在系统文件管理器中定位已登记作品。'
          : '无法定位作品，请前往作品库检查文件状态。'
      );
    } catch {
      setMessage('无法定位作品，请前往作品库检查文件状态。');
    } finally {
      setExportBusy(false);
    }
  }

  const segments = useMemo(
    () => buildTimelineSegments(currentDraft?.videoTrack ?? []),
    [currentDraft?.videoTrack]
  );
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
  const clipNames = useMemo(() => {
    const names: Record<string, string> = {};
    currentDraft?.videoTrack.forEach((clip, index) => {
      names[clip.clipId] = resolveClipDisplayName(clip, index, videoWorks);
    });
    return names;
  }, [currentDraft, videoWorks]);
  const timelineFitPixelsPerSecond =
    totalDurationUs > 0 && timelineViewportWidth > 0
      ? timelineViewportWidth / (totalDurationUs / 1_000_000)
      : 0;
  const effectiveTimelinePixelsPerSecond =
    timelineFitPixelsPerSecond > 0
      ? Math.max(
          timelineFitPixelsPerSecond,
          timelinePixelsPerSecond || timelineFitPixelsPerSecond
        )
      : 0;
  const timelineCanvasWidth = Math.max(
    timelineViewportWidth,
    (totalDurationUs / 1_000_000) * effectiveTimelinePixelsPerSecond
  );
  const timelineRulerTicks = useMemo(
    () =>
      buildTimelineRulerTicks(
        totalDurationUs,
        effectiveTimelinePixelsPerSecond,
        timelineScrollLeft,
        timelineScrollLeft + timelineViewportWidth,
        timelineViewportWidth
      ),
    [
      effectiveTimelinePixelsPerSecond,
      timelineScrollLeft,
      timelineViewportWidth,
      totalDurationUs
    ]
  );
  const timelineThumbnailSlots = useMemo(
    () =>
      timelineCollapsed ||
      timelineViewportWidth <= 0 ||
      effectiveTimelinePixelsPerSecond <= 0
        ? []
        : buildTimelineThumbnailSlots(
            segments,
            effectiveTimelinePixelsPerSecond,
            timelineScrollLeft,
            timelineScrollLeft + timelineViewportWidth,
            timelineViewportWidth
          ),
    [
      effectiveTimelinePixelsPerSecond,
      segments,
      timelineCollapsed,
      timelineScrollLeft,
      timelineViewportWidth
    ]
  );

  useEffect(() => {
    const viewport = timelineViewportRef.current;
    if (!viewport) return;
    const updateWidth = () => setTimelineViewportWidth(viewport.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [timelineCollapsed]);

  useEffect(() => {
    if (timelineFitPixelsPerSecond <= 0) return;
    const previousFit = timelineFitPixelsPerSecondRef.current;
    setTimelinePixelsPerSecond((current) => {
      const wasFitted =
        current <= 0 ||
        previousFit <= 0 ||
        Math.abs(current - previousFit) < 0.5;
      const next = wasFitted
        ? timelineFitPixelsPerSecond
        : Math.max(timelineFitPixelsPerSecond, current);
      return Math.min(
        Math.max(timelineFitPixelsPerSecond, timelineMaximumPixelsPerSecond),
        next
      );
    });
    timelineFitPixelsPerSecondRef.current = timelineFitPixelsPerSecond;
  }, [timelineFitPixelsPerSecond]);

  useEffect(() => {
    const viewport = timelineViewportRef.current;
    if (
      !viewport ||
      timelineCollapsed ||
      effectiveTimelinePixelsPerSecond <= 0 ||
      totalDurationUs <= 0
    ) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const deltaY =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? event.deltaY * 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? event.deltaY * viewport.clientHeight
              : event.deltaY;
        const next = resolveTimelineWheelZoom({
          currentPixelsPerSecond: effectiveTimelinePixelsPerSecond,
          deltaY,
          pointerOffsetPx: event.clientX - rect.left,
          scrollLeft: viewport.scrollLeft,
          totalDurationUs,
          viewportWidth: viewport.clientWidth
        });
        timelineZoomScrollLeftRef.current = next.scrollLeft;
        setTimelinePixelsPerSecond(next.pixelsPerSecond);
        return;
      }
      const horizontalDelta = resolveTimelineHorizontalWheelDelta({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shiftKey: event.shiftKey,
        viewportHeight: viewport.clientHeight
      });
      if (horizontalDelta === 0) return;
      const maximumScrollLeft = Math.max(
        0,
        viewport.scrollWidth - viewport.clientWidth
      );
      const nextScrollLeft = Math.min(
        maximumScrollLeft,
        Math.max(0, viewport.scrollLeft + horizontalDelta)
      );
      if (nextScrollLeft === viewport.scrollLeft) return;
      event.preventDefault();
      viewport.scrollLeft = nextScrollLeft;
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [
    effectiveTimelinePixelsPerSecond,
    timelineCollapsed,
    totalDurationUs
  ]);

  useLayoutEffect(() => {
    const viewport = timelineViewportRef.current;
    const nextScrollLeft = timelineZoomScrollLeftRef.current;
    if (!viewport || nextScrollLeft === undefined) return;
    timelineZoomScrollLeftRef.current = undefined;
    viewport.scrollLeft = nextScrollLeft;
    timelinePendingScrollLeftRef.current = viewport.scrollLeft;
    setTimelineScrollLeft(viewport.scrollLeft);
  }, [timelineCanvasWidth]);

  useEffect(
    () => () => {
      if (timelineScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(timelineScrollFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const requestToken = ++timelineFrameRequestRef.current;
    if (!videoEditors || !currentDraft || currentDraft.videoTrack.length === 0) {
      setFrameUrls({});
      setTimelineFrameUrls({});
      return;
    }
    const editorApi = videoEditors;
    const draft = currentDraft;
    const groups = new Map<string, TimelineFrameRequest[]>();
    const addRequest = (request: TimelineFrameRequest) => {
      const requests = groups.get(request.clipId) ?? [];
      if (!requests.some((item) => item.key === request.key)) {
        requests.push(request);
        groups.set(request.clipId, requests);
      }
    };
    const cachedTimelineFrames: Record<string, string> = {};
    const viewportCenterPx = timelineScrollLeft + timelineViewportWidth / 2;
    const prioritizedSlots = [...timelineThumbnailSlots].sort(
      (left, right) =>
        Math.abs(left.leftPx + left.widthPx / 2 - viewportCenterPx) -
        Math.abs(right.leftPx + right.widthPx / 2 - viewportCenterPx)
    );
    for (const slot of prioritizedSlots) {
      const cached = timelineFrameCacheRef.current.get(slot.key);
      if (cached) {
        timelineFrameCacheRef.current.delete(slot.key);
        timelineFrameCacheRef.current.set(slot.key, cached);
        cachedTimelineFrames[slot.key] = cached;
      } else {
        addRequest({
          kind: 'timeline',
          key: slot.key,
          clipId: slot.clipId,
          sourceUs: slot.sourceUs
        });
      }
    }
    if (Object.keys(cachedTimelineFrames).length > 0) {
      setTimelineFrameUrls((previous) => ({
        ...previous,
        ...cachedTimelineFrames
      }));
    }

    const cachedPosterFrames: Record<string, string> = {};
    for (const clip of draft.videoTrack.slice(0, 24)) {
      const cached = frameCacheRef.current.get(clip.clipId);
      if (cached) {
        cachedPosterFrames[clip.clipId] = cached;
      } else {
        addRequest({
          kind: 'poster',
          key: `poster:${clip.clipId}:${clip.sourceRange.inUs}`,
          clipId: clip.clipId,
          sourceUs: clip.sourceRange.inUs
        });
      }
    }
    if (Object.keys(cachedPosterFrames).length > 0) {
      setFrameUrls((previous) => ({ ...previous, ...cachedPosterFrames }));
    }
    const groupedRequests = [...groups.entries()];
    if (groupedRequests.length === 0) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void runWithConcurrency(
        groupedRequests,
        timelineFrameConcurrency,
        async ([clipId, requests]) => {
          const isCancelled = () =>
            requestToken !== timelineFrameRequestRef.current ||
            controller.signal.aborted;
          if (isCancelled()) return;
          let handle = previewCacheRef.current.get(clipId);
          if (
            !handle ||
            !Number.isFinite(Date.parse(handle.expiresAt)) ||
            Date.parse(handle.expiresAt) - Date.now() <= 30_000
          ) {
            const result = await editorApi.createSourcePreview(
              draft.draftId,
              clipId
            );
            if (isCancelled() || !result.ok) return;
            handle = {
              url: result.value.url,
              expiresAt: result.value.expiresAt,
              mimeType: result.value.mimeType
            };
            previewCacheRef.current.set(clipId, handle);
          }
          await extractTimelineFrameBatch(
            handle.url,
            requests,
            controller.signal,
            isCancelled,
            (frames) => {
              if (isCancelled()) {
                for (const frame of frames) {
                  URL.revokeObjectURL(frame.frameUrl);
                }
                return;
              }
              const nextPosterFrames: Record<string, string> = {};
              const nextTimelineFrames: Record<string, string> = {};
              const evictedTimelineKeys = new Set<string>();
              for (const { request, frameUrl } of frames) {
                if (request.kind === 'poster') {
                  const previous = frameCacheRef.current.get(request.clipId);
                  if (previous && previous !== frameUrl) {
                    URL.revokeObjectURL(previous);
                  }
                  frameCacheRef.current.set(request.clipId, frameUrl);
                  nextPosterFrames[request.clipId] = frameUrl;
                  continue;
                }
                for (const key of cacheTimelineFrame(
                  timelineFrameCacheRef.current,
                  request.key,
                  frameUrl
                )) {
                  evictedTimelineKeys.add(key);
                }
                nextTimelineFrames[request.key] = frameUrl;
              }
              if (Object.keys(nextPosterFrames).length > 0) {
                setFrameUrls((current) => ({
                  ...current,
                  ...nextPosterFrames
                }));
              }
              if (
                Object.keys(nextTimelineFrames).length > 0 ||
                evictedTimelineKeys.size > 0
              ) {
                setTimelineFrameUrls((current) => {
                  const next = { ...current, ...nextTimelineFrames };
                  for (const key of evictedTimelineKeys) delete next[key];
                  return next;
                });
              }
            }
          );
        }
      ).catch(() => undefined);
    }, timelineFrameDebounceMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    currentDraft,
    timelineFrameRefresh,
    timelineThumbnailSlots,
    timelineScrollLeft,
    timelineViewportWidth,
    videoEditors
  ]);
  const activeTexts =
    currentDraft?.textTrack.filter(
      (text) => playheadUs >= text.range.startUs && playheadUs < text.range.endUs
    ) ?? [];

  function selectClip(clipId: string) {
    const resumePlayback = timelinePlayingRef.current;
    playbackSwitchingRef.current = false;
    videoRef.current?.pause();
    musicRef.current?.pause();
    setSelectedClipId(clipId);
    const nextPlayheadUs =
      segments.find((segment) => segment.clipId === clipId)?.startUs ?? 0;
    setPlayheadUs(nextPlayheadUs);
    setInspectorTab('clip');
    void ensurePreview(
      clipId,
      false,
      undefined,
      nextPlayheadUs,
      resumePlayback
    );
  }

  function seekTimeline(nextUs: number) {
    const boundedUs = Math.min(totalDurationUs, Math.max(0, nextUs));
    setPlayheadUs(boundedUs);
    if (boundedUs >= totalDurationUs) {
      stopTimelinePlayback();
      return;
    }
    const targetSegment = resolveTimelineSegmentAt(segments, boundedUs);
    if (!targetSegment) return;
    const resumePlayback = timelinePlayingRef.current;
    playbackSwitchingRef.current = false;
    videoRef.current?.pause();
    musicRef.current?.pause();
    if (targetSegment.clipId !== selectedClipId) {
      setSelectedClipId(targetSegment.clipId);
    }
    void ensurePreview(
      targetSegment.clipId,
      false,
      undefined,
      boundedUs,
      resumePlayback
    );
  }

  function syncPlayheadFromPreview() {
    if (pendingPreviewSeekRef.current) return;
    if (!videoRef.current || !currentDraft) return;
    const previewClipId = previewHandleRef.current?.clipId;
    const playbackClip = currentDraft.videoTrack.find(
      (clip) => clip.clipId === previewClipId
    );
    const playbackSegment = segments.find(
      (segment) => segment.clipId === previewClipId
    );
    if (!playbackClip || !playbackSegment) return;
    const rawPreviewUs = Math.round(videoRef.current.currentTime * 1_000_000);
    const sourceUs = Math.min(
      playbackClip.sourceRange.outUs,
      Math.max(playbackClip.sourceRange.inUs, rawPreviewUs)
    );
    const sourceOffset = sourceUs - playbackSegment.sourceInUs;
    const timelineOffset = Number(
      (BigInt(sourceOffset) * BigInt(playbackSegment.speedDenominator)) /
        BigInt(playbackSegment.speedNumerator)
    );
    const nextPlayheadUs = Math.min(
      playbackSegment.endUs,
      playbackSegment.startUs + timelineOffset
    );
    setPlayheadUs(nextPlayheadUs);
    syncBackgroundMusic(nextPlayheadUs, timelinePlayingRef.current);
    const previewEndUs = playbackClip.sourceRange.outUs;
    if (rawPreviewUs >= previewEndUs - 1_000) {
      if (timelinePlayingRef.current) advanceTimelinePlayback();
      else videoRef.current.pause();
    }
  }

  function toggleTimelinePlayback() {
    if (timelinePlayingRef.current) {
      stopTimelinePlayback();
      return;
    }
    const startUs = playheadUs >= totalDurationUs ? 0 : playheadUs;
    const targetSegment = resolveTimelineSegmentAt(segments, startUs);
    if (!targetSegment) return;
    timelinePlayingRef.current = true;
    playbackSwitchingRef.current = false;
    setTimelinePlaying(true);
    setPlayheadUs(startUs);
    setSelectedClipId(targetSegment.clipId);
    void ensurePreview(targetSegment.clipId, false, undefined, startUs, true);
  }

  function stopTimelinePlayback() {
    timelinePlayingRef.current = false;
    playbackSwitchingRef.current = false;
    setTimelinePlaying(false);
    videoRef.current?.pause();
    musicRef.current?.pause();
  }

  function startCurrentPreviewPlayback(clipId: string, timelineUs: number) {
    if (!timelinePlayingRef.current || !videoRef.current || !currentDraft) return;
    const clip = currentDraft.videoTrack.find((candidate) => candidate.clipId === clipId);
    if (!clip) return;
    videoRef.current.playbackRate = clip.speed.numerator / clip.speed.denominator;
    videoRef.current.muted = clip.sourceAudio.muted;
    videoRef.current.volume = clip.sourceAudio.volumePermille / 1_000;
    syncBackgroundMusic(timelineUs, true);
    void videoRef.current.play().catch(() => {
      stopTimelinePlayback();
      setMessage('无法开始时间线预览，请再次点击播放。');
    });
  }

  function advanceTimelinePlayback() {
    const previewClipId = previewHandleRef.current?.clipId;
    const playbackSegment = segments.find(
      (segment) => segment.clipId === previewClipId
    );
    if (
      !timelinePlayingRef.current ||
      !playbackSegment ||
      playbackSwitchingRef.current
    ) {
      return;
    }
    playbackSwitchingRef.current = true;
    videoRef.current?.pause();
    const nextSegment = segments[playbackSegment.index + 1];
    if (!nextSegment) {
      setPlayheadUs(totalDurationUs);
      stopTimelinePlayback();
      return;
    }
    const nextPlayheadUs = Math.max(playbackSegment.endUs, nextSegment.startUs);
    setPlayheadUs(nextPlayheadUs);
    setSelectedClipId(nextSegment.clipId);
    void ensurePreview(
      nextSegment.clipId,
      false,
      undefined,
      nextPlayheadUs,
      true
    );
  }

  function syncBackgroundMusic(timelineUs: number, shouldPlay: boolean) {
    if (!musicRef.current || !currentDraft?.backgroundMusic || !musicPreview) return;
    const playback = resolveBackgroundMusicPlayback(
      currentDraft.backgroundMusic,
      timelineUs
    );
    if (!playback) {
      musicRef.current.pause();
      return;
    }
    const targetSeconds = playback.sourceUs / 1_000_000;
    if (Math.abs(musicRef.current.currentTime - targetSeconds) > 0.2) {
      musicRef.current.currentTime = targetSeconds;
    }
    musicRef.current.volume = playback.volumePermille / 1_000;
    if (shouldPlay && musicRef.current.paused) {
      void musicRef.current.play().catch(() => undefined);
    } else if (!shouldPlay) {
      musicRef.current.pause();
    }
  }

  function togglePreviewFullscreen() {
    setPreviewExpanded((value) => !value);
  }

  function selectCanvasRatio(eventKey: string | number | undefined) {
    if (!currentDraft || operationBlocked || typeof eventKey !== 'string') return;
    if (eventKey === 'custom') {
      setInspectorTab('canvas');
      setInspectorExpanded(true);
      return;
    }
    const aspectRatio: VideoEditorCanvasDto['aspectRatio'] =
      eventKey === 'source'
        ? { kind: 'source' }
        : (() => {
            const preset = canvasRatioPresets.find((item) => item.key === eventKey);
            return preset
              ? {
                  kind: 'ratio' as const,
                  numerator: preset.numerator,
                  denominator: preset.denominator
                }
              : currentDraft.canvas.aspectRatio;
          })();
    const label =
      eventKey === 'source'
        ? '适应（原始）'
        : canvasRatioPresets.find((item) => item.key === eventKey)?.label;
    if (!label) return;
    void runCommand(
      {
        kind: 'set_canvas',
        canvas: { ...currentDraft.canvas, aspectRatio }
      },
      `画布比例已切换为${label}。`
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
            <span
              aria-live="polite"
              className={`uc-video-editor__save-state uc-video-editor__save-state--${
                loading
                  ? 'info'
                  : session
                    ? saveStateTones[saveState]
                    : 'warning'
              }`}
            >
              <span aria-hidden="true" className="uc-video-editor__save-state-dot" />
              {loading
                ? '读取中'
                : session
                  ? saveStateLabels[saveState]
                  : '未打开项目'}
            </span>
            {saveState === 'conflict' ? (
              <Button
                disabled={busy}
                onClick={() => currentDraft && void openDraft(currentDraft.draftId)}
                variant="secondary"
              >
                重新载入
              </Button>
            ) : null}
          </div>
          <div className="uc-video-editor__draft-picker">
            <div className="uc-rsuite-field">
              <SelectPicker
                aria-label="编辑草稿"
                cleanable={false}
                data={drafts.map((draft) => ({
                  label: draft.title,
                  value: draft.draftId
                }))}
                disabled={!session || loading || operationBlocked || drafts.length === 0}
                onChange={(value) => value && void openDraft(value)}
                placeholder={drafts.length === 0 ? '暂无编辑草稿' : '选择编辑草稿'}
                value={currentDraft?.draftId ?? null}
              />
            </div>
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
            variant="secondary"
          >
            保存草稿
          </Button>
          <Button
            disabled={!currentDraft || operationBlocked || exportBusy}
            onClick={() => setInspectorTab('export')}
            variant="secondary"
          >
            导出设置
          </Button>
          <Button
            disabled={!currentDraft || operationBlocked || exportBusy}
            onClick={() => void prepareExport()}
          >
            导出视频
          </Button>
        </div>
      </header>

      <div
        className={`uc-video-editor__workspace${timelineCollapsed ? ' uc-video-editor__workspace--timeline-collapsed' : ''}`}
      >
        <Card className="uc-video-editor__media-bin">
          <PanelHeading
            description="素材只通过受控接口登记，界面不会读取本地绝对路径。"
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
              frames={frameUrls}
              loading={loading}
              names={clipNames}
              onDelete={(clipId) =>
                void runCommand(
                  { kind: 'remove_clip', clipId },
                  '片段已从主轨移除，源文件没有删除。'
                )
              }
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
              storage={storage}
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
          {mediaTab === 'timeline' ? (
            <p className="uc-video-editor__hint">
              导入只登记或复制视频并追加片段，不上传、不调用在线智能服务、不创建任务。
            </p>
          ) : null}
        </Card>

        <div
          className={`uc-video-editor__center${previewExpanded ? ' uc-video-editor__center--expanded' : ''}`}
        >
          <Card className="uc-video-editor__preview">
            <PanelHeading
              description={
                currentDraft
                  ? `${canvasLabel(currentDraft)} · ${selectedClip ? '当前片段已选择' : '请选择片段'}`
                  : '创建或打开草稿后显示真实画布意图。'
              }
              title="预览舞台"
            />
            <div className="uc-video-editor__preview-stage">
              <div
                className="uc-video-editor__preview-canvas"
                style={{
                  aspectRatio: currentDraft ? canvasPreviewAspectRatio(currentDraft) : '16 / 9',
                  backgroundColor:
                    currentDraft?.canvas.background.kind === 'solid'
                      ? currentDraft.canvas.background.color
                      : '#000000',
                  transform: previewZoom === 'fit' ? undefined : `scale(${previewZoom})`
                }}
              >
                {preview ? (
                  <video
                    aria-busy={previewSeeking}
                    aria-label="时间线预览"
                    className="uc-video-editor__video"
                    data-preview-clip-id={previewHandleRef.current?.clipId}
                    key={`${previewHandleRef.current?.clipId ?? ''}:${preview.url}`}
                    onEnded={advanceTimelinePlayback}
                    onLoadedData={applyPendingPreviewSeek}
                    onLoadedMetadata={applyPendingPreviewSeek}
                    onSeeked={completePreviewSeek}
                    onTimeUpdate={syncPlayheadFromPreview}
                    playsInline
                    ref={videoRef}
                    src={preview.url}
                  />
                ) : (
                  <EmptyState
                    description={
                      selectedClip
                        ? previewUnavailable
                          ? '源文件不可用，可在左侧素材列表重新定位后重试。'
                          : '正在校验并加载第一个片段，加载完成后即可预览整条时间线。'
                        : '当前没有已选择的视频片段。'
                    }
                    icon="预"
                    readOnly
                    title={
                      selectedClip
                        ? previewUnavailable
                          ? '源文件不可用'
                          : '正在准备时间线预览'
                        : '等待视频片段'
                    }
                  />
                )}
                {activeTexts.map((text) => (
                  <span
                    className="uc-video-editor__preview-text"
                    key={text.textId}
                    style={{
                      color: text.style.color,
                      fontFamily: text.style.requestedFontFamily,
                      fontSize: `${text.style.fontSizeMilliPx / 1_000}px`,
                      left: `${text.position.xPermille / 10}%`,
                      opacity: text.style.opacityPermille / 1_000,
                      textAlign: text.style.alignment,
                      top: `${text.position.yPermille / 10}%`,
                      transform: `translate(${text.style.alignment === 'left' ? '0' : text.style.alignment === 'center' ? '-50%' : '-100%'}, -50%)`
                    }}
                  >
                    {text.content}
                  </span>
                ))}
              </div>
            </div>
            {musicPreview ? (
              <audio
                aria-hidden="true"
                key={musicPreview.url}
                onLoadedMetadata={() =>
                  syncBackgroundMusic(playheadUs, timelinePlayingRef.current)
                }
                ref={musicRef}
                src={musicPreview.url}
              />
            ) : null}
            <div className="uc-video-editor__transport">
              <span className="uc-video-editor__transport-time">
                <strong>{formatTime(playheadUs)}</strong> / {formatTime(totalDurationUs)}
              </span>
              <button
                aria-label={timelinePlaying ? '暂停时间线' : '播放时间线'}
                className="uc-video-editor__transport-play"
                disabled={totalDurationUs <= 0 || busy}
                onClick={toggleTimelinePlayback}
                title={timelinePlaying ? '暂停' : '播放'}
                type="button"
              >
                {timelinePlaying ? <LuPause aria-hidden="true" /> : <LuPlay aria-hidden="true" />}
              </button>
              <div className="uc-video-editor__transport-tools">
                <Dropdown
                  className="uc-video-editor__zoom-menu"
                  menuStyle={{ minWidth: 132, maxHeight: 320, overflowY: 'auto' }}
                  onSelect={(eventKey) => {
                    if (eventKey === 'clear-preview-cache') {
                      void clearPreviewCache();
                      return;
                    }
                    const zoom = previewZoomOptions.find(
                      (option) => option.key === eventKey
                    )?.key;
                    if (zoom !== undefined) setPreviewZoom(zoom);
                  }}
                  placement="bottomEnd"
                  renderToggle={(props, ref) => (
                    <button
                      {...props}
                      aria-label="预览缩放"
                      className={`uc-video-editor__transport-icon${props.className ? ` ${props.className}` : ''}`}
                      ref={ref}
                      title={`预览缩放：${previewZoom === 'fit' ? '适应' : `${previewZoom * 100}%`}`}
                      type="button"
                    >
                      <LuZoomIn aria-hidden="true" />
                    </button>
                  )}
                >
                  {previewZoomOptions.map((option) => (
                    <Dropdown.Item
                      className="uc-video-editor__zoom-item"
                      eventKey={option.key}
                      icon={previewZoom === option.key ? <LuCheck /> : undefined}
                      key={option.key}
                    >
                      {option.label}
                    </Dropdown.Item>
                  ))}
                  <Dropdown.Separator />
                  <Dropdown.Item eventKey="clear-preview-cache">
                    清除预览缓存
                  </Dropdown.Item>
                </Dropdown>
                <Dropdown
                  className="uc-video-editor__ratio-menu"
                  disabled={!currentDraft || operationBlocked}
                  menuStyle={{ minWidth: 184, maxHeight: 356, overflowY: 'auto' }}
                  onSelect={selectCanvasRatio}
                  placement="bottomEnd"
                  renderToggle={(props, ref) => (
                    <button
                      {...props}
                      aria-label="画布比例"
                      className={`uc-video-editor__transport-ratio${props.className ? ` ${props.className}` : ''}`}
                      ref={ref}
                      title="选择画布比例"
                      type="button"
                    >
                      {currentDraft ? selectedCanvasRatioLabel(currentDraft) : '比例'}
                      <LuChevronDown aria-hidden="true" />
                    </button>
                  )}
                >
                  <Dropdown.Item
                    className="uc-video-editor__ratio-item"
                    eventKey="source"
                    icon={currentDraft?.canvas.aspectRatio.kind === 'source' ? <LuCheck /> : undefined}
                  >
                    <span className="uc-video-editor__ratio-option">
                      <span>适应（原始）</span>
                    </span>
                  </Dropdown.Item>
                  <Dropdown.Item className="uc-video-editor__ratio-item" eventKey="custom">
                    自定义
                  </Dropdown.Item>
                  <Dropdown.Separator />
                  {canvasRatioPresets.map((preset) => (
                    <Dropdown.Item
                      className="uc-video-editor__ratio-item"
                      eventKey={preset.key}
                      icon={currentDraft && canvasRatioMatches(currentDraft.canvas, preset.numerator, preset.denominator) ? <LuCheck /> : undefined}
                      key={preset.key}
                    >
                      <span className="uc-video-editor__ratio-option">
                        <span>{preset.label}</span>
                        <span
                          aria-hidden="true"
                          className="uc-video-editor__ratio-shape"
                          style={{ aspectRatio: `${preset.numerator} / ${preset.denominator}` }}
                        />
                      </span>
                    </Dropdown.Item>
                  ))}
                </Dropdown>
                <button
                  aria-label={previewExpanded ? '退出全屏预览' : '全屏预览'}
                  aria-pressed={previewExpanded}
                  className="uc-video-editor__transport-icon"
                  onClick={togglePreviewFullscreen}
                  title={previewExpanded ? '退出全屏预览' : '全屏预览'}
                  type="button"
                >
                  {previewExpanded ? <LuMinimize2 aria-hidden="true" /> : <LuMaximize2 aria-hidden="true" />}
                </button>
              </div>
            </div>
          </Card>
        </div>

        <Card
          className={`uc-video-editor__timeline${timelineCollapsed ? ' uc-video-editor__timeline--collapsed' : ''}`}
        >
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
              <Button
                disabled={!currentDraft || totalDurationUs <= 0}
                onClick={() => setInspectorTab('text')}
                variant="ghost"
              >
                文字
              </Button>
              <Button
                disabled={!currentDraft || totalDurationUs <= 0}
                onClick={() => setInspectorTab('audio')}
                variant="ghost"
              >
                音乐
              </Button>
              <Button
                disabled={!currentDraft || totalDurationUs <= 0}
                onClick={() => setInspectorTab('cover')}
                variant="ghost"
              >
                封面
              </Button>
              <button
                aria-controls="uc-video-editor-timeline-content"
                aria-expanded={!timelineCollapsed}
                className="uc-video-editor__timeline-toggle"
                onClick={() => setTimelineCollapsed((value) => !value)}
                title={timelineCollapsed ? '展开时间线' : '收起时间线'}
                type="button"
              >
                {timelineCollapsed ? <LuChevronUp aria-hidden="true" /> : <LuChevronDown aria-hidden="true" />}
                {timelineCollapsed ? '展开' : '收起'}
              </button>
            </div>
          </div>
          {timelineCollapsed ? (
            <div
              className="uc-video-editor__timeline-summary"
              id="uc-video-editor-timeline-content"
            >
              <strong>视频主轨</strong>
              <span>{segments.length} 个片段</span>
              <span>{formatTime(totalDurationUs)}</span>
            </div>
          ) : (
          <div
            className="uc-video-editor__timeline-grid"
            id="uc-video-editor-timeline-content"
          >
            <div className="uc-video-editor__timeline-labels" aria-hidden="true">
              <span />
              <strong>视频主轨</strong>
              <strong>文字轨</strong>
              <strong>背景音乐</strong>
            </div>
            <div
              aria-label="时间线，按住 Ctrl 滚动鼠标滚轮可缩放"
              className="uc-video-editor__timeline-viewport"
              onScroll={(event) => {
                timelinePendingScrollLeftRef.current =
                  event.currentTarget.scrollLeft;
                if (timelineScrollFrameRef.current !== undefined) return;
                timelineScrollFrameRef.current = window.requestAnimationFrame(() => {
                  timelineScrollFrameRef.current = undefined;
                  setTimelineScrollLeft(timelinePendingScrollLeftRef.current);
                });
              }}
              ref={timelineViewportRef}
              role="region"
              title="按住 Ctrl 滚动鼠标滚轮可缩放时间线"
            >
              <div
                className="uc-video-editor__timeline-canvas"
                style={{ width: `${timelineCanvasWidth}px` }}
              >
                <div className="uc-video-editor__ruler" aria-hidden="true">
                  {timelineRulerTicks.map((tick) => (
                    <span
                      className="uc-video-editor__ruler-tick"
                      key={tick.timeUs}
                      style={{ left: `${tick.leftPx}px` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
                <VideoTimelineTrack
                  canReorder={!operationBlocked}
                  frames={frameUrls}
                  onMove={(clipId, toIndex) =>
                    void runCommand(
                      { kind: 'move_clip', clipId, toIndex },
                      '片段已通过拖拽移动。'
                    )
                  }
                  onSeek={(nextUs) => seekTimeline(nextUs)}
                  onSelect={selectClip}
                  pixelsPerSecond={effectiveTimelinePixelsPerSecond}
                  segments={segments}
                  selectedClipId={selectedClipId}
                  thumbnailFrames={timelineFrameUrls}
                  thumbnailSlots={timelineThumbnailSlots}
                  totalDurationUs={totalDurationUs}
                />
                <TimelineTrack
                  items={
                    currentDraft?.textTrack.map((text) => ({
                      id: text.textId,
                      label: text.content || '空文字层',
                      startUs: text.range.startUs,
                      endUs: text.range.endUs
                    })) ?? []
                  }
                  onSelect={(textId) => {
                    setSelectedTextId(textId);
                    setInspectorTab('text');
                  }}
                  selectedId={selectedTextId}
                  totalDurationUs={totalDurationUs}
                />
                <TimelineTrack
                  items={
                    currentDraft?.backgroundMusic
                      ? [{
                          id: currentDraft.backgroundMusic.fileId,
                          label: '背景音乐',
                          startUs: currentDraft.backgroundMusic.timelineRange.startUs,
                          endUs: currentDraft.backgroundMusic.timelineRange.endUs
                        }]
                      : []
                  }
                  totalDurationUs={totalDurationUs}
                />
                <TimelinePlayhead
                  onSeek={seekTimeline}
                  playheadUs={playheadUs}
                  totalDurationUs={totalDurationUs}
                  viewportRef={timelineViewportRef}
                />
              </div>
            </div>
          </div>
          )}
        </Card>

        <Card
          className={`uc-video-editor__inspector${inspectorExpanded ? ' uc-video-editor__inspector--expanded' : ''}`}
        >
          <div className="uc-video-editor__inspector-head">
            <PanelHeading
              description="表单只提交编辑操作；成功返回的数据是唯一保存依据。"
              title="属性面板"
            />
            <button
              aria-controls="uc-video-editor-inspector-body"
              aria-expanded={inspectorExpanded}
              className="uc-video-editor__inspector-toggle"
              onClick={() => setInspectorExpanded((value) => !value)}
              type="button"
            >
              <span className="uc-video-editor__inspector-toggle-label">
                {inspectorExpanded ? '收起' : '展开'}
              </span>
              <span
                aria-hidden="true"
                className="uc-video-editor__inspector-toggle-chev"
              >
                ▾
              </span>
            </button>
          </div>
          <div
            className="uc-video-editor__inspector-body"
            id="uc-video-editor-inspector-body"
          >
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
            <button
              aria-selected={inspectorTab === 'audio'}
              disabled={!currentDraft}
              onClick={() => setInspectorTab('audio')}
              role="tab"
              type="button"
            >
              声音
            </button>
            <button
              aria-selected={inspectorTab === 'text'}
              disabled={!currentDraft}
              onClick={() => setInspectorTab('text')}
              role="tab"
              type="button"
            >
              文字
            </button>
            <button
              aria-selected={inspectorTab === 'cover'}
              disabled={!currentDraft}
              onClick={() => setInspectorTab('cover')}
              role="tab"
              type="button"
            >
              封面
            </button>
            <button
              aria-selected={inspectorTab === 'export'}
              disabled={!currentDraft}
              onClick={() => setInspectorTab('export')}
              role="tab"
              type="button"
            >
              导出
            </button>
          </div>
          <label className="uc-video-editor__title-field">
            <span>草稿名称</span>
            <Input
              disabled={!currentDraft}
              onBlur={() => void commitTitle()}
              onChange={(value) => {
                setTitle(value);
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
                displayName={clipNames[selectedClip.clipId] ?? `片段 ${selectedIndex + 1}`}
                frameUrl={frameUrls[selectedClip.clipId]}
                index={selectedIndex}
                onCommand={(command, successMessage) =>
                  void runCommand(command, successMessage)
                }
                onInvalid={setMessage}
                onRelink={() => void relinkSource(selectedClip.clipId)}
                status={sourceStatuses[selectedClip.clipId]}
                total={currentDraft?.videoTrack.length ?? 0}
              />
            ) : (
              <EmptyState
                description="从素材区或视频主轨选择一个片段。"
                icon="属"
                readOnly
                title="尚未选择片段"
              />
            )
          ) : inspectorTab === 'canvas' && currentDraft ? (
            <CanvasInspector
              busy={operationBlocked}
              canvas={currentDraft.canvas}
              key={`${currentDraft.draftId}-${JSON.stringify(currentDraft.canvas)}`}
              onCommand={(canvas) =>
                void runCommand(
                  { kind: 'set_canvas', canvas },
                  '画布设置已保存。'
                )
              }
              onInvalid={setMessage}
              sourceClip={currentDraft.videoTrack[0]}
            />
          ) : inspectorTab === 'audio' && currentDraft ? (
            <AudioInspector
              backgroundMusic={currentDraft.backgroundMusic}
              busy={operationBlocked}
              clip={selectedClip}
              onCommand={(command, successMessage) =>
                void runCommand(command, successMessage)
              }
              onInvalid={setMessage}
              onSelectMusic={() => void selectBackgroundMusic()}
              totalDurationUs={totalDurationUs}
            />
          ) : inspectorTab === 'text' && currentDraft ? (
            <TextInspector
              busy={operationBlocked}
              onCommand={(command, successMessage) =>
                void runCommand(command, successMessage)
              }
              onInvalid={setMessage}
              onSelect={setSelectedTextId}
              selectedTextId={selectedTextId}
              texts={currentDraft.textTrack}
              totalDurationUs={totalDurationUs}
            />
          ) : inspectorTab === 'cover' && currentDraft ? (
            <CoverInspector
              busy={operationBlocked}
              clips={currentDraft.videoTrack}
              cover={currentDraft.cover}
              imageWorks={imageWorks}
              key={`${currentDraft.draftId}-${JSON.stringify(currentDraft.cover)}`}
              onAttachWork={(workId, prependToVideo, prependDurationUs) =>
                void attachCoverWork(workId, prependToVideo, prependDurationUs)
              }
              onCommand={(command, successMessage) =>
                void runCommand(command, successMessage)
              }
              onInvalid={setMessage}
              onSelectLocal={(prependToVideo, prependDurationUs) =>
                void selectCoverImage(prependToVideo, prependDurationUs)
              }
              selectedClipId={selectedClipId}
            />
          ) : inspectorTab === 'export' && currentDraft ? (
            <ExportInspector
              busy={operationBlocked || exportBusy}
              confirmed={exportConfirmed}
              draft={currentDraft}
              key={`${currentDraft.draftId}-${currentDraft.outputPreference.fileName ?? ''}-${currentDraft.outputPreference.conflictPolicy}`}
              media={exportMedia}
              onCancel={() => void cancelExport()}
              onConfirm={setExportConfirmed}
              onNavigate={onNavigate}
              onPreflight={() => void prepareExport()}
              onReveal={() => void revealExport()}
              onRetry={() => void retryExport()}
              onSave={(outputPreference) =>
                void runCommand(
                  { kind: 'set_output_preference', outputPreference },
                  '导出文件名和冲突策略已保存；请重新预检。'
                )
              }
              onStart={() => void startExport()}
              preflight={exportPreflight}
              task={exportTask}
              totalDurationUs={totalDurationUs}
            />
          ) : (
            <EmptyState
              description="打开草稿后才能编辑画布。"
              icon="画"
              readOnly
              title="暂无画布设置"
            />
          )}
          </div>
        </Card>
      </div>

      {message ? (
        <p className="uc-video-editor__message" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function MediaList({
  draft,
  frames,
  loading,
  names,
  onDelete,
  onRelink,
  onSelect,
  selectedClipId,
  session,
  statuses
}: {
  readonly draft?: VideoEditorDraftDto;
  readonly frames: Readonly<Record<string, string>>;
  readonly loading: boolean;
  readonly names: Readonly<Record<string, string>>;
  readonly onDelete: (clipId: string) => void;
  readonly onRelink: (clipId: string) => void;
  readonly onSelect: (clipId: string) => void;
  readonly selectedClipId: string;
  readonly session?: StorageProjectSessionDto;
  readonly statuses: Readonly<Record<string, VideoEditorSourceStatusDto>>;
}) {
  const [armedClipId, setArmedClipId] = useState('');
  const armedTimerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(armedTimerRef.current);
    },
    []
  );

  function armDelete(clipId: string) {
    if (armedClipId === clipId) {
      window.clearTimeout(armedTimerRef.current);
      setArmedClipId('');
      onDelete(clipId);
      return;
    }
    window.clearTimeout(armedTimerRef.current);
    setArmedClipId(clipId);
    armedTimerRef.current = window.setTimeout(() => {
      setArmedClipId('');
    }, 3_000);
  }

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
        description="点击顶部“新建草稿”建立项目内空白编辑草稿。"
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
        const frameUrl = frames[clip.clipId];
        return (
          <li
            className={
              selectedClipId === clip.clipId
                ? 'uc-video-editor__media-item uc-video-editor__media-item--selected'
                : 'uc-video-editor__media-item'
            }
            key={clip.clipId}
          >
            <button
              className="uc-video-editor__media-select"
              onClick={() => onSelect(clip.clipId)}
              type="button"
            >
              <span
                aria-hidden="true"
                className="uc-video-editor__media-frame"
              >
                {frameUrl ? (
                  <img alt="" src={frameUrl} />
                ) : (
                  <span className="uc-video-editor__frame-fallback">
                    {index + 1}
                  </span>
                )}
                <span className="uc-video-editor__frame-dur">
                  {formatTime(effectiveClipDurationUs(clip))}
                </span>
              </span>
              <span className="uc-video-editor__media-meta">
                <strong>{names[clip.clipId] ?? `片段 ${index + 1}`}</strong>
                <small>
                  {clip.source.identity.container.toUpperCase()} ·{' '}
                  {clip.source.identity.width}×{clip.source.identity.height} ·{' '}
                  {formatTime(effectiveClipDurationUs(clip))}
                </small>
              </span>
            </button>
            <span className="uc-video-editor__media-side">
              <StatusPill tone={display.tone}>{display.label}</StatusPill>
              {status?.relinkRequired ? (
                <Button onClick={() => onRelink(clip.clipId)} variant="ghost">
                  重新定位
                </Button>
              ) : null}
              <button
                aria-label={`删除片段 ${index + 1}（源文件保留）`}
                className={`uc-video-editor__media-delete${armedClipId === clip.clipId ? ' armed' : ''}`}
                onClick={() => armDelete(clip.clipId)}
                title="删除片段（源文件保留）"
                type="button"
              >
                {armedClipId === clip.clipId ? '确认' : '×'}
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectVideoList({
  onSelect,
  selectedWorkId,
  storage,
  works
}: {
  readonly onSelect: (workId: string) => void;
  readonly selectedWorkId: string;
  readonly storage?: StorageApi;
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
    <div className="uc-video-editor__project-works uc-scrollbar">
      {works.map((work) => (
        <button
          aria-pressed={selectedWorkId === work.workId}
          key={work.workId}
          onClick={() => onSelect(work.workId)}
          type="button"
        >
          <ProjectVideoThumbnail storage={storage} work={work} />
          <span className="uc-video-editor__project-work-meta">
            <strong title={work.name}>{work.name}</strong>
            <small>{fileStateLabel(work.fileState)}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function ProjectVideoThumbnail({
  storage,
  work
}: {
  readonly storage?: StorageApi;
  readonly work: StorageWorkSummaryDto;
}) {
  const previewRef = useRef<HTMLSpanElement>(null);
  const [media, setMedia] = useState<StorageLocalMediaHandleDto>();

  useEffect(() => {
    const preview = previewRef.current;
    let active = true;
    setMedia(undefined);
    if (!preview || !storage || work.fileState !== 'available') {
      return () => {
        active = false;
      };
    }

    const load = () => {
      void storage.createWorkMediaHandle(work.workId, work.projectId)
        .then((result) => {
          if (active && result.ok) setMedia(result.value);
        })
        .catch(() => undefined);
    };
    const observer = typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(([entry]) => {
          if (!entry?.isIntersecting) return;
          load();
          observer?.disconnect();
        }, { rootMargin: '180px' });
    if (observer) observer.observe(preview);
    else load();

    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [storage, work.fileState, work.projectId, work.workId]);

  return (
    <span
      aria-hidden="true"
      className="uc-video-editor__project-work-preview"
      ref={previewRef}
    >
      {media ? (
        <video muted playsInline preload="metadata" src={media.url} />
      ) : (
        <span className="uc-video-editor__project-work-fallback">视频</span>
      )}
    </span>
  );
}

function VideoTimelineTrack({
  canReorder,
  frames,
  onMove,
  onSeek,
  onSelect,
  pixelsPerSecond,
  segments,
  selectedClipId,
  thumbnailFrames,
  thumbnailSlots,
  totalDurationUs
}: {
  readonly canReorder: boolean;
  readonly frames: Readonly<Record<string, string>>;
  readonly onMove: (clipId: string, toIndex: number) => void;
  readonly onSeek: (timelineUs: number) => void;
  readonly onSelect: (clipId: string) => void;
  readonly pixelsPerSecond: number;
  readonly segments: readonly TimelineSegment[];
  readonly selectedClipId: string;
  readonly thumbnailFrames: Readonly<Record<string, string>>;
  readonly thumbnailSlots: readonly TimelineThumbnailSlot[];
  readonly totalDurationUs: number;
}) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const slotsByClip = useMemo(() => {
    const grouped = new Map<string, TimelineThumbnailSlot[]>();
    for (const slot of thumbnailSlots) {
      const slots = grouped.get(slot.clipId) ?? [];
      slots.push(slot);
      grouped.set(slot.clipId, slots);
    }
    return grouped;
  }, [thumbnailSlots]);
  return segments.length ? (
        <div
          className="uc-video-editor__lane uc-video-editor__lane--video"
          onClick={(event) => {
            if (!laneRef.current) return;
            const target = event.target as HTMLElement;
            if (target.closest('button.uc-video-editor__seg')) return;
            const rect = laneRef.current.getBoundingClientRect();
            if (rect.width <= 0) return;
            onSeek(
              resolveTimelinePositionUs(
                event.clientX,
                rect.left,
                rect.width,
                totalDurationUs
              )
            );
          }}
          ref={laneRef}
        >
          {segments.map((segment) => {
            const frameUrl = frames[segment.clipId];
            const segmentLeftPx =
              (segment.startUs / 1_000_000) * pixelsPerSecond;
            return (
              <button
                aria-pressed={selectedClipId === segment.clipId}
                className={`uc-video-editor__seg${
                  selectedClipId === segment.clipId
                    ? ' uc-video-editor__seg--selected'
                    : ''
                }`}
                draggable={canReorder}
                key={segment.clipId}
                onClick={() => onSelect(segment.clipId)}
                onDragOver={(event) => {
                  if (!canReorder) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDragStart={(event) => {
                  onSelect(segment.clipId);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', segment.clipId);
                }}
                onDrop={(event) => {
                  if (!canReorder) return;
                  event.preventDefault();
                  const clipId = event.dataTransfer.getData('text/plain');
                  const sourceIndex = segments.findIndex(
                    (item) => item.clipId === clipId
                  );
                  if (sourceIndex < 0) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const placeAfter =
                    event.clientX >= bounds.left + bounds.width / 2;
                  const toIndex = resolveTimelineDropIndex(
                    sourceIndex,
                    segment.index,
                    placeAfter
                  );
                  if (toIndex !== sourceIndex) onMove(clipId, toIndex);
                }}
                style={{
                  left: `${(segment.startUs / 1_000_000) * pixelsPerSecond}px`,
                  width: `${Math.max(4, (segment.durationUs / 1_000_000) * pixelsPerSecond)}px`,
                  minWidth: 4
                }}
                title={`片段 ${segment.index + 1} · 起点 ${formatTime(segment.startUs)}`}
                type="button"
              >
                {frameUrl ? (
                  <img
                    alt=""
                    className="uc-video-editor__seg-poster"
                    draggable={false}
                    src={frameUrl}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="uc-video-editor__frame-fallback"
                  >
                    {segment.index + 1}
                  </span>
                )}
                <span
                  aria-hidden="true"
                  className="uc-video-editor__thumbnail-strip"
                >
                  {(slotsByClip.get(segment.clipId) ?? []).map((slot) => {
                    const thumbnailUrl = thumbnailFrames[slot.key] ?? frameUrl;
                    return (
                      <span
                        className="uc-video-editor__thumbnail"
                        key={slot.key}
                        style={{
                          left: `${slot.leftPx - segmentLeftPx}px`,
                          width: `${slot.widthPx}px`
                        }}
                      >
                        {thumbnailUrl ? (
                          <img alt="" draggable={false} src={thumbnailUrl} />
                        ) : null}
                      </span>
                    );
                  })}
                </span>
                <span className="uc-video-editor__seg-label">
                  {segment.index + 1} · {formatTime(segment.durationUs)}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="uc-video-editor__lane uc-video-editor__lane--video">
          <small>暂无内容</small>
        </div>
  );
}

function TimelinePlayhead({
  onSeek,
  playheadUs,
  totalDurationUs,
  viewportRef
}: {
  readonly onSeek: (timelineUs: number) => void;
  readonly playheadUs: number;
  readonly totalDurationUs: number;
  readonly viewportRef: { readonly current: HTMLDivElement | null };
}) {
  const scaleRef = useRef<HTMLDivElement | null>(null);
  if (totalDurationUs <= 0) return null;
  const playheadPercent = Math.min(
    100,
    Math.max(0, (playheadUs / totalDurationUs) * 100)
  );
  return (
    <div className="uc-video-editor__playhead-layer">
      <div className="uc-video-editor__playhead-scale" ref={scaleRef}>
        <button
          aria-label="主轨播放头"
          aria-valuemin={0}
          aria-valuemax={totalDurationUs}
          aria-valuenow={playheadUs}
          aria-valuetext={formatTime(playheadUs)}
          className="uc-video-editor__playhead-line"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onSeek(Math.max(0, playheadUs - 500_000));
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              onSeek(Math.min(totalDurationUs, playheadUs + 500_000));
            } else if (event.key === 'Home') {
              event.preventDefault();
              onSeek(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              onSeek(totalDurationUs);
            }
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!scaleRef.current) return;
            let pendingClientX = event.clientX;
            let active = true;
            let lastPositionUs = -1;
            let animationFrameId: number | undefined;
            const flushMove = () => {
              animationFrameId = undefined;
              if (!active || !scaleRef.current) return;
              const viewport = viewportRef.current;
              if (viewport) {
                const viewportRect = viewport.getBoundingClientRect();
                const nextScrollLeft = resolveTimelineEdgeAutoScroll({
                  clientX: pendingClientX,
                  viewportLeft: viewportRect.left,
                  viewportWidth: viewportRect.width,
                  scrollLeft: viewport.scrollLeft,
                  scrollWidth: viewport.scrollWidth
                });
                if (nextScrollLeft !== viewport.scrollLeft) {
                  viewport.scrollLeft = nextScrollLeft;
                }
              }
              const scaleRect = scaleRef.current.getBoundingClientRect();
              const nextPositionUs = resolveTimelinePositionUs(
                pendingClientX,
                scaleRect.left,
                scaleRect.width,
                totalDurationUs
              );
              if (nextPositionUs !== lastPositionUs) {
                lastPositionUs = nextPositionUs;
                onSeek(nextPositionUs);
              }
              animationFrameId = window.requestAnimationFrame(flushMove);
            };
            const scheduleMove = (clientX: number) => {
              pendingClientX = clientX;
              if (animationFrameId === undefined) {
                animationFrameId = window.requestAnimationFrame(flushMove);
              }
            };
            scheduleMove(event.clientX);
            const onMove = (e: MouseEvent) => scheduleMove(e.clientX);
            const onUp = (e: MouseEvent) => {
              pendingClientX = e.clientX;
              active = false;
              if (animationFrameId !== undefined) {
                window.cancelAnimationFrame(animationFrameId);
              }
              if (scaleRef.current) {
                const scaleRect = scaleRef.current.getBoundingClientRect();
                onSeek(
                  resolveTimelinePositionUs(
                    pendingClientX,
                    scaleRect.left,
                    scaleRect.width,
                    totalDurationUs
                  )
                );
              }
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          role="slider"
          style={{ left: `${playheadPercent}%` }}
          type="button"
        />
      </div>
    </div>
  );
}

function TimelineTrack({
  items,
  onSelect,
  selectedId,
  totalDurationUs
}: {
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly startUs: number;
    readonly endUs: number;
  }[];
  readonly onSelect?: (id: string) => void;
  readonly selectedId?: string;
  readonly totalDurationUs: number;
}) {
  return (
      <div className="uc-video-editor__lane uc-video-editor__lane--slim">
        {items.length ? (
          items.map((item) =>
            onSelect ? (
              <button
                aria-pressed={selectedId === item.id}
                className="uc-video-editor__chip"
                key={item.id}
                onClick={() => onSelect(item.id)}
                style={timelineRangeStyle(item, totalDurationUs)}
                type="button"
              >
                {item.label}
              </button>
            ) : (
              <span
                className="uc-video-editor__chip"
                key={item.id}
                style={timelineRangeStyle(item, totalDurationUs)}
              >
                {item.label}
              </span>
            )
          )
        ) : (
          <span className="uc-video-editor__chip uc-video-editor__chip--ghost">
            ＋ 暂无内容
          </span>
        )}
      </div>
  );
}

function timelineRangeStyle(
  range: { readonly startUs: number; readonly endUs: number },
  totalDurationUs: number
): { readonly left: string; readonly width: string } {
  if (totalDurationUs <= 0) return { left: '0%', width: '0%' };
  const startUs = Math.min(totalDurationUs, Math.max(0, range.startUs));
  const endUs = Math.min(totalDurationUs, Math.max(startUs, range.endUs));
  return {
    left: `${(startUs / totalDurationUs) * 100}%`,
    width: `${((endUs - startUs) / totalDurationUs) * 100}%`
  };
}

function ClipInspector({
  busy,
  clip,
  displayName,
  frameUrl,
  index,
  onCommand,
  onInvalid,
  onRelink,
  status,
  total
}: {
  readonly busy: boolean;
  readonly clip: VideoEditorClipDto;
  readonly displayName: string;
  readonly frameUrl?: string;
  readonly index: number;
  readonly onCommand: (command: VideoEditorUpdateDto, message: string) => void;
  readonly onInvalid: (message: string) => void;
  readonly onRelink: () => void;
  readonly status?: VideoEditorSourceStatusDto;
  readonly total: number;
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
  const statusOk = display.tone === 'success';
  return (
    <div className="uc-video-editor__inspector-content">
      <div className="uc-video-editor__clip-summary">
        <span
          aria-hidden="true"
          className="uc-video-editor__media-frame uc-video-editor__clip-summary-frame"
        >
          {frameUrl ? (
            <img alt="" src={frameUrl} />
          ) : (
            <span className="uc-video-editor__frame-fallback">
              {index + 1}
            </span>
          )}
        </span>
        <span className="uc-video-editor__clip-summary-meta">
          <span className="uc-video-editor__clip-summary-name">
            {displayName}
          </span>
          <span className="uc-video-editor__clip-chips">
            <span className="uc-video-editor__chip2">
              {index + 1} / {total}
            </span>
            <span className="uc-video-editor__chip2">
              {clip.source.identity.container.toUpperCase()}
            </span>
            <span className="uc-video-editor__chip2">
              {clip.source.identity.width}×{clip.source.identity.height}
            </span>
            <span
              className={`uc-video-editor__chip2${statusOk ? ' uc-video-editor__chip2--ok' : ''}`}
            >
              ● {display.label}
            </span>
          </span>
        </span>
      </div>
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
          <InputNumber
            defaultValue={clip.sourceRange.inUs / 1000}
            min={0}
            name="trimStartMs"
            step={1}
          />
        </label>
        <label>
          结束（毫秒）
          <InputNumber
            defaultValue={clip.sourceRange.outUs / 1000}
            min={1}
            name="trimEndMs"
            step={1}
          />
        </label>
        <Button disabled={busy} type="submit">保存裁剪</Button>
      </form>

      <form className="uc-video-editor__form" key={`speed-${clip.clipId}-${clip.speed.numerator}`} onSubmit={submitSpeed}>
        <h3>速度</h3>
        <label>
          速度百分比
          <InputNumber
            defaultValue={(clip.speed.numerator / clip.speed.denominator) * 100}
            min={1}
            name="speedPercent"
            step={1}
          />
        </label>
        <Button disabled={busy} type="submit">保存速度</Button>
      </form>

      <form className="uc-video-editor__form" key={`transform-${clip.clipId}-${JSON.stringify(clip.transform)}`} onSubmit={submitTransform}>
        <h3>画面变换</h3>
        <label>缩放（%）<InputNumber defaultValue={clip.transform.scalePermille / 10} min={0.1} name="scalePercent" step={0.1} /></label>
        <label>水平位置（%）<InputNumber defaultValue={clip.transform.positionXPermille / 10} name="positionXPercent" step={0.1} /></label>
        <label>垂直位置（%）<InputNumber defaultValue={clip.transform.positionYPermille / 10} name="positionYPercent" step={0.1} /></label>
        <label>旋转（度）<InputNumber defaultValue={clip.transform.rotationMilliDegrees / 1000} name="rotationDegrees" step={0.001} /></label>
        <Checkbox className="uc-video-editor__check" defaultChecked={clip.transform.flipX} name="flipX">水平翻转</Checkbox>
        <Checkbox className="uc-video-editor__check" defaultChecked={clip.transform.flipY} name="flipY">垂直翻转</Checkbox>
        <Checkbox className="uc-video-editor__check" defaultChecked={clip.transform.crop !== null} name="cropEnabled">启用裁切</Checkbox>
        <label>横向裁切（%）<InputNumber defaultValue={(clip.transform.crop?.xPermille ?? 0) / 10} min={0} name="cropXPercent" step={0.1} /></label>
        <label>纵向裁切（%）<InputNumber defaultValue={(clip.transform.crop?.yPermille ?? 0) / 10} min={0} name="cropYPercent" step={0.1} /></label>
        <label>裁切宽度（%）<InputNumber defaultValue={(clip.transform.crop?.widthPermille ?? 1000) / 10} min={0.1} name="cropWidthPercent" step={0.1} /></label>
        <label>裁切高度（%）<InputNumber defaultValue={(clip.transform.crop?.heightPermille ?? 1000) / 10} min={0.1} name="cropHeightPercent" step={0.1} /></label>
        <Button disabled={busy} type="submit">保存画面变换</Button>
      </form>

      <div className="uc-video-editor__disabled-field">
        基础转场
        <SelectPicker
          aria-label="基础转场"
          cleanable={false}
          data={[{ value: 'none', label: '无转场（媒体引擎尚未审批）' }]}
          disabled
          searchable={false}
          value="none"
        />
      </div>
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
  const [ratioKind, setRatioKind] = useState<'source' | 'ratio'>(
    canvas.aspectRatio.kind
  );
  const [transformPolicy, setTransformPolicy] = useState<'fit' | 'fill'>(
    canvas.transformPolicy
  );
  const [backgroundKind, setBackgroundKind] = useState<'solid' | 'blur_source'>(
    canvas.background.kind
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
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
      transformPolicy: transformPolicy === 'fill' ? 'fill' : 'fit',
      background:
        backgroundKind === 'blur_source'
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
      <div className="uc-rsuite-field">
        比例来源
        <SelectPicker
          aria-label="比例来源"
          cleanable={false}
          data={[
            { value: 'source', label: '跟随首个源视频' },
            { value: 'ratio', label: '自定义比例' }
          ]}
          onChange={(value) => setRatioKind(value === 'ratio' ? 'ratio' : 'source')}
          searchable={false}
          value={ratioKind}
        />
      </div>
      <label>比例宽<InputNumber defaultValue={ratio.numerator} min={1} name="ratioNumerator" step={1} /></label>
      <label>比例高<InputNumber defaultValue={ratio.denominator} min={1} name="ratioDenominator" step={1} /></label>
      <div className="uc-rsuite-field">
        适配方式
        <SelectPicker
          aria-label="适配方式"
          cleanable={false}
          data={[
            { value: 'fit', label: '适应画布' },
            { value: 'fill', label: '填满画布' }
          ]}
          onChange={(value) => setTransformPolicy(value === 'fill' ? 'fill' : 'fit')}
          searchable={false}
          value={transformPolicy}
        />
      </div>
      <div className="uc-rsuite-field">
        背景
        <SelectPicker
          aria-label="背景"
          cleanable={false}
          data={[
            { value: 'solid', label: '纯色' },
            { value: 'blur_source', label: '源画面模糊' }
          ]}
          onChange={(value) =>
            setBackgroundKind(value === 'blur_source' ? 'blur_source' : 'solid')
          }
          searchable={false}
          value={backgroundKind}
        />
      </div>
      <label>
        背景颜色
        <Input
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
        <InputNumber
          defaultValue={
            canvas.background.kind === 'blur_source'
              ? canvas.background.strengthPermille / 10
              : 50
          }
          max={100}
          min={0}
          name="blurStrengthPercent"
          step={0.1}
        />
      </label>
      <Button disabled={busy} type="submit">保存画布设置</Button>
    </form>
  );
}

function TextInspector({
  busy,
  onCommand,
  onInvalid,
  onSelect,
  selectedTextId,
  texts,
  totalDurationUs
}: {
  readonly busy: boolean;
  readonly onCommand: (command: VideoEditorUpdateDto, message: string) => void;
  readonly onInvalid: (message: string) => void;
  readonly onSelect: (textId: string) => void;
  readonly selectedTextId: string;
  readonly texts: readonly VideoEditorTextOverlayDto[];
  readonly totalDurationUs: number;
}) {
  const selected = texts.find((text) => text.textId === selectedTextId);

  return (
    <div className="uc-video-editor__inspector-content">
      <div className="uc-video-editor__layer-list">
        <Button
          disabled={busy}
          onClick={() => onSelect('')}
          variant={selected ? 'ghost' : 'secondary'}
        >
          新建文字
        </Button>
        {texts.map((text, index) => (
          <button
            aria-pressed={selectedTextId === text.textId}
            key={text.textId}
            onClick={() => onSelect(text.textId)}
            type="button"
          >
            {index + 1}. {text.content || '空文字层'}
          </button>
        ))}
      </div>
      <TextLayerForm
        busy={busy}
        key={selected?.textId ?? 'new-text'}
        onCommand={onCommand}
        onInvalid={onInvalid}
        onSelect={onSelect}
        selected={selected}
        totalDurationUs={totalDurationUs}
      />
    </div>
  );
}

function TextLayerForm({
  busy,
  onCommand,
  onInvalid,
  onSelect,
  selected,
  totalDurationUs
}: {
  readonly busy: boolean;
  readonly onCommand: (command: VideoEditorUpdateDto, message: string) => void;
  readonly onInvalid: (message: string) => void;
  readonly onSelect: (textId: string) => void;
  readonly selected?: VideoEditorTextOverlayDto;
  readonly totalDurationUs: number;
}) {
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right'>(
    selected?.style.alignment === 'left' || selected?.style.alignment === 'right'
      ? selected.style.alignment
      : 'center'
  );
  const [entrance, setEntrance] = useState<'none' | 'fade_in'>(
    selected?.entrance === 'fade_in' ? 'fade_in' : 'none'
  );
  const [exit, setExit] = useState<'none' | 'fade_out'>(
    selected?.exit === 'fade_out' ? 'fade_out' : 'none'
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const content = String(data.get('content')).trim();
    const fontFamily = String(data.get('fontFamily')).trim();
    const startUs = millisecondsToUs(formNumber(form, 'startMs'));
    const endUs = millisecondsToUs(formNumber(form, 'endMs'));
    const fontSizeMilliPx = Math.round(formNumber(form, 'fontSizePx') * 1000);
    const opacityPermille = percentToPermille(formNumber(form, 'opacityPercent'));
    const xPermille = percentToPermille(formNumber(form, 'xPercent'));
    const yPermille = percentToPermille(formNumber(form, 'yPercent'));
    if (!content) {
      onInvalid('文字内容不能为空。');
      return;
    }
    if (!fontFamily || !document.fonts.check(`16px ${JSON.stringify(fontFamily)}`)) {
      onInvalid(`系统未检测到字体“${fontFamily || '未填写'}”，请更换字体后保存。`);
      return;
    }
    if (
      ![startUs, endUs, fontSizeMilliPx, opacityPermille, xPermille, yPermille]
        .every(Number.isSafeInteger) ||
      startUs < 0 ||
      endUs <= startUs ||
      endUs > totalDurationUs ||
      fontSizeMilliPx <= 0 ||
      opacityPermille < 0 ||
      opacityPermille > 1000 ||
      xPermille < 0 ||
      xPermille > 1000 ||
      yPermille < 0 ||
      yPermille > 1000
    ) {
      onInvalid('文字时间、字号、位置或透明度无效，且结束时间不能越过项目时长。');
      return;
    }
    onCommand(
      {
        kind: 'upsert_text',
        text: {
          ...(selected ? { textId: selected.textId } : {}),
          content,
          range: { startUs, endUs },
          style: {
            requestedFontFamily: fontFamily,
            ...(selected?.style.requestedFontFamily === fontFamily &&
            selected.style.resolvedFontId
              ? { resolvedFontId: selected.style.resolvedFontId }
              : {}),
            fontSizeMilliPx,
            alignment,
            opacityPermille,
            color: String(data.get('color'))
          },
          position: { xPermille, yPermille },
          entrance,
          exit
        }
      },
      selected ? '文字层修改已保存。' : '新文字层已添加。'
    );
  }

  return (
    <form className="uc-video-editor__form" onSubmit={submit}>
      <h3>{selected ? '编辑文字层' : '新建文字层'}</h3>
      <label>文字内容<Input as="textarea" defaultValue={selected?.content ?? ''} name="content" rows={3} /></label>
      <label>开始（毫秒）<InputNumber defaultValue={(selected?.range.startUs ?? 0) / 1000} min={0} name="startMs" step={1} /></label>
      <label>结束（毫秒）<InputNumber defaultValue={(selected?.range.endUs ?? totalDurationUs) / 1000} min={1} name="endMs" step={1} /></label>
      <label>字体<Input defaultValue={selected?.style.requestedFontFamily ?? defaultTextFontFamily} name="fontFamily" /></label>
      <label>字号（px）<InputNumber defaultValue={(selected?.style.fontSizeMilliPx ?? 32_000) / 1000} min={1} name="fontSizePx" step={0.1} /></label>
      <div className="uc-rsuite-field">对齐<SelectPicker aria-label="对齐" cleanable={false} data={[{ value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' }]} onChange={(value) => setAlignment(value === 'left' || value === 'right' ? value : 'center')} searchable={false} value={alignment} /></div>
      <label>水平位置（%）<InputNumber defaultValue={(selected?.position.xPermille ?? 500) / 10} max={100} min={0} name="xPercent" step={0.1} /></label>
      <label>垂直位置（%）<InputNumber defaultValue={(selected?.position.yPermille ?? 850) / 10} max={100} min={0} name="yPercent" step={0.1} /></label>
      <label>透明度（%）<InputNumber defaultValue={(selected?.style.opacityPermille ?? 1000) / 10} max={100} min={0} name="opacityPercent" step={0.1} /></label>
      <label>颜色<Input defaultValue={selected?.style.color ?? '#ffffff'} name="color" type="color" /></label>
      <div className="uc-rsuite-field">出现<SelectPicker aria-label="出现" cleanable={false} data={[{ value: 'none', label: '直接出现' }, { value: 'fade_in', label: '淡入' }]} onChange={(value) => setEntrance(value === 'fade_in' ? 'fade_in' : 'none')} searchable={false} value={entrance} /></div>
      <div className="uc-rsuite-field">消失<SelectPicker aria-label="消失" cleanable={false} data={[{ value: 'none', label: '直接消失' }, { value: 'fade_out', label: '淡出' }]} onChange={(value) => setExit(value === 'fade_out' ? 'fade_out' : 'none')} searchable={false} value={exit} /></div>
      <Button disabled={busy || totalDurationUs <= 0} type="submit">
        {selected ? '保存文字层' : '添加文字层'}
      </Button>
      {selected ? (
        <Button
          disabled={busy}
          onClick={() => {
            onCommand(
              { kind: 'remove_text', textId: selected.textId },
              '文字层已删除。'
            );
            onSelect('');
          }}
          variant="ghost"
        >
          删除文字层
        </Button>
      ) : null}
    </form>
  );
}

function AudioInspector({
  backgroundMusic,
  busy,
  clip,
  onCommand,
  onInvalid,
  onSelectMusic,
  totalDurationUs
}: {
  readonly backgroundMusic: VideoEditorBackgroundMusicDto | null;
  readonly busy: boolean;
  readonly clip?: VideoEditorClipDto;
  readonly onCommand: (command: VideoEditorUpdateDto, message: string) => void;
  readonly onInvalid: (message: string) => void;
  readonly onSelectMusic: () => void;
  readonly totalDurationUs: number;
}) {
  function submitSourceAudio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!clip) return;
    const form = event.currentTarget;
    const volumePermille = percentToPermille(formNumber(form, 'volumePercent'));
    if (!Number.isSafeInteger(volumePermille) || volumePermille < 0 || volumePermille > 1000) {
      onInvalid('原声音量必须在 0% 到 100% 之间。');
      return;
    }
    onCommand(
      {
        kind: 'set_source_audio',
        clipId: clip.clipId,
        sourceAudio: {
          muted: new FormData(form).has('muted'),
          volumePermille
        }
      },
      '当前片段原声设置已保存。'
    );
  }

  function submitMusic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!backgroundMusic) return;
    const form = event.currentTarget;
    const sourceRange = {
      inUs: millisecondsToUs(formNumber(form, 'sourceStartMs')),
      outUs: millisecondsToUs(formNumber(form, 'sourceEndMs'))
    };
    const timelineRange = {
      startUs: millisecondsToUs(formNumber(form, 'trackStartMs')),
      endUs: millisecondsToUs(formNumber(form, 'trackEndMs'))
    };
    const volumePermille = percentToPermille(formNumber(form, 'musicVolumePercent'));
    const fadeInUs = millisecondsToUs(formNumber(form, 'fadeInMs'));
    const fadeOutUs = millisecondsToUs(formNumber(form, 'fadeOutMs'));
    const values = [
      sourceRange.inUs,
      sourceRange.outUs,
      timelineRange.startUs,
      timelineRange.endUs,
      volumePermille,
      fadeInUs,
      fadeOutUs
    ];
    if (
      !values.every(Number.isSafeInteger) ||
      sourceRange.inUs < 0 ||
      sourceRange.outUs <= sourceRange.inUs ||
      sourceRange.outUs > backgroundMusic.identity.durationUs ||
      timelineRange.startUs < 0 ||
      timelineRange.endUs <= timelineRange.startUs ||
      timelineRange.endUs > totalDurationUs ||
      volumePermille < 0 ||
      volumePermille > 1000 ||
      fadeInUs < 0 ||
      fadeOutUs < 0 ||
      fadeInUs + fadeOutUs > timelineRange.endUs - timelineRange.startUs
    ) {
      onInvalid('音乐裁剪、时间、音量或淡入淡出无效，且不能越过音频或项目时长。');
      return;
    }
    onCommand(
      {
        kind: 'update_background_music',
        sourceRange,
        timelineRange,
        volumePermille,
        fadeInUs,
        fadeOutUs
      },
      '背景音乐设置已保存。'
    );
  }

  return (
    <div className="uc-video-editor__inspector-content">
      {clip ? (
        <form className="uc-video-editor__form" key={`audio-${clip.clipId}`} onSubmit={submitSourceAudio}>
          <h3>片段原声</h3>
          <Checkbox className="uc-video-editor__check" defaultChecked={clip.sourceAudio.muted} name="muted">静音当前片段</Checkbox>
          <label>原声音量（%）<InputNumber defaultValue={clip.sourceAudio.volumePermille / 10} max={100} min={0} name="volumePercent" step={0.1} /></label>
          <Button disabled={busy} type="submit">保存原声</Button>
        </form>
      ) : (
        <p className="uc-video-editor__hint">选择一个视频片段后可调整原声。</p>
      )}
      <div className="uc-video-editor__form">
        <h3>单条背景音乐</h3>
        <Button disabled={busy || totalDurationUs <= 0} onClick={onSelectMusic} variant="secondary">
          {backgroundMusic ? '替换背景音乐' : '选择背景音乐'}
        </Button>
        <p className="uc-video-editor__hint">当前使用本机安全解析的 PCM/浮点 WAV；选择新文件会替换现有音乐，不会叠加第二条。</p>
      </div>
      {backgroundMusic ? (
        <form className="uc-video-editor__form" key={backgroundMusic.fileId} onSubmit={submitMusic}>
          <h3>音乐范围与混音</h3>
          <label>源开始（毫秒）<InputNumber defaultValue={backgroundMusic.sourceRange.inUs / 1000} min={0} name="sourceStartMs" step={1} /></label>
          <label>源结束（毫秒）<InputNumber defaultValue={backgroundMusic.sourceRange.outUs / 1000} min={1} name="sourceEndMs" step={1} /></label>
          <label>时间线开始（毫秒）<InputNumber defaultValue={backgroundMusic.timelineRange.startUs / 1000} min={0} name="trackStartMs" step={1} /></label>
          <label>时间线结束（毫秒）<InputNumber defaultValue={backgroundMusic.timelineRange.endUs / 1000} min={1} name="trackEndMs" step={1} /></label>
          <label>音乐音量（%）<InputNumber defaultValue={backgroundMusic.volumePermille / 10} max={100} min={0} name="musicVolumePercent" step={0.1} /></label>
          <label>淡入（毫秒）<InputNumber defaultValue={backgroundMusic.fadeInUs / 1000} min={0} name="fadeInMs" step={1} /></label>
          <label>淡出（毫秒）<InputNumber defaultValue={backgroundMusic.fadeOutUs / 1000} min={0} name="fadeOutMs" step={1} /></label>
          <Button disabled={busy} type="submit">保存背景音乐</Button>
          <Button
            disabled={busy}
            onClick={() =>
              onCommand({ kind: 'clear_background_music' }, '背景音乐已移除。')
            }
            variant="ghost"
          >
            移除背景音乐
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function CoverInspector({
  busy,
  clips,
  cover,
  imageWorks,
  onAttachWork,
  onCommand,
  onInvalid,
  onSelectLocal,
  selectedClipId
}: {
  readonly busy: boolean;
  readonly clips: readonly VideoEditorClipDto[];
  readonly cover: VideoEditorCoverDto | null;
  readonly imageWorks: readonly StorageWorkSummaryDto[];
  readonly onAttachWork: (
    workId: string,
    prependToVideo: boolean,
    prependDurationUs?: number
  ) => void;
  readonly onCommand: (command: VideoEditorUpdateDto, message: string) => void;
  readonly onInvalid: (message: string) => void;
  readonly onSelectLocal: (
    prependToVideo: boolean,
    prependDurationUs?: number
  ) => void;
  readonly selectedClipId: string;
}) {
  const [prependToVideo, setPrependToVideo] = useState(
    cover?.prependToVideo ?? false
  );
  const [prependDurationMs, setPrependDurationMs] = useState(
    cover?.prependDurationUs ? String(cover.prependDurationUs / 1000) : ''
  );
  const [projectWorkId, setProjectWorkId] = useState(imageWorks[0]?.workId ?? '');
  const [frameClipId, setFrameClipId] = useState(
    selectedClipId || clips[0]?.clipId || ''
  );

  function submitVideoFrame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const clipId = frameClipId;
    const clip = clips.find((candidate) => candidate.clipId === clipId);
    const sourceTimeUs = millisecondsToUs(formNumber(form, 'sourceTimeMs'));
    const prependDurationUs = readPrependDuration();
    if (
      !clip ||
      !Number.isSafeInteger(sourceTimeUs) ||
      sourceTimeUs < clip.sourceRange.inUs ||
      sourceTimeUs >= clip.sourceRange.outUs ||
      prependDurationUs === null
    ) {
      onInvalid('封面选帧必须位于所选片段的有效源时间范围内。');
      return;
    }
    onCommand(
      {
        kind: 'set_cover',
        cover: {
          kind: 'video_frame',
          clipId,
          sourceTimeUs,
          prependToVideo,
          prependDurationUs: prependDurationUs ?? undefined
        }
      },
      '视频帧已设为封面。'
    );
  }

  function readPrependDuration(): number | undefined | null {
    if (!prependToVideo) return undefined;
    const milliseconds = Number(prependDurationMs);
    const durationUs = millisecondsToUs(milliseconds);
    if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(durationUs) || durationUs <= 0) {
      onInvalid('拼接封面时必须填写大于 0 的显示时长。');
      return null;
    }
    return durationUs;
  }

  function selectLocalCover(): void {
    const duration = readPrependDuration();
    if (duration !== null) onSelectLocal(prependToVideo, duration);
  }

  function attachProjectCover(): void {
    const duration = readPrependDuration();
    if (duration !== null) onAttachWork(projectWorkId, prependToVideo, duration);
  }

  return (
    <div className="uc-video-editor__inspector-content">
      <dl className="uc-video-editor__facts">
        <Fact label="当前封面" value={coverLabel(cover)} />
        <Fact
          label="视频内容"
          value={cover?.prependToVideo ? '封面将拼接到视频开头' : '封面不改变视频内容'}
        />
      </dl>
      <fieldset className="uc-video-editor__choice">
        <legend>封面是否加入视频</legend>
        <RadioGroup
          inline
          name="prependChoice"
          onChange={(value) => setPrependToVideo(value === 'prepend')}
          value={prependToVideo ? 'prepend' : 'cover'}
        >
          <Radio value="cover">仅作为封面（默认）</Radio>
          <Radio value="prepend">拼接到视频开头</Radio>
        </RadioGroup>
      </fieldset>
      {prependToVideo ? (
        <label>封面显示时长（毫秒）<InputNumber min={1} onChange={(value) => setPrependDurationMs(value === null ? '' : String(value))} step={1} value={prependDurationMs} /></label>
      ) : null}
      <form className="uc-video-editor__form" onSubmit={submitVideoFrame}>
        <h3>从视频选帧</h3>
        <div className="uc-rsuite-field">片段<SelectPicker aria-label="片段" cleanable={false} data={clips.map((clip, index) => ({ value: clip.clipId, label: `片段 ${index + 1}` }))} onChange={(value) => value && setFrameClipId(value)} searchable={false} value={frameClipId || null} /></div>
        <label>源时间（毫秒）<InputNumber defaultValue={(clips.find((clip) => clip.clipId === selectedClipId)?.sourceRange.inUs ?? clips[0]?.sourceRange.inUs ?? 0) / 1000} min={0} name="sourceTimeMs" step={1} /></label>
        <Button disabled={busy || clips.length === 0} type="submit">使用视频帧</Button>
      </form>
      <div className="uc-video-editor__form">
        <h3>本机图片</h3>
        <Button disabled={busy} onClick={selectLocalCover} variant="secondary">选择并校验图片</Button>
      </div>
      <div className="uc-video-editor__form">
        <h3>项目图片作品</h3>
        <div className="uc-rsuite-field">图片作品<SelectPicker aria-label="图片作品" cleanable={false} data={imageWorks.map((work) => ({ value: work.workId, label: work.name }))} disabled={imageWorks.length === 0} onChange={(value) => setProjectWorkId(value ?? '')} placeholder={imageWorks.length === 0 ? '暂无项目图片' : undefined} value={projectWorkId || null} /></div>
        <Button disabled={busy || !projectWorkId} onClick={attachProjectCover} variant="secondary">使用项目图片</Button>
      </div>
      {cover ? (
        <Button
          disabled={busy}
          onClick={() => onCommand({ kind: 'set_cover', cover: null }, '封面已清除。')}
          variant="ghost"
        >
          清除封面
        </Button>
      ) : null}
    </div>
  );
}

function ExportInspector({
  busy,
  confirmed,
  draft,
  media,
  onCancel,
  onConfirm,
  onNavigate,
  onPreflight,
  onReveal,
  onRetry,
  onSave,
  onStart,
  preflight,
  task,
  totalDurationUs
}: {
  readonly busy: boolean;
  readonly confirmed: boolean;
  readonly draft: VideoEditorDraftDto;
  readonly media?: StorageLocalMediaHandleDto;
  readonly onCancel: () => void;
  readonly onConfirm: (confirmed: boolean) => void;
  readonly onNavigate?: (itemId: 'tasks' | 'library') => void;
  readonly onPreflight: () => void;
  readonly onReveal: () => void;
  readonly onRetry: () => void;
  readonly onSave: (preference: VideoEditorOutputPreferenceDto) => void;
  readonly onStart: () => void;
  readonly preflight?: VideoEditorExportPreflightDto;
  readonly task?: VideoEditorExportTaskDto;
  readonly totalDurationUs: number;
}) {
  const [fileName, setFileName] = useState(
    draft.outputPreference.fileName ?? draft.title
  );
  const [conflictPolicy, setConflictPolicy] = useState(
    draft.outputPreference.conflictPolicy
  );
  const [resultPreviewExpanded, setResultPreviewExpanded] = useState(false);
  const state = exportStateDisplay(task?.state);
  const completed = task?.state === 'completed' && Boolean(task.workId);
  const active = Boolean(task && isExportPollingState(task.state));
  const preferencesDirty =
    fileName.trim() !== (draft.outputPreference.fileName ?? draft.title) ||
    conflictPolicy !== draft.outputPreference.conflictPolicy;
  const currentPreflight = preferencesDirty ? undefined : preflight;

  useEffect(() => {
    if (!resultPreviewExpanded || !completed) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setResultPreviewExpanded(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [completed, resultPreviewExpanded]);

  function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave({
      ...draft.outputPreference,
      fileName: fileName.trim() || undefined,
      conflictPolicy
    });
  }

  return (
    <div className="uc-video-editor__inspector-content uc-video-editor__export">
      <form className="uc-video-editor__form" onSubmit={savePreferences}>
        <h3>输出文件</h3>
        <label>
          文件名
          <Input
            maxLength={80}
            onChange={(value) => setFileName(value)}
            placeholder="视频作品名称"
            value={fileName}
          />
        </label>
        <div className="uc-rsuite-field">
          同名冲突
          <SelectPicker
            aria-label="同名冲突"
            cleanable={false}
            data={[
              { value: 'create_unique_name', label: '创建独立版本（推荐）' },
              { value: 'fail', label: '同名时停止' }
            ]}
            onChange={(value) =>
              setConflictPolicy(value === 'fail' ? 'fail' : 'create_unique_name')
            }
            searchable={false}
            value={conflictPolicy}
          />
        </div>
        <Button
          disabled={busy || !fileName.trim() || !preferencesDirty}
          type="submit"
          variant="secondary"
        >
          保存导出设置
        </Button>
        {preferencesDirty ? <p>设置尚未保存；保存后才能执行预检或开始导出。</p> : null}
      </form>

      <section className="uc-video-editor__export-confirmation">
        <div className="uc-video-editor__export-heading">
          <h3>导出确认</h3>
          <StatusPill
            tone={currentPreflight?.ready ? 'success' : currentPreflight ? 'warning' : 'neutral'}
          >
            {preferencesDirty
              ? '设置未保存'
              : currentPreflight?.ready
                ? '预检通过'
                : currentPreflight
                  ? '预检未通过'
                  : '尚未预检'}
          </StatusPill>
        </div>
        <dl className="uc-video-editor__facts">
          <Fact
            label="来源"
            value={`${draft.videoTrack.length} 个视频片段 · ${formatTime(totalDurationUs)}`}
          />
          <Fact
            label="目标"
            value={`当前项目独立结果 · ${fileName.trim() || draft.title}.webm`}
          />
          <Fact
            label="格式"
            value={currentPreflight
              ? `${currentPreflight.output.container.toUpperCase()} · ${currentPreflight.output.videoCodec} · ${currentPreflight.output.audioCodec}`
              : '等待媒体引擎真实预检'}
          />
          <Fact label="质量" value="源分辨率 · 源帧率 · 当前引擎质量策略" />
          <Fact
            label="硬件策略"
            value={currentPreflight
              ? hardwarePolicyLabel(currentPreflight.output.hardwareAcceleration)
              : '等待媒体引擎真实预检'}
          />
          <Fact
            label="空间状态"
            value={exportSpaceLabel(currentPreflight, task)}
          />
        </dl>
        {currentPreflight && !currentPreflight.ready ? (
          <ul className="uc-video-editor__export-reasons" role="alert">
            {currentPreflight.reasons.map((reason) => (
              <li key={reason}>{exportReasonLabel(reason)}</li>
            ))}
          </ul>
        ) : null}
        <Button disabled={busy || preferencesDirty} onClick={onPreflight} variant="secondary">
          {currentPreflight ? '重新执行预检' : '执行导出预检'}
        </Button>
        {currentPreflight?.ready ? (
          <Checkbox
            checked={confirmed}
            className="uc-video-editor__export-check"
            onChange={(_value, checked) => onConfirm(checked)}
          >
            我已核对来源、目标、格式、质量、硬件策略和空间校验时机
          </Checkbox>
        ) : null}
        <Button
          disabled={busy || active || !currentPreflight?.ready || !confirmed}
          onClick={onStart}
        >
          {active ? '已有导出正在执行' : '创建独立导出版本'}
        </Button>
      </section>

      {task ? (
        <section className="uc-video-editor__export-task" aria-live="polite">
          <div className="uc-video-editor__export-heading">
            <h3>后台任务 · 第 {task.attempt} 次尝试</h3>
            <StatusPill tone={state.tone}>{state.label}</StatusPill>
          </div>
          <progress
            aria-label="导出进度"
            max="100"
            value={Math.max(0, Math.min(100, task.progress?.percent ?? 0))}
          />
          <p>
            {task.progress?.percent === undefined
              ? '当前阶段尚未报告百分比。'
              : `已处理 ${task.progress.percent.toFixed(1)}%`}
          </p>
          {task.attempt > 1 ? (
            <p>旧尝试没有被覆盖；全部真实尝试可在任务中心查看。</p>
          ) : null}
          {task.requiredAction ? (
            <p className="uc-video-editor__source-issue">
              {requiredActionLabel(task.requiredAction.code)}：
              {exportReasonLabel(task.requiredAction.message)}
            </p>
          ) : null}
          {task.failure ? (
            <p className="uc-video-editor__source-issue">
              失败：{exportReasonLabel(task.failure.message)}（
              {retryabilityLabel(task.failure.retryability)}）
            </p>
          ) : null}
          <div className="uc-video-editor__export-actions">
            {task.canCancel ? (
              <Button disabled={busy} onClick={onCancel} variant="secondary">
                请求取消
              </Button>
            ) : null}
            {task.canRetry ? (
              <Button disabled={busy} onClick={onRetry} variant="secondary">
                创建新尝试
              </Button>
            ) : null}
            {onNavigate ? (
              <Button onClick={() => onNavigate('tasks')} variant="ghost">
                打开任务中心
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {completed ? (
        <section className="uc-video-editor__export-result">
          <div className="uc-video-editor__export-heading">
            <h3>导出成功</h3>
            <StatusPill tone="success">作品已登记</StatusPill>
          </div>
          <p>文件已经过独立探测、校验、发布并登记为新作品。</p>
          {media?.mediaKind === 'video' ? (
            <div
              className={`uc-video-editor__export-preview${resultPreviewExpanded ? ' uc-video-editor__export-preview--expanded' : ''}`}
            >
              <video
                aria-label="已登记导出作品预览"
                className="uc-video-editor__export-preview-video"
                controls
                controlsList="nofullscreen"
                playsInline
                preload="metadata"
                src={media.url}
              />
              <button
                aria-label={resultPreviewExpanded ? '退出导出视频全屏预览' : '全屏预览导出视频'}
                aria-pressed={resultPreviewExpanded}
                className="uc-video-editor__export-preview-fullscreen"
                onClick={() => setResultPreviewExpanded((value) => !value)}
                title={resultPreviewExpanded ? '退出全屏' : '全屏预览'}
                type="button"
              >
                {resultPreviewExpanded ? (
                  <LuMinimize2 aria-hidden="true" />
                ) : (
                  <LuMaximize2 aria-hidden="true" />
                )}
              </button>
            </div>
          ) : null}
          <div className="uc-video-editor__export-actions">
            <Button disabled={busy} onClick={onReveal} variant="secondary">
              在文件管理器中定位
            </Button>
            {onNavigate ? (
              <Button onClick={() => onNavigate('library')}>打开作品库</Button>
            ) : null}
          </div>
        </section>
      ) : null}
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
      sourceOutUs: clip.sourceRange.outUs,
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

export function resolveTimelineWheelZoom({
  currentPixelsPerSecond,
  deltaY,
  pointerOffsetPx,
  scrollLeft,
  totalDurationUs,
  viewportWidth
}: TimelineWheelZoomInput): {
  readonly pixelsPerSecond: number;
  readonly scrollLeft: number;
} {
  if (
    currentPixelsPerSecond <= 0 ||
    totalDurationUs <= 0 ||
    viewportWidth <= 0
  ) {
    return {
      pixelsPerSecond: Math.max(0, currentPixelsPerSecond),
      scrollLeft: Math.max(0, scrollLeft)
    };
  }
  const totalDurationSeconds = totalDurationUs / 1_000_000;
  const fitPixelsPerSecond = viewportWidth / totalDurationSeconds;
  const maximumPixelsPerSecond = Math.max(
    fitPixelsPerSecond,
    timelineMaximumPixelsPerSecond
  );
  const pixelsPerSecond = Math.min(
    maximumPixelsPerSecond,
    Math.max(
      fitPixelsPerSecond,
      currentPixelsPerSecond * Math.exp(-deltaY * timelineWheelSensitivity)
    )
  );
  const pointer = Math.min(viewportWidth, Math.max(0, pointerOffsetPx));
  const anchorSeconds = (Math.max(0, scrollLeft) + pointer) /
    currentPixelsPerSecond;
  const maximumScrollLeft = Math.max(
    0,
    totalDurationSeconds * pixelsPerSecond - viewportWidth
  );
  const nextScrollLeft = Math.min(
    maximumScrollLeft,
    Math.max(0, anchorSeconds * pixelsPerSecond - pointer)
  );
  return { pixelsPerSecond, scrollLeft: nextScrollLeft };
}

export function resolveTimelineHorizontalWheelDelta({
  deltaX,
  deltaY,
  deltaMode,
  shiftKey,
  viewportHeight
}: TimelineHorizontalWheelInput): number {
  const rawDelta = deltaX !== 0 ? deltaX : shiftKey ? deltaY : 0;
  if (rawDelta === 0) return 0;
  const multiplier = deltaMode === 1
    ? 16
    : deltaMode === 2
      ? Math.max(1, viewportHeight)
      : 1;
  return rawDelta * multiplier;
}

export function resolveTimelineEdgeAutoScroll({
  clientX,
  viewportLeft,
  viewportWidth,
  scrollLeft,
  scrollWidth
}: TimelineEdgeAutoScrollInput): number {
  const maximumScrollLeft = Math.max(0, scrollWidth - viewportWidth);
  const boundedScrollLeft = Math.min(
    maximumScrollLeft,
    Math.max(0, scrollLeft)
  );
  if (viewportWidth <= 0 || maximumScrollLeft <= 0) return boundedScrollLeft;
  const edgeWidth = Math.min(64, Math.max(24, viewportWidth * 0.12));
  const leftEdge = viewportLeft + edgeWidth;
  const rightEdge = viewportLeft + viewportWidth - edgeWidth;
  let strength = 0;
  if (clientX < leftEdge) {
    strength = -Math.min(1, (leftEdge - clientX) / edgeWidth);
  } else if (clientX > rightEdge) {
    strength = Math.min(1, (clientX - rightEdge) / edgeWidth);
  }
  if (strength === 0) return boundedScrollLeft;
  const delta = Math.sign(strength) * Math.ceil(4 + 24 * Math.abs(strength));
  return Math.min(
    maximumScrollLeft,
    Math.max(0, boundedScrollLeft + delta)
  );
}

export function buildTimelineRulerTicks(
  totalDurationUs: number,
  pixelsPerSecond: number,
  viewportStartPx = 0,
  viewportEndPx = (totalDurationUs / 1_000_000) * pixelsPerSecond,
  overscanPx = 0
): readonly TimelineRulerTick[] {
  if (totalDurationUs <= 0 || pixelsPerSecond <= 0) return [];
  const rawStepSeconds = timelineRulerTargetGapPx / pixelsPerSecond;
  const magnitude = 10 ** Math.floor(Math.log10(rawStepSeconds));
  const normalized = rawStepSeconds / magnitude;
  const niceMultiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const stepUs = Math.max(
    1,
    Math.round(niceMultiplier * magnitude * 1_000_000)
  );
  const visibleStartPx = Math.max(0, viewportStartPx - Math.max(0, overscanPx));
  const visibleEndPx = viewportEndPx + Math.max(0, overscanPx);
  const visibleStartUs = (visibleStartPx / pixelsPerSecond) * 1_000_000;
  const visibleEndUs = Math.min(
    totalDurationUs,
    (visibleEndPx / pixelsPerSecond) * 1_000_000
  );
  const firstTickUs = Math.ceil(visibleStartUs / stepUs) * stepUs;
  const ticks: TimelineRulerTick[] = [];
  for (
    let timeUs = firstTickUs;
    timeUs <= visibleEndUs;
    timeUs += stepUs
  ) {
    ticks.push({
      timeUs,
      leftPx: (timeUs / 1_000_000) * pixelsPerSecond,
      label: formatTime(timeUs)
    });
  }
  return ticks;
}

export function buildTimelineThumbnailSlots(
  segments: readonly TimelineSegment[],
  pixelsPerSecond: number,
  viewportStartPx: number,
  viewportEndPx: number,
  overscanPx: number
): readonly TimelineThumbnailSlot[] {
  if (pixelsPerSecond <= 0 || viewportEndPx < viewportStartPx) return [];
  const visibleStartPx = Math.max(0, viewportStartPx - Math.max(0, overscanPx));
  const visibleEndPx = viewportEndPx + Math.max(0, overscanPx);
  const slots: TimelineThumbnailSlot[] = [];
  for (const segment of segments) {
    const segmentLeftPx = (segment.startUs / 1_000_000) * pixelsPerSecond;
    const segmentWidthPx = (segment.durationUs / 1_000_000) * pixelsPerSecond;
    if (segmentWidthPx <= 0) continue;
    const slotCount = Math.max(
      1,
      Math.ceil(segmentWidthPx / timelineThumbnailWidthPx)
    );
    const widthPx = segmentWidthPx / slotCount;
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const leftPx = segmentLeftPx + slotIndex * widthPx;
      if (leftPx > visibleEndPx || leftPx + widthPx < visibleStartPx) continue;
      const timelineOffsetUs = Math.round(
        (segment.durationUs * (slotIndex + 0.5)) / slotCount
      );
      const sourceOffsetUs = Number(
        (BigInt(timelineOffsetUs) * BigInt(segment.speedNumerator)) /
          BigInt(segment.speedDenominator)
      );
      const sourceUs = Math.min(
        segment.sourceOutUs,
        Math.max(segment.sourceInUs, segment.sourceInUs + sourceOffsetUs)
      );
      slots.push({
        key: `${segment.clipId}:${sourceUs}`,
        clipId: segment.clipId,
        slotIndex,
        sourceUs,
        leftPx,
        widthPx
      });
    }
  }
  return slots;
}

export function resolveTimelineDropIndex(
  sourceIndex: number,
  targetIndex: number,
  placeAfter: boolean
): number {
  const insertionIndex = targetIndex + (placeAfter ? 1 : 0);
  return insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex;
}

export function resolveTimelineSegmentAt(
  segments: readonly TimelineSegment[],
  playheadUs: number
): TimelineSegment | undefined {
  const segment = segments.find(
    (candidate) =>
      playheadUs >= candidate.startUs && playheadUs < candidate.endUs
  );
  if (segment) return segment;
  const lastSegment = segments.at(-1);
  return lastSegment?.endUs === playheadUs ? lastSegment : undefined;
}

export function resolveTimelinePositionUs(
  clientX: number,
  laneLeft: number,
  laneWidth: number,
  totalDurationUs: number
): number {
  if (laneWidth <= 0 || totalDurationUs <= 0) return 0;
  const offset = Math.min(laneWidth, Math.max(0, clientX - laneLeft));
  return Math.round((offset / laneWidth) * totalDurationUs);
}

export function resolveBackgroundMusicPlayback(
  music: VideoEditorBackgroundMusicDto,
  timelineUs: number
): { readonly sourceUs: number; readonly volumePermille: number } | undefined {
  if (
    timelineUs < music.timelineRange.startUs ||
    timelineUs >= music.timelineRange.endUs
  ) {
    return undefined;
  }
  const timelineOffset = timelineUs - music.timelineRange.startUs;
  const remainingUs = music.timelineRange.endUs - timelineUs;
  const fadeInScale =
    music.fadeInUs > 0 ? Math.min(1, timelineOffset / music.fadeInUs) : 1;
  const fadeOutScale =
    music.fadeOutUs > 0 ? Math.min(1, remainingUs / music.fadeOutUs) : 1;
  return {
    sourceUs: Math.min(
      music.sourceRange.outUs,
      music.sourceRange.inUs + timelineOffset
    ),
    volumePermille: Math.round(
      music.volumePermille * Math.min(fadeInScale, fadeOutScale)
    )
  };
}

function timelineToSourceUs(
  draft: VideoEditorDraftDto,
  clipId: string,
  playheadUs: number
): number {
  const segment = buildTimelineSegments(draft.videoTrack).find(
    (candidate) => candidate.clipId === clipId
  );
  const clip = draft.videoTrack.find((candidate) => candidate.clipId === clipId);
  if (!segment || !clip) return 0;
  const timelineOffset = Math.min(
    segment.durationUs,
    Math.max(0, playheadUs - segment.startUs)
  );
  const sourceOffset = Number(
    (BigInt(timelineOffset) * BigInt(segment.speedNumerator)) /
      BigInt(segment.speedDenominator)
  );
  return Math.min(
    clip.sourceRange.outUs,
    Math.max(clip.sourceRange.inUs, clip.sourceRange.inUs + sourceOffset)
  );
}

function revokeFrameUrlMap(cache: Map<string, string>): void {
  for (const frameUrl of cache.values()) URL.revokeObjectURL(frameUrl);
  cache.clear();
}

function cacheTimelineFrame(
  cache: Map<string, string>,
  key: string,
  frameUrl: string
): readonly string[] {
  const previous = cache.get(key);
  if (previous && previous !== frameUrl) URL.revokeObjectURL(previous);
  cache.delete(key);
  cache.set(key, frameUrl);
  const evictedKeys: string[] = [];
  while (cache.size > timelineFrameCacheLimit) {
    const oldest = cache.entries().next().value as
      | [string, string]
      | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
    evictedKeys.push(oldest[0]);
  }
  return evictedKeys;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  maximumConcurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(maximumConcurrency))
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    })
  );
}

/**
 * 每个素材批次只创建一个 video，并在同一解码器上顺序定位可见帧。
 * 任一帧失败只保留占位，不阻塞编辑，也不触发草稿写入。
 */
async function extractTimelineFrameBatch(
  previewUrl: string,
  requests: readonly TimelineFrameRequest[],
  signal: AbortSignal,
  isCancelled: () => boolean,
  onFrames: (frames: readonly ExtractedTimelineFrame[]) => void
): Promise<void> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.src = previewUrl;
  const extractedFrames: ExtractedTimelineFrame[] = [];
  try {
    if (!(await waitForVideoReady(video, signal))) return;
    const orderedRequests = [...requests].sort(
      (left, right) => left.sourceUs - right.sourceUs
    );
    for (const request of orderedRequests) {
      if (isCancelled()) break;
      if (!(await seekVideoFrame(video, request.sourceUs, signal))) continue;
      if (isCancelled()) break;
      const frameUrl = await captureTimelineFrame(video);
      if (!frameUrl) continue;
      if (isCancelled()) {
        URL.revokeObjectURL(frameUrl);
        break;
      }
      extractedFrames.push({ request, frameUrl });
    }
    if (isCancelled()) {
      for (const frame of extractedFrames) URL.revokeObjectURL(frame.frameUrl);
      return;
    }
    if (extractedFrames.length > 0) onFrames(extractedFrames);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function waitForVideoReady(
  video: HTMLVideoElement,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onLoaded = () => finish(true);
    const onError = () => finish(false);
    const onAbort = () => finish(false);
    const timer = window.setTimeout(() => finish(false), 10_000);
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    video.load();
  });
}

async function seekVideoFrame(
  video: HTMLVideoElement,
  sourceUs: number,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  const maximumSeconds = Number.isFinite(video.duration)
    ? Math.max(0, video.duration - 0.001)
    : Number.POSITIVE_INFINITY;
  const targetSeconds = Math.min(
    maximumSeconds,
    Math.max(0, sourceUs / 1_000_000)
  );
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    !video.seeking &&
    Math.abs(video.currentTime - targetSeconds) <= 0.001
  ) {
    await waitForPresentedVideoFrame(video, signal);
    return !signal.aborted;
  }
  const sought = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onSeeked = () => finish(true);
    const onError = () => finish(false);
    const onAbort = () => finish(false);
    const timer = window.setTimeout(() => finish(false), 5_000);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      video.currentTime = targetSeconds;
    } catch {
      finish(false);
    }
  });
  if (!sought || signal.aborted) return false;
  await waitForPresentedVideoFrame(video, signal);
  return !signal.aborted;
}

function waitForPresentedVideoFrame(
  video: HTMLVideoElement,
  signal: AbortSignal
): Promise<void> {
  if (
    signal.aborted ||
    typeof video.requestVideoFrameCallback !== 'function'
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let callbackId: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      if (callbackId !== undefined) {
        video.cancelVideoFrameCallback(callbackId);
      }
      resolve();
    };
    const timer = window.setTimeout(finish, timelineFramePresentationTimeoutMs);
    signal.addEventListener('abort', finish, { once: true });
    callbackId = video.requestVideoFrameCallback(finish);
  });
}

function captureTimelineFrame(
  video: HTMLVideoElement
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const sourceWidth = Math.max(2, video.videoWidth);
      const sourceHeight = Math.max(2, video.videoHeight);
      const sourceRatio = sourceWidth / sourceHeight;
      const targetRatio =
        timelineThumbnailRenderWidthPx / timelineThumbnailRenderHeightPx;
      let sourceX = 0;
      let sourceY = 0;
      let cropWidth = sourceWidth;
      let cropHeight = sourceHeight;
      if (sourceRatio > targetRatio) {
        cropWidth = sourceHeight * targetRatio;
        sourceX = (sourceWidth - cropWidth) / 2;
      } else if (sourceRatio < targetRatio) {
        cropHeight = sourceWidth / targetRatio;
        sourceY = (sourceHeight - cropHeight) / 2;
      }
      const canvas = document.createElement('canvas');
      canvas.width = timelineThumbnailRenderWidthPx;
      canvas.height = timelineThumbnailRenderHeightPx;
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(undefined);
        return;
      }
      context.drawImage(
        video,
        sourceX,
        sourceY,
        cropWidth,
        cropHeight,
        0,
        0,
        canvas.width,
        canvas.height
      );
      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : undefined),
        'image/jpeg',
        0.72
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * S4 片段可读命名（纯前端派生，不落库）：
 * 1) 来源为当前项目视频作品 → 作品名；
 * 2) 否则有 fileId → “片段 N · 前 6 位短码”；
 * 3) 兜底 → “片段 N”。
 */
export function resolveClipDisplayName(
  clip: Pick<VideoEditorClipDto, 'source'>,
  index: number,
  videoWorks: readonly StorageWorkSummaryDto[]
): string {
  const workId = clip.source.workId;
  if (workId) {
    const work = videoWorks.find((item) => item.workId === workId);
    if (work) return work.name;
  }
  const shortCode = clip.source.fileId.slice(0, 6);
  return shortCode ? `片段 ${index + 1} · ${shortCode}` : `片段 ${index + 1}`;
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

export function selectedCanvasRatioLabel(draft: VideoEditorDraftDto): string {
  if (draft.canvas.aspectRatio.kind === 'ratio') {
    const preset = canvasRatioPresets.find((item) =>
      canvasRatioMatches(draft.canvas, item.numerator, item.denominator)
    );
    return preset?.key ?? `${draft.canvas.aspectRatio.numerator}:${draft.canvas.aspectRatio.denominator}`;
  }
  const identity = draft.videoTrack[0]?.source.identity;
  if (!identity || identity.width <= 0 || identity.height <= 0) return '原始比例';
  const divisor = greatestCommonDivisor(identity.width, identity.height);
  return `${identity.width / divisor}:${identity.height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

export function canvasPreviewAspectRatio(draft: {
  readonly canvas: Pick<VideoEditorCanvasDto, 'aspectRatio'>;
  readonly videoTrack: readonly {
    readonly source: {
      readonly identity: { readonly width: number; readonly height: number };
    };
  }[];
}): string {
  if (draft.canvas.aspectRatio.kind === 'ratio') {
    return `${draft.canvas.aspectRatio.numerator} / ${draft.canvas.aspectRatio.denominator}`;
  }
  const sourceIdentity = draft.videoTrack[0]?.source.identity;
  return sourceIdentity && sourceIdentity.width > 0 && sourceIdentity.height > 0
    ? `${sourceIdentity.width} / ${sourceIdentity.height}`
    : '16 / 9';
}

function canvasRatioMatches(
  canvas: VideoEditorCanvasDto,
  numerator: number,
  denominator: number
): boolean {
  return canvas.aspectRatio.kind === 'ratio' &&
    canvas.aspectRatio.numerator * denominator === numerator * canvas.aspectRatio.denominator;
}

function coverLabel(cover: VideoEditorCoverDto | null): string {
  if (!cover) return '未设置';
  if (cover.kind === 'video_frame') return '视频选帧';
  if (cover.kind === 'local_image') return '本机图片';
  return '项目图片作品';
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

function fileStateLabel(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    pending: '等待写入',
    writing: '写入中',
    verifying: '校验中',
    available: '本地可用',
    missing: '文件丢失',
    read_only: '只读',
    disconnected: '存储已断开',
    corrupted: '文件损坏',
    deleted: '已删除'
  };
  return labels[state] ?? '未知文件状态';
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
      return { label: '未知文件状态', tone: status.relinkRequired ? 'warning' : 'neutral' };
  }
}

async function findLatestExportForDraft(
  storage: StorageApi,
  videoEditors: VideoEditorApi,
  projectId: string,
  draftId: string
): Promise<VideoEditorExportTaskDto | undefined> {
  const listed = await storage.listTasks();
  if (!listed.ok) throw new Error('Unable to list export tasks');
  const candidates = listed.value.items
    .filter((task) => task.projectId === projectId && task.kind === 'video_editing')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const candidate of candidates) {
    const details = await storage.getTaskDetails(candidate.taskId);
    if (!details.ok || details.value?.sourceDraftId !== draftId) continue;
    const task = await videoEditors.getExport(candidate.taskId);
    return task.ok ? task.value : undefined;
  }
  return undefined;
}

const pollingExportStates = new Set([
  'queued',
  'validating_sources',
  'preparing_media',
  'encoding',
  'writing_file',
  'verifying_file',
  'registering_work',
  'cancel_requested'
]);

function isExportPollingState(state: string): boolean {
  return pollingExportStates.has(state);
}

function exportStateDisplay(state?: string): { readonly label: string; readonly tone: StatusTone } {
  const states: Record<string, { readonly label: string; readonly tone: StatusTone }> = {
    queued: { label: '排队中', tone: 'info' },
    validating_sources: { label: '正在校验素材', tone: 'info' },
    preparing_media: { label: '正在准备媒体', tone: 'info' },
    encoding: { label: '正在编码', tone: 'info' },
    writing_file: { label: '正在写入文件', tone: 'info' },
    verifying_file: { label: '正在校验文件', tone: 'info' },
    registering_work: { label: '正在登记作品', tone: 'info' },
    completed: { label: '已完成', tone: 'success' },
    cancel_requested: { label: '正在请求取消', tone: 'warning' },
    cancelled: { label: '已取消', tone: 'neutral' },
    needs_user_action: { label: '需要处理', tone: 'warning' },
    interrupted: { label: '执行已中断', tone: 'warning' },
    recovery_required: { label: '需要恢复', tone: 'warning' },
    failed: { label: '失败', tone: 'danger' },
    expired: { label: '已过期', tone: 'danger' }
  };
  return state
    ? states[state] ?? { label: '未知导出状态', tone: 'neutral' }
    : { label: '尚未创建任务', tone: 'neutral' };
}

function exportSpaceLabel(
  preflight?: VideoEditorExportPreflightDto,
  task?: VideoEditorExportTaskDto
): string {
  if (task?.requiredAction?.code === 'destination_unavailable') {
    return `目标不可用：${exportReasonLabel(task.requiredAction.message)}`;
  }
  if (!preflight) return '尚未估算；执行开始时检查真实可写空间';
  return `预计 ${formatFileSize(preflight.estimatedOutputBytes)}；执行开始时检查真实可写空间`;
}

function exportReasonLabel(reason: string): string {
  if (reason.includes('timeline has no video clips')) return '时间线没有视频片段';
  if (reason.includes('approved local media engine is unavailable')) {
    return '未检测到经批准的本地媒体引擎';
  }
  if (reason.includes('capability probe failed')) return '媒体引擎能力探测失败';
  if (reason.includes('source file') || reason.includes('source identity')) {
    return '源文件不可用、已变化或无法验证';
  }
  if (reason.includes('requested font is unavailable')) return '草稿使用的字体当前不可用';
  if (reason.includes('destination is not writable')) return '目标目录不可写';
  if (reason.includes('destination space is unavailable')) return '无法读取目标磁盘空间';
  if (reason.includes('does not have enough free space')) return '目标磁盘空间不足';
  if (reason.includes('requested export destination')) return '所选目标目录不受当前管线支持';
  if (reason.includes('requested') && reason.includes('unavailable')) return '所选输出能力不可用';
  return '未知原因';
}

function hardwarePolicyLabel(value: 'software_only'): string {
  return value === 'software_only' ? '仅软件编码（当前真实能力）' : value;
}

function requiredActionLabel(code: 'source_unavailable' | 'destination_unavailable'): string {
  return code === 'source_unavailable' ? '需要恢复源文件' : '需要恢复导出目标';
}

function retryabilityLabel(value: 'retryable' | 'not_retryable' | 'unknown'): string {
  if (value === 'retryable') return '可以创建新尝试';
  if (value === 'not_retryable') return '不能直接重试';
  return '重试状态未知';
}

function formatFileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
