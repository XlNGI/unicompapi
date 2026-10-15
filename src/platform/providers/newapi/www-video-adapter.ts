import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createProviderUsageObservation, parseProviderExecutionRouteSnapshot, toIsoTimestamp, validateParameterValues,
  type ProviderConnection, type ProviderExecutionRouteSnapshotV1, type ProviderInvocationAttemptId, type ProviderSubmitOutcome,
  type UsageFactV1 } from '../../../domain';
import type { ProviderAsyncOperationPort, ProviderAsyncOperationStatus } from '../provider-execution-lifecycle';
import { VideoResultPortError, type VideoResultPort } from '../../videos/video-result-port';
import type { NewApiVideoConnectionResolverPort, NewApiVideoCredentialResolverPort, ControlledNewApiImagePort,
  NewApiVideoUsageObservationSinkPort, NewApiVideoAdapterIdFactory } from './newapi-video-adapter';
import { NewApiRuntimeError, type NewApiSharedRuntime, type WwwVideoOperation } from './newapi-runtime';
import { NEWAPI_VIDEO_ADAPTER_ID, NEWAPI_VIDEO_PROTOCOL_ID, NEWAPI_VIDEO_RESULT_SCHEMA_ID, NEWAPI_ADAPTER_VERSION } from './newapi-contracts';
import { UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, UNICOMPAPI_WWW_BASE_URL, UNICOMPAPI_WWW_ENDPOINT_POLICY_ID } from './unicompapi-contracts';
import { wwwVideoContract, wwwVideoContractFingerprint, wwwVideoConstraint, wwwVideoParameterSchema, wwwVideoUsageSchema,
  type WwwVideoContract } from './www-video-contracts';

export interface ControlledWwwVideoPort {
  resolve(input: { readonly projectId: string; readonly assetId: string }): Promise<{
    readonly assetId: string; readonly mimeType: 'video/mp4'; readonly durationMs: number; readonly sizeBytes: number; readonly bytes: Uint8Array;
  }>;
}
interface Context {
  readonly route: ProviderExecutionRouteSnapshotV1;
  readonly contract: WwwVideoContract;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  usagePersisted: boolean;
  requestId?: string;
  assetId?: string;
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fail = () => new NewApiRuntimeError('invalid_response', 'not_retryable');
const invalid = () => new NewApiRuntimeError('invalid_parameters', 'not_retryable');
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(v)) throw fail(); return v; };
function json(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail(); }
  if (!record(value)) throw fail(); return value;
}

/** Original-Key WWW media lifecycle. No submit retry and no automatic settlement. */
export class WwwVideoAdapter implements ProviderAsyncOperationPort, VideoResultPort {
  private readonly operations = new Map<string, Context>();
  constructor(private readonly runtime: NewApiSharedRuntime, private readonly connections: NewApiVideoConnectionResolverPort,
    private readonly credentials: NewApiVideoCredentialResolverPort, private readonly images: ControlledNewApiImagePort,
    private readonly usage: NewApiVideoUsageObservationSinkPort, private readonly ids: NewApiVideoAdapterIdFactory,
    private readonly videos?: ControlledWwwVideoPort) {}

  async submit(input: { readonly routeSnapshot: unknown; readonly request: unknown; readonly beforeRequestStarted?: () => Promise<void>; readonly signal?: AbortSignal }): Promise<ProviderSubmitOutcome> {
    let started = false;
    let context: Context | undefined;
    let key: string | undefined;
    try {
      const route = this.validateRoute(input.routeSnapshot);
      const contract = wwwVideoContract(route.providerModelKey!)!;
      const r = input.request;
      if (!record(r) || r.projectId !== route.projectId || typeof r.prompt !== 'string' || !r.prompt.trim() ||
        r.prompt.length > contract.maximumPromptLength || typeof r.invocationAttemptId !== 'string') throw invalid();
      const values = validateParameterValues(wwwVideoParameterSchema(contract, route.productFeature), 'full', r.parameterValues);
      const cap = Math.floor(Number(values.maximum_cost_cny) * 1_000_000);
      if (!Number.isSafeInteger(cap) || cap <= 0) throw invalid();
      const assets: string[] = r.assetIds === undefined ? r.assetId === undefined ? [] : [id(r.assetId)] :
        Array.isArray(r.assetIds) ? r.assetIds.map(id) : (() => { throw invalid(); })();
      if (new Set(assets).size !== assets.length || r.assetId !== undefined && (assets.length !== 1 || assets[0] !== r.assetId)) throw invalid();
      const parameters = { ...values }; delete parameters.maximum_cost_cny;
      const mode = route.productFeature === 'text_to_video' ? 'text_to_video' : route.productFeature === 'video_edit' ? 'reference_video' :
        typeof values.generation_mode === 'string' ? values.generation_mode : contract.modelKey.endsWith('-i2v') ? 'first_frame' : 'reference_images';
      const roles = this.roles(contract, route.productFeature, mode, assets.length);
      if (contract.fields.some(f => f.name === 'generation_mode')) parameters.generation_mode = mode;
      if (parameters.frames !== undefined && parameters.duration_seconds !== undefined) throw invalid();
      context = { route, contract, invocationAttemptId: id(r.invocationAttemptId) as ProviderInvocationAttemptId, usagePersisted: false };
      // Deterministic key survives local recovery through the durable invocation attempt.
      key = `www-video-${createHash('sha256').update(context.invocationAttemptId).digest('hex')}`;
      await this.connection(context);
      // Authorization is consumed before any upload or quote sends user content.
      // `started` below separately tracks the charge-capable generation POST.
      await input.beforeRequestStarted?.();
      const referenceAssets: { id: string; source: 'upload'; role: string }[] = [];
      const localHashes: string[] = [];
      let total = 0;
      for (let i = 0; i < assets.length; i++) {
        if (input.signal?.aborted) throw new NewApiRuntimeError('cancelled', 'not_retryable');
        let bytes: Uint8Array; let mimeType: 'image/png' | 'image/jpeg' | 'video/mp4';
        if (route.productFeature === 'video_edit') {
          const video = await this.videos?.resolve({ projectId: route.projectId, assetId: assets[i] });
          if (!video || video.assetId !== assets[i] || video.mimeType !== 'video/mp4' || video.sizeBytes !== video.bytes.byteLength ||
            video.sizeBytes > 100_000_000 || video.durationMs < 3000 || video.durationMs > 60000) throw invalid();
          bytes = video.bytes; mimeType = video.mimeType;
        } else {
          const image = await this.images.resolve({ projectId: route.projectId, assetId: assets[i] });
          const lim = contract.imageLimits;
          if (image.assetId !== assets[i] || !['image/png', 'image/jpeg'].includes(image.mimeType) || image.sizeBytes !== image.bytes.byteLength ||
            image.sizeBytes > lim.maximumBytes || Math.min(image.width, image.height) < lim.minimumSide || Math.max(image.width, image.height) > lim.maximumSide ||
            image.width * image.height > lim.maximumPixels) throw invalid();
          if (contract.modelKey === 'happyhorse-1.1-i2v' && (image.width / image.height < 0.4 || image.width / image.height > 2.5)) throw invalid();
          total += image.sizeBytes;
          if ('maximumTotalBytes' in lim && lim.maximumTotalBytes !== undefined && total > lim.maximumTotalBytes) throw invalid();
          bytes = image.bytes; mimeType = image.mimeType as 'image/png' | 'image/jpeg';
        }
        localHashes.push(createHash('sha256').update(bytes).digest('hex'));
        const uploaded = await this.call(context, 'asset', { body: bytes, mimeType, modelKey: contract.modelKey,
          uploadProfile: 'uploadProfile' in contract ? contract.uploadProfile : undefined, signal: input.signal });
        const data = json(uploaded.body).data;
        if (!record(data)) throw fail();
        referenceAssets.push({ id: id(data.id), source: 'upload', role: roles[i] });
      }
      const original = { model: contract.modelKey, prompt: r.prompt, parameters,
        ...(referenceAssets.length ? { assetIds: referenceAssets.map(a => a.id), ...(contract.referenceBinding === 'explicit_roles' ? { referenceAssets } : {}) } : {}),
        ...(contract.protocol === 'h3-actions' ? { action: 'generate' } : {}) };
      const quoted = json((await this.call(context, 'quote', { body: encode({ ...original,
        ...(contract.protocol === 'h3-actions' ? { operation: 'quote' } : {}) }), signal: input.signal })).body);
      const quote = record(quoted.quote) ? quoted.quote : quoted;
      if (quote.currency !== 'CNY_MICRO' || !Number.isSafeInteger(quote.quoted_amount) || Number(quote.quoted_amount) <= 0 ||
        Number(quote.quoted_amount) > cap || typeof quote.price_version !== 'string' || quote.price_version.length < 1 || quote.price_version.length > 256 ||
        contract.quoteBinding === 'input_digest_and_price' && (typeof quote.input_digest !== 'string' || !/^[a-f0-9]{64}$/i.test(quote.input_digest)) ||
        quote.closed_reasons !== undefined && (!Array.isArray(quote.closed_reasons) || quote.closed_reasons.length > 0) ||
        contract.protocol === 'h3-actions' && !Array.isArray(quote.closed_reasons)) throw invalid();
      // The quote pins uploaded bytes; also reject a changed local source before paid submission.
      for (let i = 0; i < assets.length; i++) {
        const current = route.productFeature === 'video_edit' ? await this.videos?.resolve({ projectId: route.projectId, assetId: assets[i] }) :
          await this.images.resolve({ projectId: route.projectId, assetId: assets[i] });
        if (!current || createHash('sha256').update(current.bytes).digest('hex') !== localHashes[i]) throw invalid();
      }
      const body = encode({ ...original, ...(contract.protocol === 'h3-actions' ? { operation: 'submit' } : {}),
        ...(contract.quoteBinding === 'input_digest_and_price' ? { expected_input_digest: quote.input_digest } : {}),
        expected_price_version: quote.price_version, expected_quote_amount: quote.quoted_amount });
      const submitted = json((await this.call(context, 'submit', { body, idempotencyKey: key, signal: input.signal,
        beforeRequestStarted: async () => { started = true; } })).body);
      const task = this.task(submitted);
      const remote = id(task.id);
      if (task.model !== undefined && task.model !== contract.modelKey || this.operations.has(remote)) throw fail();
      this.operations.set(remote, context);
      return { kind: 'accepted_async', providerOperationId: remote, state: 'queued' };
    } catch (error) {
      // A single read can recover an accepted original request after transport ambiguity. Never POST again.
      if (started && context && key) {
        try {
          const lookup = json((await this.call(context, 'request_lookup', { idempotencyKey: key })).body);
          const request = record(lookup.data) ? lookup.data : lookup;
          const remote = id(request.task_id ?? request.media_task_id);
          this.operations.set(remote, context);
          return { kind: 'accepted_async', providerOperationId: remote, state: 'queued' };
        } catch { /* Preserve unknown outcome and its durable attempt; no generation retry. */ }
      }
      if (!started) return { kind: 'failed_before_submission', message: 'The WWW video generation request was not submitted', retryability: 'not_retryable' };
      const explicit = error instanceof NewApiRuntimeError && ['authentication_failed', 'permission_denied', 'insufficient_balance', 'invalid_parameters', 'invalid_request', 'model_not_found'].includes(error.code);
      if (started && !explicit) return { kind: 'submission_outcome_unknown', message: '视频提交结果待核，请查询原请求；不要重新生成。' };
      return { kind: 'failed_before_submission', message: error instanceof NewApiRuntimeError ? error.message : '视频参数或素材校验未通过。', retryability: 'not_retryable' };
    }
  }

  async attachOperation(input: { readonly routeSnapshot: unknown; readonly providerOperationId: string; readonly invocationAttemptId: ProviderInvocationAttemptId; readonly usageAlreadyPersisted?: boolean }): Promise<void> {
    const route = this.validateRoute(input.routeSnapshot);
    const remote = id(input.providerOperationId);
    const existing = this.operations.get(remote);
    if (existing && (existing.route.id !== route.id || existing.invocationAttemptId !== input.invocationAttemptId)) throw invalid();
    const context: Context = { route, contract: wwwVideoContract(route.providerModelKey!)!, invocationAttemptId: input.invocationAttemptId,
      usagePersisted: Boolean(input.usageAlreadyPersisted) };
    await this.connection(context); this.operations.set(remote, context);
  }
  knowsOperation(remote: string) { return this.operations.has(remote); }
  get attachedOperationCount() { return this.operations.size; }
  dispose() { this.operations.clear(); }
  async query(remote: string, signal?: AbortSignal): Promise<ProviderAsyncOperationStatus> {
    const context = this.context(remote);
    const task = this.task(json((await this.call(context, 'query', { remoteId: remote, signal })).body));
    if (task.id !== remote || task.model !== undefined && task.model !== context.contract.modelKey) throw fail();
    const status = typeof task.status === 'string' ? task.status.toLowerCase() : '';
    if (['queued', 'pending'].includes(status)) return { state: 'queued' };
    if (['running', 'processing', 'reviewing', 'submission_unknown', 'submitted'].includes(status)) return { state: 'processing' };
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      await this.persistUsage(context, task);
      return { state: 'failed', message: '原视频任务未交付，请查看原任务费用状态。', retryability: 'not_retryable' };
    }
    if (!['succeeded', 'success', 'completed'].includes(status)) throw fail();
    if (record(task.billing) && task.billing.settlement_pending === true) return { state: 'processing' };
    if (task.review_phase !== 'output_approved') throw fail();
    const data = task.data;
    if (!Array.isArray(data) || data.length !== 1 || !record(data[0])) throw fail();
    const asset = id(data[0].asset_id);
    // A returned private URL is a declaration, never an arbitrary fetch target.
    const expected = `/v1/${context.contract.protocol === 'h3-actions' ? 'h3/tasks' : 'videos'}/${remote}/content?asset_id=${encodeURIComponent(asset)}`;
    // Live WWW returns an absolute URL; public examples use a relative path.
    // Admit only the canonical same-origin spelling, and still build the download locally.
    if (data[0].url !== expected && data[0].url !== `https://www.unicompapi.com${expected}`) throw fail();
    context.assetId = asset;
    await this.persistUsage(context, task);
    return { state: 'completed' };
  }
  async cancel() { return { state: 'processing' as const }; }
  async getCompletion(remote: string) {
    const state = await this.query(remote);
    if (state.state === 'failed') throw new VideoResultPortError('not_retryable', state.message);
    return state.state === 'completed' ? { state: 'completed' as const } : undefined;
  }
  async listResults(remote: string) {
    if (!(await this.getCompletion(remote))) throw new VideoResultPortError('retryable', '原视频尚未交付。');
    return [{ remoteResultId: this.context(remote).assetId!, name: 'www-video', declaredMimeType: 'video/mp4' as const, declaredContainer: 'mp4' as const }];
  }
  async openDownload(remote: string, asset: string) {
    const context = this.context(remote);
    if (!(await this.getCompletion(remote)) || asset !== context.assetId) throw fail();
    const response = await this.call(context, 'content', { remoteId: remote, assetId: asset });
    if (response.contentType !== 'video/mp4') throw fail();
    return Readable.from([Buffer.from(response.body)]);
  }
  private validateRoute(value: unknown) {
    const route = parseProviderExecutionRouteSnapshot(value);
    const c = wwwVideoContract(route.providerModelKey ?? '');
    if (!c || route.packageId !== UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID || route.packageVersion !== '1.0.0' ||
      route.adapterKey !== NEWAPI_VIDEO_ADAPTER_ID || route.adapterVersion !== NEWAPI_ADAPTER_VERSION || route.protocolBindingRevision !== 1 ||
      route.endpointPolicyId !== UNICOMPAPI_WWW_ENDPOINT_POLICY_ID || route.endpointPolicyRevision !== 1 || route.featureMappingVersion !== 1 ||
      !(c.features as readonly string[]).includes(route.productFeature) || route.parameterSchemaId !== wwwVideoParameterSchema(c, route.productFeature).schemaId ||
      route.parameterSchemaRevision !== c.revision || route.constraintSetId !== wwwVideoConstraint(route.productFeature) || route.constraintSetRevision !== 1 ||
      route.resultSchemaId !== NEWAPI_VIDEO_RESULT_SCHEMA_ID || route.resultSchemaRevision !== 1 || route.usageSchemaId !== wwwVideoUsageSchema.id ||
      route.usageSchemaRevision !== 1 || route.parameterContract?.contractId !== c.id || route.parameterContract.contractRevision !== c.revision ||
      route.parameterContract.contractFingerprint !== wwwVideoContractFingerprint(c) || route.parameterContract.rules.length > 0) throw invalid();
    return route;
  }
  private roles(c: WwwVideoContract, feature: string, mode: string, count: number): string[] {
    if (feature === 'text_to_video') { if (count) throw invalid(); return []; }
    if (feature === 'video_edit') { if (count !== 1) throw invalid(); return ['reference_video']; }
    if (mode === 'first_frame' || mode === 'last_frame') { if (count !== 1) throw invalid(); return [mode]; }
    if (mode === 'first_last_frame') { if (count !== 2) throw invalid(); return ['first_frame', 'last_frame']; }
    if (mode !== 'reference_images' || count < 1 || count > c.imageLimits.maximum) throw invalid();
    return Array.from({ length: count }, () => 'reference_image');
  }
  private task(value: Record<string, unknown>) { return record(value.task) ? value.task : value; }
  private context(remote: string) { const c = this.operations.get(id(remote)); if (!c) throw invalid(); return c; }
  private async connection(context: Context): Promise<ProviderConnection> {
    const c = await this.connections.get(context.route.connectionId); const r = context.route;
    if (!c || c.providerId !== r.providerId || c.packageId !== r.packageId || c.endpoint !== UNICOMPAPI_WWW_BASE_URL ||
      c.connectionRevision !== r.connectionRevision || c.connectionConfigVersionId !== r.connectionConfigVersionId ||
      c.credentialVersionId !== r.credentialVersionId || c.state !== 'available' || c.credentialState !== 'valid' ||
      !c.adapterBindings?.some(b => b.adapterId === r.adapterKey && b.protocolId === NEWAPI_VIDEO_PROTOCOL_ID && b.adapterVersion === r.adapterVersion)) throw invalid();
    return c;
  }
  private async call(context: Context, operation: WwwVideoOperation, extra: Omit<Parameters<NewApiSharedRuntime['requestWwwVideo']>[0], 'connection' | 'credentials' | 'operation'>) {
    const connection = await this.connection(context);
    return this.credentials.useCredential({ connectionId: context.route.connectionId, credentialVersionId: context.route.credentialVersionId }, credentials =>
      this.runtime.requestWwwVideo({ ...extra, connection, credentials, operation, h3: context.contract.protocol === 'h3-actions',
        onResponseRequestId: requestId => { if (operation === 'submit') context.requestId = requestId; } }));
  }
  private async persistUsage(context: Context, task: Record<string, unknown>) {
    if (context.usagePersisted) return;
    const b = task.billing;
    const facts: UsageFactV1[] = record(b) && b.currency === 'CNY_MICRO' && Number.isSafeInteger(b.charged_amount) && Number(b.charged_amount) >= 0 ?
      [{ metricId: 'charged_amount', quantity: String(b.charged_amount), unit: 'CNY_MICRO', source: 'provider_body' }] : [];
    await this.usage.append(createProviderUsageObservation({ id: this.ids.nextProviderUsageObservationId(), invocationAttemptId: context.invocationAttemptId,
      usageSchemaId: wwwVideoUsageSchema.id, usageSchemaRevision: 1, sourceEventKey: `www_video_usage_${context.invocationAttemptId}`,
      sequence: 1, status: facts.length ? 'reported' : 'not_reported', sourceStage: 'poll', facts,
      ...(context.requestId ? { providerRequestId: context.requestId } : {}), observedAt: toIsoTimestamp(new Date().toISOString()) }, wwwVideoUsageSchema), wwwVideoUsageSchema);
    context.usagePersisted = true;
  }
}
