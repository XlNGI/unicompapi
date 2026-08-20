import { useEffect, useMemo, useRef, useState } from 'react';
import type { WheelEvent } from 'react';
import {
  LuCircleAlert,
  LuCircleX,
  LuLoaderCircle,
  LuShieldCheck
} from 'react-icons/lu';
import { GenerationResultPreview } from './GenerationResultPreview';
import { StatusPill } from './StatusPill';
import type { SubmissionProgressPhase } from './SubmissionProgressSteps';
import type {
  StorageTaskDetailsDto,
  StorageWorkSummaryDto
} from '../shared/storage-ipc';

interface GenerationHistoryProps {
  readonly draftId: string;
  readonly mediaKind: 'image' | 'video';
  readonly projectId: string;
  readonly refreshKey: number;
  readonly submissionProgress: {
    readonly phase: SubmissionProgressPhase;
    readonly failureMessage?: string;
  };
}

interface HistoryWork extends StorageWorkSummaryDto {
  readonly localUrl: string;
  readonly sourceTaskId: string;
  readonly verifiedAt: string;
}

type HistoryStatus = 'pending' | 'failed' | 'uncertain';

interface HistoryStatusNode {
  readonly id: string;
  readonly kind: HistoryStatus;
  readonly occurredAt: string;
}

type HistoryNode =
  | { readonly kind: 'work'; readonly work: HistoryWork }
  | HistoryStatusNode;

const activeExecutionStates = new Set([
  'submitting',
  'queued',
  'processing',
  'validating_sources',
  'preparing_media',
  'encoding',
  'remote_completed',
  'downloading',
  'writing',
  'verifying',
  'writing_file',
  'verifying_file',
  'registering_work',
  'cancel_requested'
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
  mediaKind,
  projectId,
  refreshKey,
  submissionProgress
}: GenerationHistoryProps) {
  const storage = window.unicomp?.storage;
  const [works, setWorks] = useState<readonly HistoryWork[]>([]);
  const [tasks, setTasks] = useState<readonly StorageTaskDetailsDto[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [liveStartedAt, setLiveStartedAt] = useState<string>();
  const [selectedWorkId, setSelectedWorkId] = useState<string>();
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLiveStartedAt(undefined);
    setSelectedWorkId(undefined);
  }, [draftId, mediaKind]);

  useEffect(() => {
    let cancelled = false;

    if (!storage) {
      setWorks([]);
      setTasks([]);
      setLoadFailed(true);
      setHistoryLoaded(true);
      return;
    }

    setHistoryLoaded(false);
    void loadHistory(storage, draftId, projectId, mediaKind).then((history) => {
      if (cancelled) return;
      setWorks(history.works);
      setTasks(history.tasks);
      setSelectedWorkId(history.works[history.works.length - 1]?.workId);
      setLoadFailed(false);
      setHistoryLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setWorks([]);
      setTasks([]);
      setLoadFailed(true);
      setHistoryLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [draftId, mediaKind, projectId, refreshKey, storage]);

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
    if (phase === 'idle' || phase === 'ready' || phase === 'completed') {
      setLiveStartedAt(undefined);
    }
  }, [submissionProgress.phase]);

  useEffect(() => {
    if (!historyLoaded) return;
    if (selectedWorkId && works.some((work) => work.workId === selectedWorkId)) {
      return;
    }
    const latest = works[works.length - 1];
    setSelectedWorkId(latest?.workId);
  }, [historyLoaded, selectedWorkId, works]);

  const nodes = useMemo(
    () => buildHistoryNodes(works, tasks, submissionProgress.phase, liveStartedAt),
    [liveStartedAt, submissionProgress.phase, tasks, works]
  );

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollLeft = timeline.scrollWidth;
  }, [nodes.length]);

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

  const selectedWork = works.find((work) => work.workId === selectedWorkId);
  const generationInFlight = livePendingPhases.has(submissionProgress.phase);
  const generationFailed = liveFailedPhases.has(submissionProgress.phase);
  const generationUncertain = liveUncertainPhases.has(submissionProgress.phase);
  const showLoadingPreview = generationInFlight && !selectedWorkId;

  return (
    <div className="uc-generation-history">
      <section
        aria-label="当前作品"
        className="uc-generation-history__current"
      >
        <header className="uc-generation-history__current-heading">
          <div>
            <strong>
              {selectedWork?.name ?? (showLoadingPreview ? '正在生成' : '作品预览')}
            </strong>
            <span>
              {selectedWork
                ? formatWorkDate(selectedWork.createdAt)
                : showLoadingPreview
                  ? '完成后自动登记到本地'
                  : '选择下方作品查看'}
            </span>
          </div>
          {selectedWork ? (
            <StatusPill tone="success">
              <LuShieldCheck aria-hidden="true" />
              本地作品
            </StatusPill>
          ) : null}
        </header>

        <div className="uc-generation-history__preview">
          <GenerationResultPreview
            animateResult
            compact
            emptyDescription={
              generationFailed
                ? submissionProgress.failureMessage ?? '本次生成未完成。'
                : generationUncertain
                  ? '请先到任务中心确认最终状态。'
                  : '完成左侧配置并生成后，作品会显示在这里。'
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
            workId={selectedWorkId}
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
            <span>{works.length} 张作品</span>
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
                    onClick={() => setSelectedWorkId(node.work.workId)}
                    type="button"
                  >
                    {mediaKind === 'image' ? (
                      <img
                        alt={`${node.work.name} 缩略图`}
                        src={node.work.localUrl}
                      />
                    ) : (
                      <video
                        aria-label={`${node.work.name} 视频缩略图`}
                        muted
                        playsInline
                        preload="metadata"
                        src={node.work.localUrl}
                      />
                    )}
                  </button>
                  <TimelineMarker tone="work" />
                  <time dateTime={node.work.createdAt}>
                    {formatTimelineTime(node.work.createdAt)}
                  </time>
                </li>
              ) : (
                <li className="uc-generation-history__node" key={node.id}>
                  <HistoryStatusCard status={node.kind} />
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

async function loadHistory(
  storage: NonNullable<typeof window.unicomp>['storage'],
  draftId: string,
  projectId: string,
  mediaKind: 'image' | 'video'
): Promise<{
  readonly works: readonly HistoryWork[];
  readonly tasks: readonly StorageTaskDetailsDto[];
}> {
  const [taskList, workList] = await Promise.all([
    storage.listTasks(),
    storage.listWorks()
  ]);
  if (!taskList.ok || !workList.ok) throw new Error('history_read_failed');

  const taskDetails = await Promise.all(
    taskList.value.items
      .filter((task) => task.projectId === projectId && task.kind === `${mediaKind}_generation`)
      .map((task) => storage.getTaskDetails(task.taskId))
  );
  const tasks = taskDetails
    .flatMap((result) => result.ok && result.value ? [result.value] : [])
    .filter((task) => task.sourceDraftId === draftId);
  const taskIds = new Set(tasks.map((task) => task.taskId));

  const workDetails = await Promise.all(
    workList.value.items
      .filter((work) =>
        work.projectId === projectId &&
        work.mediaKind === mediaKind &&
        work.fileState === 'available'
      )
      .map(async (work) => ({
        summary: work,
        details: await storage.getWorkDetails(work.workId)
      }))
  );
  const verifiedWorks = workDetails.flatMap(({ summary, details }) =>
    details.ok &&
    details.value?.verifiedAt &&
    taskIds.has(details.value.sourceTaskId)
      ? [{ summary, details: details.value }]
      : []
  );
  const mediaHandles = await Promise.all(
    verifiedWorks.map(async ({ summary, details }) => ({
      summary,
      details,
      handle: await storage.createWorkMediaHandle(summary.workId)
    }))
  );
  const works = mediaHandles
    .flatMap(({ summary, details, handle }) =>
      handle.ok && handle.value.mediaKind === mediaKind
        ? [{
            ...summary,
            localUrl: handle.value.url,
            sourceTaskId: details.sourceTaskId,
            verifiedAt: details.verifiedAt as string
          }]
        : []
    )
    .sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.workId.localeCompare(b.workId)
    );

  return { works, tasks };
}

function buildHistoryNodes(
  works: readonly HistoryWork[],
  tasks: readonly StorageTaskDetailsDto[],
  livePhase: SubmissionProgressPhase,
  liveStartedAt?: string
): readonly HistoryNode[] {
  const nodes: HistoryNode[] = works.map((work) => ({ kind: 'work', work }));
  const taskStates = new Set<HistoryStatus>();

  for (const task of tasks) {
    const state = task.latestExecutionState;
    const occurredAt = task.latestExecutionUpdatedAt ?? task.createdAt;
    if (!state) continue;
    if (activeExecutionStates.has(state)) {
      nodes.push({ id: `task-${task.taskId}-pending`, kind: 'pending', occurredAt });
      taskStates.add('pending');
    } else if (state === 'failed' || state === 'expired') {
      nodes.push({ id: `task-${task.taskId}-failed`, kind: 'failed', occurredAt });
      taskStates.add('failed');
    } else if (uncertainExecutionStates.has(state)) {
      nodes.push({ id: `task-${task.taskId}-uncertain`, kind: 'uncertain', occurredAt });
      taskStates.add('uncertain');
    }
  }

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

function HistoryStatusCard({ status }: { readonly status: HistoryStatus }) {
  if (status === 'pending') {
    return (
      <div className="uc-generation-history__status uc-generation-history__status--pending">
        <LuLoaderCircle aria-hidden="true" />
        <span>生成中</span>
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

function formatTimelineTime(timestamp: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function formatWorkDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = formatTimelineTime(timestamp);
  if (sameDay) return `今天 ${time}`;
  return `${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  }).format(date)} ${time}`;
}
