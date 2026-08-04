import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  parseFeatureCandidateDto,
  parseFeatureCandidateSubject,
  parseSubmissionConfirmationDto,
  parseSubmissionPreparation,
  parseSubmissionUserConfirmation,
  projectParameterSchema,
  toIsoTimestamp,
  validateParameterSchemaV2,
  validateParameterValues,
  validateProductFeatureRequest,
  type FeatureCandidateAvailabilityReason,
  type FeatureCandidateCostFactV1,
  type FeatureCandidateDtoV1,
  type FeatureCandidateSubjectV1,
  type IsoTimestamp,
  type ParameterProjectionMode,
  type ParameterSchemaV2,
  type ParameterValue,
  type ProductFeature,
  type ProductFeatureSurface,
  type ProjectId,
  type ProviderExecutionRouteSnapshotV1,
  type SubmissionConfirmationDtoV1,
  type SubmissionPreparationV1,
  type SubmissionUserConfirmationV1
} from '../../domain';
import {
  noConnectionOutboundAuthorization,
  type ConnectionOutboundAuthorizationPort
} from './connection-outbound-authorization';

export interface FeatureSubjectMaterialReferenceV1 {
  readonly kind: 'asset' | 'file_reference';
  readonly referenceId: string;
  readonly revision: number;
}

export interface ResolvedFeatureSubjectV1 {
  readonly projectId: ProjectId;
  readonly subject: FeatureCandidateSubjectV1;
  readonly productFeature: ProductFeature;
  readonly surface: ProductFeatureSurface;
  readonly imageCount: number;
  readonly videoCount: number;
  readonly contextCount: number;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  readonly outboundTextSnapshot: string;
  readonly materialReferences: readonly FeatureSubjectMaterialReferenceV1[];
  readonly contextContentHashes: readonly string[];
}

export interface FeatureSubjectResolverPort {
  resolve(subject: FeatureCandidateSubjectV1): Promise<ResolvedFeatureSubjectV1>;
}

export interface FeatureCandidateEligibilityV1 {
  readonly modelEnabled: boolean;
  readonly catalogState: 'present' | 'missing' | 'retired';
  readonly connectionState: string;
  readonly profileStatus: 'declared' | 'verified' | 'restricted' | 'disabled';
  readonly featureSupported: boolean;
  readonly bindingAvailable: boolean;
  readonly runtimeAllowed: boolean;
  readonly schemasInterpretable: boolean;
}

export type ProviderExecutionRouteTemplateV1 = Omit<
  ProviderExecutionRouteSnapshotV1,
  'schemaVersion' | 'id' | 'projectId' | 'runtimeAuthorizationClaimId' | 'createdAt'
>;

export interface ResolvedFeatureCandidateV1 {
  readonly candidateId: string;
  readonly providerName: string;
  readonly connectionName: string;
  readonly modelName: string;
  readonly recipientName: string;
  readonly outboundScope: SubmissionConfirmationDtoV1['outboundScope'];
  readonly contentCategories: readonly string[];
  readonly parameterSchema: ParameterSchemaV2;
  readonly usageSchema: {
    readonly schemaId: string;
    readonly revision: number;
  };
  readonly cost: FeatureCandidateCostFactV1;
  readonly eligibility: FeatureCandidateEligibilityV1;
  readonly routeTemplate: ProviderExecutionRouteTemplateV1;
}

export interface FeatureCandidateSourcePort {
  list(subject: ResolvedFeatureSubjectV1): Promise<readonly ResolvedFeatureCandidateV1[]>;
}

export interface PreparedRouteSelectionRecordV1 {
  readonly tokenHash: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
  readonly candidateId: string;
  readonly subject: FeatureCandidateSubjectV1;
  readonly projectId: ProjectId;
  readonly bindingHash: string;
  readonly confirmation: SubmissionConfirmationDtoV1;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly authorizationRevision?: number;
  readonly consumedAt?: IsoTimestamp;
}

export type FeatureSubmissionErrorCode =
  | 'subject_invalid'
  | 'candidate_not_found'
  | 'candidate_unavailable'
  | 'route_selection_invalid'
  | 'route_selection_expired'
  | 'route_selection_consumed'
  | 'stale_route_selection'
  | 'confirmation_required';

export class FeatureSubmissionError extends Error {
  constructor(readonly code: FeatureSubmissionErrorCode, message: string) {
    super(message);
    this.name = 'FeatureSubmissionError';
  }
}

export class RouteSelectionTokenVault {
  private readonly records = new Map<string, PreparedRouteSelectionRecordV1>();

  issue(
    record: Omit<PreparedRouteSelectionRecordV1, 'tokenHash' | 'consumedAt'>
  ): { readonly token: string; readonly record: PreparedRouteSelectionRecordV1 } {
    const token = `rst1_${randomBytes(32).toString('base64url')}`;
    const tokenHash = sha256(token);
    const stored = { ...record, tokenHash };
    this.records.set(tokenHash, stored);
    return { token, record: stored };
  }

  inspect(token: string): PreparedRouteSelectionRecordV1 {
    if (!/^rst1_[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new FeatureSubmissionError(
        'route_selection_invalid',
        'The route selection token is malformed or has been tampered with'
      );
    }
    const record = this.records.get(sha256(token));
    if (!record) {
      throw new FeatureSubmissionError(
        'route_selection_invalid',
        'The route selection token is unknown or no longer valid'
      );
    }
    return structuredClone(record);
  }

  consume(token: string, consumedAt: IsoTimestamp): PreparedRouteSelectionRecordV1 {
    const record = this.inspect(token);
    if (record.consumedAt) {
      throw new FeatureSubmissionError(
        'route_selection_consumed',
        'The route selection token has already been consumed'
      );
    }
    const consumed = { ...record, consumedAt };
    this.records.set(record.tokenHash, consumed);
    return structuredClone(consumed);
  }
}

export class ProviderFeatureCandidateService {
  constructor(
    private readonly subjects: FeatureSubjectResolverPort,
    private readonly candidates: FeatureCandidateSourcePort,
    private readonly tokens: RouteSelectionTokenVault,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly tokenLifetimeMs = 5 * 60 * 1000,
    private readonly authorizations: ConnectionOutboundAuthorizationPort =
      noConnectionOutboundAuthorization
  ) {
    if (!Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs < 1_000) {
      throw new TypeError('Route selection token lifetime is invalid');
    }
  }

  async listFeatureCandidates(
    subject: FeatureCandidateSubjectV1
  ): Promise<readonly FeatureCandidateDtoV1[]> {
    const resolvedSubject = await this.resolveSubject(subject);
    const values = await this.candidates.list(resolvedSubject);
    return values
      .map((candidate) => this.toDto(resolvedSubject, candidate))
      .sort((left, right) =>
        left.providerName.localeCompare(right.providerName) ||
        left.connectionName.localeCompare(right.connectionName) ||
        left.modelName.localeCompare(right.modelName) ||
        left.candidateId.localeCompare(right.candidateId)
      );
  }

  async prepareSubmission(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly candidateId: string;
  }): Promise<SubmissionPreparationV1> {
    const now = toIsoTimestamp(this.now());
    const resolved = await this.resolveBinding(input.subject, input.candidateId);
    const expiresAt = toIsoTimestamp(
      new Date(Date.parse(now) + this.tokenLifetimeMs).toISOString()
    );
    const confirmation = parseSubmissionConfirmationDto({
      schemaVersion: 1,
      confirmationId: `confirmation-${randomUUID()}`,
      productFeature: resolved.subject.productFeature,
      providerName: resolved.candidate.providerName,
      connectionName: resolved.candidate.connectionName,
      modelName: resolved.candidate.modelName,
      recipientName: resolved.candidate.recipientName,
      outboundScope: resolved.candidate.outboundScope,
      contentCategories: resolved.candidate.contentCategories,
      parameterFieldCount: Object.keys(resolved.subject.parameterValues).length,
      materialCount: resolved.subject.materialReferences.length,
      contextCount: resolved.subject.contextCount,
      cost: resolved.candidate.cost
    });
    const bindingHash = bindingFingerprint(resolved.subject, resolved.candidate, confirmation);
    const authorization = await this.authorizations.check({
      connectionId: resolved.candidate.routeTemplate.connectionId,
      connectionRevision: resolved.candidate.routeTemplate.connectionRevision,
      recipientName: resolved.candidate.recipientName,
      scope: resolved.candidate.outboundScope,
      now
    });
    const issued = this.tokens.issue({
      nonce: `nonce-${randomUUID()}`,
      idempotencyKey: `submission-${randomUUID()}`,
      candidateId: resolved.candidate.candidateId,
      subject: resolved.subject.subject,
      projectId: resolved.subject.projectId,
      bindingHash,
      confirmation,
      issuedAt: now,
      expiresAt,
      authorizationRevision: authorization.authorizationRevision
    });
    return parseSubmissionPreparation({
      schemaVersion: 1,
      routeSelectionToken: issued.token,
      expiresAt,
      requiresConfirmation: !authorization.authorized,
      confirmation
    });
  }

  async validatePreparedSubmission(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation?: SubmissionUserConfirmationV1;
    readonly allowConsumed?: boolean;
  }): Promise<{
    readonly tokenRecord: PreparedRouteSelectionRecordV1;
    readonly subject: ResolvedFeatureSubjectV1;
    readonly candidate: ResolvedFeatureCandidateV1;
  }> {
    const tokenRecord = this.tokens.inspect(input.routeSelectionToken);
    const now = toIsoTimestamp(this.now());
    if (Date.parse(now) >= Date.parse(tokenRecord.expiresAt)) {
      throw new FeatureSubmissionError(
        'route_selection_expired',
        'The route selection token has expired'
      );
    }
    if (tokenRecord.consumedAt && !input.allowConsumed) {
      throw new FeatureSubmissionError(
        'route_selection_consumed',
        'The route selection token has already been consumed'
      );
    }
    const resolved = await this.resolveBinding(input.subject, tokenRecord.candidateId);
    const currentHash = bindingFingerprint(
      resolved.subject,
      resolved.candidate,
      tokenRecord.confirmation
    );
    if (
      canonicalJson(resolved.subject.subject) !== canonicalJson(tokenRecord.subject) ||
      resolved.subject.projectId !== tokenRecord.projectId ||
      currentHash !== tokenRecord.bindingHash
    ) {
      throw new FeatureSubmissionError(
        'stale_route_selection',
        'The draft, route, policy, parameters, media, context or cost facts changed'
      );
    }
    const authorization = tokenRecord.authorizationRevision === undefined
      ? { authorized: false as const }
      : await this.authorizations.check({
          connectionId: resolved.candidate.routeTemplate.connectionId,
          connectionRevision: resolved.candidate.routeTemplate.connectionRevision,
          recipientName: resolved.candidate.recipientName,
          scope: resolved.candidate.outboundScope,
          expectedAuthorizationRevision: tokenRecord.authorizationRevision,
          now
        });
    if (!authorization.authorized) {
      if (!input.confirmation) {
        throw new FeatureSubmissionError(
          'confirmation_required',
          'The exact prepared outbound confirmation is required'
        );
      }
      const confirmation = parseSubmissionUserConfirmation(input.confirmation);
      if (confirmation.confirmationId !== tokenRecord.confirmation.confirmationId) {
        throw new FeatureSubmissionError(
          'confirmation_required',
          'The exact prepared outbound confirmation is required'
        );
      }
      await this.authorizations.authorize({
        connectionId: resolved.candidate.routeTemplate.connectionId,
        connectionRevision: resolved.candidate.routeTemplate.connectionRevision,
        recipientName: resolved.candidate.recipientName,
        scope: resolved.candidate.outboundScope,
        confirmedAt: now
      });
    }
    return { tokenRecord, ...resolved };
  }

  consumePreparedSubmission(token: string): PreparedRouteSelectionRecordV1 {
    return this.tokens.consume(token, toIsoTimestamp(this.now()));
  }

  inspectPreparedSubmission(token: string): PreparedRouteSelectionRecordV1 {
    return this.tokens.inspect(token);
  }

  private async resolveBinding(
    subject: FeatureCandidateSubjectV1,
    candidateId: string
  ): Promise<{
    readonly subject: ResolvedFeatureSubjectV1;
    readonly candidate: ResolvedFeatureCandidateV1;
  }> {
    const resolvedSubject = await this.resolveSubject(subject);
    const candidate = (await this.candidates.list(resolvedSubject)).find(
      (item) => item.candidateId === candidateId
    );
    if (!candidate) {
      throw new FeatureSubmissionError('candidate_not_found', 'The selected candidate was not found');
    }
    const dto = this.toDto(resolvedSubject, candidate);
    if (!dto.available) {
      throw new FeatureSubmissionError(
        'candidate_unavailable',
        `The selected candidate is unavailable: ${dto.unavailableReasons.join(',')}`
      );
    }
    const projectionMode = parameterProjectionMode(resolvedSubject.surface);
    validateParameterValues(candidate.parameterSchema, projectionMode, resolvedSubject.parameterValues);
    return { subject: resolvedSubject, candidate };
  }

  private async resolveSubject(
    subject: FeatureCandidateSubjectV1
  ): Promise<ResolvedFeatureSubjectV1> {
    const parsed = parseFeatureCandidateSubject(subject);
    let resolved: ResolvedFeatureSubjectV1;
    try {
      resolved = await this.subjects.resolve(parsed);
      if (canonicalJson(resolved.subject) !== canonicalJson(parsed)) {
        throw new Error('subject revision changed');
      }
      validateProductFeatureRequest({
        productFeature: resolved.productFeature,
        surface: resolved.surface,
        imageCount: resolved.imageCount,
        videoCount: resolved.videoCount,
        contextCount: resolved.contextCount
      });
    } catch (error) {
      throw new FeatureSubmissionError(
        'subject_invalid',
        error instanceof Error ? error.message : 'The feature subject is invalid'
      );
    }
    return structuredClone(resolved);
  }

  private toDto(
    subject: ResolvedFeatureSubjectV1,
    candidate: ResolvedFeatureCandidateV1
  ): FeatureCandidateDtoV1 {
    const reasons = candidateReasons(subject, candidate);
    const projection = projectParameterSchema(
      validateParameterSchemaV2(candidate.parameterSchema),
      parameterProjectionMode(subject.surface)
    );
    return parseFeatureCandidateDto({
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      providerName: candidate.providerName,
      connectionName: candidate.connectionName,
      modelName: candidate.modelName,
      parameterSchema: projection,
      usageSchema: {
        schemaVersion: 1,
        schemaId: candidate.usageSchema.schemaId,
        revision: candidate.usageSchema.revision
      },
      cost: candidate.cost,
      available: reasons.length === 0,
      unavailableReasons: reasons
    });
  }
}

function candidateReasons(
  subject: ResolvedFeatureSubjectV1,
  candidate: ResolvedFeatureCandidateV1
): readonly FeatureCandidateAvailabilityReason[] {
  const reasons: FeatureCandidateAvailabilityReason[] = [];
  if (!candidate.eligibility.modelEnabled) reasons.push('model_disabled');
  if (candidate.eligibility.catalogState !== 'present') reasons.push('model_not_present');
  if (candidate.eligibility.connectionState !== 'available') reasons.push('connection_unavailable');
  if (candidate.eligibility.profileStatus !== 'verified') reasons.push('profile_unavailable');
  if (!candidate.eligibility.featureSupported ||
      candidate.routeTemplate.productFeature !== subject.productFeature ||
      candidate.parameterSchema.productFeature !== subject.productFeature) {
    reasons.push('feature_unsupported');
  }
  if (!candidate.eligibility.bindingAvailable) reasons.push('binding_unavailable');
  if (!candidate.eligibility.runtimeAllowed) reasons.push('runtime_not_allowed');
  if (!candidate.eligibility.schemasInterpretable) reasons.push('schema_unsupported');
  return [...new Set(reasons)];
}

function bindingFingerprint(
  subject: ResolvedFeatureSubjectV1,
  candidate: ResolvedFeatureCandidateV1,
  confirmation: SubmissionConfirmationDtoV1
): string {
  return sha256(canonicalJson({
    subject,
    candidate: {
      candidateId: candidate.candidateId,
      routeTemplate: candidate.routeTemplate,
      parameterSchema: candidate.parameterSchema,
      usageSchema: candidate.usageSchema,
      cost: candidate.cost,
      eligibility: candidate.eligibility,
      recipientName: candidate.recipientName,
      outboundScope: candidate.outboundScope,
      contentCategories: candidate.contentCategories
    },
    confirmation
  }));
}

function parameterProjectionMode(surface: ProductFeatureSurface): ParameterProjectionMode {
  return surface === 'quick' ? 'required_only' : 'full';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}
