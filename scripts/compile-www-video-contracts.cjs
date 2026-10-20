// Compile retained public gateway fields; this does not create vendor contracts.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const sourceFile = process.argv[2] ?? 'outputs/www-video-contracts/sources.json';
const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const retained = require('../src/platform/providers/newapi/www-video-catalog.retained-20261019.json');
function actionExampleFields(record) {
  const html = fs.readFileSync(path.join(path.dirname(sourceFile), `${record.modelKey}.html`), 'utf8');
  if (crypto.createHash('sha256').update(html).digest('hex') !== record.sha256) throw new Error('Documentation digest mismatch');
  const examples = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(match => {
    const plain = match[1].replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    try { return JSON.parse(plain); } catch { return undefined; }
  });
  const example = examples.find(item => item?.model === record.modelKey && item.operation === 'quote' && item.action === 'generate');
  if (!example?.parameters || !Object.keys(example.parameters).length) throw new Error('Documented generate example unavailable');
  // Examples establish names and primitive types, not enums or limits. In
  // particular, regenerate/understand restrictions do not constrain generate.
  return Object.entries(example.parameters).map(([name, value]) => {
    const type = typeof value;
    if (!/^[a-z_]+$/.test(name) || !['string', 'number', 'boolean'].includes(type)) throw new Error('Unsupported example parameter');
    return { name, required: null, example: value, schema: { type: type === 'number' && Number.isSafeInteger(value) ? 'integer' : type } };
  });
}
const entries = source.records.map(record => {
  if (record.status !== 200) throw new Error('Documentation unavailable');
  const fields = record.tables.filter(row => row[0]?.startsWith('parameters.')).map(row => {
    const name = row[0].match(/^parameters\.([a-z_]+)/)[1];
    const range = row[2].split('；')[0];
    const type = row[1].split(' ')[0];
    const schema = { type: type === 'integer' ? 'integer' : type === 'boolean' ? 'boolean' : 'string' };
    const bounds = range.match(/^(-?\d+)\s*–\s*(-?\d+)/);
    if (bounds) { schema.minimum = Number(bounds[1]); schema.maximum = Number(bounds[2]); }
    else if (type !== 'boolean') schema.enum = range.split('、').map(x => type === 'integer' ? Number(x) : x);
    if (name === 'frames') schema.multipleOf = 4; // adjusted below to a 29 + 4k enum
    if (name === 'frames') { delete schema.multipleOf; schema.enum = Array.from({ length: 66 }, (_, i) => 29 + i * 4); }
    if (!/·\s*(可选|必填)/.test(row[1])) throw new Error('Documented field requirement unavailable');
    return { name, required: row[1].includes('必填'), schema };
  });
  const key = record.modelKey;
  const h3 = key === 'MiniMax-H3';
  if (h3) fields.splice(0, fields.length, ...actionExampleFields(record));
  const features = h3 ? ['text_to_video'] : key.endsWith('-t2v') ? ['text_to_video']
    : /-i2v$|-r2v$/.test(key) ? ['image_to_video'] : key.endsWith('-video-edit') ? ['video_edit'] : ['text_to_video', 'image_to_video'];
  const previous = retained.contracts.find(contract => contract.modelKey === key);
  if (!previous) throw new Error('Retained contract unavailable');
  const promptLimits = (record.notes ?? []).flatMap(note => [...note.matchAll(/最多\s*([\d,]+)\s*字符|上限为\s*([\d,]+)\s*个Unicode字符/g)]
    .map(match => Number((match[1] ?? match[2]).replaceAll(',', ''))));
  if (new Set(promptLimits).size > 1) throw new Error('Conflicting documented prompt limits');
  return { id: `relay.unicompapi-www.${key}.video`, revision: previous.revision + 1, authority: 'relay', modelKey: key,
    ...(h3 ? { action: 'generate', parameterEvidence: 'documented_example_types_quote_validated',
      parameterExample: Object.fromEntries(fields.map(f => [f.name, f.example])) } : {}),
    source: { url: record.url, retrievedAt: record.retrievedAt, sha256: record.sha256 },
    vendorContractId: h3 ? 'official.minimax.MiniMax-H3.video' : key === 'doubao-seedance-2-0-260128' ? 'official.volcengine.seedance-2.0.video' : undefined,
    protocol: h3 ? 'h3-actions' : 'unicomp.media.v1', features, fields,
    quoteBinding: key.startsWith('happyhorse-1.1-') ? 'price_version_and_amount' : 'input_digest_and_price',
    referenceBinding: key.startsWith('happyhorse-1.1-') ? 'asset_ids' : 'explicit_roles',
    maximumPromptLength: promptLimits[0] ?? previous.maximumPromptLength,
    promptLimitEvidence: promptLimits.length ? 'documented_unicode_characters' : 'retained_product_limit',
    // Explicit product support boundary. New documentation enums never expand it automatically.
    supportedOutputFormats: ['mp4'],
    supportedImageModes: ['first_frame', ...(key.startsWith('doubao') ? [] : ['last_frame']), 'first_last_frame', 'reference_images'],
    imageLimits: { maximum: key.endsWith('-i2v') ? 1 : key.startsWith('wan') ? 10 : 9,
      minimumSide: key.endsWith('-r2v') ? 400 : key.startsWith('wan') ? 240 : 300,
      maximumSide: key.startsWith('happyhorse') ? 8192 : key.startsWith('wan') ? 8000 : 6000,
      maximumPixels: key.startsWith('happyhorse') ? 16000000 : key.startsWith('wan') ? 64000000 : 36000000,
      maximumBytes: key.startsWith('doubao') ? 29999999 : key.endsWith('-ali') ? 20000000 : 20 * 1024 * 1024,
      allowAlphaChannel: !(record.notes ?? []).some(note => note.includes('图片须无透明通道')),
      maximumTotalBytes: key.startsWith('happyhorse') || key === 'wan3.0-video' ? 20 * 1024 * 1024 : undefined },
    uploadProfile: key.startsWith('doubao') ? 'seedance-reference' : key.endsWith('-ali') ? 'aliyun-wan-reference' : key.endsWith('-video-edit') ? 'happyhorse-edit-reference' : undefined };
});
fs.writeFileSync('src/platform/providers/newapi/www-video-catalog.json', JSON.stringify({ schemaVersion: 1, contracts: entries }, null, 2) + '\n');
const evidenceFile = process.argv[3] ?? 'docs/evidence/video-parameter-repair-20261020/compile.json';
fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
fs.writeFileSync(evidenceFile, JSON.stringify({ compiledAt: new Date().toISOString(), sourceFile, outboundScope: 'compiler reads retained public documentation locally; no network', credentialReads: 0, generationRequests: 0,
  records: entries.map(c => ({ modelKey: c.modelKey, authority: c.authority, source: c.source, vendorContractId: c.vendorContractId })) }, null, 2) + '\n');
