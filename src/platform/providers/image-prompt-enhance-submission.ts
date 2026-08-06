import { randomUUID } from 'node:crypto';
import {
  createProviderExecutionRouteSnapshot,
  parseSubmissionConfirmationDto,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toDraftId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  type ImageWorkspaceDraft,
  type ImageWorkspaceRepository,
  type ParameterValue,
  type ParameterSchemaV2,
  type ProviderConnection,
  type StructuredCredentialRecord
} from '../../domain';
import type {
  ImagePromptEnhanceCandidateDto,
  ImagePromptEnhanceIpcErrorCode,
  ImagePromptEnhancePreparationDto,
  ImagePromptEnhanceSubmissionDto
} from '../../shared/image-prompt-enhance-ipc';
import type { SecureCredentialVault } from './credential-vault';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DeepSeekChatAdapter,
  type DeepSeekConversationLifecyclePort,
  type DeepSeekCredentialResolverPort,
  type DeepSeekSharedRuntime,
  type DeepSeekUsageObservationSinkPort
} from './deepseek';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NewApiChatAdapter,
  type NewApiConnectionResolverPort,
  type NewApiConversationLifecyclePort,
  type NewApiCredentialResolverPort,
  type NewApiParameterSchemaResolverPort,
  type NewApiSharedRuntime,
  type NewApiUsageObservationSinkPort
} from './newapi';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID } from './newapi/unicompapi-contracts';
import { createTextProviderFeatureContracts } from './project-text-feature';
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

const noopUsage: DeepSeekUsageObservationSinkPort & NewApiUsageObservationSinkPort = {
  async append() {
    return;
  }
};

const ENHANCE_SYSTEM_INSTRUCTION =
  '请将下列图片创作提示词改写得更清晰、具体、可执行。只输出改写后的提示词正文，不要解释、不加前后缀。';

export interface ImagePromptEnhanceSubmissionRuntimes {
  readonly deepSeekRuntime: DeepSeekSharedRuntime;
  readonly newApiRuntime: NewApiSharedRuntime;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
}

export class ImagePromptEnhanceError extends Error {
  constructor(
    readonly code: ImagePromptEnhanceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImagePromptEnhanceError';
  }
}

interface EnhancePreparationRecord {
  readonly token: string;
  readonly expiresAt: string;
  readonly confirmation: ImagePromptEnhancePreparationDto['confirmation'];
  readonly draftId: string;
  readonly draftUpdatedAt: string;
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly candidateId: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  readonly outboundText: string;
  readonly candidate: ResolvedFeatureCandidateV1;
  consumed?: boolean;
}

export class ImagePromptEnhanceService {
  private readonly preparations = new Map<string, EnhancePreparationRecord>();
  private readonly candidates: ProviderFeatureCandidateService;
  private readonly source: RegistryFeatureCandidateSource;
  private readonly now: () => string;

  constructor(
    private readonly options: {
      readonly projectId: string;
      readonly drafts: ImageWorkspaceRepository;
      readonly runtimes: ImagePromptEnhanceSubmissionRuntimes;
      readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort;
      readonly submissionAuthorization?: RuntimeAuthorizationOrchestrationPort;
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
          throw new Error('Image prompt enhance does not resolve draft subjects');
        }
      },
      this.source,
      new RouteSelectionTokenVault(),
      this.now
    );
  }

  listCandidates(
    productFeature: 'text_chat' | 'text_reasoning'
  ): Promise<readonly ImagePromptEnhanceCandidateDto[]> {
    return this.candidates.listCatalogForFeature({
      projectId: this.options.projectId,
      productFeature
    }) as Promise<readonly ImagePromptEnhanceCandidateDto[]>;
  }

  async prepare(input: {
    readonly draftId: string;
    readonly draftUpdatedAt: string;
    readonly productFeature: 'text_chat' | 'text_reasoning';
    readonly candidateId: string;
    readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  }): Promise<ImagePromptEnhancePreparationDto> {
    const draft = await this.requireSavedDraft(input.draftId, input.draftUpdatedAt);
    const outboundText = draft.prompt.originalInput.trim();
    if (!outboundText) {
      throw new ImagePromptEnhanceError('empty_prompt', 'Original prompt is empty');
    }
    const resolvedSubject = catalogSubject({
      projectId: this.options.projectId,
      productFeature: input.productFeature,
      outboundText,
      parameterValues: input.parameterValues
    });
    const resolved = (await this.source.list(resolvedSubject)).find(
      (item) => item.candidateId === input.candidateId
    );
    if (!resolved) {
      throw new ImagePromptEnhanceError('candidate_not_found', 'Candidate was not found');
    }
    const availability = await this.candidates.listCatalogForFeature({
      projectId: this.options.projectId,
      productFeature: input.productFeature
    });
    const dto = availability.find((item) => item.candidateId === input.candidateId);
    if (!dto) {
      throw new ImagePromptEnhanceError('candidate_not_found', 'Candidate was not found');
    }
    if (!dto.available) {
      throw new ImagePromptEnhanceError(
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
      contentCategories: resolved.contentCategories,
      parameterFieldCount: Object.keys(input.parameterValues).length,
      materialCount: 0,
      contextCount: 0,
      cost: resolved.cost
    });
    const token = `enhance-token-${randomUUID()}`;
    this.preparations.set(token, {
      token,
      expiresAt,
      confirmation,
      draftId: draft.id,
      draftUpdatedAt: draft.updatedAt,
      productFeature: input.productFeature,
      candidateId: input.candidateId,
      parameterValues: input.parameterValues,
      outboundText,
      candidate: resolved
    });
    return {
      schemaVersion: 1,
      routeSelectionToken: token,
      expiresAt,
      confirmation
    };
  }

  async submit(input: {
    readonly draftId: string;
    readonly draftUpdatedAt: string;
    readonly routeSelectionToken: string;
    readonly confirmationId: string;
    readonly confirmed: boolean;
  }): Promise<ImagePromptEnhanceSubmissionDto> {
    if (!input.confirmed) {
      throw new ImagePromptEnhanceError(
        'confirmation_required',
        'Explicit confirmation is required'
      );
    }
    const runtimes = this.options.runtimes;
    const preparation = this.preparations.get(input.routeSelectionToken);
    if (!preparation) {
      throw new ImagePromptEnhanceError(
        'route_selection_invalid',
        'Enhance preparation token is invalid'
      );
    }
    if (preparation.consumed) {
      throw new ImagePromptEnhanceError(
        'route_selection_consumed',
        'Enhance preparation token was already used'
      );
    }
    if (Date.parse(this.now()) >= Date.parse(preparation.expiresAt)) {
      throw new ImagePromptEnhanceError(
        'route_selection_expired',
        'Enhance preparation token expired'
      );
    }
    if (preparation.confirmation.confirmationId !== input.confirmationId) {
      throw new ImagePromptEnhanceError(
        'confirmation_required',
        'Confirmation ID does not match preparation'
      );
    }
    if (
      preparation.draftId !== input.draftId ||
      preparation.draftUpdatedAt !== input.draftUpdatedAt
    ) {
      throw new ImagePromptEnhanceError(
        'stale_route_selection',
        'Draft revision changed since preparation'
      );
    }
    const draft = await this.requireSavedDraft(input.draftId, input.draftUpdatedAt);
    if (draft.prompt.originalInput.trim() !== preparation.outboundText) {
      throw new ImagePromptEnhanceError(
        'stale_route_selection',
        'Outbound prompt text changed since preparation'
      );
    }

    const claimId = `claim-enhance-${randomUUID()}`;
    const authorization = this.options.submissionAuthorization;
    if (
      !authorization ||
      typeof authorization.claimSubmission !== 'function' ||
      typeof authorization.markRequestStarted !== 'function'
    ) {
      throw new ImagePromptEnhanceError(
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
      throw new ImagePromptEnhanceError(
        'authorization_not_claimed',
        'Runtime authorization could not be claimed'
      );
    }

    preparation.consumed = true;
    const collector = createCollectingLifecycle();
    const credentials = createRegistryCredentialResolver(
      runtimes.providerRegistry,
      runtimes.credentialVault
    );
    const connections = createRegistryConnectionResolver(runtimes.providerRegistry);
    const parameterSchemas = createTextParameterSchemaResolver();
    const deepSeekAdapter = new DeepSeekChatAdapter(
      runtimes.deepSeekRuntime,
      credentials,
      collector,
      noopUsage
    );
    const newApiAdapter = new NewApiChatAdapter(
      runtimes.newApiRuntime,
      credentials,
      connections,
      parameterSchemas,
      collector,
      noopUsage
    );

    const responseExecutionId = toConversationResponseExecutionId(
      `prompt-enhance-${randomUUID()}`
    );
    const invocationAttemptId = toProviderInvocationAttemptId(
      `prompt-enhance-attempt-${randomUUID()}`
    );
    const request = {
      responseExecutionId,
      invocationAttemptId,
      messages: [
        { role: 'system' as const, content: ENHANCE_SYSTEM_INSTRUCTION },
        { role: 'user' as const, content: preparation.outboundText }
      ],
      parameterValues: preparation.parameterValues
    };

    let requestStarted = false;
    const beforeRequestStarted = async () => {
      if (requestStarted) return;
      await authorization.markRequestStarted(claimId, this.now());
      requestStarted = true;
    };

    try {
      const handle = await dispatchEnhanceChat({
        routeSnapshot,
        request,
        beforeRequestStarted,
        deepSeekAdapter,
        newApiAdapter
      });
      const terminal = await handle.completion;
      if (terminal.state !== 'completed') {
        await authorization.recordOutcome?.(claimId, this.now()).catch(() => undefined);
        return {
          schemaVersion: 1,
          status: 'failed',
          draftId: draft.id,
          draftUpdatedAt: draft.updatedAt,
          safeCode:
            'safeCode' in terminal && typeof terminal.safeCode === 'string'
              ? terminal.safeCode
              : 'enhance.failed'
        };
      }
      const enhancedText = collector.getContent().trim();
      if (!enhancedText) {
        throw new ImagePromptEnhanceError('empty_result', 'Enhance returned empty text');
      }
      const nextDraft: ImageWorkspaceDraft = {
        ...draft,
        state: 'saved',
        prompt: {
          ...draft.prompt,
          systemSupplements: [
            ...draft.prompt.systemSupplements.filter(
              (item) => item.source !== 'enhancement'
            ),
            {
              content: enhancedText,
              source: 'enhancement',
              sourceReference: `prompt_enhance:${responseExecutionId}`
            }
          ]
        },
        updatedAt: toIsoTimestamp(this.now())
      };
      await this.options.drafts.save(nextDraft);
      await authorization.recordOutcome?.(claimId, this.now()).catch(() => undefined);
      return {
        schemaVersion: 1,
        status: 'completed',
        draftId: nextDraft.id,
        draftUpdatedAt: nextDraft.updatedAt,
        enhancedText
      };
    } catch (error) {
      if (!requestStarted) {
        await authorization.releaseBeforeRequest?.(claimId, this.now()).catch(() => undefined);
        if (error instanceof ImagePromptEnhanceError) throw error;
        throw new ImagePromptEnhanceError(
          'submission_failed_before_request',
          error instanceof Error ? error.message : 'Enhance failed before request'
        );
      }
      await authorization.recordOutcome?.(claimId, this.now()).catch(() => undefined);
      if (error instanceof ImagePromptEnhanceError) throw error;
      throw new ImagePromptEnhanceError(
        'submission_outcome_unknown',
        error instanceof Error ? error.message : 'Enhance outcome unknown'
      );
    }
  }

  private async requireSavedDraft(
    draftId: string,
    draftUpdatedAt: string
  ): Promise<ImageWorkspaceDraft> {
    const draft = await this.options.drafts.get(toDraftId(draftId));
    if (!draft || draft.projectId !== this.options.projectId) {
      throw new ImagePromptEnhanceError('draft_not_found', 'Image draft was not found');
    }
    if (draft.updatedAt !== draftUpdatedAt) {
      throw new ImagePromptEnhanceError(
        'draft_revision_changed',
        'Image draft revision changed'
      );
    }
    if (draft.state !== 'saved') {
      throw new ImagePromptEnhanceError(
        'subject_invalid',
        'Image draft must be saved before prompt enhance'
      );
    }
    return draft;
  }
}

function catalogSubject(input: {
  readonly projectId: string;
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly outboundText: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
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
    contextCount: 0,
    parameterValues: input.parameterValues,
    outboundTextSnapshot: input.outboundText,
    materialReferences: [],
    contextContentHashes: []
  };
}

function createCollectingLifecycle(): DeepSeekConversationLifecyclePort &
  NewApiConversationLifecyclePort & { getContent(): string } {
  let content = '';
  return {
    getContent: () => content,
    async start() {
      return;
    },
    async appendContent(_executionId, contentDelta) {
      content += contentDelta;
    },
    async complete() {
      return;
    },
    async requestCancel() {
      return;
    },
    async confirmCancelled() {
      return;
    },
    async fail() {
      return;
    },
    async interrupt() {
      return;
    }
  };
}

async function dispatchEnhanceChat(input: {
  readonly routeSnapshot: ReturnType<typeof createProviderExecutionRouteSnapshot>;
  readonly request: {
    readonly responseExecutionId: ReturnType<typeof toConversationResponseExecutionId>;
    readonly invocationAttemptId: ReturnType<typeof toProviderInvocationAttemptId>;
    readonly messages: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
    readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  };
  readonly beforeRequestStarted: () => Promise<void>;
  readonly deepSeekAdapter: DeepSeekChatAdapter;
  readonly newApiAdapter: NewApiChatAdapter;
}): Promise<{ completion: Promise<{ state: string; safeCode?: string }> }> {
  const route = input.routeSnapshot;
  const matchesDeepSeek =
    route.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID &&
    route.adapterKey === DEEPSEEK_CHAT_ADAPTER_ID &&
    route.adapterVersion === DEEPSEEK_CHAT_ADAPTER_VERSION &&
    route.packageVersion === DEEPSEEK_PROVIDER_PACKAGE_VERSION;
  const matchesNewApi =
    (route.packageId === NEWAPI_PROVIDER_PACKAGE_ID ||
      route.packageId === UNICOMPAPI_PROVIDER_PACKAGE_ID) &&
    route.adapterKey === NEWAPI_CHAT_ADAPTER_ID &&
    route.adapterVersion === NEWAPI_ADAPTER_VERSION;
  if (matchesDeepSeek) {
    return input.deepSeekAdapter.submit({
      routeSnapshot: route,
      request: input.request,
      beforeRequestStarted: input.beforeRequestStarted
    });
  }
  if (matchesNewApi) {
    return input.newApiAdapter.submit({
      routeSnapshot: route,
      request: input.request,
      beforeRequestStarted: input.beforeRequestStarted
    });
  }
  throw new ImagePromptEnhanceError(
    'adapter_contract_invalid',
    'No matching text adapter for the selected enhance route'
  );
}

function createRegistryCredentialResolver(
  registry: JsonProviderRegistryStore,
  vault: SecureCredentialVault
): DeepSeekCredentialResolverPort & NewApiCredentialResolverPort {
  return {
    async useCredential<T>(
      input: {
        readonly connectionId: string;
        readonly credentialVersionId: string;
      },
      operation: (credential: StructuredCredentialRecord) => Promise<T>
    ): Promise<T> {
      const snapshot = await registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === input.connectionId
      );
      if (
        !connection?.credentialReference ||
        connection.credentialVersionId !== input.credentialVersionId
      ) {
        throw new Error('Provider credential is unavailable for the selected route');
      }
      return vault.useRecord(connection.credentialReference, operation);
    }
  };
}

function createRegistryConnectionResolver(
  registry: JsonProviderRegistryStore
): NewApiConnectionResolverPort {
  return {
    async get(connectionId: string): Promise<ProviderConnection | undefined> {
      const snapshot = await registry.load();
      return snapshot.connections.find((item) => item.id === connectionId);
    }
  };
}

function createTextParameterSchemaResolver(): NewApiParameterSchemaResolverPort {
  const schemas = createTextProviderFeatureContracts().map(
    (contract) => contract.parameterSchema
  );
  return {
    async get(
      schemaId: string,
      revision: number
    ): Promise<ParameterSchemaV2 | undefined> {
      return schemas.find(
        (schema) => schema.schemaId === schemaId && schema.revision === revision
      );
    }
  };
}
