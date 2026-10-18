// Compile retained public gateway fields; this does not create vendor contracts.
const fs = require('node:fs');
const source = JSON.parse(fs.readFileSync('outputs/www-video-contracts/sources.json', 'utf8'));
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
    return { name, schema };
  });
  const key = record.modelKey;
  const h3 = key === 'MiniMax-H3';
  if (h3) fields.push(
    { name: 'resolution', schema: { type: 'string', enum: ['2K'] } },
    { name: 'ratio', schema: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] } },
    { name: 'duration', schema: { type: 'integer', minimum: 4, maximum: 15 } },
    { name: 'generate_audio', schema: { type: 'boolean', enum: [true] } },
    { name: 'watermark', schema: { type: 'boolean' } });
  const features = h3 ? ['text_to_video'] : key.endsWith('-t2v') ? ['text_to_video']
    : /-i2v$|-r2v$/.test(key) ? ['image_to_video'] : key.endsWith('-video-edit') ? ['video_edit'] : ['text_to_video', 'image_to_video'];
  return { id: `relay.unicompapi-www.${key}.video`, revision: 1, authority: 'relay', modelKey: key,
    source: { url: record.url, retrievedAt: record.retrievedAt, sha256: record.sha256 },
    vendorContractId: h3 ? 'official.minimax.MiniMax-H3.video' : key === 'doubao-seedance-2-0-260128' ? 'official.volcengine.seedance-2.0.video' : undefined,
    protocol: h3 ? 'h3-actions' : 'unicomp.media.v1', features, fields,
    quoteBinding: key.startsWith('happyhorse-1.1-') ? 'price_version_and_amount' : 'input_digest_and_price',
    referenceBinding: key.startsWith('happyhorse-1.1-') ? 'asset_ids' : 'explicit_roles',
    maximumPromptLength: key.startsWith('wan') ? 20000 : 2500,
    imageLimits: { maximum: key.endsWith('-i2v') ? 1 : key.startsWith('wan') ? 10 : 9,
      minimumSide: key.endsWith('-r2v') ? 400 : key.startsWith('wan') ? 240 : 300,
      maximumSide: key.startsWith('happyhorse') ? 8192 : key.startsWith('wan') ? 8000 : 6000,
      maximumPixels: key.startsWith('happyhorse') ? 16000000 : key.startsWith('wan') ? 64000000 : 36000000,
      maximumBytes: key.startsWith('doubao') ? 29999999 : key.endsWith('-ali') ? 20000000 : 20 * 1024 * 1024,
      maximumTotalBytes: key.startsWith('happyhorse') || key === 'wan3.0-video' ? 20 * 1024 * 1024 : undefined },
    uploadProfile: key.startsWith('doubao') ? 'seedance-reference' : key.endsWith('-ali') ? 'aliyun-wan-reference' : key.endsWith('-video-edit') ? 'happyhorse-edit-reference' : undefined };
});
fs.writeFileSync('src/platform/providers/newapi/www-video-catalog.json', JSON.stringify({ schemaVersion: 1, contracts: entries }, null, 2) + '\n');
fs.mkdirSync('docs/evidence', { recursive: true });
fs.writeFileSync('docs/evidence/www-video-contract-sources-20261015.json', JSON.stringify({ retrievedAt: new Date().toISOString(), outboundScope: source.outboundScope, credentialReads: 0, generationRequests: 0,
  records: entries.map(c => ({ modelKey: c.modelKey, authority: c.authority, source: c.source, vendorContractId: c.vendorContractId })) }, null, 2) + '\n');
