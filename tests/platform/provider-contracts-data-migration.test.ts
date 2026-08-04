import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProjectContextDraftFragment,
  addUserMessage,
  createAsset,
  createConversation,
  createDraft,
  createEmptyImageWorkspaceDraft,
  createEmptyVideoWorkspaceDraft,
  createExecution,
  createProjectContextDraft,
  createProvider,
  createProviderConnection,
  createProviderOperationRecord,
  createProviderProtocolBinding,
  createTaskFromDraft,
  registerProjectContextDraft,
  toAssetId,
  toConnectionId,
  toConversationId,
  toDraftId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  toProviderOperationRecordId,
  toTaskId,
  toWorkId,
  type ImageWorkspaceDraft,
  type VideoWorkspaceDraft,
  type Work
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  NodeProjectStorage,
  ProviderContractsDataMigrator,
  ProviderRegistryContractsMigrator,
  migrateProviderRegistryOwnership,
  type ProviderContractsMigrationSourceV1,
  type ProviderRegistryOwnershipMappingV1
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-contract-migration');
const t0 = toIsoTimestamp('2026-08-03T13:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T13:01:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('provider contracts project data migration', () => {
  it('migrates quick references explicitly and blocks ambiguous legacy facts without fabrication', async () => {
    const fixture = await projectFixture();
    const source = migrationSource();
    const result = await fixture.migrator.migrate(source, t1);

    expect(result.alreadyApplied).toBe(false);
    expect(result.run.status).toBe('completed_with_blocks');
    expect(result.run.draftDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        legacyDraftId: 'image-quick-reference',
        disposition: 'read_only_blocked',
        targetSurface: 'professional_image',
        targetProductFeature: 'reference_to_image',
        blockers: ['saved_conversation_requires_project_context'],
        clearedLegacyFields: [
          'model',
          'parameters',
          'confirmation',
          'saved_conversation_context'
        ]
      }),
      expect.objectContaining({
        legacyDraftId: 'video-quick-image',
        disposition: 'migrated',
        targetSurface: 'professional_video',
        targetProductFeature: 'image_to_video'
      }),
      expect.objectContaining({
        legacyDraftId: 'video-quick-video',
        disposition: 'read_only_blocked',
        blockers: ['legacy_video_reference_unsupported']
      }),
      expect.objectContaining({
        legacyDraftId: 'generic-text-video',
        disposition: 'migrated',
        targetSurface: 'quick_video',
        targetProductFeature: 'text_to_video'
      }),
      expect.objectContaining({
        legacyDraftId: 'generic-local-video-edit',
        disposition: 'preserved_local',
        clearedLegacyFields: []
      })
    ]));

    expect(result.run.callRecords).toEqual([
      expect.objectContaining({
        executionId: 'execution-legacy-async',
        routeState: 'legacy_route_unavailable',
        recoverability: 'unrecoverable',
        safeReason: 'legacy_route_unavailable',
        usageAvailability: 'not_collected_legacy',
        invocationFacts: 'not_fabricated',
        providerReceipt: 'legacy_redacted'
      })
    ]);
    expect(result.run.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: 'conversation-unbound',
        disposition: 'unbound_read_only',
        automaticProjectAssignment: false
      }),
      expect.objectContaining({
        conversationId: 'conversation-project',
        disposition: 'project_owned'
      })
    ]));
    expect(result.run.projectContexts).toEqual([
      expect.objectContaining({
        projectContextId: 'context-migrated',
        sourceConversationId: 'conversation-project',
        disposition: 'preserved_project_context'
      })
    ]);
    expect(result.run.providerInvocationFactsCreated).toBe(0);
    expect(result.run.providerUsageFactsCreated).toBe(0);
    expect(JSON.stringify(result.run)).not.toMatch(
      /legacy-provider-operation-secret|remote_url|base64|file_uri|finalPrompt|originalInput/
    );
  });

  it('is order-independent and idempotent, appends changed facts, and recovers from backup', async () => {
    const fixture = await projectFixture();
    const source = migrationSource();
    const first = await fixture.migrator.migrate(source, t1);
    const reordered = {
      ...source,
      assets: [...source.assets].reverse(),
      conversations: [...source.conversations].reverse()
    };
    const repeated = await fixture.migrator.migrate(reordered, t1);
    expect(repeated).toMatchObject({ alreadyApplied: true, documentRevision: 1 });
    expect(repeated.run.sourceFingerprint).toBe(first.run.sourceFingerprint);

    const changed = await fixture.migrator.migrate({
      ...source,
      mappingVersion: 'migration-map-v2'
    }, t1);
    expect(changed).toMatchObject({ alreadyApplied: false, documentRevision: 2 });
    expect((await fixture.migrator.load()).runs).toHaveLength(2);

    await writeFile(
      path.join(fixture.projectRoot, 'migrations', 'provider-contracts-v1.json'),
      '{broken',
      'utf8'
    );
    const recovered = await fixture.migrator.load();
    expect(recovered.revision).toBe(1);
    expect(recovered.runs).toHaveLength(1);
  });

  it('accepts only explicit route mappings and rejects cross-project or duplicate history', async () => {
    const fixture = await projectFixture();
    const source = migrationSource();
    const mapped = await fixture.migrator.migrate({
      ...source,
      legacyRouteMappings: [{
        executionId: toExecutionId('execution-legacy-async'),
        routeSnapshotId: 'route-snapshot-exact-v1',
        mappingVersion: 'route-map-v1'
      }]
    }, t1);
    expect(mapped.run.callRecords[0]).toMatchObject({
      routeState: 'mapped',
      routeSnapshotId: 'route-snapshot-exact-v1',
      recoverability: 'read_only'
    });

    await expect(fixture.migrator.migrate({
      ...source,
      drafts: [source.drafts[0], source.drafts[0]]
    }, t1)).rejects.toThrow('legacy draft identities must be unique');
    await expect(fixture.migrator.migrate({
      ...source,
      assets: [{ ...source.assets[0], projectId: toProjectId('another-project') }]
    }, t1)).rejects.toThrow('crosses projects');
  });
});

describe('provider registry contract migration', () => {
  it('requires exact package/protocol ownership, increments revision once, and keeps a restorable backup', async () => {
    const fixture = await registryFixture();
    const migrator = new ProviderRegistryContractsMigrator(fixture.store);
    const mapping = registryMapping();
    const migrated = await migrator.migrate([mapping]);
    expect(migrated).toMatchObject({
      changed: true,
      registryRevision: 2,
      migratedConnectionIds: ['connection-legacy']
    });
    expect(migrated.snapshot.providers[0]).toMatchObject({
      packageId: 'package.fixture',
      packageVersion: '1.0.0'
    });
    expect(migrated.snapshot.connections[0]).toMatchObject({
      templateId: 'template.fixture',
      connectionRevision: 1
    });
    expect(await fixture.store.loadBackup()).toMatchObject({ registryRevision: 1 });

    const repeated = await migrator.migrate([mapping]);
    expect(repeated).toMatchObject({ changed: false, registryRevision: 2 });
    expect(await fixture.store.restoreBackup()).toBe(true);
    expect(await fixture.store.load()).toMatchObject({
      registryRevision: 3,
      providers: [expect.objectContaining({ packageId: undefined })]
    });
  });

  it('preserves unmapped records and never guesses a package, adapter, or protocol', async () => {
    const fixture = await registryFixture();
    const snapshot = await fixture.store.load();
    const noMappings = migrateProviderRegistryOwnership(snapshot, []);
    expect(noMappings).toMatchObject({
      changed: false,
      unmappedProviderIds: ['provider-legacy'],
      unmappedConnectionIds: ['connection-legacy']
    });
    await expect(new ProviderRegistryContractsMigrator(fixture.store).migrate([{
      ...registryMapping(),
      ownership: {
        ...registryMapping().ownership,
        adapterBindings: [{
          adapterId: 'guessed.adapter',
          adapterVersion: '1.0.0',
          protocolId: 'guessed.protocol',
          protocolVersion: '1'
        }]
      }
    }])).rejects.toThrow('cannot guess a protocol binding');
  });
});

async function projectFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-contract-migration-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  return {
    projectRoot,
    migrator: new ProviderContractsDataMigrator(new NodeProjectStorage(projectRoot))
  };
}

function migrationSource(): ProviderContractsMigrationSourceV1 {
  const imageAsset = createAsset({
    id: toAssetId('asset-image'),
    projectId,
    fileId: toFileReferenceId('file-image'),
    name: 'image.png',
    mediaKind: 'image',
    origin: 'imported',
    createdAt: t0
  });
  const videoAsset = createAsset({
    id: toAssetId('asset-video'),
    projectId,
    fileId: toFileReferenceId('file-video'),
    name: 'video.mp4',
    mediaKind: 'video',
    origin: 'imported',
    createdAt: t0
  });
  const generic = createDraft({
    id: toDraftId('generic-text-video'),
    projectId,
    kind: 'video_generation',
    state: 'saved',
    prompt: prompt('generate a video'),
    selectedAssetIds: [],
    createdAt: t0,
    updatedAt: t0
  });
  const localVideoEdit = createDraft({
    id: toDraftId('generic-local-video-edit'),
    projectId,
    kind: 'video_editing',
    state: 'saved',
    prompt: prompt('local edit'),
    selectedAssetIds: [videoAsset.id],
    createdAt: t0,
    updatedAt: t0
  });
  const task = createTaskFromDraft({
    id: toTaskId('task-legacy-async'),
    draft: generic,
    confirmedAt: t0
  });
  const execution = createExecution({
    id: toExecutionId('execution-legacy-async'),
    taskId: task.id,
    createdAt: t0
  });
  const providerOperation = createProviderOperationRecord({
    id: toProviderOperationRecordId('provider-operation-legacy'),
    taskId: task.id,
    executionId: execution.id,
    mediaKind: 'video',
    executionLifecycle: 'asynchronous_polling',
    outcome: {
      kind: 'accepted_async',
      providerOperationId: 'legacy-provider-operation-secret',
      state: 'processing'
    },
    createdAt: t0,
    updatedAt: t0
  });
  const work: Work = {
    schemaVersion: 1,
    id: toWorkId('work-legacy'),
    projectId,
    sourceTaskId: task.id,
    sourceExecutionId: execution.id,
    fileId: toFileReferenceId('file-work'),
    mediaKind: 'video',
    name: 'legacy work',
    createdAt: t0
  };
  const imageQuick = {
    ...createEmptyImageWorkspaceDraft({
      id: toDraftId('image-quick-reference'),
      projectId,
      mode: 'quick_image',
      createdAt: t0
    }),
    input: {
      assetId: imageAsset.id,
      role: 'reference' as const,
      selectedAt: t0
    },
    contextReferences: [{
      kind: 'saved_conversation' as const,
      referenceId: 'conversation-unbound'
    }]
  } satisfies ImageWorkspaceDraft;
  const videoQuickImage = {
    ...createEmptyVideoWorkspaceDraft({
      id: toDraftId('video-quick-image'),
      projectId,
      mode: 'quick_video',
      createdAt: t0
    }),
    quick: {
      reference: {
        assetId: imageAsset.id,
        mediaKind: 'image' as const,
        role: 'reference',
        selectedAt: t0
      }
    }
  } satisfies VideoWorkspaceDraft;
  const videoQuickVideo = {
    ...createEmptyVideoWorkspaceDraft({
      id: toDraftId('video-quick-video'),
      projectId,
      mode: 'quick_video',
      createdAt: t0
    }),
    quick: {
      reference: {
        assetId: videoAsset.id,
        mediaKind: 'video' as const,
        role: 'reference',
        selectedAt: t0
      }
    }
  } satisfies VideoWorkspaceDraft;
  const projectConversation = addUserMessage(createConversation({
    id: toConversationId('conversation-project'),
    title: 'Project conversation',
    projectId,
    createdAt: t0
  }), {
    id: toMessageId('message-project-user'),
    content: 'context source',
    createdAt: t0
  });
  const unboundConversation = createConversation({
    id: toConversationId('conversation-unbound'),
    title: 'Legacy unbound',
    projectId: null,
    createdAt: t0
  });
  const contextDraft = addProjectContextDraftFragment(createProjectContextDraft({
    id: toProjectContextDraftId('context-draft-migration'),
    projectId,
    conversationId: projectConversation.id,
    createdAt: t0
  }), {
    id: toProjectContextFragmentId('context-fragment-migration'),
    conversationId: projectConversation.id,
    messageId: projectConversation.messages[0].id,
    messageRevision: projectConversation.messages[0].revision,
    messageRole: 'user',
    selection: { schemaVersion: 1, startUtf16: 0, endUtf16: 7 },
    contentSnapshot: 'context'
  }, t0);
  const context = registerProjectContextDraft(
    contextDraft,
    toProjectContextId('context-migrated'),
    t0
  );
  return {
    schemaVersion: 1,
    projectId,
    mappingVersion: 'migration-map-v1',
    assets: [imageAsset, videoAsset],
    drafts: [generic, localVideoEdit],
    imageWorkspaceDrafts: [imageQuick],
    videoWorkspaceDrafts: [videoQuickImage, videoQuickVideo],
    tasks: [task],
    executions: [execution],
    providerOperations: [providerOperation],
    works: [work],
    conversations: [unboundConversation, projectConversation],
    projectContexts: [context],
    legacyRouteMappings: []
  };
}

function prompt(text: string) {
  return { originalInput: text, systemSupplements: [], finalPrompt: text };
}

async function registryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-registry-migration-'));
  roots.push(root);
  const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const provider = createProvider({
    id: toProviderId('provider-legacy'),
    name: 'Legacy provider',
    accessCategory: 'custom_remote',
    identityState: 'unverified',
    createdAt: t0,
    updatedAt: t0
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-legacy'),
    providerId: provider.id,
    name: 'Legacy connection',
    state: 'saved',
    identityState: 'unverified',
    credentialState: 'not_configured',
    createdAt: t0,
    updatedAt: t0
  });
  const binding = createProviderProtocolBinding({
    id: toProtocolBindingId('binding-legacy-exact'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.protocol',
    protocolVersion: '1',
    mediaKind: 'image',
    adapterKind: 'fixture.adapter',
    authScheme: 'token',
    executionLifecycle: 'synchronous_completed',
    supportedPurposes: ['image_generation'],
    createdAt: t0,
    updatedAt: t0
  });
  await store.save({
    schemaVersion: 3,
    currentConnectionId: null,
    providers: [provider],
    connections: [connection],
    protocolBindings: [binding],
    models: [],
    capabilities: [],
    routingPreferences: [],
    modelDefinitions: [],
    modelProfiles: []
  });
  return { store };
}

function registryMapping(): ProviderRegistryOwnershipMappingV1 {
  return {
    schemaVersion: 1,
    mappingVersion: 'registry-map-v1',
    providerId: 'provider-legacy',
    connectionId: 'connection-legacy',
    ownership: {
      packageId: 'package.fixture',
      packageVersion: '1.0.0',
      templateId: 'template.fixture',
      templateKind: 'official',
      credentialSchemaId: 'credential.fixture',
      credentialSchemaVersion: 1,
      credentialVersionId: 'credential-version.fixture.1',
      connectionPolicyId: 'connection-policy.fixture',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery-policy.fixture',
      discoveryPolicyRevision: 1,
      endpointPolicyId: 'endpoint-policy.fixture',
      endpointPolicyRevision: 1,
      connectionConfigVersionId: 'connection-config.fixture.1',
      connectionRevision: 1,
      adapterBindings: [{
        adapterId: 'fixture.adapter',
        adapterVersion: '1.0.0',
        protocolId: 'fixture.protocol',
        protocolVersion: '1'
      }]
    }
  };
}
