import { createHash } from 'node:crypto';
import {
  createProvider,
  createProviderConnection,
  toIsoTimestamp,
  type Asset,
  type AssetId,
  type Conversation,
  type Draft,
  type Execution,
  type ImageWorkspaceDraft,
  type IsoTimestamp,
  type ProductFeature,
  type ProjectContextV1,
  type ProjectId,
  type ProviderConnectionAdapterBinding,
  type ProviderOperationRecord,
  type ProviderTemplateKind,
  type Task,
  type VideoWorkspaceDraft,
  type Work
} from '../../domain';
import {
  projectStoragePaths,
  type ProjectStorageAdapter
} from '../storage';
import {
  ProviderRegistryConflictError,
  type JsonProviderRegistryStore,
  type ProviderRegistrySnapshot
} from './provider-registry';

export const providerContractsMigrationVersion = 'provider-contracts-v1';

export const legacyMigrationBlockers = [
  'legacy_multiple_materials_unsupported',
  'legacy_video_reference_unsupported',
  'legacy_material_kind_unknown',
  'saved_conversation_requires_project_context',
  'legacy_route_unavailable'
] as const;
export type LegacyMigrationBlocker = (typeof legacyMigrationBlockers)[number];

export interface LegacyRouteMappingV1 {
  readonly executionId: Execution['id'];
  readonly routeSnapshotId: string;
  readonly mappingVersion: string;
}

export interface ProviderContractsMigrationSourceV1 {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly mappingVersion: string;
  readonly assets: readonly Asset[];
  readonly drafts: readonly Draft[];
  readonly imageWorkspaceDrafts: readonly ImageWorkspaceDraft[];
  readonly videoWorkspaceDrafts: readonly VideoWorkspaceDraft[];
  readonly tasks: readonly Task[];
  readonly executions: readonly Execution[];
  readonly providerOperations: readonly ProviderOperationRecord[];
  readonly works: readonly Work[];
  readonly conversations: readonly Conversation[];
  readonly projectContexts: readonly ProjectContextV1[];
  readonly legacyRouteMappings: readonly LegacyRouteMappingV1[];
}

export interface LegacyDraftMigrationDecisionV1 {
  readonly schemaVersion: 1;
  readonly legacyDraftId: string;
  readonly sourceKind: 'draft' | 'image_workspace' | 'video_workspace';
  readonly disposition: 'migrated' | 'preserved_local' | 'read_only_blocked';
  readonly targetSurface?:
    | 'quick_image'
    | 'professional_image'
    | 'quick_video'
    | 'professional_video'
    | 'image_understanding'
    | 'image_to_prompt'
    | 'image_editing';
  readonly targetProductFeature?: ProductFeature;
  readonly preservedAssetIds: readonly AssetId[];
  readonly clearedLegacyFields: readonly (
    | 'model'
    | 'parameters'
    | 'confirmation'
    | 'saved_conversation_context'
  )[];
  readonly blockers: readonly LegacyMigrationBlocker[];
  readonly legacyModelId?: string;
  readonly legacyCapabilityEvidenceId?: string;
  readonly mappingVersion: string;
  readonly requiresUserConfirmation: true;
}

export interface LegacyCallReadModelV1 {
  readonly schemaVersion: 1;
  readonly taskId: Task['id'];
  readonly executionId: Execution['id'];
  readonly providerOperationRecordId?: ProviderOperationRecord['id'];
  readonly workIds: readonly Work['id'][];
  readonly state: Execution['state'];
  readonly routeState: 'mapped' | 'not_applicable' | 'legacy_route_unavailable';
  readonly routeSnapshotId?: string;
  readonly recoverability: 'read_only' | 'unrecoverable';
  readonly safeReason?: 'legacy_route_unavailable';
  readonly usageAvailability: 'not_collected_legacy';
  readonly invocationFacts: 'not_fabricated';
  readonly providerReceipt: 'absent' | 'legacy_redacted';
}

export interface LegacyConversationReadModelV1 {
  readonly schemaVersion: 1;
  readonly conversationId: Conversation['id'];
  readonly projectId: ProjectId | null;
  readonly revision: number;
  readonly messageCount: number;
  readonly disposition: 'project_owned' | 'unbound_read_only';
  readonly automaticProjectAssignment: false;
}

export interface LegacyProjectContextReadModelV1 {
  readonly schemaVersion: 1;
  readonly projectContextId: ProjectContextV1['id'];
  readonly currentRevision: number;
  readonly sourceConversationId: Conversation['id'];
  readonly disposition: 'preserved_project_context';
}

export interface ProviderContractsMigrationRunV1 {
  readonly schemaVersion: 1;
  readonly migrationVersion: typeof providerContractsMigrationVersion;
  readonly projectId: ProjectId;
  readonly mappingVersion: string;
  readonly sourceFingerprint: string;
  readonly completedAt: IsoTimestamp;
  readonly status: 'completed' | 'completed_with_blocks';
  readonly draftDecisions: readonly LegacyDraftMigrationDecisionV1[];
  readonly callRecords: readonly LegacyCallReadModelV1[];
  readonly conversations: readonly LegacyConversationReadModelV1[];
  readonly projectContexts: readonly LegacyProjectContextReadModelV1[];
  readonly sourceFactsPreserved: true;
  readonly providerInvocationFactsCreated: 0;
  readonly providerUsageFactsCreated: 0;
}

export interface ProviderContractsMigrationDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly runs: readonly ProviderContractsMigrationRunV1[];
}

export interface ProviderContractsMigrationOutcomeV1 {
  readonly run: ProviderContractsMigrationRunV1;
  readonly alreadyApplied: boolean;
  readonly documentRevision: number;
}

export class ProviderContractsDataMigrator {
  constructor(private readonly storage: ProjectStorageAdapter) {}

  async migrate(
    source: ProviderContractsMigrationSourceV1,
    completedAt: IsoTimestamp
  ): Promise<ProviderContractsMigrationOutcomeV1> {
    const normalized = normalizeSource(source);
    const timestamp = toIsoTimestamp(completedAt);
    const sourceFingerprint = fingerprint(normalized);
    let alreadyApplied = false;
    let selectedRun: ProviderContractsMigrationRunV1 | undefined;

    const document = await this.storage.mutateJsonAtomically(
      projectStoragePaths.migrations.providerContracts,
      (current) => {
        const existing = current === undefined
          ? emptyMigrationDocument()
          : parseProviderContractsMigrationDocument(current);
        const previous = existing.runs.find(
          (run) => run.sourceFingerprint === sourceFingerprint
        );
        if (previous) {
          alreadyApplied = true;
          selectedRun = previous;
          return existing;
        }
        const run = buildMigrationRun(normalized, sourceFingerprint, timestamp);
        selectedRun = run;
        return {
          schemaVersion: 1 as const,
          revision: existing.revision + 1,
          runs: [...existing.runs, run]
        };
      },
      { backup: true }
    );

    if (!selectedRun) {
      throw new TypeError('provider contracts migration did not produce a run');
    }
    return {
      run: selectedRun,
      alreadyApplied,
      documentRevision: document.revision
    };
  }

  async load(): Promise<ProviderContractsMigrationDocumentV1> {
    const loaded = await this.storage.readJsonWithBackup(
      projectStoragePaths.migrations.providerContracts,
      parseProviderContractsMigrationDocument
    );
    return loaded?.value ?? emptyMigrationDocument();
  }
}

export interface ProviderConnectionPackageOwnershipV1 {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly templateId: string;
  readonly templateKind: ProviderTemplateKind;
  readonly credentialSchemaId: string;
  readonly credentialSchemaVersion: number;
  readonly credentialVersionId: string;
  readonly connectionPolicyId: string;
  readonly connectionPolicyRevision: number;
  readonly discoveryPolicyId: string;
  readonly discoveryPolicyRevision: number;
  readonly endpointPolicyId: string;
  readonly endpointPolicyRevision: number;
  readonly connectionConfigVersionId: string;
  readonly connectionRevision: number;
  readonly adapterBindings: readonly ProviderConnectionAdapterBinding[];
}

export interface ProviderRegistryOwnershipMappingV1 {
  readonly schemaVersion: 1;
  readonly mappingVersion: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly ownership: ProviderConnectionPackageOwnershipV1;
}

export interface ProviderRegistryMigrationResultV1 {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly changed: boolean;
  readonly migratedConnectionIds: readonly string[];
  readonly unmappedProviderIds: readonly string[];
  readonly unmappedConnectionIds: readonly string[];
}

export function migrateProviderRegistryOwnership(
  snapshot: ProviderRegistrySnapshot,
  mappings: readonly ProviderRegistryOwnershipMappingV1[]
): ProviderRegistryMigrationResultV1 {
  assertUnique(mappings.map((item) => item.connectionId), 'registry migration connection');
  const providers = [...snapshot.providers];
  const connections = [...snapshot.connections];
  const migratedConnectionIds: string[] = [];

  for (const mapping of mappings) {
    requireMappingVersion(mapping.mappingVersion);
    if (mapping.schemaVersion !== 1) {
      throw new TypeError('provider registry ownership mapping schema is invalid');
    }
    const providerIndex = providers.findIndex((item) => item.id === mapping.providerId);
    const connectionIndex = connections.findIndex((item) => item.id === mapping.connectionId);
    if (providerIndex < 0 || connectionIndex < 0) {
      throw new TypeError('provider registry ownership mapping target is missing');
    }
    const provider = providers[providerIndex];
    const connection = connections[connectionIndex];
    if (connection.providerId !== provider.id) {
      throw new TypeError('provider registry ownership mapping crosses providers');
    }
    validateAdapterBindings(snapshot, connection.id, mapping.ownership.adapterBindings);
    const nextProvider = createProvider({
      ...provider,
      packageId: mapping.ownership.packageId,
      packageVersion: mapping.ownership.packageVersion
    });
    const nextConnection = createProviderConnection({
      ...connection,
      ...mapping.ownership
    });
    if (provider.packageId !== undefined && JSON.stringify(provider) !== JSON.stringify(nextProvider)) {
      throw new TypeError('provider package ownership conflicts with existing history');
    }
    if (connection.packageId !== undefined && JSON.stringify(connection) !== JSON.stringify(nextConnection)) {
      throw new TypeError('connection package ownership conflicts with existing history');
    }
    providers[providerIndex] = nextProvider;
    connections[connectionIndex] = nextConnection;
    if (JSON.stringify(connection) !== JSON.stringify(nextConnection)) {
      migratedConnectionIds.push(connection.id);
    }
  }

  const mappedProviders = new Set(mappings.map((item) => item.providerId));
  const mappedConnections = new Set(mappings.map((item) => item.connectionId));
  const nextSnapshot = { ...snapshot, providers, connections };
  return {
    snapshot: nextSnapshot,
    changed: JSON.stringify(snapshot) !== JSON.stringify(nextSnapshot),
    migratedConnectionIds,
    unmappedProviderIds: providers
      .filter((item) => !item.packageId && !mappedProviders.has(item.id))
      .map((item) => item.id),
    unmappedConnectionIds: connections
      .filter((item) => !item.packageId && !mappedConnections.has(item.id))
      .map((item) => item.id)
  };
}

export class ProviderRegistryContractsMigrator {
  constructor(private readonly store: JsonProviderRegistryStore) {}

  async migrate(
    mappings: readonly ProviderRegistryOwnershipMappingV1[]
  ): Promise<ProviderRegistryMigrationResultV1 & { readonly registryRevision: number }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.store.load();
      const result = migrateProviderRegistryOwnership(current, mappings);
      if (!result.changed) {
        return { ...result, registryRevision: current.registryRevision ?? 1 };
      }
      try {
        await this.store.save(result.snapshot);
        const saved = await this.store.load();
        return { ...result, snapshot: saved, registryRevision: saved.registryRevision ?? 1 };
      } catch (error) {
        if (!(error instanceof ProviderRegistryConflictError) || attempt === 3) {
          throw error;
        }
      }
    }
    throw new TypeError('provider registry migration retry limit exceeded');
  }
}

function buildMigrationRun(
  source: ProviderContractsMigrationSourceV1,
  sourceFingerprint: string,
  completedAt: IsoTimestamp
): ProviderContractsMigrationRunV1 {
  const assets = new Map(source.assets.map((asset) => [asset.id, asset]));
  const draftDecisions = [
    ...source.drafts.map((draft) => migrateGenericDraft(draft, assets, source.mappingVersion)),
    ...source.imageWorkspaceDrafts.map((draft) => migrateImageDraft(draft, source.mappingVersion)),
    ...source.videoWorkspaceDrafts.map((draft) => migrateVideoDraft(draft, source.mappingVersion))
  ].sort(compareDraftDecisions);
  const callRecords = source.executions.map((execution) =>
    migrateLegacyCall(source, execution)
  );
  const conversations = source.conversations.map((conversation) => ({
    schemaVersion: 1 as const,
    conversationId: conversation.id,
    projectId: conversation.projectId,
    revision: conversation.revision,
    messageCount: conversation.messages.length,
    disposition: conversation.projectId === null
      ? 'unbound_read_only' as const
      : 'project_owned' as const,
    automaticProjectAssignment: false as const
  }));
  const projectContexts = source.projectContexts.map((context) => ({
    schemaVersion: 1 as const,
    projectContextId: context.id,
    currentRevision: context.currentRevision,
    sourceConversationId: context.versions[0].sourceConversationId,
    disposition: 'preserved_project_context' as const
  }));
  const hasBlocks = draftDecisions.some((item) => item.blockers.length > 0) ||
    callRecords.some((item) => item.recoverability === 'unrecoverable');
  return {
    schemaVersion: 1,
    migrationVersion: providerContractsMigrationVersion,
    projectId: source.projectId,
    mappingVersion: source.mappingVersion,
    sourceFingerprint,
    completedAt,
    status: hasBlocks ? 'completed_with_blocks' : 'completed',
    draftDecisions,
    callRecords,
    conversations,
    projectContexts,
    sourceFactsPreserved: true,
    providerInvocationFactsCreated: 0,
    providerUsageFactsCreated: 0
  };
}

function migrateGenericDraft(
  draft: Draft,
  assets: ReadonlyMap<AssetId, Asset>,
  mappingVersion: string
): LegacyDraftMigrationDecisionV1 {
  const selected = draft.selectedAssetIds.map((id) => assets.get(id));
  const unknownMaterial = selected.some((asset) => !asset);
  const mediaKinds = selected.flatMap((asset) => asset ? [asset.mediaKind] : []);
  let targetProductFeature: ProductFeature | undefined;
  let targetSurface: LegacyDraftMigrationDecisionV1['targetSurface'];
  const blockers: LegacyMigrationBlocker[] = [];
  if (draft.kind === 'video_editing') {
    return draftDecision({
      legacyDraftId: draft.id,
      sourceKind: 'draft',
      preservedAssetIds: draft.selectedAssetIds,
      blockers,
      mappingVersion,
      preserveLocal: true
    });
  }
  if (draft.kind === 'image_generation') {
    if (draft.selectedAssetIds.length === 0) {
      targetProductFeature = 'text_to_image';
      targetSurface = 'quick_image';
    } else if (draft.selectedAssetIds.length === 1 && mediaKinds[0] === 'image') {
      targetProductFeature = 'reference_to_image';
      targetSurface = 'professional_image';
    } else {
      blockers.push(unknownMaterial
        ? 'legacy_material_kind_unknown'
        : 'legacy_multiple_materials_unsupported');
    }
  } else if (draft.kind === 'video_generation') {
    if (draft.selectedAssetIds.length === 0) {
      targetProductFeature = 'text_to_video';
      targetSurface = 'quick_video';
    } else if (draft.selectedAssetIds.length === 1 && mediaKinds[0] === 'image') {
      targetProductFeature = 'image_to_video';
      targetSurface = 'professional_video';
    } else {
      blockers.push(unknownMaterial
        ? 'legacy_material_kind_unknown'
        : mediaKinds.includes('video')
          ? 'legacy_video_reference_unsupported'
          : 'legacy_multiple_materials_unsupported');
    }
  } else {
    targetProductFeature = featureForCreationKind(draft.kind);
    targetSurface = surfaceForFeature(targetProductFeature);
  }
  return draftDecision({
    legacyDraftId: draft.id,
    sourceKind: 'draft',
    targetProductFeature,
    targetSurface,
    preservedAssetIds: draft.selectedAssetIds,
    blockers,
    mappingVersion
  });
}

function migrateImageDraft(
  draft: ImageWorkspaceDraft,
  mappingVersion: string
): LegacyDraftMigrationDecisionV1 {
  const blockers = savedConversationBlockers(draft.contextReferences);
  let feature: ProductFeature;
  let targetSurface: LegacyDraftMigrationDecisionV1['targetSurface'];
  if (draft.mode === 'quick_image' || draft.mode === 'professional_image') {
    feature = draft.input ? 'reference_to_image' : 'text_to_image';
    targetSurface = draft.input ? 'professional_image' : draft.mode;
  } else if (draft.mode === 'image_understanding') {
    feature = 'image_understanding';
    targetSurface = 'image_understanding';
  } else if (draft.mode === 'image_to_prompt') {
    feature = 'image_to_prompt';
    targetSurface = 'image_to_prompt';
  } else {
    feature = 'image_edit';
    targetSurface = 'image_editing';
  }
  const generation = 'generation' in draft ? draft.generation :
    'editing' in draft ? draft.editing : undefined;
  return draftDecision({
    legacyDraftId: draft.id,
    sourceKind: 'image_workspace',
    targetProductFeature: feature,
    targetSurface,
    preservedAssetIds: draft.input ? [draft.input.assetId] : [],
    blockers,
    mappingVersion,
    legacyModelId: generation?.model?.modelId,
    legacyCapabilityEvidenceId:
      generation?.model?.capabilityEvidenceId ?? generation?.parameters?.capabilityEvidenceId,
    clearSavedConversation: blockers.length > 0
  });
}

function migrateVideoDraft(
  draft: VideoWorkspaceDraft,
  mappingVersion: string
): LegacyDraftMigrationDecisionV1 {
  const blockers = savedConversationBlockers(draft.contextReferences);
  let feature: ProductFeature | undefined;
  let targetSurface: LegacyDraftMigrationDecisionV1['targetSurface'];
  let assets: readonly AssetId[] = [];
  if (draft.mode === 'quick_video') {
    if (!draft.quick.reference) {
      feature = 'text_to_video';
      targetSurface = 'quick_video';
    } else if (draft.quick.reference.mediaKind === 'image') {
      feature = 'image_to_video';
      targetSurface = 'professional_video';
      assets = [draft.quick.reference.assetId];
    } else {
      blockers.push('legacy_video_reference_unsupported');
      assets = [draft.quick.reference.assetId];
    }
  } else if (draft.mode === 'text_to_video') {
    feature = 'text_to_video';
    targetSurface = 'professional_video';
    assets = selectedVideoAssets(draft.textToVideo.materials?.slots ?? []);
  } else {
    feature = 'image_to_video';
    targetSurface = 'professional_video';
    assets = [
      ...(draft.imageToVideo.source ? [draft.imageToVideo.source.assetId] : []),
      ...selectedVideoAssets(draft.imageToVideo.materials?.slots ?? [])
    ];
    if (new Set(assets).size !== 1) {
      blockers.push('legacy_multiple_materials_unsupported');
    }
  }
  return draftDecision({
    legacyDraftId: draft.id,
    sourceKind: 'video_workspace',
    targetProductFeature: feature,
    targetSurface,
    preservedAssetIds: [...new Set(assets)],
    blockers: [...new Set(blockers)],
    mappingVersion,
    legacyModelId: draft.generation.model?.modelId,
    legacyCapabilityEvidenceId:
      draft.generation.model?.capabilityEvidenceId ??
      draft.generation.parameters?.capabilityEvidenceId,
    clearSavedConversation: blockers.includes('saved_conversation_requires_project_context')
  });
}

function draftDecision(input: {
  readonly legacyDraftId: string;
  readonly sourceKind: LegacyDraftMigrationDecisionV1['sourceKind'];
  readonly targetProductFeature?: ProductFeature;
  readonly targetSurface?: LegacyDraftMigrationDecisionV1['targetSurface'];
  readonly preservedAssetIds: readonly AssetId[];
  readonly blockers: readonly LegacyMigrationBlocker[];
  readonly mappingVersion: string;
  readonly legacyModelId?: string;
  readonly legacyCapabilityEvidenceId?: string;
  readonly clearSavedConversation?: boolean;
  readonly preserveLocal?: boolean;
}): LegacyDraftMigrationDecisionV1 {
  return {
    schemaVersion: 1,
    legacyDraftId: input.legacyDraftId,
    sourceKind: input.sourceKind,
    disposition: input.blockers.length > 0
      ? 'read_only_blocked'
      : input.preserveLocal
        ? 'preserved_local'
        : 'migrated',
    ...(input.targetProductFeature ? { targetProductFeature: input.targetProductFeature } : {}),
    ...(input.targetSurface ? { targetSurface: input.targetSurface } : {}),
    preservedAssetIds: [...input.preservedAssetIds],
    clearedLegacyFields: input.preserveLocal
      ? []
      : [
          'model',
          'parameters',
          'confirmation',
          ...(input.clearSavedConversation ? ['saved_conversation_context' as const] : [])
        ],
    blockers: [...input.blockers],
    ...(input.legacyModelId ? { legacyModelId: input.legacyModelId } : {}),
    ...(input.legacyCapabilityEvidenceId
      ? { legacyCapabilityEvidenceId: input.legacyCapabilityEvidenceId }
      : {}),
    mappingVersion: input.mappingVersion,
    requiresUserConfirmation: true
  };
}

function migrateLegacyCall(
  source: ProviderContractsMigrationSourceV1,
  execution: Execution
): LegacyCallReadModelV1 {
  const task = source.tasks.find((item) => item.id === execution.taskId);
  if (!task) throw new TypeError(`legacy execution ${execution.id} has no task`);
  const receipt = source.providerOperations.find(
    (item) => item.executionId === execution.id
  );
  const route = source.legacyRouteMappings.find(
    (item) => item.executionId === execution.id
  );
  const isAsync = receipt?.executionLifecycle === 'asynchronous_polling' ||
    receipt?.outcome.kind === 'accepted_async';
  const routeState = route
    ? 'mapped' as const
    : isAsync
      ? 'legacy_route_unavailable' as const
      : 'not_applicable' as const;
  return {
    schemaVersion: 1,
    taskId: task.id,
    executionId: execution.id,
    ...(receipt ? { providerOperationRecordId: receipt.id } : {}),
    workIds: source.works
      .filter((work) => work.sourceExecutionId === execution.id)
      .map((work) => work.id),
    state: execution.state,
    routeState,
    ...(route ? { routeSnapshotId: requireOpaqueId(route.routeSnapshotId, 'route snapshot ID') } : {}),
    recoverability: routeState === 'legacy_route_unavailable' ? 'unrecoverable' : 'read_only',
    ...(routeState === 'legacy_route_unavailable'
      ? { safeReason: 'legacy_route_unavailable' as const }
      : {}),
    usageAvailability: 'not_collected_legacy',
    invocationFacts: 'not_fabricated',
    providerReceipt: receipt ? 'legacy_redacted' : 'absent'
  };
}

function normalizeSource(
  source: ProviderContractsMigrationSourceV1
): ProviderContractsMigrationSourceV1 {
  if (source.schemaVersion !== 1) {
    throw new TypeError('provider contracts migration source schema is invalid');
  }
  requireMappingVersion(source.mappingVersion);
  const projectCollections = [
    source.assets,
    source.drafts,
    source.imageWorkspaceDrafts,
    source.videoWorkspaceDrafts,
    source.tasks,
    source.works,
    source.projectContexts
  ];
  for (const collection of projectCollections) {
    for (const item of collection) {
      if ('projectId' in item && item.projectId !== source.projectId) {
        throw new TypeError('provider contracts migration source crosses projects');
      }
    }
  }
  for (const conversation of source.conversations) {
    if (conversation.projectId !== null && conversation.projectId !== source.projectId) {
      throw new TypeError('provider contracts migration conversation crosses projects');
    }
  }
  assertUnique(source.assets.map((item) => item.id), 'legacy asset');
  assertUnique([
    ...source.drafts.map((item) => item.id),
    ...source.imageWorkspaceDrafts.map((item) => item.id),
    ...source.videoWorkspaceDrafts.map((item) => item.id)
  ], 'legacy draft');
  assertUnique(source.tasks.map((item) => item.id), 'legacy task');
  assertUnique(source.executions.map((item) => item.id), 'legacy execution');
  assertUnique(source.providerOperations.map((item) => item.id), 'legacy provider operation');
  assertUnique(source.works.map((item) => item.id), 'legacy work');
  assertUnique(source.conversations.map((item) => item.id), 'legacy conversation');
  assertUnique(source.projectContexts.map((item) => item.id), 'legacy project context');
  assertUnique(source.legacyRouteMappings.map((item) => item.executionId), 'legacy route mapping');
  source.legacyRouteMappings.forEach((item) => requireMappingVersion(item.mappingVersion));
  return {
    ...source,
    assets: sortById(source.assets),
    drafts: sortById(source.drafts),
    imageWorkspaceDrafts: sortById(source.imageWorkspaceDrafts),
    videoWorkspaceDrafts: sortById(source.videoWorkspaceDrafts),
    tasks: sortById(source.tasks),
    executions: sortById(source.executions),
    providerOperations: sortById(source.providerOperations),
    works: sortById(source.works),
    conversations: sortById(source.conversations),
    projectContexts: sortById(source.projectContexts),
    legacyRouteMappings: [...source.legacyRouteMappings].sort((a, b) =>
      a.executionId.localeCompare(b.executionId)
    )
  };
}

export function parseProviderContractsMigrationDocument(
  value: unknown
): ProviderContractsMigrationDocumentV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.runs)) {
    throw new TypeError('provider contracts migration document is invalid');
  }
  const runs = value.runs as ProviderContractsMigrationRunV1[];
  for (const run of runs) {
    if (!isRecord(run) || run.schemaVersion !== 1 ||
      run.migrationVersion !== providerContractsMigrationVersion ||
      !/^[a-f0-9]{64}$/.test(String(run.sourceFingerprint)) ||
      !['completed', 'completed_with_blocks'].includes(String(run.status)) ||
      !Array.isArray(run.draftDecisions) || !Array.isArray(run.callRecords) ||
      !Array.isArray(run.conversations) || !Array.isArray(run.projectContexts) ||
      run.sourceFactsPreserved !== true || run.providerInvocationFactsCreated !== 0 ||
      run.providerUsageFactsCreated !== 0) {
      throw new TypeError('provider contracts migration run is invalid');
    }
    toIsoTimestamp(String(run.completedAt));
    requireMappingVersion(String(run.mappingVersion));
  }
  assertUnique(runs.map((run) => run.sourceFingerprint), 'migration source fingerprint');
  return {
    schemaVersion: 1,
    revision: Number(value.revision),
    runs: structuredClone(runs)
  };
}

function emptyMigrationDocument(): ProviderContractsMigrationDocumentV1 {
  return { schemaVersion: 1, revision: 0, runs: [] };
}

function fingerprint(source: ProviderContractsMigrationSourceV1): string {
  return createHash('sha256').update(canonicalJson(source)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function featureForCreationKind(kind: Draft['kind']): ProductFeature {
  switch (kind) {
    case 'image_analysis': return 'image_understanding';
    case 'image_editing': return 'image_edit';
    case 'image_to_prompt': return 'image_to_prompt';
    case 'image_generation': return 'text_to_image';
    case 'video_generation': return 'text_to_video';
    case 'video_editing': throw new TypeError('local video editing has no provider feature');
  }
}

function surfaceForFeature(
  feature: ProductFeature
): LegacyDraftMigrationDecisionV1['targetSurface'] {
  if (feature === 'image_understanding') return 'image_understanding';
  if (feature === 'image_to_prompt') return 'image_to_prompt';
  if (feature === 'image_edit') return 'image_editing';
  if (feature === 'text_to_image') return 'quick_image';
  if (feature === 'reference_to_image') return 'professional_image';
  if (feature === 'text_to_video') return 'quick_video';
  if (feature === 'image_to_video') return 'professional_video';
  throw new TypeError(`unsupported legacy draft product feature ${feature}`);
}

function savedConversationBlockers(
  references: readonly { readonly kind: string }[]
): LegacyMigrationBlocker[] {
  return references.some((item) => item.kind === 'saved_conversation')
    ? ['saved_conversation_requires_project_context']
    : [];
}

function selectedVideoAssets(
  slots: readonly { readonly selection?: { readonly assetId: AssetId } }[]
): readonly AssetId[] {
  return slots.flatMap((slot) => slot.selection ? [slot.selection.assetId] : []);
}

function validateAdapterBindings(
  snapshot: ProviderRegistrySnapshot,
  connectionId: string,
  adapterBindings: readonly ProviderConnectionAdapterBinding[]
): void {
  if (adapterBindings.length === 0) {
    throw new TypeError('provider registry ownership mapping requires an adapter binding');
  }
  for (const adapter of adapterBindings) {
    const bindings = snapshot.protocolBindings.filter((candidate) =>
      candidate.connectionId === connectionId &&
      candidate.protocolId === adapter.protocolId &&
      candidate.protocolVersion === adapter.protocolVersion &&
      candidate.adapterKind === adapter.adapterId
    );
    if (bindings.length !== 1) {
      throw new TypeError('provider registry ownership mapping cannot guess a protocol binding');
    }
  }
}

function requireMappingVersion(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError('migration mapping version is invalid');
  }
  return value;
}

function requireOpaqueId(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sortById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function compareDraftDecisions(
  left: LegacyDraftMigrationDecisionV1,
  right: LegacyDraftMigrationDecisionV1
): number {
  return left.legacyDraftId.localeCompare(right.legacyDraftId) ||
    left.sourceKind.localeCompare(right.sourceKind);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} identities must be unique`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
