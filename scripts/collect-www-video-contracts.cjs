// Read only public documentation. Never sends project content or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const keys = ['MiniMax-H3', 'doubao-seedance-2-0-260128', 'happyhorse-1.1-t2v', 'happyhorse-1.1-i2v', 'happyhorse-1.1-r2v', 'wan3.0-video', 'wan3.0-video-ali', 'wan3.0-video-prime-ali', 'happyhorse-1.0-video-edit'];
const clean = s => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
async function main() {
  const root = path.resolve('outputs/www-video-contracts');
  fs.mkdirSync(root, { recursive: true });
  const records = [];
  for (const key of keys) {
    const url = `https://www.unicompapi.com/docs/models/${key}`;
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    const section = body.match(/<section id="(?:parameters|fields|limits)"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    const tables = [...(section ?? body).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => clean(cell[1])));
    const record = { modelKey: key, url, retrievedAt: new Date().toISOString(), status: response.status,
      sha256: crypto.createHash('sha256').update(body).digest('hex'), tables,
      notes: [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(x => clean(x[1])).filter(x => x.length < 1800) };
    records.push(record);
    fs.writeFileSync(path.join(root, `${key}.html`), body);
    console.log(JSON.stringify({ modelKey: key, status: response.status, fields: tables.filter(row => row[0]?.startsWith('parameters.')), notes: record.notes.slice(-22) }));
  }
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ records, outboundScope: 'public documentation URL GET only', generationRequests: 0, credentialReads: 0 }, null, 2) + '\n');
}
main().catch(() => { console.error('Public documentation collection failed; no automatic retry.'); process.exitCode = 1; });
