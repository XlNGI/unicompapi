import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preload = await readFile('electron/preload.ts', 'utf8');
const contract = await readFile('src/shared/settings-ipc.ts', 'utf8');
const controller = await readFile('src/platform/ipc/settings-controller.ts', 'utf8');

test('exposes only the controlled phase 8 B1/B2 settings operations', () => {
  for (const operation of [
    'getSnapshot',
    'updateValues',
    'exportPortable',
    'prepareImport',
    'getSystemStatus',
    'selectDirectory',
    'planOperation',
    'executeOperation'
  ]) {
    assert.match(preload, new RegExp(`${operation}:`));
    assert.match(contract, new RegExp(`${operation}`));
  }
  assert.doesNotMatch(contract, /readFile|writeFile|deleteFile|absolutePath|rootDirectory/);
  assert.doesNotMatch(preload, /absolutePath|rootDirectory/);
});

test('keeps dangerous settings behind impact planning and confirmation', () => {
  assert.match(contract, /confirmation_required/);
  assert.match(contract, /confirmationHandle/);
  assert.match(contract, /changedValueCount/);
  assert.match(contract, /affectedCategories/);
  assert.match(controller, /hasHighRiskSettingsChanges/);
  assert.match(controller, /operation_expired/);
  assert.match(controller, /revision_conflict/);
  assert.doesNotMatch(contract, /migrateDirectory\(|clearLocalData\(|setProxy\(/);
});

test('keeps unsupported platform capabilities honest while B2 adapters are explicit', () => {
  for (const capability of [
    'directory_operations',
    'task_policy',
    'media_components',
    'permission_controls',
    'proxy_controls',
    'notification_controls',
    'shortcut_controls',
    'diagnostics',
    'updates'
  ]) {
    assert.match(controller, new RegExp(capability));
  }
  assert.match(controller, /state: 'unavailable'/);
  assert.match(controller, /phase8_platform_adapter_pending/);
  assert.doesNotMatch(controller, /id: 'updates',\s*state: 'available'/);
});

test('portable settings exclude device-bound and credential-bearing fields', () => {
  assert.doesNotMatch(
    contract,
    /credentialReference|proxyPassword|apiKey|secret|absolutePath/i
  );
  assert.match(contract, /PortableSettingsV1/);
});
