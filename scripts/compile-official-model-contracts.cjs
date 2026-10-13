// Compile local, previously authorized public-document snapshots. No network or source execution.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'outputs/model-contract-audit/sources');
const sourceRecords = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).sources;
const packageDirectory = fs.readdirSync(path.join(root, 'node_modules/.pnpm')).find(name => name.startsWith('js-yaml@'));
if (!packageDirectory) throw new Error('The existing documentation YAML parser is unavailable');
const yaml = require(path.join(root, 'node_modules/.pnpm', packageDirectory, 'node_modules/js-yaml'));

function source(id) {
  const record = sourceRecords.find(item => item.id === id && item.state === 'retrieved');
  if (!record) throw new Error(`Missing public-document snapshot: ${id}`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, `${id}.body`))).digest('hex');
  if (hash !== record.sha256) throw new Error(`Public-document snapshot hash mismatch: ${id}`);
  return { url: record.resolvedUrl, retrievedAt: record.capturedAt, sha256: record.sha256 };
}
function openapi(id) {
  const text = fs.readFileSync(path.join(directory, `${id}.txt`), 'utf8');
  const block = text.match(/````?yaml[^\n]*\n([\s\S]*?)\n````?/);
  if (!block) throw new Error(`Missing documented OpenAPI: ${id}`);
  return yaml.load(block[1], { schema: yaml.JSON_SCHEMA });
}
// Keep structural API facts only, and reject references to anything outside this retained specification.
const structural = new Set(['type', '$ref', 'allOf', 'oneOf', 'anyOf', 'not', 'properties', 'items', 'required', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'uniqueItems', 'additionalProperties', 'nullable', 'default', 'deprecated', 'pattern', 'format', 'multipleOf']);
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!structural.has(key)) continue;
    if (key === '$ref' && (typeof item !== 'string' || !item.startsWith('#/components/schemas/'))) throw new Error('External schema reference is not allowed');
    result[key] = key === 'properties' ? Object.fromEntries(Object.entries(item).map(([field, schema]) => [field, clean(schema)])) : clean(item);
  }
  return result;
}
const contracts = [];
function add(id, vendor, modelKeys, sourceIds, requestSchema, definitions = {}, extra = {}) {
  const retained = {};
  function retainReferences(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.replace('#/components/schemas/', '');
      if (!definitions[name]) throw new Error('Referenced schema was not retained in the official snapshot');
      if (!retained[name]) { retained[name] = clean(definitions[name]); retainReferences(retained[name]); }
    }
    for (const item of Object.values(value)) retainReferences(item);
  }
  const normalized = clean(requestSchema);
  retainReferences(normalized);
  const responseSchemas = extra.responseSchemas ? Object.fromEntries(Object.entries(extra.responseSchemas)
    .map(([mediaType, schema]) => [mediaType, clean(schema)])) : undefined;
  if (responseSchemas) retainReferences(responseSchemas);
  contracts.push({ id, revision: 1, authority: 'model_vendor', vendor, modelKeys, sources: sourceIds.map(source),
    requestSchema: normalized, definitions: retained,
    ...extra, ...(responseSchemas ? { responseSchemas } : {}) });
}
const glm = JSON.parse(fs.readFileSync(path.join(directory, 'glm-openapi.body'), 'utf8'));
const glmSchema = glm.components.schemas.ChatCompletionTextRequest;
for (const key of ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.1', 'glm-5.2']) {
  if (!glmSchema.properties.model.enum.includes(key)) throw new Error('GLM model not declared in retained official schema');
  const schema = structuredClone(glmSchema);
  schema.properties.model.enum = [key];
  schema.properties.model.default = key;
  schema.properties.temperature.multipleOf = 0.01;
  schema.properties.top_p.multipleOf = 0.01;
  // The official reference limits reasoning_effort to GLM-5.2 and newer.
  if (key !== 'glm-5.2') delete schema.properties.reasoning_effort;
  add(`official.zhipu.${key}.chat`, 'zhipu', [key], ['glm-openapi', 'glm-chat'], schema, glm.components.schemas,
    { method: 'POST', endpointPath: '/paas/v4/chat/completions',
      responseSchemas: { 'application/json': { $ref: '#/components/schemas/ChatCompletionResponse' },
        'text/event-stream': { $ref: '#/components/schemas/ChatCompletionChunk' } },
      toolChoices: ['auto'], thinkingHistory: 'preserve_when_returned' });
}
const kimi = openapi('kimi-api-chat');
for (const [model, schemaName, choices] of [['kimi-k3', 'KimiK3ChatRequest', ['auto', 'none', 'required']],
  ['kimi-k2.6', 'KimiK26ChatRequest', ['auto', 'none']]]) {
  const schema = structuredClone(kimi.components.schemas[schemaName]);
  const fixed = { top_p: { type: 'number', const: 0.95 }, n: { type: 'integer', const: 1 },
    presence_penalty: { type: 'number', const: 0 }, frequency_penalty: { type: 'number', const: 0 } };
  fixed.temperature = model === 'kimi-k3' ? { type: 'number', const: 1 } : { type: 'number', enum: [0.6, 1] };
  if (model === 'kimi-k2.6') {
    const choice = structuredClone(kimi.components.schemas.ChatRequestBase.properties.tool_choice);
    choice.oneOf.find(item => item.type === 'string').enum = choices;
    fixed.tool_choice = choice;
  }
  schema.allOf.push({ type: 'object', properties: fixed });
  if (model === 'kimi-k3') schema.allOf.push({ type: 'object', properties: { max_completion_tokens: { type: 'integer', minimum: 1, maximum: 1048576 } } });
  add(`official.moonshot.${model}.chat`, 'moonshot', [model], ['kimi-api-chat', 'kimi-models'], schema, kimi.components.schemas,
    { method: 'POST', endpointPath: '/v1/chat/completions',
      responseSchemas: { 'application/json': { $ref: '#/components/schemas/ChatCompletionResponse' },
        'text/event-stream': { $ref: '#/components/schemas/ChatCompletionChunk' } },
      toolChoices: choices, thinkingHistory: 'preserve_when_returned', conditions: ['json_schema_format_requires_definition', 'stop_sequence_max_32_utf8_bytes',
        ...(model === 'kimi-k2.6' ? ['temperature_depends_on_thinking_mode'] : [])] });
}
const minimax = openapi('minimax-h3-create');
for (const model of ['MiniMax-H3', 'MiniMax-H3-Max']) {
  const schema = structuredClone(minimax.components.schemas.VideoGenerationV2Req);
  schema.properties.model.enum = [model];
  schema.properties.resolution.enum = model === 'MiniMax-H3' ? ['768P', '2K'] : ['480P', '768P'];
  schema.properties.duration.enum = Array.from({ length: model === 'MiniMax-H3' ? 12 : 11 }, (_, index) => index + (model === 'MiniMax-H3' ? 4 : 5));
  if (model === 'MiniMax-H3') delete schema.properties.extra;
  add(`official.minimax.${model}.video`, 'minimax', [model], ['minimax-h3-create'], schema, minimax.components.schemas,
    { method: 'POST', endpointPath: '/v2/video_generation', responseSchemas: {
      'application/json': { $ref: '#/components/schemas/VideoGenerationV2Resp' } },
      conditions: ['text_only_requires_non_adaptive_ratio', 'frame_and_reference_inputs_are_mutually_exclusive'] });
}

// The official DeepSeek page provides the parameter structure in rendered reference tables.
const deepseek = fs.readFileSync(path.join(directory, 'deepseek-chat.txt'), 'utf8');
if (!deepseek.includes('393216') || !deepseek.includes('none') || !deepseek.includes('required')) throw new Error('DeepSeek reference anchors changed');
const deepseekSchema = { type: 'object', required: ['model', 'messages'], properties: {
  model: { type: 'string', enum: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'] }, messages: { type: 'array', minItems: 1 },
  thinking: { type: 'object', nullable: true, properties: { type: { type: 'string', enum: ['enabled', 'disabled'], default: 'enabled' } } },
  reasoning_effort: { type: 'string', enum: ['none', 'low', 'high', 'max', 'minimal', 'medium', 'xhigh'], default: 'high' },
  max_tokens: { type: 'integer', minimum: 1, maximum: 393216, nullable: true },
  temperature: { type: 'number', minimum: 0, maximum: 2, default: 1, nullable: true },
  top_p: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 1, nullable: true },
  stop: { nullable: true, oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 16 }] },
  response_format: { type: 'object', nullable: true, properties: { type: { type: 'string', enum: ['text', 'json_object'], default: 'text' } } },
  stream: { type: 'boolean', nullable: true }, stream_options: { type: 'object', nullable: true, properties: { include_usage: { type: 'boolean' } } },
  tools: { type: 'array', nullable: true }, tool_choice: { nullable: true, oneOf: [{ type: 'string', enum: ['none', 'auto', 'required'] },
    { type: 'object', required: ['type', 'function'], properties: { type: { type: 'string', enum: ['function'] }, function: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }] },
  logprobs: { type: 'boolean', nullable: true }, top_logprobs: { type: 'integer', minimum: 0, maximum: 20, nullable: true }
} };
add('official.deepseek.v4.chat', 'deepseek', ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  ['deepseek-chat', 'deepseek-models', 'deepseek-tools'], deepseekSchema, {},
  { toolChoices: ['auto', 'none', 'required'], conditions: ['required_and_named_tools_require_non_thinking_mode', 'top_logprobs_requires_logprobs'],
    thinkingHistory: 'preserve_when_returned', aliases: { 'deepseek-v4-flash': 'deepseek-flash' } });

// Extract published data literals only. Do not evaluate or import the untrusted web application code.
const klingSource = fs.readFileSync(path.join(directory, 'kling-text-video-schema.body'), 'utf8');
const syntax = ts.createSourceFile('official-document.js', klingSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let requestBody;
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node)) { const value = literal(node.operand); if (typeof value === 'number') return node.operator === ts.SyntaxKind.ExclamationToken ? !value : node.operator === ts.SyntaxKind.MinusToken ? -value : undefined; }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(property => [property.name.text, literal(property.initializer)]).filter(([,value]) => value !== undefined));
  return undefined;
}
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(syntax) === 'requestBody' && ts.isArrayLiteralExpression(node.initializer)) requestBody = literal(node.initializer);
  ts.forEachChild(node, visit);
}
visit(syntax);
if (!requestBody || !requestBody.some(item => item.name === 'model_name')) throw new Error('Kling public schema extraction failed');
const klingProperties = Object.fromEntries(requestBody.map(item => [item.name, { type: item.type === 'float' ? 'number' : item.type,
  ...(item.enum ? { enum: item.enum } : {}), ...(item.default !== undefined ? { default: item.default } : {}) }]));
add('official.kling.text-to-video', 'kling', klingProperties.model_name.enum ?? [], ['kling-text-video-schema'],
  { type: 'object', required: requestBody.filter(item => item.required).map(item => item.name), properties: klingProperties }, {},
  { conditions: ['multi_shot_and_shot_type_depend_on_model', 'custom_storyboards_require_multi_prompt'] });

const viduText = fs.readFileSync(path.join(directory, 'vidu-q3-text.txt'), 'utf8');
if (!viduText.includes('1 - 16') || !viduText.includes('/ent/v2/text2video')) throw new Error('Vidu text reference anchors changed');
const viduCommon = {
  prompt: { type: 'string', maxLength: 20000 }, seed: { type: 'integer', default: 0 },
  payload: { type: 'string', maxLength: 1048576 }, off_peak: { type: 'boolean', default: false },
  watermark: { type: 'boolean', default: true }, wm_position: { type: 'integer', enum: [1,2,3,4], default: 3 },
  wm_url: { type: 'string' }, meta_data: { type: 'string' }, callback_url: { type: 'string' }
};
for (const model of ['viduq3-pro', 'viduq3-turbo']) add(`official.vidu.${model}.text-video`, 'vidu', [model], ['vidu-q3-text'],
  { type: 'object', required: ['model', 'prompt'], properties: { ...viduCommon, model: { type: 'string', enum: [model] },
    duration: { type: 'integer', minimum: 1, maximum: 16, default: 5 }, audio: { type: 'boolean', default: true },
    aspect_ratio: { type: 'string', enum: ['1:1','16:9','9:16','4:3','3:4'], default: '16:9' },
    resolution: { type: 'string', enum: ['540p','720p','1080p'], default: '720p' } } }, {}, { endpointPath: '/ent/v2/text2video' });
const viduFirstFrame = fs.readFileSync(path.join(directory, 'vidu-q3-image.txt'), 'utf8');
if (!viduFirstFrame.includes('只支持输入 1 张图') || !viduFirstFrame.includes('1 - 16')) throw new Error('Vidu first-frame reference anchors changed');
for (const model of ['viduq3-pro', 'viduq3-turbo']) add(`official.vidu.${model}.image-video`, 'vidu', [model], ['vidu-q3-image'],
  { type: 'object', required: ['model', 'images'], properties: { ...viduCommon,
    model: { type: 'string', enum: [model] }, images: { type: 'string' },
    duration: { type: 'integer', minimum: 1, maximum: 16, default: 5 }, audio: { type: 'boolean', default: true },
    is_rec: { type: 'boolean', default: false },
    resolution: { type: 'string', enum: model === 'viduq3-turbo' ? ['720p','1080p'] : ['540p','720p','1080p'], default: '720p' }
  } }, {}, { method: 'POST', endpointPath: '/ent/v2/img2video',
    conditions: ['single_first_frame_image_only', 'recommended_prompt_overrides_supplied_prompt'] });
for (const [model, minimum, maximum, resolutions, ratios] of [
  ['viduq3', 3, 16, ['540p','720p','1080p'], ['1:1','16:9','9:16','3:4','4:3','auto']],
  ['viduq3-turbo', 3, 15, ['540p','720p','1080p'], ['1:1','16:9','9:16','3:4','4:3','auto']],
  ['viduq3-drama', 2, 16, ['720p','1080p'], ['16:9','9:16','auto']],
  ['viduq3-mix', 3, 15, ['720p','1080p'], ['1:1','16:9','9:16','3:4','4:3','auto']],
  ['viduq3-ad', 3, 15, ['720p','1080p'], ['1:1','16:9','9:16','3:4','4:3','auto']]
]) add(`official.vidu.${model}.reference-video`, 'vidu', [model], ['vidu-q3-reference'],
  { type: 'object', required: ['model','prompt'], properties: { ...viduCommon, model: { type: 'string', enum: [model] },
    images: { type: 'array', minItems: 1, maxItems: 7 }, duration: { type: 'integer', minimum, maximum },
    resolution: { type: 'string', enum: resolutions }, aspect_ratio: { type: 'string', enum: ratios },
    ...(['viduq3', 'viduq3-drama'].includes(model) ? { audio: { type: 'boolean', default: true } } : {})
  } }, {}, { endpointPath: '/ent/v2/reference2video',
    ...(model === 'viduq3-turbo' ? { documentationConflicts: ['duration_section_3_to_15_vs_resolution_section_3_to_16'] } : {}),
    conditions: ['controlled_reference_images_or_subjects_required', 'multimedia_reference_roles_need_separate_product_authorization'] });
const viduImage = fs.readFileSync(path.join(directory, 'vidu-image-generation.txt'), 'utf8');
if (!viduImage.includes('0～7') || !viduImage.includes('1～7') || !viduImage.includes('2000')) throw new Error('Vidu image reference anchors changed');
for (const model of ['viduq1', 'viduq2']) add(`official.vidu.${model}.reference-image`, 'vidu', [model], ['vidu-image-generation'],
  { type: 'object', required: ['model', 'prompt', ...(model === 'viduq1' ? ['images'] : [])], properties: {
    model: { type: 'string', enum: [model] }, prompt: { type: 'string', maxLength: 2000 },
    images: { type: 'array', items: { type: 'string' }, minItems: model === 'viduq1' ? 1 : 0, maxItems: 7 },
    seed: { type: 'integer', default: 0 },
    aspect_ratio: { type: 'string', enum: model === 'viduq1' ? ['16:9','9:16','1:1','3:4','4:3'] : ['16:9','9:16','1:1','3:4','4:3','21:9','2:3','3:2','auto'], default: '16:9' },
    resolution: { type: 'string', enum: model === 'viduq1' ? ['1080p'] : ['1080p','2K','4K'], default: '1080p' },
    payload: { type: 'string', maxLength: 1048576 }, callback_url: { type: 'string' }
  } }, {}, { endpointPath: '/ent/v2/reference2image', conditions: ['controlled_images_only', 'source_aspect_ratio_table_truncated_requires_model_detail'] });

// Qwen's vendor deployment exposes this protocol, not the relay's images/generations envelope.
const qwenText = fs.readFileSync(path.join(directory, 'qwen-openai-chat.txt'), 'utf8');
if (!qwenText.includes('[0, 2)') || !qwenText.includes('enable_thinking')) throw new Error('Qwen chat reference anchors changed');
add('official.alibaba.qwen3.chat', 'alibaba', [], ['qwen-openai-chat'], {
  type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string' }, messages: { type: 'array', minItems: 1 },
    temperature: { type: 'number', minimum: 0, exclusiveMaximum: 2 }, top_p: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    max_tokens: { type: 'integer', minimum: 1 }, enable_thinking: { type: 'boolean' },
    thinking_budget: { type: 'integer' }, stream: { type: 'boolean' },
    stream_options: { type: 'object', properties: { include_usage: { type: 'boolean' } } },
    tools: { type: 'array' }, tool_choice: { oneOf: [{ type: 'string', enum: ['auto','none'] }, { type: 'object' }] },
    response_format: { type: 'object' }, seed: { type: 'integer' }
  }
}, {}, { contractScope: 'qwen_openai_chat_endpoint_schema_model_id_requires_explicit_binding', toolChoices: ['auto','none'],
  conditions: ['model_specific_output_limit_requires_binding', 'qwen_thinking_mode_requires_supported_model'], thinkingHistory: 'preserve_when_returned' });

const seedreamText = fs.readFileSync(path.join(directory, 'volcengine-images.txt'), 'utf8');
const volcengineModels = fs.readFileSync(path.join(directory, 'volcengine-model-list.txt'), 'utf8');
for (const key of ['doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128',
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']) {
  if (!volcengineModels.includes(key)) throw new Error('Volcengine exact model key not present in retained model list');
}
if (!seedreamText.includes('Seedream 5.0 lite') || !seedreamText.includes('sequential_image_generation')) throw new Error('Seedream reference anchors changed');
add('official.volcengine.seedream-5-lite.image', 'volcengine', ['doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128'], ['volcengine-images', 'volcengine-model-list'], {
  type: 'object', required: ['model', 'prompt'], properties: { model: { type: 'string' }, prompt: { type: 'string' },
    size: { type: 'string' }, image: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    response_format: { type: 'string', enum: ['url','b64_json'] }, watermark: { type: 'boolean' },
    sequential_image_generation: { type: 'string', enum: ['auto','disabled'] }, sequential_image_generation_options: { type: 'object' },
    stream: { type: 'boolean' }
  }
}, {}, { contractScope: 'seedream_5_lite_image_request_projection',
  conditions: ['product_single_output_requires_sequential_disabled', 'vendor_model_id_requires_explicit_binding'] });

const seedanceText = fs.readFileSync(path.join(directory, 'volcengine-video-current.txt'), 'utf8');
if (!seedanceText.includes('Seedance 2.0 fast') || !seedanceText.includes('4k')) throw new Error('Seedance reference anchors changed');
for (const mode of ['seedance-2.0', 'seedance-2.0-fast']) add(`official.volcengine.${mode}.video`, 'volcengine',
  [mode === 'seedance-2.0' ? 'doubao-seedance-2-0-260128' : 'doubao-seedance-2-0-fast-260128'], ['volcengine-video-current', 'volcengine-model-list'], {
  type: 'object', required: ['model', 'content'], properties: { model: { type: 'string' }, content: { type: 'array', minItems: 1 },
    resolution: { type: 'string', enum: mode.endsWith('fast') ? ['480p','720p'] : ['480p','720p','1080p','4k'], default: '720p' },
    ratio: { type: 'string', enum: ['21:9','16:9','4:3','1:1','3:4','9:16','adaptive'] },
    duration: { type: 'integer', oneOf: [{ const: -1 }, { minimum: 4, maximum: 15 }] },
    generate_audio: { type: 'boolean' }, watermark: { type: 'boolean' }, return_last_frame: { type: 'boolean' }, callback_url: { type: 'string' }
  }
}, {}, { method: 'POST', endpointPath: '/api/v3/contents/generations/tasks',
  contractScope: 'seedance_2_video_request_projection',
  conditions: ['input_roles_and_durations_depend_on_model', 'frames_seed_camera_fixed_are_documented_for_seedance_1_only', 'vendor_model_id_requires_explicit_binding'] });

const output = path.join(root, 'src/platform/providers/contracts/official-api-contracts.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, contracts }, null, 2) + '\n');
const evidence = {
  schemaVersion: 1,
  authorization: 'explicit_user_2026-10-12',
  scope: 'public_vendor_and_relay_documentation_only',
  credentialReads: 0,
  generationRequests: 0,
  automaticRetries: 0,
  sources: sourceRecords,
  contracts: contracts.map(contract => ({ id: contract.id, modelKeys: contract.modelKeys,
    sources: contract.sources, status: 'source_compiled_review_required' })),
  relays: [
    { id: 'provider-package-unicompapi', site: 'https://unicompapi.com', role: 'relay', endpoint: 'https://unicompapi.com/v1',
      cardStatus: 'separate_card', contractAuthority: 'relay_docs_do_not_become_model_vendor_contracts' },
    { id: 'provider-package-unicompapi-www', site: 'https://www.unicompapi.com', role: 'relay', endpoint: 'https://www.unicompapi.com/v1',
      cardStatus: 'separate_card', supportedAdapter: 'chat_completions_only',
      mediaProtocolStatus: 'relay_quote_and_submit_protocol_not_reused_as_vendor_contract' }
  ],
  deferredByUser: { decisionDate: '2026-10-13', state: 'skipped_pending_official_mapping',
    models: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
      'happyhorse-1.0-i2v', 'happyhorse-1.0-r2v', 'happyhorse-1.0-t2v', 'happyhorse-1.0-video-edit',
      'happyhorse-1.1-i2v', 'happyhorse-1.1-r2v', 'happyhorse-1.1-t2v',
      'deepseek-r1-0528', 'deepseek-v3', 'deepseek-v3.2', 'deepseek-v3.2-exp',
      'viduimage-2', 'q2-fast', 'q2-pro', 'q3-fast', 'q3-lite', 'kling-v3-turbo',
      'qwen-image', 'qwen-image-edit-2509', 'qwen3-235b-a22b', 'qwen3-32b'],
    reason: 'Owner explicitly requested skipping these unresolved legacy, relay-alias, and dynamic model contracts while retaining the evidence and gaps.',
    includedInOfficialAlignmentPass: false },
  unverifiedLocalMappings: [
    'UniComp relay model aliases without an exact official-vendor mapping',
    'OpenAI official documentation and OpenAPI sources unavailable in this environment',
    'Legacy Qwen model aliases still require exact per-model vendor mapping; the generic endpoint schema is not proof of this mapping',
    'www.unicompapi.com quote/submit media protocol is documented but not wired to the media adapters',
    'Vidu image/video contracts still require per-route parameter snapshot integration',
    'Qwen and Volcengine media contracts require product adapter compilation',
    'Dynamic model discovery records and remaining static model records are not fully bound'
  ]
};
const evidencePath = path.join(root, 'docs/evidence/model-contract-sources-20261012.json');
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
process.stdout.write(JSON.stringify({ contracts: contracts.length, evidence: 'docs/evidence/model-contract-sources-20261012.json', output: 'src/platform/providers/contracts/official-api-contracts.json', vendorModels: contracts.flatMap(item => item.modelKeys) }) + '\n');
