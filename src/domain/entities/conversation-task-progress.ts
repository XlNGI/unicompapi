export const conversationTaskProgressStages = [
  'planning', 'retrieval', 'analysis', 'design', 'rendering', 'checking', 'publishing', 'completed'
] as const;
export type ConversationTaskProgressStage = (typeof conversationTaskProgressStages)[number];
export const conversationTaskProgressStatuses = ['started', 'running', 'completed', 'failed', 'cancelled', 'paused'] as const;
export type ConversationTaskProgressStatus = (typeof conversationTaskProgressStatuses)[number];

export interface ConversationTaskProgressSnapshot {
  readonly sequence: number;
  readonly stage: ConversationTaskProgressStage;
  readonly progressStatus: ConversationTaskProgressStatus;
  readonly taskRevision: number;
  readonly pageId?: string;
  readonly pageRevision?: number;
  readonly occurredAt: string;
}

/** Bounded projection shared by persisted replay and live message updates. */
export function projectTaskProgress(
  current: readonly ConversationTaskProgressSnapshot[] = [],
  event: {
    readonly type: string;
    readonly sequence: number;
    readonly stage?: ConversationTaskProgressStage;
    readonly progressStatus?: ConversationTaskProgressStatus;
    readonly taskRevision?: number;
    readonly pageId?: string;
    readonly pageRevision?: number;
    readonly occurredAt: string;
  }
): readonly ConversationTaskProgressSnapshot[] {
  if (event.type !== 'task_progress' || event.stage === undefined ||
      event.progressStatus === undefined || event.taskRevision === undefined) return current;
  const last = current[current.length - 1];
  if (last && (event.sequence <= last.sequence || event.taskRevision < last.taskRevision)) return current;
  let retained = last && event.taskRevision > last.taskRevision ? [] : current;
  if (event.pageId !== undefined) {
    const latestPageRevision = retained.reduce((latest, item) => item.pageId === event.pageId
      ? Math.max(latest, item.pageRevision ?? 0) : latest, 0);
    if ((event.pageRevision ?? 0) < latestPageRevision) return current;
    // A new page revision invalidates the old revision's completed stages.
    retained = retained.filter((item) => item.pageId !== event.pageId ||
      (item.pageRevision ?? 0) === (event.pageRevision ?? 0));
  }
  const snapshot: ConversationTaskProgressSnapshot = {
    sequence: event.sequence,
    stage: event.stage,
    progressStatus: event.progressStatus,
    taskRevision: event.taskRevision,
    ...(event.pageId !== undefined ? { pageId: event.pageId } : {}),
    ...(event.pageRevision !== undefined ? { pageRevision: event.pageRevision } : {}),
    occurredAt: event.occurredAt
  };
  return [...retained.filter((item) => item.stage !== event.stage || item.pageId !== event.pageId), snapshot].slice(-128);
}
