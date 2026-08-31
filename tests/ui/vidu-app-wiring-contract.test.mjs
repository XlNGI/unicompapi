import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compositionSource = await readFile(
  'electron/ipc/vidu-composition.ts',
  'utf8'
);
const mainSource = await readFile('electron/main.ts', 'utf8');
const providerHandlerSource = await readFile(
  'electron/ipc/provider-ipc.ts',
  'utf8'
);
const storageHandlerSource = await readFile(
  'electron/ipc/storage-ipc.ts',
  'utf8'
);
const preloadSource = await readFile('electron/preload.ts', 'utf8');
const imageContractSource = await readFile(
  'src/shared/image-submission-ipc.ts',
  'utf8'
);
const videoFeatureContractSource = await readFile(
  'src/shared/video-feature-ipc.ts',
  'utf8'
);
const videoResultContractSource = await readFile(
  'src/shared/video-result-ipc.ts',
  'utf8'
);
const workspaceContractSource = await readFile(
  'src/shared/video-workspace-ipc.ts',
  'utf8'
);

test('Electron owns one shared Vidu registry, vault and provider package', () => {
  assert.equal((mainSource.match(/new ElectronViduComposition\(/g) ?? []).length, 1);
  for (const constructor of [
    'JsonProviderRegistryStore',
    'SecureCredentialVault',
    'ViduProviderPackage'
  ]) {
    assert.equal(
      (compositionSource.match(new RegExp(`new ${constructor}\\(`, 'g')) ?? [])
        .length,
      1
    );
  }
  assert.match(mainSource, /registerProviderIpcHandlers\(\{[\s\S]*viduComposition\.registry/);
  assert.match(mainSource, /registerStorageIpcHandlers\(\{[\s\S]*vidu: viduComposition/);
  assert.match(providerHandlerSource, /readonly registry: JsonProviderRegistryStore/);
  assert.match(storageHandlerSource, /options\.vidu\?\.registry/);
  assert.doesNotMatch(compositionSource, /protocolBindings\[0\]/);
});

test('Vidu runtime access is ledger-gated and no longer hard-blocked or frozen', () => {
  assert.doesNotMatch(compositionSource, /denyViduRuntimeAuthorization/);
  assert.doesNotMatch(compositionSource, /liveValidation/);
  assert.doesNotMatch(mainSource, /ensureFrozenViduCatalog/);
  assert.match(
    compositionSource,
    /operationContext: videoOperationContext/
  );
  assert.match(mainSource, /new RuntimeAuthorizationLedger\(\s*new JsonRuntimeAuthorizationLedgerStore\(/);
  assert.match(mainSource, /new LedgerRuntimeAuthorizationSync\(\s*runtimeAuthorizationLedger\s*\)/);
  assert.match(mainSource, /\{ runtimeAuthorization: runtimeAuthorizationSync \}/);
  assert.match(mainSource, /reconcileConnections\(registrySnapshot\.connections\)/);
  assert.equal(
    (mainSource.match(/runtimeAuthorization: runtimeAuthorizationLedger/g) ?? []).length,
    2
  );
  assert.match(
    storageHandlerSource,
    /readonly runtimeAuthorization\?: ProviderCandidateRuntimeAuthorizationPort/
  );
});

test('preload exposes videoFeatures as the only video generation submission surface', () => {
  assert.match(preloadSource, /const videoFeatures: VideoFeatureApi/);
  assert.match(preloadSource, /\bcreateFromImageWork:/);
  assert.match(preloadSource, /videoFeatures,/);
  assert.doesNotMatch(preloadSource, /videoSubmissions/);
  assert.doesNotMatch(preloadSource, /video-submission:/);
  assert.doesNotMatch(storageHandlerSource, /videoSubmissionIpcChannels/);
  assert.doesNotMatch(storageHandlerSource, /VideoSubmissionController/);
  assert.doesNotMatch(compositionSource, /VideoOperationRouter/);
  assert.doesNotMatch(
    preloadSource,
    /contextBridge\.exposeInMainWorld\([^,]+,\s*ipcRenderer/
  );
});

test('renderer contracts contain controlled IDs and no provider or filesystem facts', () => {
  const contracts = `${imageContractSource}\n${videoFeatureContractSource}\n${videoResultContractSource}\n${workspaceContractSource}`;
  for (const protectedField of [
    'absolutePath',
    'relativePath',
    'checksumSha256',
    'credentialReference',
    'endpoint',
    'remoteOperationId',
    'providerOperationId',
    'task_id',
    'downloadUrl',
    'errorStack'
  ]) {
    assert.doesNotMatch(contracts, new RegExp(protectedField));
  }
  assert.match(workspaceContractSource, /createFromImageWork\(\s*workId: string/);
  assert.match(videoFeatureContractSource, /submitDraft\(/);
  assert.match(videoResultContractSource, /VideoWorkRegisteredDto/);
});
