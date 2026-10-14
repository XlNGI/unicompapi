/* Synthetic model plans through the compiled production runner. No provider/network calls. */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fsSync.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file);
const { authoredFixtureDesign, autonomousOutline, bodyRefs, splitTree } = require('../tests/fixtures/presentation-autonomous-design.ts');
const { DocumentGenerationRunner } = require('../dist-electron/src/platform/documents/document-generation-runner');
const { buildDocumentIRFromOutline } = require('../dist-electron/src/domain/entities/document-agent');
const { createConfiguredOfficeRenderAdapter, inspectPptxGeometry } = require('../dist-electron/src/platform/documents/office-render-adapter');
const { presentationAttemptPath } = require('../dist-electron/src/platform/documents/presentation-design-attempts');
const { NodeProjectStorage, toProjectRelativePath } = require('../dist-electron/src/platform/storage');
const { JsonWorkRepository } = require('../dist-electron/src/platform/repositories');
const { toProjectId } = require('../dist-electron/src/domain');

const output = path.resolve('docs/evidence/llm-autonomous-design-20261014');
const getRenderer = name => process.env[name] || ['User', 'Machine'].map(scope => execFileSync('powershell', ['-NoProfile', '-Command',
  `[Environment]::GetEnvironmentVariable('${name}','${scope}')`], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim()).find(Boolean);
const office = getRenderer('UNICOMP_OFFICE_RENDERER'), pdfRenderer = getRenderer('UNICOMP_PDF_RENDERER');
if (!office || !pdfRenderer) throw new Error('local_office_renderer_unavailable');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function pngChunk(name, bytes) { const type = Buffer.from(name), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([len, type, bytes, sum]); }
function localBitmap() {
  const width = 600, height = 400, rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * (width * 3 + 1) + 1 + x * 3;
    const wave = (Math.sin(x / 80 + y / 70) + 1) / 2;
    rows[p] = 10 + Math.floor(20 * wave); rows[p + 1] = 40 + Math.floor(130 * wave); rows[p + 2] = 80 + Math.floor(90 * x / width);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
function plans() {
  const grid = { schemaVersion: 1, root: { nodeId: 'grid', type: 'grid', columns: 2, gap: 0.04, children: [
    { nodeId: 'headline', type: 'content', columnSpan: 2, contentRef: bodyRefs[0], style: { fontSize: 38, fontWeight: 700 } },
    { nodeId: 'retention', type: 'content', contentRef: bodyRefs[1], style: { fontSize: 24, color: '1F5FBF', verticalAlignment: 'middle' },
      textSpans: [{ start: 8, end: 11, style: { fontSize: 48, fontWeight: 700 } }] },
    { nodeId: 'delivery', type: 'column', gap: 0.06, padding: 0.06, style: { fill: 'F1F5F9' }, children: bodyRefs.slice(2).map((contentRef, i) => ({
      nodeId: `support-${i}`, type: 'content', contentRef, style: { fontSize: 24 } })) }
  ] } };
  const picture = { schemaVersion: 1, root: { nodeId: 'story', type: 'column', gap: 0.04, children: [
    { nodeId: 'headline', type: 'content', contentRef: bodyRefs[0], weight: 20, style: { fontSize: 34, fontWeight: 700 } },
    { nodeId: 'body', type: 'row', weight: 80, gap: 0.06, children: [
      { nodeId: 'copy', type: 'column', weight: 55, gap: 0.04, children: bodyRefs.slice(1).map((contentRef, i) => ({
        nodeId: `fact-${i}`, type: 'content', contentRef, style: { fontSize: i === 0 ? 30 : 24, color: i === 0 ? '35D6C8' : 'F5FAFF' } })) },
      { nodeId: 'art', type: 'image', weight: 45, assetKey: 'image-1', imageFit: 'cover', imageMask: 'ellipse' }
    ] }
  ] } };
  return [['split-65-35', authoredFixtureDesign(autonomousOutline, splitTree())], ['editorial-grid', authoredFixtureDesign(autonomousOutline, grid)],
    ['image-composition', { ...authoredFixtureDesign(autonomousOutline, picture), globalDesign: { ...authoredFixtureDesign().globalDesign,
      visualSystem: { palette: { background: '07111F', surface: '102A43', text: 'F5FAFF', muted: 'B7C9DC', accent: '35D6C8', secondaryAccent: 'FE5EA8' } } } }]]
    .map(([name, plan]) => [name, { ...plan, pages: plan.pages.map(page => page.pageRole !== 'hero' && page.pageRole !== 'closing' ? page : {
      ...page, designTree: { ...page.designTree, root: { ...page.designTree.root, children: page.designTree.root.children.map(node => ({ ...node,
        style: { ...node.style, verticalAlignment: 'middle' } })) } } }) }]);
}
async function savePages(file, name, temp) {
  const renderRoot = path.join(temp, name), pdfRoot = path.join(renderRoot, 'pdf'); await fs.mkdir(pdfRoot, { recursive: true });
  execFileSync(office, [`-env:UserInstallation=${pathToFileURL(path.join(renderRoot, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', pdfRoot, file], { windowsHide: true, timeout: 60000, stdio: 'ignore' });
  const pdf = path.join(pdfRoot, `${path.basename(file, '.pptx')}.pdf`);
  execFileSync(pdfRenderer, ['-png', '-r', '100', pdf, path.join(renderRoot, 'page')], { windowsHide: true, timeout: 60000, stdio: 'ignore' });
  const pages = (await fs.readdir(renderRoot)).filter(name => /^page-\d+\.png$/u.test(name)).sort();
  for (const page of pages) await fs.copyFile(path.join(renderRoot, page), path.join(output, `${name}-${page}`));
  await fs.copyFile(pdf, path.join(output, `${name}.pdf`)); return pages.length;
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-design-evidence-'));
  try {
    const assetPath = path.join(temp, 'approved-bitmap.png'); await fs.writeFile(assetPath, localBitmap());
    const cases = [];
    for (const [name, design] of plans()) {
      const projectRoot = path.join(temp, `project-${name}`), projectId = toProjectId(`synthetic-${name}`);
      const storage = new NodeProjectStorage(projectRoot); let requests = 0;
      const usesImage = name === 'image-composition';
      const fileOptions = {};
      if (usesImage) {
        // Host-only file binding; the model receives image-1/aspect ratio, not this path.
        const { createFileReference, toFileReferenceId, toIsoTimestamp, transitionFile } = require('../dist-electron/src/domain');
        const { JsonFileReferenceRepository } = require('../dist-electron/src/platform/repositories');
        const target = path.join(projectRoot, 'files', 'assets', 'approved-bitmap.png'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(assetPath, target);
        const bytes = await fs.readFile(target), timestamp = toIsoTimestamp('2026-10-14T16:00:00.000Z');
        let reference = createFileReference({ id: toFileReferenceId('synthetic-local-image'), projectId,
          locator: { kind: 'project', relativePath: toProjectRelativePath('files/assets/approved-bitmap.png') }, sizeBytes: bytes.length, createdAt: timestamp });
        reference = transitionFile(reference, 'verifying', timestamp);
        reference = transitionFile(reference, 'available', timestamp, { sizeBytes: bytes.length, checksumSha256: sha(bytes) });
        await new JsonFileReferenceRepository(storage, projectId).save(reference);
        fileOptions.images = [{ fileId: reference.id }];
      }
      const result = await new DocumentGenerationRunner({ rootDirectory: projectRoot, projectId,
        requireRenderForPpt: true, renderPreview: createConfiguredOfficeRenderAdapter() }).run({
        kind: 'ppt', title: autonomousOutline.title, outline: autonomousOutline,
        documentIR: buildDocumentIRFromOutline({ outline: autonomousOutline, operation: 'create' }),
        contentFingerprint: sha(JSON.stringify(autonomousOutline)), sourceDraftId: `synthetic-${name}`, draftRevision: 1,
        userRequirement: 'Synthetic model-authored page composition; preserve all supplied facts.', requestArtDirection: async () => { requests++; return design; }, ...fileOptions
      });
      const original = path.join(projectRoot, result.file.locator.relativePath), target = path.join(output, `${name}.pptx`); await fs.copyFile(original, target);
      const attempt = await storage.readJson(presentationAttemptPath(result.execution.id, 0));
      const receipt = await storage.readJson(presentationAttemptPath(result.execution.id, 0, true));
      await fs.writeFile(path.join(output, `${name}-design.json`), JSON.stringify(attempt.plan.designIR, null, 2));
      await fs.writeFile(path.join(output, `${name}-layout.json`), JSON.stringify(attempt.plan.layoutIR, null, 2));
      const geometry = await inspectPptxGeometry(target); const pages = await savePages(target, name, temp);
      const works = await new JsonWorkRepository(storage, projectId).list(projectId);
      if (works.length !== 1 || works[0].id !== result.work.id) throw new Error('case_work_registration_mismatch');
      cases.push({ name, pages, plannerRequests: requests, externalRequests: 0, execution: result.execution.state, workCount: works.length,
        fileHash: result.file.checksumSha256, geometryErrors: geometry.length, qaOutcome: receipt.qaOutcome,
        designExecution: attempt.plan.snapshot.designExecution, visualAudit: attempt.plan.snapshot.visualAudit });
    }
    const report = { schemaVersion: 1, date: '2026-10-14', status: 'passed', modelOutput: 'synthetic offline planner fixtures',
      boundary: 'compiled production Runner -> admitted Design IR -> Layout IR -> real PPTX -> native Office/PDF QA -> hash/publication/Work',
      cases, externalProviderCalls: 0, subjectiveMultimodalReview: 'not_available' };
    await fs.writeFile(path.join(output, 'cases.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write(error.stack || String(error)); process.exitCode = 1; });
