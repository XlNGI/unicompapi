import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MutableRefObject, RefObject } from 'react';
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
import type {
  StorageGenerationHistoryItemDto,
  StorageGenerationWorkspaceMode
} from '../shared/storage-ipc';
import { imageWorkDragDataType } from '../shared/image-workspace-ipc';

interface GenerationHistoryProps {
  readonly draftId: string;
  readonly workspaceMode: StorageGenerationWorkspaceMode;
  readonly mediaKind: 'image' | 'video';
  readonly projectId: string;
  readonly refreshKey: number;
  readonly expectedWorkId?: string;
  readonly expectedTaskId?: string;
  readonly userTookOverRef: MutableRefObject<boolean>;
  readonly onWorkSelectionChange?: (workId?: string) => void;
  readonly submissionProgress: {
    readonly phase: SubmissionProgressPhase;
    readonly failureMessage?: string;
  };
}

type HistoryWork = StorageGenerationHistoryItemDto['works'][number] & { readonly sourceTaskId: string };

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
  | 'completed'
  | 'cancelled'
  | 'uncertain';

interface HistoryStatusNode {
  readonly id: string;
  readonly taskId: string;
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
// View state only; task/work facts always come from storage.
const historyViews = new Map<string, { workId?: string; statusId?: string; taskId?: string; scroll: number }>();

const pendingExecutionStates = new Set([
  'created',
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
  workspaceMode,
  mediaKind,
  projectId,
  refreshKey,
  expectedWorkId,
  expectedTaskId,
  userTookOverRef,
  submissionProgress,
  onWorkSelectionChange
}: GenerationHistoryProps) {
  const storage = window.unicomp?.storage;
  const [works, setWorks] = useState<readonly HistoryWork[]>([]);
  const [tasks, setTasks] = useState<readonly HistoryTask[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedWorkId, setSelectedWorkId] = useState<string>();
  const [selectedStatusId, setSelectedStatusId] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const [scrollRequest, setScrollRequest] = useState(0);
  const readOwnerRef = useRef<{ scope: string; running: boolean; queued?: () => void }>();
  const selectedWorkIdRef = useRef<string>();
  const selectedStatusIdRef = useRef<string>();
  const selectedTaskIdRef = useRef<string>();
  const autoSelectTaskRef = useRef<AutoSelectTask>();
  const retryTimerRef = useRef<number>();
  const deadlineTimerRef = useRef<number>();
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollLeftRef = useRef(0);
  const followLatestScrollRef = useRef(true);
  const scrollAnchorRef = useRef<{ id: string; x: number }>();
  const viewScope = `${projectId}:${workspaceMode}:${mediaKind}`;

  useEffect(() => {
    onWorkSelectionChange?.(selectedWorkId);
  }, [onWorkSelectionChange, selectedWorkId]);

  useEffect(() => {
    const saved = historyViews.get(viewScope);
    selectedWorkIdRef.current = saved?.workId;
    setSelectedWorkId(saved?.workId);
    selectedStatusIdRef.current = saved?.statusId;
    setSelectedStatusId(saved?.statusId);
    selectedTaskIdRef.current = saved?.taskId;
    setWorks([]);
    setTasks([]);
    if (saved?.taskId) userTookOverRef.current = true;
    return () => {
      historyViews.set(viewScope, { workId: selectedWorkIdRef.current,
        statusId: selectedStatusIdRef.current, taskId: selectedTaskIdRef.current,
        scroll: scrollLeftRef.current });
      if (historyViews.size > 32) historyViews.delete(historyViews.keys().next().value!);
    };
  }, [viewScope]);

  // 当进入生成中阶段（preparing/requesting/waiting）且用户未主动接管选择时，重置选中项为生成中态
  const isPendingGeneration = livePendingPhases.has(submissionProgress.phase);
  useEffect(() => {
    if (isPendingGeneration && !userTookOverRef.current) {
      followLatestScrollRef.current = true;
      selectedWorkIdRef.current = undefined;
      setSelectedWorkId(undefined);
      setSelectedStatusId(undefined);
      selectedStatusIdRef.current = undefined;
      selectedTaskIdRef.current = undefined;
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

    const scope = `${projectId}:${workspaceMode}:${mediaKind}`;
    if (readOwnerRef.current?.scope !== scope) readOwnerRef.current = { scope, running: false };
    const owner = readOwnerRef.current;
    const read = () => {
      if (cancelled) return;
      owner.running = true;
      void loadProjectHistory(storage, projectId, draftId, mediaKind, workspaceMode).then((history) => {
        if (cancelled) return;
        const autoSelectTask = autoSelectTaskRef.current;
        const hasPendingGeneration = livePendingPhases.has(submissionProgress.phase);

        const statusNodes = buildHistoryStatusNodes(history.tasks);
        const selection = resolveHistorySelection({
          followTask: !userTookOverRef.current,
          autoSelectActive: Boolean(autoSelectTask) && !userTookOverRef.current,
          hasPendingGeneration: hasPendingGeneration && !userTookOverRef.current,
          selectedTaskId: !userTookOverRef.current && expectedTaskId ? expectedTaskId : selectedTaskIdRef.current,
          selectedStatusId: selectedStatusIdRef.current,
          selectedWorkId: selectedWorkIdRef.current,
          statusNodes,
          targetWorkId: autoSelectTask?.targetWorkId,
          works: history.works
        });
        const followingNewTask = !userTookOverRef.current && expectedTaskId &&
          selectedTaskIdRef.current !== expectedTaskId && selection.selectedTaskId === expectedTaskId;
        const timeline = timelineRef.current;
        const visible = timeline && Array.from(timeline.querySelectorAll<HTMLElement>('[data-task-id]'))
          .find(element => element.getBoundingClientRect().right > timeline.getBoundingClientRect().left);
        if (visible) scrollAnchorRef.current = { id: visible.dataset.taskId!, x: visible.getBoundingClientRect().x };
        setWorks(history.works);
        setTasks(history.tasks);
        selectedWorkIdRef.current = selection.selectedWorkId;
        setSelectedWorkId(selection.selectedWorkId);
        selectedStatusIdRef.current = selection.selectedStatusId;
        setSelectedStatusId(selection.selectedStatusId);
        selectedTaskIdRef.current = selection.selectedTaskId;
        if (followLatestScrollRef.current && (selection.shouldScrollToLatest || followingNewTask)) {
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
      }).finally(() => {
        owner.running = false;
        const queued = owner.queued;
        owner.queued = undefined;
        queued?.();
      });
    };
    if (owner.running) owner.queued = read;
    else read();

    return () => {
      cancelled = true;
    };
  }, [draftId, expectedWorkId, expectedTaskId, mediaKind, projectId, refreshKey, retryKey, storage, submissionProgress.phase, workspaceMode]);

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

  const nodes = useMemo(
    () => buildHistoryNodes(works, tasks),
    [tasks, works]
  );

  const cards = useMemo(() => groupHistoryNodes(nodes, tasks), [nodes, tasks]);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !cards.length) return;
    const anchor = scrollAnchorRef.current;
    const element = anchor && Array.from(timeline.querySelectorAll<HTMLElement>('[data-task-id]'))
      .find(item => item.dataset.taskId === anchor.id);
    if (element && anchor) timeline.scrollLeft += element.getBoundingClientRect().x - anchor.x;
    else if (historyViews.has(viewScope)) timeline.scrollLeft = historyViews.get(viewScope)!.scroll;
    scrollAnchorRef.current = undefined;
  }, [cards, viewScope]);
  const historySummaryText = formatHistorySummary(summarizeHistoryNodes(
    cards.map((card) => ({ kind: card.status?.kind ?? 'work' }))
  ));

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !followLatestScrollRef.current) return;
    timeline.scrollLeft = timeline.scrollWidth;
  }, [scrollRequest]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const handleTimelineWheel = (event: WheelEvent) => {
      followLatestScrollRef.current = false;
      if (timeline.scrollWidth <= timeline.clientWidth) return;

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
    // React's delegated wheel listener is passive and cannot cancel page scroll.
    timeline.addEventListener('wheel', handleTimelineWheel, { passive: false });
    return () => timeline.removeEventListener('wheel', handleTimelineWheel);
  }, []);

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
    selectedTaskIdRef.current = works.find((work) => work.workId === workId)?.sourceTaskId;
    selectedStatusIdRef.current = undefined;
    setSelectedStatusId(undefined);
  }

  function handleStatusSelection(statusId: string) {
    userTookOverRef.current = true;
    stopAutoSelectTask();
    selectedWorkIdRef.current = undefined;
    setSelectedWorkId(undefined);
    selectedStatusIdRef.current = statusId;
    setSelectedStatusId(statusId);
    selectedTaskIdRef.current = nodes.find((node): node is HistoryStatusNode =>
      node.kind !== 'work' && node.id === statusId)?.taskId;
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
                    : selectedStatusNode?.kind === 'cancelled' ? '任务已取消' : '作品预览'
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
                ? `${isSelectedStatusFailed ? '生成任务已失败。' : submissionProgress.failureMessage ?? '本次生成未完成。'} 请前往任务中心查看详情与恢复方式。`
                : generationUncertain
                  ? '请先到任务中心确认最终状态。'
                  : selectedStatusNode?.kind === 'completed' ? '任务已结束，当前没有可用的本地作品。请到任务中心或作品库检查。'
                    : selectedStatusNode?.kind === 'cancelled' ? '此任务已取消。已有作品仍保留在任务卡中。'
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
                  : selectedStatusNode?.kind === 'cancelled' ? '任务已取消'
                    : selectedStatusNode?.kind === 'completed' ? '暂无可用作品' : '等待生成'
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
      >
        <header className="uc-generation-history__timeline-heading">
          <div>
            <strong>生成历史</strong>
            <span>{historySummaryText}</span>
          </div>
          <div>
            {loadFailed && <span role="status">历史刷新失败</span>}
            <span>最近 30 个任务 · 最新在右侧</span>
          </div>
        </header>

        <div
          className="uc-generation-history__timeline-scroll uc-scrollbar"
          ref={timelineRef}
          onPointerDown={() => { followLatestScrollRef.current = false; }}
          onKeyDown={() => { followLatestScrollRef.current = false; }}
          onScroll={(event) => { scrollLeftRef.current = event.currentTarget.scrollLeft; }}
        >
          {nodes.length > 0 ? (
            <ol className="uc-generation-history__nodes">
              {cards.map((card) => (
                <HistoryTaskCard key={card.id} card={card}
                  selectedWorkId={selectedWorkId} selectedStatusId={selectedStatusId}
                  onWorkSelection={handleWorkSelection} onStatusSelection={handleStatusSelection} />
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
  readonly followTask?: boolean;
  readonly autoSelectActive: boolean;
  readonly hasPendingGeneration?: boolean;
  readonly selectedStatusId?: string;
  readonly selectedTaskId?: string;
  readonly selectedWorkId?: string;
  readonly targetWorkId?: string;
  readonly works: readonly { readonly workId: string; readonly sourceTaskId: string; readonly createdAt?: string }[];
  readonly statusNodes?: readonly { readonly id: string; readonly taskId: string; readonly kind: HistoryStatus; readonly occurredAt: string }[];
}): {
  readonly matchedTarget: boolean;
  readonly selectedStatusId?: string;
  readonly selectedTaskId?: string;
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
      selectedTaskId: input.works.find((work) => work.workId === input.targetWorkId)?.sourceTaskId,
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
      selectedTaskId: input.works.find((work) => work.workId === input.selectedWorkId)?.sourceTaskId,
      selectedWorkId: input.selectedWorkId,
      shouldScrollToLatest: false
    };
  }
  if (!input.followTask && input.selectedStatusId && input.statusNodes?.some((node) => node.id === input.selectedStatusId)) {
    return {
      matchedTarget: false,
      selectedStatusId: input.selectedStatusId,
      selectedTaskId: input.selectedTaskId,
      selectedWorkId: undefined,
      shouldScrollToLatest: false
    };
  }
  const selectedTaskWork = input.selectedTaskId
    ? input.works.find((work) => work.sourceTaskId === input.selectedTaskId)
    : undefined;
  if (selectedTaskWork) {
    return {
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedTaskId: input.selectedTaskId,
      selectedWorkId: selectedTaskWork.workId,
      shouldScrollToLatest: false
    };
  }
  // 当任务处于生成中时，不应自动兜底选中历史中的最后一个作品，避免抢占正在生成状态的预览与焦点
  const selectedTaskStatus = input.statusNodes?.find((node) => node.taskId === input.selectedTaskId);
  if (selectedTaskStatus) {
    return { matchedTarget: false, selectedTaskId: selectedTaskStatus.taskId,
      selectedStatusId: selectedTaskStatus.id, shouldScrollToLatest: false };
  }
  if (input.hasPendingGeneration) {
    return {
      matchedTarget: false,
      selectedStatusId: undefined,
      selectedTaskId: undefined,
      selectedWorkId: undefined,
      shouldScrollToLatest: true
    };
  }

  // 综合比对最新作品与最新状态节点：如果最新事件是一个状态节点（例如失败或待确认），且发生时间晚于或等于最新作品，优先选中该状态节点
  const latestWork = input.works[input.works.length - 1];
  const sortedStatuses = input.statusNodes && input.statusNodes.length > 0
    ? input.statusNodes.filter(node => node.kind !== 'completed' || !input.works.some(work => work.sourceTaskId === node.taskId))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    : [];
  const latestStatus = sortedStatuses[sortedStatuses.length - 1];

  if (latestStatus) {
    const workTime = latestWork?.createdAt ?? '';
    if (!latestWork || latestStatus.occurredAt >= workTime) {
      return {
        matchedTarget: false,
        selectedStatusId: latestStatus.id,
        selectedTaskId: latestStatus.taskId,
        selectedWorkId: undefined,
        shouldScrollToLatest: true
      };
    }
  }

  return {
    matchedTarget: false,
    selectedStatusId: undefined,
    selectedTaskId: latestWork?.sourceTaskId,
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
  const generationInFlight = hasSelectedStatusNode ? isSelectedStatusActive :
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
  draftId: string,
  mediaKind: 'image' | 'video',
  workspaceMode: StorageGenerationWorkspaceMode
): Promise<{ readonly works: readonly HistoryWork[]; readonly tasks: readonly HistoryTask[] }> {
  const result = await storage.listGenerationHistory({ projectId, draftId, mediaKind, workspaceMode, limit: 30 });
  if (!result.ok || result.value.issues.length > 0) throw new Error('history_read_failed');
  // Merge active and finished tasks before applying the shared display limit.
  const items = [...new Map([...result.value.activeItems, ...result.value.items]
    .map(item => [item.taskId, item])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.taskId.localeCompare(b.taskId))
    .slice(0, 30);
  return {
    works: sortHistoryWorks(items.flatMap(item => item.works.map(work => ({ ...work, sourceTaskId: item.taskId })))),
    tasks: items.map(item => ({ taskId: item.taskId, createdAt: item.createdAt,
      latestExecutionState: item.state ?? '', latestExecutionUpdatedAt: item.occurredAt ?? item.createdAt }))
  };
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
      nodes.push({ id: `task-${task.taskId}`, taskId: task.taskId, kind: 'pending', occurredAt });
    } else if (awaitingReceiptExecutionStates.has(state)) {
      nodes.push({
        id: `task-${task.taskId}`,
        taskId: task.taskId,
        kind: 'awaiting_receipt',
        occurredAt
      });
    } else if (receivingExecutionStates.has(state)) {
      nodes.push({
        id: `task-${task.taskId}`,
        taskId: task.taskId,
        kind: 'receiving',
        occurredAt
      });
    } else if (state === 'failed' || state === 'expired') {
      nodes.push({ id: `task-${task.taskId}`, taskId: task.taskId, kind: 'failed', occurredAt });
    } else if (state === 'completed' || state === 'cancelled') {
      nodes.push({ id: `task-${task.taskId}`, taskId: task.taskId, kind: state, occurredAt });
    } else if (uncertainExecutionStates.has(state)) {
      nodes.push({ id: `task-${task.taskId}`, taskId: task.taskId, kind: 'uncertain', occurredAt });
    }
  }
  return nodes;
}

function buildHistoryNodes(
  works: readonly HistoryWork[],
  tasks: readonly HistoryTask[]
): readonly HistoryNode[] {
  const nodes: HistoryNode[] = works.map((work) => ({ kind: 'work', work }));
  const taskStatusNodes = buildHistoryStatusNodes(tasks);
  nodes.push(...taskStatusNodes);

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
  readonly cancelled?: number;
} {
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let uncertain = 0;
  let cancelled = 0;
  for (const node of nodes) {
    if (node.kind === 'cancelled') { cancelled += 1; continue; }
    if (node.kind === 'work' || node.kind === 'completed') {
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
  return { failed, running, succeeded, uncertain, ...(cancelled ? { cancelled } : {}) };
}

interface HistoryTaskCardData {
  readonly id: string;
  readonly status?: HistoryStatusNode;
  readonly works: readonly HistoryWork[];
  readonly createdAt: string;
}

function groupHistoryNodes(nodes: readonly HistoryNode[], tasks: readonly HistoryTask[]): readonly HistoryTaskCardData[] {
  const createdAtByTask = new Map(tasks.map((task) => [task.taskId, task.createdAt]));
  const groups = new Map<string, { id: string; status?: HistoryStatusNode; works: HistoryWork[]; createdAt: string }>();
  for (const node of nodes) {
    const taskId = node.kind === 'work' ? node.work.sourceTaskId : node.taskId;
    const id = taskId || (node.kind === 'work' ? node.work.workId : node.id);
    const current = groups.get(id) ?? { id, works: [], createdAt: createdAtByTask.get(id)! };
    if (node.kind === 'work') current.works.push(node.work);
    else current.status = node;
    groups.set(id, current);
  }
  return [...groups.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

const historyStatusLabels: Record<HistoryStatus, string> = {
  pending: '生成中', awaiting_receipt: '结果待接收', receiving: '正在接收',
  failed: '失败', uncertain: '待确认', completed: '已完成', cancelled: '已取消'
};

function HistoryTaskCard({ card, selectedWorkId, selectedStatusId, onWorkSelection, onStatusSelection }: {
  readonly card: HistoryTaskCardData;
  readonly selectedWorkId?: string;
  readonly selectedStatusId?: string;
  readonly onWorkSelection: (workId: string) => void;
  readonly onStatusSelection: (statusId: string) => void;
}) {
  const [rememberedWorkId, setRememberedWorkId] = useState<string>();
  const work = card.works.find((item) => item.workId === selectedWorkId) ??
    card.works.find((item) => item.workId === rememberedWorkId) ?? card.works[0];
  const index = work ? card.works.indexOf(work) : -1;
  const status = card.status;
  function selectWork(next: HistoryWork) {
    setRememberedWorkId(next.workId);
    onWorkSelection(next.workId);
  }
  return (
    <li className="uc-generation-history__node" data-task-id={card.id}>
      <div className={`uc-generation-history__task-card${card.works.length > 1 ? ' has-multiple' : ''}`}>
        {work && status && status.kind !== 'completed' ? (
          <button type="button" className={`uc-generation-history__task-status is-${status.kind}`}
            aria-label={`查看任务状态 ${historyStatusLabels[status.kind]}`}
            aria-pressed={selectedStatusId === status.id} onClick={() => onStatusSelection(status.id)}>
            {historyStatusLabels[status.kind]}
          </button>
        ) : null}
        {work ? (
          <button type="button" className="uc-generation-history__work"
            aria-label={`查看作品 ${work.name}`} aria-pressed={selectedWorkId === work.workId}
            onClick={() => selectWork(work)}>
            <HistoryMediaThumbnail key={work.workId} work={work} selected={selectedWorkId === work.workId} />
          </button>
        ) : status ? (
          <button type="button" className="uc-generation-history__status-button"
            aria-label={`查看任务状态 ${historyStatusLabels[status.kind]}`}
            aria-pressed={selectedStatusId === status.id} onClick={() => onStatusSelection(status.id)}>
            <HistoryStatusCard status={status.kind} />
          </button>
        ) : null}
        {card.works.length > 1 && <div className="uc-generation-history__work-switcher">
          {card.works.length > 1 && <button type="button" aria-label="上一件作品"
            disabled={index <= 0} onClick={() => selectWork(card.works[index - 1]!)}>‹</button>}
          <span aria-live="polite">{`作品 ${index + 1}／${card.works.length}`}</span>
          {card.works.length > 1 && <button type="button" aria-label="下一件作品"
            disabled={index >= card.works.length - 1} onClick={() => selectWork(card.works[index + 1]!)}>›</button>}
        </div>}
      </div>
      <TimelineMarker tone={status?.kind ?? 'work'} />
      <time dateTime={card.createdAt}>{formatTimelineTime(card.createdAt)}</time>
    </li>
  );
}

export function formatHistorySummary(summary: {
  readonly failed: number;
  readonly running: number;
  readonly succeeded: number;
  readonly uncertain: number;
  readonly cancelled?: number;
}): string {
  const segments = [`成功 ${summary.succeeded}`, `失败 ${summary.failed}`];
  if (summary.running > 0) segments.push(`进行中 ${summary.running}`);
  if (summary.uncertain > 0) segments.push(`待确认 ${summary.uncertain}`);
  if (summary.cancelled) segments.push(`已取消 ${summary.cancelled}`);
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
  if (status === 'completed' || status === 'cancelled') {
    return <div className="uc-generation-history__status"><span>{historyStatusLabels[status]}</span></div>;
  }
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
