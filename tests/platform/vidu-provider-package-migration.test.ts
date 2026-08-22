import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderExecutionRouteSnapshot,
  toIsoTimestamp,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  type ParameterValue,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderUsageObservationV1
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  ProviderPackageRegistry,
  SecureCredentialVault,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_IMAGE_V1_ADAPTER_VERSION,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_OFFICIAL_TEMPLATE_ID,
  VIDU_PROVIDER_PACKAGE_VERSION,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_TEXT_VIDEO_V2_ADAPTER_ID,
  ViduPackagedParameterSchemaResolver,
  ViduProviderPackage,
  ViduRegistryExecutionRouteResolver,
  createViduModelContract,
  viduPackagedParameterSchemas,
  viduProviderPackageDescriptor,
  type ControlledImageMaterialPort,
  type CredentialProtector
} from '../../src/platform';
import { createUserViduRegistryRecords } from '../fixtures/vidu-user-registry';
import {
  SyntheticViduService,
  isoBmffVideo,
  pngBytes
} from '../fixtures/vidu-synthetic-service';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-08-03T10:00:00.000Z');
const projectId = toProjectId('project-vidu-route-migration');
const syntheticCredentialValue = 'route-fixture-credential-value';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Vidu Provider Package migration', () => {
  it('publishes one official package and exact frozen model contracts', () => {
    const registry = new ProviderPackageRegistry([
      viduProviderPackageDescriptor
    ]);
    const template = registry.resolveTemplate(
      VIDU_PROVIDER_PACKAGE_ID,
      'vidu-official'
    );

    expect(template.package.packageVersion).toBe(VIDU_PROVIDER_PACKAGE_VERSION);
    expect(template.template).toMatchObject({
      kind: 'official',
      baseUrlMode: 'fixed',
      freeConnectionValidation: true,
      modelDiscoveryKind: 'manual_exact'
    });
    expect(template.adapters.map((adapter) => adapter.adapterId)).toEqual([
      VIDU_IMAGE_V1_ADAPTER_ID,
      VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
      VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      VIDU_TEXT_VIDEO_V2_ADAPTER_ID
    ]);
    expect(registry.resolveEndpoint(template, undefined, false)).toBe(
      'https://api.vidu.cn/'
    );

    const imageV1 = createViduModelContract('viduimage-2');
    expect(imageV1.defaultProfileStatus).toBe('verified');
    expect(
      imageV1.definition.profileTemplates[0].features.map(
        (feature) => feature.productFeature
      )
    ).toEqual(['text_to_image', 'image_edit']);
    expect(
      createViduModelContract('viduq2').definition.profileTemplates[0].features.map(
        (feature) => feature.productFeature
      )
    ).toEqual(['text_to_image', 'reference_to_image', 'image_edit']);
    expect(
      createViduModelContract('viduq1').definition.profileTemplates[0].features.map(
        (feature) => feature.productFeature
      )
    ).toEqual(['reference_to_image']);
    expect(createViduModelContract('q3-lite')).toMatchObject({
      defaultProfileStatus: 'restricted'
    });
    expect(createViduModelContract('viduq3-turbo')).toMatchObject({
      defaultProfileStatus: 'restricted'
    });
    expect(
      createViduModelContract('viduq3-turbo').definition.profileTemplates[0].features.map(
        (feature) => feature.productFeature
      )
    ).toEqual(['image_to_video', 'text_to_video']);
    expect(
      createViduModelContract('viduq3-pro').definition.profileTemplates[0].features.map(
        (feature) => feature.productFeature
      )
    ).toEqual(['text_to_video']);
    expect(() => createViduModelContract('viduq3-guessed')).toThrow(
      'exact frozen model key'
    );
  });

  it('keeps migrated user Vidu rows as ordinary records without re-seeding', async () => {
    const root = await makeRoot('vidu-registry-migration-');
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const frozen = createUserViduRegistryRecords();
    const provider = {
      ...frozen.providers[0],
      name: 'Existing Vidu',
      identityState: 'verified' as const,
      updatedAt: timestamp
    };
    const connection = {
      ...frozen.connections[0],
      providerId: provider.id,
      name: 'Existing Vidu connection',
      state: 'available' as const,
      identityState: 'verified' as const,
      credentialState: 'valid' as const,
      credentialReference: 'existing-vidu-credential-reference',
      updatedAt: timestamp
    };
    await store.save({
      schemaVersion: 2,
      providers: [provider],
      connections: [connection],
      protocolBindings: frozen.protocolBindings.slice(0, 1),
      models: frozen.models.slice(0, 2),
      capabilities: frozen.capabilities.slice(0, 2),
      routingPreferences: []
    });
    const revision = (await store.load()).registryRevision;

    const reloaded = await new JsonProviderRegistryStore(
      path.join(root, 'registry.json')
    ).load();

    expect(reloaded.registryRevision).toBe(revision);
    expect(reloaded.providers[0]).toMatchObject({
      name: 'Existing Vidu',
      identityState: 'verified'
    });
    expect(reloaded.connections[0]).toMatchObject({
      state: 'available',
      credentialState: 'valid',
      credentialReference: 'existing-vidu-credential-reference',
      templateId: VIDU_OFFICIAL_TEMPLATE_ID
    });
    expect(reloaded.protocolBindings).toHaveLength(1);
    expect(reloaded.models).toHaveLength(2);
    expect(reloaded.capabilities).toHaveLength(2);
  });

  it('aligns Vidu video parameter schemas with official options and revisions', () => {
    const turbo = createViduModelContract('viduq3-turbo');
    const textSchema = turbo.parameterSchemas.find(
      (schema) => schema.productFeature === 'text_to_video'
    )!;
    const referenceSchema = turbo.parameterSchemas.find(
      (schema) => schema.productFeature === 'image_to_video'
    )!;

    expect(textSchema).toMatchObject({ revision: 2 });
    expect(textSchema.fields.map((field) => field.fieldId)).toEqual([
      'audio',
      'duration',
      'resolution',
      'aspect_ratio',
      'seed'
    ]);
    expect(textSchema.fields.find((field) => field.fieldId === 'duration'))
      .toMatchObject({ minimum: 1, maximum: 16 });
    expect(textSchema.fields.find((field) => field.fieldId === 'resolution'))
      .toMatchObject({ valueType: 'enum', options: ['540p', '720p', '1080p'] });
    expect(textSchema.fields.find((field) => field.fieldId === 'aspect_ratio'))
      .toMatchObject({
        valueType: 'enum',
        options: ['16:9', '9:16', '3:4', '4:3', '1:1']
      });

    expect(referenceSchema).toMatchObject({ revision: 2 });
    expect(referenceSchema.fields.find((field) => field.fieldId === 'duration'))
      .toMatchObject({ minimum: 3, maximum: 16 });
    expect(referenceSchema.fields.find((field) => field.fieldId === 'resolution'))
      .toMatchObject({ valueType: 'enum', options: ['540p', '720p', '1080p'] });

    const drama = createViduModelContract('viduq3-drama').parameterSchemas[0];
    expect(drama.fields.find((field) => field.fieldId === 'duration'))
      .toMatchObject({ minimum: 2, maximum: 15 });
    expect(drama.fields.find((field) => field.fieldId === 'resolution'))
      .toMatchObject({ valueType: 'enum', options: ['1080p'] });
  });
});

describe('Vidu RouteSnapshot adapters', () => {
  it('submits Image V1 with Bearer and receives Gemini image results', async () => {
    const fixture = await routeFixture();
    const imageV1Route = routeFor(fixture.snapshot, 'viduimage-2', 'text_to_image');
    const geminiRoute = routeFor(
      fixture.snapshot,
      'q3-lite',
      'reference_to_image'
    );

    const imageV1Outcome = await fixture.adapters.imageV1.submit(imageV1Route, {
      request: dispatchRequest(imageV1Route, false)
    });
    expect(imageV1Outcome).toMatchObject({
      kind: 'completed_sync',
      results: [{ kind: 'remote_url' }]
    });
    expect(fixture.service.count('POST', '/ent/v1/images/generations')).toBe(1);
    expect(
      fixture.service.requests.find((request) =>
        request.url.includes('/ent/v1/images/generations')
      )?.authorized
    ).toBe(true);

    await expect(fixture.adapters.geminiImageV2.submit(
      { ...geminiRoute, connectionRevision: geminiRoute.connectionRevision + 1 },
      { request: dispatchRequest(geminiRoute, true) }
    )).resolves.toMatchObject({ kind: 'failed_before_submission' });

    let requestStarted = 0;
    const outcome = await fixture.adapters.geminiImageV2.submit(geminiRoute, {
      request: dispatchRequest(geminiRoute, true),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });
    expect(outcome).toMatchObject({
      kind: 'completed_sync',
      results: [{ kind: 'file_uri' }]
    });
    expect(requestStarted).toBe(1);
    if (outcome.kind !== 'completed_sync') throw new Error('image outcome');
    const bytes = await readAll(await fixture.adapters.geminiImageV2.receiveResult(
      geminiRoute,
      {
        providerOperationId: outcome.providerOperationId,
        result: outcome.results[0]
      }
    ));
    expect(bytes).toEqual(pngBytes(8, 8));
    const restarted = fixture.providerPackage.createRouteAdapters({
      routes: new ViduRegistryExecutionRouteResolver(fixture.registry),
      parameterSchemas: new ViduPackagedParameterSchemaResolver(),
      materials: fixture.materials,
      usage: { append: async (observation) => { fixture.usage.push(observation); } }
    }).geminiImageV2;
    const resultReference = {
      providerOperationId: outcome.providerOperationId,
      result: outcome.results[0]
    };
    await expect(restarted.receiveResult(geminiRoute, resultReference))
      .rejects.toMatchObject({ code: 'vidu.result_route_unavailable' });
    await restarted.attachResult({
      routeSnapshot: geminiRoute,
      ...resultReference
    });
    await expect(readAll(await restarted.receiveResult(
      geminiRoute,
      resultReference
    ))).resolves.toEqual(pngBytes(8, 8));
    expect(fixture.usage).toHaveLength(2);
    expect(fixture.usage.every((item) => item.status === 'not_reported')).toBe(true);
    expect(JSON.stringify(fixture.usage)).not.toContain(syntheticCredentialValue);
  });

  it('submits viduq2 text-to-image without assets and reference-to-image with one asset', async () => {
    const fixture = await routeFixture(['viduq2']);
    const textRoute = routeFor(fixture.snapshot, 'viduq2', 'text_to_image');
    const referenceRoute = routeFor(
      fixture.snapshot,
      'viduq2',
      'reference_to_image'
    );

    await expect(fixture.adapters.referenceImageV2.submit(textRoute, {
      request: dispatchRequest(textRoute, true)
    })).resolves.toMatchObject({ kind: 'failed_before_submission' });

    const textOutcome = await fixture.adapters.referenceImageV2.submit(textRoute, {
      request: dispatchRequest(textRoute, false)
    });
    expect(textOutcome).toMatchObject({
      kind: 'completed_sync',
      results: [{ kind: 'remote_url' }]
    });
    expect(
      fixture.service.requests.some((request) =>
        request.url.includes('/ent/v2/reference2image') &&
        !request.url.includes('/image/reference2image/')
      )
    ).toBe(true);
    expect(
      fixture.service.count('GET', '/ent/v2/tasks/synthetic-image-task/creations')
    ).toBeGreaterThanOrEqual(1);

    await expect(fixture.adapters.referenceImageV2.submit(referenceRoute, {
      request: dispatchRequest(referenceRoute, false)
    })).resolves.toMatchObject({ kind: 'failed_before_submission' });

    const referenceOutcome = await fixture.adapters.referenceImageV2.submit(
      referenceRoute,
      { request: dispatchRequest(referenceRoute, true) }
    );
    expect(referenceOutcome).toMatchObject({
      kind: 'completed_sync',
      results: [{ kind: 'remote_url' }]
    });
  });

  it('uses the captured route for video query, cancel, restart attach and result receipt', async () => {
    const fixture = await routeFixture();
    const route = routeFor(
      fixture.snapshot,
      'viduq3-turbo',
      'image_to_video'
    );
    let requestStarted = 0;
    const submitted = await fixture.adapters.referenceVideoV2.submit(route, {
      request: dispatchRequest(route, true, { audio: false, duration: 3 }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });
    expect(submitted).toEqual({
      kind: 'accepted_async',
      providerOperationId: 'synthetic-video-task',
      state: 'queued'
    });
    expect(requestStarted).toBe(1);

    await expect(fixture.adapters.referenceVideoV2.query(
      route,
      'synthetic-video-task'
    )).resolves.toEqual({ state: 'completed' });
    await expect(fixture.adapters.referenceVideoV2.cancel(
      route,
      'synthetic-video-task'
    )).resolves.toEqual({ state: 'cancelled' });
    expect(fixture.usage.filter((item) => item.status === 'not_reported'))
      .toHaveLength(1);

    const restarted = fixture.providerPackage.createRouteAdapters({
      routes: new ViduRegistryExecutionRouteResolver(fixture.registry),
      parameterSchemas: new ViduPackagedParameterSchemaResolver(),
      materials: fixture.materials,
      usage: { append: async (observation) => { fixture.usage.push(observation); } }
    }).referenceVideoV2;
    await expect(restarted.receiveResult(route, {
      providerOperationId: 'synthetic-video-task',
      remoteResultId: 'synthetic-video-result'
    })).rejects.toMatchObject({ code: 'vidu.operation_route_unavailable' });

    await restarted.attachOperation({
      routeSnapshot: route,
      providerOperationId: 'synthetic-video-task',
      invocationAttemptId: toProviderInvocationAttemptId(
        'attempt-viduimage-route'
      ),
      usageAlreadyPersisted: true
    });
    const bytes = await readAll(await restarted.receiveResult(route, {
      providerOperationId: 'synthetic-video-task',
      remoteResultId: 'synthetic-video-result'
    }));
    expect(bytes).toEqual(isoBmffVideo());
    expect(fixture.service.count(
      'GET',
      '/ent/v2/tasks/synthetic-video-task/creations'
    )).toBeGreaterThanOrEqual(2);
    expect(fixture.service.requests.every(
      (request) => request.dnsRebindingProtection === 'required'
    )).toBe(true);
    expect(JSON.stringify({ usage: fixture.usage, requests: fixture.service.requests }))
      .not.toContain(syntheticCredentialValue);
  });
});

async function routeFixture(
  enabledModelKeys: readonly string[] = [
    'viduimage-2',
    'q3-lite',
    'viduq3-turbo'
  ]
) {
  const root = await makeRoot('vidu-route-migration-');
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const records = createUserViduRegistryRecords();
  await registry.save({
    schemaVersion: 2,
    providers: records.providers,
    connections: records.connections,
    protocolBindings: records.protocolBindings,
    models: records.models.map((model) => ({
      ...model,
      activeProfileId: records.modelProfiles.find(
        (profile) => profile.modelId === model.id
      )?.profileId
    })),
    capabilities: records.capabilities,
    routingPreferences: [],
    modelDefinitions: records.modelDefinitions,
    modelProfiles: records.modelProfiles
  });
  const initial = await registry.load();
  const credentialReference = 'credential-vidu-route-synthetic';
  await registry.save({
    ...initial,
    connections: initial.connections.map((connection) => ({
      ...connection,
      state: 'available' as const,
      identityState: 'verified' as const,
      credentialState: 'valid' as const,
      credentialReference,
      updatedAt: timestamp
    })),
    models: initial.models.map((model) => ({
      ...model,
      enabled: enabledModelKeys.includes(model.providerModelKey),
      updatedAt: timestamp
    })),
    modelProfiles: initial.modelProfiles!.map((profile) => {
      const model = initial.models.find((candidate) => candidate.id === profile.modelId);
      return model && enabledModelKeys.includes(model.providerModelKey)
        ? { ...profile, status: 'verified' as const, recordedAt: timestamp }
        : profile;
    })
  });
  const snapshot = await registry.load();
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    protector()
  );
  await vault.save(credentialReference, syntheticCredentialValue);
  const service = new SyntheticViduService(syntheticCredentialValue);
  const imageUrl =
    'https://results.synthetic.invalid/reference.png?signature=private';
  const videoUrl =
    'https://results.synthetic.invalid/generated.mp4?signature=private';
  service.registerDownload(imageUrl, pngBytes(8, 8), 'image/png');
  service.registerDownload(videoUrl, isoBmffVideo(), 'video/mp4');
  const providerPackage = new ViduProviderPackage({
    credentialVault: vault,
    transport: service
  });
  const materials: ControlledImageMaterialPort = {
    resolve: async (input) => ({
      assetId: input.assetId,
      mimeType: 'image/png',
      width: 8,
      height: 8,
      sizeBytes: pngBytes(8, 8).byteLength,
      base64: pngBytes(8, 8).toString('base64')
    })
  };
  const usage: ProviderUsageObservationV1[] = [];
  const adapters = providerPackage.createRouteAdapters({
    routes: new ViduRegistryExecutionRouteResolver(registry),
    parameterSchemas: new ViduPackagedParameterSchemaResolver(),
    materials,
    usage: { append: async (observation) => { usage.push(observation); } },
    ids: {
      nextProviderOperationId: sequentialId('vidu-route-image'),
      nextProviderUsageObservationId: () =>
        `vidu-route-usage-${usage.length + 1}` as ProviderUsageObservationV1['id']
    },
    now: () => timestamp
  });
  return {
    root,
    registry,
    snapshot,
    service,
    providerPackage,
    materials,
    usage,
    adapters
  };
}

function routeFor(
  snapshot: Awaited<ReturnType<JsonProviderRegistryStore['load']>>,
  modelKey: string,
  productFeature: ProviderExecutionRouteSnapshotV1['productFeature']
): ProviderExecutionRouteSnapshotV1 {
  const provider = snapshot.providers[0];
  const connection = snapshot.connections[0];
  const model = snapshot.models.find(
    (candidate) => candidate.providerModelKey === modelKey
  );
  const profile = snapshot.modelProfiles?.find(
    (candidate) => candidate.profileId === model?.activeProfileId
  );
  const binding = snapshot.protocolBindings.find(
    (candidate) => candidate.id === model?.protocolBindingId
  );
  const feature = profile?.features.find(
    (candidate) => candidate.productFeature === productFeature
  );
  const parameterSchema = feature
    ? viduPackagedParameterSchemas.find(
        (candidate) => candidate.schemaId === feature.parameterSchemaId
      )
    : undefined;
  if (
    !provider ||
    !connection ||
    !model ||
    !profile ||
    !binding ||
    !feature ||
    !parameterSchema
  ) {
    throw new Error('Vidu route fixture is incomplete');
  }
  const adapterVersion = binding.adapterKind === VIDU_IMAGE_V1_ADAPTER_ID
    ? VIDU_IMAGE_V1_ADAPTER_VERSION
    : binding.adapterKind === VIDU_GEMINI_IMAGE_V2_ADAPTER_ID
      ? VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION
      : binding.adapterKind === VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID
        ? VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION
        : VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION;
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(
      `route-vidu-${modelKey}-${productFeature}`
    ),
    projectId,
    packageId: provider.packageId!,
    packageVersion: provider.packageVersion!,
    adapterKey: binding.adapterKind,
    adapterVersion,
    providerId: provider.id,
    providerDisplayName: provider.name,
    connectionId: connection.id,
    connectionDisplayName: connection.name,
    connectionRevision: connection.connectionRevision!,
    connectionConfigVersionId: connection.connectionConfigVersionId!,
    endpointPolicyId: connection.endpointPolicyId!,
    endpointPolicyRevision: connection.endpointPolicyRevision!,
    credentialVersionId: connection.credentialVersionId!,
    modelId: model.id,
    providerModelKey: model.providerModelKey,
    modelDisplayName: model.displayName,
    modelRevision: model.revision,
    profileId: profile.profileId,
    profileRevision: profile.revision,
    protocolBindingId: binding.id,
    protocolBindingRevision: 1,
    productFeature,
    internalPurpose: feature.internalPurpose,
    featureMappingVersion: 1,
    parameterSchemaId: feature.parameterSchemaId,
    parameterSchemaRevision: parameterSchema.revision,
    resultSchemaId: feature.resultSchemaId,
    resultSchemaRevision: 1,
    usageSchemaId: feature.usageSchemaId as ProviderExecutionRouteSnapshotV1['usageSchemaId'],
    usageSchemaRevision: 1,
    constraintSetId: feature.constraintSetId,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime-policy.vidu-closed',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'runtime-claim-vidu-synthetic',
    createdAt: timestamp
  });
}

function dispatchRequest(
  route: ProviderExecutionRouteSnapshotV1,
  withAsset: boolean,
  parameterValues: Readonly<Record<string, ParameterValue>> = {}
) {
  return {
    invocationAttemptId: toProviderInvocationAttemptId(
      'attempt-viduimage-route'
    ),
    projectId: route.projectId,
    prompt: 'Create a synthetic Vidu result',
    ...(withAsset ? { assetId: 'asset-vidu-route-input' } : {}),
    parameterValues
  };
}

function protector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) =>
      Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0x5a)),
    unprotect: (value) =>
      Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8')
  };
}

function sequentialId(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
