import { randomUUID } from 'node:crypto';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  createLocalResultObservation,
  recoverRemoteCompletedExecution,
  toDraftId,
  toIsoTimestamp,
  toLocalResultObservationId,
  toProviderOperationRecordId,
  toTaskId,
  transitionExecution,
  type FeatureCandidateSubjectV1,
  type SubmissionUserConfirmationV1
} from '../../domain';
import type {
  ImageFeatureRecoveryDto,
  ImageFeatureSubmissionDto
} from '../../shared/image-feature-ipc';
import {
  ImageDraftArtifactFactory,
  ProviderExecutionLifecycleService,
  ProviderSubmissionOrchestrator,
  ProjectImageFeatureSubjectResolver,
  ProjectImageMaterialResolver,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  SubmissionOrchestrationError,
  createImageFeatureDispatchBridge,
  createImageFeatureSubmissionIdFactory,
  createImageProviderFeatureContracts,
  assertImagePromptEnhancementSatisfied,
  extractImageResultUrls,
  imageDraftRevision,
  type ImageFeatureSubmissionRuntimes,
  type JsonProviderRegistryStore,
  type ProviderCandidateRuntimeAuthorizationPort,
  type ProviderPackageRegistry,
  type RuntimeAuthorizationOrchestrationPort,
  type SecureCredentialVault,
  type ViduProviderPackage
} from '../providers';
import {
  JsonAssetRepository,
  JsonExecutionRepository,
  JsonImageWorkspaceRepository,
  JsonLocalResultObservationRepository,
  JsonProjectContextRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderOperationRepository,
  JsonTaskRepository
} from '../repositories';
import {
  NodeProjectStorage,
  ProjectMetadataUnitOfWork,
  ProjectSubmissionAcceptanceStore,
  SubmissionIntentJournal,
  type ProjectSubmissionAcceptanceV1
} from '../storage';
import type { ImageFeatureControllerRuntime } from './image-feature-controller';
import type { ImageWorkspaceMutationCoordinator } from './image-workspace-mutations';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ImageFeatureRuntimeOptions {
  readonly session: StorageProjectSession;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
  readonly runtimeAuthorization: ProviderCandidateRuntimeAuthorizationPort;
  readonly submissionAuthorization?: RuntimeAuthorizationOrchestrationPort;
  readonly imageSubmission?: Omit<
    ImageFeatureSubmissionRuntimes,
    'providerRegistry' | 'providerPackages' | 'materials'
  > & {
    readonly viduPackage: ViduProviderPackage;
    readonly credentialVault: SecureCredentialVault;
  };
  readonly resultReceiver?: {
    receive(executionId: string): Promise<{
      readonly ok: true;
      readonly value: { readonly workId: string };
    } | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    }>;
  };
  readonly mutations: ImageWorkspaceMutationCoordinator;
  now?: () => string;
}

export function createImageFeatureControllerRuntime(
  options: ImageFeatureRuntimeOptions
): ImageFeatureControllerRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const storage = new NodeProjectStorage(options.session.rootDirectory);
  const drafts = new JsonImageWorkspaceRepository(storage, options.session.projectId);
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
    createImageProviderFeatureContracts()
  );
  const candidates = new ProviderFeatureCandidateService(
    new ProjectImageFeatureSubjectResolver(
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

  const runtime: ImageFeatureControllerRuntime = {
    drafts,
    candidates,
    assertPromptEnhancementSatisfied: (draft) =>
      assertImagePromptEnhancementSatisfied({
        projectId: options.session.projectId,
        draft,
        contexts
      })
  };

  const recoveryResultReceiver = options.resultReceiver;
  if (recoveryResultReceiver) {
    runtime.recoverResult = async (taskId): Promise<ImageFeatureRecoveryDto> => {
      const task = await tasks.get(toTaskId(taskId));
      if (!task || task.projectId !== options.session.projectId) {
        throw new Error('Image task not found in the open project');
      }
      const execution = [...await executions.list(task.id)]
        .filter((item) => task.executionIds.includes(item.id))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (
        task.submission.kind !== 'image_generation' ||
        !execution ||
        execution.state !== 'failed' ||
        execution.failure?.stage !== 'downloading' ||
        execution.failure.retryability !== 'retryable' ||
        execution.submissionOutcome !== 'completed_sync' ||
        !execution.providerOperationRecordId
      ) {
        throw new Error('This task does not have a recoverable image result download');
      }
      const operation = await operations.get(execution.providerOperationRecordId);
      if (
        !operation ||
        operation.taskId !== task.id ||
        operation.executionId !== execution.id ||
        operation.mediaKind !== 'image' ||
        operation.outcome.kind !== 'completed_sync'
      ) {
        throw new Error('The original image result reference is unavailable');
      }
      const attempt = (await invocations.list()).find(
        (item) =>
          item.subject.kind === 'media' &&
          item.subject.taskId === task.id &&
          item.subject.executionId === execution.id
      );
      const recovered = recoverRemoteCompletedExecution(
        execution,
        toIsoTimestamp(now())
      );
      await executions.save(recovered);
      const received = await recoveryResultReceiver.receive(recovered.id);
      if (!received.ok) throw new Error(received.error.message);
      if (attempt) {
        await localResults.append(
          createLocalResultObservation({
            id: toLocalResultObservationId(`local-result-${randomUUID()}`),
            invocationAttemptId: attempt.id,
            mediaKind: 'image',
            outputCount: 1,
            validationState: 'valid',
            observedAt: toIsoTimestamp(now())
          })
        );
      }
      return {
        schemaVersion: 1,
        taskId: task.id,
        executionId: recovered.id,
        workId: received.value.workId
      };
    };
  }

  const authorization = options.submissionAuthorization;
  const imageSubmission = options.imageSubmission;
  const canSubmit = Boolean(
    imageSubmission &&
    authorization &&
    typeof authorization.claimSubmission === 'function' &&
    typeof authorization.markRequestStarted === 'function' &&
    typeof authorization.releaseBeforeRequest === 'function' &&
    typeof authorization.recordOutcome === 'function'
  );

  if (!canSubmit || !imageSubmission || !authorization) {
    return runtime;
  }

  const acceptances = new ProjectSubmissionAcceptanceStore(
    new ProjectMetadataUnitOfWork(storage, now)
  );
  const journal = new SubmissionIntentJournal(storage, now);
  const artifacts = new ImageDraftArtifactFactory({
    drafts,
    tasks,
    executions,
    providerRegistry: options.providerRegistry
  });
  const materials = new ProjectImageMaterialResolver({
    getSession: () => options.session
  });
  const dispatch = createImageFeatureDispatchBridge({
    ...imageSubmission,
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
    createImageFeatureSubmissionIdFactory(),
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
        retryAllowed: false as const
      };
    }

    await persistCallRecordFacts({
      acceptance,
      routes,
      invocations
    });

    let workId: string | undefined;
    let localResultError: string | undefined;
    const resultImageUrls = acceptance.providerOperationRecord
      ? extractImageResultUrls(acceptance.providerOperationRecord.outcome)
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
          mediaKind: 'image',
          executionLifecycle: acceptance.providerOperationRecord.executionLifecycle,
          outcome: acceptance.providerOperationRecord.outcome
        });
      }
      if (execution?.state === 'remote_completed' && options.resultReceiver) {
        const received = await options.resultReceiver.receive(execution.id);
        if (received.ok) {
          workId = received.value.workId;
        } else {
          localResultError =
            `本地登记失败：${received.error.message}（${received.error.code}）`;
        }
      } else if (
        acceptance.intent.status === 'completed' &&
        !options.resultReceiver
      ) {
        localResultError = '本地登记失败：未配置图片结果接收器';
      } else if (
        acceptance.intent.status === 'completed' &&
        execution &&
        execution.state !== 'remote_completed' &&
        execution.state !== 'completed'
      ) {
        localResultError =
          `本地登记失败：执行状态为 ${execution.state}，无法落盘图片`;
      }
    } else if (
      acceptance.intent.status === 'failed_before_submission'
    ) {
      const safeCode = latestSafeCode(acceptance.invocationEvents);
      localResultError = userFacingSubmissionFeedback(safeCode, 'before_request');
      await lifecycle.applyUnrecordedSubmitOutcome({
        executionId: acceptance.subjectArtifacts.execution.id,
        outcome: 'failed_before_submission',
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
    const feedback =
      localResultError ??
      (workId
        ? '远端已返回结果，并已完成本地作品登记。'
        : resultImageUrls.length > 0
          ? '远端已返回图片结果。'
          : acceptance.intent.status === 'provider_accepted'
            ? '远端已接受请求。'
            : acceptance.intent.status === 'completed'
              ? '提交已完成。'
              : undefined);

    if (resultImageUrls.length > 0 || workId || localResultError) {
      await localResults.append(
        createLocalResultObservation({
          id: toLocalResultObservationId(`local-result-${randomUUID()}`),
          invocationAttemptId: acceptance.invocationAttempt.id,
          mediaKind: 'image',
          outputCount: Math.max(resultImageUrls.length, workId ? 1 : 0),
          validationState: workId ? 'valid' : resultImageUrls.length > 0 ? 'pending' : 'invalid',
          ...(resultImageUrls[0] ? { resultImageUrl: resultImageUrls[0] } : {}),
          observedAt: toIsoTimestamp(now())
        })
      );
    }

    return {
      schemaVersion: 1 as const,
      submissionIntentId: orchestration.submissionIntentId,
      status: orchestration.status,
      retryAllowed: false as const,
      invocationAttemptId: acceptance.invocationAttempt.id,
      taskId: acceptance.subjectArtifacts.task.id,
      executionId: acceptance.subjectArtifacts.execution.id,
      ...(workId ? { workId } : {}),
      ...(resultImageUrls.length > 0 ? { resultImageUrls } : {}),
      ...(localResultError ? { localResultError } : {}),
      ...(feedback ? { feedback } : {}),
      ...(feedbackSafeCode ? { safeCode: feedbackSafeCode } : {})
    } satisfies ImageFeatureSubmissionDto;
  };

  runtime.generateQuickImage = async (input) => {
    await options.mutations.wait();
    const createdAt = toIsoTimestamp(now());
    const draftId = toDraftId(`draft-quick-${randomUUID()}`);
    const empty = createEmptyImageWorkspaceDraft({
      id: draftId,
      projectId: options.session.projectId,
      mode: 'quick_image',
      createdAt
    });
    const prompt = input.prompt.trim();
    // Do not put candidateId on the draft without schema ids — domain
    // ImageFeatureSelection requires the three fields together. Candidate is
    // selected via prepareSubmission(candidateId) below.
    const saved = createImageWorkspaceDraft({
      ...empty,
      state: 'saved',
      prompt: {
        originalInput: prompt,
        systemSupplements: [],
        finalPrompt: prompt
      },
      featureSelection: {
        productFeature: 'text_to_image',
        parameterValues: input.parameterValues
      },
      updatedAt: createdAt
    });
    await drafts.save(saved);
    const subject: FeatureCandidateSubjectV1 = {
      kind: 'draft',
      draftId: saved.id,
      draftRevision: imageDraftRevision(saved.updatedAt)
    };
    const prepared = await candidates.prepareSubmission({
      subject,
      candidateId: input.candidateId
    });
    const confirmation: SubmissionUserConfirmationV1 = {
      schemaVersion: 1,
      confirmationId: prepared.confirmation.confirmationId,
      confirmed: true
    };
    const submission = await runtime.submit!({
      subject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    });
    return {
      schemaVersion: 1 as const,
      draftId: saved.id,
      draftUpdatedAt: saved.updatedAt,
      submission
    };
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

function userFacingSubmissionFeedback(
  safeCode: string | undefined,
  phase: 'before_request' | 'after_request'
): string {
  switch (safeCode) {
    case 'vidu.credential_unavailable':
    case 'newapi.credential_unavailable':
      return '凭证不可用：请到服务商连接里重新保存 Token 后再生成';
    case 'vidu.credit_insufficient':
      return '远端反馈：服务商积分不足，请充值后再生成';
    case 'vidu.invalid_request':
    case 'newapi.invalid_request':
      return '远端反馈：请求参数被拒绝，请检查模型与参数后重试';
    case 'newapi.invalid_response':
      return '远端已返回结果，但响应格式无法解析为可用图片';
    case 'vidu.authentication_failed':
    case 'newapi.authentication_failed':
      return '远端反馈：鉴权失败，请检查服务商连接凭证';
    case 'vidu.permission_denied':
    case 'newapi.permission_denied':
      return '远端反馈：当前凭证无权执行该操作';
    case 'vidu.rate_limited':
    case 'newapi.rate_limited':
      return '远端反馈：请求过于频繁，请稍后再试';
    case 'vidu.provider_unavailable':
    case 'newapi.provider_unavailable':
      return '远端反馈：服务暂时不可用，请稍后重试';
    case 'vidu.timeout':
    case 'newapi.timeout':
      return '远端反馈：请求超时，结果未知，禁止自动重试';
    case 'vidu.network_error':
    case 'newapi.network_error':
      return '远端反馈：网络请求失败，结果未知，禁止自动重试';
    case 'vidu.invalid_response':
      return '远端反馈：响应无法解析为有效图片，禁止自动重试';
    case 'vidu.proxy_unavailable':
    case 'newapi.proxy_unavailable':
      return '远端反馈：代理不可用，请检查网络代理设置';
    case 'vidu.protocol_mismatch':
    case 'newapi.protocol_mismatch':
    case 'newapi.route_mismatch':
      return '远端反馈：协议绑定与请求不匹配';
    case 'vidu.endpoint_not_allowed':
    case 'newapi.endpoint_not_allowed':
      return '远端反馈：目标接口不在允许范围内';
    case 'newapi.model_not_found':
      return '远端反馈：模型不存在或当前连接不可用';
    case 'newapi.insufficient_balance':
      return '远端反馈：账户余额不足，请充值后再生成';
    case 'newapi.invalid_parameters':
      return '远端反馈：请求参数无效，请检查模型与参数后重试';
    case 'newapi.request_too_large':
      return '远端反馈：请求内容过大，请缩短提示词或减小参数';
    case 'adapter.failed_before_submission':
      return phase === 'before_request'
        ? '请求未成功发出，因此没有图片结果'
        : '远端已收到请求但未返回可用图片，禁止自动重试';
    default:
      return phase === 'before_request'
        ? '请求未成功发出，因此没有图片结果'
        : '远端已收到请求但未返回可用图片，禁止自动重试';
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
