import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MutableRefObject, RefObject, WheelEvent } from 'react';
import {
  LuCircleAlert,
  LuCircleX,
  LuDownload,
  LuLoaderCircle,
  LuShieldCheck
} from 'react-icons/lu';
import { GenerationResultPreview } from './GenerationResultPreview';
import { StatusPill } from './StatusPill';
import type { SubmissionProgressPhase } from './SubmissionProgressSteps';
import type { StorageGenerationHistoryItemDto } from '../shared/storage-ipc';
import { imageWorkDragDataType } from '../shared/image-workspace-ipc';

interface GenerationHistoryProps {
  readonly draftId: string;
  readonly extraDraftIds?: readonly string[];
  readonly mediaKind: 'image' | 'video';
  readonly projectId: string;
  readonly refreshKey: number;
  readonly expectedWorkId?: string;
  readonly userTookOverRef: MutableRefObject<boolean>;
  readonly onWorkSelectionChange?: (workId?: string) => void;
  readonly submissionProgress: {
    readonly phase: SubmissionProgressPhase;
    readonly failureMessage?: string;
  };
}

type HistoryWork = Extract<StorageGenerationHistoryItemDto, { readonly kind: 'work' }>;

interface HistoryTask {
  readonly taskId: string;
  readonly createdAt: string;
  readonly latestExecutionState: string;
  readonly latestExecutionUpdatedAt: string;
}

export type HistoryStatus =
  | 'pending'
  | 'awaiting_receipt'
  | 'receiving'
  | 'failed'
  | 'uncertain';

interface HistoryStatusNode {
  readonly id: string;
  readonly kind: HistoryStatus;
  readonly occurredAt: string;
}

type HistoryNode =
  | { readonly kind: 'work'; readonly work: HistoryWork }
  | HistoryStatusNode;

interface AutoSelectTask {
  readonly targetWorkId: string;
  readonly startedAt: number;
  retryCount: number;
}

const AUTO_SELECT_RETRY_DELAY_MS = 600;
const AUTO_SELECT_MAX_RETRIES = 5;
const AUTO_SELECT_MAX_WAIT_MS = 6_000;

const pendingExecutionStates = new Set([
  'submitting',
  'queued',
  'processing',
  'validating_sources',
  'preparing_media',
  'encoding',
  'cancel_requested'
]);

const awaitingReceiptExecutionStates = new Set([
  'remote_completed'
]);

const receivingExecutionStates = new Set([
  'downloading',
  'writing',
  'verifying',
  'writing_file',
  'verifying_file',
  'registering_work'
]);

const uncertainExecutionStates = new Set([
  'submission_outcome_unknown',
  'cancellation_unknown',
  'needs_user_action',
  'interrupted',
  'recovery_required'
]);

const livePendingPhases = new Set<SubmissionProgressPhase>([
  'preparing',
  'requesting',
  'waiting'
]);

const liveFailedPhases = new Set<SubmissionProgressPhase>([
  'failed',
  'submission_failed'
]);

const liveUncertainPhases = new Set<SubmissionProgressPhase>([
  'uncertain',
  'submission_uncertain'
]);

export function GenerationHistory({
  draftId,
  extraDraftIds,
  mediaKind,
  projectId,
  refreshKey,
  expectedWorkId,
  userTookOverRef,
  submissionProgress,
  onWorkSelectionChange
}: GenerationHistoryProps) {
  const storage = window.unicomp?.storage;
  const [works, setWorks] = useState<readonly HistoryWork[]>([]);
  const [tasks, setTasks] = useState<readonly HistoryTask[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [liveStartedAt, setLiveStartedAt] = useState<string>();
  const [selectedWorkId, setSelectedWorkId] = useState<string>();
  const [selectedStatusId, setSelectedStatusId] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const [scrollRequest, setScrollRequest] = useState(0);
  const selectedWorkIdRef = useRef<string>();
  const selectedStatusIdRef = useRef<string>();
  const autoSelectTaskRef = useRef<AutoSelectTask>();
  const retryTimerRef = useRef<number>();
  const deadlineTimerRef = useRef<number>();
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onWorkSelectionChange?.(selectedWorkId);
  }, [onWorkSelectionChange, selectedWorkId]);

  // 当前模式下所有草稿ID（当前草稿 + 同模式兄弟草稿），用于按模式过滤历史
  const modeDraftIds = useMemo(
    () => Array.from(new Set([draftId, ...(extraDraftIds ?? [])])),
    [draftId, extraDraftIds]
  );

  useEffect(() => {
    setLiveStartedAt(undefined);
    selectedWorkIdRef.current = undefined;
    setSelectedWorkId(undefined);
    selectedStatusIdRef.current = undefined;
    setSelectedStatusId(undefined);
  }, [draftId, mediaKind]);

  // 当进入生成中阶段（preparing/requesting/waiting）且用户未主动接管选择时，重置选中项为生成中态
  const isPendingGeneration = livePendingPhases.has(submissionProgress.phase);
  useEffect(() => {
    if (isPendingGeneration && !userTookOverRef.current) {
      selectedWorkIdRef.current = undefined;
      setSelectedWorkId(undefined);
      setSelectedStatusId(undefined);
    }
  }, [isPendingGeneration]);

  useEffect(() => {
    stopAutoSelectTask();
    const targetWorkId = expectedWorkId?.trim();
    if (!targetWorkId) return;

    autoSelectTaskRef.current = {
      targetWorkId,
      startedAt: Date.now(),
      retryCount: 0
    };
    deadlineTimerRef.current = window.setTimeout(() => {
      stopAutoSelectTask();
    }, AUTO_SELECT_MAX_WAIT_MS);

    return stopAutoSelectTask;
  }, [draftId, expectedWorkId, mediaKind]);

  useEffect(() => {
    let cancelled = false;
    if (retryTimerRef.current !== undefined) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }

    if (!storage) {
      setWorks([]);
      setTasks([]);
      setLoadFailed(true);
      stopAutoSelectTask();
      return;
    }

    void loadProjectHistory(storage, projectId, mediaKind, modeDraftIds).then((history) => {
      if (cancelled) return;
      const autoSelectTask = autoSelectTaskRef.current;
      const hasPendingGeneration = livePendingPhases.has(submissionProgress.phase) ||
        (submissionProgress.phase === 'completed' && Boolean(expectedWorkId) && Boolean(autoSelectTask));

      const statusNodes = buildHistoryStatusNodes(history.tasks);
      const selection = resolveHistorySelection({
        autoSelectActive: Boolean(autoSelectTask),
        hasPendingGeneration: hasPendingGeneration && !userTookOverRef.current,
        selectedStatusId: selectedStatusIdRef.current,
        selectedWorkId: selectedWorkIdRef.current,
        statusNodes,
        targetWorkId: autoSelectTask?.targetWorkId,
        works: history.works
      });
      setWorks(history.works);
      setTasks(history.tasks);
      selectedWorkIdRef.current = selection.selectedWorkId;
      setSelectedWorkId(selection.selectedWorkId);
      selectedStatusIdRef.current = selection.selectedStatusId;
      setSelectedStatusId(selection.selectedStatusId);
      if (selection.shouldScrollToLatest) {
        setScrollRequest((request) => request + 1);
      }
      setLoadFailed(false);
      if (selection.matchedTarget) {
        stopAutoSelectTask();
      } else {
        scheduleAutoSelectRetry();
      }
    }).catch(() => {
      if (cancelled) return;
      setLoadFailed(true);
      scheduleAutoSelectRetry();
    });

    return () => {
      cancelled = true;
    };
  }, [expectedWorkId, mediaKind, modeDraftIds, projectId, refreshKey, retryKey, storage, submissionProgress.phase]);

  useEffect(() => {
    if (!storage) return;
    return storage.onLocalStorageChanged(() => {
      // 存储发生落库变化时，立即重试一次拉取并重置退避定时器，提升响应即时性
      if (retryTimerRef.current !== undefined) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = undefined;
      }
      setRetryKey((key) => key + 1);
    });
  }, [storage]);

  useEffect(() => {
    const phase = submissionProgress.phase;
    if (
      livePendingPhases.has(phase) ||
      liveFailedPhases.has(phase) ||
      liveUncertainPhases.has(phase)
    ) {
      setLiveStartedAt((startedAt) => startedAt ?? new Date().toISOString());
      return;
    }
    if (phase === 'completed' && expectedWorkId && autoSelectTaskRef.current) {
      setLiveStartedAt((startedAt) => startedAt ?? new Date().toISOString());
      return;
    }
    if (phase === 'idle' || phase === 'ready' || phase === 'completed') {
      setLiveStartedAt(undefined);
    }
  }, [expectedWorkId, submissionProgress.phase]);

  const displayLivePhase = submissionProgress.phase === 'completed' &&
    expectedWorkId && autoSelectTaskRef.current
    ? 'waiting'
    : submissionProgress.phase;

  const nodes = useMemo(
    () => buildHistoryNodes(works, tasks, displayLivePhase, liveStartedAt),
    [displayLivePhase, liveStartedAt, tasks, works]
  );

  const historySummaryText = formatHistorySummary(summarizeHistoryNodes(nodes));

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollLeft = timeline.scrollWidth;
  }, [scrollRequest]);

  const handleTimelineWheel = (event: WheelEvent<HTMLElement>) => {
    const timeline = timelineRef.current;
    if (!timeline || timeline.scrollWidth <= timeline.clientWidth) return;

    const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    if (rawDelta === 0) return;

    const delta = event.deltaMode === 1
      ? rawDelta * 24
      : event.deltaMode === 2
        ? rawDelta * timeline.clientWidth
        : rawDelta;
    const maxScrollLeft = timeline.scrollWidth - timeline.clientWidth;
    const nextScrollLeft = Math.min(
      maxScrollLeft,
      Math.max(0, timeline.scrollLeft + delta)
    );
    if (nextScrollLeft === timeline.scrollLeft) return;

    event.preventDefault();
    timeline.scrollLeft = nextScrollLeft;
  };

  const selectedStatusNode = selectedStatusId
    ? nodes.find((node): node is HistoryStatusNode => node.kind !== 'work' && node.id === selectedStatusId)
    : undefined;
  const isSelectedStatusFailed = selectedStatusNode?.kind === 'failed';
  const isSelectedStatusUncertain = selectedStatusNode?.kind === 'uncertain';

  const selectedWork = works.find((work) => work.workId === selectedWorkId);
  const completedWorkId = submissionProgress.phase === 'completed' &&
    expectedWorkId && !selectedWorkId
    ? expectedWorkId
    : undefined;
  const previewWorkId = selectedWorkId ?? completedWorkId;
  const {
    generationFailed,
    generationUncertain,
    showLoadingPreview
  } = resolveHistoryStageFlags({
    livePhase: submissionProgress.phase,
    previewWorkId,
    selectedStatusKind: selectedStatusNode?.kind
  });

  function handleWorkDragStart(
    event: DragEvent<HTMLElement>,
    workId: string
  ) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(imageWorkDragDataType, workId);
    event.dataTransfer.setData('text/plain', workId);
  }

  function handleWorkSelection(workId: string) {
    userTookOverRef.current = true;
    stopAutoSelectTask();
    selectedWorkIdRef.current = workId;
    setSelectedWorkId(workId);
    selectedStatusIdRef.current = undefined;
    setSelectedStatusId(undefined);
  }

  function handleStatusSelection(statusId: string) {
    selectedWorkIdRef.current = undefined;
    setSelectedWorkId(undefined);
    selectedStatusIdRef.current = statusId;
    setSelectedStatusId(statusId);
  }

  function scheduleAutoSelectRetry() {
    const task = autoSelectTaskRef.current;
    if (!task || retryTimerRef.current !== undefined) return;
    if (!canRetryAutoSelect(task.retryCount, Date.now() - task.startedAt)) {
      stopAutoSelectTask();
      return;
    }
    task.retryCount += 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = undefined;
      setRetryKey((key) => key + 1);
    }, AUTO_SELECT_RETRY_DELAY_MS);
  }

  function stopAutoSelectTask() {
    autoSelectTaskRef.current = undefined;
    if (retryTimerRef.current !== undefined) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    if (deadlineTimerRef.current !== undefined) {
      clearTimeout(deadlineTimerRef.current);
      deadlineTimerRef.current = undefined;
    }
  }

  return (
    <div className="uc-generation-history">
      <section
        aria-label="当前作品"
        className="uc-generation-history__current"
      >
        <header className="uc-generation-history__current-heading">
          <div>
            <strong>
              {selectedWork?.name ?? (
                showLoadingPreview
                  ? '正在生成'
                  : generationFailed
                    ? '生成失败'
                    : generationUncertain
                      ? '状态待确认'
                      : '作品预览'
              )}
            </strong>
            <span>
              {selectedWork
                ? formatWorkDate(selectedWork.createdAt)
                : showLoadingPreview
                  ? '完成后自动登记到本地'
                  : selectedStatusNode
                    ? `${formatWorkDate(selectedStatusNode.occurredAt)}（已记录）`
                    : '选择下方作品查看'}
            </span>
          </div>
          {selectedWork ? (
            <StatusPill tone="success">
              <LuShieldCheck aria-hidden="true" />
              本地作品
            </StatusPill>
          ) : isSelectedStatusFailed ? (
            <StatusPill tone="danger">
              <LuCircleX aria-hidden="true" />
              任务失败
            </StatusPill>
          ) : isSelectedStatusUncertain ? (
            <StatusPill tone="warning">
              <LuCircleAlert aria-hidden="true" />
              待确认
            </StatusPill>
          ) : null}
        </header>

        <div
          className={`uc-generation-history__preview${selectedWorkId && mediaKind === 'image' ? ' is-draggable' : ''}`}
          draggable={Boolean(selectedWorkId && mediaKind === 'image')}
          onDragStart={selectedWorkId && mediaKind === 'image'
            ? (event) => handleWorkDragStart(event, selectedWorkId)
            : undefined}
        >
          <GenerationResultPreview
            animateResult
            compact
            emptyDescription={
              generationFailed
                ? `${submissionProgress.failureMessage ?? (isSelectedStatusFailed ? '生成任务已失败。' : '本次生成未完成。')} 请前往任务中心查看详情与重试。`
                : generationUncertain
                  ? '请先到任务中心确认最终状态。'
                  : '完成左侧配置并生成后，作品会显示在这里。'
            }
            emptyIcon={
              generationFailed ? (
                <LuCircleX aria-hidden="true" style={{ color: 'var(--uc-color-status-danger)' }} />
              ) : generationUncertain ? (
                <LuCircleAlert aria-hidden="true" style={{ color: 'var(--uc-color-status-warning)' }} />
              ) : undefined
            }
            emptyTitle={
              generationFailed
                ? '生成失败'
                : generationUncertain
                  ? '状态待确认'
                  : '等待生成'
            }
            loading={showLoadingPreview}
            loadingDescription="完成后将校验并登记到本地。"
            loadingTitle={`正在生成${mediaKind === 'image' ? '图片' : '视频'}`}
            mediaKind={mediaKind}
            projectId={projectId}
            role={generationFailed ? 'alert' : undefined}
            workId={previewWorkId}
          />
        </div>
      </section>

      <section
        aria-label="生成历史"
        className="uc-generation-history__timeline"
        onWheel={handleTimelineWheel}
      >
        <header className="uc-generation-history__timeline-heading">
          <div>
            <strong>生成历史</strong>
            <span>{historySummaryText}</span>
          </div>
          <span>最新在右侧</span>
        </header>

        <div
          className="uc-generation-history__timeline-scroll uc-scrollbar"
          ref={timelineRef}
        >
          {nodes.length > 0 ? (
            <ol className="uc-generation-history__nodes">
              {nodes.map((node) => node.kind === 'work' ? (
                <li className="uc-generation-history__node" key={node.work.workId}>
                  <button
                    aria-label={`查看作品 ${node.work.name}`}
                    aria-pressed={node.work.workId === selectedWorkId}
                    className="uc-generation-history__work"
                    onClick={() => handleWorkSelection(node.work.workId)}
                    type="button"
                  >
                    <HistoryMediaThumbnail
                      selected={node.work.workId === selectedWorkId}
                      work={node.work}
                    />
                  </button>
                  <TimelineMarker tone="work" />
                  <time dateTime={node.work.createdAt}>
                    {formatTimelineTime(node.work.createdAt)}
                  </time>
                </li>
              ) : (
                <li className="uc-generation-history__node" key={node.id}>
                  <button
                    aria-label={node.kind === 'pending' ? '查看正在生成' : `查看生成状态 ${node.kind}`}
                    aria-pressed={
                      selectedStatusId !== undefined
                        ? node.id === selectedStatusId
                        : node.kind === 'pending' && !selectedWorkId && !selectedStatusId && (isPendingGeneration || Boolean(autoSelectTaskRef.current))
                    }
                    className="uc-generation-history__status-button"
                    onClick={() => handleStatusSelection(node.id)}
                    type="button"
                  >
                    <HistoryStatusCard status={node.kind} />
                  </button>
                  <TimelineMarker tone={node.kind} />
                  <time dateTime={node.occurredAt}>
                    {formatTimelineTime(node.occurredAt)}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="uc-generation-history__empty">
              {loadFailed ? '历史记录暂不可用' : '暂无记录'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function resolveHistorySelection(input: {
  readonly autoSelectActive: boolean;
  readonly hasPendingGeneration?: boolean;
  readonly selectedStatusId?: string;
  readonly selectedWorkId?: string;
  readonly targetWorkId?: string;
  readonly works: readonly { readonly workId: string; readonly createdAt?: string }[];
  readonly statusNodes?: readonly { readonly id: string; readonly kind: HistoryStatus; readonly occurredAt: string }[];
}): {
  readonly matchedTarget: boolean;
  readonly selectedStatusId?: string;
  readonly selectedWorkId?: string;
  readonly shouldScrollToLatest: boolean;
} {
  if (
    input.autoSelectActive &&
    input.targetWorkId &&
    input.works.some((work) => work.workId === input.targetWorkId)
  ) {
    return {
      matchedTarget: true,
      selectedStatusId: undefined,
      selectedWorkId: input.targetWorkId,
      shouldScrollToLatest: true
    };
  }
  if (
    input.selectedWorkId &&
    input.works.some((work) => work.workId === input.selectedWorkId)
  ) {
    return {
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedWorkId: input.selectedWorkId,
      shouldScrollToLatest: false
    };
  }
  if (
    input.selectedStatusId &&
    input.statusNodes?.some((node) => node.id === input.selectedStatusId)
  ) {
    return {
      matchedTarget: false,
      selectedStatusId: input.selectedStatusId,
      selectedWorkId: undefined,
      shouldScrollToLatest: false
    };
  }
  // 当任务处于生成中时，不应自动兜底选中历史中的最后一个作品，避免抢占正在生成状态的预览与焦点
  if (input.hasPendingGeneration) {
    return {
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedWorkId: undefined,
      shouldScrollToLatest: true
    };
  }

  // 综合比对最新作品与最新状态节点：如果最新事件是一个状态节点（例如失败或待确认），且发生时间晚于或等于最新作品，优先选中该状态节点
  const latestWork = input.works[input.works.length - 1];
  const sortedStatuses = input.statusNodes && input.statusNodes.length > 0
    ? [...input.statusNodes].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    : [];
  const latestStatus = sortedStatuses[sortedStatuses.length - 1];

  if (latestStatus) {
    const workTime = latestWork?.createdAt ?? '';
    if (!latestWork || latestStatus.occurredAt >= workTime) {
      return {
        matchedTarget: false,
        selectedStatusId: latestStatus.id,
        selectedWorkId: undefined,
        shouldScrollToLatest: true
      };
    }
  }

  return {
    matchedTarget: false,
    selectedStatusId: undefined,
    selectedWorkId: latestWork?.workId,
    shouldScrollToLatest: input.works.length > 0
  };
}

export function resolveHistoryStageFlags(input: {
  readonly livePhase: SubmissionProgressPhase;
  readonly previewWorkId?: string;
  readonly selectedStatusKind?: HistoryStatus;
}): {
  readonly generationFailed: boolean;
  readonly generationInFlight: boolean;
  readonly generationUncertain: boolean;
  readonly isSelectedStatusActive: boolean;
  readonly showLoadingPreview: boolean;
} {
  const hasSelectedStatusNode = input.selectedStatusKind !== undefined;
  const isSelectedStatusActive = input.selectedStatusKind === 'pending' ||
    input.selectedStatusKind === 'awaiting_receipt' ||
    input.selectedStatusKind === 'receiving';
  // 这里刻意不把“提交已完成但自动选中尚未落定”算作进行中：该窗口下调用点
  // 会用 expectedWorkId 兜底 previewWorkId，showLoadingPreview 必然为假，写进去也不会生效。
  // 主舞台在该窗口的形态由调用点 previewWorkId 的兜底决定，不由本函数决定。
  const generationInFlight = isSelectedStatusActive ||
    livePendingPhases.has(input.livePhase);
  const generationFailed = hasSelectedStatusNode
    ? input.selectedStatusKind === 'failed'
    : liveFailedPhases.has(input.livePhase);
  const generationUncertain = hasSelectedStatusNode
    ? input.selectedStatusKind === 'uncertain'
    : liveUncertainPhases.has(input.livePhase);
  return {
    generationFailed,
    generationInFlight,
    generationUncertain,
    isSelectedStatusActive,
    showLoadingPreview: generationInFlight && !input.previewWorkId &&
      !generationFailed && !generationUncertain
  };
}

export function canRetryAutoSelect(retryCount: number, elapsedMs: number): boolean {
  return retryCount < AUTO_SELECT_MAX_RETRIES && elapsedMs < AUTO_SELECT_MAX_WAIT_MS;
}

async function loadProjectHistory(
  storage: NonNullable<typeof window.unicomp>['storage'],
  projectId: string,
  mediaKind: 'image' | 'video',
  draftIds: readonly string[]
): Promise<{
  readonly works: readonly HistoryWork[];
  readonly tasks: readonly HistoryTask[];
}> {
  // 按当前模式下所有草稿ID查询后端历史，合并去重后取最近10个
  const responses = await Promise.all(
    draftIds.map((draftId) =>
      storage.listGenerationHistory({
        projectId,
        draftId,
        mediaKind,
        limit: 20
      })
    )
  );

  const allWorks: HistoryWork[] = [];
  const allTasks: HistoryTask[] = [];
  let anyOk = false;
  for (const result of responses) {
    if (!result.ok) continue;
    anyOk = true;
    for (const item of result.value.items) {
      if (item.kind === 'work') {
        allWorks.push(item);
      } else if (item.kind === 'status') {
        allTasks.push({
          taskId: item.taskId,
          createdAt: item.createdAt,
          latestExecutionState: item.state,
          latestExecutionUpdatedAt: item.occurredAt
        });
      }
    }
  }

  if (!anyOk && responses.length > 0) throw new Error('history_read_failed');

  // 按 workId 去重，按时间倒序取最近10个，再反转为时间线所需的升序
  const recentWorks = [...new Map(allWorks.map((w) => [w.workId, w])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  const works = sortHistoryWorks(recentWorks);
  const tasks = [...new Map(allTasks.map((t) => [t.taskId, t])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  return { works, tasks };
}

function sortHistoryWorks(works: readonly HistoryWork[]): readonly HistoryWork[] {
  return [...new Map(works.map((work) => [work.workId, work])).values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.workId.localeCompare(b.workId)
  );
}

function buildHistoryStatusNodes(
  tasks: readonly HistoryTask[]
): readonly HistoryStatusNode[] {
  const nodes: HistoryStatusNode[] = [];
  for (const task of tasks) {
    const state = task.latestExecutionState;
    const occurredAt = task.latestExecutionUpdatedAt ?? task.createdAt;
    if (!state) continue;
    if (pendingExecutionStates.has(state)) {
      nodes.push({ id: `task-${task.taskId}-pending`, kind: 'pending', occurredAt });
    } else if (awaitingReceiptExecutionStates.has(state)) {
      nodes.push({
        id: `task-${task.taskId}-awaiting-receipt`,
        kind: 'awaiting_receipt',
        occurredAt
      });
    } else if (receivingExecutionStates.has(state)) {
      nodes.push({
        id: `task-${task.taskId}-receiving`,
        kind: 'receiving',
        occurredAt
      });
    } else if (state === 'failed' || state === 'expired') {
      nodes.push({ id: `task-${task.taskId}-failed`, kind: 'failed', occurredAt });
    } else if (uncertainExecutionStates.has(state)) {
      nodes.push({ id: `task-${task.taskId}-uncertain`, kind: 'uncertain', occurredAt });
    }
  }
  return nodes;
}

function buildHistoryNodes(
  works: readonly HistoryWork[],
  tasks: readonly HistoryTask[],
  livePhase: SubmissionProgressPhase,
  liveStartedAt?: string
): readonly HistoryNode[] {
  const nodes: HistoryNode[] = works.map((work) => ({ kind: 'work', work }));
  const taskStatusNodes = buildHistoryStatusNodes(tasks);
  const taskStates = new Set<HistoryStatus>(taskStatusNodes.map((node) => node.kind));
  nodes.push(...taskStatusNodes);

  const liveStatus = livePendingPhases.has(livePhase)
    ? 'pending'
    : liveFailedPhases.has(livePhase)
      ? 'failed'
      : liveUncertainPhases.has(livePhase)
        ? 'uncertain'
        : undefined;
  if (liveStatus && liveStartedAt && !taskStates.has(liveStatus)) {
    nodes.push({
      id: `live-${liveStatus}`,
      kind: liveStatus,
      occurredAt: liveStartedAt
    });
  }

  return nodes.sort((a, b) => {
    const aTime = a.kind === 'work' ? a.work.createdAt : a.occurredAt;
    const bTime = b.kind === 'work' ? b.work.createdAt : b.occurredAt;
    return aTime.localeCompare(bTime);
  });
}

export function summarizeHistoryNodes(
  nodes: readonly ({ readonly kind: 'work' } | { readonly kind: HistoryStatus })[]
): {
  readonly failed: number;
  readonly running: number;
  readonly succeeded: number;
  readonly uncertain: number;
} {
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let uncertain = 0;
  for (const node of nodes) {
    if (node.kind === 'work') {
      succeeded += 1;
      continue;
    }
    if (node.kind === 'failed') {
      failed += 1;
      continue;
    }
    if (
      node.kind === 'pending' ||
      node.kind === 'awaiting_receipt' ||
      node.kind === 'receiving'
    ) {
      running += 1;
      continue;
    }
    uncertain += 1;
  }
  return { failed, running, succeeded, uncertain };
}

export function formatHistorySummary(summary: {
  readonly failed: number;
  readonly running: number;
  readonly succeeded: number;
  readonly uncertain: number;
}): string {
  const segments = [`成功 ${summary.succeeded}`, `失败 ${summary.failed}`];
  if (summary.running > 0) segments.push(`进行中 ${summary.running}`);
  if (summary.uncertain > 0) segments.push(`待确认 ${summary.uncertain}`);
  return segments.join(' · ');
}

function HistoryMediaThumbnail({
  selected,
  work
}: {
  readonly selected: boolean;
  readonly work: HistoryWork;
}) {
  const storage = window.unicomp?.storage;
  const elementRef = useRef<HTMLImageElement | HTMLVideoElement>(null);
  const [visible, setVisible] = useState(selected);
  const [localUrl, setLocalUrl] = useState<string>();

  useEffect(() => {
    if (selected) setVisible(true);
  }, [selected]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !storage) return;
    let cancelled = false;
    void storage.createWorkMediaHandle(work.workId, work.projectId).then((result) => {
      if (!cancelled && result.ok && result.value.mediaKind === work.mediaKind) {
        setLocalUrl(result.value.url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [storage, visible, work.mediaKind, work.projectId, work.workId]);

  return work.mediaKind === 'image' ? (
    <img
      alt={`${work.name} 缩略图`}
      decoding="async"
      loading="lazy"
      ref={elementRef as RefObject<HTMLImageElement>}
      src={localUrl}
    />
  ) : (
    <video
      aria-label={`${work.name} 视频缩略图`}
      key={work.workId}
      muted
      playsInline
      poster=""
      preload="metadata"
      ref={elementRef as RefObject<HTMLVideoElement>}
      src={visible ? localUrl : undefined}
      style={{ backgroundColor: 'transparent' }}
    />
  );
}

function HistoryStatusCard({ status }: { readonly status: HistoryStatus }) {
  if (status === 'pending') {
    return (
      <div className="uc-generation-history__status uc-generation-history__status--pending">
        <LuLoaderCircle aria-hidden="true" />
        <span>生成中</span>
      </div>
    );
  }
  if (status === 'awaiting_receipt') {
    return (
      <div className="uc-generation-history__status uc-generation-history__status--awaiting-receipt">
        <LuDownload aria-hidden="true" />
        <span>结果待接收</span>
      </div>
    );
  }
  if (status === 'receiving') {
    return (
      <div className="uc-generation-history__status uc-generation-history__status--receiving">
        <LuLoaderCircle aria-hidden="true" />
        <span>正在接收</span>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="uc-generation-history__status uc-generation-history__status--failed">
        <LuCircleX aria-hidden="true" />
        <span>失败</span>
      </div>
    );
  }
  return (
    <div className="uc-generation-history__status uc-generation-history__status--uncertain">
      <LuCircleAlert aria-hidden="true" />
      <span>待确认</span>
    </div>
  );
}

function TimelineMarker({ tone }: {
  readonly tone: 'work' | HistoryStatus;
}) {
  return (
    <span
      aria-hidden="true"
      className={`uc-generation-history__marker uc-generation-history__marker--${tone}`}
    />
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatClockTime(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit'
  }).format(date);
}

function formatTimelineTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const clock = formatClockTime(date);
  // 今天只显示时分；今年内非今天显示月日+时分；跨年显示年月日+时分
  if (isSameDay(date, now)) return clock;
  if (date.getFullYear() === now.getFullYear()) {
    const md = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit'
    }).format(date);
    return `${md} ${clock}`;
  }
  const ymd = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
  return `${ymd} ${clock}`;
}

function formatWorkDate(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const clock = formatClockTime(date);
  if (isSameDay(date, now)) return `今天 ${clock}`;
  const ymd = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
  return `${ymd} ${clock}`;
}
