// Explicitly authorized public documentation only. No credentials, model calls or retries.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { restorePublicDocumentHtml } = require('./lib/restore-public-document-html.cjs');

if (!process.argv.includes('--authorized-public-documents')) throw new Error('Public documentation authorization is required');
const directory = path.resolve(__dirname, '../outputs/model-contract-audit/sources');
fs.mkdirSync(directory, { recursive: true });
const initialSources = [
  ['openai-models', 'https://developers.openai.com/api/docs/models'],
  ['openai-chat', 'https://platform.openai.com/docs/api-reference/chat/create'],
  ['deepseek-chat', 'https://api-docs.deepseek.com/api/create-chat-completion'],
  ['kimi-chat', 'https://platform.kimi.com/docs/api/chat-completion.md'],
  ['kimi-search', 'https://platform.kimi.com/docs/guide/use-web-search.md'],
  ['glm-chat', 'https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md'],
  ['qwen-chat', 'https://help.aliyun.com/zh/model-studio/qwen-api-reference/'],
  ['qwen-image', 'https://help.aliyun.com/zh/model-studio/qwen-image-api'],
  ['vidu-text-video', 'https://platform.vidu.cn/docs/text-to-video'],
  ['vidu-reference-image', 'https://platform.vidu.cn/docs/reference-to-image'],
  ['vidu-reference-video', 'https://platform.vidu.cn/docs/reference-to-video'],
  ['kling-text-video', 'https://app.klingai.com/cn/dev/document-api/apiReference/model/textToVideo'],
  ['minimax-video', 'https://platform.minimaxi.com/docs/api-reference/video-generation'],
  ['volcengine-video', 'https://www.volcengine.com/docs/82379/1520757'],
  ['unicompapi-home', 'https://unicompapi.com/']
];
// Follow actual public document links/redirects discovered in the first batch.
const supplementalSources = [
  ['kimi-api-chat', 'https://platform.kimi.com/docs/api/chat.md'],
  ['kimi-models', 'https://platform.kimi.com/docs/api/models-overview.md'],
  ['kimi-k3', 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart.md'],
  ['glm-openapi', 'https://docs.bigmodel.cn/openapi/openapi.json'],
  ['qwen-openai-chat', 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions'],
  ['vidu-q3-text', 'https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video'],
  ['vidu-image-generation', 'https://platform.vidu.cn/docs/api-reference/image-generation'],
  ['minimax-video-current', 'https://platform.minimax.cn/docs/api-reference/video-generation'],
  ['volcengine-video-current', 'https://docs.volcengine.com/docs/82379/1520757'],
  ['kling-video-current', 'https://klingai.com/document-api/apiReference/model/textToVideo']
];
const catalogSources = [
  ['deepseek-models', 'https://api-docs.deepseek.com/quick_start/pricing'],
  ['deepseek-tools', 'https://api-docs.deepseek.com/guides/tool_calls'],
  ['vidu-q3-image', 'https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/image-to-video'],
  ['vidu-q3-reference', 'https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/reference-to-video'],
  ['minimax-doc-index', 'https://platform.minimax.cn/docs'],
  ['kling-public-doc-client', 'https://p4-kling.klingai.com/kcdn/cdn-kcdn112452/api-doc/assets/index-B4YRheOs.js'],
  ['unicompapi-public-doc-links', 'https://unicompapi.com/static/js/index.382ed15bdb.js'],
  ['qwen-image-edit', 'https://help.aliyun.com/zh/model-studio/qwen-image-edit-api']
];
const detailedSources = [
  ['minimax-h3-create', 'https://platform.minimax.cn/docs/api-reference/video-generation-v2-create.md'],
  ['kling-api-doc-loader', 'https://p4-kling.klingai.com/kcdn/cdn-kcdn112452/api-doc/assets/api-module-loader-fE9OcdWp.js'],
  ['kling-api-doc-navigation', 'https://p4-kling.klingai.com/kcdn/cdn-kcdn112452/api-doc/assets/DocumentNavigation-D40AtI73.js']
];
const schemaSources = [
  ['kling-text-video-schema', 'https://p4-kling.klingai.com/kcdn/cdn-kcdn112452/api-doc/assets/api-BqIZ9h2I.js'],
  ['kling-text-video-description', 'https://p4-kling.klingai.com/kcdn/cdn-kcdn112452/api-doc/assets/zh-C5a5ACo3.js']
];
const mediaSources = [
  ['qwen-model-overview', 'https://help.aliyun.com/zh/model-studio/getting-started/models'],
  ['volcengine-images', 'https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh'],
  ['unicompapi-www-home', 'https://www.unicompapi.com/']
];
const relaySources = [['unicompapi-www-docs', 'https://www.unicompapi.com/docs/api']];
const relayModelSources = [
  ['unicompapi-www-kimi-k3', 'https://www.unicompapi.com/docs/models/kimi-k3'],
  ['unicompapi-www-glm-5.2', 'https://www.unicompapi.com/docs/models/glm-5.2'],
  ['unicompapi-www-happyhorse', 'https://www.unicompapi.com/docs/models/happyhorse-1.1-t2v'],
  ['unicompapi-www-gpt-luna', 'https://www.unicompapi.com/docs/models/gpt-5.6-luna'],
  ['unicompapi-www-h3', 'https://www.unicompapi.com/docs/models/MiniMax-H3']
];
const remainingSources = [
  ['openai-chat-markdown', 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create.md'],
  ['openai-models-markdown', 'https://developers.openai.com/api/docs/models.md'],
  ['qwen-model-detail', 'https://help.aliyun.com/zh/model-studio/models'],
  ['unicompapi-www-doc-model-index', 'https://www.unicompapi.com/docs']
];
const legacySources = [
  ['qwen-image-old-api', 'https://help.aliyun.com/zh/model-studio/qwen-image-api-reference/'],
  ['qwen-image-legacy', 'https://help.aliyun.com/zh/model-studio/legacy-qwen-image-models/'],
  ['vidu-q2-text', 'https://platform.vidu.cn/docs/api-reference/video-models/vidu-q2/text-to-video'],
  ['vidu-q2-image', 'https://platform.vidu.cn/docs/api-reference/video-models/vidu-q2/image-to-video'],
  ['vidu-q1-reference', 'https://platform.vidu.cn/docs/api-reference/video-models/vidu-q1/reference-to-video'],
  ['volcengine-model-list', 'https://docs.volcengine.com/docs/ark/model-list?lang=zh'],
  ['qwen-happyhorse-api', 'https://help.aliyun.com/zh/model-studio/happyhorse-video-generation-api'],
  ['qwen-happyhorse-public-model', 'https://bailian.console.aliyun.com/cn-beijing/model/market/detail/happyhorse-1.1-t2v']
];
const sources = process.argv.includes('--legacy') ? legacySources : process.argv.includes('--remaining') ? remainingSources : process.argv.includes('--relay-models') ? relayModelSources : process.argv.includes('--relay') ? relaySources : process.argv.includes('--media') ? mediaSources : process.argv.includes('--schemas') ? schemaSources : process.argv.includes('--details') ? detailedSources : process.argv.includes('--catalog') ? catalogSources : process.argv.includes('--supplement') ? supplementalSources : initialSources;
const allowedHosts = new Set([...initialSources, ...supplementalSources, ...catalogSources, ...detailedSources, ...schemaSources, ...mediaSources, ...relaySources, ...relayModelSources, ...remainingSources, ...legacySources].map(([,url]) => new URL(url).hostname));
allowedHosts.add('platform.minimax.io');
allowedHosts.add('developers.openai.com');
const results = [];
async function retrieve([id, sourceUrl]) {
  const record = { id, sourceUrl, capturedAt: new Date().toISOString(), state: 'unavailable', requests: 0, outboundScope: 'public_document_url_only', cost: 0 };
  try {
    let target = new URL(sourceUrl);
    const signal = AbortSignal.timeout(20_000);
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (target.protocol !== 'https:' || target.username || target.password || !allowedHosts.has(target.hostname)) throw new Error('source_redirect_not_allowed');
      record.requests++;
      response = await fetch(target, { redirect: 'manual', signal, headers: { Accept: 'text/markdown,text/html,application/json', 'User-Agent': 'UniComp-Official-Contract-Audit/1.0' } });
      record.httpStatus = response.status;
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('source_redirect_limit');
      target = new URL(location, target);
    }
    record.resolvedUrl = target.toString();
    record.contentType = response.headers.get('content-type');
    if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
    const parts = []; let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length; if (size > 4 * 1024 * 1024) throw new Error('source_too_large');
      parts.push(Buffer.from(bytes));
    }
    const body = Buffer.concat(parts);
    record.byteLength = body.length;
    record.sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const text = body.toString('utf8');
    const documentUnavailable = /<title[^>]*>[^<]*(?:404|not found)/i.test(text) || /notfound:\s*["']true["']/i.test(text);
    const plain = /html/i.test(record.contentType ?? '') || /^\s*<!doctype html>/i.test(text)
      ? restorePublicDocumentHtml(text).replace(/<[^>]+>/g, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&#(?:39|x27);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n[\t ]*\n+/g, '\n') : text;
    fs.writeFileSync(path.join(directory, `${id}.body`), body);
    fs.writeFileSync(path.join(directory, `${id}.txt`), plain);
    record.state = documentUnavailable ? 'unavailable' : 'retrieved'; record.textLength = plain.length;
    if (documentUnavailable) record.safeCode = 'document_not_found';
  } catch (error) { record.safeCode = error instanceof Error && /^[a-z0-9_]+$/i.test(error.message) ? error.message : 'source_fetch_failed'; }
  results.push(record);
  process.stdout.write(JSON.stringify(record) + '\n');
}
(async () => {
  for (let index = 0; index < sources.length; index += 4) await Promise.all(sources.slice(index, index + 4).map(retrieve));
  const manifestPath = path.join(directory, 'manifest.json');
  const previous = process.argv.some(value => ['--supplement', '--catalog', '--details', '--schemas', '--media', '--relay', '--relay-models', '--remaining', '--legacy'].includes(value)) && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).sources : [];
  const merged = new Map(previous.map(record => [record.id, record]));
  for (const record of results) merged.set(record.id, record);
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, authorization: 'explicit_user_2026-10-12', retries: 0, credentialReads: 0, generationRequests: 0, sources: [...merged.values()] }, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
