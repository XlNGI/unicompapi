// Recover one accepted WWW video through the production recovery runtime.
// --apply permits local landing only. Transport rejects every POST, including settlement.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit' });
  child.on('error', () => { console.error('Recovery process unavailable'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, safeStorage } = require('electron');
  const option = name => {
    const at = process.argv.indexOf(name);
    assert.ok(at >= 0 && process.argv[at + 1], 'Required recovery option missing');
    return process.argv[at + 1];
  };
  const projectDirectory = path.resolve(option('--project-directory'));
  const executionId = option('--execution-id');
  const output = path.resolve(option('--output-directory'));
  const apply = process.argv.includes('--apply');
  const originalRoot = path.join(app.getPath('appData'), 'unicomp-desktop');
  const profile = path.join(__dirname, '../.cache/www-video-result-recovery-20261019', String(process.pid));
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(path.join(originalRoot, 'Local State'), path.join(profile, 'Local State'));
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  let networkRuntime;
  const requests = [];
  const protectedSnapshot = [];
  async function main() {
    await app.whenReady();
    const p = require('../dist-electron/src/platform');
    const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
    const manifest = read(path.join(projectDirectory, 'project.json'));
    const session = { projectId: manifest.id, projectName: manifest.name, rootDirectory: projectDirectory };
    const storage = new p.NodeProjectStorage(projectDirectory);
    const executions = new p.JsonExecutionRepository(storage, session.projectId);
    const tasks = new p.JsonTaskRepository(storage, session.projectId);
    const works = new p.JsonWorkRepository(storage, session.projectId);
    const execution = await executions.get(executionId);
    assert.ok(execution?.remoteOperationId && execution.submissionOutcome === 'accepted_async', 'No accepted original task');
    const task = await tasks.get(execution.taskId);
    assert.equal(task?.projectId, session.projectId);
    const registryPath = path.join(originalRoot, 'provider-registry.json');
    const protectedFiles = [registryPath, path.join(projectDirectory, 'project.json'),
      ...['tasks.json', 'provider-operations.json', 'provider-execution-route-snapshots.json', 'video-workspace-drafts.json'].map(file => path.join(projectDirectory, 'entities', file))];
    const protectedHashes = protectedFiles.map(file => sha(fs.readFileSync(file)));
    protectedSnapshot.push(...protectedFiles.map((file, i) => ({ name: path.basename(file), file, sha256: protectedHashes[i] })));
    const invocationRepository = new p.JsonProviderInvocationRepository(storage, session.projectId);
    const invocation = (await invocationRepository.list()).find(i => i.subject.kind === 'media' && i.subject.executionId === executionId);
    const route = invocation && await new p.JsonProviderExecutionRouteSnapshotRepository(storage, session.projectId).get(invocation.routeSnapshotId);
    assert.equal(route?.packageId, p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID);
    const existing = (await works.list(session.projectId)).filter(w => w.sourceTaskId === task.id);
    if (!apply) {
      console.log(JSON.stringify({ status: 'ready', localState: execution.state, remoteTaskId: execution.remoteOperationId, existingWorks: existing.length, writes: 0, requests: 0 }));
      return;
    }
    const transport = new ElectronNewApiHttpTransport();
    networkRuntime = new p.NewApiSharedRuntime({ transport: { async send(request) {
      const attempt = { method: request.method, path: new URL(request.url).pathname };
      requests.push(attempt);
      try {
      const url = new URL(request.url);
      assert.equal(request.method, 'GET', 'Original recovery must never generate, upload or settle');
      assert.equal(url.origin, 'https://www.unicompapi.com');
      const prefix = '/v1/' + (route.providerModelKey === 'MiniMax-H3' ? 'h3/tasks/' : 'videos/');
      assert.ok(url.pathname === prefix + execution.remoteOperationId || url.pathname === '/v1/videos/' + execution.remoteOperationId + '/content');
      if (url.pathname.endsWith('/content')) assert.match(url.searchParams.get('asset_id') ?? '', /^[A-Za-z0-9_-]{1,200}$/);
      assert.equal(request.body, undefined);
      assert.ok(requests.length <= 12, 'Recovery request bound exceeded');
      const response = await transport.send(request);
      attempt.status = response.status;
      return response;
      } catch (error) {
        attempt.error = { name: error.name, code: error.code, kind: error.kind,
          assertion: error.name === 'AssertionError' ? error.message : undefined };
        throw error;
      }
    } }, defaultTimeoutMs: 45_000 });
    const registry = new p.JsonProviderRegistryStore(registryPath);
    const vault = new p.SecureCredentialVault(path.join(originalRoot, 'secure-credentials.json'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(), protect: v => safeStorage.encryptString(v), unprotect: v => safeStorage.decryptString(Buffer.from(v))
    });
    const usage = new p.JsonProviderUsageObservationRepository(storage);
    const adapter = p.createNewApiVideoAdapterFromRuntimes({ newApiRuntime: networkRuntime, credentialVault: vault, providerRegistry: registry,
      materials: new p.ProjectImageMaterialResolver({ getSession: () => session }), usage });
    const mutations = new p.VideoWorkspaceMutationCoordinator();
    const receiver = new p.LocalVideoResultReceiver({ getSession: () => session, mutations, port: adapter });
    const runtime = p.createVideoFeatureControllerRuntime({ session, providerRegistry: registry,
      providerPackages: new p.ProviderPackageRegistry([p.unicompapiWwwProviderPackageDescriptor]),
      runtimeAuthorization: { async checkAccess() { return { allowed: false, operation: 'submit', reason: 'no_matching_policy' }; } },
      asyncOperationPort: adapter, attachNewApiVideoOperation: input => adapter.attachOperation(input), resultReceiver: receiver, mutations });
    assert.equal(runtime.submit, undefined, 'Recovery runtime must not have a submission path');
    let recovered;
    if (execution.state === 'completed' && existing.length === 1) recovered = { taskId: task.id, executionId, workId: existing[0].id };
    else {
      assert.equal(existing.length, 0, 'Unexpected pre-existing result; review before recovery');
      assert.equal(execution.state, 'failed');
      recovered = await runtime.recoverResult(task.id);
    }
    const finalExecution = await executions.get(executionId);
    assert.equal(finalExecution.state, 'completed');
    const finalWorks = (await works.list(session.projectId)).filter(w => w.sourceTaskId === task.id);
    assert.equal(finalWorks.length, 1);
    assert.equal(finalWorks[0].id, recovered.workId);
    const file = await new p.JsonFileReferenceRepository(storage, session.projectId).get(finalWorks[0].fileId);
    assert.equal(file.state, 'available');
    const local = await p.resolveFileReferencePathSafely(projectDirectory, file);
    const metadata = await new p.NodeVideoInspector().inspect(local);
    assert.equal(metadata.mimeType, 'video/mp4'); assert.ok(metadata.durationMs > 0);
    assert.equal(sha(fs.readFileSync(local)), file.checksumSha256);
    const protectedUnchanged = protectedFiles.every((filePath, i) => sha(fs.readFileSync(filePath)) === protectedHashes[i]);
    assert.equal(protectedUnchanged, true);
    const report = { capturedAt: new Date().toISOString(), status: 'passed', model: route.providerModelKey, remoteTaskId: execution.remoteOperationId,
      taskId: task.id, executionId, workId: recovered.workId, state: finalExecution.state, workCount: finalWorks.length,
      file: { relativePath: path.relative(projectDirectory, local).split(path.sep).join('/'), state: file.state, checksumSha256: file.checksumSha256, metadata },
      usage: (await usage.list(invocation.id)).map(o => ({ status: o.status, facts: o.facts })), requests,
      generationPosts: 0, settlementPosts: 0, originalTaskAndRouteAndRegistryUnchanged: protectedUnchanged,
      boundary: 'Production recovery runtime, adapter and verified local receiver; recover the accepted original only, no generation or settlement' };
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, existing.length ? 'recovery-repeat-validation.json' : 'recovery-validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
  const deadline = setTimeout(() => { console.error('Original recovery deadline; no automatic retry'); app.exit(1); }, 180_000);
  main().then(() => { clearTimeout(deadline); networkRuntime?.dispose(); app.exit(0); }).catch(error => {
    clearTimeout(deadline); networkRuntime?.dispose();
    const failure = { capturedAt: new Date().toISOString(), code: error.code ?? 'recovery_failed', name: error.name, requests, generationPosts: 0, settlementPosts: 0,
      protectedFiles: protectedSnapshot.map(item => ({ name: item.name, beforeSha256: item.sha256,
        afterSha256: sha(fs.readFileSync(item.file)) })) };
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'recovery-failure.json'), JSON.stringify(failure, null, 2) + '\n');
    console.error(JSON.stringify(failure)); app.exit(1);
  });
}
