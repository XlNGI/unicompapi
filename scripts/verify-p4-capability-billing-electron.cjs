const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

/**
 * P4 Electron acceptance for the two remaining Electron-GREEN criteria of
 * `docs/current/MODEL_CAPABILITY_BILLING_PARAMETER_OPTIMIZATION_PLAN.md`:
 *
 *   1. the video page must not list an unconfirmed image-generation model;
 *   2. billing states and their reason copy must be explainable from a
 *      desensitised fixture.
 *
 * Both are decided by Application/Platform-layer modules that really run in the
 * Electron main process, so this script runs there too and requires the shipped
 * `dist-electron` build rather than re-bundling the sources. The only module
 * loaded from source is `src/pages/tasks/call-fees.ts`, which is renderer-only
 * and therefore absent from the main-process build; it is compiled to CommonJS
 * here so the acceptance still exercises the real copy table.
 *
 * No network, no credentials, no user data: the provider registry and the
 * authorization ledger are real implementations backed by temporary files, and
 * the fixtures use reserved names (`relay.invalid`) plus synthetic amounts.
 */

const workspace = path.resolve(__dirname, '..');
const deadlineMs = 120_000;
const now = '2026-09-18T02:00:00.000Z';

// This acceptance only loads main-process modules, but Electron still spawns a
// GPU process on startup and aborts the whole app when no usable GPU exists
// (headless CI, remote session). The same switch set as the renderer acceptance
// keeps it runnable there.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
app.setPath('userData', path.join(os.tmpdir(), `unicomp-p4-acceptance-${process.pid}`));

let temporaryRoots = [];
let exitCode = 1;
const deadline = setTimeout(() => {
  process.stderr.write('P4 capability/billing acceptance exceeded its deadline.\n');
  app.exit(1);
}, deadlineMs);
deadline.unref?.();

/** Loads the shipped main-process build plus the renderer-only copy module. */
async function loadProductionModules(buildDirectory) {
  const platform = require(path.join(workspace, 'dist-electron', 'src', 'platform', 'index.js'));
  const domain = require(path.join(workspace, 'dist-electron', 'src', 'domain', 'index.js'));
  const vite = require('vite');
  const entry = path.join(buildDirectory, 'call-fees-entry.ts');
  const { writeFile } = require('node:fs/promises');
  // The entry lives in a temporary directory, so it must reference the module by
  // absolute path (forward slashes keep the specifier valid on Windows).
  const callFeesModule = path
    .join(workspace, 'src', 'pages', 'tasks', 'call-fees')
    .split(path.sep)
    .join('/');
  await writeFile(entry, `export * from ${JSON.stringify(callFeesModule)};\n`, 'utf8');
  await vite.build({
    configFile: false,
    root: workspace,
    logLevel: 'silent',
    build: {
      outDir: path.join(buildDirectory, 'call-fees'),
      emptyOutDir: true,
      minify: false,
      target: 'node20',
      lib: { entry, formats: ['cjs'], fileName: () => 'call-fees.cjs' }
    }
  });
  const callFees = require(path.join(buildDirectory, 'call-fees', 'call-fees.cjs'));
  return { platform, domain, callFees };
}

/**
 * Builds the exact registry state the removed soft router used to mint for every
 * enabled model behind a connection publishing `newapi.video`: a verified video
 * profile whose only evidence is the router's own declaration.
 *
 * `trustedEvidence` adds a user-confirmed capability record, which is the only
 * thing that may legitimately authorise a video candidate.
 */
async function relayFixture(modules, input) {
  const { platform, domain } = modules;
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-p4-relay-'));
  temporaryRoots.push(root);

  const providerId = domain.toProviderId('provider-relay');
  const connectionId = domain.toConnectionId('connection-relay');
  const modelId = domain.toModelId('model-relay-image');
  const chatBindingId = domain.toProtocolBindingId('protocol-binding-relay-chat');
  const videoBindingId = domain.toProtocolBindingId('protocol-binding-relay-video');
  const providerModelKey = 'gpt-image-2.5';

  const registry = new platform.JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const authorization = new platform.RuntimeAuthorizationLedger(
    new platform.JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
    () => now
  );
  await authorization.upsertPolicy({
    policyId: 'policy-relay-video',
    providerPackageId: platform.NEWAPI_PROVIDER_PACKAGE_ID,
    connectionId,
    adapterKey: platform.NEWAPI_VIDEO_ADAPTER_ID,
    state: 'interactive_allowed',
    revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result']
  });

  const forgedDefinition = platform.createOpenAiCompatibleDefaultVideoDefinition({
    packageId: platform.NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: platform.NEWAPI_PROVIDER_PACKAGE_VERSION,
    providerModelKey
  });
  const forgedTemplate = forgedDefinition.profileTemplates[0];
  const declaredEvidence = domain.createModelCapabilityEvidence({
    id: domain.toCapabilityEvidenceId(`capability-${modelId}-video_generation-declared-v1`),
    modelId,
    revision: 1,
    capability: 'video_generation',
    state: 'declared_supported',
    source: 'provider_declared',
    recordedAt: now
  });
  const confirmedEvidence = domain.createModelCapabilityEvidence({
    id: domain.toCapabilityEvidenceId(`capability-${modelId}-video_generation-user-confirmed-v1`),
    modelId,
    revision: 1,
    capability: 'video_generation',
    state: 'user_confirmed',
    source: 'user_confirmed',
    recordedAt: now
  });

  await registry.mutate((snapshot) => ({
    snapshot: {
      ...snapshot,
      providers: [
        ...snapshot.providers,
        domain.createProvider({
          id: providerId,
          name: 'Relay',
          accessCategory: 'online',
          identityState: 'verified',
          packageId: platform.NEWAPI_PROVIDER_PACKAGE_ID,
          packageVersion: platform.NEWAPI_PROVIDER_PACKAGE_VERSION,
          createdAt: now,
          updatedAt: now
        })
      ],
      connections: [
        ...snapshot.connections,
        domain.createProviderConnection({
          id: connectionId,
          providerId,
          name: 'Relay connection',
          endpoint: 'https://relay.invalid',
          packageId: platform.NEWAPI_PROVIDER_PACKAGE_ID,
          packageVersion: platform.NEWAPI_PROVIDER_PACKAGE_VERSION,
          templateId: platform.NEWAPI_COMPATIBLE_TEMPLATE_ID,
          templateKind: 'compatible_custom',
          credentialSchemaId: platform.NEWAPI_CREDENTIAL_SCHEMA_ID,
          credentialSchemaVersion: 1,
          credentialVersionId: 'credential-version-relay',
          connectionPolicyId: 'connection.relay.compatible',
          connectionPolicyRevision: 1,
          discoveryPolicyId: 'discovery.relay.models',
          discoveryPolicyRevision: 1,
          endpointPolicyId: platform.NEWAPI_ENDPOINT_POLICY_ID,
          endpointPolicyRevision: 1,
          connectionConfigVersionId: 'connection-config-relay',
          connectionRevision: 1,
          adapterBindings: platform.newApiProviderPackageDescriptor.adapters.map((adapter) => ({
            adapterId: adapter.adapterId,
            adapterVersion: adapter.adapterVersion,
            protocolId: adapter.protocolId,
            protocolVersion: adapter.protocolVersion
          })),
          state: 'available',
          identityState: 'verified',
          credentialState: 'valid',
          credentialReference: 'credential-reference-relay',
          createdAt: now,
          updatedAt: now
        })
      ],
      protocolBindings: [
        ...snapshot.protocolBindings,
        domain.createProviderProtocolBinding({
          id: chatBindingId,
          providerId,
          connectionId,
          protocolId: platform.NEWAPI_CHAT_PROTOCOL_ID,
          protocolVersion: platform.NEWAPI_PROTOCOL_VERSION,
          mediaKind: 'unknown',
          adapterKind: platform.NEWAPI_CHAT_ADAPTER_ID,
          authScheme: 'unknown',
          executionLifecycle: 'unknown',
          supportedPurposes: [],
          createdAt: now,
          updatedAt: now
        }),
        domain.createProviderProtocolBinding({
          id: videoBindingId,
          providerId,
          connectionId,
          protocolId: platform.NEWAPI_VIDEO_PROTOCOL_ID,
          protocolVersion: platform.NEWAPI_PROTOCOL_VERSION,
          mediaKind: 'unknown',
          adapterKind: platform.NEWAPI_VIDEO_ADAPTER_ID,
          authScheme: 'bearer',
          executionLifecycle: 'asynchronous_polling',
          supportedPurposes: ['video_generation'],
          createdAt: now,
          updatedAt: now
        })
      ],
      models: [
        ...snapshot.models,
        domain.createProviderModel({
          id: modelId,
          providerId,
          connectionId,
          providerModelKey,
          displayName: providerModelKey,
          protocolBindingId: videoBindingId,
          mediaKind: 'unknown',
          enabled: true,
          catalogState: 'present',
          revision: 1,
          createdAt: now,
          updatedAt: now
        })
      ],
      capabilities: [
        ...snapshot.capabilities,
        declaredEvidence,
        ...(input.trustedEvidence ? [confirmedEvidence] : [])
      ],
      modelDefinitions: [...(snapshot.modelDefinitions ?? []), forgedDefinition],
      modelProfiles: [
        ...(snapshot.modelProfiles ?? []),
        {
          schemaVersion: 1,
          profileId: 'profile-relay-forged-video',
          revision: 1,
          packageId: platform.NEWAPI_PROVIDER_PACKAGE_ID,
          sourceTemplateId: forgedTemplate.templateId,
          adapterKey: platform.NEWAPI_VIDEO_ADAPTER_ID,
          modelId,
          modelRevision: 1,
          protocolBindingId: videoBindingId,
          status: 'verified',
          features: [
            {
              productFeature: 'text_to_video',
              internalPurpose: 'video_generation',
              parameterSchemaId: platform.NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
              resultSchemaId: platform.NEWAPI_VIDEO_RESULT_SCHEMA_ID,
              usageSchemaId: platform.newApiVideoUsageSchema.id,
              constraintSetId: platform.NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
            }
          ],
          evidenceIds: [declaredEvidence.id],
          recordedAt: now
        }
      ]
    },
    result: undefined
  }));

  const contracts = new platform.ProviderFeatureContractRegistry([
    {
      parameterSchema: platform.newApiDefaultTextToVideoParameterSchema,
      resultSchemaId: platform.NEWAPI_VIDEO_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: platform.newApiVideoUsageSchema,
      constraintSetId: platform.NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: platform.newApiDefaultTextToVideoParameterSchema,
      resultSchemaId: platform.NEWAPI_VIDEO_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: platform.newApiVideoUsageSchema,
      constraintSetId: platform.NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    }
  ]);
  const source = new platform.RegistryFeatureCandidateSource(
    registry,
    new platform.ProviderPackageRegistry([platform.newApiProviderPackageDescriptor]),
    contracts,
    authorization
  );
  const resolver = {
    async resolve(subject) {
      return {
        projectId: domain.toProjectId('project-video-gate'),
        subject,
        productFeature: 'text_to_video',
        surface: 'quick',
        imageCount: 0,
        videoCount: 0,
        contextCount: 0,
        parameterValues: {},
        outboundTextSnapshot: 'synthetic prompt',
        materialReferences: [],
        contextContentHashes: []
      };
    }
  };
  return {
    registry,
    providerModelKey,
    draftSubject: { kind: 'draft', draftId: domain.toDraftId('draft-video-gate'), draftRevision: 1 },
    service: new platform.ProviderFeatureCandidateService(
      resolver,
      source,
      new platform.RouteSelectionTokenVault(),
      () => now
    )
  };
}

/**
 * Desensitised billing fixtures, one per original failure class. Amounts are
 * synthetic, `sourceLabel`s carry no upstream host, and the decoy strings stand
 * in for the upstream text that must never reach the renderer.
 */
const billingFixtures = [
  {
    name: 'a missing upstream request id',
    billing: { state: 'unestimated', currencyCode: 'CNY', reasonCode: 'request_id_unavailable' }
  },
  {
    name: 'a station log endpoint answering 404',
    billing: { state: 'unestimated', currencyCode: 'CNY', reasonCode: 'logs_unavailable_404' }
  },
  {
    name: 'a station log endpoint answering 429',
    billing: { state: 'unestimated', currencyCode: 'CNY', reasonCode: 'logs_rate_limited' }
  },
  {
    name: 'a station that reported no usage',
    billing: { state: 'unestimated', currencyCode: 'CNY', reasonCode: 'usage_not_reported' }
  },
  {
    name: 'a price table without the exact model key',
    billing: { state: 'unestimated', currencyCode: 'CNY', reasonCode: 'pricing_model_missing' }
  }
];

/** Upstream text that a fixture may carry but that must never be displayed. */
const secretDecoys = [
  'https://relay.invalid/v1/logs',
  'sk-decoy-not-a-real-token-0001',
  'raw upstream payload {quota: 12345}'
];

async function run() {
  const buildDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-p4-build-'));
  temporaryRoots.push(buildDirectory);
  await app.whenReady();

  const modules = await loadProductionModules(buildDirectory);
  const { platform, callFees } = modules;
  const scenarios = [];
  const record = (name, passed, detail) => scenarios.push({ name, passed, detail });

  // --- A. The video candidate list never shows an unconfirmed image model ----
  const unconfirmed = await relayFixture(modules, { trustedEvidence: false });
  const unconfirmedCandidates = await unconfirmed.service.listFeatureCandidates(
    unconfirmed.draftSubject
  );
  record(
    'the video candidate list excludes a model whose video capability is unconfirmed',
    unconfirmedCandidates.length === 0,
    `candidates: ${unconfirmedCandidates.length}`
  );
  record(
    'the image-only model name is absent from the video candidate list',
    !unconfirmedCandidates.some((candidate) => candidate.modelName === unconfirmed.providerModelKey),
    `model ${unconfirmed.providerModelKey} present: ${unconfirmedCandidates.some(
      (candidate) => candidate.modelName === unconfirmed.providerModelKey
    )}`
  );
  const invalidated = platform.describeInvalidatedOpenAiCompatibleVideoProfiles(
    await unconfirmed.registry.load(),
    (productFeature) => productFeature === 'text_to_video'
  );
  record(
    'the excluded profile is reported with a reason and the gate version',
    invalidated.length === 1 &&
      invalidated[0].reason === 'router_synthesized_evidence' &&
      invalidated[0].gateVersion === platform.OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION,
    `report: ${JSON.stringify(invalidated)}`
  );

  // The gate must not be a blanket block: the same model becomes eligible once a
  // trustworthy per-model fact exists.
  const confirmed = await relayFixture(modules, { trustedEvidence: true });
  const confirmedCandidates = await confirmed.service.listFeatureCandidates(
    confirmed.draftSubject
  );
  record(
    'the same model is listed once its video capability is user-confirmed',
    confirmedCandidates.length === 1 &&
      confirmedCandidates[0].modelName === confirmed.providerModelKey &&
      confirmedCandidates[0].available === true,
    `candidates: ${JSON.stringify(
      confirmedCandidates.map((candidate) => ({
        modelName: candidate.modelName,
        available: candidate.available
      }))
    )}`
  );

  // --- B. Billing states and their reason copy are explainable --------------
  const copies = [];
  for (const fixture of billingFixtures) {
    const text = callFees.formatCallBilling(fixture.billing);
    copies.push({ name: fixture.name, text });
    record(
      `billing copy explains ${fixture.name}`,
      typeof text === 'string' &&
        text.startsWith('无法估算') &&
        text.length > '无法估算'.length + 4,
      `"${String(text)}"`
    );
  }
  record(
    'each billing reason produces distinct copy instead of one generic message',
    new Set(copies.map((entry) => entry.text)).size === copies.length,
    `distinct ${new Set(copies.map((entry) => entry.text)).size} of ${copies.length}: ` +
      copies.map((entry) => entry.text).join(' | ')
  );

  // A settled amount must render as an amount, with no reason appended.
  const settled = callFees.formatCallBilling({
    state: 'actual_bill',
    currencyCode: 'CNY',
    amount: '12.5'
  });
  record(
    'a settled amount renders as an amount without a reason',
    settled === '¥12.5',
    `"${String(settled)}"`
  );
  const pending = callFees.formatCallBilling({
    state: 'pending_reconciliation',
    currencyCode: 'CNY'
  });
  record(
    'a state without a reason still renders its own label',
    pending === '等待中转站账单确认',
    `"${String(pending)}"`
  );

  // Desensitising check: no decoy upstream text may appear in any output.
  const allCopy = [
    ...copies.map((entry) => entry.text),
    settled,
    pending,
    callFees.formatCallBilling(undefined)
  ]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const leaked = secretDecoys.filter((decoy) => allCopy.includes(decoy));
  record(
    'no upstream text, host or credential reaches the billing copy',
    leaked.length === 0,
    `leaked: ${leaked.length === 0 ? 'none' : leaked.join(', ')}`
  );

  // A failed call and a missing pricing rule must stay explainable too.
  const notSuccessful = callFees.calculateSuccessfulCallFee({
    state: 'failed',
    usage: { availability: 'available', facts: [], calculatedAt: now }
  });
  record(
    'a failed call is explained instead of priced',
    notSuccessful.state === 'not_successful' &&
      notSuccessful.reason === '调用未成功，不计入费用',
    `state ${notSuccessful.state}, reason "${String(notSuccessful.reason)}"`
  );
  const missingRule = callFees.calculateSuccessfulCallFee({
    state: 'completed',
    usage: {
      availability: 'available',
      facts: [{ metricId: 'output_seconds', quantity: '5', unit: 'second', source: 'station' }],
      calculatedAt: now
    }
  });
  record(
    'a successful call without a pricing rule is explained instead of guessed',
    missingRule.state === 'missing_inputs' &&
      missingRule.reason === '缺少官方价格规则，无法计算费用',
    `state ${missingRule.state}, reason "${String(missingRule.reason)}"`
  );

  const evidence = {
    scenario: 'P4 capability gate and billing copy (Electron main process)',
    environment: {
      electron: process.versions.electron,
      node: process.versions.node,
      platform: os.platform(),
      release: os.release(),
      modules: 'dist-electron main-process build + renderer-only copy module'
    },
    candidateGate: {
      unconfirmedCandidates: unconfirmedCandidates.length,
      confirmedCandidates: confirmedCandidates.length,
      invalidatedReport: invalidated
    },
    billing: { copies },
    scenarios
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

  const failed = scenarios.filter((scenario) => !scenario.passed);
  assert.equal(failed.length, 0, `unmet expectations: ${JSON.stringify(failed, null, 2)}`);
  process.stdout.write('P4_CAPABILITY_BILLING_ACCEPTANCE_OK\n');
  exitCode = 0;
}

run()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(deadline);
    const roots = temporaryRoots;
    temporaryRoots = [];
    for (const root of roots) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    app.exit(exitCode);
  });
