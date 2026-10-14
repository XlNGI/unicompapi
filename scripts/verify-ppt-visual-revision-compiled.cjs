const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const JSZip = require('jszip');
const { DocumentGenerationRunner } = require('../dist-electron/src/platform/documents/document-generation-runner.js');
const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader.js');
const { createConfiguredOfficeRenderAdapter } = require('../dist-electron/src/platform/documents/office-render-adapter.js');
const { parsePresentationVisualRevisionRequest } = require('../dist-electron/src/application/presentation-design-revision.js');
const { toProjectId } = require('../dist-electron/src/domain/ids.js');
const { outline, optimizedDesign } = require('./generate-ppt-visual-audit-evidence.cjs');

(async () => {
  const renderer = createConfiguredOfficeRenderAdapter();
  assert(renderer, 'local Office/PDF renderer is required');
  const evidence = path.resolve('docs/evidence/ppt-visual-integration-20261014');
  const rootDirectory = path.resolve('outputs', 'ppt-visual-integration-' + Date.now());
  const projectId = toProjectId('ppt-visual-integration');
  const qaEvidence = [];
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId, renderPreview: async (temporaryPath, input) => {
    const qa = await renderer(temporaryPath, input);
    qaEvidence.push({ previewCount: qa.previewCount, diagnostics: qa.diagnostics ?? [] });
    return qa;
  }, requireRenderForPpt: true });
  const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
  const digest = value => createHash('sha256').update(value).digest('hex');
  const base = await runner.run({ kind: 'ppt', title: outline.title, outline, draftRevision: 1, sourceDraftId: 'visual-native-parent',
    contentFingerprint: digest('visual-native-parent'), userRequirement: 'Use a restrained technical style without changing content',
    requestArtDirection: async () => optimizedDesign() });
  const parent = await reader.readWithProductionPlan(base.work.id);
  assert(parent.productionPlan?.plan.designIR);
  const revision = parsePresentationVisualRevisionRequest('第四页更简洁一点', parent.pages.length);
  const result = await runner.run({ kind: 'ppt', title: outline.title, outline, draftRevision: 1, sourceDraftId: 'visual-native-revision',
    contentFingerprint: digest('visual-native-revision'), parentWorkId: base.work.id, sourceChecksumSha256: parent.file.checksumSha256,
    presentationVisualRevision: revision });
  const child = await reader.readWithProductionPlan(result.work.id);
  assert(child.productionPlan?.plan.designIR);
  assert.deepEqual(child.productionPlan.plan.contentSnapshot, parent.productionPlan.plan.contentSnapshot);
  assert.equal(child.pages.length, 6);
  const [before, after] = await Promise.all([JSZip.loadAsync(parent.buffer), JSZip.loadAsync(child.buffer)]);
  assert.notEqual(await before.file('ppt/slides/slide4.xml').async('string'), await after.file('ppt/slides/slide4.xml').async('string'));
  const preserved = [];
  for (const [name, entry] of Object.entries(before.files)) {
    if (entry.dir || ['[Content_Types].xml', 'ppt/slides/slide4.xml', 'ppt/slides/_rels/slide4.xml.rels'].includes(name)) continue;
    assert.deepEqual(await after.file(name).async('nodebuffer'), await entry.async('nodebuffer'), name);
    preserved.push(name);
  }
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, 'parent.pptx'), parent.buffer);
  await fs.writeFile(path.join(evidence, 'revised.pptx'), child.buffer);
  await fs.writeFile(path.join(evidence, 'parent-design.json'), JSON.stringify(parent.productionPlan.plan.designIR, null, 2));
  await fs.writeFile(path.join(evidence, 'revised-design.json'), JSON.stringify(child.productionPlan.plan.designIR, null, 2));
  const pngDirectory = path.join(rootDirectory, 'rendered');
  await fs.mkdir(pngDirectory, { recursive: true });
  for (const name of ['parent', 'revised']) {
    execFileSync(process.env.UNICOMP_OFFICE_RENDERER, [`-env:UserInstallation=${pathToFileURL(path.join(rootDirectory, 'office-' + name)).href}`,
      '--headless', '--convert-to', 'pdf', '--outdir', pngDirectory, path.join(evidence, name + '.pptx')], { windowsHide: true, timeout: 60_000, stdio: 'ignore' });
    execFileSync(process.env.UNICOMP_PDF_RENDERER, ['-png', '-r', '120', path.join(pngDirectory, name + '.pdf'), path.join(pngDirectory, name)],
      { windowsHide: true, timeout: 60_000, stdio: 'ignore' });
    for (let page = 1; page <= child.pages.length; page++) await fs.copyFile(path.join(pngDirectory, `${name}-${page}.png`), path.join(evidence, `${name}-page-${page}.png`));
  }
  const report = { schemaVersion: 1, date: '2026-10-14', basis: 'compiled production Runner with local Office/PDF QA',
    providerRequests: 0, planner: 'deterministic semantic fixture (not a live LLM)', multimodalReview: 'not_available',
    targetPages: [4], pages: child.pages.length, canonicalContentPreserved: true, productionPlanReadback: true,
    untouchedPartsPreserved: preserved, parentSha256: digest(parent.buffer), revisedSha256: digest(child.buffer),
    outcomes: { parent: base.execution.state, revised: result.execution.state },
    renderedQa: qaEvidence,
    layoutAudit: child.productionPlan.plan.snapshot.visualAudit };
  await fs.writeFile(path.join(evidence, 'validation.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ evidence, pages: child.pages.length, preservedParts: preserved.length, outcomes: report.outcomes }) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
