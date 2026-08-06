import { randomUUID } from 'node:crypto';
import {
  createLocalResultObservation,
  toIsoTimestamp,
  toLocalResultObservationId,
  toProviderOperationRecordId,
  transitionExecution
} from '../../domain';
import type { VideoFeatureSubmissionDto } from '../../shared/video-feature-ipc';
import {
  ProviderAsyncOperationCoordinator,
  ProviderExecutionLifecycleService,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderSubmissionOrchestrator,
  ProjectImageMaterialResolver,
  ProjectVideoFeatureSubjectResolver,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  SubmissionOrchestrationError,
  VideoDraftArtifactFactory,
  ViduBoundedPoller,
  createVideoFeatureDispatchBridge,
  createVideoFeatureSubmissionIdFactory,
  createVideoProviderFeatureContracts,
  extractVideoResultUrls,
  type JsonProviderRegistryStore,
  type ProviderAsyncOperationPort,
  type ProviderCandidateRuntimeAuthorizationPort,
  type ProviderPackageRegistry,
  type RuntimeAuthorizationOrchestrationPort,
  type SecureCredentialVault,
  type VideoFeatureSubmissionRuntimes,
  type ViduProviderPackage
} from '../providers';
import {
  JsonAssetRepository,
  JsonExecutionRepository,
  JsonLocalResultObservationRepository,
  JsonProjectContextRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderOperationRepository,
  JsonTaskRepository,
  JsonVideoWorkspaceRepository
} from '../repositories';
import {
  NodeProjectStorage,
  ProjectMetadataUnitOfWork,
  ProjectSubmissionAcceptanceStore,
  SubmissionIntentJournal,
  type ProjectSubmissionAcceptanceV1
} from '../storage';
import type { VideoFeatureControllerRuntime } from './video-feature-controller';
import type { VideoWorkspaceMutationCoordinator } from './video-workspace-mutations';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface VideoFeatureRuntimeOptions {
  readonly session: StorageProjectSession;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
  readonly runtimeAuthorization: ProviderCandidateRuntimeAuthorizationPort;
  readonly submissionAuthorization?: RuntimeAuthorizationOrchestrationPort;
  readonly videoSubmission?: Omit<
    VideoFeatureSubmissionRuntimes,
    'providerRegistry' | 'providerPackages' | 'materials'
  > & {
    readonly viduPackage: ViduProviderPackage;
    readonly credentialVault: SecureCredentialVault;
  };
  /** Same async query/cancel port used by the video submission closed loop. */
  readonly asyncOperationPort?: ProviderAsyncOperationPort;
  /** Attach remote task id to the shared Vidu video adapter context before poll. */
  readonly rememberVideoOperation?: (
    providerOperationId: string,
    context: {
      readonly connectionId: string;
      readonly binding: import('../../domain').ProviderProtocolBinding;
    }
  ) => void;
  readonly resultReceiver?: {
    receive(executionId: string): Promise<{
      readonly ok: true;
      readonly value: {
        readonly executionId: string;
        readonly works: readonly {
          readonly workId: string;
          readonly name: string;
        }[];
      };
    } | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    }>;
  };
  readonly mutations: VideoWorkspaceMutationCoordinator;
  now?: () => string;
}

export function createVideoFeatureControllerRuntime(
  options: VideoFeatureRuntimeOptions
): VideoFeatureControllerRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const storage = new NodeProjectStorage(options.session.rootDirectory);
  const drafts = new JsonVideoWorkspaceRepository(storage, options.session.projectId);
  const contexts = new JsonProjectContextRepository(storage, options.session.projectId);
  const assets = new JsonAssetRepository(storage, options.session.projectId);
  const tasks = new JsonTaskRepository(storage, options.session.projectId);
  const executions = new JsonExecutionRepository(storage);
  const operations = new JsonProviderOperationRepository(storage);
  const invocations = new JsonProviderInvocationRepository(
    storage,
    options.session.projectId
  );
  const routes = new JsonProviderExecutionRouteSnapshotRepository(
    storage,
    options.session.projectId
  );
  const localResults = new JsonLocalResultObservationRepository(storage);
  const contracts = new ProviderFeatureContractRegistry(
    createVideoProviderFeatureContracts()
  );
  const candidates = new ProviderFeatureCandidateService(
    new ProjectVideoFeatureSubjectResolver(
      options.session.projectId,
      drafts,
      contexts,
      assets
    ),
    new RegistryFeatureCandidateSource(
      options.providerRegistry,
      options.providerPackages,
      contracts,
      options.runtimeAuthorization
    ),
    new RouteSelectionTokenVault()
  );

  const runtime: VideoFeatureControllerRuntime = {
    drafts,
    candidates
  };

  const authorization = options.submissionAuthorization;
  const videoSubmission = options.videoSubmission;
  const canSubmit = Boolean(
    videoSubmission &&
    authorization &&
    typeof authorization.claimSubmission === 'function' &&
    typeof authorization.markRequestStarted === 'function' &&
    typeof authorization.releaseBeforeRequest === 'function' &&
    typeof authorization.recordOutcome === 'function'
  );

  if (!canSubmit || !videoSubmission || !authorization) {
    return runtime;
  }

  const acceptances = new ProjectSubmissionAcceptanceStore(
    new ProjectMetadataUnitOfWork(storage, now)
  );
  const journal = new SubmissionIntentJournal(storage, now);
  const artifacts = new VideoDraftArtifactFactory({
    drafts,
    tasks,
    executions,
    providerRegistry: options.providerRegistry
  });
  const materials = new ProjectImageMaterialResolver({
    getSession: () => options.session
  });
  const dispatch = createVideoFeatureDispatchBridge({
    ...videoSubmission,
    providerRegistry: options.providerRegistry,
    providerPackages: options.providerPackages,
    materials
  });
  const orchestrator = new ProviderSubmissionOrchestrator(
    candidates,
    acceptances,
    authorization,
    journal,
    artifacts,
    dispatch,
    createVideoFeatureSubmissionIdFactory(),
    now
  );
  const lifecycle = new ProviderExecutionLifecycleService({
    executionRepository: executions,
    operationRepository: operations,
    createRecordId: () =>
      toProviderOperationRecordId(`provider-operation-record-${randomUUID()}`),
    now
  });

  runtime.submit = async (input) => {
    let orchestration;
    try {
      orchestration = await orchestrator.submitDraft(input);
    } catch (error) {
      if (error instanceof SubmissionOrchestrationError && error.result) {
        orchestration = error.result;
      } else {
        throw error;
      }
    }
    const acceptance = (await acceptances.list()).find(
      (item) => item.intent.id === orchestration.submissionIntentId
    );
    if (!acceptance || acceptance.subjectArtifacts.kind !== 'media') {
      return {
        schemaVersion: 1 as const,
        submissionIntentId: orchestration.submissionIntentId,
        status: orchestration.status,
        retryAllowed: false as const,
        ...(orchestration.status === 'failed_before_submission' ||
        orchestration.status === 'unknown_outcome'
          ? {
              feedback: userFacingSubmissionFeedback(
                undefined,
                orchestration.status === 'failed_before_submission'
                  ? 'before_request'
                  : 'after_request'
              )
            }
          : {})
      };
    }

    await persistCallRecordFacts({
      acceptance,
      routes,
      invocations
    });

    let workId: string | undefined;
    let localResultError: string | undefined;
    let finalStatus = orchestration.status;
    const resultVideoUrls = acceptance.providerOperationRecord
      ? extractVideoResultUrls(acceptance.providerOperationRecord.outcome)
      : [];

    if (
      acceptance.providerOperationRecord &&
      ['provider_accepted', 'completed'].includes(acceptance.intent.status)
    ) {
      let execution = await executions.get(acceptance.subjectArtifacts.execution.id);
      const task = await tasks.get(acceptance.subjectArtifacts.task.id);
      if (execution && task && execution.state === 'created') {
        execution = transitionExecution(
          execution,
          'submitting',
          toIsoTimestamp(now())
        );
        await executions.save(execution);
        execution = await lifecycle.applySubmitOutcome({
          task,
          execution,
          mediaKind: 'video',
          executionLifecycle: acceptance.providerOperationRecord.executionLifecycle,
          outcome: acceptance.providerOperationRecord.outcome
        });
      }

      // Match the existing video closed loop: poll async operations to completion.
      if (
        execution &&
        (execution.state === 'queued' || execution.state === 'processing') &&
        options.asyncOperationPort &&
        execution.providerOperationRecordId &&
        execution.remoteOperationId
      ) {
        try {
          await attachVideoOperationContext({
            providerOperationId: execution.remoteOperationId,
            routeSnapshot: acceptance.routeSnapshot,
            providerRegistry: options.providerRegistry,
            remember: options.rememberVideoOperation
          });
          const coordinator = new ProviderAsyncOperationCoordinator(
            executions,
            operations,
            options.asyncOperationPort,
            () => now()
          );
          const poller = new ViduBoundedPoller(options.asyncOperationPort);
          const pollStatus = await poller.poll(execution.remoteOperationId);
          execution = await coordinator.refresh(execution.providerOperationRecordId);

          if (pollStatus.state === 'polling_exhausted') {
            localResultError =
              '轮询超时：远端仍在排队或处理中。可稍后在任务中心刷新，禁止自动重试。';
            finalStatus = 'provider_accepted';
          } else if (pollStatus.state === 'failed') {
            localResultError = `远端反馈：${pollStatus.message}`;
            finalStatus = 'failed';
          } else if (pollStatus.state === 'cancelled' || pollStatus.state === 'expired') {
            localResultError = `远端任务已${pollStatus.state === 'cancelled' ? '取消' : '过期'}`;
            finalStatus = 'cancelled';
          }
        } catch (error) {
          localResultError =
            error instanceof Error && error.message.trim().length > 0
              ? `视频轮询失败：${error.message}`
              : '视频轮询失败，结果未知，禁止自动重试。';
          finalStatus = 'unknown_outcome';
        }
      } else if (
        execution &&
        (execution.state === 'queued' || execution.state === 'processing') &&
        !options.asyncOperationPort
      ) {
        localResultError =
          '远端已接受请求，但未配置视频异步轮询端口，任务仍停留在排队/处理中。';
      }

      if (execution?.state === 'remote_completed' && options.resultReceiver) {
        try {
          const received = await options.resultReceiver.receive(execution.id);
          if (received.ok) {
            workId = received.value.works[0]?.workId;
            finalStatus = 'completed';
          } else {
            localResultError =
              `本地登记失败：${received.error.message}（${received.error.code}）`;
            finalStatus = 'completed';
          }
        } catch (error) {
          localResultError =
            error instanceof Error && error.message.trim().length > 0
              ? `本地登记失败：${error.message}`
              : '本地登记失败：结果接收异常';
          finalStatus = 'completed';
        }
      } else if (
        execution?.state === 'remote_completed' &&
        !options.resultReceiver
      ) {
        localResultError = '远端已完成，但未配置视频结果接收器，无法落盘。';
        finalStatus = 'completed';
      }
    } else if (acceptance.intent.status === 'failed_before_submission') {
      const safeCode = latestSafeCode(acceptance.invocationEvents);
      localResultError = userFacingSubmissionFeedback(safeCode, 'before_request');
    } else if (acceptance.intent.status === 'unknown_outcome') {
      const safeCode = latestSafeCode(acceptance.invocationEvents);
      localResultError = userFacingSubmissionFeedback(safeCode, 'after_request');
    }

    const feedbackSafeCode = latestSafeCode(acceptance.invocationEvents);
    const feedback =
      localResultError ??
      (workId
        ? '远端已返回结果，并已完成本地作品登记。'
        : resultVideoUrls.length > 0
          ? '远端已返回视频结果。'
          : finalStatus === 'completed'
            ? '提交已完成。'
            : finalStatus === 'provider_accepted'
              ? '远端已接受请求，仍在排队或处理中。'
              : undefined);

    if (resultVideoUrls.length > 0 || workId || localResultError) {
      await localResults.append(
        createLocalResultObservation({
          id: toLocalResultObservationId(`local-result-${randomUUID()}`),
          invocationAttemptId: acceptance.invocationAttempt.id,
          mediaKind: 'video',
          outputCount: Math.max(resultVideoUrls.length, workId ? 1 : 0),
          validationState: workId ? 'valid' : resultVideoUrls.length > 0 ? 'pending' : 'invalid',
          observedAt: toIsoTimestamp(now())
        })
      );
    }

    return {
      schemaVersion: 1 as const,
      submissionIntentId: orchestration.submissionIntentId,
      status: finalStatus,
      retryAllowed: false as const,
      ...(workId ? { workId } : {}),
      ...(resultVideoUrls.length > 0 ? { resultVideoUrls } : {}),
      ...(localResultError && !workId ? { localResultError } : {}),
      ...(feedback ? { feedback } : {}),
      ...(feedbackSafeCode ? { safeCode: feedbackSafeCode } : {})
    } satisfies VideoFeatureSubmissionDto;
  };

  return runtime;
}

function latestSafeCode(
  events: ProjectSubmissionAcceptanceV1['invocationEvents']
): string | undefined {
  return [...events]
    .reverse()
    .find((event) => 'safeCode' in event && typeof event.safeCode === 'string')
    ?.safeCode;
}

async function attachVideoOperationContext(input: {
  readonly providerOperationId: string;
  readonly routeSnapshot: ProjectSubmissionAcceptanceV1['routeSnapshot'];
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly remember?: VideoFeatureRuntimeOptions['rememberVideoOperation'];
}): Promise<void> {
  if (!input.remember) return;
  const snapshot = await input.providerRegistry.load();
  const binding =
    snapshot.protocolBindings.find(
      (item) => item.id === input.routeSnapshot.protocolBindingId
    ) ??
    snapshot.protocolBindings.find(
      (item) =>
        item.connectionId === input.routeSnapshot.connectionId &&
        item.adapterKind === input.routeSnapshot.adapterKey
    );
  if (!binding) return;
  input.remember(input.providerOperationId, {
    connectionId: binding.connectionId,
    binding
  });
}

function userFacingSubmissionFeedback(
  safeCode: string | undefined,
  phase: 'before_request' | 'after_request'
): string {
  switch (safeCode) {
    case 'vidu.credential_unavailable':
      return '凭证不可用：请到服务商连接里重新保存 Token 后再生成';
    case 'vidu.credit_insufficient':
      return '远端反馈：服务商积分不足，请充值后再生成';
    case 'vidu.invalid_request':
      return '远端反馈：请求参数被拒绝，请检查模型与参数后重试';
    case 'vidu.authentication_failed':
      return '远端反馈：鉴权失败，请检查服务商连接凭证';
    case 'vidu.permission_denied':
      return '远端反馈：当前凭证无权执行该操作';
    case 'vidu.rate_limited':
      return '远端反馈：请求过于频繁，请稍后再试';
    case 'vidu.provider_unavailable':
      return '远端反馈：服务暂时不可用，请稍后重试';
    case 'vidu.timeout':
      return '远端反馈：请求超时，结果未知，禁止自动重试';
    case 'vidu.network_error':
      return '远端反馈：网络请求失败，结果未知，禁止自动重试';
    case 'vidu.invalid_response':
      return '远端反馈：响应无法解析，禁止自动重试';
    case 'vidu.proxy_unavailable':
      return '远端反馈：代理不可用，请检查网络代理设置';
    case 'vidu.protocol_mismatch':
      return '远端反馈：协议绑定与请求不匹配';
    case 'vidu.endpoint_not_allowed':
      return '远端反馈：目标接口不在允许范围内';
    default:
      return phase === 'before_request'
        ? `请求未成功发出（${safeCode ?? 'adapter.failed_before_submission'}），因此没有视频结果`
        : `远端已收到请求但未返回可用视频（${safeCode ?? 'adapter.submission_outcome_unknown'}），禁止自动重试`;
  }
}

async function persistCallRecordFacts(input: {
  readonly acceptance: ProjectSubmissionAcceptanceV1;
  readonly routes: JsonProviderExecutionRouteSnapshotRepository;
  readonly invocations: JsonProviderInvocationRepository;
}): Promise<void> {
  await input.routes.save(input.acceptance.routeSnapshot);
  const [initial, ...rest] = input.acceptance.invocationEvents;
  if (!initial) return;
  const submittingAttempt = {
    ...input.acceptance.invocationAttempt,
    state: 'submitting' as const
  };
  await input.invocations.create(submittingAttempt, initial);
  for (const event of rest) {
    await input.invocations.appendEvent(event);
  }
}
