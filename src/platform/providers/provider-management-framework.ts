import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProviderId,
  type CredentialSchema,
  type IsoTimestamp,
  type ModelFeatureProfile,
  type ProviderAdapterDescriptor,
  type ProviderConnection,
  type ProviderModel,
  type ProviderModelDefinition,
  type ProviderProtocolBinding,
  type SafeProviderTemplateDto,
  type StructuredCredentialRecord
} from '../../domain';
import { sharedFileWriteCoordinator } from '../storage';
import type { SecureCredentialVault } from './credential-vault';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_PROTOCOL_ID,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  deepSeekModelDefinitions
} from './deepseek/deepseek-contracts';
import {
  createOpenAiCompatibleDefaultTextDefinition,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID
} from './newapi/newapi-contracts';
import { isOpenAiCompatiblePackageId } from './newapi/openai-compatible-identity';
import {
  ProviderConnectionContractService,
  type ProviderConnectionContractResult
} from './provider-connection-contract-service';
import {
  ProviderPackageContractError,
  type ProviderPackageRegistry,
  type ResolvedProviderTemplate
} from './provider-package-registry';
import type {
  JsonProviderRegistryStore,
  ProviderRegistrySnapshot
} from './provider-registry';

export const providerManagementActions = [
  'connection_created',
  'credential_rotated',
  'connection_validated',
  'catalog_synced',
  'model_registered_exact',
  'connection_enabled',
  'connection_disabled',
  'model_enabled',
  'model_disabled',
  'model_deleted',
  'connection_deleted'
] as const;
export type ProviderManagementAction = (typeof providerManagementActions)[number];

export interface ProviderManagementAuditEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly action: ProviderManagementAction;
  readonly outcome: 'succeeded' | 'denied' | 'failed';
  readonly providerId?: string;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly safeCode?: string;
  readonly count?: number;
  readonly occurredAt: IsoTimestamp;
}

interface ProviderManagementAuditDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly events: readonly ProviderManagementAuditEventV1[];
}

export interface ProviderManagementAuditStore {
  append(
    event: Omit<ProviderManagementAuditEventV1, 'schemaVersion' | 'sequence'>
  ): Promise<ProviderManagementAuditEventV1>;
  list(): Promise<readonly ProviderManagementAuditEventV1[]>;
}

export class JsonProviderManagementAuditStore
  implements ProviderManagementAuditStore {
  private readonly backupPath: string;

  constructor(private readonly auditPath: string) {
    this.backupPath = `${auditPath}.bak`;
  }

  async append(
    event: Omit<ProviderManagementAuditEventV1, 'schemaVersion' | 'sequence'>
  ): Promise<ProviderManagementAuditEventV1> {
    return sharedFileWriteCoordinator.runExclusive(this.auditPath, async () => {
      const current = await this.loadDocument();
      const created = parseAuditEvent({
        ...event,
        schemaVersion: 1,
        sequence: current.events.length + 1
      });
      const next = {
        schemaVersion: 1 as const,
        revision: current.revision + 1,
        events: [...current.events, created]
      };
      if (current.revision > 0) {
        await writeJsonAtomically(this.backupPath, current);
      }
      await writeJsonAtomically(this.auditPath, next);
      return created;
    });
  }

  async list(): Promise<readonly ProviderManagementAuditEventV1[]> {
    return (await this.loadDocument()).events;
  }

  private async loadDocument(): Promise<ProviderManagementAuditDocumentV1> {
    try {
      return parseAuditDocument(JSON.parse(await readFile(this.auditPath, 'utf8')));
    } catch (primaryError) {
      try {
        return parseAuditDocument(JSON.parse(await readFile(this.backupPath, 'utf8')));
      } catch (backupError) {
        if (isMissing(primaryError) && isMissing(backupError)) {
          return { schemaVersion: 1, revision: 0, events: [] };
        }
        throw new ProviderManagementFrameworkError(
          'audit_store_unavailable',
          'Provider management audit is unavailable'
        );
      }
    }
  }
}

export interface ProviderManagementAdapterIdentityV1 {
  readonly packageId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
}

export interface ProviderConnectionValidationResultV1 {
  readonly state: 'available' | 'unavailable';
  readonly identityState: 'verified' | 'verification_failed';
  readonly credentialState: 'valid' | 'invalid' | 'verification_unavailable';
  readonly observedAt: IsoTimestamp;
  readonly safeCode?: string;
}

export interface ProviderCatalogEntryV1 {
  readonly providerModelKey: string;
  readonly displayName: string;
}

export type ProviderAddConnectionStep = 'validating' | 'saving' | 'syncing';

export type ProviderAddConnectionProgress = (
  step: ProviderAddConnectionStep
) => void;

export interface ProviderManagementAdapterPort {
  readonly identity: ProviderManagementAdapterIdentityV1;
  validateConnection?(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<ProviderConnectionValidationResultV1>;
  discoverModels?(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<{
    readonly entries: readonly ProviderCatalogEntryV1[];
    readonly observedAt: IsoTimestamp;
  }>;
}

export interface ProviderManagementTemplateDto extends SafeProviderTemplateDto {
  readonly validationAction: 'available' | 'requires_live_api_approval' | 'unsupported';
  readonly modelDiscoveryAction:
    | 'catalog_available'
    | 'requires_live_api_approval'
    | 'manual_exact'
    | 'unsupported';
}

export class ProviderManagementAdapterRegistry {
  private readonly ports: ReadonlyMap<string, ProviderManagementAdapterPort>;

  constructor(
    private readonly packages: ProviderPackageRegistry,
    ports: readonly ProviderManagementAdapterPort[]
  ) {
    const entries = ports.map((port) => {
      const descriptor = packages.resolveAdapter(
        port.identity.packageId,
        port.identity.adapterId,
        port.identity.adapterVersion,
        port.identity.protocolId,
        port.identity.protocolVersion
      );
      return [adapterKey(port.identity), { port, descriptor }] as const;
    });
    assertUnique(entries.map(([key]) => key), 'provider management adapter');
    this.ports = new Map(entries.map(([key, value]) => [key, value.port]));
  }

  resolve(
    connection: ProviderConnection,
    template: ResolvedProviderTemplate,
    operation: 'validate_connection' | 'discover_models'
  ): { readonly port: ProviderManagementAdapterPort; readonly descriptor: ProviderAdapterDescriptor } {
    const matches = template.adapters.filter((descriptor) =>
      descriptor.operations.includes(operation) &&
      connection.adapterBindings?.some((binding) =>
        binding.adapterId === descriptor.adapterId &&
        binding.adapterVersion === descriptor.adapterVersion &&
        binding.protocolId === descriptor.protocolId &&
        binding.protocolVersion === descriptor.protocolVersion
      )
    );
    if (matches.length === 0) {
      throw new ProviderManagementFrameworkError(
        'operation_unavailable',
        'The provider package does not support this management operation'
      );
    }
    if (matches.length !== 1) {
      throw new ProviderManagementFrameworkError(
        'adapter_binding_ambiguous',
        'The provider management adapter binding is ambiguous'
      );
    }
    const descriptor = matches[0];
    const port = this.ports.get(adapterKey({
      packageId: template.package.packageId,
      adapterId: descriptor.adapterId,
      adapterVersion: descriptor.adapterVersion,
      protocolId: descriptor.protocolId,
      protocolVersion: descriptor.protocolVersion
    }));
    if (!port ||
      (operation === 'validate_connection' && !port.validateConnection) ||
      (operation === 'discover_models' && !port.discoverModels)) {
      throw new ProviderManagementFrameworkError(
        'adapter_unavailable',
        'The exact provider management adapter is not installed'
      );
    }
    return { port, descriptor };
  }

  resolveSingleCatalogBinding(
    connection: ProviderConnection,
    template: ResolvedProviderTemplate
  ): ProviderAdapterDescriptor {
    const bindings = connection.adapterBindings ?? [];
    const matches = template.adapters.filter((descriptor) =>
      bindings.some((binding) =>
        binding.adapterId === descriptor.adapterId &&
        binding.adapterVersion === descriptor.adapterVersion &&
        binding.protocolId === descriptor.protocolId &&
        binding.protocolVersion === descriptor.protocolVersion
      )
    );
    if (matches.length === 0) {
      throw new ProviderManagementFrameworkError(
        'operation_unavailable',
        'The provider package does not support manual model registration'
      );
    }
    if (matches.length === 1) return matches[0];
    // Multi-adapter packages (chat/image/video) should register models against
    // the catalog/management adapter, not require a single binding overall.
    const discoverers = matches.filter((descriptor) =>
      descriptor.operations.includes('discover_models')
    );
    if (discoverers.length === 1) return discoverers[0];
    const validators = matches.filter((descriptor) =>
      descriptor.operations.includes('validate_connection')
    );
    if (validators.length === 1) return validators[0];
    throw new ProviderManagementFrameworkError(
      'adapter_binding_ambiguous',
      'An exact single adapter binding is required for manual model registration'
    );
  }

  supports(
    template: ResolvedProviderTemplate,
    operation: 'validate_connection' | 'discover_models'
  ): boolean {
    return template.adapters.some((descriptor) => {
      if (!descriptor.operations.includes(operation)) return false;
      const port = this.ports.get(adapterKey({
        packageId: template.package.packageId,
        adapterId: descriptor.adapterId,
        adapterVersion: descriptor.adapterVersion,
        protocolId: descriptor.protocolId,
        protocolVersion: descriptor.protocolVersion
      }));
      return operation === 'validate_connection'
        ? Boolean(port?.validateConnection)
        : Boolean(port?.discoverModels);
    });
  }
}

export interface ProviderCredentialRetentionPort {
  hasActiveReference(credentialVersionId: string): Promise<boolean>;
  listActiveCredentialVersions(connectionId: string): Promise<readonly string[]>;
  markCredentialUnavailable(input: {
    readonly connectionId: string;
    readonly credentialVersionIds: readonly string[];
    readonly occurredAt: IsoTimestamp;
  }): Promise<void>;
}

const noActiveCredentials: ProviderCredentialRetentionPort = {
  async hasActiveReference() { return false; },
  async listActiveCredentialVersions() { return []; },
  async markCredentialUnavailable() {}
};

export type ProviderManagementFrameworkErrorCode =
  | 'invalid_request'
  | 'package_not_found'
  | 'template_not_found'
  | 'connection_not_found'
  | 'model_not_found'
  | 'connection_contract_stale'
  | 'credential_unavailable'
  | 'credential_invalid'
  | 'connection_validation_failed'
  | 'free_validation_unavailable'
  | 'operation_unavailable'
  | 'adapter_unavailable'
  | 'adapter_binding_ambiguous'
  | 'connection_not_available'
  | 'catalog_sync_unavailable'
  | 'manual_registration_unavailable'
  | 'model_already_exists'
  | 'model_not_routable'
  | 'active_operations_present'
  | 'provider_registry_conflict'
  | 'audit_store_unavailable'
  | 'provider_management_failed';

export class ProviderManagementFrameworkError extends Error {
  constructor(
    readonly code: ProviderManagementFrameworkErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProviderManagementFrameworkError';
  }
}

export type ProviderManagementFrameworkResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ProviderManagementFrameworkErrorCode;
        readonly message: string;
      };
    };

export interface ProviderRuntimeAuthorizationSyncPort {
  syncConnectionPolicy(input: {
    readonly providerPackageId: string;
    readonly connectionId: string;
    readonly allowed: boolean;
  }): Promise<void>;
}

export interface ProviderManagementFrameworkOptions {
  readonly now?: () => IsoTimestamp;
  readonly credentialRetention?: ProviderCredentialRetentionPort;
  readonly connectionService?: ProviderConnectionContractService;
  readonly runtimeAuthorization?: ProviderRuntimeAuthorizationSyncPort;
}

export class ProviderManagementFramework {
  private readonly now: () => IsoTimestamp;
  private readonly credentialRetention: ProviderCredentialRetentionPort;
  private readonly connectionService: ProviderConnectionContractService;
  private readonly runtimeAuthorization?: ProviderRuntimeAuthorizationSyncPort;

  constructor(
    private readonly packages: ProviderPackageRegistry,
    private readonly registry: JsonProviderRegistryStore,
    private readonly vault: SecureCredentialVault,
    private readonly adapters: ProviderManagementAdapterRegistry,
    private readonly audit: ProviderManagementAuditStore,
    options: ProviderManagementFrameworkOptions = {}
  ) {
    this.now = options.now ?? (() => toIsoTimestamp(new Date().toISOString()));
    this.credentialRetention = options.credentialRetention ?? noActiveCredentials;
    this.connectionService = options.connectionService ??
      new ProviderConnectionContractService(packages, registry, vault);
    this.runtimeAuthorization = options.runtimeAuthorization;
  }

  private async syncRuntimePolicy(connectionId: string): Promise<void> {
    if (!this.runtimeAuthorization) return;
    const snapshot = await this.registry.load();
    const connection = snapshot.connections.find(
      (candidate) => candidate.id === connectionId
    );
    if (!connection?.packageId) return;
    await this.runtimeAuthorization.syncConnectionPolicy({
      providerPackageId: connection.packageId,
      connectionId: connection.id,
      allowed: connection.state === 'available'
    }).catch(() => undefined);
  }

  listTemplates(): readonly ProviderManagementTemplateDto[] {
    return this.packages.listSafeTemplates().map((template) => {
      const resolved = this.packages.resolveTemplate(
        template.packageId,
        template.templateId
      );
      const validationInstalled = this.adapters.supports(
        resolved,
        'validate_connection'
      );
      const discoveryInstalled = this.adapters.supports(
        resolved,
        'discover_models'
      );
      return {
        ...template,
        validationAction: !template.freeConnectionValidation
          ? 'unsupported'
          : validationInstalled
            ? 'available'
            : 'requires_live_api_approval',
        modelDiscoveryAction: template.modelDiscoveryKind === 'manual_exact'
          ? 'manual_exact'
          : template.modelDiscoveryKind === 'none'
            ? 'unsupported'
            : discoveryInstalled
              ? 'catalog_available'
              : 'requires_live_api_approval'
      };
    });
  }

  async createConnection(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly providerId: string;
    readonly connectionId: string;
    readonly state: 'saved';
  }>> {
    try {
      parseCreateConnectionRequest(input);
      const saved = await this.persistConnection(input);
      if (!saved.ok) return saved;
      return { ok: true, value: { ...saved.value, state: 'saved' as const } };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async addConnection(input: unknown, progress?: ProviderAddConnectionProgress): Promise<
    ProviderManagementFrameworkResult<{
      readonly providerId: string;
      readonly connectionId: string;
      readonly state: 'available' | 'unavailable' | 'saved';
      readonly validated: boolean;
      readonly catalog: 'synced' | 'skipped' | 'failed';
      readonly catalogCount?: number;
      readonly catalogWarning?: string;
    }>
  > {
    try {
      const request = parseAddConnectionRequest(input);
      const resolved = this.packages.resolveTemplate(
        request.packageId,
        request.templateId
      );
      const probeAvailable = resolved.template.freeConnectionValidation &&
        this.adapters.supports(resolved, 'validate_connection');
      if (!probeAvailable) {
        throw new ProviderManagementFrameworkError(
          'free_validation_unavailable',
          'This provider template has no approved free validation operation for save-time probing'
        );
      }
      const endpoint = this.packages.resolveEndpoint(
        resolved,
        request.endpoint,
        request.explicitLoopbackHttpConsent
      );
      const credentials = validateCredentialRecord(
        resolved.credentialSchema,
        request.credentials
      );
      const draft = this.createDraftConnection(resolved, endpoint);
      const adapter = this.adapters.resolve(draft, resolved, 'validate_connection');
      progress?.('validating');
      const parsed = parseValidationObservation(await adapter.port.validateConnection!({
        connection: draft,
        endpoint,
        credentials
      }));
      if (parsed.state === 'unavailable' && !request.allowUnavailableSave) {
        await this.record({
          action: 'connection_validated',
          outcome: 'failed',
          safeCode: parsed.safeCode ?? parsed.state
        }, parsed.observedAt);
        return {
          ok: false,
          error: {
            code: 'connection_validation_failed',
            message: parsed.safeCode ?? 'unavailable'
          }
        };
      }
      progress?.('saving');
      const saved = await this.persistConnection(request.save);
      if (!saved.ok) return saved;
      await this.applyValidationObservation(
        saved.value.connectionId,
        saved.value.providerId,
        parsed
      );
      await this.syncRuntimePolicy(saved.value.connectionId);
      let catalog: 'synced' | 'skipped' | 'failed' = 'skipped';
      let catalogCount: number | undefined;
      let catalogWarning: string | undefined;
      if (
        parsed.state === 'available' &&
        resolved.template.modelDiscoveryKind === 'catalog'
      ) {
        progress?.('syncing');
        const synced = await this.syncModelCatalog({
          connectionId: saved.value.connectionId
        });
        if (synced.ok) {
          catalog = 'synced';
          catalogCount = synced.value.count;
        } else {
          catalog = 'failed';
          catalogWarning = synced.error.code;
        }
      }
      return {
        ok: true,
        value: {
          ...saved.value,
          state: parsed.state,
          validated: true,
          catalog,
          ...(catalogCount === undefined ? {} : { catalogCount }),
          ...(catalogWarning === undefined ? {} : { catalogWarning })
        }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  private async persistConnection(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly providerId: string;
    readonly connectionId: string;
  }>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.connectionService.saveConnection(input);
      if (result.ok) {
        await this.record({
          action: 'connection_created',
          outcome: 'succeeded',
          providerId: result.value.providerId,
          connectionId: result.value.connectionId
        });
        return {
          ok: true,
          value: {
            providerId: result.value.providerId,
            connectionId: result.value.connectionId
          }
        };
      }
      if (result.error.code !== 'connection_save_failed' || attempt === 2) {
        await this.record({
          action: 'connection_created',
          outcome: result.error.code === 'invalid_request' ? 'denied' : 'failed',
          safeCode: result.error.code
        });
        return frameworkFailure(mapConnectionError(result));
      }
    }
    return frameworkFailureCode('provider_management_failed');
  }

  private async applyValidationObservation(
    connectionId: string,
    providerId: string,
    parsed: ProviderConnectionValidationResultV1
  ): Promise<void> {
    const snapshot = await this.registry.load();
    const owned = resolveOwnedConnection(snapshot, this.packages, connectionId);
    await this.registry.mutate((latest) => {
      const current = requireUnchangedConnection(latest, owned.connection, this.packages);
      return {
        snapshot: {
          ...latest,
          connections: latest.connections.map((connection) =>
            connection.id === current.id
              ? {
                  ...connection,
                  state: parsed.state,
                  identityState: parsed.identityState,
                  credentialState: parsed.credentialState,
                  lastConnectionValidationAt: parsed.observedAt,
                  updatedAt: parsed.observedAt
                }
              : connection
          )
        },
        result: undefined
      };
    });
    await this.record({
      action: 'connection_validated',
      outcome: 'succeeded',
      providerId,
      connectionId,
      safeCode: parsed.safeCode ?? parsed.state
    }, parsed.observedAt);
  }

  private createDraftConnection(
    resolved: ResolvedProviderTemplate,
    endpoint: string | undefined
  ): ProviderConnection {
    const now = this.now();
    return createProviderConnection({
      id: toConnectionId(`connection-draft-${randomUUID()}`),
      providerId: toProviderId(`provider-draft-${randomUUID()}`),
      name: 'draft-connection',
      endpoint,
      packageId: resolved.package.packageId,
      packageVersion: resolved.package.packageVersion,
      templateId: resolved.template.templateId,
      templateKind: resolved.template.kind,
      credentialSchemaId: resolved.credentialSchema.schemaId,
      credentialSchemaVersion: resolved.credentialSchema.version,
      credentialVersionId: `credential-version-draft-${randomUUID()}`,
      connectionPolicyId: resolved.template.connectionPolicyId,
      connectionPolicyRevision: resolved.template.connectionPolicyRevision,
      discoveryPolicyId: resolved.template.discoveryPolicyId,
      discoveryPolicyRevision: resolved.template.discoveryPolicyRevision,
      endpointPolicyId: resolved.endpointPolicy.policyId,
      endpointPolicyRevision: resolved.endpointPolicy.revision,
      connectionConfigVersionId: `connection-config-draft-${randomUUID()}`,
      connectionRevision: 1,
      adapterBindings: resolved.adapters.map((adapter) => ({
        adapterId: adapter.adapterId,
        adapterVersion: adapter.adapterVersion,
        protocolId: adapter.protocolId,
        protocolVersion: adapter.protocolVersion
      })),
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved',
      createdAt: now,
      updatedAt: now
    });
  }

  async rotateCredential(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly connectionId: string;
    readonly credentialVersionId: string;
    readonly previousCredential: 'removed' | 'retained_for_active_operations' | 'absent';
  }>> {
    let newReference: string | undefined;
    try {
      const request = parseRotateCredentialRequest(input);
      const snapshot = await this.registry.load();
      const resolved = resolveOwnedConnection(snapshot, this.packages, request.connectionId);
      const credential = validateCredentialRecord(
        resolved.template.credentialSchema,
        request.credentials
      );
      const previousReference = resolved.connection.credentialReference;
      const previousVersion = resolved.connection.credentialVersionId;
      newReference = `credential-${randomUUID()}`;
      const credentialVersionId = `credential-version-${randomUUID()}`;
      await this.vault.saveRecord(newReference, credential);
      const now = this.now();
      await this.registry.mutate((latest) => {
        const current = resolveOwnedConnection(
          latest,
          this.packages,
          request.connectionId
        ).connection;
        if (
          current.connectionRevision !== resolved.connection.connectionRevision ||
          current.credentialVersionId !== resolved.connection.credentialVersionId
        ) {
          throw new ProviderManagementFrameworkError(
            'provider_registry_conflict',
            'The provider connection changed during credential rotation'
          );
        }
        return {
          snapshot: {
            ...latest,
            connections: latest.connections.map((connection) =>
              connection.id === current.id
                ? {
                    ...connection,
                    credentialReference: newReference,
                    credentialVersionId,
                    credentialState: 'saved' as const,
                    state: connection.state === 'disabled' ? 'disabled' as const : 'saved' as const,
                    identityState: 'unverified' as const,
                    lastConnectionValidationAt: undefined,
                    connectionRevision: (connection.connectionRevision ?? 0) + 1,
                    updatedAt: now
                  }
                : connection
            )
          },
          result: undefined
        };
      });
      newReference = undefined;
      let previousCredential: 'removed' | 'retained_for_active_operations' | 'absent' = 'absent';
      if (previousReference && previousVersion) {
        if (await this.credentialRetention.hasActiveReference(previousVersion)) {
          previousCredential = 'retained_for_active_operations';
        } else {
          await this.vault.remove(previousReference);
          previousCredential = 'removed';
        }
      }
      await this.record({
        action: 'credential_rotated',
        outcome: 'succeeded',
        providerId: resolved.connection.providerId,
        connectionId: resolved.connection.id,
        safeCode: previousCredential
      });
      return {
        ok: true,
        value: {
          connectionId: resolved.connection.id,
          credentialVersionId,
          previousCredential
        }
      };
    } catch (error) {
      if (newReference) await this.vault.remove(newReference).catch(() => false);
      return frameworkFailure(error);
    }
  }

  async validateConnection(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly connectionId: string;
    readonly state: ProviderConnectionValidationResultV1['state'];
    readonly observedAt: IsoTimestamp;
  }>> {
    try {
      const connectionId = parseIdRequest(input, 'connectionId');
      const snapshot = await this.registry.load();
      const resolved = resolveOwnedConnection(snapshot, this.packages, connectionId);
      if (!resolved.template.template.freeConnectionValidation) {
        throw new ProviderManagementFrameworkError(
          'free_validation_unavailable',
          'This provider template has no approved free validation operation'
        );
      }
      const adapter = this.adapters.resolve(
        resolved.connection,
        resolved.template,
        'validate_connection'
      );
      const observation = await useStructuredCredential(
        this.vault,
        resolved.connection,
        resolved.template.credentialSchema,
        (credentials) => adapter.port.validateConnection!({
          connection: resolved.connection,
          endpoint: resolved.connection.endpoint,
          credentials
        })
      );
      const parsed = parseValidationObservation(observation);
      await this.registry.mutate((latest) => {
        const current = requireUnchangedConnection(
          latest,
          resolved.connection,
          this.packages
        );
        return {
          snapshot: {
            ...latest,
            connections: latest.connections.map((connection) =>
              connection.id === current.id
                ? {
                    ...connection,
                    state: parsed.state,
                    identityState: parsed.identityState,
                    credentialState: parsed.credentialState,
                    lastConnectionValidationAt: parsed.observedAt,
                    updatedAt: parsed.observedAt
                  }
                : connection
            )
          },
          result: undefined
        };
      });
      await this.record({
        action: 'connection_validated',
        outcome: 'succeeded',
        providerId: resolved.connection.providerId,
        connectionId,
        safeCode: parsed.safeCode ?? parsed.state
      }, parsed.observedAt);
      await this.syncRuntimePolicy(connectionId);
      return {
        ok: true,
        value: { connectionId, state: parsed.state, observedAt: parsed.observedAt }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async syncModelCatalog(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly connectionId: string;
    readonly count: number;
    readonly catalogRevision: number;
    readonly observedAt: IsoTimestamp;
  }>> {
    try {
      const connectionId = parseIdRequest(input, 'connectionId');
      const snapshot = await this.registry.load();
      const resolved = resolveOwnedConnection(snapshot, this.packages, connectionId);
      if (resolved.template.template.modelDiscoveryKind !== 'catalog') {
        throw new ProviderManagementFrameworkError(
          'catalog_sync_unavailable',
          'This provider template does not publish a model catalog operation'
        );
      }
      requireAvailableConnection(resolved.connection);
      const adapter = this.adapters.resolve(
        resolved.connection,
        resolved.template,
        'discover_models'
      );
      const result = await useStructuredCredential(
        this.vault,
        resolved.connection,
        resolved.template.credentialSchema,
        (credentials) => adapter.port.discoverModels!({
          connection: resolved.connection,
          endpoint: resolved.connection.endpoint,
          credentials
        })
      );
      const observedAt = toIsoTimestamp(result.observedAt);
      const entries = parseCatalogEntries(result.entries);
      const mutation = await this.registry.mutate((latest) => {
        const current = requireUnchangedConnection(
          latest,
          resolved.connection,
          this.packages
        );
        const binding = ensureCatalogBinding(
          latest,
          current,
          adapter.descriptor,
          observedAt
        );
        const catalogRevision = nextCatalogRevision(latest.models, current.id);
        const nextModels = mergeCatalogModels(
          latest.models,
          current,
          binding.binding,
          entries,
          catalogRevision,
          observedAt
        );
        const unavailableModelIds = new Set(
          nextModels
            .filter((model) =>
              model.connectionId === current.id &&
              model.catalogState !== 'present'
            )
            .map((model) => model.id)
        );
        return {
          snapshot: {
            ...latest,
            protocolBindings: binding.protocolBindings,
            models: nextModels,
            routingPreferences: latest.routingPreferences.map((preference) =>
              unavailableModelIds.has(preference.modelId) && preference.enabled
                ? { ...preference, enabled: false, updatedAt: observedAt }
                : preference
            )
          },
          result: { count: entries.length, catalogRevision }
        };
      });
      await this.record({
        action: 'catalog_synced',
        outcome: 'succeeded',
        providerId: resolved.connection.providerId,
        connectionId,
        count: mutation.count
      }, observedAt);
      return {
        ok: true,
        value: { connectionId, ...mutation, observedAt }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async registerExactModel(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly connectionId: string;
    readonly modelId: string;
    readonly state: 'registered_without_profile';
  }>> {
    try {
      const request = parseRegisterModelRequest(input);
      const model = await this.registry.mutate((snapshot) => {
        const resolved = resolveOwnedConnection(
          snapshot,
          this.packages,
          request.connectionId
        );
        requireAvailableConnection(resolved.connection);
        if (snapshot.models.some((candidate) =>
          candidate.connectionId === resolved.connection.id &&
          candidate.providerModelKey === request.providerModelKey
        )) {
          throw new ProviderManagementFrameworkError(
            'model_already_exists',
            'The exact provider model key is already registered'
          );
        }
        const descriptor = this.adapters.resolveSingleCatalogBinding(
          resolved.connection,
          resolved.template
        );
        const now = this.now();
        const binding = ensureCatalogBinding(
          snapshot,
          resolved.connection,
          descriptor,
          now
        );
        const created = createProviderModel({
          id: toModelId(`model-${randomUUID()}`),
          providerId: resolved.connection.providerId,
          connectionId: resolved.connection.id,
          protocolBindingId: binding.binding.id,
          providerModelKey: request.providerModelKey,
          mediaKind: 'unknown',
          revision: 1,
          catalogState: 'present',
          catalogRevision: nextCatalogRevision(snapshot.models, resolved.connection.id),
          lastSeenAt: now,
          displayName: request.displayName,
          enabled: false,
          createdAt: now,
          updatedAt: now
        });
        return {
          snapshot: {
            ...snapshot,
            protocolBindings: binding.protocolBindings,
            models: [...snapshot.models, created]
          },
          result: created
        };
      });
      await this.record({
        action: 'model_registered_exact',
        outcome: 'succeeded',
        providerId: model.providerId,
        connectionId: model.connectionId,
        modelId: model.id
      });
      return {
        ok: true,
        value: {
          connectionId: model.connectionId,
          modelId: model.id,
          state: 'registered_without_profile'
        }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async setConnectionEnabled(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly connectionId: string;
    readonly state: 'enabled' | 'disabled';
  }>> {
    try {
      const request = parseEnabledRequest(input, 'connectionId');
      const now = this.now();
      const result = await this.registry.mutate((snapshot) => {
        const resolved = resolveOwnedConnection(
          snapshot,
          this.packages,
          request.id
        );
        if (resolved.connection.state === 'deleted' && request.enabled) {
          throw new ProviderManagementFrameworkError(
            'connection_contract_stale',
            'A deleted provider connection cannot be enabled'
          );
        }
        const nextState = request.enabled
          ? resolved.connection.identityState === 'verified' &&
              resolved.connection.credentialState === 'valid' &&
              resolved.connection.lastConnectionValidationAt
            ? 'available' as const
            : 'saved' as const
          : 'disabled' as const;
        return {
          snapshot: {
            ...snapshot,
            connections: snapshot.connections.map((connection) =>
              connection.id === resolved.connection.id
                ? {
                    ...connection,
                    state: nextState,
                    connectionRevision: (connection.connectionRevision ?? 0) + 1,
                    updatedAt: now
                  }
                : connection
            ),
            models: request.enabled
              ? snapshot.models
              : snapshot.models.map((model) =>
                  model.connectionId === resolved.connection.id && model.enabled
                    ? { ...model, enabled: false, revision: model.revision + 1, updatedAt: now }
                    : model
                ),
            routingPreferences: request.enabled
              ? snapshot.routingPreferences
              : snapshot.routingPreferences.map((preference) =>
                  snapshot.models.some((model) =>
                    model.id === preference.modelId &&
                    model.connectionId === resolved.connection.id
                  ) && preference.enabled
                    ? { ...preference, enabled: false, updatedAt: now }
                    : preference
                )
          },
          result: {
            connectionId: resolved.connection.id,
            providerId: resolved.connection.providerId,
            state: request.enabled ? 'enabled' as const : 'disabled' as const
          }
        };
      });
      await this.record({
        action: request.enabled ? 'connection_enabled' : 'connection_disabled',
        outcome: 'succeeded',
        providerId: result.providerId,
        connectionId: result.connectionId
      }, now);
      await this.syncRuntimePolicy(result.connectionId);
      return { ok: true, value: { connectionId: result.connectionId, state: result.state } };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async setModelEnabled(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly modelId: string;
    readonly state: 'enabled' | 'disabled';
  }>> {
    try {
      const request = parseEnabledRequest(input, 'modelId');
      const now = this.now();
      const result = await this.registry.mutate((snapshot) => {
        const model = snapshot.models.find((candidate) => candidate.id === request.id);
        if (!model) {
          throw new ProviderManagementFrameworkError(
            'model_not_found',
            'The provider model was not found'
          );
        }
        const resolved = resolveOwnedConnection(
          snapshot,
          this.packages,
          model.connectionId
        );
        if (resolved.connection.providerId !== model.providerId) {
          throw new ProviderManagementFrameworkError(
            'connection_contract_stale',
            'The provider model does not belong to its package-owned connection'
          );
        }
        let workingSnapshot = snapshot;
        let currentModel = model;
        if (request.enabled && !currentModel.activeProfileId) {
          const attached = tryAttachDefaultTextChatProfile(workingSnapshot, currentModel, now);
          workingSnapshot = attached.snapshot;
          currentModel = attached.model;
        }
        if (request.enabled) assertModelRoutableForEnable(workingSnapshot, currentModel);
        const updated = currentModel.enabled === request.enabled
          ? currentModel
          : {
              ...currentModel,
              enabled: request.enabled,
              revision: currentModel.revision + 1,
              updatedAt: now
            };
        return {
          snapshot: {
            ...workingSnapshot,
            models: workingSnapshot.models.map((candidate) =>
              candidate.id === currentModel.id ? updated : candidate
            ),
            routingPreferences: request.enabled
              ? workingSnapshot.routingPreferences
              : workingSnapshot.routingPreferences.map((preference) =>
                  preference.modelId === currentModel.id && preference.enabled
                    ? { ...preference, enabled: false, updatedAt: now }
                    : preference
                )
          },
          result: updated
        };
      });
      await this.record({
        action: request.enabled ? 'model_enabled' : 'model_disabled',
        outcome: 'succeeded',
        providerId: result.providerId,
        connectionId: result.connectionId,
        modelId: result.id
      }, now);
      return {
        ok: true,
        value: { modelId: result.id, state: request.enabled ? 'enabled' : 'disabled' }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async deleteModel(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly modelId: string;
    readonly state: 'deleted';
  }>> {
    try {
      const modelId = parseIdRequest(input, 'modelId');
      const now = this.now();
      const result = await this.registry.mutate((snapshot) => {
        const model = snapshot.models.find((candidate) => candidate.id === modelId);
        if (!model) {
          throw new ProviderManagementFrameworkError(
            'model_not_found',
            'The provider model was not found'
          );
        }
        if ((model.catalogState ?? 'present') === 'retired') {
          return { snapshot, result: model };
        }
        const hasCapabilityHistory = snapshot.capabilities.some(
          (evidence) => evidence.modelId === model.id
        );
        // Capability evidence is immutable and requires the model ref,
        // so history-bearing models stay as hidden retired tombs.
        if (hasCapabilityHistory) {
          return {
            snapshot: {
              ...snapshot,
              models: snapshot.models.map((candidate) =>
                candidate.id === model.id
                  ? {
                      ...candidate,
                      enabled: false,
                      catalogState: 'retired' as const,
                      revision: candidate.revision + 1,
                      updatedAt: now
                    }
                  : candidate
              ),
              routingPreferences: snapshot.routingPreferences.map((preference) =>
                preference.modelId === model.id && preference.enabled
                  ? { ...preference, enabled: false, updatedAt: now }
                  : preference
              )
            },
            result: model
          };
        }
        return {
          snapshot: {
            ...snapshot,
            models: snapshot.models.filter((candidate) => candidate.id !== model.id),
            modelProfiles: (snapshot.modelProfiles ?? []).filter(
              (profile) => profile.modelId !== model.id
            ),
            routingPreferences: snapshot.routingPreferences.filter(
              (preference) => preference.modelId !== model.id
            )
          },
          result: model
        };
      });
      await this.record({
        action: 'model_deleted',
        outcome: 'succeeded',
        providerId: result.providerId,
        connectionId: result.connectionId,
        modelId: result.id
      }, now);
      return {
        ok: true,
        value: { modelId: result.id, state: 'deleted' }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  async deleteConnection(input: unknown): Promise<ProviderManagementFrameworkResult<{
    readonly connectionId: string;
    readonly state: 'deleted';
    readonly remoteRevocation: 'not_attempted';
  }>> {
    try {
      const request = parseDeleteConnectionRequest(input);
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (candidate) => candidate.id === request.connectionId
      );
      if (!connection) {
        throw new ProviderManagementFrameworkError(
          'connection_not_found',
          'The provider connection was not found'
        );
      }
      const activeVersions = await this.credentialRetention.listActiveCredentialVersions(
        connection.id
      );
      if (activeVersions.length > 0 && !request.abandonActiveOperations) {
        throw new ProviderManagementFrameworkError(
          'active_operations_present',
          'Active provider operations must finish or be explicitly abandoned'
        );
      }
      const now = this.now();
      if (activeVersions.length > 0) {
        await this.credentialRetention.markCredentialUnavailable({
          connectionId: connection.id,
          credentialVersionIds: activeVersions,
          occurredAt: now
        });
      }
      const credentialReference = connection.credentialReference;
      const packageId = connection.packageId;
      if (packageId) {
        await this.runtimeAuthorization?.syncConnectionPolicy({
          providerPackageId: packageId,
          connectionId: connection.id,
          allowed: false
        }).catch(() => undefined);
      }
      await this.registry.mutate((latest) => {
        const current = requirePresentConnection(latest, connection);
        const modelIds = new Set(
          latest.models
            .filter((model) => model.connectionId === current.id)
            .map((model) => String(model.id))
        );
        const hasCapabilityHistory = latest.capabilities.some((evidence) =>
          modelIds.has(String(evidence.modelId))
        );
        // Capability evidence is immutable and requires model/connection refs,
        // so history-bearing connections stay as hidden tombs; others are purged.
        if (hasCapabilityHistory) {
          return {
            snapshot: {
              ...latest,
              connections: latest.connections.map((item) =>
                item.id === current.id
                  ? {
                      ...item,
                      endpoint: undefined,
                      credentialReference: undefined,
                      credentialState: 'deleted' as const,
                      state: 'deleted' as const,
                      identityState: 'unverified' as const,
                      lastConnectionValidationAt: undefined,
                      connectionRevision: (item.connectionRevision ?? 0) + 1,
                      updatedAt: now
                    }
                  : item
              ),
              models: latest.models.map((model) =>
                modelIds.has(String(model.id)) && model.enabled
                  ? { ...model, enabled: false, revision: model.revision + 1, updatedAt: now }
                  : model
              ),
              routingPreferences: latest.routingPreferences.map((preference) =>
                modelIds.has(String(preference.modelId)) && preference.enabled
                  ? { ...preference, enabled: false, updatedAt: now }
                  : preference
              )
            },
            result: undefined
          };
        }
        const remainingConnections = latest.connections.filter(
          (item) => item.id !== current.id
        );
        const providerStillUsed = remainingConnections.some(
          (item) => item.providerId === current.providerId
        );
        return {
          snapshot: {
            ...latest,
            providers: providerStillUsed
              ? latest.providers
              : latest.providers.filter((provider) => provider.id !== current.providerId),
            connections: remainingConnections,
            protocolBindings: latest.protocolBindings.filter(
              (binding) => binding.connectionId !== current.id
            ),
            models: latest.models.filter((model) => model.connectionId !== current.id),
            modelProfiles: (latest.modelProfiles ?? []).filter(
              (profile) => !modelIds.has(String(profile.modelId))
            ),
            routingPreferences: latest.routingPreferences.filter(
              (preference) => !modelIds.has(String(preference.modelId))
            )
          },
          result: undefined
        };
      });
      if (credentialReference) await this.vault.remove(credentialReference);
      await this.record({
        action: 'connection_deleted',
        outcome: 'succeeded',
        providerId: connection.providerId,
        connectionId: connection.id,
        safeCode: activeVersions.length > 0
          ? 'active_operations_abandoned'
          : 'local_only'
      }, now);
      return {
        ok: true,
        value: {
          connectionId: connection.id,
          state: 'deleted',
          remoteRevocation: 'not_attempted'
        }
      };
    } catch (error) {
      return frameworkFailure(error);
    }
  }

  private record(
    input: Omit<ProviderManagementAuditEventV1, 'schemaVersion' | 'sequence' | 'eventId' | 'occurredAt'>,
    occurredAt = this.now()
  ): Promise<ProviderManagementAuditEventV1> {
    return this.audit.append({
      ...input,
      eventId: `provider-audit-${randomUUID()}`,
      occurredAt
    });
  }
}

function resolveOwnedConnection(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  connectionId: string
): { readonly connection: ProviderConnection; readonly template: ResolvedProviderTemplate } {
  const connection = snapshot.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) {
    throw new ProviderManagementFrameworkError(
      'connection_not_found',
      'The provider connection was not found'
    );
  }
  if (!connection.packageId || !connection.templateId) {
    throw new ProviderManagementFrameworkError(
      'connection_contract_stale',
      'The provider connection has no package ownership'
    );
  }
  let template: ResolvedProviderTemplate;
  try {
    template = packages.resolveTemplate(connection.packageId, connection.templateId);
  } catch (error) {
    if (error instanceof ProviderPackageContractError) {
      throw new ProviderManagementFrameworkError(
        error.code === 'package_not_found' ? 'package_not_found' : 'template_not_found',
        error.message
      );
    }
    throw error;
  }
  const expectedBindings = template.adapters.map((adapter) => ({
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    protocolId: adapter.protocolId,
    protocolVersion: adapter.protocolVersion
  }));
  if (
    connection.packageVersion !== template.package.packageVersion ||
    connection.templateKind !== template.template.kind ||
    connection.credentialSchemaId !== template.credentialSchema.schemaId ||
    connection.credentialSchemaVersion !== template.credentialSchema.version ||
    connection.connectionPolicyId !== template.template.connectionPolicyId ||
    connection.connectionPolicyRevision !== template.template.connectionPolicyRevision ||
    connection.discoveryPolicyId !== template.template.discoveryPolicyId ||
    connection.discoveryPolicyRevision !== template.template.discoveryPolicyRevision ||
    connection.endpointPolicyId !== template.endpointPolicy.policyId ||
    connection.endpointPolicyRevision !== template.endpointPolicy.revision ||
    JSON.stringify(connection.adapterBindings) !== JSON.stringify(expectedBindings)
  ) {
    throw new ProviderManagementFrameworkError(
      'connection_contract_stale',
      'The provider connection contract does not match its package template'
    );
  }
  return { connection, template };
}

function requireUnchangedConnection(
  snapshot: ProviderRegistrySnapshot,
  expected: ProviderConnection,
  packages: ProviderPackageRegistry
): ProviderConnection {
  const current = resolveOwnedConnection(snapshot, packages, expected.id).connection;
  if (
    current.connectionConfigVersionId !== expected.connectionConfigVersionId ||
    current.connectionRevision !== expected.connectionRevision ||
    current.credentialVersionId !== expected.credentialVersionId
  ) {
    throw new ProviderManagementFrameworkError(
      'provider_registry_conflict',
      'The provider connection changed during the management operation'
    );
  }
  return current;
}

function requirePresentConnection(
  snapshot: ProviderRegistrySnapshot,
  expected: ProviderConnection
): ProviderConnection {
  const current = snapshot.connections.find((candidate) => candidate.id === expected.id);
  if (!current) {
    throw new ProviderManagementFrameworkError(
      'connection_not_found',
      'The provider connection was not found'
    );
  }
  if (
    current.connectionConfigVersionId !== expected.connectionConfigVersionId ||
    current.connectionRevision !== expected.connectionRevision ||
    current.credentialVersionId !== expected.credentialVersionId
  ) {
    throw new ProviderManagementFrameworkError(
      'provider_registry_conflict',
      'The provider connection changed during the management operation'
    );
  }
  return current;
}

async function useStructuredCredential<T>(
  vault: SecureCredentialVault,
  connection: ProviderConnection,
  schema: CredentialSchema,
  operation: (record: StructuredCredentialRecord) => Promise<T>
): Promise<T> {
  if (!connection.credentialReference || !connection.credentialVersionId) {
    throw new ProviderManagementFrameworkError(
      'credential_unavailable',
      'The provider connection has no structured credential'
    );
  }
  return vault.useRecord(connection.credentialReference, async (record) => {
    if (record.schemaId !== schema.schemaId || record.schemaVersion !== schema.version) {
      throw new ProviderManagementFrameworkError(
        'credential_invalid',
        'The provider credential schema does not match the connection template'
      );
    }
    validateCredentialRecord(schema, record.values);
    return operation(record);
  });
}

function validateCredentialRecord(
  schema: CredentialSchema,
  values: Readonly<Record<string, string>>
): StructuredCredentialRecord {
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  if (Object.keys(values).some((key) => !fields.has(key))) {
    throw new ProviderManagementFrameworkError(
      'credential_invalid',
      'The provider credential contains an unsupported field'
    );
  }
  const normalized: Record<string, string> = {};
  for (const field of schema.fields) {
    const value = values[field.key];
    if (value === undefined) {
      if (field.required) {
        throw new ProviderManagementFrameworkError(
          'credential_invalid',
          'A required provider credential field is missing'
        );
      }
      continue;
    }
    if (typeof value !== 'string' || value.length < 1 || value.length > 65_536) {
      throw new ProviderManagementFrameworkError(
        'credential_invalid',
        'A provider credential field is invalid'
      );
    }
    normalized[field.key] = value;
  }
  return { schemaId: schema.schemaId, schemaVersion: schema.version, values: normalized };
}

function parseValidationObservation(
  value: ProviderConnectionValidationResultV1
): ProviderConnectionValidationResultV1 {
  if (
    !['available', 'unavailable'].includes(value.state) ||
    !['verified', 'verification_failed'].includes(value.identityState) ||
    !['valid', 'invalid', 'verification_unavailable'].includes(value.credentialState)
  ) {
    throw new ProviderManagementFrameworkError(
      'provider_management_failed',
      'The provider validation adapter returned an invalid result'
    );
  }
  return {
    ...value,
    observedAt: toIsoTimestamp(value.observedAt),
    ...(value.safeCode ? { safeCode: requireSafeCode(value.safeCode) } : {})
  };
}

function parseCatalogEntries(
  entries: readonly ProviderCatalogEntryV1[]
): readonly ProviderCatalogEntryV1[] {
  if (!Array.isArray(entries)) {
    throw new ProviderManagementFrameworkError(
      'provider_management_failed',
      'The provider model catalog is invalid'
    );
  }
  const parsed = entries.map((entry) => ({
    providerModelKey: requireProviderModelKey(entry.providerModelKey),
    displayName: requireDisplayName(entry.displayName)
  }));
  assertUnique(parsed.map((entry) => entry.providerModelKey), 'provider model key');
  return parsed;
}

function ensureCatalogBinding(
  snapshot: ProviderRegistrySnapshot,
  connection: ProviderConnection,
  descriptor: ProviderAdapterDescriptor,
  now: IsoTimestamp
): {
  readonly binding: ProviderProtocolBinding;
  readonly protocolBindings: readonly ProviderProtocolBinding[];
} {
  const matches = snapshot.protocolBindings.filter((binding) =>
    binding.connectionId === connection.id &&
    binding.providerId === connection.providerId &&
    binding.protocolId === descriptor.protocolId &&
    binding.protocolVersion === descriptor.protocolVersion &&
    binding.adapterKind === descriptor.adapterId
  );
  if (matches.length > 1) {
    throw new ProviderManagementFrameworkError(
      'adapter_binding_ambiguous',
      'The provider registry contains duplicate exact protocol bindings'
    );
  }
  if (matches[0]) return { binding: matches[0], protocolBindings: snapshot.protocolBindings };
  const binding = createProviderProtocolBinding({
    id: toProtocolBindingId(`protocol-binding-catalog-${randomUUID()}`),
    providerId: connection.providerId,
    connectionId: connection.id,
    protocolId: descriptor.protocolId,
    protocolVersion: descriptor.protocolVersion,
    mediaKind: 'unknown',
    adapterKind: descriptor.adapterId,
    authScheme: 'unknown',
    executionLifecycle: 'unknown',
    supportedPurposes: [],
    createdAt: now,
    updatedAt: now
  });
  return { binding, protocolBindings: [...snapshot.protocolBindings, binding] };
}

function mergeCatalogModels(
  models: readonly ProviderModel[],
  connection: ProviderConnection,
  binding: ProviderProtocolBinding,
  entries: readonly ProviderCatalogEntryV1[],
  catalogRevision: number,
  observedAt: IsoTimestamp
): readonly ProviderModel[] {
  const byKey = new Map(
    models
      .filter((model) => model.connectionId === connection.id)
      .map((model) => [model.providerModelKey, model])
  );
  const present = entries.map((entry) => {
    const current = byKey.get(entry.providerModelKey);
    if (!current) {
      return createProviderModel({
        id: toModelId(`model-${randomUUID()}`),
        providerId: connection.providerId,
        connectionId: connection.id,
        protocolBindingId: binding.id,
        providerModelKey: entry.providerModelKey,
        mediaKind: 'unknown',
        revision: 1,
        catalogState: 'present',
        catalogRevision,
        lastSeenAt: observedAt,
        displayName: entry.displayName,
        enabled: false,
        createdAt: observedAt,
        updatedAt: observedAt
      });
    }
    if (current.catalogState === 'retired') {
      return {
        ...current,
        protocolBindingId: binding.id,
        catalogRevision,
        lastSeenAt: observedAt,
        revision: current.revision + 1,
        updatedAt: observedAt
      };
    }
    return {
      ...current,
      protocolBindingId: binding.id,
      displayName: entry.displayName,
      catalogState: 'present' as const,
      catalogRevision,
      lastSeenAt: observedAt,
      revision: current.revision + 1,
      updatedAt: observedAt
    };
  });
  const keys = new Set(entries.map((entry) => entry.providerModelKey));
  const retained = models
    .filter((model) => model.connectionId !== connection.id || !keys.has(model.providerModelKey))
    .map((model) =>
      model.connectionId === connection.id && model.catalogState !== 'retired'
        ? {
            ...model,
            catalogState: 'missing' as const,
            catalogRevision,
            enabled: false,
            revision: model.revision + 1,
            updatedAt: observedAt
          }
        : model
    );
  return [...retained, ...present];
}

function nextCatalogRevision(
  models: readonly ProviderModel[],
  connectionId: string
): number {
  return Math.max(
    0,
    ...models
      .filter((model) => model.connectionId === connectionId)
      .map((model) => model.catalogRevision ?? 0)
  ) + 1;
}

function requireAvailableConnection(connection: ProviderConnection): void {
  if (
    connection.state !== 'available' ||
    connection.identityState !== 'verified' ||
    connection.credentialState !== 'valid'
  ) {
    throw new ProviderManagementFrameworkError(
      'connection_not_available',
      'The provider connection must pass validation before model management'
    );
  }
}

function assertModelRoutableForEnable(
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel
): void {
  const connection = snapshot.connections.find((candidate) =>
    candidate.id === model.connectionId
  );
  const binding = snapshot.protocolBindings.find((candidate) =>
    candidate.id === model.protocolBindingId &&
    candidate.connectionId === model.connectionId
  );
  if (
    !connection || connection.state !== 'available' ||
    connection.credentialState !== 'valid' || connection.identityState !== 'verified' ||
    (model.catalogState ?? 'present') !== 'present' ||
    !binding
  ) {
    throw new ProviderManagementFrameworkError(
      'model_not_routable',
      'Only a present model on an available connection can be enabled'
    );
  }
  // Catalog-synced models may not have a verified profile yet; still allow the
  // user to mark them enabled for local selection. If a profile is already
  // attached, it must remain verified.
  if (model.activeProfileId) {
    const profile = snapshot.modelProfiles?.find((candidate) =>
      candidate.profileId === model.activeProfileId &&
      candidate.modelId === model.id &&
      candidate.modelRevision <= model.revision
    );
    if (!profile || profile.status !== 'verified') {
      throw new ProviderManagementFrameworkError(
        'model_not_routable',
        'Only a present model with an exact verified profile can be enabled'
      );
    }
  }
}

function tryAttachDefaultTextChatProfile(
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel,
  now: IsoTimestamp
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly model: ProviderModel;
} {
  if (model.activeProfileId) return { snapshot, model };
  const provider = snapshot.providers.find((candidate) => candidate.id === model.providerId);
  const connection = snapshot.connections.find((candidate) => candidate.id === model.connectionId);
  const binding = snapshot.protocolBindings.find((candidate) =>
    candidate.id === model.protocolBindingId &&
    candidate.connectionId === model.connectionId
  );
  if (!provider?.packageId || !provider.packageVersion || !connection || !binding) {
    return { snapshot, model };
  }
  const definition = resolveDefaultTextChatDefinition({
    packageId: provider.packageId,
    packageVersion: provider.packageVersion,
    providerModelKey: model.providerModelKey,
    binding
  });
  if (!definition) return { snapshot, model };
  const template = definition.profileTemplates[0];
  if (!template) return { snapshot, model };
  if (
    binding.adapterKind !== template.adapterKey ||
    binding.protocolId !== template.protocolDefinitionId
  ) {
    return { snapshot, model };
  }
  const definitions = snapshot.modelDefinitions ?? [];
  const nextDefinitions = definitions.some(
    (candidate) => candidate.definitionId === definition.definitionId
  )
    ? definitions
    : [...definitions, definition];
  const nextModelRevision = model.revision + 1;
  const profile: ModelFeatureProfile = {
    schemaVersion: 1,
    profileId: `profile-${randomUUID()}`,
    revision: Math.max(
      1,
      ...(snapshot.modelProfiles ?? [])
        .filter((candidate) => candidate.modelId === model.id)
        .map((candidate) => candidate.revision + 1)
    ),
    packageId: definition.packageId,
    sourceTemplateId: template.templateId,
    adapterKey: template.adapterKey,
    modelId: model.id,
    modelRevision: nextModelRevision,
    protocolBindingId: model.protocolBindingId,
    status: 'verified',
    features: template.features,
    evidenceIds: snapshot.capabilities
      .filter((candidate) => candidate.modelId === model.id)
      .map((candidate) => candidate.id),
    recordedAt: now
  };
  const updatedModel: ProviderModel = {
    ...model,
    activeProfileId: profile.profileId,
    revision: nextModelRevision,
    updatedAt: now
  };
  return {
    snapshot: {
      ...snapshot,
      modelDefinitions: nextDefinitions,
      models: snapshot.models.map((candidate) =>
        candidate.id === model.id ? updatedModel : candidate
      ),
      modelProfiles: [...(snapshot.modelProfiles ?? []), profile]
    },
    model: updatedModel
  };
}

function resolveDefaultTextChatDefinition(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerModelKey: string;
  readonly binding: ProviderProtocolBinding;
}): ProviderModelDefinition | undefined {
  if (
    input.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID &&
    input.binding.adapterKind === DEEPSEEK_CHAT_ADAPTER_ID &&
    input.binding.protocolId === DEEPSEEK_CHAT_PROTOCOL_ID
  ) {
    return deepSeekModelDefinitions.find(
      (definition) => definition.providerModelKey === input.providerModelKey
    );
  }
  if (
    isOpenAiCompatiblePackageId(input.packageId) &&
    input.binding.adapterKind === NEWAPI_CHAT_ADAPTER_ID &&
    input.binding.protocolId === NEWAPI_CHAT_PROTOCOL_ID
  ) {
    return createOpenAiCompatibleDefaultTextDefinition({
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      providerModelKey: input.providerModelKey
    });
  }
  return undefined;
}

function parseCreateConnectionRequest(value: unknown): unknown {
  if (!isRecord(value)) throw invalidRequest();
  const allowed = new Set([
    'packageId',
    'templateId',
    'name',
    'endpoint',
    'credentials',
    'explicitLoopbackHttpConsent'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidRequest();
  return value;
}

function parseAddConnectionRequest(value: unknown): {
  readonly save: Record<string, unknown>;
  readonly packageId: string;
  readonly templateId: string;
  readonly endpoint?: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly explicitLoopbackHttpConsent: boolean;
  readonly allowUnavailableSave: boolean;
} {
  if (!isRecord(value)) throw invalidRequest();
  const allowed = new Set([
    'packageId',
    'templateId',
    'name',
    'endpoint',
    'credentials',
    'explicitLoopbackHttpConsent',
    'allowUnavailableSave'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidRequest();
  if (
    value.allowUnavailableSave !== undefined &&
    typeof value.allowUnavailableSave !== 'boolean'
  ) {
    throw invalidRequest();
  }
  if (
    value.explicitLoopbackHttpConsent !== undefined &&
    typeof value.explicitLoopbackHttpConsent !== 'boolean'
  ) {
    throw invalidRequest();
  }
  if (
    value.endpoint !== undefined &&
    (typeof value.endpoint !== 'string' || value.endpoint.length > 2_048)
  ) {
    throw invalidRequest();
  }
  if (!isRecord(value.credentials)) throw invalidRequest();
  const credentials: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value.credentials)) {
    if (typeof fieldValue !== 'string') throw invalidRequest();
    credentials[key] = fieldValue;
  }
  const save: Record<string, unknown> = {};
  for (const key of [
    'packageId',
    'templateId',
    'name',
    'endpoint',
    'credentials',
    'explicitLoopbackHttpConsent'
  ]) {
    if (value[key] !== undefined) save[key] = value[key];
  }
  return {
    save,
    packageId: requireId(value.packageId),
    templateId: requireId(value.templateId),
    endpoint: value.endpoint,
    credentials,
    explicitLoopbackHttpConsent: value.explicitLoopbackHttpConsent === true,
    allowUnavailableSave: value.allowUnavailableSave === true
  };
}

function parseRotateCredentialRequest(value: unknown): {
  readonly connectionId: string;
  readonly credentials: Readonly<Record<string, string>>;
} {
  if (!isRecord(value) || !isRecord(value.credentials) ||
    Object.keys(value).some((key) => !['connectionId', 'credentials'].includes(key))) {
    throw invalidRequest();
  }
  const credentials: Record<string, string> = {};
  for (const [key, field] of Object.entries(value.credentials)) {
    if (typeof field !== 'string') throw invalidRequest();
    credentials[key] = field;
  }
  return { connectionId: requireId(value.connectionId), credentials };
}

function parseRegisterModelRequest(value: unknown): {
  readonly connectionId: string;
  readonly providerModelKey: string;
  readonly displayName: string;
} {
  if (!isRecord(value) ||
    Object.keys(value).some((key) =>
      !['connectionId', 'providerModelKey', 'displayName'].includes(key)
    )) {
    throw invalidRequest();
  }
  return {
    connectionId: requireId(value.connectionId),
    providerModelKey: requireProviderModelKey(value.providerModelKey),
    displayName: requireDisplayName(value.displayName)
  };
}

function parseEnabledRequest(
  value: unknown,
  idField: 'connectionId' | 'modelId'
): { readonly id: string; readonly enabled: boolean } {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' ||
    Object.keys(value).some((key) => ![idField, 'enabled'].includes(key))) {
    throw invalidRequest();
  }
  return { id: requireId(value[idField]), enabled: value.enabled };
}

function parseDeleteConnectionRequest(value: unknown): {
  readonly connectionId: string;
  readonly confirmLocalDeletion: true;
  readonly abandonActiveOperations: boolean;
} {
  if (!isRecord(value) || value.confirmLocalDeletion !== true ||
    (value.abandonActiveOperations !== undefined &&
      typeof value.abandonActiveOperations !== 'boolean') ||
    Object.keys(value).some((key) =>
      !['connectionId', 'confirmLocalDeletion', 'abandonActiveOperations'].includes(key)
    )) {
    throw invalidRequest();
  }
  return {
    connectionId: requireId(value.connectionId),
    confirmLocalDeletion: true,
    abandonActiveOperations: value.abandonActiveOperations === true
  };
}

function parseIdRequest(value: unknown, field: string): string {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== field)) {
    throw invalidRequest();
  }
  return requireId(value[field]);
}

function mapConnectionError(
  result: Extract<ProviderConnectionContractResult, { readonly ok: false }>
): ProviderManagementFrameworkError {
  const code: ProviderManagementFrameworkErrorCode =
    result.error.code === 'package_not_found'
      ? 'package_not_found'
      : result.error.code === 'template_not_found'
        ? 'template_not_found'
        : result.error.code === 'credential_invalid'
          ? 'credential_invalid'
          : result.error.code === 'invalid_request' ||
              result.error.code === 'endpoint_not_allowed' ||
              result.error.code === 'package_contract_invalid'
            ? 'invalid_request'
            : 'provider_management_failed';
  return new ProviderManagementFrameworkError(code, result.error.message);
}

function frameworkFailure<T>(error: unknown): ProviderManagementFrameworkResult<T> {
  if (error instanceof ProviderManagementFrameworkError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof ProviderPackageContractError) {
    const code = error.code === 'package_not_found'
      ? 'package_not_found'
      : error.code === 'template_not_found'
        ? 'template_not_found'
        : 'invalid_request';
    return { ok: false, error: { code, message: error.message } };
  }
  return frameworkFailureCode(
    error instanceof TypeError ? 'invalid_request' : 'provider_management_failed'
  );
}

function frameworkFailureCode<T>(
  code: ProviderManagementFrameworkErrorCode
): ProviderManagementFrameworkResult<T> {
  const messages: Record<ProviderManagementFrameworkErrorCode, string> = {
    invalid_request: 'The provider management request is invalid',
    package_not_found: 'The provider package was not found',
    template_not_found: 'The provider template was not found',
    connection_not_found: 'The provider connection was not found',
    model_not_found: 'The provider model was not found',
    connection_contract_stale: 'The provider connection contract is unavailable',
    credential_unavailable: 'The provider credential is unavailable',
    credential_invalid: 'The provider credential is invalid',
    connection_validation_failed: 'The remote provider validation failed',
    free_validation_unavailable: 'No approved free connection validation is available',
    operation_unavailable: 'The provider management operation is unavailable',
    adapter_unavailable: 'The exact provider management adapter is unavailable',
    adapter_binding_ambiguous: 'The provider management adapter binding is ambiguous',
    connection_not_available: 'The provider connection is not available',
    catalog_sync_unavailable: 'Model catalog synchronization is unavailable',
    manual_registration_unavailable: 'Exact manual model registration is unavailable',
    model_already_exists: 'The provider model is already registered',
    model_not_routable: 'The provider model cannot be enabled',
    active_operations_present: 'Active provider operations still use this connection',
    provider_registry_conflict: 'The provider registry changed during the operation',
    audit_store_unavailable: 'The provider management audit is unavailable',
    provider_management_failed: 'The provider management operation failed'
  };
  return { ok: false, error: { code, message: messages[code] } };
}

function parseAuditDocument(value: unknown): ProviderManagementAuditDocumentV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.events)) {
    throw new TypeError('Provider management audit document is invalid');
  }
  const events = value.events.map(parseAuditEvent);
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      throw new TypeError('Provider management audit sequence is invalid');
    }
  });
  assertUnique(events.map((event) => event.eventId), 'provider audit event');
  return { schemaVersion: 1, revision: Number(value.revision), events };
}

function parseAuditEvent(value: unknown): ProviderManagementAuditEventV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
    !providerManagementActions.includes(value.action as ProviderManagementAction) ||
    !['succeeded', 'denied', 'failed'].includes(String(value.outcome))) {
    throw new TypeError('Provider management audit event is invalid');
  }
  const allowed = new Set([
    'schemaVersion', 'eventId', 'sequence', 'action', 'outcome', 'providerId',
    'connectionId', 'modelId', 'safeCode', 'count', 'occurredAt'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('Provider management audit event contains unsupported fields');
  }
  const count = value.count === undefined ? undefined : Number(value.count);
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
    throw new TypeError('Provider management audit count is invalid');
  }
  return {
    schemaVersion: 1,
    eventId: requireId(value.eventId),
    sequence: Number(value.sequence),
    action: value.action as ProviderManagementAction,
    outcome: value.outcome as ProviderManagementAuditEventV1['outcome'],
    ...(value.providerId === undefined ? {} : { providerId: requireId(value.providerId) }),
    ...(value.connectionId === undefined ? {} : { connectionId: requireId(value.connectionId) }),
    ...(value.modelId === undefined ? {} : { modelId: requireId(value.modelId) }),
    ...(value.safeCode === undefined ? {} : { safeCode: requireSafeCode(value.safeCode) }),
    ...(count === undefined ? {} : { count }),
    occurredAt: toIsoTimestamp(String(value.occurredAt))
  };
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function requireProviderModelKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 500) {
    throw invalidRequest();
  }
  return value.trim();
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 200) {
    throw invalidRequest();
  }
  return value.trim();
}

function requireSafeCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError('Provider management safe code is invalid');
  }
  return value;
}

function invalidRequest(): ProviderManagementFrameworkError {
  return new ProviderManagementFrameworkError(
    'invalid_request',
    'The provider management request is invalid'
  );
}

function adapterKey(identity: ProviderManagementAdapterIdentityV1): string {
  return [
    identity.packageId,
    identity.adapterId,
    identity.adapterVersion,
    identity.protocolId,
    identity.protocolVersion
  ].join('::');
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} identities must be unique`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT';
}
