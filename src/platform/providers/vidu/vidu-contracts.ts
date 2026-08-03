import {
  createUsageSchema,
  toUsageSchemaId,
  type ParameterFieldSchemaV2,
  type ParameterSchemaV2,
  type ProviderModelDefinition,
  type ProviderPackageDescriptor,
  type UsageSchemaV1
} from '../../../domain';

export const VIDU_PROVIDER_PACKAGE_ID = 'provider-package-vidu-v1';
export const VIDU_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const VIDU_OFFICIAL_TEMPLATE_ID = 'vidu-official';
export const VIDU_CREDENTIAL_SCHEMA_ID = 'credential.vidu.token';
export const VIDU_ENDPOINT_POLICY_ID = 'endpoint.vidu.official';
export const VIDU_OFFICIAL_BASE_URL = 'https://api.vidu.cn';

export const VIDU_IMAGE_V1_ADAPTER_ID = 'vidu_image_v1';
export const VIDU_IMAGE_V1_ADAPTER_VERSION = '2026-08-03';
export const VIDU_IMAGE_V1_PROTOCOL_ID = 'vidu.ent.v1.images';
export const VIDU_IMAGE_V1_PROTOCOL_VERSION = '1';
export const VIDU_IMAGE_V1_SOURCE_DOCUMENT_REVISION =
  'vidu-image-v1-c2-evidence@2026-07-29';

export const VIDU_GEMINI_IMAGE_V2_ADAPTER_ID = 'vidu_gemini_image_v2';
export const VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION = '2026-08-03';
export const VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID =
  'vidu.ent.v2.image.reference2image';
export const VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION = '2';
export const VIDU_GEMINI_IMAGE_V2_SOURCE_DOCUMENT_REVISION =
  'vidu-gemini-image-v2-c2-evidence@2026-07-29';

export const VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID =
  'vidu_reference_video_v2';
export const VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION = '2026-08-03';
export const VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID =
  'vidu.ent.v2.reference2video';
export const VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION = '2';
export const VIDU_REFERENCE_VIDEO_V2_SOURCE_DOCUMENT_REVISION =
  'vidu-reference-video-v2-c2-evidence@2026-07-29';

export const VIDU_IMAGE_V1_RESULT_SCHEMA_ID = 'results.vidu.image-v1';
export const VIDU_GEMINI_IMAGE_V2_RESULT_SCHEMA_ID =
  'results.vidu.gemini-image-v2';
export const VIDU_REFERENCE_VIDEO_V2_RESULT_SCHEMA_ID =
  'results.vidu.reference-video-v2';
export const VIDU_USAGE_SCHEMA_ID = 'usage.vidu.not-reported';

export const VIDU_TEXT_IMAGE_CONSTRAINT_SET_ID =
  'constraints.vidu.text-only-single-output';
export const VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID =
  'constraints.vidu.single-controlled-image-single-output';
export const VIDU_IMAGE_VIDEO_CONSTRAINT_SET_ID =
  'constraints.vidu.single-controlled-first-frame-single-output';

export const frozenViduVideoModelKeys = [
  'viduq3-drama',
  'viduq3-ad',
  'viduq3-mix',
  'viduq3-turbo',
  'viduq3'
] as const;

export const frozenViduGeminiImageModelKeys = [
  'q2-fast',
  'q2-pro',
  'q3-fast',
  'q3-lite'
] as const;

export const frozenViduModelKeys = [
  ...frozenViduVideoModelKeys,
  'viduimage-2',
  ...frozenViduGeminiImageModelKeys
] as const;

export type FrozenViduModelKey = (typeof frozenViduModelKeys)[number];

export interface ViduModelContractV1 {
  readonly definition: ProviderModelDefinition;
  readonly parameterSchemas: readonly ParameterSchemaV2[];
  readonly defaultProfileStatus: 'restricted' | 'disabled';
}

export const viduUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(VIDU_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'provider_status_only',
  conflictPolicy: 'mark_invalid_response',
  metrics: []
});

export const viduProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: VIDU_PROVIDER_PACKAGE_ID,
  packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
  displayName: 'Vidu',
  credentialSchemas: [
    {
      schemaId: VIDU_CREDENTIAL_SCHEMA_ID,
      version: 1,
      fields: [
        {
          key: 'token',
          label: 'Vidu Token',
          secret: true,
          required: true,
          kind: 'token'
        }
      ]
    }
  ],
  endpointPolicies: [
    {
      policyId: VIDU_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: ['api.vidu.cn'],
      allowedPorts: [443],
      allowedPathPrefixes: ['/'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: VIDU_OFFICIAL_BASE_URL
    }
  ],
  adapters: [
    {
      adapterId: VIDU_IMAGE_V1_ADAPTER_ID,
      adapterVersion: VIDU_IMAGE_V1_ADAPTER_VERSION,
      protocolId: VIDU_IMAGE_V1_PROTOCOL_ID,
      protocolVersion: VIDU_IMAGE_V1_PROTOCOL_VERSION,
      operations: ['submit', 'receive_result']
    },
    {
      adapterId: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      adapterVersion: VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
      protocolId: VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
      operations: ['submit', 'receive_result']
    },
    {
      adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
      operations: ['submit', 'query', 'cancel', 'receive_result']
    }
  ],
  templates: [
    {
      templateId: VIDU_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      displayName: 'Vidu Official',
      baseUrlMode: 'fixed',
      credentialSchemaId: VIDU_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.vidu.official',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.vidu.packaged-catalog',
      discoveryPolicyRevision: 1,
      endpointPolicyId: VIDU_ENDPOINT_POLICY_ID,
      endpointPolicyRevision: 1,
      adapterBindings: [
        {
          adapterId: VIDU_IMAGE_V1_ADAPTER_ID,
          adapterVersion: VIDU_IMAGE_V1_ADAPTER_VERSION
        },
        {
          adapterId: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
          adapterVersion: VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION
        },
        {
          adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
          adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION
        }
      ],
      freeConnectionValidation: false,
      modelDiscoveryKind: 'none'
    }
  ]
};

export function createViduModelContract(
  providerModelKey: string
): ViduModelContractV1 {
  const exactKey = requireFrozenModelKey(providerModelKey);
  if (exactKey === 'viduimage-2') return imageV1Contract(exactKey);
  if (isGeminiImageKey(exactKey)) return geminiImageContract(exactKey);
  return referenceVideoContract(exactKey);
}

export const viduPackagedModelContracts: readonly ViduModelContractV1[] =
  frozenViduModelKeys.map(createViduModelContract);

export const viduPackagedParameterSchemas: readonly ParameterSchemaV2[] =
  viduPackagedModelContracts.flatMap((contract) => contract.parameterSchemas);

function imageV1Contract(providerModelKey: 'viduimage-2'): ViduModelContractV1 {
  const commonFields: readonly ParameterFieldSchemaV2[] = [
    optionalString('background', 10),
    optionalInteger('output_compression', 20, 0, 100),
    optionalString('output_format', 30),
    optionalString('quality', 40),
    optionalString('response_format', 50),
    optionalString('size', 60)
  ];
  const generationSchemaId = `parameters.vidu.image-v1.text-to-image.${providerModelKey}`;
  const editSchemaId = `parameters.vidu.image-v1.image-edit.${providerModelKey}`;
  return {
    definition: definition(
      providerModelKey,
      VIDU_IMAGE_V1_ADAPTER_ID,
      VIDU_IMAGE_V1_PROTOCOL_ID,
      VIDU_IMAGE_V1_SOURCE_DOCUMENT_REVISION,
      [
        feature(
          'text_to_image',
          'image_generation',
          generationSchemaId,
          VIDU_IMAGE_V1_RESULT_SCHEMA_ID,
          VIDU_TEXT_IMAGE_CONSTRAINT_SET_ID
        ),
        feature(
          'image_edit',
          'image_editing',
          editSchemaId,
          VIDU_IMAGE_V1_RESULT_SCHEMA_ID,
          VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID
        )
      ]
    ),
    parameterSchemas: [
      schema(generationSchemaId, 'text_to_image', commonFields),
      schema(editSchemaId, 'image_edit', [
        ...commonFields,
        optionalString('input_fidelity', 70)
      ])
    ],
    defaultProfileStatus: 'disabled'
  };
}

function geminiImageContract(
  providerModelKey: (typeof frozenViduGeminiImageModelKeys)[number]
): ViduModelContractV1 {
  const schemaId = `parameters.vidu.gemini-image-v2.reference-to-image.${providerModelKey}`;
  return {
    definition: definition(
      providerModelKey,
      VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
      VIDU_GEMINI_IMAGE_V2_SOURCE_DOCUMENT_REVISION,
      [feature(
        'reference_to_image',
        'reference_to_image',
        schemaId,
        VIDU_GEMINI_IMAGE_V2_RESULT_SCHEMA_ID,
        VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID
      )]
    ),
    parameterSchemas: [schema(schemaId, 'reference_to_image', [
      optionalString('aspectRatio', 10),
      optionalString('imageSize', 20)
    ])],
    defaultProfileStatus: 'restricted'
  };
}

function referenceVideoContract(
  providerModelKey: (typeof frozenViduVideoModelKeys)[number]
): ViduModelContractV1 {
  const schemaId = `parameters.vidu.reference-video-v2.image-to-video.${providerModelKey}`;
  const range = durationRange(providerModelKey);
  return {
    definition: definition(
      providerModelKey,
      VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      VIDU_REFERENCE_VIDEO_V2_SOURCE_DOCUMENT_REVISION,
      [feature(
        'image_to_video',
        'reference_to_video',
        schemaId,
        VIDU_REFERENCE_VIDEO_V2_RESULT_SCHEMA_ID,
        VIDU_IMAGE_VIDEO_CONSTRAINT_SET_ID
      )]
    ),
    parameterSchemas: [schema(schemaId, 'image_to_video', [
      optionalBoolean('audio', 10),
      optionalInteger('duration', 20, range.minimum, range.maximum, 'second'),
      optionalString('resolution', 30),
      optionalString('aspect_ratio', 40)
    ])],
    defaultProfileStatus: 'restricted'
  };
}

function definition(
  providerModelKey: FrozenViduModelKey,
  adapterKey: string,
  protocolDefinitionId: string,
  sourceDocumentRevision: string,
  features: ProviderModelDefinition['profileTemplates'][number]['features']
): ProviderModelDefinition {
  return {
    schemaVersion: 1,
    definitionId: `definition.vidu.${providerModelKey}`,
    packageId: VIDU_PROVIDER_PACKAGE_ID,
    packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
    providerModelKey,
    profileTemplates: [
      {
        templateId: `profile-template.vidu.${providerModelKey}`,
        adapterKey,
        protocolDefinitionId,
        sourceDocumentRevision,
        features
      }
    ]
  };
}

function feature(
  productFeature: ProviderModelDefinition['profileTemplates'][number]['features'][number]['productFeature'],
  internalPurpose: string,
  parameterSchemaId: string,
  resultSchemaId: string,
  constraintSetId: string
) {
  return {
    productFeature,
    internalPurpose,
    parameterSchemaId,
    resultSchemaId,
    usageSchemaId: VIDU_USAGE_SCHEMA_ID,
    constraintSetId
  };
}

function schema(
  schemaId: string,
  productFeature: ParameterSchemaV2['productFeature'],
  fields: readonly ParameterFieldSchemaV2[]
): ParameterSchemaV2 {
  return { schemaVersion: 2, schemaId, revision: 1, productFeature, fields };
}

function optionalString(fieldId: string, order: number): ParameterFieldSchemaV2 {
  return optionalField(fieldId, order, 'string');
}

function optionalBoolean(fieldId: string, order: number): ParameterFieldSchemaV2 {
  return optionalField(fieldId, order, 'boolean');
}

function optionalInteger(
  fieldId: string,
  order: number,
  minimum: number,
  maximum: number,
  unitId?: string
): ParameterFieldSchemaV2 {
  return {
    ...optionalField(fieldId, order, 'integer'),
    minimum,
    maximum,
    ...(unitId ? { unitId } : {})
  };
}

function optionalField(
  fieldId: string,
  order: number,
  valueType: 'string' | 'integer' | 'boolean'
): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    order,
    valueType,
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false
  };
}

function durationRange(
  modelKey: (typeof frozenViduVideoModelKeys)[number]
): { readonly minimum: number; readonly maximum: number } {
  if (modelKey === 'viduq3-drama') return { minimum: 2, maximum: 15 };
  if (modelKey === 'viduq3') return { minimum: 3, maximum: 16 };
  return { minimum: 3, maximum: 15 };
}

function requireFrozenModelKey(value: string): FrozenViduModelKey {
  if (!frozenViduModelKeys.includes(value as FrozenViduModelKey)) {
    throw new TypeError('Vidu model contract requires an exact frozen model key');
  }
  return value as FrozenViduModelKey;
}

function isGeminiImageKey(
  value: FrozenViduModelKey
): value is (typeof frozenViduGeminiImageModelKeys)[number] {
  return frozenViduGeminiImageModelKeys.includes(
    value as (typeof frozenViduGeminiImageModelKeys)[number]
  );
}
