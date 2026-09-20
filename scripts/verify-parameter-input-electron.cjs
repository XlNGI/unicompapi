const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const {
  isParameterInputPerformanceSummary,
  parameterInputDiagnosticsIpcChannel
} = require('../dist-electron/src/shared/parameter-input-performance.js');

/**
 * P4 Electron acceptance for the parameter input decoupling (P3).
 *
 * It runs the real Electron renderer against the real production preload and
 * drives the shipped `DynamicParameterForm` with real input/blur/click events.
 * The form is bundled on its own page rather than inside the video workbench, so
 * this proves the parameter input contract, not the full workbench flow; the
 * workbench wiring is asserted by tests/ui/parameter-input-decoupling.test.mjs.
 *
 * Nothing here touches the user's project data, provider registry or network:
 * userData is redirected to a temporary directory and all network requests from
 * the page are refused.
 */

const workspace = path.resolve(__dirname, '..');
const harnessEntry = path.join(workspace, 'tests', 'harness', 'parameter-input-harness.tsx');
const deadlineMs = 180_000;

app.disableHardwareAcceleration();
// The acceptance only needs the DOM and the IPC bridge, so the GPU process is
// unnecessary. Running it in-process keeps the script usable on a machine
// without a usable GPU (headless CI, remote session), where a separate GPU
// process aborts the whole app.
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
app.setPath('userData', path.join(os.tmpdir(), `unicomp-parameter-input-smoke-${process.pid}`));

let temporaryRoot;
let exitCode = 1;
const deadline = setTimeout(() => {
  process.stderr.write('Parameter input Electron acceptance exceeded its deadline.\n');
  app.exit(1);
}, deadlineMs);
// Never keep the process alive for the deadline alone.
deadline.unref?.();

const parameterInputSummaries = [];

async function bundleHarness(outputDirectory) {
  const vite = require('vite');
  await vite.build({
    configFile: false,
    root: workspace,
    mode: 'development',
    // The harness runs in a renderer main world, which has no `process`; the
    // build replaces the env references and the injection adds a minimal shim
    // for anything the dependencies read at runtime.
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      // The form enables its diagnostics probe only in a development build; the
      // acceptance wants the real probe → IPC → main-process validator path.
      'import.meta.env.DEV': 'true'
    },
    // No React plugin here, so the automatic JSX runtime has to be requested
    // explicitly; otherwise the transform emits React.createElement calls.
    esbuild: { jsx: 'automatic' },
    // rsuite ships "use client" directives that Vite warns about on every module;
    // the warnings are expected for this bundle and would bury the evidence.
    logLevel: 'silent',
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      target: 'chrome120',
      lib: {
        entry: harnessEntry,
        formats: ['iife'],
        name: 'ParameterInputHarness',
        fileName: () => 'harness.js'
      }
    }
  });
  const bundle = path.join(outputDirectory, 'harness.js');
  return readFile(bundle, 'utf8');
}

/**
 * Runs the bundle in the page. The wrapper exists so a top-level failure is
 * reported with its stack instead of Electron's opaque "Script failed to
 * execute", and so the script's completion value is serializable.
 */
function injectionSource(bundle) {
  return [
    // A renderer main world has no `process`/`global`, so the bundle gets a
    // minimal shim for anything the dependencies read at runtime. No platform
    // literal is set here: this acceptance path must stay platform-neutral, and
    // the evidence reports the host facts from the main process instead.
    'window.process = window.process || { env: { NODE_ENV: "development" }, versions: {} };',
    'window.global = window.global || window;',
    'try {',
    bundle,
    '\n} catch (error) {',
    '  window.__parameterInputHarnessError = String((error && error.stack) || error);',
    '}',
    'undefined;'
  ].join('\n');
}

async function waitForHarness(window, timeoutMs = 30_000) {
  const startedAt = Date.now();
  for (;;) {
    const state = await window.webContents.executeJavaScript(
      '({ error: window.__parameterInputHarnessError || null,' +
        ' ready: Boolean(window.__parameterInputHarness && window.__parameterInputHarness.ready) })'
    );
    if (state.error) throw new Error(`harness failed to load: ${state.error}`);
    if (state.ready) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('harness never became ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run() {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-parameter-input-'));
  const buildDirectory = path.join(temporaryRoot, 'harness-build');
  await mkdir(buildDirectory);
  await app.whenReady();

  ipcMain.on(parameterInputDiagnosticsIpcChannel, (_event, value) => {
    if (!isParameterInputPerformanceSummary(value)) {
      parameterInputSummaries.push({ rejected: true });
      return;
    }
    parameterInputSummaries.push(value);
  });

  const harness = await bundleHarness(buildDirectory);
  const page = path.join(temporaryRoot, 'harness.html');
  await writeFile(
    page,
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
      '<title>Parameter input acceptance</title><div id="harness-root"></div>',
    'utf8'
  );

  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(workspace, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // A hidden window is throttled by Chromium: polling loops and timers can
      // be deferred by a second or more once the page goes idle. That would let
      // the 600 ms idle commit boundary fire before the harness dispatches the
      // blur it is testing, so throttling is disabled. Without this the
      // scenarios race the boundary instead of measuring it.
      backgroundThrottling: false,
      partition: `parameter-input-smoke-${process.pid}`
    }
  });

  let deniedNetworkRequests = 0;
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(?:file|data):/u.test(details.url);
    if (!allowed) deniedNetworkRequests += 1;
    callback({ cancel: !allowed });
  });

  const rendererErrors = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`render-process-gone: ${details.reason}`);
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) rendererErrors.push(message);
  });

  await window.loadFile(page);
  await window.webContents.executeJavaScript(injectionSource(harness), true);
  await waitForHarness(window);

  const report = await window.webContents.executeJavaScript(
    'window.__parameterInputHarness.run()',
    true
  );

  // The probe only emits a session of at least 30 settled inputs, 2 s after the
  // last one, through the production IPC channel and validator.
  const summariesDeadline = Date.now() + 6_000;
  while (parameterInputSummaries.length === 0 && Date.now() < summariesDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const failed = report.scenarios.filter((scenario) => !scenario.passed);
  const rejectedSummaries = parameterInputSummaries.filter((summary) => summary.rejected);
  const summaries = parameterInputSummaries.filter((summary) => !summary.rejected);

  const evidence = {
    scenario: 'P4 parameter input decoupling (Electron renderer)',
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: os.platform(),
      release: os.release(),
      harnessBundle: 'development mode (diagnostics probe enabled)',
      deniedNetworkRequests
    },
    latency: report.latency,
    burst: report.burst,
    harness: report.harness,
    scenarios: report.scenarios,
    diagnostics: {
      summariesReceived: summaries.length,
      rejectedByRedactionGate: rejectedSummaries.length,
      lastSummary: summaries[summaries.length - 1] ?? null
    },
    rendererErrors
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

  assert.equal(failed.length, 0, `unmet expectations: ${JSON.stringify(failed, null, 2)}`);
  assert.ok(
    summaries.length >= 1,
    'the parameter input probe must deliver at least one summary through the production channel'
  );
  assert.equal(rejectedSummaries.length, 0, 'no recorded summary may be rejected by the gate');
  assert.equal(rendererErrors.length, 0, `renderer reported errors: ${rendererErrors.join('; ')}`);
  for (const summary of summaries) {
    assert.ok(
      summary.visibleLatencyP95Ms < 100,
      `p95 ${summary.visibleLatencyP95Ms} ms must stay under the 100 ms target`
    );
  }
  process.stdout.write('PARAMETER_INPUT_ACCEPTANCE_OK\n');
  exitCode = 0;
}

run()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(deadline);
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    app.exit(exitCode);
  });
