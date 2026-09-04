import type { ConversationWorkflowV1 } from '../domain';

export type ConversationWebResearchFailureCode =
  | 'web_authorization_required'
  | 'web_authorization_expired'
  | 'web_authorization_mismatch'
  | 'web_domain_not_allowed'
  | 'web_query_not_allowed'
  | 'web_provider_unconfigured'
  | 'web_credential_unavailable'
  | 'web_authentication_failed'
  | 'web_rate_limited'
  | 'web_timeout'
  | 'web_cancelled'
  | 'web_network_error'
  | 'web_response_invalid'
  | 'web_response_too_large'
  | 'web_no_results'
  | 'source_required_unavailable';

export interface ConversationWebLocalChunk {
  readonly chunkId: string;
  readonly sourceKind: string;
  readonly source: string;
  readonly text: string;
  readonly contentHash: string;
  readonly indexVersion: string;
}

export interface ConversationWebExternalEvidence {
  readonly citationId: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly publishedAt?: string;
  readonly retrievedAt: string;
  readonly summary: string;
  readonly contentHash: string;
}

export interface ConversationWebResearchReference {
  readonly kind: 'local' | 'web';
  readonly citationId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly contentHash: string;
  readonly sourceKind?: string;
  readonly indexVersion?: string;
  readonly url?: string;
  readonly domain?: string;
  readonly publishedAt?: string;
  readonly retrievedAt?: string;
}

export interface ConversationWebResearchPort {
  search(input: {
    readonly policy: 'web_only' | 'mixed';
    readonly query: string;
    readonly authorization: {
      readonly granted: boolean;
      readonly confirmedAt: string;
      readonly outboundSummary: string;
      readonly allowedDomains: readonly string[];
    };
    readonly maxResults: number;
    readonly maxAgeDays?: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status:
      | 'completed'
      | 'needs_authorization'
      | 'offline_fallback'
      | 'cancelled'
      | 'skipped_internal_only';
    readonly evidence: readonly ConversationWebExternalEvidence[];
    readonly reason?: string;
  }>;
}

export interface ConversationWebLocalRetrievalPort {
  retrieve(input: {
    readonly query: string;
    readonly k: number;
  }): Promise<readonly ConversationWebLocalChunk[]>;
}

export interface ConversationWebResearchConfiguration {
  readonly enabled: boolean;
  readonly providerName?: string;
  readonly allowedDomains: readonly string[];
  readonly outboundSummary: string;
  readonly allowMixedQueries: boolean;
  readonly maxResults?: number;
  readonly maxAgeDays?: number;
  readonly localResultThreshold?: number;
  readonly authorizationTtlMs?: number;
  readonly cost?: {
    readonly state: 'known' | 'unknown' | 'not_applicable';
    readonly summary?: string;
  };
}

export interface ConversationWebResearchSession {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly conversationRevision: number;
  readonly planHash: string;
  readonly queryHash: string;
  readonly status:
    | 'local_ready'
    | 'authorization_required'
    | 'searching'
    | 'completed'
    | 'unavailable'
    | 'failed'
    | 'cancelled';
  readonly references: readonly ConversationWebResearchReference[];
  readonly authorization?: {
    readonly querySummary: string;
    readonly outboundSummary: string;
    readonly allowedDomains: readonly string[];
    readonly providerName: string;
    readonly expiresAt: string;
    readonly cost: {
      readonly state: 'known' | 'unknown' | 'not_applicable';
      readonly summary?: string;
    };
  };
  readonly failureCode?: ConversationWebResearchFailureCode;
  readonly updatedAt: string;
}

interface ActiveResearchSession {
  readonly public: ConversationWebResearchSession;
  readonly query: string;
  readonly controller?: AbortController;
}

export class ConversationWebResearchService {
  private readonly sessions = new Map<string, ActiveResearchSession>();

  constructor(
    private readonly research: ConversationWebResearchPort,
    private readonly configuration: ConversationWebResearchConfiguration,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async preview(input: {
    readonly workflow: ConversationWorkflowV1;
    readonly conversationRevision: number;
    readonly query: string;
    readonly local: ConversationWebLocalRetrievalPort;
  }): Promise<ConversationWebResearchSession> {
    requireReadyWebWorkflow(input.workflow);
    const query = normalizeQuery(input.query);
    if (!query) {
      return this.saveUnavailable(input, '', 'web_query_not_allowed', []);
    }
    const [planHash, queryHash] = await Promise.all([
      sha256(JSON.stringify(input.workflow.plan)),
      sha256(query)
    ]);
    const local = await input.local.retrieve({ query, k: 3 }).catch(() => []);
    const localReferences = toLocalReferences(local);
    const threshold = this.configuration.localResultThreshold ?? 1;
    if (
      input.workflow.plan.sourcePolicy === 'mixed' &&
      localReferences.length >= threshold
    ) {
      return this.save({
        projectId: input.workflow.projectId,
        workflowId: input.workflow.id,
        workflowRevision: input.workflow.revision,
        conversationRevision: input.conversationRevision,
        planHash,
        queryHash,
        status: 'local_ready',
        references: localReferences,
        updatedAt: this.now()
      }, query);
    }
    if (!this.configuration.enabled || !this.configuration.providerName) {
      return this.saveUnavailable(
        input,
        query,
        'web_provider_unconfigured',
        localReferences,
        planHash,
        queryHash
      );
    }
    if (
      input.workflow.plan.sourcePolicy === 'mixed' &&
      !this.configuration.allowMixedQueries
    ) {
      return this.saveUnavailable(
        input,
        query,
        'web_query_not_allowed',
        localReferences,
        planHash,
        queryHash
      );
    }
    const allowedDomains = normalizeDomains(this.configuration.allowedDomains);
    if (allowedDomains.length === 0) {
      return this.saveUnavailable(
        input,
        query,
        'web_domain_not_allowed',
        localReferences,
        planHash,
        queryHash
      );
    }
    const ttlMs = this.configuration.authorizationTtlMs ?? 10 * 60 * 1_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60 * 1_000) {
      throw new TypeError('authorizationTtlMs is invalid');
    }
    return this.save({
      projectId: input.workflow.projectId,
      workflowId: input.workflow.id,
      workflowRevision: input.workflow.revision,
      conversationRevision: input.conversationRevision,
      planHash,
      queryHash,
      status: 'authorization_required',
      references: localReferences,
      authorization: {
        querySummary: query.slice(0, 500),
        outboundSummary: this.configuration.outboundSummary.slice(0, 500),
        allowedDomains,
        providerName: this.configuration.providerName,
        expiresAt: new Date(Date.parse(this.now()) + ttlMs).toISOString(),
        cost: this.configuration.cost ?? { state: 'unknown' }
      },
      failureCode: 'web_authorization_required',
      updatedAt: this.now()
    }, query);
  }

  async authorize(input: {
    readonly workflow: ConversationWorkflowV1;
    readonly conversationRevision: number;
    readonly planHash: string;
    readonly confirmed: true;
  }): Promise<ConversationWebResearchSession> {
    requireReadyWebWorkflow(input.workflow);
    const active = this.sessions.get(input.workflow.id);
    if (!active || active.public.status !== 'authorization_required') {
      return this.failFromThinking(
        input.workflow,
        active,
        'web_authorization_required'
      );
    }
    const currentPlanHash = await sha256(JSON.stringify(input.workflow.plan));
    if (
      input.planHash !== active.public.planHash ||
      currentPlanHash !== active.public.planHash ||
      input.workflow.revision !== active.public.workflowRevision ||
      input.conversationRevision !== active.public.conversationRevision
    ) {
      return this.failFromActive(active, 'web_authorization_mismatch');
    }
    const authorization = active.public.authorization;
    if (!authorization || authorization.expiresAt <= this.now()) {
      return this.failFromActive(active, 'web_authorization_expired');
    }
    const controller = new AbortController();
    this.sessions.set(input.workflow.id, {
      ...active,
      controller,
      public: {
        ...active.public,
        status: 'searching',
        failureCode: undefined,
        updatedAt: this.now()
      }
    });
    const result = await this.research.search({
      policy: input.workflow.plan.sourcePolicy === 'mixed' ? 'mixed' : 'web_only',
      query: active.query,
      authorization: {
        granted: input.confirmed,
        confirmedAt: this.now(),
        outboundSummary: authorization.outboundSummary,
        allowedDomains: authorization.allowedDomains
      },
      maxResults: this.configuration.maxResults ?? 5,
      ...(this.configuration.maxAgeDays !== undefined
        ? { maxAgeDays: this.configuration.maxAgeDays }
        : {}),
      signal: controller.signal
    });
    if (result.status === 'cancelled') {
      return this.failFromActive(active, 'web_cancelled', 'cancelled');
    }
    if (result.status !== 'completed' || result.evidence.length === 0) {
      return this.failFromActive(active, mapResearchFailure(result.reason));
    }
    const references = deduplicateReferences([
      ...active.public.references,
      ...toExternalReferences(result.evidence)
    ]);
    return this.save({
      ...active.public,
      status: 'completed',
      references,
      failureCode: undefined,
      updatedAt: this.now()
    }, active.query);
  }

  getStatus(projectId: string, workflowId: string): ConversationWebResearchSession | undefined {
    const active = this.sessions.get(workflowId);
    if (!active || active.public.projectId !== projectId) return undefined;
    const authorizationExpiresAt = active.public.authorization?.expiresAt;
    if (
      active.public.status === 'authorization_required' &&
      authorizationExpiresAt !== undefined &&
      authorizationExpiresAt <= this.now()
    ) {
      return this.failFromActive(active, 'web_authorization_expired');
    }
    return structuredClone(active.public);
  }

  cancel(input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowRevision: number;
  }): ConversationWebResearchSession {
    const active = this.sessions.get(input.workflowId);
    if (
      !active ||
      active.public.projectId !== input.projectId ||
      active.public.workflowRevision !== input.workflowRevision
    ) {
      throw new ConversationWebResearchError('web_authorization_mismatch');
    }
    active.controller?.abort();
    return this.failFromActive(active, 'web_cancelled', 'cancelled');
  }

  private saveUnavailable(
    input: {
      readonly workflow: ConversationWorkflowV1;
      readonly conversationRevision: number;
    },
    query: string,
    failureCode: ConversationWebResearchFailureCode,
    references: readonly ConversationWebResearchReference[],
    planHash = '0'.repeat(64),
    queryHash = '0'.repeat(64)
  ): ConversationWebResearchSession {
    return this.save({
      projectId: input.workflow.projectId,
      workflowId: input.workflow.id,
      workflowRevision: input.workflow.revision,
      conversationRevision: input.conversationRevision,
      planHash,
      queryHash,
      status: 'unavailable',
      references,
      failureCode,
      updatedAt: this.now()
    }, query);
  }

  private failFromThinking(
    workflow: ConversationWorkflowV1,
    active: ActiveResearchSession | undefined,
    failureCode: ConversationWebResearchFailureCode
  ): ConversationWebResearchSession {
    if (active) return this.failFromActive(active, failureCode);
    const current: ConversationWebResearchSession = {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      conversationRevision: 0,
      planHash: '0'.repeat(64),
      queryHash: '0'.repeat(64),
      status: 'failed',
      references: [],
      failureCode,
      updatedAt: this.now()
    };
    return this.save(current, '');
  }

  private failFromActive(
    active: ActiveResearchSession,
    failureCode: ConversationWebResearchFailureCode,
    status: 'failed' | 'cancelled' = 'failed'
  ): ConversationWebResearchSession {
    return this.save({
      ...active.public,
      status,
      failureCode,
      updatedAt: this.now()
    }, active.query);
  }

  private save(
    session: ConversationWebResearchSession,
    query: string
  ): ConversationWebResearchSession {
    const publicSession = structuredClone(session);
    this.sessions.set(session.workflowId, { public: publicSession, query });
    return structuredClone(publicSession);
  }
}

export class ConversationWebResearchError extends Error {
  constructor(readonly code: ConversationWebResearchFailureCode) {
    super(code);
    this.name = 'ConversationWebResearchError';
  }
}

function requireReadyWebWorkflow(workflow: ConversationWorkflowV1): void {
  if (workflow.status !== 'ready') {
    throw new TypeError('Conversation workflow is not ready');
  }
  if (workflow.plan.sourcePolicy !== 'web' && workflow.plan.sourcePolicy !== 'mixed') {
    throw new TypeError('Conversation workflow does not request web research');
  }
}

function normalizeQuery(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

function normalizeDomains(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^\.+/, '')))]
    .filter((value) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value))
    .slice(0, 32);
}

function toLocalReferences(
  chunks: readonly ConversationWebLocalChunk[]
): readonly ConversationWebResearchReference[] {
  return deduplicateReferences(chunks.map((chunk) => ({
    kind: 'local' as const,
    citationId: chunk.chunkId,
    title: chunk.source,
    excerpt: chunk.text.slice(0, 1_000),
    contentHash: chunk.contentHash,
    sourceKind: chunk.sourceKind,
    indexVersion: chunk.indexVersion
  })));
}

function toExternalReferences(
  evidence: readonly ConversationWebExternalEvidence[]
): readonly ConversationWebResearchReference[] {
  return evidence.map((item) => ({
    kind: 'web' as const,
    citationId: item.citationId,
    title: item.title,
    excerpt: item.summary,
    contentHash: item.contentHash,
    url: item.url,
    domain: item.domain,
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    retrievedAt: item.retrievedAt
  }));
}

function deduplicateReferences(
  references: readonly ConversationWebResearchReference[]
): readonly ConversationWebResearchReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.contentHash)) return false;
    seen.add(reference.contentHash);
    return true;
  });
}

function mapResearchFailure(reason: string | undefined): ConversationWebResearchFailureCode {
  if (reason === 'provider_unconfigured') return 'web_provider_unconfigured';
  if (reason === 'invalid_request') return 'web_response_invalid';
  if (reason === 'no_allowed_domains') return 'web_domain_not_allowed';
  const supported: readonly ConversationWebResearchFailureCode[] = [
    'web_provider_unconfigured',
    'web_credential_unavailable',
    'web_authentication_failed',
    'web_rate_limited',
    'web_timeout',
    'web_cancelled',
    'web_network_error',
    'web_response_invalid',
    'web_response_too_large',
    'web_no_results'
  ];
  const code = reason?.startsWith('web_') ? reason : `web_${reason ?? 'network_error'}`;
  return supported.includes(code as ConversationWebResearchFailureCode)
    ? code as ConversationWebResearchFailureCode
    : 'web_network_error';
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable');
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(bytes)]
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('');
}
