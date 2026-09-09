import { randomUUID } from 'node:crypto';
import {
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createProviderUsageObservation,
  createProviderExecutionRouteSnapshot,
  parseSubmissionConfirmationDto,
  toConversationId,
  toConversationResponseDraftId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderUsageObservationId,
  promptEnhanceInputFingerprint,
  promptEnhanceSourceReference,
  type ParameterValue,
  type ProjectContextOutboundSnapshotV1,
  type ProviderExecutionRouteSnapshotRepository,
  type ProviderInvocationRepository,
  type ProviderUsageObservationRepository
} from '../../domain';
import type {
  PromptEnhanceCandidateDto,
  PromptEnhanceIpcErrorCode,
  PromptEnhancePreparationDto,
  PromptEnhanceSubmissionDto
} from '../../shared/prompt-enhance-ipc';
import type { SecureCredentialVault } from './credential-vault';
import type { DeepSeekSharedRuntime } from './deepseek';
import type { NewApiSharedRuntime } from './newapi';
import { createTextProviderFeatureContracts } from './project-text-feature';
import { isPromptOnceUserParameter, submitPromptOnce } from './prompt-once-text-adapter';
import type { JsonProviderRegistryStore } from './provider-registry';
import type { ProviderPackageRegistry } from './provider-package-registry';
import {
  ProviderFeatureCandidateService,
  RouteSelectionTokenVault,
  type ResolvedFeatureCandidateV1,
  type ResolvedFeatureSubjectV1
} from './provider-feature-candidates';
import {
  ProviderFeatureContractRegistry,
  RegistryFeatureCandidateSource,
  type ProviderCandidateRuntimeAuthorizationPort
} from './provider-registry-feature-candidates';
import type { RuntimeAuthorizationOrchestrationPort } from './provider-submission-orchestrator';

const ENHANCE_SYSTEM_INSTRUCTION =
  '你是创作提示词优化器。请将用户原始创作需求与系统拼接好的结构化文案结合，根据语义进行优化，生成清晰、具体、可直接执行的最终提示词。保留用户核心意图，合理吸收项目上下文，不得编造不存在的事实；删除重复、冲突和无法执行的表达。只输出最终提示词正文，不要解释、标题、前后缀或 Markdown。';

export interface PromptEnhanceSubmissionRuntimes {
  readonly deepSeekRuntime: DeepSeekSharedRuntime;
  readonly newApiRuntime: NewApiSharedRuntime;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
}

export class PromptEnhanceError extends Error {
  constructor(
    readonly code: PromptEnhanceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PromptEnhanceError';
  }
}

// Compatibility names for the first image host while callers migrate to the generic contract.

export interface PromptEnhanceSubjectSnapshot {
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly originalInput: string;
  readonly additionalPromptContent: string;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
  readonly kind: 'image_workspace' | 'video_workspace';
}

export interface PromptEnhanceSubjectPort {
  load(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
  }): Promise<PromptEnhanceSubjectSnapshot>;
  saveEnhancement(input: {
    readonly subject: PromptEnhanceSubjectSnapshot;
    readonly enhancedText: string;
    readonly sourceReference: string;
    readonly updatedAt: string;
  }): Promise<{ readonly subjectId: string; readonly subjectRevision: string }>;
}

interface EnhancePreparationRecord {
  readonly token: string;
  readonly expiresAt: string;
  readonly confirmation: PromptEnhancePreparationDto['confirmation'];
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly productFeature: 'text_reasoning';
  readonly candidateId: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  readonly outboundText: string;
  readonly inputFingerprint: string;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
  readonly candidate: ResolvedFeatureCandidateV1;
  state: 'ready' | 'submitting' | 'consumed';
}

export function claimPromptEnhancePreparation(record: {
  state: EnhancePreparationRecord['state'];
}): void {
  if (record.state !== 'ready') {
    throw new PromptEnhanceError(
      'route_selection_consumed',
      'Enhance preparation token was already used'
    );
  }
  record.state = 'submitting';
}

export interface PromptEnhanceAuditRepositories {
  readonly routes: ProviderExecutionRouteSnapshotRepository;
  readonly invocations: ProviderInvocationRepository;
  readonly usage: ProviderUsageObservationRepository;
}

export class PromptEnhanceService {
  private readonly preparations = new Map<string, EnhancePreparationRecord>();
  private readonly candidates: ProviderFeatureCandidateService;
  private readonly source: RegistryFeatureCandidateSource;
  private readonly now: () => string;

  constructor(
    private readonly options: {
      readonly projectId: string;
      readonly subjects: PromptEnhanceSubjectPort;
      readonly runtimes: PromptEnhanceSubmissionRuntimes;
      readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort;
      readonly submissionAuthorization?: RuntimeAuthorizationOrchestrationPort;
      readonly audit?: PromptEnhanceAuditRepositories;
      now?: () => string;
    }
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    const contracts = new ProviderFeatureContractRegistry(
      createTextProviderFeatureContracts()
    );
    this.source = new RegistryFeatureCandidateSource(
      options.runtimes.providerRegistry,
      options.runtimes.providerPackages,
      contracts,
      options.runtimeAuthorization ?? {
        async checkAccess() {
          return {
            allowed: false,
            operation: 'submit' as const,
            reason: 'no_matching_policy' as const
          };
        }
      }
    );
    this.candidates = new ProviderFeatureCandidateService(
      {
        async resolve() {
          throw new Error('Prompt enhance does not resolve catalog subjects');
        }
      },
      this.source,
      new RouteSelectionTokenVault(),
      this.now
    );
  }

  listCandidates(
    productFeature: 'text_reasoning' = 'text_reasoning'
  ): Promise<readonly PromptEnhanceCandidateDto[]> {
    return this.candidates.listCatalogForFeature({
      projectId: this.options.projectId,
      productFeature
    }).then((candidates) => candidates.map((candidate) => ({
      ...candidate,
      parameterSchema: {
        ...candidate.parameterSchema,
        fields: candidate.parameterSchema.fields.filter(
          (field) => isPromptOnceUserParameter(field.fieldId)
        )
      }
    }))) as Promise<readonly PromptEnhanceCandidateDto[]>;
  }

  async prepare(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
    readonly productFeature: 'text_reasoning';
    readonly candidateId: string;
    readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  }): Promise<PromptEnhancePreparationDto> {
    const subject = await this.options.subjects.load(input);
    const originalInput = subject.originalInput.trim();
    const additionalPromptContent = subject.additionalPromptContent.trim();
    if (
      !originalInput &&
      !additionalPromptContent &&
      subject.contextSnapshots.length === 0
    ) {
      throw new PromptEnhanceError('empty_prompt', 'Original prompt is empty');
    }
    const contextSnapshots = subject.contextSnapshots;
    const outboundText = buildEnhancePrompt(
      originalInput,
      contextSnapshots,
      additionalPromptContent
    );
    const inputFingerprint = await promptEnhanceInputFingerprint({
      originalInput,
      structuredInput: additionalPromptContent,
      contextSnapshots
    });
    const resolvedSubject = catalogSubject({
      projectId: this.options.projectId,
      productFeature: input.productFeature,
      outboundText,
      parameterValues: input.parameterValues,
      contextSnapshots
    });
    const resolved = (await this.source.list(resolvedSubject)).find(
      (item) => item.candidateId === input.candidateId
    );
    if (!resolved) {
      throw new PromptEnhanceError('candidate_not_found', 'Candidate was not found');
    }
    const availability = await this.candidates.listCatalogForFeature({
      projectId: this.options.projectId,
      productFeature: input.productFeature
    });
    const dto = availability.find((item) => item.candidateId === input.candidateId);
    if (!dto) {
      throw new PromptEnhanceError('candidate_not_found', 'Candidate was not found');
    }
    if (!dto.available) {
      throw new PromptEnhanceError(
        'candidate_unavailable',
        `Candidate unavailable: ${dto.unavailableReasons.join(',')}`
      );
    }
    const now = toIsoTimestamp(this.now());
    const expiresAt = toIsoTimestamp(
      new Date(Date.parse(now) + 10 * 60 * 1000).toISOString()
    );
    const confirmation = parseSubmissionConfirmationDto({
      schemaVersion: 1,
      confirmationId: `confirmation-enhance-${randomUUID()}`,
      productFeature: input.productFeature,
      providerName: resolved.providerName,
      connectionName: resolved.connectionName,
      modelName: resolved.modelName,
      recipientName: resolved.recipientName,
      outboundScope: resolved.outboundScope,
      contentCategories: [...new Set(resolved.contentCategories)],
      parameterFieldCount: Object.keys(input.parameterValues).length,
      materialCount: 0,
      contextCount: contextSnapshots.length,
      cost: resolved.cost
    });
    const token = `enhance-token-${randomUUID()}`;
    this.preparations.set(token, {
      token,
      expiresAt,
      confirmation,
      subjectId: subject.subjectId,
      subjectRevision: subject.subjectRevision,
      productFeature: input.productFeature,
      candidateId: input.candidateId,
      parameterValues: input.parameterValues,
      outboundText,
      inputFingerprint,
      contextSnapshots,
      candidate: resolved,
      state: 'ready'
    });
    return {
      schemaVersion: 1,
      routeSelectionToken: token,
      expiresAt,
      confirmation
    };
  }

  async submit(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
    readonly routeSelectionToken: string;
    readonly confirmationId: string;
    readonly confirmed: boolean;
  }): Promise<PromptEnhanceSubmissionDto> {
    if (!input.confirmed) {
      throw new PromptEnhanceError(
        'confirmation_required',
        'Explicit confirmation is required'
      );
    }
    const runtimes = this.options.runtimes;
    const preparation = this.preparations.get(input.routeSelectionToken);
    if (!preparation) {
      throw new PromptEnhanceError(
        'route_selection_invalid',
        'Enhance preparation token is invalid'
      );
    }
    if (Date.parse(this.now()) >= Date.parse(preparation.expiresAt)) {
      throw new PromptEnhanceError(
        'route_selection_expired',
        'Enhance preparation token expired'
      );
    }
    if (preparation.confirmation.confirmationId !== input.confirmationId) {
      throw new PromptEnhanceError(
        'confirmation_required',
        'Confirmation ID does not match preparation'
      );
    }
    if (
      preparation.subjectId !== input.subjectId ||
      preparation.subjectRevision !== input.subjectRevision
    ) {
      throw new PromptEnhanceError(
        'stale_route_selection',
        'Subject revision changed since preparation'
      );
    }
    claimPromptEnhancePreparation(preparation);
    const subject = await this.options.subjects.load(input);
    const currentFingerprint = await promptEnhanceInputFingerprint({
      originalInput: subject.originalInput,
      structuredInput: subject.additionalPromptContent,
      contextSnapshots: subject.contextSnapshots
    });
    if (currentFingerprint !== preparation.inputFingerprint) {
      throw new PromptEnhanceError(
        'stale_route_selection',
        'Prompt enhance inputs changed since preparation'
      );
    }

    const claimId = `claim-enhance-${randomUUID()}`;
    const authorization = this.options.submissionAuthorization;
    if (
      !authorization ||
      typeof authorization.claimSubmission !== 'function' ||
      typeof authorization.markRequestStarted !== 'function'
    ) {
      throw new PromptEnhanceError(
        'runtime_not_allowed',
        'Runtime authorization is not approved for prompt enhance'
      );
    }

    const routeSnapshot = createProviderExecutionRouteSnapshot({
      id: toProviderExecutionRouteSnapshotId(`route-enhance-${randomUUID()}`),
      projectId: toProjectId(this.options.projectId),
      ...preparation.candidate.routeTemplate,
      providerDisplayName: preparation.candidate.providerName,
      connectionDisplayName: preparation.candidate.connectionName,
      modelDisplayName: preparation.candidate.modelName,
      runtimeAuthorizationClaimId: claimId,
      createdAt: toIsoTimestamp(this.now())
    });
    const invocationAttemptId = toProviderInvocationAttemptId(
      `invocation-enhance-${randomUUID()}`
    );
    let eventSequence = 1;
    const appendAuditEvent = async (
      type: Parameters<typeof createProviderInvocationEvent>[0]['type'],
      safeCode?: string
    ) => {
      if (!this.options.audit) return;
      const sequence = eventSequence + 1;
      await this.options.audit.invocations.appendEvent(createProviderInvocationEvent({
        id: toProviderInvocationEventId(`event-enhance-${randomUUID()}`),
        invocationAttemptId,
        sequence,
        type,
        ...(safeCode ? { safeCode } : {}),
        occurredAt: toIsoTimestamp(this.now())
      }));
      eventSequence = sequence;
    };
    if (this.options.audit) {
      const createdAt = toIsoTimestamp(this.now());
      await this.options.audit.routes.save(routeSnapshot);
      await this.options.audit.invocations.create(
        createProviderInvocationAttempt({
          id: invocationAttemptId,
          projectId: toProjectId(this.options.projectId),
          subject: { kind: 'prompt_once', subjectId: preparation.subjectId },
          routeSnapshotId: routeSnapshot.id,
          createdAt
        }),
        createProviderInvocationEvent({
          id: toProviderInvocationEventId(`event-enhance-${randomUUID()}`),
          invocationAttemptId,
          sequence: 1,
          type: 'submission_started',
          occurredAt: createdAt
        })
      );
    }

    try {
      await authorization.claimSubmission({
        providerPackageId: routeSnapshot.packageId,
        connectionId: routeSnapshot.connectionId,
        adapterKey: routeSnapshot.adapterKey,
        policyRevision: routeSnapshot.runtimePolicyRevision,
        routeSelectionNonce: preparation.token,
        idempotencyKey: `enhance-${preparation.token}`,
        claimId,
        now: this.now()
      });
    } catch {
      preparation.state = 'consumed';
      await appendAuditEvent('submission_failed_before_request', 'authorization_not_claimed')
        .catch(() => undefined);
      throw new PromptEnhanceError(
        'authorization_not_claimed',
        'Runtime authorization could not be claimed'
      );
    }

    let requestStarted = false;
    const beforeRequestStarted = async () => {
      if (requestStarted) return;
      await authorization.markRequestStarted(claimId, this.now());
      requestStarted = true;
    };

    try {
      const result = await submitPromptOnce({
        runtimes,
        routeSnapshot,
        prompt: preparation.outboundText,
        parameterValues: preparation.parameterValues,
        beforeRequestStarted
      });
      const enhancedText = result.content.trim();
      if (!enhancedText) {
        throw new PromptEnhanceError('empty_result', 'Enhance returned empty text');
      }
      await appendAuditEvent('provider_accepted');
      if (this.options.audit) {
        await this.options.audit.usage.append(createProviderUsageObservation({
          id: toProviderUsageObservationId(`usage-enhance-${randomUUID()}`),
          invocationAttemptId,
          usageSchemaId: result.usageSchema.id,
          usageSchemaRevision: result.usageSchema.revision,
          sourceEventKey: `enhance_${randomUUID().replace(/-/gu, '')}`,
          sequence: 1,
          status: result.usageStatus,
          sourceStage: 'result',
          facts: result.usageFacts,
          observedAt: toIsoTimestamp(this.now())
        }, result.usageSchema), result.usageSchema);
      }
      const persisted = await this.options.subjects.saveEnhancement({
        subject,
        enhancedText,
        sourceReference: promptEnhanceSourceReference({
          inputFingerprint: preparation.inputFingerprint,
          executionId: result.providerOperationId
        }),
        updatedAt: toIsoTimestamp(this.now())
      });
      await authorization.recordOutcome?.(claimId, this.now()).catch(() => undefined);
      await appendAuditEvent('completed');
      preparation.state = 'consumed';
      return {
        schemaVersion: 1,
        status: 'completed',
        subjectId: persisted.subjectId,
        subjectRevision: persisted.subjectRevision,
        enhancedText
      };
    } catch (error) {
      preparation.state = 'consumed';
      if (!requestStarted) {
        await authorization.releaseBeforeRequest?.(claimId, this.now()).catch(() => undefined);
        await appendAuditEvent('submission_failed_before_request', 'prompt_once.failed_before_request')
          .catch(() => undefined);
        if (error instanceof PromptEnhanceError) throw error;
        throw new PromptEnhanceError(
          'submission_failed_before_request',
          error instanceof Error ? error.message : 'Enhance failed before request'
        );
      }
      await authorization.recordOutcome?.(claimId, this.now()).catch(() => undefined);
      await appendAuditEvent('outcome_unknown', 'prompt_once.outcome_unknown')
        .catch(() => undefined);
      if (error instanceof PromptEnhanceError) throw error;
      throw new PromptEnhanceError(
        'submission_outcome_unknown',
        error instanceof Error ? error.message : 'Enhance outcome unknown'
      );
    }
  }

}

function catalogSubject(input: {
  readonly projectId: string;
  readonly productFeature: 'text_reasoning';
  readonly outboundText: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
}): ResolvedFeatureSubjectV1 {
  return {
    projectId: toProjectId(input.projectId),
    subject: {
      kind: 'conversation_response_draft',
      conversationId: toConversationId('conversation-prompt-enhance'),
      conversationRevision: 1,
      responseDraftId: toConversationResponseDraftId('response-draft-prompt-enhance'),
      responseDraftRevision: 1,
      userMessageId: toMessageId('message-prompt-enhance')
    },
    productFeature: input.productFeature,
    surface: 'professional',
    imageCount: 0,
    videoCount: 0,
    contextCount: input.contextSnapshots.length,
    parameterValues: input.parameterValues,
    outboundTextSnapshot: input.outboundText,
    materialReferences: [],
    contextContentHashes: input.contextSnapshots.map((context) => context.contentHash)
  };
}

export function buildEnhancePrompt(
  originalInput: string,
  contextSnapshots: readonly ProjectContextOutboundSnapshotV1[],
  additionalPromptContent = ''
): string {
  const contexts = contextSnapshots.length === 0
    ? '（无项目上下文）'
    : contextSnapshots.map((context, index) => [
        `<project_context index="${index + 1}" revision="${context.contextRevision}">`,
        context.contentSnapshot,
        '</project_context>'
      ].join('\n')).join('\n\n');
  const prompt = [
    ENHANCE_SYSTEM_INSTRUCTION,
    '',
    '<project_contexts>',
    contexts,
    '</project_contexts>',
    '',
    '<user_input>',
    originalInput,
    '</user_input>'
  ].join('\n');
  const structured = additionalPromptContent.trim();
  const composed = structured
    ? [
        prompt,
        '',
        '<structured_input>',
        structured,
        '</structured_input>'
      ].join('\n')
    : prompt;
  if (composed.length > 500_000) {
    throw new PromptEnhanceError(
      'subject_invalid',
      'Prompt enhance input is too large'
    );
  }
  return composed;
}
