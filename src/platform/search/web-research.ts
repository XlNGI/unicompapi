import { createHash } from 'node:crypto';

export type WebResearchPolicy = 'internal_only' | 'web_only' | 'mixed';

export type WebResearchStatus =
  | 'skipped_internal_only'
  | 'needs_authorization'
  | 'completed'
  | 'offline_fallback'
  | 'cancelled';

export interface WebSearchAuthorization {
  readonly granted: boolean;
  readonly confirmedAt?: string;
  readonly outboundSummary: string;
  readonly allowedDomains: readonly string[];
}

export interface WebSearchTransportResult {
  readonly title: string;
  readonly url: string;
  readonly publishedAt?: string;
  readonly summary: string;
}

export interface WebSearchTransport {
  search(input: {
    readonly query: string;
    readonly allowedDomains: readonly string[];
    readonly maxResults: number;
    readonly signal: AbortSignal;
  }): Promise<readonly WebSearchTransportResult[]>;
}

export type WebSearchTransportErrorCode =
  | 'invalid_request'
  | 'provider_unconfigured'
  | 'credential_unavailable'
  | 'authentication_failed'
  | 'rate_limited'
  | 'dns_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'network_error'
  | 'response_invalid'
  | 'response_too_large';

export class WebSearchTransportError extends Error {
  constructor(readonly code: WebSearchTransportErrorCode) {
    super(`Web search transport failed: ${code}`);
    this.name = 'WebSearchTransportError';
  }
}

export interface ExternalEvidence {
  readonly citationId: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly publishedAt?: string;
  readonly retrievedAt: string;
  readonly summary: string;
  readonly contentHash: string;
}

export interface WebResearchResult {
  readonly status: WebResearchStatus;
  readonly evidence: readonly ExternalEvidence[];
  readonly reason?:
    | 'authorization_required'
    | 'no_allowed_domains'
    | 'invalid_request'
    | 'provider_unconfigured'
    | 'credential_unavailable'
    | 'authentication_failed'
    | 'rate_limited'
    | 'dns_unavailable'
    | 'timeout'
    | 'cancelled'
    | 'network_error'
    | 'response_invalid'
    | 'response_too_large'
    | 'no_results';
  readonly fromCache: boolean;
}

export class ControlledWebResearchService {
  private readonly cache = new Map<
    string,
    { readonly expiresAt: number; readonly evidence: readonly ExternalEvidence[] }
  >();

  constructor(
    private readonly options: {
      readonly transport: WebSearchTransport;
      readonly now?: () => Date;
      readonly cacheTtlMs?: number;
      readonly timeoutMs?: number;
    }
  ) {}

  async search(input: {
    readonly policy: WebResearchPolicy;
    readonly query: string;
    readonly authorization: WebSearchAuthorization;
    readonly maxResults?: number;
    readonly maxAgeDays?: number;
    readonly signal?: AbortSignal;
  }): Promise<WebResearchResult> {
    if (input.policy === 'internal_only') {
      return {
        status: 'skipped_internal_only',
        evidence: [],
        fromCache: false
      };
    }
    const query = sanitizeQuery(input.query);
    if (!query) {
      return {
        status: 'offline_fallback',
        evidence: [],
        reason: 'no_results',
        fromCache: false
      };
    }
    if (!input.authorization.granted) {
      return {
        status: 'needs_authorization',
        evidence: [],
        reason: 'authorization_required',
        fromCache: false
      };
    }
    const domains = normalizeDomains(input.authorization.allowedDomains);
    if (domains.length === 0) {
      return {
        status: 'offline_fallback',
        evidence: [],
        reason: 'no_allowed_domains',
        fromCache: false
      };
    }
    if (input.signal?.aborted) {
      return { status: 'cancelled', evidence: [], fromCache: false };
    }

    const maxResults = clampMaxResults(input.maxResults);
    const maxAgeDays = normalizeMaxAgeDays(input.maxAgeDays);
    const cacheKey = createCacheKey(query, domains, maxResults, maxAgeDays);
    const now = this.now().getTime();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return {
        status: 'completed',
        evidence: cached.evidence,
        fromCache: true
      };
    }
    if (cached) this.cache.delete(cacheKey);

    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 15_000
    );
    try {
      const raw = await this.options.transport.search({
        query,
        allowedDomains: domains,
        maxResults,
        signal: controller.signal
      });
      if (input.signal?.aborted) {
        return { status: 'cancelled', evidence: [], fromCache: false };
      }
      if (controller.signal.aborted) {
        return {
          status: 'offline_fallback',
          evidence: [],
          reason: 'timeout',
          fromCache: false
        };
      }
      const evidence = normalizeEvidence(raw, {
        allowedDomains: domains,
        maxResults,
        maxAgeDays,
        retrievedAt: this.now()
      });
      if (evidence.length === 0) {
        return {
          status: 'offline_fallback',
          evidence: [],
          reason: 'no_results',
          fromCache: false
        };
      }
      this.cache.set(cacheKey, {
        expiresAt: this.now().getTime() + (this.options.cacheTtlMs ?? 300_000),
        evidence
      });
      return { status: 'completed', evidence, fromCache: false };
    } catch (error) {
      if (input.signal?.aborted) {
        return { status: 'cancelled', evidence: [], fromCache: false };
      }
      if (error instanceof WebSearchTransportError) {
        if (error.code === 'cancelled') {
          return { status: 'cancelled', evidence: [], reason: 'cancelled', fromCache: false };
        }
        return {
          status: 'offline_fallback',
          evidence: [],
          reason: error.code,
          fromCache: false
        };
      }
      return {
        status: 'offline_fallback',
        evidence: [],
        reason: controller.signal.aborted ? 'timeout' : 'network_error',
        fromCache: false
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function normalizeEvidence(
  values: readonly WebSearchTransportResult[],
  options: {
    readonly allowedDomains: readonly string[];
    readonly maxResults: number;
    readonly maxAgeDays?: number;
    readonly retrievedAt: Date;
  }
): readonly ExternalEvidence[] {
  const seen = new Set<string>();
  const evidence: ExternalEvidence[] = [];
  for (const value of values) {
    if (evidence.length >= options.maxResults) break;
    const url = normalizeHttpsUrl(value.url);
    if (!url) continue;
    const domain = new URL(url).hostname.toLowerCase();
    if (!isAllowedDomain(domain, options.allowedDomains) || seen.has(url)) {
      continue;
    }
    const title = sanitizeExternalText(value.title, 300);
    const summary = sanitizeExternalText(value.summary, 2_000);
    if (!title || !summary) continue;
    const publishedAt = normalizePublishedAt(value.publishedAt, options);
    if (value.publishedAt !== undefined && publishedAt === undefined) continue;
    const contentHash = sha256(`${title}\n${url}\n${summary}`);
    seen.add(url);
    evidence.push({
      citationId: `web-${contentHash.slice(0, 16)}`,
      title,
      url,
      domain,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      retrievedAt: options.retrievedAt.toISOString(),
      summary,
      contentHash
    });
  }
  return evidence;
}

function normalizePublishedAt(
  value: string | undefined,
  options: { readonly maxAgeDays?: number; readonly retrievedAt: Date }
): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (options.maxAgeDays !== undefined) {
    const ageMs = options.retrievedAt.getTime() - date.getTime();
    if (ageMs < 0 || ageMs > options.maxAgeDays * 86_400_000) return undefined;
  }
  return date.toISOString();
}

function normalizeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeQuery(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1_000);
}

function sanitizeExternalText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^(?:system|developer|assistant|user)\s*:/gim, '')
    .replace(/ignore\s+(?:all\s+)?previous\s+instructions?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeDomains(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^\.+/, '')))]
    .filter((value) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value));
}

function isAllowedDomain(domain: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined) return 5;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new TypeError('maxResults must be an integer between 1 and 10');
  }
  return value;
}

function normalizeMaxAgeDays(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) {
    throw new TypeError('maxAgeDays must be an integer between 1 and 3650');
  }
  return value;
}

function createCacheKey(
  query: string,
  domains: readonly string[],
  maxResults: number,
  maxAgeDays: number | undefined
): string {
  return sha256(
    JSON.stringify({ query, domains, maxResults, maxAgeDays })
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
