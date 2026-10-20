import { createProviderConnection, createProviderExecutionRouteSnapshot, toConnectionId, toIsoTimestamp, toModelId, toProjectId,
  toProtocolBindingId, toProviderExecutionRouteSnapshotId, toProviderId, toProviderInvocationAttemptId, toProviderUsageObservationId,
  type ProductFeature, type ProviderConnection, type ProviderUsageObservationV1 } from '../../src/domain';
import { NewApiSharedRuntime, type NewApiHttpTransportRequest, type NewApiHttpTransportResponse } from '../../src/platform/providers/newapi/newapi-runtime';
import { NewApiVideoAdapter } from '../../src/platform/providers/newapi/newapi-video-adapter';
import { NEWAPI_ADAPTER_VERSION, NEWAPI_PROTOCOL_VERSION, NEWAPI_VIDEO_ADAPTER_ID, NEWAPI_VIDEO_PROTOCOL_ID, NEWAPI_VIDEO_RESULT_SCHEMA_ID } from '../../src/platform/providers/newapi/newapi-contracts';
import { UNICOMPAPI_WWW_BASE_URL, UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, UNICOMPAPI_WWW_ENDPOINT_POLICY_ID } from '../../src/platform/providers/newapi/unicompapi-contracts';
import { wwwVideoContract, wwwVideoConstraint, wwwVideoContractFingerprint, wwwVideoParameterSchema, wwwVideoUsageSchema } from '../../src/platform/providers/newapi/www-video-contracts';
import { testPng } from './png';

export const wwwTime = toIsoTimestamp('2026-10-15T07:00:00.000Z');
export function wwwConnection(): ProviderConnection {
  return createProviderConnection({ id: toConnectionId('connection-www-fixture'), providerId: toProviderId('provider-www-fixture'),
    name: 'WWW synthetic', endpoint: UNICOMPAPI_WWW_BASE_URL, packageId: UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID,
    packageVersion: '1.0.0', templateId: 'unicompapi-www-relay', templateKind: 'official', endpointPolicyId: UNICOMPAPI_WWW_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
    connectionPolicyId: 'connection.unicompapi.www-relay', connectionPolicyRevision: 1, discoveryPolicyId: 'discovery.unicompapi.www-models', discoveryPolicyRevision: 1,
    connectionRevision: 1, connectionConfigVersionId: 'config-www-fixture-1', credentialVersionId: 'credential-www-fixture-1',
    credentialSchemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
    identityState: 'verified', credentialState: 'valid', state: 'available',
    adapterBindings: [{ adapterId: NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION, protocolId: NEWAPI_VIDEO_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION }],
    createdAt: wwwTime, updatedAt: wwwTime });
}
export function wwwRoute(key: string, feature?: ProductFeature) {
  const contract = wwwVideoContract(key)!; const f = feature ?? contract.features[0] as ProductFeature;
  const c = wwwConnection();
  return createProviderExecutionRouteSnapshot({ id: toProviderExecutionRouteSnapshotId(`route-www-${key}-${f}`), projectId: toProjectId('project-www-fixture'),
    packageId: c.packageId!, packageVersion: '1.0.0', adapterKey: NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION,
    providerId: c.providerId, connectionId: c.id, connectionRevision: 1, connectionConfigVersionId: c.connectionConfigVersionId!,
    endpointPolicyId: c.endpointPolicyId!, endpointPolicyRevision: 1, credentialVersionId: c.credentialVersionId!,
    modelId: toModelId(`model-www-${key}`), providerModelKey: key, modelRevision: 1, profileId: `profile-www-${key}`, profileRevision: 1,
    protocolBindingId: toProtocolBindingId('binding-www-fixture'), protocolBindingRevision: 1, productFeature: f,
    internalPurpose: f === 'text_to_video' ? 'video_generation' : 'reference_to_video', featureMappingVersion: 1,
    parameterSchemaId: wwwVideoParameterSchema(contract, f).schemaId, parameterSchemaRevision: contract.revision,
    resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID, resultSchemaRevision: 1, usageSchemaId: wwwVideoUsageSchema.id, usageSchemaRevision: 1,
    constraintSetId: wwwVideoConstraint(f), constraintSetRevision: 1, runtimePolicyId: 'runtime-www-fixture', runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-www-fixture', createdAt: wwwTime,
    parameterContract: { schemaVersion: 1, contractId: contract.id, contractRevision: contract.revision, contractFingerprint: wwwVideoContractFingerprint(contract), rules: [] } });
}
export function wwwAdapterFixture(key = 'happyhorse-1.1-t2v', feature?: ProductFeature) {
  const route = wwwRoute(key, feature);
  let connection: ProviderConnection = wwwConnection();
  const calls: NewApiHttpTransportRequest[] = [];
  const usage: ProviderUsageObservationV1[] = [];
  let quoted: Record<string, unknown> = { currency: 'CNY_MICRO', input_digest: 'a'.repeat(64), price_version: 'price-fixture-1', quoted_amount: 1_000_000, closed_reasons: [] };
  let task: Record<string, unknown> = { id: 'remote-www-fixture', model: key, status: 'queued' };
  let submitError = false;
  let lookup: Record<string, unknown> = {};
  let approval = true;
  let downloadFailures = 0;
  let quoteFailure: { code: string; message: string } | undefined;
  const approvals: { quotedAmountCnyMicro: number; modelKey: string }[] = [];
  const runtime = new NewApiSharedRuntime({ transport: { async send(request): Promise<NewApiHttpTransportResponse> {
    calls.push(request);
    const url = new URL(request.url);
    const body = request.body && request.headers['content-type'] === 'application/json' ? JSON.parse(new TextDecoder().decode(request.body)) : {};
    let data: unknown;
    if (url.pathname === '/v1/assets') data = { data: { id: `uploaded-${calls.length}` } };
    else if (url.pathname === '/v1/requests') data = lookup;
    else if (url.pathname.endsWith('/quote') || body.operation === 'quote') {
      if (quoteFailure) return { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-quote-error' },
        body: new TextEncoder().encode(JSON.stringify({ error: quoteFailure })) };
      data = quoted;
    }
    else if (request.method === 'POST') { if (submitError) throw new Error('synthetic disconnect'); data = { id: task.id, model: key, status: 'queued' }; }
    else if (url.pathname.endsWith('/content')) {
      if (downloadFailures-- > 0) throw new Error('synthetic content GET disconnect');
      return { status: 200, headers: { 'content-type': 'video/mp4' }, body: new Uint8Array([1, 2, 3]) };
    }
    else data = task;
    return { status: 200, headers: { 'content-type': 'application/json', 'x-unicomp-request-id': 'request-www-fixture' }, body: new TextEncoder().encode(JSON.stringify(data)) };
  } } });
  const imageBytes = testPng(1280, 720);
  let image = { mimeType: 'image/png', width: 1280, height: 720, sizeBytes: imageBytes.length, bytes: imageBytes as Uint8Array };
  const imageResolutions: { maximumInputBytes?: number }[] = [];
  const adapter = new NewApiVideoAdapter(runtime, { get: async () => connection },
    { useCredential: async (_input, action) => action({ schemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, schemaVersion: 1, values: { api_key: 'synthetic-www-test-key' } }) },
    { get: async () => wwwVideoParameterSchema(wwwVideoContract(key)!, route.productFeature) },
    { resolve: async ({ assetId, maximumInputBytes }) => { imageResolutions.push({ maximumInputBytes }); return { assetId, ...image }; } },
    { append: async o => { usage.push(o); } }, { nextProviderUsageObservationId: () => toProviderUsageObservationId('usage-www-fixture') },
    undefined, { resolve: async ({ assetId }) => ({ assetId, mimeType: 'video/mp4', durationMs: 4000, sizeBytes: 3, bytes: new Uint8Array([1, 2, 3]) }) },
    { confirm: async input => { approvals.push(input); return approval; } });
  const request = { projectId: route.projectId, prompt: 'A synthetic orange cup on a white table.', invocationAttemptId: toProviderInvocationAttemptId('attempt-www-fixture'),
    parameterValues: key === 'MiniMax-H3' ? { resolution: '2K', ratio: '16:9', duration: 4, generate_audio: true, watermark: false } : {},
    ...(route.productFeature === 'image_to_video' || route.productFeature === 'video_edit' ? { assetId: 'asset-www-fixture' } : {}) };
  return { route, request, adapter, calls, usage, approvals, imageResolutions,
    setImage: (value: typeof image) => { image = value; }, setQuoteFailure: (value: typeof quoteFailure) => { quoteFailure = value; },
    setApproval: (value: boolean) => { approval = value; }, setConnection: (v: ProviderConnection) => { connection = v; },
    setDownloadFailures: (count: number) => { downloadFailures = count; },
    setQuote: (v: Record<string, unknown>) => { quoted = { ...quoted, ...v }; }, setTask: (v: Record<string, unknown>) => { task = { ...task, ...v }; },
    disconnect: (value: Record<string, unknown> = {}) => { submitError = true; lookup = value; },
    complete: (asset = 'result-www-fixture') => { task = { ...task, status: 'succeeded',
      billing: { currency: 'CNY_MICRO', charged_amount: 1_000_000, settlement_pending: false },
      ...(key === 'MiniMax-H3' ? { output_type: 'video', review_phase: undefined,
        data: { asset_id: asset, url: `/v1/videos/${task.id}/content?asset_id=${asset}`, mime_type: 'video/mp4' } } :
        { review_phase: 'output_approved', data: [{ asset_id: asset, url: `/v1/videos/${task.id}/content?asset_id=${asset}` }] }) }; } };
}
