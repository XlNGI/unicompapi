const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const workspace = path.resolve(__dirname, '..');
const outputDirectory = path.join(workspace, 'outputs', 'r04-r05-built-recovery');
const prefix = 'unicomp-r45-built-recovery-';

function verifyTemporaryRoot(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.equal(path.basename(resolved).startsWith(prefix), true);
  return resolved;
}

async function orchestrate() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(outputDirectory, { recursive: true });
  let status = 'failed', phases = [], failure;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    for (const phase of [1, 2, 3]) {
      if (phase === 2) await new Promise(resolve => setTimeout(resolve, 1_250));
      const result = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, '--child', String(phase), temporaryRoot], {
          cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Built recovery phase ${phase} exceeded 90 seconds`)); }, 90_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      if (result.code !== 0) {
        const log = await fs.readFile(path.join(temporaryRoot, `phase-${phase}.json`), 'utf8').catch(() => '{}');
        const safe = JSON.parse(log);
        throw new Error(`Phase ${phase} failed: ${safe.failure ?? 'No child report'}`);
      }
      const phaseReport = JSON.parse(await fs.readFile(path.join(temporaryRoot, `phase-${phase}.json`), 'utf8'));
      phases.push(phaseReport);
      process.stdout.write(`Built recovery phase ${phase}: passed (${phaseReport.checks.length} checks, ${phaseReport.fakeProviderRequests} synthetic requests).\n`);
    }
    assert.equal(new Set(phases.map(item => item.pid)).size, 3);
    status = 'passed';
  } catch (error) { failure = error.message; }
  finally {
    const compiledFiles = ['electron/preload.js', 'electron/ipc/chat-context-ipc.js', 'src/platform/ipc/chat-context-runtime.js',
      'src/platform/ipc/conversation-agent-continuations.js', 'src/platform/ipc/conversation-agent-recovery-runtime.js',
      'src/application/conversation-agent-session-service.js', 'src/platform/repositories/json-conversation-agent-session-repository.js'];
    const hashes = await Promise.all(compiledFiles.map(async file => ({ file: `dist-electron/${file}`,
      sha256: createHash('sha256').update(await fs.readFile(path.join(workspace, 'dist-electron', file))).digest('hex') })));
    const report = { schemaVersion: 1, status, recordedAt: new Date().toISOString(), checks: phases.flatMap(item => item.checks), phases,
      distinctElectronProcesses: new Set(phases.map(item => item.pid)).size, compiledFiles: hashes,
      fakeProviderRequests: phases.reduce((sum, item) => sum + item.fakeProviderRequests, 0),
      networkRequests: phases.reduce((sum, item) => sum + item.networkRequests, 0), ...(failure ? { failure } : {}),
      scope: 'Actual compiled Host modules, production registerChatContextIpcHandlers and production preload in three isolated Electron processes. Synthetic transport and project only.',
      limits: ['Minimal fixture renderer; does not exercise production AppLayout or operating user application.',
        'Crash model_started and expired roots are seeded primary records, not a live paid request or forced process crash.',
        'Synthetic model returns text only; original PPT delivery goal must fail the file delivery gate. No real Office generation is claimed.'] };
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const resolved = verifyTemporaryRoot(temporaryRoot);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  if (status !== 'passed') throw new Error(failure);
}

async function runChild(phase, temporaryRoot) {
  verifyTemporaryRoot(temporaryRoot);
  const { app, BrowserWindow, net } = require('electron');
  const userData = path.join(temporaryRoot, 'profile'), projectRoot = path.join(temporaryRoot, 'project');
  require('node:fs').mkdirSync(userData, { recursive: true });
  require('node:fs').mkdirSync(projectRoot, { recursive: true });
  app.setPath('userData', userData); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
  let networkRequests = 0, fakeProviderRequests = 0, lifecycle, window, deepSeek, newApi;
  const checks = [], mainErrorsExpectedTyped = [], privateErrors = [], rootBudgetComparisons = [];
  const denyNetwork = () => { networkRequests += 1; throw new Error('Synthetic verification denies HTTP(S)'); };
  require('node:http').request = denyNetwork; require('node:http').get = denyNetwork;
  require('node:https').request = denyNetwork; require('node:https').get = denyNetwork;
  globalThis.fetch = denyNetwork; net.request = denyNetwork; net.fetch = denyNetwork;
  let status = 'failed', failure;
  let checkpoint = 'setup';
  const deadline = setTimeout(() => {
    fs.writeFile(path.join(temporaryRoot, `phase-${phase}.json`), JSON.stringify({ phase, status: 'failed', pid: process.pid,
      checks, fakeProviderRequests, networkRequests, mainErrorsExpectedTyped, failure: `Deadline reached at ${checkpoint}` }))
      .finally(() => app.exit(1));
  }, 80_000);
  try {
    await app.whenReady();
    const f = require('./lib/r45-built-fixture.cjs');
    const fixture = await f.providerFixture(userData, phase === 1), repos = f.repositories(projectRoot);
    newApi = new f.p.NewApiSharedRuntime({ transport: { send: async () => { fakeProviderRequests += 1; return f.textResponse(fixture.modelKey); } } });
    deepSeek = new f.p.DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected synthetic provider'); } } });
    const { registerChatContextIpcHandlers } = require('../dist-electron/electron/ipc/chat-context-ipc');
    lifecycle = registerChatContextIpcHandlers({
      getSession: () => ({ projectId: f.projectId, projectName: 'Offline built recovery fixture', rootDirectory: projectRoot }),
      providerRegistry: fixture.registry, providerPackages: new f.p.ProviderPackageRegistry([
        f.p.deepSeekProviderPackageDescriptor, f.p.volcengineProviderPackageDescriptor, f.p.klingProviderPackageDescriptor,
        f.p.minimaxH3ProviderPackageDescriptor, f.p.unicompapiStudioH3ProviderPackageDescriptor, f.p.kimiProviderPackageDescriptor,
        f.p.newApiProviderPackageDescriptor, f.p.unicompapiProviderPackageDescriptor, f.p.viduProviderPackageDescriptor
      ]), runtimeAuthorization: fixture.authorization,
      textSubmission: { credentialVault: fixture.vault, newApiRuntime: newApi, deepSeekRuntime: deepSeek },
      onError: error => { privateErrors.push(error?.stack ?? String(error)); const code = error?.code ?? error?.name ?? 'unknown';
        mainErrorsExpectedTyped.push({ code, expected: ['unknown_result', 'continuation_invalid', 'deadline_exceeded'].includes(code) }); }
    });
    const html = path.join(temporaryRoot, 'renderer.html');
    await fs.writeFile(html, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Offline recovery verification</title>');
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(workspace, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false, partition: `r45-built-${process.pid}` } });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(?:file|data):/u.test(details.url); if (!allowed) networkRequests += 1; callback({ cancel: !allowed });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); await window.loadFile(html);
    const invoke = async (method, ...args) => {
      await fs.writeFile(path.join(temporaryRoot, `progress-${phase}.json`), JSON.stringify({ checkpoint, method, checks: checks.length }));
      return window.webContents.executeJavaScript(`window.unicomp.chatContexts[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
    };
    const success = result => { assert.equal(result.ok, true, result.error ? `${result.error.code}: ${result.error.message}` : 'Expected success'); return result.value; };
    checkpoint = 'candidate-list';
    const candidates = success(await invoke('listTextCandidates', 'text_chat')), candidate = candidates.find(item => item.available);
    assert.ok(candidate, 'Synthetic candidate available');
    const read = async id => success(await invoke('getConversation', id));
    const request = async (conversationId, content, commandId, session) => {
      const conversation = await read(conversationId);
      return { clientCommandId: commandId, conversation: { conversationId, expectedRevision: conversation.revision, editedMessageId: null },
        title: conversation.title, content, productFeature: 'text_chat', candidateId: candidate.candidateId, contextSelections: [], parameterValues: {},
        ...(session ? { continuation: { sessionId: session.sessionId, expectedRevision: session.revision,
          resumeToken: session.resumeToken, action: session.waiting?.allowedActions[0] ?? 'reply' } } : {}) };
    };
    const waitSettled = async id => {
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        const execution = success(await invoke('getResponseExecution', id));
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.state)) { await lifecycle.waitForMutations(); return execution; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Synthetic execution did not settle within 10 seconds');
    };
    const statePath = path.join(temporaryRoot, 'fixture-state.json');
    let state = phase === 1 ? {} : JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (phase === 1) {
      const conversation = success(await invoke('createConversation', 'Offline wait', true));
      const started = success(await invoke('startAgentResponse', await request(conversation.conversationId, '制作一个 PPT。', 'built-initial-wait')));
      assert.equal(started.waiting, true); assert.equal(started.agentSession.state, 'waiting_user');
      const session = await repos.sessions.get(started.agentSession.sessionId);
      assert.equal(session.childSegments.length, 1); assert.equal(session.planningBoundary, 'not_started');
      assert.equal(JSON.stringify(session).includes(started.agentSession.resumeToken), false);
      state = { conversationId: conversation.conversationId, originalDto: started.agentSession, originalSession: session };
      rootBudgetComparisons.push({ scope: 'initial_wait', before: session.budget, after: session.budget, unchanged: true });
      for (const kind of ['paid_unknown', 'planning_unknown', 'expired']) state[kind] = await f.seedRoot(projectRoot, kind);
      assert.equal(fakeProviderRequests, 0); checks.push('initial_wait_is_durable_without_provider_call', 'raw_resume_nonce_absent_from_session', 'synthetic_primary_crash_and_expiry_seeds');
    } else {
      checkpoint = 'waiting-read';
      const current = await read(state.conversationId), dto = current.agentSessions.find(item => item.sessionId === state.originalSession.id);
      const session = await repos.sessions.get(dto.sessionId);
      assert.equal(dto.state, 'waiting_user'); assert.ok(dto.resumeToken);
      assert.deepEqual(session.budget, state.originalSession.budget); assert.deepEqual(session.childSegments, state.originalSession.childSegments);
      rootBudgetComparisons.push({ scope: 'reopened_wait', before: state.originalSession.budget, after: session.budget, unchanged: true });
      const previous = phase === 2 ? state.originalDto : state.secondDto;
      assert.notEqual(dto.resumeToken, previous.resumeToken); assert.equal(session.waitingVersion, state.originalSession.waitingVersion + phase - 1);
      assert.deepEqual((await read(state.conversationId)).agentSessions.find(item => item.sessionId === dto.sessionId), dto);
      assert.equal(fakeProviderRequests, 0);
      checks.push(`process_${phase}_waiting_challenge_rotates_once`, `process_${phase}_root_budget_and_children_preserved`, `process_${phase}_reads_do_not_submit`);
      checkpoint = 'paid-unknown-read';
      const paid = await read(state.paid_unknown.conversationId), paidDto = paid.agentSessions.find(item => item.sessionId === state.paid_unknown.session.id);
      assert.equal(paidDto.state, 'needs_reconciliation');
      assert.deepEqual((await repos.sessions.get(paidDto.sessionId)).budget, state.paid_unknown.session.budget);
      rootBudgetComparisons.push({ scope: 'unknown_submission', before: state.paid_unknown.session.budget,
        after: (await repos.sessions.get(paidDto.sessionId)).budget, unchanged: true });
      const beforePaid = await repos.conversations.get(state.paid_unknown.conversationId);
      const blocked = await invoke('startAgentResponse', await request(state.paid_unknown.conversationId, '只回复一句新的培训建议。', `built-block-unknown-${phase}`));
      assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'response_reconciliation_required');
      assert.deepEqual(await repos.conversations.get(state.paid_unknown.conversationId), beforePaid);
      assert.equal(fakeProviderRequests, 0); checks.push(`process_${phase}_submitted_model_unknown_freezes_and_blocks_resend`);
      const expired = await read(state.expired.conversationId), expiredDto = expired.agentSessions.find(item => item.sessionId === state.expired.session.id);
      assert.equal(expiredDto.state, 'expired'); assert.deepEqual((await repos.sessions.get(expiredDto.sessionId)).budget, state.expired.session.budget);
      checks.push(`process_${phase}_known_expiry_preserves_original_budget`);
      if (phase === 2) state.secondDto = dto;
      else {
        for (const staleDto of [state.originalDto, state.secondDto]) {
          const before = await repos.conversations.get(state.conversationId);
          const refused = await invoke('startAgentResponse', await request(state.conversationId, '主题是培训。', `built-stale-${staleDto.revision}`, staleDto));
          assert.equal(refused.ok, false); assert.deepEqual(await repos.conversations.get(state.conversationId), before); assert.equal(fakeProviderRequests, 0);
        }
        checks.push('both_previous_process_resume_tokens_rejected_without_submission');
        const validRequest = await request(state.conversationId, '主题是企业新人培训，面向新员工，内容包括流程和常见问题。', 'built-valid-topic', dto);
        const resumed = success(await invoke('startAgentResponse', validRequest));
        assert.ok(resumed.execution); assert.equal(resumed.agentSession.sessionId, state.originalSession.id);
        await waitSettled(resumed.execution.responseExecutionId);
        const settled = await repos.sessions.get(state.originalSession.id);
        assert.equal(settled.childSegments.length, 2); assert.deepEqual(settled.budget, state.originalSession.budget);
        rootBudgetComparisons.push({ scope: 'reply_settlement', before: state.originalSession.budget, after: settled.budget, unchanged: true });
        assert.equal(settled.status, 'closed'); assert.equal(settled.closedReason, 'failed'); assert.equal(settled.registeredWorkIds.length, 0);
        const child = await repos.runs.findByResponseExecutionId(resumed.execution.responseExecutionId);
        assert.equal(child.parentRunId, state.originalSession.id); assert.equal(child.id, settled.childSegments[1].runId);
        assert.equal((await repos.runs.get(state.originalSession.id)).responseExecutionId, undefined); assert.equal(fakeProviderRequests, 1);
        const beforeReplay = await repos.conversations.get(state.conversationId);
        const replay = success(await invoke('startAgentResponse', validRequest));
        assert.equal(replay.execution.responseExecutionId, resumed.execution.responseExecutionId);
        assert.deepEqual(await repos.conversations.get(state.conversationId), beforeReplay); assert.deepEqual(await repos.sessions.get(settled.id), settled);
        assert.equal(fakeProviderRequests, 1);
        checks.push('valid_reply_appends_one_immutable_child_to_same_parent', 'text_only_result_cannot_satisfy_original_ppt_file_goal', 'duplicate_command_replays_without_extra_submission');
        const planning = await read(state.planning_unknown.conversationId), planningDto = planning.agentSessions.find(item => item.sessionId === state.planning_unknown.session.id);
        assert.equal(planningDto.state, 'needs_reconciliation');
        const closed = success(await invoke('cancelAgentSession', { projectId: f.projectId, sessionId: planningDto.sessionId,
          expectedRevision: planningDto.revision, closeUnknown: true }));
        assert.equal(closed.state, 'cancelled'); assert.equal(fakeProviderRequests, 1);
        const fresh = success(await invoke('startAgentResponse', await request(state.planning_unknown.conversationId, '只回复一句话，介绍培训流程。', 'built-explicit-after-close')));
        assert.notEqual(fresh.agentSession.sessionId, planningDto.sessionId); await waitSettled(fresh.execution.responseExecutionId); assert.equal(fakeProviderRequests, 2);
        checks.push('unknown_planning_requires_explicit_close_before_one_fresh_submission');
        const freshExpired = success(await invoke('startAgentResponse', await request(state.expired.conversationId, '只回复一句话，介绍培训流程。', 'built-explicit-after-expiry')));
        assert.notEqual(freshExpired.agentSession.sessionId, expiredDto.sessionId); await waitSettled(freshExpired.execution.responseExecutionId); assert.equal(fakeProviderRequests, 3);
        assert.deepEqual((await repos.sessions.get(expiredDto.sessionId)).budget, state.expired.session.budget);
        rootBudgetComparisons.push({ scope: 'expired_old_task_after_explicit_new_task', before: state.expired.session.budget,
          after: (await repos.sessions.get(expiredDto.sessionId)).budget, unchanged: true });
        checks.push('expired_task_allows_explicit_new_parent_without_resetting_old_budget');
      }
    }
    await lifecycle.waitForMutations(); assert.equal(networkRequests, 0); assert.equal(mainErrorsExpectedTyped.every(item => item.expected), true);
    await fs.writeFile(statePath, JSON.stringify(state)); status = 'passed';
  } catch (error) {
    // Only synthetic assertions and typed errors are printed; strip generated directory names.
    failure = `${checkpoint}: ` + String(error?.message ?? error).replaceAll(temporaryRoot, '<isolated-fixture>') +
      (privateErrors.length ? '; typed Host errors: ' + mainErrorsExpectedTyped.map(item => item.code).join(', ') : '');
  } finally {
    const bounded = operation => Promise.race([Promise.resolve(operation).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2_000))]);
    try { await bounded(lifecycle?.interruptActiveResponses()); await bounded(lifecycle?.waitForMutations()); } catch { /* aggregate assertions retain failure */ }
    deepSeek?.dispose(); newApi?.dispose();
    if (window && !window.isDestroyed()) { await window.webContents.session.closeAllConnections(); window.destroy(); }
    await fs.writeFile(path.join(temporaryRoot, `phase-${phase}.json`), JSON.stringify({ phase, status, pid: process.pid, electron: process.versions.electron,
      checks, fakeProviderRequests, networkRequests, rootBudgetComparisons, mainErrorsExpectedTyped, ...(failure ? { failure } : {}) }, null, 2));
    clearTimeout(deadline);
    app.exit(status === 'passed' ? 0 : 1);
    setTimeout(() => process.exit(status === 'passed' ? 0 : 1), 1_000).unref();
  }
}

if (process.versions.electron) runChild(Number(process.argv[process.argv.indexOf('--child') + 1]), process.argv[process.argv.indexOf('--child') + 2])
  .catch(error => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exit(1); });
else orchestrate().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
