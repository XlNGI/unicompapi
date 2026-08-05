import { randomUUID } from 'node:crypto';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  createLocalResultObservation,
  toDraftId,
  toIsoTimestamp,
  toLocalResultObservationId,
  toProviderOperationRecordId,
  transitionExecution,
  type FeatureCandidateSubjectV1,
  type SubmissionUserConfirmationV1
} from '../../domain';
import type { ImageFeatureSubmissionDto } from '../../shared/image-feature-ipc';
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
import type {
  ImageFeatureControllerRuntime,
  ImageFeatureGenerateQuickInput
} from './image-feature-controller';
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
    candidates
  };

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
      const safeCode = [...acceptance.invocationEvents]
        .reverse()
        .find((event) => 'safeCode' in event && typeof event.safeCode === 'string')
        ?.safeCode;
      localResultError =
        safeCode === 'vidu.credential_unavailable'
          ? '凭证不可用：请到服务商连接里重新保存 Token 后再生成'
          : safeCode === 'vidu.credit_insufficient'
            ? '服务商积分不足（CreditInsufficient），请充值后再生成'
            : safeCode === 'vidu.invalid_request'
              ? '服务商拒绝了请求参数，请检查模型参数后重试'
              : `请求未成功发出（${safeCode ?? 'adapter.failed_before_submission'}），因此没有图片结果`;
    } else if (acceptance.intent.status === 'unknown_outcome') {
      localResultError =
        '提交结果未知，禁止自动当成成功，因此没有登记图片';
    }

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
      ...(localResultError ? { localResultError } : {})
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
