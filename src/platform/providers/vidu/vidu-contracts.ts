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

/** Official async reference2image (viduq2 / viduq1). Dual-track with legacy Gemini sync. */
export const VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID = 'vidu_reference_image_v2';
export const VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION = '2026-08-06';
export const VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID = 'vidu.ent.v2.reference2image';
export const VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION = '2';
export const VIDU_REFERENCE_IMAGE_V2_SOURCE_DOCUMENT_REVISION =
  'vidu-reference-image-v2-official@2026-08-06';

export const VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID =
  'vidu_reference_video_v2';
export const VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION = '2026-08-03';
export const VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID =
  'vidu.ent.v2.reference2video';
export const VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION = '2';
export const VIDU_REFERENCE_VIDEO_V2_SOURCE_DOCUMENT_REVISION =
  'vidu-reference-video-v2-c2-evidence@2026-07-29';

/** Official async text2video. https://platform.vidu.cn/docs/text-to-video */
export const VIDU_TEXT_VIDEO_V2_ADAPTER_ID = 'vidu_text_video_v2';
export const VIDU_TEXT_VIDEO_V2_ADAPTER_VERSION = '2026-08-06';
export const VIDU_TEXT_VIDEO_V2_PROTOCOL_ID = 'vidu.ent.v2.text2video';
export const VIDU_TEXT_VIDEO_V2_PROTOCOL_VERSION = '2';
export const VIDU_TEXT_VIDEO_V2_SOURCE_DOCUMENT_REVISION =
  'vidu-text-video-v2-official@2026-08-06';

export const VIDU_IMAGE_V1_RESULT_SCHEMA_ID = 'results.vidu.image-v1';
export const VIDU_GEMINI_IMAGE_V2_RESULT_SCHEMA_ID =
  'results.vidu.gemini-image-v2';
export const VIDU_REFERENCE_IMAGE_V2_RESULT_SCHEMA_ID =
  'results.vidu.reference-image-v2';
export const VIDU_REFERENCE_VIDEO_V2_RESULT_SCHEMA_ID =
  'results.vidu.reference-video-v2';
export const VIDU_TEXT_VIDEO_V2_RESULT_SCHEMA_ID =
  'results.vidu.text-video-v2';
export const VIDU_USAGE_SCHEMA_ID = 'usage.vidu.not-reported';

export const frozenViduOfficialImageModelKeys = ['viduq2', 'viduq1'] as const;
export const frozenViduLegacyGeminiImageModelKeys = [
  'q2-fast',
  'q2-pro',
  'q3-fast',
  'q3-lite'
] as const;

export const VIDU_TEXT_IMAGE_CONSTRAINT_SET_ID =
  'constraints.vidu.text-only-single-output';
export const VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID =
  'constraints.vidu.single-controlled-image-single-output';
export const VIDU_IMAGE_VIDEO_CONSTRAINT_SET_ID =
  'constraints.vidu.single-controlled-first-frame-single-output';
export const VIDU_TEXT_VIDEO_CONSTRAINT_SET_ID =
  'constraints.vidu.text-only-single-video-output';

/** Official text2video models that do not collide with packaged image keys. */
export const frozenViduTextVideoModelKeys = [
  'viduq3-pro',
  'viduq3-turbo'
] as const;

export const frozenViduReferenceVideoModelKeys = [
  'viduq3-drama',
  'viduq3-ad',
  'viduq3-mix',
  'viduq3-turbo',
  'viduq3'
] as const;

export const frozenViduVideoModelKeys = [
  'viduq3-drama',
  'viduq3-ad',
  'viduq3-mix',
  'viduq3-turbo',
  'viduq3',
  'viduq3-pro'
] as const;

export const frozenViduGeminiImageModelKeys = [
  ...frozenViduOfficialImageModelKeys,
  ...frozenViduLegacyGeminiImageModelKeys
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
  readonly defaultProfileStatus: 'verified' | 'restricted' | 'disabled';
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
      adapterId: VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
      operations: ['submit', 'receive_result']
    },
    {
      adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
      operations: [
        'validate_connection',
        'submit',
        'query',
        'cancel',
        'receive_result'
      ]
    },
    {
      adapterId: VIDU_TEXT_VIDEO_V2_ADAPTER_ID,
      adapterVersion: VIDU_TEXT_VIDEO_V2_ADAPTER_VERSION,
      protocolId: VIDU_TEXT_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_TEXT_VIDEO_V2_PROTOCOL_VERSION,
      // Connection validation stays on the reference video adapter identity.
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
          adapterId: VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
          adapterVersion: VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION
        },
        {
          adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
          adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION
        },
        {
          adapterId: VIDU_TEXT_VIDEO_V2_ADAPTER_ID,
          adapterVersion: VIDU_TEXT_VIDEO_V2_ADAPTER_VERSION
        }
      ],
      freeConnectionValidation: true,
      modelDiscoveryKind: 'manual_exact'
    }
  ]
};

export function createViduModelContract(
  providerModelKey: string
): ViduModelContractV1 {
  const exactKey = requireFrozenModelKey(providerModelKey);
  if (exactKey === 'viduimage-2') return imageV1Contract(exactKey);
  if (isGeminiImageKey(exactKey)) return geminiImageContract(exactKey);
  if (exactKey === 'viduq3-pro') return textVideoContract(exactKey);
  if (exactKey === 'viduq3-turbo') return dualVideoContract(exactKey);
  return referenceVideoContract(
    exactKey as (typeof frozenViduReferenceVideoModelKeys)[number]
  );
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
    defaultProfileStatus: 'verified'
  };
}

function geminiImageContract(
  providerModelKey: (typeof frozenViduGeminiImageModelKeys)[number]
): ViduModelContractV1 {
  // Official reference2image models: https://platform.vidu.cn/docs/reference-to-image
  // viduq2 supports text-to-image (0 images), reference-to-image, and image edit.
  // viduq1 supports reference-to-image only (1–7 images).
  if (providerModelKey === 'viduq2') {
    const textSchemaId =
      `parameters.vidu.reference-image-v2.text-to-image.${providerModelKey}`;
    const referenceSchemaId =
      `parameters.vidu.reference-image-v2.reference-to-image.${providerModelKey}`;
    const editSchemaId =
      `parameters.vidu.reference-image-v2.image-edit.${providerModelKey}`;
    const commonFields: readonly ParameterFieldSchemaV2[] = [
      optionalEnum('aspect_ratio', 10, [
        '16:9',
        '9:16',
        '1:1',
        '3:4',
        '4:3',
        '21:9',
        '2:3',
        '3:2',
        'auto'
      ]),
      optionalEnum('resolution', 20, ['1080p', '2K', '4K']),
      optionalInteger('seed', 30, 0, 2_147_483_647)
    ];
    return {
      definition: definition(
        providerModelKey,
        VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
        VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
        VIDU_REFERENCE_IMAGE_V2_SOURCE_DOCUMENT_REVISION,
        [
          feature(
            'text_to_image',
            'image_generation',
            textSchemaId,
            VIDU_REFERENCE_IMAGE_V2_RESULT_SCHEMA_ID,
            VIDU_TEXT_IMAGE_CONSTRAINT_SET_ID
          ),
          feature(
            'reference_to_image',
            'reference_to_image',
            referenceSchemaId,
            VIDU_REFERENCE_IMAGE_V2_RESULT_SCHEMA_ID,
            VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID
          ),
          feature(
            'image_edit',
            'image_editing',
            editSchemaId,
            VIDU_REFERENCE_IMAGE_V2_RESULT_SCHEMA_ID,
            VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID
          )
        ]
      ),
      parameterSchemas: [
        schema(textSchemaId, 'text_to_image', commonFields, 2),
        schema(referenceSchemaId, 'reference_to_image', commonFields, 2),
        schema(editSchemaId, 'image_edit', commonFields, 2)
      ],
      defaultProfileStatus: 'restricted'
    };
  }

  if (providerModelKey === 'viduq1') {
    const schemaId =
      `parameters.vidu.reference-image-v2.reference-to-image.${providerModelKey}`;
    return {
      definition: definition(
        providerModelKey,
        VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
        VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
        VIDU_REFERENCE_IMAGE_V2_SOURCE_DOCUMENT_REVISION,
        [feature(
          'reference_to_image',
          'reference_to_image',
          schemaId,
          VIDU_REFERENCE_IMAGE_V2_RESULT_SCHEMA_ID,
          VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID
        )]
      ),
      parameterSchemas: [schema(schemaId, 'reference_to_image', [
        optionalEnum('aspect_ratio', 10, ['16:9', '9:16', '1:1', '3:4', '4:3']),
        optionalEnum('resolution', 20, ['1080p']),
        optionalInteger('seed', 30, 0, 2_147_483_647)
      ], 2)],
      defaultProfileStatus: 'restricted'
    };
  }

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
  providerModelKey: (typeof frozenViduReferenceVideoModelKeys)[number]
): ViduModelContractV1 {
  const schemaId = `parameters.vidu.reference-video-v2.image-to-video.${providerModelKey}`;
  const range = referenceDurationRange(providerModelKey);
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
    parameterSchemas: [schema(schemaId, 'image_to_video',
      referenceVideoFields(providerModelKey, range), 2)],
    defaultProfileStatus: 'restricted'
  };
}

function textVideoContract(
  providerModelKey: 'viduq3-pro'
): ViduModelContractV1 {
  // Official text2video: https://platform.vidu.cn/docs/text-to-video
  const schemaId =
    `parameters.vidu.text-video-v2.text-to-video.${providerModelKey}`;
  const range = textDurationRange(providerModelKey);
  return {
    definition: definition(
      providerModelKey,
      VIDU_TEXT_VIDEO_V2_ADAPTER_ID,
      VIDU_TEXT_VIDEO_V2_PROTOCOL_ID,
      VIDU_TEXT_VIDEO_V2_SOURCE_DOCUMENT_REVISION,
      [feature(
        'text_to_video',
        'video_generation',
        schemaId,
        VIDU_TEXT_VIDEO_V2_RESULT_SCHEMA_ID,
        VIDU_TEXT_VIDEO_CONSTRAINT_SET_ID
      )]
    ),
    parameterSchemas: [schema(schemaId, 'text_to_video',
      textVideoFields(range), 2)],
    defaultProfileStatus: 'restricted'
  };
}

function dualVideoContract(
  providerModelKey: 'viduq3-turbo'
): ViduModelContractV1 {
  // Official docs list viduq3-turbo for text2video and the packaged reference
  // path. Catalog install binds one profile/adapter per model, so both product
  // features share the reference video adapter; submit routes by capability.
  const referenceSchemaId =
    `parameters.vidu.reference-video-v2.image-to-video.${providerModelKey}`;
  const textSchemaId =
    `parameters.vidu.text-video-v2.text-to-video.${providerModelKey}`;
  const referenceRange = referenceDurationRange(providerModelKey);
  const textRange = textDurationRange(providerModelKey);
  return {
    definition: definition(
      providerModelKey,
      VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      VIDU_REFERENCE_VIDEO_V2_SOURCE_DOCUMENT_REVISION,
      [
        feature(
          'image_to_video',
          'reference_to_video',
          referenceSchemaId,
          VIDU_REFERENCE_VIDEO_V2_RESULT_SCHEMA_ID,
          VIDU_IMAGE_VIDEO_CONSTRAINT_SET_ID
        ),
        feature(
          'text_to_video',
          'video_generation',
          textSchemaId,
          VIDU_TEXT_VIDEO_V2_RESULT_SCHEMA_ID,
          VIDU_TEXT_VIDEO_CONSTRAINT_SET_ID
        )
      ]
    ),
    parameterSchemas: [
      schema(referenceSchemaId, 'image_to_video',
        referenceVideoFields(providerModelKey, referenceRange), 2),
      schema(textSchemaId, 'text_to_video', textVideoFields(textRange), 2)
    ],
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
  fields: readonly ParameterFieldSchemaV2[],
  revision = 1
): ParameterSchemaV2 {
  return { schemaVersion: 2, schemaId, revision, productFeature, fields };
}

function optionalString(fieldId: string, order: number): ParameterFieldSchemaV2 {
  return optionalField(fieldId, order, 'string');
}

function optionalBoolean(fieldId: string, order: number): ParameterFieldSchemaV2 {
  return optionalField(fieldId, order, 'boolean');
}

function optionalEnum(
  fieldId: string,
  order: number,
  options: readonly string[]
): ParameterFieldSchemaV2 {
  return {
    ...optionalField(fieldId, order, 'enum'),
    options
  };
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
  valueType: 'string' | 'integer' | 'boolean' | 'enum'
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

function referenceDurationRange(
  modelKey: (typeof frozenViduReferenceVideoModelKeys)[number]
): { readonly minimum: number; readonly maximum: number } {
  if (modelKey === 'viduq3-drama') return { minimum: 2, maximum: 15 };
  if (modelKey === 'viduq3-ad') return { minimum: 3, maximum: 15 };
  return { minimum: 3, maximum: 16 };
}

function textDurationRange(
  modelKey: (typeof frozenViduTextVideoModelKeys)[number]
): { readonly minimum: number; readonly maximum: number } {
  // Official text2video duration: q3 models 1–16.
  if (modelKey === 'viduq3-pro' || modelKey === 'viduq3-turbo') {
    return { minimum: 1, maximum: 16 };
  }
  return { minimum: 1, maximum: 16 };
}

function referenceVideoFields(
  modelKey: (typeof frozenViduReferenceVideoModelKeys)[number],
  range: { readonly minimum: number; readonly maximum: number }
): readonly ParameterFieldSchemaV2[] {
  return [
    optionalBoolean('audio', 10),
    optionalInteger('duration', 20, range.minimum, range.maximum, 'second'),
    optionalEnum('resolution', 30, referenceResolutionOptions(modelKey)),
    optionalEnum('aspect_ratio', 40, referenceAspectRatioOptions(modelKey)),
    optionalInteger('seed', 50, 0, 2_147_483_647)
  ];
}

function textVideoFields(
  range: { readonly minimum: number; readonly maximum: number }
): readonly ParameterFieldSchemaV2[] {
  return [
    optionalBoolean('audio', 10),
    optionalInteger('duration', 20, range.minimum, range.maximum, 'second'),
    optionalEnum('resolution', 30, ['540p', '720p', '1080p']),
    optionalEnum('aspect_ratio', 40, ['16:9', '9:16', '3:4', '4:3', '1:1']),
    optionalInteger('seed', 50, 0, 2_147_483_647)
  ];
}

function referenceResolutionOptions(
  modelKey: (typeof frozenViduReferenceVideoModelKeys)[number]
): readonly string[] {
  if (modelKey === 'viduq3-drama') return ['1080p'];
  if (modelKey === 'viduq3-mix' || modelKey === 'viduq3-ad') {
    return ['720p', '1080p'];
  }
  return ['540p', '720p', '1080p'];
}

function referenceAspectRatioOptions(
  modelKey: (typeof frozenViduReferenceVideoModelKeys)[number]
): readonly string[] {
  if (modelKey === 'viduq3-drama' || modelKey === 'viduq3-ad') {
    return ['16:9', '9:16', '4:3', '3:4', '1:1'];
  }
  return ['16:9', '9:16', '1:1'];
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
