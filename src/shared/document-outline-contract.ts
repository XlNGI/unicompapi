export const outlineDocumentKinds = ['word', 'excel', 'ppt'] as const;
export type OutlineDocumentKind = (typeof outlineDocumentKinds)[number];

export const outlinePresentationPageKinds = [
  'cover',
  'section',
  'insight',
  'comparison',
  'process',
  'data',
  'image_text',
  'closing'
] as const;

export const outlinePageKindAliases: Readonly<Record<string, (typeof outlinePresentationPageKinds)[number]>> = {
  summary: 'insight',
  detail: 'insight',
  roadmap: 'process',
  risk: 'insight',
  action: 'process'
};

export const outlineBlockKinds = [
  'paragraph',
  'bullets',
  'numbered',
  'quote',
  'table',
  'chart'
] as const;

export const outlineSceneElementKinds = [
  'text',
  'shape',
  'line',
  'table',
  'chart',
  'group'
] as const;

export const outlineContractLimits = {
  maxTitleLength: 200,
  maxSections: 100,
  maxBlocksPerSection: 100,
  maxItems: 50,
  maxTextLength: 2_000,
  maxTableColumns: 50,
  maxTableRows: 200,
  maxTableCellLength: 1_000,
  maxChartItems: 50,
  maxChartLabelLength: 100,
  maxSceneElements: 30,
  maxTotalCharacters: 48_000,
  maxContentGroups: 80,
  maxEstimatedPages: 40
} as const;

/**
 * Compatibility aliases accepted only before strict validation. The parser
 * owns the normalization operation; this module only defines the mapping.
 */
export const outlineAliasDefinitions = {
  sceneElement: {
    fillColor: 'style.fill',
    strokeColor: 'style.stroke',
    lineColor: 'style.stroke',
    shapeType: 'type',
    lineWidth: undefined,
    strokeWidth: undefined,
    bold: undefined,
    opacity: undefined
  },
  sceneStyle: {
    fillColor: 'fill',
    strokeColor: 'stroke',
    lineColor: 'stroke',
    lineWidth: undefined,
    strokeWidth: undefined,
    shapeType: undefined,
    strokeStyle: undefined,
    bold: undefined,
    fontWeight: undefined,
    opacity: undefined,
    textAlign: undefined
  }
} as const;

export type OutlineJsonSchema = Readonly<Record<string, unknown>>;

const nonBlankText = (maximum: number): OutlineJsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength: maximum
});

const boundedText = nonBlankText(outlineContractLimits.maxTextLength);

const itemsSchema: OutlineJsonSchema = {
  type: 'array',
  maxItems: outlineContractLimits.maxItems,
  items: boundedText
};

const tableSchema: OutlineJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'table' },
    header: {
      type: 'array',
      minItems: 1,
      maxItems: outlineContractLimits.maxTableColumns,
      items: boundedText
    },
    rows: {
      type: 'array',
      maxItems: outlineContractLimits.maxTableRows,
      items: {
        type: 'array',
        items: { type: 'string', maxLength: outlineContractLimits.maxTableCellLength }
      }
    }
  },
  required: ['type', 'header', 'rows']
};

const chartSchema: OutlineJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'chart' },
    chartKind: { enum: ['bar', 'pie'] },
    title: { type: 'string', maxLength: outlineContractLimits.maxTextLength },
    data: {
      type: 'array',
      minItems: 1,
      maxItems: outlineContractLimits.maxChartItems,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: nonBlankText(outlineContractLimits.maxChartLabelLength),
          value: { type: 'number' }
        },
        required: ['label', 'value']
      }
    }
  },
  required: ['type', 'chartKind', 'data']
};

const blockSchemas: readonly OutlineJsonSchema[] = [
  ...(['paragraph', 'quote'] as const).map((type) => ({
    type: 'object',
    additionalProperties: false,
    properties: { type: { const: type }, text: boundedText },
    required: ['type', 'text']
  })),
  ...(['bullets', 'numbered'] as const).map((type) => ({
    type: 'object',
    additionalProperties: false,
    properties: { type: { const: type }, items: itemsSchema },
    required: ['type', 'items']
  })),
  tableSchema,
  chartSchema
];

const sceneStyleSchema: OutlineJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fill: { pattern: '^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
    stroke: { pattern: '^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
    textColor: { pattern: '^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
    fontSize: { type: 'number', exclusiveMinimum: 0 },
    fontFamily: { type: 'string', minLength: 1, maxLength: 100 },
    radius: { type: 'number', minimum: 0 }
  }
};

const sceneGeometrySchema: OutlineJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    width: { type: 'number', minimum: 0, maximum: 1 },
    height: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['x', 'y', 'width', 'height']
};

const sceneElementSchema: OutlineJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    elementId: { type: 'string', minLength: 1, maxLength: 256 },
    type: { enum: [...outlineSceneElementKinds] },
    geometry: sceneGeometrySchema,
    zIndex: { type: 'integer', minimum: 0, maximum: 10_000 },
    parentId: { type: 'string', minLength: 1, maxLength: 256 },
    readingOrder: { type: 'integer', minimum: 0 },
    content: { type: 'string', maxLength: outlineContractLimits.maxTextLength },
    style: sceneStyleSchema
  },
  required: ['elementId', 'type', 'geometry', 'zIndex']
};

const sceneSchema: OutlineJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    elements: {
      type: 'array',
      minItems: 1,
      maxItems: outlineContractLimits.maxSceneElements,
      items: sceneElementSchema
    }
  },
  required: ['schemaVersion', 'elements']
};

function blockSchema(): OutlineJsonSchema {
  return { oneOf: blockSchemas };
}

function sectionSchema(kind: OutlineDocumentKind): OutlineJsonSchema {
  const properties: Record<string, unknown> = {
    heading: nonBlankText(outlineContractLimits.maxTitleLength),
    level: { enum: [1, 2, 3] },
    blocks: {
      type: 'array',
      maxItems: outlineContractLimits.maxBlocksPerSection,
      items: blockSchema()
    }
  };
  const required = ['heading', 'level', 'blocks'];
  if (kind === 'ppt') {
    Object.assign(properties, {
      pageKind: { enum: [...outlinePresentationPageKinds] },
      takeaway: boundedText,
      action: boundedText,
      scene: sceneSchema
    });
  }
  if (kind === 'excel') {
    Object.assign(properties, {
      footers: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: boundedText,
          values: { type: 'array', items: { type: ['string', 'number', 'null'] } }
        },
        required: ['values']
      }
    });
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

/** Machine-readable contract consumed by Provider adapters and tests. */
export function buildDocumentOutlineJsonSchema(
  kind: OutlineDocumentKind
): OutlineJsonSchema {
  const properties: Record<string, unknown> = {
    kind: { enum: [kind] },
    title: nonBlankText(outlineContractLimits.maxTitleLength),
    sections: {
      type: 'array',
      maxItems: outlineContractLimits.maxSections,
      items: sectionSchema(kind)
    }
  };
  if (kind === 'ppt') {
    Object.assign(properties, { coverScene: sceneSchema, closingScene: sceneSchema });
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
    required: ['kind', 'title', 'sections']
  };
}

/** Fallback instruction for providers without structured-output support. */
export function buildDocumentOutlinePrompt(kind: OutlineDocumentKind): string {
  return [
    '输出必须是一个 JSON 对象，不要 Markdown 代码围栏、前后缀或解释。',
    '以下是唯一的 Outline Contract；未知字段、别名字段和额外字段都禁止输出。',
    JSON.stringify(buildDocumentOutlineJsonSchema(kind)),
    '历史兼容字段（如 fillColor、lineColor、shapeType、bold、opacity、strokeWidth）不能出现在输出中。'
  ].join('\n');
}
