import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createUsageSchema,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  toUsageSchemaId,
  type FeatureCandidateSubjectV1,
  type ParameterSchemaV2,
  type ProviderPackageDescriptor
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  JsonRuntimeAuthorizationLedgerStore,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderPackageRegistry,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  RuntimeAuthorizationLedger,
  type FeatureSubjectResolverPort,
  type ResolvedFeatureSubjectV1
} from '../../src/platform';

const roots: string[] = [];
const now = toIsoTimestamp('2026-08-03T16:00:00.000Z');
const subject: FeatureCandidateSubjectV1 = {
  kind: 'draft',
  draftId: toDraftId('draft-registry-candidates'),
  draftRevision: 3
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('registry-backed feature candidates', () => {
  it('combines exact profiles, package bindings and runtime policy without exposing route facts', async () => {
    const fixture = await candidateFixture();
    const values = await fixture.service.listFeatureCandidates(subject);

    expect(values).toHaveLength(2);
    expect(values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerName: 'Official Fixture',
        connectionName: 'Official connection',
        modelName: 'Official image model',
        available: true,
        unavailableReasons: [],
        parameterSchema: expect.objectContaining({
          fields: [expect.objectContaining({ fieldId: 'quality' })]
        })
      }),
      expect.objectContaining({
        providerName: 'Compatible Fixture',
        available: false,
        unavailableReasons: ['runtime_not_allowed']
      })
    ]));
    expect(JSON.stringify(values)).not.toMatch(
      /adapter|endpoint|credential|providerModelKey|profileId|protocolBinding|runtimePolicy/i
    );

    const available = values.find((candidate) => candidate.available);
    if (!available) throw new Error('available candidate missing');
    const prepared = await fixture.service.prepareSubmission({
      subject,
      candidateId: available.candidateId
    });
    expect(prepared.routeSelectionToken).toMatch(/^rst1_/);
    const inspected = fixture.service.inspectPreparedSubmission(
      prepared.routeSelectionToken
    );
    expect(inspected.confirmation).toMatchObject({
      materialCount: 0,
      contextCount: 0,
      parameterFieldCount: 1
    });

    await fixture.registry.mutate((snapshot) => ({
      snapshot: {
        ...snapshot,
        connections: snapshot.connections.map((connection) =>
          connection.id === 'connection-candidate-official'
            ? {
                ...connection,
                credentialVersionId: 'credential-candidate-official-v2',
                connectionRevision: connection.connectionRevision! + 1,
                updatedAt: now
              }
            : connection
        )
      },
      result: undefined
    }));
    await expect(fixture.service.validatePreparedSubmission({
      subject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation: {
        schemaVersion: 1,
        confirmationId: prepared.confirmation.confirmationId,
        confirmed: true
      }
    })).rejects.toMatchObject({ code: 'stale_route_selection' });
  });

  it('enforces pure-text quick creation, full professional parameters and exact one-image features', async () => {
    const quickWithMedia = resolver({
      ...resolvedSubject(),
      imageCount: 1
    });
    await expect(new ProviderFeatureCandidateService(
      quickWithMedia,
      { async list() { return []; } },
      new RouteSelectionTokenVault(),
      () => now
    ).listFeatureCandidates(subject)).rejects.toMatchObject({ code: 'subject_invalid' });

    const professionalSchema: ParameterSchemaV2 = {
      ...parameterSchema,
      schemaId: 'parameters.candidate.reference-image',
      productFeature: 'reference_to_image'
    };
    const professionalSubject: FeatureCandidateSubjectV1 = {
      kind: 'draft',
      draftId: toDraftId('draft-registry-professional'),
      draftRevision: 1
    };
    const candidate = resolvedCandidate(professionalSchema);
    for (const imageCount of [0, 2]) {
      const service = new ProviderFeatureCandidateService(
        resolver({
          ...resolvedSubject(),
          subject: professionalSubject,
          productFeature: 'reference_to_image',
          surface: 'professional',
          imageCount,
          parameterValues: { quality: 'standard', style: 'natural' }
        }),
        { async list() { return [candidate]; } },
        new RouteSelectionTokenVault(),
        () => now
      );
      await expect(service.listFeatureCandidates(professionalSubject))
        .rejects.toMatchObject({ code: 'subject_invalid' });
    }

    const service = new ProviderFeatureCandidateService(
      resolver({
        ...resolvedSubject(),
        subject: professionalSubject,
        productFeature: 'reference_to_image',
        surface: 'professional',
        imageCount: 1,
        parameterValues: { quality: 'standard', style: 'natural' }
      }),
      { async list() { return [candidate]; } },
      new RouteSelectionTokenVault(),
      () => now
    );
    await expect(service.listFeatureCandidates(professionalSubject)).resolves.toMatchObject([
      {
        available: true,
        parameterSchema: {
          fields: [
            { fieldId: 'quality' },
            { fieldId: 'style' }
          ]
        }
      }
    ]);
  });

  it('invalidates confirmation when outbound text, media or project context snapshots change', async () => {
    const professionalSubject: FeatureCandidateSubjectV1 = {
      kind: 'draft',
      draftId: toDraftId('draft-registry-snapshots'),
      draftRevision: 7
    };
    const schema: ParameterSchemaV2 = {
      ...parameterSchema,
      schemaId: 'parameters.candidate.snapshot-reference',
      productFeature: 'reference_to_image'
    };
    let outboundTextSnapshot = 'snapshot prompt v1';
    let materialRevision = 2;
    let contextHash = 'context-hash-v1';
    const source = () => ({
      ...resolvedSubject(),
      subject: professionalSubject,
      productFeature: 'reference_to_image' as const,
      surface: 'professional' as const,
      imageCount: 1,
      contextCount: 1,
      parameterValues: { quality: 'standard', style: 'natural' },
      outboundTextSnapshot,
      materialReferences: [{
        kind: 'asset' as const,
        referenceId: 'asset-snapshot-reference',
        revision: materialRevision
      }],
      contextContentHashes: [contextHash]
    });
    const service = new ProviderFeatureCandidateService(
      { async resolve() { return source(); } },
      { async list() { return [resolvedCandidate(schema)]; } },
      new RouteSelectionTokenVault(),
      () => now
    );
    const prepared = await service.prepareSubmission({
      subject: professionalSubject,
      candidateId: 'candidate-professional-reference'
    });
    const confirmation = {
      schemaVersion: 1 as const,
      confirmationId: prepared.confirmation.confirmationId,
      confirmed: true as const
    };

    contextHash = 'context-hash-v2';
    await expect(service.validatePreparedSubmission({
      subject: professionalSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    })).rejects.toMatchObject({ code: 'stale_route_selection' });
    contextHash = 'context-hash-v1';
    materialRevision = 3;
    await expect(service.validatePreparedSubmission({
      subject: professionalSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    })).rejects.toMatchObject({ code: 'stale_route_selection' });
    materialRevision = 2;
    outboundTextSnapshot = 'snapshot prompt v2';
    await expect(service.validatePreparedSubmission({
      subject: professionalSubject,
      routeSelectionToken: prepared.routeSelectionToken,
      confirmation
    })).rejects.toMatchObject({ code: 'stale_route_selection' });
  });
});

async function candidateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-registry-candidates-'));
  roots.push(root);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const authorization = new RuntimeAuthorizationLedger(
    new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
    () => now
  );
  await authorization.upsertPolicy({
    policyId: 'policy-candidate-official',
    providerPackageId: 'package.candidate-fixture',
    connectionId: 'connection-candidate-official',
    adapterKey: 'candidate.image.official',
    state: 'interactive_allowed',
    revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result']
  });
  await authorization.upsertPolicy({
    policyId: 'policy-candidate-compatible-blocked',
    providerPackageId: 'package.candidate-fixture',
    connectionId: 'connection-candidate-compatible',
    adapterKey: 'candidate.image.compatible',
    state: 'blocked',
    revision: 1,
    allowedOperations: []
  });
  await registry.mutate((snapshot) => ({
    snapshot: {
      ...snapshot,
      providers: [
        ...snapshot.providers,
        provider('official', 'Official Fixture'),
        provider('compatible', 'Compatible Fixture')
      ],
      connections: [
        ...snapshot.connections,
        connection('official'),
        connection('compatible')
      ],
      protocolBindings: [
        ...snapshot.protocolBindings,
        binding('official'),
        binding('compatible')
      ],
      models: [
        ...snapshot.models,
        model('official', 'Official image model'),
        model('compatible', 'Compatible image model')
      ],
      modelDefinitions: [
        ...(snapshot.modelDefinitions ?? []),
        definition('official'),
        definition('compatible')
      ],
      modelProfiles: [
        ...(snapshot.modelProfiles ?? []),
        profile('official'),
        profile('compatible')
      ]
    },
    result: undefined
  }));

  const contracts = new ProviderFeatureContractRegistry([{
    parameterSchema,
    resultSchemaId: 'results.candidate.image',
    resultSchemaRevision: 1,
    usageSchema,
    constraintSetId: 'constraints.candidate.text-only',
    constraintSetRevision: 1,
    featureMappingVersion: 1
  }]);
  const source = new RegistryFeatureCandidateSource(
    registry,
    new ProviderPackageRegistry([packageDescriptor]),
    contracts,
    authorization
  );
  return {
    registry,
    service: new ProviderFeatureCandidateService(
      resolver(resolvedSubject()),
      source,
      new RouteSelectionTokenVault(),
      () => now
    )
  };
}

const parameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: 'parameters.candidate.text-image',
  revision: 1,
  productFeature: 'text_to_image',
  fields: [
    {
      fieldId: 'quality',
      labelId: 'parameter.quality',
      order: 10,
      valueType: 'enum',
      exposure: 'user_required',
      defaultPolicy: 'require_user_value',
      required: true,
      options: ['standard', 'high']
    },
    {
      fieldId: 'style',
      labelId: 'parameter.style',
      order: 20,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['natural', 'vivid']
    }
  ]
};

const usageSchema = createUsageSchema({
  id: toUsageSchemaId('usage.candidate.image'),
  revision: 1,
  completenessRule: 'provider_status_only',
  conflictPolicy: 'mark_invalid_response',
  metrics: []
});

function resolvedSubject(): ResolvedFeatureSubjectV1 {
  return {
    projectId: toProjectId('project-registry-candidates'),
    subject,
    productFeature: 'text_to_image',
    surface: 'quick',
    imageCount: 0,
    videoCount: 0,
    contextCount: 0,
    parameterValues: { quality: 'standard' },
    outboundTextSnapshot: 'synthetic prompt snapshot',
    materialReferences: [],
    contextContentHashes: []
  };
}

function resolver(value: ResolvedFeatureSubjectV1): FeatureSubjectResolverPort {
  return { async resolve() { return structuredClone(value); } };
}

function provider(kind: 'official' | 'compatible', name: string) {
  return createProvider({
    id: toProviderId(`provider-candidate-${kind}`),
    name,
    packageId: 'package.candidate-fixture',
    packageVersion: '1.0.0',
    accessCategory: kind === 'official' ? 'online' : 'custom_remote',
    identityState: 'verified',
    createdAt: now,
    updatedAt: now
  });
}

function connection(kind: 'official' | 'compatible') {
  return createProviderConnection({
    id: toConnectionId(`connection-candidate-${kind}`),
    providerId: toProviderId(`provider-candidate-${kind}`),
    name: kind === 'official' ? 'Official connection' : 'Compatible connection',
    endpoint: kind === 'official'
      ? 'https://official.candidate.test/v1'
      : 'https://compatible.candidate.test/v1',
    packageId: 'package.candidate-fixture',
    packageVersion: '1.0.0',
    templateId: `candidate-${kind}`,
    templateKind: kind === 'official' ? 'official' : 'compatible_custom',
    credentialSchemaId: 'credential.candidate',
    credentialSchemaVersion: 1,
    credentialVersionId: `credential-candidate-${kind}-v1`,
    connectionPolicyId: `connection-policy.candidate-${kind}`,
    connectionPolicyRevision: 1,
    discoveryPolicyId: `discovery-policy.candidate-${kind}`,
    discoveryPolicyRevision: 1,
    endpointPolicyId: `endpoint-policy.candidate-${kind}`,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: `connection-config-candidate-${kind}-v1`,
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: `candidate.image.${kind}`,
      adapterVersion: '1.0.0',
      protocolId: `candidate.protocol.${kind}`,
      protocolVersion: '1.0.0'
    }],
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: `credential-reference-candidate-${kind}`,
    lastConnectionValidationAt: now,
    createdAt: now,
    updatedAt: now
  });
}

function binding(kind: 'official' | 'compatible') {
  return createProviderProtocolBinding({
    id: toProtocolBindingId(`binding-candidate-${kind}`),
    providerId: toProviderId(`provider-candidate-${kind}`),
    connectionId: toConnectionId(`connection-candidate-${kind}`),
    protocolId: `candidate.protocol.${kind}`,
    protocolVersion: '1.0.0',
    mediaKind: 'image',
    adapterKind: `candidate.image.${kind}`,
    authScheme: 'token',
    executionLifecycle: 'synchronous_completed',
    supportedPurposes: ['image_generation'],
    createdAt: now,
    updatedAt: now
  });
}

function model(kind: 'official' | 'compatible', displayName: string) {
  return createProviderModel({
    id: toModelId(`model-candidate-${kind}`),
    providerId: toProviderId(`provider-candidate-${kind}`),
    connectionId: toConnectionId(`connection-candidate-${kind}`),
    protocolBindingId: toProtocolBindingId(`binding-candidate-${kind}`),
    providerModelKey: `model-key-${kind}`,
    mediaKind: 'image',
    revision: 1,
    displayName,
    activeProfileId: `profile-candidate-${kind}`,
    catalogState: 'present',
    enabled: true,
    createdAt: now,
    updatedAt: now
  });
}

function profile(kind: 'official' | 'compatible') {
  return {
    schemaVersion: 1 as const,
    profileId: `profile-candidate-${kind}`,
    revision: 1,
    packageId: 'package.candidate-fixture',
    sourceTemplateId: `profile-template-candidate-${kind}`,
    adapterKey: `candidate.image.${kind}`,
    modelId: `model-candidate-${kind}`,
    modelRevision: 1,
    protocolBindingId: `binding-candidate-${kind}`,
    status: 'verified' as const,
    features: [{
      productFeature: 'text_to_image' as const,
      internalPurpose: 'image_generation',
      parameterSchemaId: parameterSchema.schemaId,
      resultSchemaId: 'results.candidate.image',
      usageSchemaId: usageSchema.id,
      constraintSetId: 'constraints.candidate.text-only'
    }],
    evidenceIds: [],
    recordedAt: now
  };
}

function definition(kind: 'official' | 'compatible') {
  return {
    schemaVersion: 1 as const,
    definitionId: `definition-candidate-${kind}`,
    packageId: 'package.candidate-fixture',
    packageVersion: '1.0.0',
    providerModelKey: `model-key-${kind}`,
    profileTemplates: [{
      templateId: `profile-template-candidate-${kind}`,
      adapterKey: `candidate.image.${kind}`,
      protocolDefinitionId: `candidate.protocol.${kind}`,
      sourceDocumentRevision: 'candidate-fixture@1',
      features: [{
        productFeature: 'text_to_image' as const,
        internalPurpose: 'image_generation',
        parameterSchemaId: parameterSchema.schemaId,
        resultSchemaId: 'results.candidate.image',
        usageSchemaId: usageSchema.id,
        constraintSetId: 'constraints.candidate.text-only'
      }]
    }]
  };
}

function resolvedCandidate(schema: ParameterSchemaV2) {
  return {
    candidateId: 'candidate-professional-reference',
    providerName: 'Professional provider',
    connectionName: 'Professional connection',
    modelName: 'Professional model',
    recipientName: 'Professional provider / Professional connection',
    outboundScope: 'external_service' as const,
    contentCategories: ['prompt_text', 'image_media'],
    parameterSchema: schema,
    usageSchema: { schemaId: 'usage.candidate.image', revision: 1 },
    cost: { state: 'unknown' as const },
    eligibility: {
      modelEnabled: true,
      catalogState: 'present' as const,
      connectionState: 'available',
      profileStatus: 'verified' as const,
      featureSupported: true,
      bindingAvailable: true,
      runtimeAllowed: true,
      schemasInterpretable: true
    },
    routeTemplate: {
      packageId: 'package.candidate-fixture',
      packageVersion: '1.0.0',
      adapterKey: 'candidate.image.professional',
      adapterVersion: '1.0.0',
      providerId: toProviderId('provider-candidate-professional'),
      connectionId: toConnectionId('connection-candidate-professional'),
      connectionRevision: 1,
      connectionConfigVersionId: 'connection-config-professional-v1',
      endpointPolicyId: 'endpoint-policy.candidate-professional',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-candidate-professional-v1',
      modelId: toModelId('model-candidate-professional'),
      modelRevision: 1,
      profileId: 'profile-candidate-professional',
      profileRevision: 1,
      protocolBindingId: toProtocolBindingId('binding-candidate-professional'),
      protocolBindingRevision: 1,
      productFeature: 'reference_to_image' as const,
      internalPurpose: 'reference_to_image',
      featureMappingVersion: 1,
      parameterSchemaId: schema.schemaId,
      parameterSchemaRevision: schema.revision,
      resultSchemaId: 'results.candidate.image',
      resultSchemaRevision: 1,
      usageSchemaId: toUsageSchemaId('usage.candidate.image'),
      usageSchemaRevision: 1,
      constraintSetId: 'constraints.candidate.single-image',
      constraintSetRevision: 1,
      runtimePolicyId: 'policy-candidate-professional',
      runtimePolicyRevision: 1
    }
  };
}

const packageDescriptor: ProviderPackageDescriptor = {
  packageId: 'package.candidate-fixture',
  packageVersion: '1.0.0',
  displayName: 'Candidate Fixture',
  credentialSchemas: [{
    schemaId: 'credential.candidate',
    version: 1,
    fields: [{
      key: 'api_key',
      label: 'API key',
      secret: true,
      required: true,
      kind: 'token'
    }]
  }],
  endpointPolicies: [
    endpointPolicy('official', 'https://official.candidate.test/v1'),
    endpointPolicy('compatible')
  ],
  adapters: [
    adapterDescriptor('official'),
    adapterDescriptor('compatible')
  ],
  templates: [
    {
      ...template('official'),
      kind: 'official',
      baseUrlMode: 'fixed',
      modelDiscoveryKind: 'catalog'
    },
    {
      ...template('compatible'),
      kind: 'compatible_custom',
      baseUrlMode: 'required',
      modelDiscoveryKind: 'manual_exact'
    }
  ]
};

function endpointPolicy(kind: string, fixedBaseUrl?: string) {
  return {
    policyId: `endpoint-policy.candidate-${kind}`,
    revision: 1,
    allowedSchemes: ['https'] as const,
    allowedHosts: [`${kind}.candidate.test`],
    allowedPorts: [443],
    allowedPathPrefixes: ['/v1'],
    redirectPolicy: 'deny' as const,
    proxyPolicy: 'system' as const,
    allowLoopback: false,
    allowPrivateNetwork: false,
    allowLoopbackHttp: false,
    dnsRebindingProtection: 'required' as const,
    ...(fixedBaseUrl ? { fixedBaseUrl } : {})
  };
}

function adapterDescriptor(kind: string) {
  return {
    adapterId: `candidate.image.${kind}`,
    adapterVersion: '1.0.0',
    protocolId: `candidate.protocol.${kind}`,
    protocolVersion: '1.0.0',
    operations: ['submit', 'receive_result'] as const
  };
}

function template(kind: string) {
  return {
    templateId: `candidate-${kind}`,
    displayName: `Candidate ${kind}`,
    credentialSchemaId: 'credential.candidate',
    credentialSchemaVersion: 1,
    connectionPolicyId: `connection-policy.candidate-${kind}`,
    connectionPolicyRevision: 1,
    discoveryPolicyId: `discovery-policy.candidate-${kind}`,
    discoveryPolicyRevision: 1,
    endpointPolicyId: `endpoint-policy.candidate-${kind}`,
    endpointPolicyRevision: 1,
    adapterBindings: [{
      adapterId: `candidate.image.${kind}`,
      adapterVersion: '1.0.0'
    }],
    freeConnectionValidation: true
  };
}
