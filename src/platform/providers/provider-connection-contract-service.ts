import { randomUUID } from 'node:crypto';
import {
  createProvider,
  createProviderConnection,
  toConnectionId,
  toIsoTimestamp,
  toProviderId,
  type CredentialSchema,
  type Provider,
  type ProviderConnection,
  type StructuredCredentialRecord
} from '../../domain';
import type {
  JsonProviderRegistryStore,
  ProviderRegistrySnapshot
} from './provider-registry';
import type { SecureCredentialVault } from './credential-vault';
import {
  ProviderPackageContractError,
  type ProviderPackageRegistry,
  type ResolvedProviderTemplate
} from './provider-package-registry';

export type ProviderConnectionContractErrorCode =
  | ProviderPackageContractError['code']
  | 'invalid_request'
  | 'credential_invalid'
  | 'provider_package_conflict'
  | 'connection_save_failed';

export type ProviderConnectionContractResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly providerId: string;
        readonly connectionId: string;
        readonly connectionConfigVersionId: string;
        readonly credentialVersionId: string;
        readonly state: 'saved';
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ProviderConnectionContractErrorCode;
        readonly message: string;
      };
    };

interface ProviderRegistryWritePort {
  load(): Promise<ProviderRegistrySnapshot>;
  save(snapshot: ProviderRegistrySnapshot): Promise<void>;
}

interface StructuredCredentialVaultWritePort {
  saveRecord(reference: string, record: StructuredCredentialRecord): Promise<void>;
  remove(reference: string): Promise<boolean>;
}

export class ProviderConnectionContractService {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly packages: ProviderPackageRegistry,
    private readonly registry: ProviderRegistryWritePort | JsonProviderRegistryStore,
    private readonly vault: StructuredCredentialVaultWritePort | SecureCredentialVault
  ) {}

  async saveConnection(input: unknown): Promise<ProviderConnectionContractResult> {
    const operation = this.saveQueue.then(() => this.saveConnectionExclusive(input));
    this.saveQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveConnectionExclusive(
    input: unknown
  ): Promise<ProviderConnectionContractResult> {
    let credentialReference: string | undefined;
    try {
      const request = parseSaveRequest(input);
      const resolved = this.packages.resolveTemplate(
        request.packageId,
        request.templateId
      );
      const endpoint = this.packages.resolveEndpoint(
        resolved,
        request.endpoint,
        request.explicitLoopbackHttpConsent
      );
      const credential = validateCredentialValues(
        resolved.credentialSchema,
        request.credentials
      );
      const snapshot = await this.registry.load();
      const provider = resolveProvider(snapshot, resolved);
      const now = toIsoTimestamp(new Date().toISOString());
      const credentialVersionId = `credential-version-${randomUUID()}`;
      credentialReference = `credential-${randomUUID()}`;
      const connection = createPackageOwnedConnection({
        provider,
        resolved,
        endpoint,
        name: request.name,
        credentialReference,
        credentialVersionId,
        now
      });

      await this.vault.saveRecord(credentialReference, credential);
      try {
        await this.registry.save({
          ...snapshot,
          providers: snapshot.providers.includes(provider)
            ? snapshot.providers
            : [...snapshot.providers, provider],
          connections: [...snapshot.connections, connection]
        });
      } catch (error) {
        await this.vault.remove(credentialReference).catch(() => false);
        credentialReference = undefined;
        throw error;
      }
      credentialReference = undefined;
      return {
        ok: true,
        value: {
          providerId: provider.id,
          connectionId: connection.id,
          connectionConfigVersionId: connection.connectionConfigVersionId!,
          credentialVersionId,
          state: 'saved'
        }
      };
    } catch (error) {
      if (credentialReference) {
        await this.vault.remove(credentialReference).catch(() => false);
      }
      return failure(error);
    }
  }
}

interface SaveConnectionRequest {
  readonly packageId: string;
  readonly templateId: string;
  readonly name: string;
  readonly endpoint?: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly explicitLoopbackHttpConsent: boolean;
}

function parseSaveRequest(value: unknown): SaveConnectionRequest {
  if (!isRecord(value)) throw new TypeError('Connection request is invalid');
  const allowedKeys = new Set([
    'packageId',
    'templateId',
    'name',
    'endpoint',
    'credentials',
    'explicitLoopbackHttpConsent'
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Connection request contains unsupported fields');
  }
  if (!isRecord(value.credentials)) {
    throw new TypeError('Connection credentials are invalid');
  }
  const credentials: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value.credentials)) {
    if (typeof fieldValue !== 'string') {
      throw new TypeError('Connection credential field is invalid');
    }
    credentials[key] = fieldValue;
  }
  if (
    value.endpoint !== undefined &&
    (typeof value.endpoint !== 'string' || value.endpoint.length > 2_048)
  ) {
    throw new TypeError('Connection endpoint is invalid');
  }
  if (
    value.explicitLoopbackHttpConsent !== undefined &&
    typeof value.explicitLoopbackHttpConsent !== 'boolean'
  ) {
    throw new TypeError('Loopback HTTP confirmation is invalid');
  }
  return {
    packageId: requireIdentifier(value.packageId),
    templateId: requireIdentifier(value.templateId),
    name: requireName(value.name),
    endpoint: value.endpoint,
    credentials,
    explicitLoopbackHttpConsent: value.explicitLoopbackHttpConsent === true
  };
}

function validateCredentialValues(
  schema: CredentialSchema,
  values: Readonly<Record<string, string>>
): StructuredCredentialRecord {
  const fieldsByKey = new Map(schema.fields.map((field) => [field.key, field]));
  if (Object.keys(values).some((key) => !fieldsByKey.has(key))) {
    throw new CredentialContractError('Credential contains an unsupported field');
  }
  const normalized: Record<string, string> = {};
  for (const field of schema.fields) {
    const value = values[field.key];
    if (value === undefined) {
      if (field.required) {
        throw new CredentialContractError('A required credential field is missing');
      }
      continue;
    }
    if (value.length < 1 || value.length > 65_536) {
      throw new CredentialContractError('Credential field value is invalid');
    }
    normalized[field.key] = value;
  }
  return {
    schemaId: schema.schemaId,
    schemaVersion: schema.version,
    values: normalized
  };
}

function resolveProvider(
  snapshot: ProviderRegistrySnapshot,
  resolved: ResolvedProviderTemplate
): Provider {
  const matching = snapshot.providers.filter(
    (provider) => provider.packageId === resolved.package.packageId
  );
  if (matching.length > 1) {
    throw new ProviderPackageConflictError();
  }
  const current = matching[0];
  if (current) {
    if (current.packageVersion !== resolved.package.packageVersion) {
      throw new ProviderPackageConflictError();
    }
    return current;
  }
  const now = toIsoTimestamp(new Date().toISOString());
  return createProvider({
    id: toProviderId(`provider-${randomUUID()}`),
    name: resolved.package.displayName,
    packageId: resolved.package.packageId,
    packageVersion: resolved.package.packageVersion,
    accessCategory:
      resolved.template.kind === 'official' ? 'online' : 'custom_remote',
    identityState: 'unverified',
    createdAt: now,
    updatedAt: now
  });
}

function createPackageOwnedConnection(input: {
  readonly provider: Provider;
  readonly resolved: ResolvedProviderTemplate;
  readonly endpoint?: string;
  readonly name: string;
  readonly credentialReference: string;
  readonly credentialVersionId: string;
  readonly now: ReturnType<typeof toIsoTimestamp>;
}): ProviderConnection {
  const { provider, resolved } = input;
  return createProviderConnection({
    id: toConnectionId(`connection-${randomUUID()}`),
    providerId: provider.id,
    name: input.name,
    endpoint: input.endpoint,
    packageId: resolved.package.packageId,
    packageVersion: resolved.package.packageVersion,
    templateId: resolved.template.templateId,
    templateKind: resolved.template.kind,
    credentialSchemaId: resolved.credentialSchema.schemaId,
    credentialSchemaVersion: resolved.credentialSchema.version,
    credentialVersionId: input.credentialVersionId,
    connectionPolicyId: resolved.template.connectionPolicyId,
    connectionPolicyRevision: resolved.template.connectionPolicyRevision,
    discoveryPolicyId: resolved.template.discoveryPolicyId,
    discoveryPolicyRevision: resolved.template.discoveryPolicyRevision,
    endpointPolicyId: resolved.endpointPolicy.policyId,
    endpointPolicyRevision: resolved.endpointPolicy.revision,
    connectionConfigVersionId: `connection-config-${randomUUID()}`,
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
    credentialReference: input.credentialReference,
    createdAt: input.now,
    updatedAt: input.now
  });
}

class CredentialContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialContractError';
  }
}

class ProviderPackageConflictError extends Error {
  constructor() {
    super('Provider package ownership conflicts with the local registry');
    this.name = 'ProviderPackageConflictError';
  }
}

function failure(error: unknown): ProviderConnectionContractResult {
  if (error instanceof ProviderPackageContractError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof CredentialContractError) {
    return { ok: false, error: { code: 'credential_invalid', message: error.message } };
  }
  if (error instanceof ProviderPackageConflictError) {
    return {
      ok: false,
      error: { code: 'provider_package_conflict', message: error.message }
    };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: 'Connection request is invalid' }
    };
  }
  return {
    ok: false,
    error: {
      code: 'connection_save_failed',
      message: 'Provider connection could not be saved atomically'
    }
  };
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    throw new TypeError('Connection identifier is invalid');
  }
  return value;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 200) {
    throw new TypeError('Connection name is invalid');
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
