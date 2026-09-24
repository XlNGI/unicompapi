import type { ProviderFailureDiagnosticV1 } from '../../domain';
import { randomUUID } from 'node:crypto';
import { failureDiagnostic } from '../providers/failure-diagnostic';
import {
  createProviderInvocationEvent,
  createLocalResultObservation,
  recoverRemoteCompletedExecution,
  isTerminalExecutionState,
  toTaskId,
  toIsoTimestamp,
  toLocalResultObservationId,
  toProviderInvocationEventId,
  toProviderOperationRecordId,
  transitionExecution,
  type ProviderInvocationAttemptId,
  type ProviderProtocolBinding
} from '../../domain';
import type { VideoFeatureSubmissionDto } from '../../shared/video-feature-ipc';
import type { VideoFeatureRecoveryDto } from '../../shared/video-feature-ipc';
import {
  MINIMAX_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  NEWAPI_VIDEO_ADAPTER_ID,
  ProviderAsyncOperationCoordinator,
  ProviderExecutionLifecycleService,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderSubmissionOrchestrator,
  ProjectImageMaterialResolver,
  ProjectVideoFeatureSubjectResolver,
  assertVideoPromptEnhancementSatisfied,
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
  JsonProviderUsageObservationRepository,
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
    'providerRegistry' | 'providerPackages' | 'materials' | 'usage'
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
      readonly binding: ProviderProtocolBinding;
    }
  ) => void;
  /** Re-attach NewAPI video operation context before poll (same long-lived adapter). */
  readonly attachNewApiVideoOperation?: (input: {
    readonly routeSnapshot: unknown;
    readonly providerOperationId: string;
    readonly invocationAttemptId: string;
  }) => Promise<void>;
  readonly attachMinimaxVideoOperation?: (input: {
    readonly routeSnapshot: unknown;
    readonly providerOperationId: string;
    readonly invocationAttemptId: string;
  }) => Promise<void>;
  readonly attachUnicompapiStudioH3VideoOperation?: (input: {
    readonly routeSnapshot: unknown;
    readonly providerOperationId: string;
    readonly invocationAttemptId: string;
  }) => Promise<void>;
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
  const usage = new JsonProviderUsageObservationRepository(storage);
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
    candidates,
    assertPromptEnhancementSatisfied: (draft) =>
      assertVideoPromptEnhancementSatisfied({
        projectId: options.session.projectId,
        draft,
        contexts
      })
  };

  const recoveryResultReceiver = options.resultReceiver;
  const recoveryRemember = options.rememberVideoOperation;
  const recoveryAttachNewApi = options.attachNewApiVideoOperation;
  const recoveryAttachMinimax = options.attachMinimaxVideoOperation;
  const recoveryAttachStudioH3 = options.attachUnicompapiStudioH3VideoOperation;
  if (recoveryResultReceiver && (recoveryRemember || recoveryAttachNewApi || recoveryAttachMinimax || recoveryAttachStudioH3)) {
    runtime.recoverResult = async (taskId): Promise<VideoFeatureRecoveryDto> => {
      const task = await tasks.get(toTaskId(taskId));
      if (!task || task.projectId !== options.session.projectId) {
        throw new Error('Video task not found in the open project');
      }
      const execution = [...await executions.list(task.id)]
        .filter((item) => task.executionIds.includes(item.id))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (
        task.submission.kind !== 'video_generation' ||
        !execution ||
        execution.state !== 'failed' ||
        execution.failure?.stage !== 'downloading' ||
        execution.failure.retryability !== 'retryable' ||
        !execution.remoteOperationId
      ) {
        throw new Error('This task does not have a recoverable video result download');
      }
      const attempt = (await invocations.list()).find(
        (item) =>
          item.subject.kind === 'media' &&
          item.subject.taskId === task.id &&
          item.subject.executionId === execution.id
      );
      const route = attempt ? await routes.get(attempt.routeSnapshotId) : undefined;
      if (!attempt || !route) {
        throw new Error('The original video route is unavailable');
      }
      const attached = await attachVideoOperationContext({
        providerOperationId: execution.remoteOperationId,
        routeSnapshot: route,
        invocationAttemptId: attempt.id,
        providerRegistry: options.providerRegistry,
        remember: recoveryRemember,
        attachNewApi: recoveryAttachNewApi,
        attachMinimax: recoveryAttachMinimax,
        attachStudioH3: recoveryAttachStudioH3
      });
      if (!attached) {
        throw new Error('The original video route cannot be restored');
      }
      const recovered = recoverRemoteCompletedExecution(
        execution,
        toIsoTimestamp(now())
      );
      await executions.save(recovered);
      const received = await recoveryResultReceiver.receive(recovered.id);
      if (!received.ok || !received.value.works[0]) {
        throw new Error(
          received.ok
            ? 'The recovered video result did not register a work'
            : received.error.message
        );
      }
      await localResults.append(
        createLocalResultObservation({
          id: toLocalResultObservationId(`local-result-${randomUUID()}`),
          invocationAttemptId: attempt.id,
          mediaKind: 'video',
          outputCount: received.value.works.length,
          validationState: 'valid',
          observedAt: toIsoTimestamp(now())
        })
      );
      return {
        schemaVersion: 1,
        taskId: task.id,
        executionId: received.value.executionId,
        workId: received.value.works[0].workId
      };
    };
  }

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
    materials,
    usage
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

  runtime.submit = async (input, onAccepted) => {
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
    let diagnostic: ProviderFailureDiagnosticV1 | undefined;
    let finalStatus = orchestration.status;
    const acceptedExecutionId = acceptance.subjectArtifacts.execution.id;
    // The receipt ends the renderer request, so subsequent local failures must
    // remain visible in persisted execution facts rather than only in the DTO.
    const recordTrackingFailure = async (stage: 'processing' | 'downloading', message: string) => {
      const current = await executions.get(acceptedExecutionId);
      if (!current || isTerminalExecutionState(current.state)) return;
      const failureStage = stage === 'downloading' && current.state === 'remote_completed' ? 'downloading' : current.state;
      await executions.save(transitionExecution(current, 'failed', toIsoTimestamp(now()), {
        failure: { stage: failureStage, message,
          retryability: stage === 'downloading' && failureStage === 'downloading' ? 'retryable' : 'unknown' }
      }));
    };
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

      if (execution && task && ['queued', 'processing', 'remote_completed'].includes(execution.state)) {
        onAccepted?.({
          schemaVersion: 1,
          submissionIntentId: orchestration.submissionIntentId,
          status: 'provider_accepted',
          retryAllowed: false,
          taskId: task.id,
          executionId: execution.id,
          feedback: '任务已接管，生成及本地登记进度请查看历史卡。'
        });
      }

      // Continue the same bounded operation after the persisted receipt.
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
            invocationAttemptId: acceptance.invocationAttempt.id,
            providerRegistry: options.providerRegistry,
            remember: options.rememberVideoOperation,
            attachNewApi: options.attachNewApiVideoOperation,
            attachMinimax: options.attachMinimaxVideoOperation,
            attachStudioH3: options.attachUnicompapiStudioH3VideoOperation
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
              '自动查询已结束，远端结果尚未确认。请在任务中心核对记录并联系服务商确认，勿重复提交。';
            if (execution.state === 'queued' || execution.state === 'processing') {
              await recordTrackingFailure('processing', localResultError);
              finalStatus = 'unknown_outcome';
            }
          } else if (pollStatus.state === 'failed') {
            diagnostic = pollStatus.failureDiagnostic ?? failureDiagnostic({ stage: 'upstream_response', message: pollStatus.message });
            localResultError = `远端反馈：${pollStatus.message}`;
            finalStatus = 'failed';
          } else if (pollStatus.state === 'cancelled' || pollStatus.state === 'expired') {
            localResultError = `远端任务已${pollStatus.state === 'cancelled' ? '取消' : '过期'}`;
            finalStatus = 'cancelled';
          }
        } catch (error) {
          diagnostic = error instanceof Error && 'failureDiagnostic' in error
            ? (error as Error & { failureDiagnostic?: ProviderFailureDiagnosticV1 }).failureDiagnostic
            : undefined;
          localResultError =
            error instanceof Error && error.message.trim().length > 0
              ? `视频轮询失败：${error.message}`
              : '视频轮询失败，结果未知，禁止自动重试。';
          finalStatus = 'unknown_outcome';
          await recordTrackingFailure('processing', '远端结果查询中断，结果尚未确认，勿重复提交。');
        }
      } else if (
        execution &&
        (execution.state === 'queued' || execution.state === 'processing') &&
        !options.asyncOperationPort
      ) {
        localResultError =
          '远端已接受请求，但未配置视频异步轮询端口，任务仍停留在排队/处理中。';
        await recordTrackingFailure('processing', '远端请求已受理，但本地结果查询不可用，勿重复提交。');
        finalStatus = 'unknown_outcome';
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
            await recordTrackingFailure('downloading', '远端已完成，但本地结果接收失败，可在任务中心恢复结果。');
          }
        } catch (error) {
          localResultError =
            error instanceof Error && error.message.trim().length > 0
              ? `本地登记失败：${error.message}`
              : '本地登记失败：结果接收异常';
          finalStatus = 'completed';
          await recordTrackingFailure('downloading', '远端已完成，但本地结果接收异常，可在任务中心恢复结果。');
        }
      } else if (
        execution?.state === 'remote_completed' &&
        !options.resultReceiver
      ) {
        localResultError = '远端已完成，但未配置视频结果接收器，无法落盘。';
        finalStatus = 'completed';
        await recordTrackingFailure('downloading', '远端已完成，但本地结果接收不可用。');
      }
    } else if (acceptance.intent.status === 'failed_before_submission') {
      const safeCode = latestSafeCode(acceptance.invocationEvents);
      localResultError = userFacingSubmissionFeedback(safeCode, 'before_request');
      await lifecycle.applyUnrecordedSubmitOutcome({
        executionId: acceptance.subjectArtifacts.execution.id,
        outcome: 'failed_before_submission',
        message: localResultError
      });
    } else if (acceptance.intent.status === 'failed') {
      const safeCode = latestSafeCode(acceptance.invocationEvents);
      localResultError = userFacingSubmissionFeedback(safeCode, 'after_request');
      await lifecycle.applyExplicitSubmissionFailure({
        executionId: acceptance.subjectArtifacts.execution.id,
        message: localResultError
      });
    } else if (acceptance.intent.status === 'unknown_outcome') {
      const safeCode = latestSafeCode(acceptance.invocationEvents);
      localResultError = userFacingSubmissionFeedback(safeCode, 'after_request');
      await lifecycle.applyUnrecordedSubmitOutcome({
        executionId: acceptance.subjectArtifacts.execution.id,
        outcome: 'submission_outcome_unknown',
        message: localResultError
      });
    }

    const feedbackSafeCode = latestSafeCode(acceptance.invocationEvents);
    if (finalStatus === 'completed' || finalStatus === 'failed' || finalStatus === 'cancelled' || finalStatus === 'unknown_outcome') {
      await finalizeVideoInvocation({
        invocations,
        attemptId: acceptance.invocationAttempt.id,
        status: finalStatus,
        safeCode: feedbackSafeCode,
        failureDiagnostic: diagnostic,
        now
      });
    }

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
      taskId: acceptance.subjectArtifacts.task.id,
      executionId: acceptance.subjectArtifacts.execution.id,
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
  readonly invocationAttemptId: string;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly remember?: VideoFeatureRuntimeOptions['rememberVideoOperation'];
  readonly attachNewApi?: VideoFeatureRuntimeOptions['attachNewApiVideoOperation'];
  readonly attachMinimax?: VideoFeatureRuntimeOptions['attachMinimaxVideoOperation'];
  readonly attachStudioH3?: VideoFeatureRuntimeOptions['attachUnicompapiStudioH3VideoOperation'];
}): Promise<boolean> {
  if (input.routeSnapshot.adapterKey === NEWAPI_VIDEO_ADAPTER_ID) {
    if (!input.attachNewApi) return false;
    await input.attachNewApi({
      routeSnapshot: input.routeSnapshot,
      providerOperationId: input.providerOperationId,
      invocationAttemptId: input.invocationAttemptId
    });
    return true;
  }
  if (input.routeSnapshot.adapterKey === MINIMAX_H3_VIDEO_ADAPTER_ID) {
    if (!input.attachMinimax) return false;
    await input.attachMinimax({
      routeSnapshot: input.routeSnapshot,
      providerOperationId: input.providerOperationId,
      invocationAttemptId: input.invocationAttemptId
    });
    return true;
  }
  if (input.routeSnapshot.adapterKey === UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID) {
    if (!input.attachStudioH3) return false;
    await input.attachStudioH3({
      routeSnapshot: input.routeSnapshot,
      providerOperationId: input.providerOperationId,
      invocationAttemptId: input.invocationAttemptId
    });
    return true;
  }
  if (!input.remember) return false;
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
  if (!binding) return false;
  input.remember(input.providerOperationId, {
    connectionId: binding.connectionId,
    binding
  });
  return true;
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
    case 'newapi.invalid_request':
    case 'newapi.invalid_parameters':
      return '远端反馈：请求参数被拒绝，请检查模型与参数后重试';
    case 'newapi.authentication_failed':
    case 'newapi.credential_unavailable':
      return '远端反馈：鉴权失败，请检查服务商连接凭证';
    case 'newapi.permission_denied':
      return '远端反馈：当前凭证无权执行该操作';
    case 'newapi.insufficient_balance':
      return '远端反馈：服务商余额不足，请充值后再生成';
    case 'newapi.rate_limited':
      return '远端反馈：请求过于频繁，请稍后再试';
    case 'newapi.provider_unavailable':
      return '远端反馈：服务暂时不可用，请稍后重试';
    case 'newapi.timeout':
      return '远端反馈：请求超时，结果未知，禁止自动重试';
    case 'newapi.network_error':
      return '远端反馈：网络请求失败，结果未知，禁止自动重试';
    case 'newapi.invalid_response':
      return '远端反馈：响应无法解析，禁止自动重试';
    case 'newapi.route_mismatch':
    case 'newapi.protocol_mismatch':
      return '远端反馈：协议绑定与请求不匹配';
    case 'newapi.model_not_found':
      return '远端反馈：模型不存在或当前连接不可用';
    case 'newapi.request_too_large':
      return '远端反馈：请求内容过大，请缩短提示词或减小参数';
    case 'newapi.project_unavailable':
      return '请求发送前失败：当前项目会话不可用，请重新打开项目后再试';
    case 'newapi.material_not_found':
      return '请求发送前失败：参考图不可用，请重新选择图片后再提交';
    case 'newapi.material_changed':
      return '请求发送前失败：参考图在确认后发生变化，请重新选择图片后再提交';
    case 'newapi.material_invalid':
      return '请求发送前失败：参考图无法读取或格式不受支持，请更换图片';
    case 'newapi.material_too_large':
      return '请求发送前失败：参考图过大，请更换较小的图片';
    case 'minimax.invalid_request':
    case 'minimax.invalid_parameters':
    case 'minimax.h3-video.invalid_parameters':
      return '远端反馈：请求参数被拒绝，请检查模型与参数后重试';
    case 'minimax.authentication_failed':
    case 'minimax.credential_unavailable':
    case 'minimax.h3-video.authentication_failed':
    case 'minimax.h3-video.credential_unavailable':
      return '远端反馈：鉴权失败，请检查服务商连接凭证';
    case 'minimax.permission_denied':
    case 'minimax.h3-video.permission_denied':
      return '远端反馈：当前凭证无权执行该操作';
    case 'minimax.rate_limited':
    case 'minimax.h3-video.rate_limited':
      return '远端反馈：请求过于频繁，请稍后再试';
    case 'minimax.provider_unavailable':
    case 'minimax.h3-video.provider_unavailable':
      return '远端反馈：服务暂时不可用，请稍后重试';
    case 'minimax.timeout':
    case 'minimax.h3-video.timeout':
      return '远端反馈：请求超时，结果未知，禁止自动重试';
    case 'minimax.network_error':
    case 'minimax.h3-video.network_error':
      return '远端反馈：网络请求失败，结果未知，禁止自动重试';
    case 'minimax.invalid_response':
    case 'minimax.h3-video.invalid_response':
      return '远端反馈：响应无法解析，禁止自动重试';
    case 'minimax.route_mismatch':
    case 'minimax.protocol_mismatch':
    case 'minimax.h3-video.protocol_mismatch':
      return '远端反馈：协议绑定与请求不匹配';
    case 'minimax.invalid_image':
      return '请求发送前失败：参考图无法读取或格式不受支持，请更换图片';
    case 'unicompapi.studio-h3.invalid_request':
    case 'unicompapi.studio-h3-video.invalid_request':
    case 'unicompapi.studio-h3-video.invalid_parameters':
      return '远端反馈：请求参数被拒绝，请检查模型与参数后重试';
    case 'unicompapi.studio-h3.authentication_failed':
    case 'unicompapi.studio-h3.credential_unavailable':
    case 'unicompapi.studio-h3-video.authentication_failed':
    case 'unicompapi.studio-h3-video.credential_unavailable':
      return '远端反馈：鉴权失败，请检查服务商连接凭证';
    case 'unicompapi.studio-h3.permission_denied':
    case 'unicompapi.studio-h3-video.permission_denied':
      return '远端反馈：当前凭证无权执行该操作';
    case 'unicompapi.studio-h3.rate_limited':
    case 'unicompapi.studio-h3-video.rate_limited':
      return '远端反馈：请求过于频繁，请稍后再试';
    case 'unicompapi.studio-h3.provider_unavailable':
    case 'unicompapi.studio-h3-video.provider_unavailable':
      return '远端反馈：服务暂时不可用，请稍后重试';
    case 'unicompapi.studio-h3.content_moderation_pending':
    case 'unicompapi.studio-h3-video.content_moderation_pending':
    case 'content_moderation_pending':
      return '远端反馈：内容审核尚未完成，请稍后用同一请求重试';
    case 'unicompapi.studio-h3.timeout':
    case 'unicompapi.studio-h3-video.timeout':
      return '远端反馈：请求超时，结果未知，禁止自动重试';
    case 'unicompapi.studio-h3.network_error':
    case 'unicompapi.studio-h3-video.network_error':
      return '远端反馈：网络请求失败，结果未知，禁止自动重试';
    case 'unicompapi.studio-h3.invalid_response':
    case 'unicompapi.studio-h3-video.invalid_response':
      return '远端反馈：响应无法解析，禁止自动重试';
    case 'unicompapi.studio-h3.route_mismatch':
    case 'unicompapi.studio-h3.protocol_mismatch':
    case 'unicompapi.studio-h3-video.protocol_mismatch':
      return '远端反馈：协议绑定与请求不匹配';
    case 'adapter.submission_outcome_unknown':
    case 'adapter.failed_before_submission':
      return phase === 'before_request'
        ? '请求未成功发出，因此没有视频结果'
        : '远端已收到请求但未返回可用视频，禁止自动重试';
    default:
      return phase === 'before_request'
        ? '请求未成功发出，因此没有视频结果'
        : '远端已收到请求但未返回可用视频，禁止自动重试';
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

async function finalizeVideoInvocation(input: {
  readonly invocations: JsonProviderInvocationRepository;
  readonly attemptId: ProviderInvocationAttemptId;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown_outcome';
  readonly safeCode?: string;
  readonly failureDiagnostic?: ProviderFailureDiagnosticV1;
  readonly now: () => string;
}): Promise<void> {
  let events = await input.invocations.listEvents(input.attemptId);
  if (events.some((event) =>
    event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled' || event.type === 'outcome_unknown'
  )) return;

  if (input.status === 'completed' && !events.some((event) => event.type === 'result_received')) {
    const resultReceived = createProviderInvocationEvent({
      id: toProviderInvocationEventId(`invocation-event-${randomUUID()}`),
      invocationAttemptId: input.attemptId,
      sequence: events.length + 1,
      type: 'result_received',
      occurredAt: toIsoTimestamp(input.now())
    });
    await input.invocations.appendEvent(resultReceived);
    events = [...events, resultReceived];
  }

  const terminal = createProviderInvocationEvent({
    id: toProviderInvocationEventId(`invocation-event-${randomUUID()}`),
    invocationAttemptId: input.attemptId,
    sequence: events.length + 1,
    type: input.status === 'unknown_outcome' ? 'outcome_unknown' : input.status,
    ...(input.safeCode ? { safeCode: input.safeCode } : {}),
    ...(input.failureDiagnostic ? { failureDiagnostic: input.failureDiagnostic } : {}),
    occurredAt: toIsoTimestamp(input.now())
  });
  await input.invocations.appendEvent(terminal);
}
