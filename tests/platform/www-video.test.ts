import { describe, expect, it } from 'vitest';
import { validateParameterSchemaV2, validateParameterValues, createProviderModel, toModelId, toProtocolBindingId, createModelCapabilityEvidence, toCapabilityEvidenceId } from '../../src/domain';
import { listWwwVideoContracts, wwwVideoContract, wwwVideoContractFingerprint, wwwVideoParameterSchema, routeWwwVideoProfile } from '../../src/platform/providers/newapi/www-video-contracts';
import { type ProviderRegistrySnapshot } from '../../src/platform/providers/provider-registry';
import { wwwAdapterFixture, wwwConnection, wwwTime } from '../fixtures/www-video';
import previousCatalog from '../../src/platform/providers/newapi/www-video-catalog.previous.json';

describe('WWW exact gateway video contracts and lifecycle', () => {
  it('uses generate example types without inheriting regenerate or understand restrictions', () => {
    const schema = wwwVideoParameterSchema(wwwVideoContract('MiniMax-H3')!, 'text_to_video');
    expect(schema.revision).toBe(3);
    expect(schema.fields.map(f => f.fieldId)).toEqual(['resolution', 'ratio', 'duration', 'generate_audio', 'watermark']);
    expect(validateParameterValues(schema, 'full', {})).toEqual({});
    expect(validateParameterValues(schema, 'full', { resolution: '768P', generate_audio: false, duration: 3 }))
      .toMatchObject({ resolution: '768P', generate_audio: false, duration: 3 });
    // Accepted locally means eligible for authoritative quote validation, not
    // a claim that every integer duration is accepted by the gateway.
    expect(() => validateParameterValues(schema, 'full', { duration: 4.5 })).toThrow();
  });
  it('shows an exact quote before the paid POST and stops on cancellation', async () => {
    const x = wwwAdapterFixture('MiniMax-H3'); x.setApproval(false);
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.approvals).toMatchObject([{ quotedAmountCnyMicro: 1_000_000, modelKey: 'MiniMax-H3' }]);
    expect(x.calls).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(x.calls[0].body)).operation).toBe('quote');
  });
  it('requires no manual budget and submits the confirmed quote amount unchanged', async () => {
    const x = wwwAdapterFixture('MiniMax-H3'); x.setQuote({ quoted_amount: 7_040_000 });
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'accepted_async' });
    expect(x.approvals).toMatchObject([{ quotedAmountCnyMicro: 7_040_000 }]);
    const submitted = JSON.parse(new TextDecoder().decode(x.calls.at(-1)!.body));
    expect(submitted.expected_quote_amount).toBe(7_040_000);
    expect(submitted.parameters).toEqual({});
  });
  it.each(['maximum_cost_cny', 'made_up_field'])('rejects a non-model input at the adapter boundary: %s', async field => {
    const x = wwwAdapterFixture('MiniMax-H3');
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...x.request, parameterValues: { [field]: 999 } } }))
      .toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
  });
  it.each(previousCatalog.contracts)('retains the previous $modelKey contract for original tasks only', async previous => {
    const x = wwwAdapterFixture(previous.modelKey, previous.features[0] as 'text_to_video');
    const retained = wwwVideoContract(previous.modelKey, previous.revision)!;
    expect(retained).toEqual(previous);
    const route = { ...x.route, parameterSchemaRevision: previous.revision,
      parameterContract: { ...x.route.parameterContract!, contractRevision: previous.revision, contractFingerprint: wwwVideoContractFingerprint(retained) } };
    expect(await x.adapter.submit({ routeSnapshot: route, request: x.request })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
    await x.adapter.attachOperation({ routeSnapshot: route, providerOperationId: 'remote-www-fixture', invocationAttemptId: x.request.invocationAttemptId });
    x.complete();
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'completed' });
  });
  it('retains the accepted H3 v1 route only for original-task query and download', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    const retained = wwwVideoContract('MiniMax-H3', 1)!;
    const route = { ...x.route, parameterSchemaRevision: 1,
      parameterContract: { ...x.route.parameterContract!, contractRevision: 1, contractFingerprint: wwwVideoContractFingerprint(retained) } };
    expect(await x.adapter.submit({ routeSnapshot: route, request: x.request })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
    await x.adapter.attachOperation({ routeSnapshot: route, providerOperationId: 'remote-www-fixture', invocationAttemptId: x.request.invocationAttemptId });
    x.complete();
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'completed' });
    const queries = x.calls.length;
    // A stale later GET must not erase the already validated result descriptor.
    x.setTask({ status: 'unexpected' });
    await x.adapter.attachOperation({ routeSnapshot: route, providerOperationId: 'remote-www-fixture', invocationAttemptId: x.request.invocationAttemptId });
    const [result] = await x.adapter.listResults('remote-www-fixture');
    await x.adapter.openDownload('remote-www-fixture', result.remoteResultId);
    expect(x.calls).toHaveLength(queries + 1);
    expect(x.calls.at(-1)!.url).toContain('/content?asset_id=');
    expect(x.usage).toHaveLength(1);
  });
  it('binds idempotently and preserves disabled state and negative capability history', () => {
    const c = wwwConnection();
    const model = createProviderModel({ id: toModelId('model-www-binding'), providerId: c.providerId, connectionId: c.id,
      protocolBindingId: toProtocolBindingId('original-catalog'), providerModelKey: 'wan3.0-video-ali', displayName: 'Wan',
      mediaKind: 'unknown', enabled: false, catalogState: 'present', revision: 1, createdAt: wwwTime, updatedAt: wwwTime });
    const negative = createModelCapabilityEvidence({ id: toCapabilityEvidenceId('www-negative-evidence'), modelId: model.id, revision: 1,
      capability: 'video_generation', state: 'unsupported', source: 'system_observed', recordedAt: wwwTime });
    const snapshot: ProviderRegistrySnapshot = { schemaVersion: 2, providers: [], connections: [c], models: [model], protocolBindings: [],
      capabilities: [negative], routingPreferences: [] };
    const first = routeWwwVideoProfile(snapshot, model, wwwTime); expect(first.state).toBe('attached');
    expect(first.model.enabled).toBe(false); expect(first.snapshot.capabilities).toContainEqual(negative);
    expect(first.snapshot.capabilities.filter(e => e.capability === 'video_generation')).toEqual([negative]);
    const second = routeWwwVideoProfile(first.snapshot, first.model, wwwTime); expect(second.state).toBe('already_attached');
    expect(second.snapshot).toBe(first.snapshot);
    const profile = first.snapshot.modelProfiles![0];
    const disabled = { ...first.snapshot, modelProfiles: [{ ...profile, status: 'disabled' as const }] };
    expect(routeWwwVideoProfile(disabled, first.model, wwwTime).state).toBe('skipped');
    expect(routeWwwVideoProfile({ ...snapshot, connections: [{ ...c, endpoint: 'https://unicompapi.com/v1' }] }, model, wwwTime).state).toBe('skipped');
  });
  it('publishes nine independent gateway contracts, excludes unavailable Seedance 2.5, and validates every schema', () => {
    const all = listWwwVideoContracts();
    expect(all).toHaveLength(9);
    expect(all.every(c => c.authority === 'relay')).toBe(true);
    expect(all.some(c => c.modelKey.includes('2-5'))).toBe(false);
    for (const c of all) for (const feature of c.features) {
      const schema = validateParameterSchemaV2(wwwVideoParameterSchema(c, feature as 'text_to_video'));
      expect(schema.fields.some(field => field.fieldId === 'maximum_cost_cny')).toBe(false);
      for (const field of schema.fields.filter(field => field.fieldId !== 'generation_mode')) {
        expect(field.required).toBe(c.fields.find(documented => documented.name === field.fieldId)?.required === true);
      }
    }
    const i2v = all.find(c => c.modelKey === 'happyhorse-1.1-i2v')!;
    expect(i2v.fields.some(f => f.name === 'aspect_ratio')).toBe(false);
    const seedance = all.find(c => c.modelKey === 'doubao-seedance-2-0-260128')!;
    for (const feature of ['text_to_video', 'image_to_video'] as const) {
      expect(wwwVideoParameterSchema(seedance, feature).fields.map(f => f.fieldId)).not.toContain('return_last_frame');
      expect(wwwVideoParameterSchema(seedance, feature).fields.map(f => f.fieldId)).not.toContain('omni_reference_task_type');
    }
  });
  for (const c of listWwwVideoContracts()) for (const f of c.features) {
    it(`${c.modelKey} / ${f}: quote, exact submit, original query, original bearer download`, async () => {
      const x = wwwAdapterFixture(c.modelKey, f as 'text_to_video');
      const request = { ...x.request, parameterValues: {
        ...(f === 'image_to_video' && c.fields.some(p => p.name === 'generation_mode') ? { generation_mode: 'first_frame' } : {}) } };
      let hook = 0;
      const outcome = await x.adapter.submit({ routeSnapshot: x.route, request, beforeRequestStarted: async () => { hook++; } });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'accepted_async' });
      expect(hook).toBe(1);
      const posts = x.calls.filter(r => r.method === 'POST' && !r.url.endsWith('/assets'));
      const q = JSON.parse(new TextDecoder().decode(posts[0].body)); const s = JSON.parse(new TextDecoder().decode(posts[1].body));
      expect(s.expected_quote_amount).toBe(1_000_000);
      expect(s.parameters).toEqual(q.parameters);
      expect(s.parameters.maximum_cost_cny).toBeUndefined();
      expect(posts[1].headers['Idempotency-Key']).toMatch(/^www-video-/);
      if (f === 'image_to_video' && c.referenceBinding === 'explicit_roles') expect(s.referenceAssets[0].role).toBe('first_frame');
      if (c.referenceBinding === 'asset_ids') { expect(s.referenceAssets).toBeUndefined(); expect(s.expected_input_digest).toBeUndefined(); }
      if (f === 'video_edit') expect(s.referenceAssets[0].role).toBe('reference_video');
      if (f !== 'text_to_video') expect(x.calls.find(r => r.url.endsWith('/assets'))!.headers['X-Model-Id']).toBe(c.modelKey);
      x.complete();
      expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'completed' });
      const results = await x.adapter.listResults('remote-www-fixture');
      const stream = await x.adapter.openDownload('remote-www-fixture', results[0].remoteResultId);
      const chunks = []; for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
      expect(x.usage).toHaveLength(1);
      expect(x.usage[0].facts[0]).toMatchObject({ unit: 'CNY_MICRO', quantity: '1000000' });
      const query = x.calls.find(r => r.method === 'GET' && !r.url.includes('/content'))!;
      if (c.modelKey === 'MiniMax-H3') expect(query.url).toContain('?refresh=true');
    });
  }
  it.each([{ quoted_amount: 0 }, { quoted_amount: -1 }, { quoted_amount: 1.5 }, { quoted_amount: Number.MAX_SAFE_INTEGER + 1 }, { quoted_amount: '1' }, { input_digest: 'wrong' }, { currency: 'USD' }, { closed_reasons: ['closed'] }])('rejects invalid quotes without generation: %j', async patch => {
    const x = wwwAdapterFixture('wan3.0-video-ali'); x.setQuote(patch);
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls.filter(c => c.url.endsWith('/videos'))).toHaveLength(0);
  });
  it('rejects stale credentials, wrong host and changed contract before any request', async () => {
    for (const patch of [{ credentialVersionId: 'changed' }, { endpoint: 'https://unicompapi.com/v1' }, { state: 'disabled' as const }]) {
      const x = wwwAdapterFixture(); x.setConnection({ ...wwwConnection(), ...patch });
      expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'failed_before_submission' });
      expect(x.calls).toHaveLength(0);
    }
    const x = wwwAdapterFixture();
    expect(await x.adapter.submit({ routeSnapshot: { ...x.route, parameterContract: { ...x.route.parameterContract, contractFingerprint: 'b'.repeat(64) } }, request: x.request })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
  });
  it('uses the HappyHorse 1.1 documented price binding when its quote has no input digest', async () => {
    const x = wwwAdapterFixture(); x.setQuote({ input_digest: undefined });
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'accepted_async' });
    const body = JSON.parse(new TextDecoder().decode(x.calls.find(c => c.url.endsWith('/videos'))!.body));
    expect(body.expected_input_digest).toBeUndefined();
    expect(body.expected_quote_amount).toBe(1_000_000); expect(body.expected_price_version).toBe('price-fixture-1');
  });
  it.each([['first_last_frame', ['asset-first', 'asset-last'], ['first_frame', 'last_frame']],
    ['reference_images', ['asset-first', 'asset-last', 'asset-third'], ['reference_image', 'reference_image', 'reference_image']],
    ['last_frame', ['asset-last'], ['last_frame']]] as const)('preserves ordered roles and counts for %s', async (generation_mode, assetIds, roles) => {
    const x = wwwAdapterFixture('wan3.0-video', 'image_to_video');
    const { assetId: ignored, ...request } = x.request; void ignored;
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...request, assetIds, parameterValues: { generation_mode } } })).toMatchObject({ kind: 'accepted_async' });
    const body = JSON.parse(new TextDecoder().decode(x.calls.find(c => c.url.endsWith('/videos'))!.body));
    expect(body.referenceAssets.map((r: {role: string}) => r.role)).toEqual(roles);
  });
  it.each([['first_frame', ['asset-first', 'asset-last']], ['first_last_frame', ['asset-first']], ['reference_images', Array.from({length: 11}, (_, i) => `asset-${i}`)]])('rejects incorrect mode counts before outbound requests: %s', async (generation_mode, assetIds) => {
    const x = wwwAdapterFixture('wan3.0-video', 'image_to_video');
    const { assetId: ignored, ...request } = x.request; void ignored;
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...request, assetIds, parameterValues: { generation_mode } } })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
  });
  it('honors cancellation before charge submission', async () => {
    const x = wwwAdapterFixture(); const controller = new AbortController(); controller.abort();
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request, signal: controller.signal })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
  });
  it('rejects an auxiliary image output switch before upload, quote or paid submit', async () => {
    const x = wwwAdapterFixture('doubao-seedance-2-0-260128');
    expect(await x.adapter.submit({ routeSnapshot: x.route,
      request: { ...x.request, parameterValues: { return_last_frame: true } } })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
  });
  it('recovers the original task by deterministic request key after one ambiguous submit; never reposts', async () => {
    const x = wwwAdapterFixture(); x.disconnect({ task_id: 'original-task' });
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'accepted_async', providerOperationId: 'original-task' });
    expect(x.calls.filter(r => r.url.endsWith('/videos'))).toHaveLength(1);
    expect(x.calls.at(-1)!.url).toContain('/v1/requests?idempotency_key=www-video-');
  });
  it('preserves unknown outcome without a second submit when lookup has no task', async () => {
    const x = wwwAdapterFixture(); x.disconnect();
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: x.request })).toMatchObject({ kind: 'submission_outcome_unknown' });
    expect(x.calls.filter(r => r.url.endsWith('/videos'))).toHaveLength(1);
  });
  it('blocks delivery during review or pending settlement and never settles automatically', async () => {
    const x = wwwAdapterFixture(); await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ billing: { settlement_pending: true }, status: 'reviewing' });
    expect(await x.adapter.getCompletion('remote-www-fixture')).toBeUndefined();
    expect(x.usage).toHaveLength(0);
    x.setTask({ status: 'succeeded' });
    expect(await x.adapter.getCompletion('remote-www-fixture')).toBeUndefined();
    expect(x.calls.some(r => r.url.endsWith('/settle'))).toBe(false);
  });
  it('accepts a canonical same-origin absolute private result and downloads through the controlled route', async () => {
    const x = wwwAdapterFixture(); await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ data: [{ asset_id: 'result', url: 'https://www.unicompapi.com/v1/videos/remote-www-fixture/content?asset_id=result' }] });
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'completed' });
    await x.adapter.openDownload('remote-www-fixture', 'result');
    expect(x.calls.at(-1)!.url).toBe('https://www.unicompapi.com/v1/videos/remote-www-fixture/content?asset_id=result');
  });
  it('receives the real H3 single-object result without a media review_phase through the videos content endpoint', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request });
    x.complete();
    x.setTask({ object: 'h3.task', action: 'generate', output_type: 'video', review_phase: undefined,
      data: { asset_id: 'h3-result', url: '/v1/videos/remote-www-fixture/content?asset_id=h3-result', mime_type: 'video/mp4' } });
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'completed' });
    expect(await x.adapter.listResults('remote-www-fixture')).toEqual([
      { remoteResultId: 'h3-result', name: 'www-video', declaredMimeType: 'video/mp4', declaredContainer: 'mp4' }
    ]);
    const stream = await x.adapter.openDownload('remote-www-fixture', 'h3-result');
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(x.calls.at(-1)!.url).toBe('https://www.unicompapi.com/v1/videos/remote-www-fixture/content?asset_id=h3-result');
    expect(x.usage).toHaveLength(1);
    expect(x.calls.filter(c => c.method === 'POST')).toHaveLength(2);
  });
  it.each([
    { output_type: 'text' },
    { review_phase: 'output_rejected' },
    { data: { asset_id: 'h3-result', url: '/v1/videos/other-task/content?asset_id=h3-result', mime_type: 'video/mp4' } },
    { data: { asset_id: 'h3-result', url: '/v1/videos/remote-www-fixture/content?asset_id=h3-result', mime_type: 'text/plain' } }
  ])('rejects H3 non-video, explicit review denial and invalid private results: %j', async patch => {
    const x = wwwAdapterFixture('MiniMax-H3');
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ output_type: 'video', review_phase: undefined,
      data: { asset_id: 'h3-result', url: '/v1/videos/remote-www-fixture/content?asset_id=h3-result', mime_type: 'video/mp4' }, ...patch });
    await expect(x.adapter.query('remote-www-fixture')).rejects.toThrow();
    expect(x.calls.some(c => c.url.includes('/content'))).toBe(false);
  });
  it('still requires media-protocol output approval and array results for non-H3 models', async () => {
    const x = wwwAdapterFixture();
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ output_type: 'video', review_phase: undefined });
    await expect(x.adapter.query('remote-www-fixture')).rejects.toThrow();
    x.setTask({ review_phase: 'output_approved', data: { asset_id: 'result', url: '/v1/videos/remote-www-fixture/content?asset_id=result' } });
    await expect(x.adapter.query('remote-www-fixture')).rejects.toThrow();
  });
  it('waits for output review without discarding a successful remote task', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ review_phase: 'output_pending' });
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'processing' });
    expect(x.calls.some(c => c.url.includes('/content'))).toBe(false);
    x.setTask({ review_phase: 'output_approved' });
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'completed' });
  });
  it('retries a transient private download without polling again or resubmitting', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    await x.adapter.query('remote-www-fixture'); x.setDownloadFailures(1);
    const stream = await x.adapter.openDownload('remote-www-fixture', 'result-www-fixture');
    for await (const chunk of stream) expect(Buffer.from(chunk)).toEqual(Buffer.from([1, 2, 3]));
    expect(x.calls.filter(c => c.url.includes('/content'))).toHaveLength(2);
    expect(x.calls.filter(c => c.method === 'GET' && !c.url.includes('/content'))).toHaveLength(1);
    expect(x.calls.filter(c => c.method === 'POST')).toHaveLength(2);
  });
  it('bounds failed downloads and exposes a recoverable original result', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    await x.adapter.query('remote-www-fixture'); x.setDownloadFailures(3);
    await expect(x.adapter.openDownload('remote-www-fixture', 'result-www-fixture')).rejects.toMatchObject({ retryability: 'retryable' });
    expect(x.calls.filter(c => c.url.includes('/content'))).toHaveLength(3);
    expect(x.calls.filter(c => c.method === 'POST')).toHaveLength(2);
  });
  it('keeps an H3 original pending when settlement is required and never settles or resubmits', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ output_type: 'video', review_phase: undefined, billing: { settlement_pending: true },
      data: { asset_id: 'h3-result', url: '/v1/videos/remote-www-fixture/content?asset_id=h3-result', mime_type: 'video/mp4' } });
    expect(await x.adapter.query('remote-www-fixture')).toEqual({ state: 'processing' });
    expect(x.calls.filter(c => c.method === 'POST')).toHaveLength(2);
    expect(x.usage).toHaveLength(0);
  });
  it.each([
    [{ asset_id: 'result', url: 'https://evil.test/private' }],
    [{ asset_id: 'result', url: '/v1/videos/other/content?asset_id=result' }],
    [{ asset_id: 'result', url: '/v1/videos/remote-www-fixture/content?asset_id=result' }, { asset_id: 'second' }]
  ])('rejects injected URLs, foreign task and multiple outputs', async (...data) => {
    const x = wwwAdapterFixture(); await x.adapter.submit({ routeSnapshot: x.route, request: x.request }); x.complete();
    x.setTask({ data }); await expect(x.adapter.query('remote-www-fixture')).rejects.toThrow();
    expect(x.calls.some(r => r.url.includes('/content'))).toBe(false);
  });
});
