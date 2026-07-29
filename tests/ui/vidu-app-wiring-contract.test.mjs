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
const videoContractSource = await readFile(
  'src/shared/video-submission-ipc.ts',
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
  assert.match(compositionSource, /createFrozenViduRegistryRecords\(\)\.protocolBindings\[0\]/);
});

test('preload exposes named lifecycle methods without generic Electron access', () => {
  for (const operation of [
    'createFromImageWork',
    'refreshExecution',
    'cancelExecution',
    'recoverExecutions'
  ]) {
    assert.match(preloadSource, new RegExp(`\\b${operation}:`));
  }
  assert.match(
    preloadSource,
    /const videoWorkspaces:[\s\S]*createFromImageWork:[\s\S]*const videoSubmissions:/
  );
  assert.doesNotMatch(preloadSource, /contextBridge\.exposeInMainWorld\([^,]+,\s*ipcRenderer/);
});

test('renderer contracts contain controlled IDs and no provider or filesystem facts', () => {
  const contracts = `${imageContractSource}\n${videoContractSource}\n${workspaceContractSource}`;
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
});
