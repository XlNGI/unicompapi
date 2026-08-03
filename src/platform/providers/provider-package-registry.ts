import { isIP } from 'node:net';
import type {
  CredentialFieldSchema,
  CredentialSchema,
  EndpointPolicy,
  ProviderAdapterDescriptor,
  ProviderPackageDescriptor,
  ProviderTemplateDescriptor,
  SafeProviderTemplateDto
} from '../../domain';

export interface ResolvedProviderTemplate {
  readonly package: ProviderPackageDescriptor;
  readonly template: ProviderTemplateDescriptor;
  readonly credentialSchema: CredentialSchema;
  readonly endpointPolicy: EndpointPolicy;
  readonly adapters: readonly ProviderAdapterDescriptor[];
}

export class ProviderPackageContractError extends Error {
  constructor(
    readonly code:
      | 'package_contract_invalid'
      | 'package_not_found'
      | 'template_not_found'
      | 'adapter_not_found'
      | 'endpoint_not_allowed',
    message: string
  ) {
    super(message);
    this.name = 'ProviderPackageContractError';
  }
}

export class ProviderPackageRegistry {
  private readonly packages: ReadonlyMap<string, ProviderPackageDescriptor>;

  constructor(descriptors: readonly ProviderPackageDescriptor[]) {
    const packages = descriptors.map(parsePackage);
    assertUnique(packages.map((item) => item.packageId), 'package');
    this.packages = new Map(packages.map((item) => [item.packageId, item]));
  }

  listSafeTemplates(): readonly SafeProviderTemplateDto[] {
    return [...this.packages.values()].flatMap((providerPackage) =>
      providerPackage.templates.map((template) => {
        const credentialSchema = findVersioned(
          providerPackage.credentialSchemas,
          'schemaId',
          template.credentialSchemaId,
          'version',
          template.credentialSchemaVersion
        );
        if (!credentialSchema) {
          throw invalidContract('Template credential schema is unavailable');
        }
        return {
          packageId: providerPackage.packageId,
          packageVersion: providerPackage.packageVersion,
          providerName: providerPackage.displayName,
          templateId: template.templateId,
          kind: template.kind,
          displayName: template.displayName,
          iconAssetId: template.iconAssetId,
          baseUrlMode: template.baseUrlMode,
          credentialFields: credentialSchema.fields.map((field) => ({ ...field })),
          freeConnectionValidation: template.freeConnectionValidation,
          modelDiscoveryKind: template.modelDiscoveryKind
        };
      })
    );
  }

  resolveTemplate(packageId: string, templateId: string): ResolvedProviderTemplate {
    const providerPackage = this.packages.get(requireStableId(packageId, 'packageId'));
    if (!providerPackage) {
      throw new ProviderPackageContractError(
        'package_not_found',
        'Provider package is not registered'
      );
    }
    const template = providerPackage.templates.find(
      (item) => item.templateId === requireStableId(templateId, 'templateId')
    );
    if (!template) {
      throw new ProviderPackageContractError(
        'template_not_found',
        'Provider template does not belong to the selected package'
      );
    }
    const credentialSchema = findVersioned(
      providerPackage.credentialSchemas,
      'schemaId',
      template.credentialSchemaId,
      'version',
      template.credentialSchemaVersion
    );
    const endpointPolicy = findVersioned(
      providerPackage.endpointPolicies,
      'policyId',
      template.endpointPolicyId,
      'revision',
      template.endpointPolicyRevision
    );
    if (!credentialSchema || !endpointPolicy) {
      throw invalidContract('Provider template policy reference is unavailable');
    }
    const adapters = template.adapterBindings.map((binding) => {
      const adapter = findVersioned(
        providerPackage.adapters,
        'adapterId',
        binding.adapterId,
        'adapterVersion',
        binding.adapterVersion
      );
      if (!adapter) {
        throw new ProviderPackageContractError(
          'adapter_not_found',
          'Provider adapter is not registered for the selected template'
        );
      }
      return adapter;
    });
    return { package: providerPackage, template, credentialSchema, endpointPolicy, adapters };
  }

  resolveAdapter(
    packageId: string,
    adapterId: string,
    adapterVersion: string,
    protocolId: string,
    protocolVersion: string
  ): ProviderAdapterDescriptor {
    const providerPackage = this.packages.get(requireStableId(packageId, 'packageId'));
    if (!providerPackage) {
      throw new ProviderPackageContractError(
        'package_not_found',
        'Provider package is not registered'
      );
    }
    const adapter = findVersioned(
      providerPackage.adapters,
      'adapterId',
      requireStableId(adapterId, 'adapterId'),
      'adapterVersion',
      requireVersionString(adapterVersion, 'adapterVersion')
    );
    if (
      !adapter ||
      adapter.protocolId !== requireStableId(protocolId, 'protocolId') ||
      adapter.protocolVersion !== requireVersionString(protocolVersion, 'protocolVersion')
    ) {
      throw new ProviderPackageContractError(
        'adapter_not_found',
        'Provider adapter protocol binding is not registered'
      );
    }
    return adapter;
  }

  resolveEndpoint(
    resolved: ResolvedProviderTemplate,
    endpoint: string | undefined,
    explicitLoopbackHttpConsent: boolean
  ): string | undefined {
    const { template, endpointPolicy } = resolved;
    if (template.baseUrlMode === 'fixed') {
      if (endpoint !== undefined) {
        throw endpointDenied('A fixed provider endpoint cannot be overridden');
      }
      if (!endpointPolicy.fixedBaseUrl) {
        throw invalidContract('Fixed provider endpoint is unavailable');
      }
      return validateEndpoint(
        endpointPolicy.fixedBaseUrl,
        endpointPolicy,
        explicitLoopbackHttpConsent
      );
    }
    if (endpoint === undefined) {
      if (template.baseUrlMode === 'required') {
        throw endpointDenied('A base URL is required for this provider template');
      }
      return undefined;
    }
    return validateEndpoint(endpoint, endpointPolicy, explicitLoopbackHttpConsent);
  }
}

function parsePackage(value: ProviderPackageDescriptor): ProviderPackageDescriptor {
  if (!isRecord(value)) throw invalidContract('Provider package is invalid');
  const providerPackage: ProviderPackageDescriptor = {
    packageId: requireStableId(value.packageId, 'packageId'),
    packageVersion: requireVersionString(value.packageVersion, 'packageVersion'),
    displayName: requireDisplayName(value.displayName, 'package displayName'),
    templates: requireArray<ProviderTemplateDescriptor>(
      value.templates,
      'templates'
    ).map(parseTemplate),
    credentialSchemas: requireArray<CredentialSchema>(
      value.credentialSchemas,
      'credentialSchemas'
    ).map(parseCredentialSchema),
    endpointPolicies: requireArray<EndpointPolicy>(
      value.endpointPolicies,
      'endpointPolicies'
    ).map(parseEndpointPolicy),
    adapters: requireArray<ProviderAdapterDescriptor>(
      value.adapters,
      'adapters'
    ).map(parseAdapter)
  };
  assertUnique(providerPackage.templates.map((item) => item.templateId), 'template');
  assertUnique(
    providerPackage.credentialSchemas.map((item) => `${item.schemaId}@${item.version}`),
    'credential schema version'
  );
  assertUnique(
    providerPackage.endpointPolicies.map((item) => `${item.policyId}@${item.revision}`),
    'endpoint policy revision'
  );
  assertUnique(
    providerPackage.adapters.map((item) => `${item.adapterId}@${item.adapterVersion}`),
    'adapter version'
  );
  assertUnique(
    providerPackage.adapters.map((item) => `${item.protocolId}@${item.protocolVersion}`),
    'adapter protocol version'
  );
  for (const template of providerPackage.templates) {
    const schema = findVersioned(
      providerPackage.credentialSchemas,
      'schemaId',
      template.credentialSchemaId,
      'version',
      template.credentialSchemaVersion
    );
    const policy = findVersioned(
      providerPackage.endpointPolicies,
      'policyId',
      template.endpointPolicyId,
      'revision',
      template.endpointPolicyRevision
    );
    if (!schema || !policy) {
      throw invalidContract('Provider template references an unknown policy');
    }
    for (const binding of template.adapterBindings) {
      if (
        !findVersioned(
          providerPackage.adapters,
          'adapterId',
          binding.adapterId,
          'adapterVersion',
          binding.adapterVersion
        )
      ) {
        throw invalidContract('Provider template references an unknown adapter');
      }
    }
    if (
      (template.kind === 'official') !== (template.baseUrlMode === 'fixed') ||
      (template.kind === 'official') !== (policy.fixedBaseUrl !== undefined)
    ) {
      throw invalidContract('Official and compatible endpoint modes are inconsistent');
    }
  }
  return providerPackage;
}

function parseTemplate(value: ProviderTemplateDescriptor): ProviderTemplateDescriptor {
  if (!isRecord(value)) throw invalidContract('Provider template is invalid');
  if (value.kind !== 'official' && value.kind !== 'compatible_custom') {
    throw invalidContract('Provider template kind is invalid');
  }
  if (!['fixed', 'optional', 'required'].includes(String(value.baseUrlMode))) {
    throw invalidContract('Provider template base URL mode is invalid');
  }
  if (!['none', 'catalog', 'manual_exact'].includes(String(value.modelDiscoveryKind))) {
    throw invalidContract('Provider template discovery kind is invalid');
  }
  if (
    typeof value.freeConnectionValidation !== 'boolean' ||
    !Array.isArray(value.adapterBindings) ||
    value.adapterBindings.length === 0
  ) {
    throw invalidContract('Provider template adapter bindings are invalid');
  }
  const adapterBindings = value.adapterBindings.map((binding) => {
    if (!isRecord(binding)) throw invalidContract('Template adapter binding is invalid');
    return {
      adapterId: requireStableId(binding.adapterId, 'adapterId'),
      adapterVersion: requireVersionString(binding.adapterVersion, 'adapterVersion')
    };
  });
  assertUnique(
    adapterBindings.map((item) => `${item.adapterId}@${item.adapterVersion}`),
    'template adapter binding'
  );
  return {
    templateId: requireStableId(value.templateId, 'templateId'),
    kind: value.kind,
    displayName: requireDisplayName(value.displayName, 'template displayName'),
    iconAssetId:
      value.iconAssetId === undefined
        ? undefined
        : requireStableId(value.iconAssetId, 'iconAssetId'),
    baseUrlMode: value.baseUrlMode,
    credentialSchemaId: requireStableId(value.credentialSchemaId, 'credentialSchemaId'),
    credentialSchemaVersion: requirePositiveInteger(
      value.credentialSchemaVersion,
      'credentialSchemaVersion'
    ),
    connectionPolicyId: requireStableId(value.connectionPolicyId, 'connectionPolicyId'),
    connectionPolicyRevision: requirePositiveInteger(
      value.connectionPolicyRevision,
      'connectionPolicyRevision'
    ),
    discoveryPolicyId: requireStableId(value.discoveryPolicyId, 'discoveryPolicyId'),
    discoveryPolicyRevision: requirePositiveInteger(
      value.discoveryPolicyRevision,
      'discoveryPolicyRevision'
    ),
    endpointPolicyId: requireStableId(value.endpointPolicyId, 'endpointPolicyId'),
    endpointPolicyRevision: requirePositiveInteger(
      value.endpointPolicyRevision,
      'endpointPolicyRevision'
    ),
    adapterBindings,
    freeConnectionValidation: value.freeConnectionValidation,
    modelDiscoveryKind: value.modelDiscoveryKind
  };
}

function parseCredentialSchema(value: CredentialSchema): CredentialSchema {
  if (!isRecord(value) || !Array.isArray(value.fields)) {
    throw invalidContract('Credential schema is invalid');
  }
  const fields = value.fields.map(parseCredentialField);
  assertUnique(fields.map((item) => item.key), 'credential field');
  return {
    schemaId: requireStableId(value.schemaId, 'schemaId'),
    version: requirePositiveInteger(value.version, 'credential schema version'),
    fields
  };
}

function parseCredentialField(value: CredentialFieldSchema): CredentialFieldSchema {
  if (
    !isRecord(value) ||
    !['token', 'access_key', 'secret_key', 'string'].includes(String(value.kind)) ||
    typeof value.secret !== 'boolean' ||
    typeof value.required !== 'boolean'
  ) {
    throw invalidContract('Credential field is invalid');
  }
  if (value.kind !== 'string' && !value.secret) {
    throw invalidContract('Credential key material must be secret');
  }
  return {
    key: requireStableId(value.key, 'credential field key'),
    label: requireDisplayName(value.label, 'credential field label'),
    secret: value.secret,
    required: value.required,
    kind: value.kind
  };
}

function parseAdapter(value: ProviderAdapterDescriptor): ProviderAdapterDescriptor {
  if (!isRecord(value) || !Array.isArray(value.operations) || value.operations.length === 0) {
    throw invalidContract('Provider adapter is invalid');
  }
  const allowed = new Set([
    'validate_connection',
    'discover_models',
    'submit',
    'query',
    'cancel',
    'receive_result'
  ]);
  if (value.operations.some((operation) => !allowed.has(operation))) {
    throw invalidContract('Provider adapter operation is invalid');
  }
  assertUnique(value.operations, 'adapter operation');
  return {
    adapterId: requireStableId(value.adapterId, 'adapterId'),
    adapterVersion: requireVersionString(value.adapterVersion, 'adapterVersion'),
    protocolId: requireStableId(value.protocolId, 'protocolId'),
    protocolVersion: requireVersionString(value.protocolVersion, 'protocolVersion'),
    operations: [...value.operations]
  };
}

function parseEndpointPolicy(value: EndpointPolicy): EndpointPolicy {
  if (!isRecord(value)) throw invalidContract('Endpoint policy is invalid');
  const allowedSchemes = requireArray<'https' | 'http'>(
    value.allowedSchemes,
    'allowedSchemes'
  );
  if (
    allowedSchemes.length === 0 ||
    allowedSchemes.some((scheme) => scheme !== 'https' && scheme !== 'http')
  ) {
    throw invalidContract('Endpoint schemes are invalid');
  }
  assertUnique(allowedSchemes, 'endpoint scheme');
  const allowedHosts = requireArray<string>(value.allowedHosts, 'allowedHosts').map(
    (host) => requireHostPattern(host)
  );
  if (allowedHosts.length === 0) throw invalidContract('Endpoint hosts are empty');
  assertUnique(allowedHosts, 'endpoint host');
  const allowedPorts = requireArray<number>(value.allowedPorts, 'allowedPorts').map((port) => {
    if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw invalidContract('Endpoint port is invalid');
    }
    return Number(port);
  });
  assertUnique(allowedPorts, 'endpoint port');
  const allowedPathPrefixes = requireArray<string>(
    value.allowedPathPrefixes,
    'allowedPathPrefixes'
  ).map(requirePathPrefix);
  if (allowedPathPrefixes.length === 0) {
    throw invalidContract('Endpoint path prefixes are empty');
  }
  assertUnique(allowedPathPrefixes, 'endpoint path prefix');
  if (
    !['deny', 'same_origin'].includes(String(value.redirectPolicy)) ||
    !['deny', 'system'].includes(String(value.proxyPolicy)) ||
    typeof value.allowLoopback !== 'boolean' ||
    typeof value.allowPrivateNetwork !== 'boolean' ||
    typeof value.allowLoopbackHttp !== 'boolean' ||
    value.dnsRebindingProtection !== 'required'
  ) {
    throw invalidContract('Endpoint security policy is invalid');
  }
  if (allowedSchemes.includes('http') && !value.allowLoopbackHttp) {
    throw invalidContract('HTTP requires an explicit loopback-only policy');
  }
  const policy: EndpointPolicy = {
    policyId: requireStableId(value.policyId, 'endpoint policy ID'),
    revision: requirePositiveInteger(value.revision, 'endpoint policy revision'),
    allowedSchemes: [...allowedSchemes],
    allowedHosts,
    allowedPorts,
    allowedPathPrefixes,
    redirectPolicy: value.redirectPolicy,
    proxyPolicy: value.proxyPolicy,
    allowLoopback: value.allowLoopback,
    allowPrivateNetwork: value.allowPrivateNetwork,
    allowLoopbackHttp: value.allowLoopbackHttp,
    dnsRebindingProtection: 'required',
    fixedBaseUrl:
      value.fixedBaseUrl === undefined
        ? undefined
        : requireEndpointString(value.fixedBaseUrl)
  };
  if (policy.fixedBaseUrl) validateEndpoint(policy.fixedBaseUrl, policy, false);
  return policy;
}

function validateEndpoint(
  value: string,
  policy: EndpointPolicy,
  explicitLoopbackHttpConsent: boolean
): string {
  const raw = requireEndpointString(value);
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw endpointDenied('Provider endpoint is not a valid absolute URL');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw endpointDenied('Provider endpoint contains forbidden URL components');
  }
  const scheme = endpoint.protocol.slice(0, -1);
  if (!policy.allowedSchemes.includes(scheme as 'https' | 'http')) {
    throw endpointDenied('Provider endpoint scheme is not allowed');
  }
  const host = endpoint.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!policy.allowedHosts.some((pattern) => hostMatches(host, pattern))) {
    throw endpointDenied('Provider endpoint host is not allowed');
  }
  const classification = classifyHost(host);
  if (classification === 'loopback' && !policy.allowLoopback) {
    throw endpointDenied('Provider endpoint loopback access is not allowed');
  }
  if (classification === 'private' && !policy.allowPrivateNetwork) {
    throw endpointDenied('Provider endpoint private-network access is not allowed');
  }
  if (
    scheme === 'http' &&
    (classification !== 'loopback' ||
      !policy.allowLoopbackHttp ||
      !explicitLoopbackHttpConsent)
  ) {
    throw endpointDenied('HTTP is allowed only for an explicitly confirmed loopback endpoint');
  }
  const port = endpoint.port ? Number(endpoint.port) : scheme === 'https' ? 443 : 80;
  if (policy.allowedPorts.length > 0 && !policy.allowedPorts.includes(port)) {
    throw endpointDenied('Provider endpoint port is not allowed');
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(endpoint.pathname);
  } catch {
    throw endpointDenied('Provider endpoint path is invalid');
  }
  if (
    decodedPath.split('/').includes('..') ||
    !policy.allowedPathPrefixes.some((prefix) => pathMatches(decodedPath, prefix))
  ) {
    throw endpointDenied('Provider endpoint path is not allowed');
  }
  return endpoint.toString();
}

function classifyHost(host: string): 'public' | 'private' | 'loopback' {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    if (octets[0] === 127) return 'loopback';
    if (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[0] === 0
    ) {
      return 'private';
    }
  }
  if (family === 6) {
    const normalized = host.toLowerCase();
    if (normalized === '::1') return 'loopback';
    if (
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return 'private';
    }
  }
  return 'public';
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function requireHostPattern(value: unknown): string {
  if (typeof value !== 'string') throw invalidContract('Endpoint host is invalid');
  const normalized = value.trim().toLowerCase();
  if (
    normalized === '*' ||
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normalized
    ) ||
    isIP(normalized) !== 0
  ) {
    return normalized;
  }
  throw invalidContract('Endpoint host is invalid');
}

function requirePathPrefix(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    value.split('/').includes('..')
  ) {
    throw invalidContract('Endpoint path prefix is invalid');
  }
  return value.length > 1 ? value.replace(/\/$/, '') : value;
}

function requireStableId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    throw invalidContract(`${label} is invalid`);
  }
  return value;
}

function requireVersionString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 128) {
    throw invalidContract(`${label} is invalid`);
  }
  return value.trim();
}

function requireDisplayName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 200) {
    throw invalidContract(`${label} is invalid`);
  }
  return value.trim();
}

function requireEndpointString(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    throw endpointDenied('Provider endpoint is invalid');
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalidContract(`${label} is invalid`);
  }
  return Number(value);
}

function requireArray<T>(value: readonly T[] | unknown, label: string): readonly T[] {
  if (!Array.isArray(value)) throw invalidContract(`${label} must be an array`);
  return value as readonly T[];
}

function findVersioned<
  T extends Record<IdKey | VersionKey, string | number>,
  IdKey extends keyof T,
  VersionKey extends keyof T
>(
  values: readonly T[],
  idKey: IdKey,
  id: T[IdKey],
  versionKey: VersionKey,
  version: T[VersionKey]
): T | undefined {
  return values.find(
    (item) => item[idKey] === id && item[versionKey] === version
  );
}

function assertUnique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw invalidContract(`Provider package contains duplicate ${label} values`);
  }
}

function invalidContract(message: string): ProviderPackageContractError {
  return new ProviderPackageContractError('package_contract_invalid', message);
}

function endpointDenied(message: string): ProviderPackageContractError {
  return new ProviderPackageContractError('endpoint_not_allowed', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
