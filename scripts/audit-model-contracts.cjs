// Read only published source contracts. Never read user registries or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const officialCatalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/platform/providers/contracts/official-api-contracts.json'), 'utf8'));
const officialContracts = officialCatalog.contracts;
const officialModelContracts = new Map();
for (const contract of officialContracts) for (const modelKey of contract.modelKeys) {
  const list = officialModelContracts.get(modelKey) ?? [];
  list.push(contract.id);
  officialModelContracts.set(modelKey, list);
}

const workspace = path.resolve(__dirname, '..');
require.extensions['.ts'] = (entry, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  entry._compile(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText, filename);
};

const providerNames = ['deepseek', 'kimi', 'newapi', 'vidu', 'kling', 'minimax', 'volcengine', 'unicompapi-studio-h3'];
const providers = providerNames.map(name => {
  const relativePath = `src/platform/providers/${name}/${name}-contracts.ts`;
  const filename = path.join(workspace, relativePath);
  const exported = require(filename);
  const schemas = new Map();
  const models = new Map();
  for (const value of Object.values(exported)) {
    if (isSchema(value)) schemas.set(value.schemaId, value);
    if (Array.isArray(value)) for (const entry of value) {
      if (isSchema(entry)) schemas.set(entry.schemaId, entry);
      if (entry && entry.definition && Array.isArray(entry.parameterSchemas)) {
        addDefinition(models, entry.definition);
        entry.parameterSchemas.forEach(schema => schemas.set(schema.schemaId, schema));
      } else if (entry && entry.schemaVersion === 1 && entry.definitionId && Array.isArray(entry.profileTemplates)) {
        addDefinition(models, entry);
      }
    }
  }
  return {
    provider: name, sourceFile: relativePath, sourceFileSha256: hash(fs.readFileSync(filename)),
    declaredDocumentRevisions: Object.entries(exported).filter(([key]) => /SOURCE_DOCUMENT_REVISION/.test(key)).map(([,value]) => value),
    models: [...models.values()],
    schemas: [...schemas.values()],
    contractFactories: Object.keys(exported).filter(key => /^create.*(ModelContract|ModelDefinition)$/.test(key)),
    officialAlignment: officialContracts.some(contract => contract.vendor === officialVendor(name))
      ? 'source_contract_candidates_available' : name === 'unicompapi-studio-h3' ? 'relay_contract_only' : 'not_verified',
    officialContractCount: officialContracts.filter(contract => contract.vendor === officialVendor(name)).length
  };
});

const relativePath = 'src/platform/providers/newapi/unicompapi-model-capabilities.ts';
const filename = path.join(workspace, relativePath);
const exported = require(filename);
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
const modelKeys = [];
visit(source);
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'uniCompApiModelFeatureMap' &&
      node.initializer && ts.isNewExpression(node.initializer)) {
    const list = node.initializer.arguments && node.initializer.arguments[0];
    if (!list || !ts.isArrayLiteralExpression(list)) throw new Error('UniCompAPI model declarations cannot be inventoried');
    for (const entry of list.elements) {
      if (!ts.isArrayLiteralExpression(entry)) throw new Error('Invalid model declaration');
      const key = entry.elements[0];
      const value = ts.isStringLiteral(key) ? key.text : exported[key.getText(source)];
      if (typeof value !== 'string') throw new Error('Model declaration is not a stable exact key');
      modelKeys.push(value);
    }
  }
  ts.forEachChild(node, visit);
}
const schemas = Object.values(exported).filter(isSchema);
providers.push({
  provider: 'unicompapi', sourceFile: relativePath, sourceFileSha256: hash(fs.readFileSync(filename)),
  declaredDocumentRevisions: [], schemas,
  models: modelKeys.map(providerModelKey => {
    const features = exported.uniCompApiModelFeatures(providerModelKey);
    return {
      providerModelKey, features: features.map(productFeature => ({ productFeature,
        parameterSchemaId: schemaFor(productFeature, providerModelKey)?.schemaId ?? null })),
      officialAlignment: officialModelContracts.has(providerModelKey) ? 'exact_key_contract_candidate' : 'not_verified',
      officialContractIds: officialModelContracts.get(providerModelKey) ?? [],
      scope: features.length ? 'published_gateway_feature_mapping' : 'catalog_key_without_enabled_feature'
    };
  }),
  officialAlignment: 'partial_source_contract_candidates'
});
function schemaFor(feature, key) {
  if (feature === 'text_chat') return exported.uniCompApiTextChatParameterSchema;
  if (feature === 'text_reasoning') return exported.uniCompApiTextReasoningParameterSchema;
  if (feature === 'text_to_image') return exported.uniCompApiTextToImageParameterSchema(key);
  if (feature === 'reference_to_image') return exported.uniCompApiReferenceToImageParameterSchema(key);
  if (feature === 'text_to_video' || feature === 'image_to_video') return exported.uniCompApiVideoParameterSchema(key, feature);
  return undefined;
}

const report = {
  schemaVersion: 1, capturedAt: new Date().toISOString(), scope: 'published_source_contracts',
  evidenceKind: 'local_source_inventory', officialAlignment: 'partial_source_contract_candidates',
  officialContractCount: officialContracts.length,
  exactOfficialModelKeyCount: officialModelContracts.size,
  relayCardCount: 2,
  credentialReads: 0, liveProviderRequests: 0,
  sourceSchemaCount: providers.reduce((sum, provider) => sum + provider.schemas.length, 0),
  exactModelEntryCount: providers.reduce((sum, provider) => sum + provider.models.length, 0),
  providers
};
const evidencePath = path.join(workspace, 'docs/evidence/model-contract-sources-20261012.json');
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const approvedSkip = new Set(evidence.deferredByUser?.models ?? []);
const coverage = providers.flatMap(provider => provider.models.map(model => ({
  provider: provider.provider, providerModelKey: model.providerModelKey,
  features: model.features.map(feature => ({ productFeature: feature.productFeature, parameterSchemaId: feature.parameterSchemaId })),
  officialContractIds: model.officialContractIds ?? [],
  state: approvedSkip.has(model.providerModelKey) ? 'deferred_by_owner'
    : (model.officialContractIds?.length ?? 0) > 0 ? 'source_contract_candidate_requires_explicit_binding'
    : provider.provider === 'unicompapi-studio-h3' ? 'relay_owned_protocol'
    : 'unresolved_official_model_mapping',
  liveVerified: false
})));
evidence.publishedSourceInventory = { sourceSchemaCount: report.sourceSchemaCount, exactModelEntryCount: report.exactModelEntryCount,
  officialContractCount: officialContracts.length, exactOfficialModelKeyCount: officialModelContracts.size,
  allModelsOfficiallyAligned: false, coverage };
if (process.argv.includes('--write-evidence')) fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
const directory = path.join(workspace, 'outputs', 'model-contract-audit');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify({ ...report, coverage }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ sourceSchemaCount: report.sourceSchemaCount, exactModelEntryCount: report.exactModelEntryCount,
  officialContractCount: report.officialContractCount, exactOfficialModelKeyCount: report.exactOfficialModelKeyCount,
  providers: providers.map(provider => ({ provider: provider.provider, schemas: provider.schemas.length, modelEntries: provider.models.length,
    officialContracts: provider.officialContractCount ?? null, officialAlignment: provider.officialAlignment })),
  report: 'outputs/model-contract-audit/inventory.json' }, null, 2) + '\n');

function isSchema(value) { return value && value.schemaVersion === 2 && typeof value.schemaId === 'string' && Array.isArray(value.fields); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function addDefinition(models, definition) {
  models.set(definition.definitionId, { providerModelKey: definition.providerModelKey, definitionId: definition.definitionId,
    features: definition.profileTemplates.flatMap(template => template.features.map(feature => ({ ...feature,
      adapterKey: template.adapterKey, sourceDocumentRevision: template.sourceDocumentRevision }))),
    officialAlignment: officialModelContracts.has(definition.providerModelKey) ? 'exact_key_contract_candidate' : 'not_verified',
    officialContractIds: officialModelContracts.get(definition.providerModelKey) ?? [] });
}
function officialVendor(name) {
  return ({ kimi: 'moonshot', minimax: 'minimax', volcengine: 'volcengine', vidu: 'vidu', kling: 'kling', deepseek: 'deepseek' })[name] ?? name;
}
