/* Offline proof of the compiled Host pipeline. No model output is executed. */
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { access, copyFile, mkdir, readFile, readdir, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const typescript = require('typescript');
const JSZip = require('jszip');

const workspace = path.resolve(__dirname, '..');
const proofRoot = path.join(workspace, 'outputs', 'ppt-organization-proof');
const runId = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
const outputDirectory = path.join(proofRoot, runId);
const deadlineAt = Date.now() + 120_000;
const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
const report = { schemaVersion: 1, status: 'in_progress', syntheticData: true, startedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform }, externalCalls: 0, blockedNetworkCalls: 0,
  providerRequests: 0, executionBoundary: 'compiled DocumentGenerationRunner / configured local Office QA / verified registered Work',
  qaResults: [], rendererConfigurationSource: {}, outputDirectory };
let supervisor;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function assert(value, message) { if (!value) throw new Error(message); }
function requireCompiled(relativePath) { return require(path.join(workspace, 'dist-electron', 'src', relativePath)); }
function readRendererSetting(name) {
  const current = process.env[name]?.trim();
  if (current) { report.rendererConfigurationSource[name] = 'process_environment'; return current; }
  if (process.platform !== 'win32') return undefined;
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', timeout: 2_000,
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const value = /REG_(?:EXPAND_)?SZ\s+(\S.*)$/m.exec(output)?.[1]?.trim();
      if (value) { report.rendererConfigurationSource[name] = key.startsWith('HKCU') ? 'user_renderer_setting' : 'machine_renderer_setting'; return value; }
    } catch { /* Only the two explicitly configured renderer settings are queried. */ }
  }
  return undefined;
}

function denyNetwork() {
  const denied = () => { report.blockedNetworkCalls += 1; throw new Error('offline_proof_network_forbidden'); };
  require('node:http').request = denied;
  require('node:http').get = denied;
  require('node:https').request = denied;
  require('node:https').get = denied;
  globalThis.fetch = denied;
}

async function loadFixture() {
  const sourcePath = path.join(workspace, 'tests', 'fixtures', 'presentation-organization-pages.ts');
  const source = await readFile(sourcePath, 'utf8');
  // This is a checked-in synthetic fixture, not a Provider payload or attachment.
  const emitted = typescript.transpileModule(source, { compilerOptions: { target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.CommonJS }, fileName: sourcePath }).outputText;
  const allowedImport = '../../src/domain/entities/presentation-design-contract';
  const imports = [...emitted.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]);
  assert(imports.length === 1 && imports[0] === allowedImport, 'unexpected_fixture_runtime_import');
  const compiledDomain = path.join(workspace, 'dist-electron', 'src', 'domain', 'entities', 'presentation-design-contract.js');
  const fixturePath = path.join(outputDirectory, 'synthetic-organization-fixture.cjs');
  await writeFile(fixturePath, emitted.replace(`require("${allowedImport}")`, `require(${JSON.stringify(compiledDomain)})`));
  report.fixtureSourceHash = sha256(source);
  return require(fixturePath);
}

async function runLocal(command, args) {
  signal.throwIfAborted();
  const timeoutMs = Math.max(1, Math.min(60_000, deadlineAt - Date.now()));
  const handle = supervisor.start({ command, args, timeoutMs, maxStdoutBytes: 0, maxStderrBytes: 0 });
  const cancel = () => handle.cancel('cancelled');
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await handle.promise;
    assert(!result.terminationReason && result.code === 0, 'local_renderer_process_failed');
  } finally { signal.removeEventListener('abort', cancel); }
  signal.throwIfAborted();
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  denyNetwork();
  const rendererEnvironment = { UNICOMP_OFFICE_RENDERER: readRendererSetting('UNICOMP_OFFICE_RENDERER'),
    UNICOMP_PDF_RENDERER: readRendererSetting('UNICOMP_PDF_RENDERER') };
  for (const executable of Object.values(rendererEnvironment)) {
    assert(executable && path.isAbsolute(executable), 'explicit_local_renderer_configuration_unavailable');
    await access(executable);
  }
  const { DocumentGenerationRunner } = requireCompiled('platform/documents/document-generation-runner.js');
  const { RegisteredPresentationReader } = requireCompiled('platform/documents/registered-presentation-reader.js');
  const { createConfiguredOfficeRenderAdapter } = requireCompiled('platform/documents/office-render-adapter.js');
  const { ManagedProcessSupervisor } = requireCompiled('platform/runtime/managed-process.js');
  const { NodeProjectStorage } = requireCompiled('platform/storage/index.js');
  const { JsonWorkRepository } = requireCompiled('platform/repositories/json-repositories.js');
  const { toProjectId } = requireCompiled('domain/index.js');
  const { parsePresentationDesignIR } = requireCompiled('domain/entities/presentation-design-contract.js');
  const compiledFiles = ['platform/documents/document-generation-runner.js', 'platform/documents/presentation-style-compiler.js',
    'domain/entities/presentation-design-contract.js', 'domain/entities/presentation-content-organization.js',
    'domain/entities/presentation-layout-ir.js',
    'platform/documents/presentation-page-features.js', 'platform/documents/presentation-layout-engine.js',
    'platform/documents/presentation-layout-ir-adapter.js',
    'platform/documents/presentation-render-plan-compiler.js', 'platform/documents/presentation-design-renderer.js',
    'platform/documents/registered-presentation-reader.js', 'platform/documents/presentation-production-plan-reader.js'];
  report.compiledHashes = await Promise.all(compiledFiles.map(async file => ({ file: `dist-electron/src/${file}`,
    sha256: sha256(await readFile(path.join(workspace, 'dist-electron', 'src', file))) })));
  const fixture = await loadFixture();
  const outline = structuredClone(fixture.organizationPagesOutline);
  const design = parsePresentationDesignIR(fixture.organizationPagesDesign(), { outline });
  const rootDirectory = path.join(outputDirectory, 'isolated-project');
  await mkdir(rootDirectory, { recursive: true });
  const projectId = toProjectId(`ppt-organization-proof-${runId}`);
  const renderer = createConfiguredOfficeRenderAdapter(rendererEnvironment);
  assert(renderer, 'configured_local_renderer_unavailable');
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId, requireRenderForPpt: true,
    renderPreview: async (temporaryPath, input) => {
      const observed = await renderer(temporaryPath, input);
      report.qaResults.push(structuredClone(observed));
      return observed; // No diagnostic is filtered or downgraded.
    } });
  const generated = await runner.run({ kind: 'ppt', title: outline.title, outline,
    executionId: `organization-proof-${runId}`, sourceDraftId: `synthetic-organization-${runId}`, draftRevision: 1,
    contentFingerprint: sha256(JSON.stringify(outline)), presentationTemplate: 'work_report', signal,
    userRequirement: 'Synthetic fixture: explicit content groups and sequence relationships, preserved facts, compiled local organization acceptance.',
    requestArtDirection: async () => design });
  assert(generated.execution.state === 'completed', 'formal_generation_did_not_complete');
  const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
  const actual = await reader.readWithProductionPlan(generated.work.id);
  const privatePlan = actual.productionPlan;
  assert(privatePlan?.plan.snapshot.designPath === 'design-aware', 'registered_work_not_design_aware');
  assert(actual.pages.length === 7 && privatePlan.plan.renderPlan?.pages.length === 7, 'unexpected_registered_page_count');
  const bodyPages = privatePlan.plan.layoutIR?.pages.filter(page => page.source.kind === 'content');
  assert(bodyPages?.length === 5 && bodyPages.every(page => page.organization?.source === 'explicit'), 'explicit_organization_not_retained');
  const packageZip = await JSZip.loadAsync(actual.buffer);
  report.savedOrganizationGeometry = [];
  for (const page of bodyPages) {
    const slideXml = await packageZip.file(`ppt/slides/slide${page.pageNumber}.xml`).async('string');
    const groups = page.organization.groups.map(group => {
      const boxes = group.sourceRefs.map(sourceRef => {
        const matches = page.elements.filter(element => element.source.kind === 'content' && element.source.ref === sourceRef);
        assert(matches.length === 1, 'organization_member_not_unique');
        const element = matches[0];
        const shapes = [...slideXml.matchAll(/<p:(?:sp|graphicFrame)\b[^>]*>[\s\S]*?<\/p:(?:sp|graphicFrame)>/g)]
          .filter(match => match[0].includes(`name="UniComp Render ${element.elementId}"`));
        assert(shapes.length === 1, 'saved_organization_member_not_unique');
        const offset = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(shapes[0][0]);
        const extent = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(shapes[0][0]);
        assert(offset && extent, 'saved_organization_geometry_missing');
        const box = { x: Number(offset[1]) / 914_400, y: Number(offset[2]) / 914_400,
          width: Number(extent[1]) / 914_400, height: Number(extent[2]) / 914_400 };
        assert(Object.keys(box).every(key => Math.abs(box[key] - element.geometry[key]) <= 3 / 914_400), 'saved_organization_geometry_changed');
        return { sourceRef, ...box };
      });
      const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
      return { groupId: group.groupId, role: group.role, members: boxes, bounds: { x, y,
        width: Math.max(...boxes.map(box => box.x + box.width)) - x,
        height: Math.max(...boxes.map(box => box.y + box.height)) - y } };
    });
    report.savedOrganizationGeometry.push({ pageNumber: page.pageNumber, layout: page.organization.layout, groups });
  }
  const works = await new JsonWorkRepository(new NodeProjectStorage(rootDirectory), projectId).list(projectId);
  assert(works.length === 1 && works[0].id === generated.work.id, 'expected_exactly_one_registered_work');
  const samplePptPath = path.join(outputDirectory, 'synthetic-grouped-organization-sample.pptx');
  assert(actual.file.locator.kind === 'project', 'registered_file_not_project_scoped');
  const registeredPptPath = path.join(rootDirectory, actual.file.locator.relativePath);
  await copyFile(registeredPptPath, samplePptPath);
  const checksum = sha256(await readFile(samplePptPath));
  assert(checksum === actual.file.checksumSha256, 'sample_copy_hash_changed');
  const previewDirectory = path.join(outputDirectory, 'preview');
  const profileDirectory = path.join(outputDirectory, 'retained-office-profile');
  await mkdir(previewDirectory, { recursive: true });
  await mkdir(profileDirectory, { recursive: true });
  supervisor = new ManagedProcessSupervisor();
  await runLocal(rendererEnvironment.UNICOMP_OFFICE_RENDERER, [
    `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`, '--headless', '--convert-to', 'pdf', '--outdir', previewDirectory, samplePptPath
  ]);
  const pdfFiles = (await readdir(previewDirectory)).filter(file => /\.pdf$/i.test(file));
  assert(pdfFiles.length === 1, 'retained_renderer_did_not_produce_one_pdf');
  const pdfPath = path.join(previewDirectory, pdfFiles[0]);
  await runLocal(rendererEnvironment.UNICOMP_PDF_RENDERER, ['-r', '96', '-png', pdfPath, path.join(previewDirectory, 'page')]);
  const pngPaths = (await readdir(previewDirectory)).filter(file => /^page-\d+\.png$/i.test(file))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0])).map(file => path.join(previewDirectory, file));
  assert(pngPaths.length === 7, 'retained_renderer_page_count_mismatch');
  for (const pngPath of pngPaths) {
    const buffer = await readFile(pngPath);
    assert(buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'invalid_retained_png');
  }
  report.status = 'passed';
  report.workId = actual.work.id;
  report.registeredWorkCount = works.length;
  report.fileHashMatches = true;
  report.fileHash = checksum;
  report.fileBytes = (await stat(samplePptPath)).size;
  report.designAware = true;
  report.rendererPages = 7;
  report.privateAttempt = privatePlan.attempt.attempt;
  report.privateContentHash = privatePlan.attempt.contentHash;
  report.privateLayoutHash = privatePlan.attempt.layoutHash;
  report.privateRenderHash = privatePlan.attempt.renderHash;
  report.styleFields = privatePlan.plan.renderPlan.pages.map(page => ({ role: page.pageRole, backgroundColor: page.backgroundColor,
    elements: page.elements.map(element => ({ type: element.type, renderId: element.renderId, geometry: element.geometry, style: element.style })) }));
  report.organization = bodyPages.map(page => ({ pageNumber: page.pageNumber, pageId: page.pageId,
    organization: page.organization }));
  report.explicitOrganizationPages = bodyPages.length;
  report.artifacts = { registeredPptPath, samplePptPath, pdfPath, pngPaths };
  report.limitations = ['Synthetic business facts; no external model or paid Provider.',
    'Structural QA does not score aesthetics or color contrast; style colors are private compiled plan facts.',
    'The production QA temporary previews are deleted by the existing adapter; separately retained local previews show this exact verified sample copy.',
    'User application, credentials, profiles and real PPT files were not opened or modified.'];
}

main().catch(error => {
  report.status = 'failed';
  report.failure = { name: error?.name ?? 'Error', code: error?.code ?? 'proof_failed', message: String(error?.message ?? 'unknown').slice(0, 300) };
  process.exitCode = 1;
}).finally(async () => {
  if (supervisor) await supervisor.terminateAll('shutdown');
  report.completedAt = new Date().toISOString();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(proofRoot, 'latest.json'), JSON.stringify({ status: report.status, runId,
    reportPath: path.join(outputDirectory, 'report.json'), artifacts: report.artifacts }, null, 2));
  process.stdout.write(`${JSON.stringify({ status: report.status, reportPath: path.join(outputDirectory, 'report.json'),
    artifacts: report.artifacts, failure: report.failure })}\n`);
});

