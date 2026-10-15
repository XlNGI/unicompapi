import { describe, expect, it } from 'vitest';
import { validateParameterSchemaV2, createProviderModel, toModelId, toProtocolBindingId, createModelCapabilityEvidence, toCapabilityEvidenceId } from '../../src/domain';
import { listWwwVideoContracts, wwwVideoParameterSchema, routeWwwVideoProfile } from '../../src/platform/providers/newapi/www-video-contracts';
import { type ProviderRegistrySnapshot } from '../../src/platform/providers/provider-registry';
import { wwwAdapterFixture, wwwConnection, wwwTime } from '../fixtures/www-video';

describe('WWW exact gateway video contracts and lifecycle', () => {
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
    for (const c of all) for (const feature of c.features) expect(validateParameterSchemaV2(wwwVideoParameterSchema(c, feature as 'text_to_video'))).toBeDefined();
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
      const request = { ...x.request, parameterValues: { maximum_cost_cny: 5,
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
  it.each([{ quoted_amount: 5_000_001 }, { quoted_amount: '1' }, { input_digest: 'wrong' }, { currency: 'USD' }, { closed_reasons: ['closed'] }])('rejects invalid/over-budget quotes without generation: %j', async patch => {
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
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...request, assetIds, parameterValues: { maximum_cost_cny: 5, generation_mode } } })).toMatchObject({ kind: 'accepted_async' });
    const body = JSON.parse(new TextDecoder().decode(x.calls.find(c => c.url.endsWith('/videos'))!.body));
    expect(body.referenceAssets.map((r: {role: string}) => r.role)).toEqual(roles);
  });
  it.each([['first_frame', ['asset-first', 'asset-last']], ['first_last_frame', ['asset-first']], ['reference_images', Array.from({length: 11}, (_, i) => `asset-${i}`)]])('rejects incorrect mode counts before outbound requests: %s', async (generation_mode, assetIds) => {
    const x = wwwAdapterFixture('wan3.0-video', 'image_to_video');
    const { assetId: ignored, ...request } = x.request; void ignored;
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...request, assetIds, parameterValues: { maximum_cost_cny: 5, generation_mode } } })).toMatchObject({ kind: 'failed_before_submission' });
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
      request: { ...x.request, parameterValues: { maximum_cost_cny: 5, return_last_frame: true } } })).toMatchObject({ kind: 'failed_before_submission' });
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
