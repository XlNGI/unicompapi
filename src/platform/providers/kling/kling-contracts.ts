import { createHash } from 'node:crypto';
import {
  createUsageSchema,
  toUsageSchemaId,
  type ParameterFieldSchemaV2,
  type ParameterSchemaV2,
  type ProviderModelDefinition,
  type ProviderPackageDescriptor,
  type UsageSchemaV1
} from '../../../domain';

export const KLING_PROVIDER_PACKAGE_ID = 'provider-package-kling';
export const KLING_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const KLING_OFFICIAL_TEMPLATE_ID = 'kling-official';
export const KLING_CREDENTIAL_SCHEMA_ID = 'credential.kling.api-key';
export const KLING_ENDPOINT_POLICY_ID = 'endpoint.kling.official';
export const KLING_OFFICIAL_BASE_URL = 'https://api-beijing.klingai.com';

export const KLING_VIDEO_ADAPTER_ID = 'kling.video';
export const KLING_VIDEO_ADAPTER_VERSION = '2026-08-03';
export const KLING_VIDEO_PROTOCOL_ID = 'kling.api2.video-generation';
export const KLING_VIDEO_PROTOCOL_VERSION = '2026-08-03';
export const KLING_VIDEO_SOURCE_DOCUMENT_REVISION =
  'kling-api2-video-docs@2026-08-03';
export const KLING_VIDEO_RESULT_SCHEMA_ID = 'results.kling.video';
export const KLING_VIDEO_USAGE_SCHEMA_ID = 'usage.kling.video-billing';
export const KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.kling.text-only';
export const KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.kling.single-controlled-first-frame';

export const klingVideoUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(KLING_VIDEO_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    usageMetric('billing_entry_count', 'entry', 'integer', true),
    usageMetric('cash_amount', 'currency_amount', 'decimal', false),
    usageMetric('cash_list_price', 'currency_amount', 'decimal', false),
    usageMetric('package_unit_amount', 'provider_unit', 'decimal', false)
  ]
});

export interface KlingVideoFeatureDeclarationV1 {
  readonly resolutions?: readonly string[];
  readonly aspectRatios?: readonly string[];
  readonly durations?: readonly number[];
  readonly supportsWatermark?: boolean;
}

export interface KlingVideoProfileDeclarationV1 {
  readonly textToVideo?: KlingVideoFeatureDeclarationV1;
  readonly imageToVideo?: Omit<KlingVideoFeatureDeclarationV1, 'aspectRatios'>;
}

export interface KlingVideoModelContractV1 {
  readonly definition: ProviderModelDefinition;
  readonly parameterSchemas: readonly ParameterSchemaV2[];
}

export const klingProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: KLING_PROVIDER_PACKAGE_ID,
  packageVersion: KLING_PROVIDER_PACKAGE_VERSION,
  displayName: 'Kling AI',
  credentialSchemas: [
    {
      schemaId: KLING_CREDENTIAL_SCHEMA_ID,
      version: 1,
      fields: [
        {
          key: 'api_key',
          label: 'Kling API key',
          secret: true,
          required: true,
          kind: 'token'
        }
      ]
    }
  ],
  endpointPolicies: [
    {
      policyId: KLING_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: ['api-beijing.klingai.com'],
      allowedPorts: [443],
      allowedPathPrefixes: ['/'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: KLING_OFFICIAL_BASE_URL
    }
  ],
  adapters: [
    {
      adapterId: KLING_VIDEO_ADAPTER_ID,
      adapterVersion: KLING_VIDEO_ADAPTER_VERSION,
      protocolId: KLING_VIDEO_PROTOCOL_ID,
      protocolVersion: KLING_VIDEO_PROTOCOL_VERSION,
      operations: ['submit', 'query', 'cancel', 'receive_result']
    }
  ],
  templates: [
    {
      templateId: KLING_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      displayName: 'Kling AI Official',
      baseUrlMode: 'fixed',
      credentialSchemaId: KLING_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.kling.official',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.kling.manual-exact',
      discoveryPolicyRevision: 1,
      endpointPolicyId: KLING_ENDPOINT_POLICY_ID,
      endpointPolicyRevision: 1,
      adapterBindings: [
        {
          adapterId: KLING_VIDEO_ADAPTER_ID,
          adapterVersion: KLING_VIDEO_ADAPTER_VERSION
        }
      ],
      freeConnectionValidation: false,
      modelDiscoveryKind: 'manual_exact'
    }
  ]
};

export function createKlingVideoModelContract(
  providerModelKey: string,
  declaration: KlingVideoProfileDeclarationV1
): KlingVideoModelContractV1 {
  const exactKey = requireProviderModelKey(providerModelKey);
  const normalized = normalizeDeclaration(declaration);
  if (!normalized.textToVideo && !normalized.imageToVideo) {
    throw new TypeError('Kling Profile must declare at least one video feature');
  }
  const contractHash = createHash('sha256')
    .update(`${exactKey}\n${canonicalJson(normalized)}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  const parameterSchemas: ParameterSchemaV2[] = [];
  const features: ProviderModelDefinition['profileTemplates'][number]['features'][number][] = [];
  for (const [feature, featureDeclaration] of [
    ['text_to_video', normalized.textToVideo],
    ['image_to_video', normalized.imageToVideo]
  ] as const) {
    if (!featureDeclaration) continue;
    const parameterSchemaId = `parameters.kling.${feature}.${contractHash}`;
    parameterSchemas.push({
      schemaVersion: 2,
      schemaId: parameterSchemaId,
      revision: 1,
      productFeature: feature,
      fields: parameterFields(featureDeclaration, feature)
    });
    features.push({
      productFeature: feature,
      internalPurpose: feature === 'text_to_video'
        ? 'video_generation'
        : 'reference_to_video',
      parameterSchemaId,
      resultSchemaId: KLING_VIDEO_RESULT_SCHEMA_ID,
      usageSchemaId: KLING_VIDEO_USAGE_SCHEMA_ID,
      constraintSetId: feature === 'text_to_video'
        ? KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
        : KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
    });
  }
  return {
    definition: {
      schemaVersion: 1,
      definitionId: `definition.kling.video.${contractHash}`,
      packageId: KLING_PROVIDER_PACKAGE_ID,
      packageVersion: KLING_PROVIDER_PACKAGE_VERSION,
      providerModelKey: exactKey,
      profileTemplates: [
        {
          templateId: `profile-template.kling.video.${contractHash}`,
          adapterKey: KLING_VIDEO_ADAPTER_ID,
          protocolDefinitionId: KLING_VIDEO_PROTOCOL_ID,
          sourceDocumentRevision: KLING_VIDEO_SOURCE_DOCUMENT_REVISION,
          features
        }
      ]
    },
    parameterSchemas
  };
}

export function createKlingVideoModelDefinition(
  providerModelKey: string,
  declaration: KlingVideoProfileDeclarationV1
): ProviderModelDefinition {
  return createKlingVideoModelContract(providerModelKey, declaration).definition;
}

function normalizeDeclaration(
  declaration: KlingVideoProfileDeclarationV1
): KlingVideoProfileDeclarationV1 {
  if (!isPlainRecord(declaration as unknown)) {
    throw new TypeError('Kling Profile declaration is invalid');
  }
  if (Object.keys(declaration).some(
    (key) => !['textToVideo', 'imageToVideo'].includes(key)
  )) {
    throw new TypeError('Kling Profile declaration contains unknown fields');
  }
  return {
    ...(declaration.textToVideo
      ? { textToVideo: normalizeFeature(declaration.textToVideo, true) }
      : {}),
    ...(declaration.imageToVideo
      ? { imageToVideo: normalizeFeature(declaration.imageToVideo, false) }
      : {})
  };
}

function normalizeFeature(
  declaration: KlingVideoFeatureDeclarationV1,
  allowAspectRatio: boolean
): KlingVideoFeatureDeclarationV1 {
  if (!isPlainRecord(declaration as unknown)) {
    throw new TypeError('Kling feature declaration is invalid');
  }
  const allowed = new Set([
    'resolutions',
    'durations',
    'supportsWatermark',
    ...(allowAspectRatio ? ['aspectRatios'] : [])
  ]);
  if (Object.keys(declaration).some((key) => !allowed.has(key))) {
    throw new TypeError('Kling feature declaration contains unknown fields');
  }
  const supportsWatermark = declaration.supportsWatermark;
  if (supportsWatermark !== undefined && typeof supportsWatermark !== 'boolean') {
    throw new TypeError('Kling watermark declaration is invalid');
  }
  return {
    ...optionDeclaration(
      'resolutions',
      normalizeStringOptions(declaration.resolutions, 'resolution')
    ),
    ...(allowAspectRatio
      ? optionDeclaration(
          'aspectRatios',
          normalizeStringOptions(declaration.aspectRatios, 'aspect ratio')
        )
      : {}),
    ...optionDeclaration(
      'durations',
      normalizeIntegerOptions(declaration.durations, 'duration')
    ),
    ...(supportsWatermark === undefined ? {} : { supportsWatermark })
  };
}

function parameterFields(
  declaration: KlingVideoFeatureDeclarationV1,
  feature: 'text_to_video' | 'image_to_video'
): readonly ParameterFieldSchemaV2[] {
  const fields: ParameterFieldSchemaV2[] = [];
  let order = 10;
  const add = (field: Omit<ParameterFieldSchemaV2, 'order'>) => {
    fields.push({ ...field, order });
    order += 10;
  };
  if (declaration.resolutions) {
    add(enumField('resolution', declaration.resolutions));
  }
  if (feature === 'text_to_video' && declaration.aspectRatios) {
    add(enumField('aspect_ratio', declaration.aspectRatios));
  }
  if (declaration.durations) {
    add(enumField('duration', declaration.durations, 'second'));
  }
  if (declaration.supportsWatermark) {
    add({
      fieldId: 'watermark',
      labelId: 'provider.parameter.watermark',
      groupId: 'provider.parameter.generation',
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    });
  }
  return fields;
}

function enumField(
  fieldId: string,
  options: readonly (string | number)[],
  unitId?: string
): Omit<ParameterFieldSchemaV2, 'order'> {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    valueType: 'enum',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    options,
    ...(unitId ? { unitId } : {})
  };
}

function normalizeStringOptions(
  value: readonly string[] | undefined,
  label: string
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`Kling ${label} options are invalid`);
  }
  const normalized = value.map((item) => {
    if (
      typeof item !== 'string' ||
      item.trim() !== item ||
      item.length < 1 ||
      item.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(item)
    ) {
      throw new TypeError(`Kling ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`Kling ${label} options must be unique`);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeIntegerOptions(
  value: readonly number[] | undefined,
  label: string
): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`Kling ${label} options are invalid`);
  }
  const normalized = value.map((item) => {
    if (!Number.isSafeInteger(item) || item < 1) {
      throw new TypeError(`Kling ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`Kling ${label} options must be unique`);
  }
  return [...normalized].sort((left, right) => left - right);
}

function optionDeclaration<Key extends string, Value>(
  key: Key,
  value: Value | undefined
): { readonly [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]?: Value;
  };
}

function requireProviderModelKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)
  ) {
    throw new TypeError('Kling exact model endpoint key is invalid');
  }
  return normalized;
}

function usageMetric(
  metricId: string,
  unit: string,
  numericKind: 'integer' | 'decimal',
  requiredForComplete: boolean
) {
  return {
    metricId,
    allowedUnits: [unit],
    numericKind,
    aggregation: 'final_authoritative' as const,
    requiredForComplete,
    allowedStages: ['poll', 'result'] as const
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
