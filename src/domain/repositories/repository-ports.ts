import type { Asset } from '../entities/asset';
import type { Draft } from '../entities/draft';
import type { Execution } from '../entities/execution';
import type { FileReference } from '../entities/file-reference';
import type { ImageWorkspaceDraft } from '../entities/image-workspace';
import type { Project } from '../entities/project';
import type { ProviderOperationRecord } from '../entities/provider-operation';
import type {
  ProjectContextDraftV1,
  ProjectContextV1,
  ProjectContextVersionV1
} from '../entities/project-context';
import type { Task } from '../entities/task';
import type { VideoEditDraft } from '../entities/video-editor';
import type { VideoExportPlan } from '../entities/video-export-plan';
import type { VideoWorkspaceDraft } from '../entities/video-workspace';
import type { Work } from '../entities/work';
import type {
  Conversation,
  ConversationStatus
} from '../entities/conversation';
import type { ConversationResponseDraftV1 } from '../entities/conversation-response';
import type {
  ConversationResponseExecutionV1,
  ConversationResponseStreamEventV1
} from '../entities/conversation-response-execution';
import type {
  ProviderInvocationAttemptV1,
  ProviderInvocationEventV1
} from '../entities/provider-invocation';
import type {
  LocalResultObservationV1,
  ProviderUsageObservationV1,
  ProviderUsageSummaryV1,
  UsageAvailabilityOverride,
  UsageSchemaV1
} from '../entities/provider-usage';
import type { ProviderExecutionRouteSnapshotV1 } from '../entities/provider-execution-route';
import type {
  ModelCapabilityEvidence,
  Provider,
  ProviderConnection,
  ProviderModel,
  RoutingPreference
} from '../entities/provider';
import type {
  AssetId,
  CapabilityEvidenceId,
  ConnectionId,
  ConversationResponseDraftId,
  ConversationResponseExecutionId,
  ConversationResponseStreamEventId,
  DraftId,
  ExecutionId,
  FileReferenceId,
  ModelId,
  ProjectId,
  ProjectContextDraftId,
  ProjectContextId,
  ProviderExecutionRouteSnapshotId,
  ProviderInvocationAttemptId,
  ProviderInvocationEventId,
  ProviderUsageObservationId,
  LocalResultObservationId,
  ProviderId,
  ProviderOperationRecordId,
  RoutingPreferenceId,
  TaskId,
  VideoEditDraftId,
  VideoExportPlanId,
  WorkId
} from '../ids';
import type { ConversationId } from '../ids';
import type { IsoTimestamp } from '../timestamps';

export interface ConversationListOptions {
  readonly statuses?: readonly ConversationStatus[];
  readonly projectId?: ProjectId | null;
}

export interface ConversationRepository {
  get(id: ConversationId): Promise<Conversation | undefined>;
  list(options?: ConversationListOptions): Promise<readonly Conversation[]>;
  create(conversation: Conversation): Promise<void>;
  save(conversation: Conversation, expectedRevision: number): Promise<void>;
}

export interface ProjectConversationRepository extends ConversationRepository {
  readonly projectId: ProjectId;
}

export interface ConversationResponseDraftRepository {
  readonly projectId: ProjectId;
  get(id: ConversationResponseDraftId): Promise<ConversationResponseDraftV1 | undefined>;
  list(conversationId?: ConversationId): Promise<readonly ConversationResponseDraftV1[]>;
  create(draft: ConversationResponseDraftV1): Promise<void>;
  save(draft: ConversationResponseDraftV1, expectedRevision: number): Promise<void>;
}

export interface ConversationResponseExecutionRepository {
  readonly projectId: ProjectId;
  get(id: ConversationResponseExecutionId): Promise<ConversationResponseExecutionV1 | undefined>;
  list(conversationId?: ConversationId): Promise<readonly ConversationResponseExecutionV1[]>;
  listEvents(
    executionId: ConversationResponseExecutionId
  ): Promise<readonly ConversationResponseStreamEventV1[]>;
  getEvent(
    id: ConversationResponseStreamEventId
  ): Promise<ConversationResponseStreamEventV1 | undefined>;
  create(
    execution: ConversationResponseExecutionV1,
    initialEvent: ConversationResponseStreamEventV1
  ): Promise<void>;
  appendEvent(event: ConversationResponseStreamEventV1): Promise<void>;
  appendEvents(events: readonly ConversationResponseStreamEventV1[]): Promise<void>;
}

export interface ProviderInvocationRepository {
  readonly projectId: ProjectId;
  get(id: ProviderInvocationAttemptId): Promise<ProviderInvocationAttemptV1 | undefined>;
  list(): Promise<readonly ProviderInvocationAttemptV1[]>;
  listEvents(
    attemptId?: ProviderInvocationAttemptId
  ): Promise<readonly ProviderInvocationEventV1[]>;
  create(
    attempt: ProviderInvocationAttemptV1,
    initialEvent: ProviderInvocationEventV1
  ): Promise<void>;
  appendEvent(event: ProviderInvocationEventV1): Promise<void>;
  getEvent(id: ProviderInvocationEventId): Promise<ProviderInvocationEventV1 | undefined>;
}

export interface ProviderUsageObservationRepository {
  get(id: ProviderUsageObservationId): Promise<ProviderUsageObservationV1 | undefined>;
  list(attemptId?: ProviderInvocationAttemptId): Promise<readonly ProviderUsageObservationV1[]>;
  append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1): Promise<void>;
  summarize(input: {
    readonly attemptId: ProviderInvocationAttemptId;
    readonly schema: UsageSchemaV1;
    readonly attemptState: ProviderInvocationAttemptV1['state'];
    readonly calculatedAt: IsoTimestamp;
    readonly availabilityOverride?: UsageAvailabilityOverride;
  }): Promise<ProviderUsageSummaryV1>;
}

export interface LocalResultObservationRepository {
  get(id: LocalResultObservationId): Promise<LocalResultObservationV1 | undefined>;
  list(attemptId?: ProviderInvocationAttemptId): Promise<readonly LocalResultObservationV1[]>;
  append(observation: LocalResultObservationV1): Promise<void>;
}

export interface ProviderExecutionRouteSnapshotRepository {
  readonly projectId: ProjectId;
  get(id: ProviderExecutionRouteSnapshotId): Promise<ProviderExecutionRouteSnapshotV1 | undefined>;
  list(): Promise<readonly ProviderExecutionRouteSnapshotV1[]>;
  save(snapshot: ProviderExecutionRouteSnapshotV1): Promise<void>;
}

export interface ProjectContextRepository {
  readonly projectId: ProjectId;
  getDraft(id: ProjectContextDraftId): Promise<ProjectContextDraftV1 | undefined>;
  createDraft(draft: ProjectContextDraftV1): Promise<void>;
  saveDraft(
    draft: ProjectContextDraftV1,
    expectedRevision: number
  ): Promise<void>;
  registerDraft(
    draftId: ProjectContextDraftId,
    expectedDraftRevision: number,
    context: ProjectContextV1
  ): Promise<void>;
  get(id: ProjectContextId): Promise<ProjectContextV1 | undefined>;
  getRevision(
    id: ProjectContextId,
    revision: number
  ): Promise<ProjectContextVersionV1 | undefined>;
  list(includeDeleted?: boolean): Promise<readonly ProjectContextV1[]>;
  save(context: ProjectContextV1, expectedRevision: number): Promise<void>;
}

export interface ProjectRepository {
  load(): Promise<Project | undefined>;
  save(project: Project): Promise<void>;
}

export interface DraftRepository {
  get(id: DraftId): Promise<Draft | undefined>;
  list(projectId: ProjectId): Promise<readonly Draft[]>;
  save(draft: Draft): Promise<void>;
}

export interface ImageWorkspaceRepository {
  get(id: DraftId): Promise<ImageWorkspaceDraft | undefined>;
  list(projectId: ProjectId): Promise<readonly ImageWorkspaceDraft[]>;
  save(draft: ImageWorkspaceDraft): Promise<void>;
}

export interface VideoWorkspaceRepository {
  get(id: DraftId): Promise<VideoWorkspaceDraft | undefined>;
  list(projectId: ProjectId): Promise<readonly VideoWorkspaceDraft[]>;
  save(draft: VideoWorkspaceDraft): Promise<void>;
}

export interface VideoEditDraftRepository {
  get(id: VideoEditDraftId): Promise<VideoEditDraft | undefined>;
  list(projectId: ProjectId): Promise<readonly VideoEditDraft[]>;
  save(draft: VideoEditDraft): Promise<void>;
}

export interface VideoExportPlanRepository {
  get(id: VideoExportPlanId): Promise<VideoExportPlan | undefined>;
  list(projectId: ProjectId): Promise<readonly VideoExportPlan[]>;
  save(plan: VideoExportPlan): Promise<void>;
}

export interface AssetRepository {
  get(id: AssetId): Promise<Asset | undefined>;
  list(projectId: ProjectId): Promise<readonly Asset[]>;
  save(asset: Asset): Promise<void>;
}

export interface FileReferenceRepository {
  get(id: FileReferenceId): Promise<FileReference | undefined>;
  list(projectId: ProjectId): Promise<readonly FileReference[]>;
  save(file: FileReference): Promise<void>;
}

export interface TaskRepository {
  get(id: TaskId): Promise<Task | undefined>;
  list(projectId: ProjectId): Promise<readonly Task[]>;
  save(task: Task): Promise<void>;
}

export interface ExecutionRepository {
  get(id: ExecutionId): Promise<Execution | undefined>;
  list(taskId: TaskId): Promise<readonly Execution[]>;
  save(execution: Execution): Promise<void>;
}

export interface ProviderOperationRepository {
  get(id: ProviderOperationRecordId): Promise<ProviderOperationRecord | undefined>;
  getByExecution(executionId: ExecutionId): Promise<ProviderOperationRecord | undefined>;
  list(taskId?: TaskId): Promise<readonly ProviderOperationRecord[]>;
  save(record: ProviderOperationRecord): Promise<void>;
}

export interface WorkRepository {
  get(id: WorkId): Promise<Work | undefined>;
  list(projectId: ProjectId): Promise<readonly Work[]>;
  save(work: Work): Promise<void>;
}

export interface ProviderRepository {
  get(id: ProviderId): Promise<Provider | undefined>;
  list(): Promise<readonly Provider[]>;
  save(provider: Provider): Promise<void>;
}

export interface ProviderConnectionRepository {
  get(id: ConnectionId): Promise<ProviderConnection | undefined>;
  list(): Promise<readonly ProviderConnection[]>;
  save(connection: ProviderConnection): Promise<void>;
}

export interface ProviderModelRepository {
  get(id: ModelId): Promise<ProviderModel | undefined>;
  list(): Promise<readonly ProviderModel[]>;
  save(model: ProviderModel): Promise<void>;
}

export interface CapabilityEvidenceRepository {
  get(id: CapabilityEvidenceId): Promise<ModelCapabilityEvidence | undefined>;
  list(): Promise<readonly ModelCapabilityEvidence[]>;
  save(evidence: ModelCapabilityEvidence): Promise<void>;
}

export interface RoutingPreferenceRepository {
  get(id: RoutingPreferenceId): Promise<RoutingPreference | undefined>;
  list(): Promise<readonly RoutingPreference[]>;
  save(preference: RoutingPreference): Promise<void>;
}
