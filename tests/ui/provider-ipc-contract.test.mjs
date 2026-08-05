import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preload = await readFile('electron/preload.ts', 'utf8');
const contract = await readFile('src/shared/provider-ipc.ts', 'utf8');
const handlers = await readFile('electron/ipc/provider-ipc.ts', 'utf8');
const main = await readFile('electron/main.ts', 'utf8');
const managementAdapters = await readFile('electron/ipc/management-adapters.ts', 'utf8');

const registryProjection = contract.slice(
  contract.indexOf('export interface ProviderSummaryDto'),
  contract.indexOf('export interface ProviderApi')
);

const managementActions = [
  'listTemplates',
  'createConnection',
  'addConnection',
  'rotateCredential',
  'validateConnection',
  'syncModelCatalog',
  'registerExactModel',
  'setConnectionEnabled',
  'setModelEnabled',
  'deleteConnection'
];

test('provider registry IPC exposes a safe package, template and profile projection', () => {
  assert.match(contract, /endpointConfigured/);
  assert.match(contract, /readonly packageId\?: string/);
  assert.match(contract, /readonly templateId\?: string/);
  assert.match(contract, /readonly profileStatus\?:/);
  assert.match(contract, /readonly productFeatures\?: readonly string\[\]/);
  assert.doesNotMatch(
    registryProjection,
    /credentialReference|credentialVersionId|readonly credentials\s*:|readonly endpoint\s*:/i
  );
});

test('provider management API exposes only structured framework operations', () => {
  for (const action of managementActions) {
    assert.match(contract, new RegExp(`\\b${action}\\b`));
    assert.match(preload, new RegExp(`providerIpcChannels\\.${action}`));
    assert.match(handlers, new RegExp(`providerIpcChannels\\.${action}`));
  }
  assert.match(contract, /credentialFields: readonly/);
  assert.match(contract, /credentials: Readonly<Record<string, string>>/);
  assert.match(contract, /validationAction: 'available' \| 'requires_live_api_approval' \| 'unsupported'/);
  assert.match(contract, /'catalog_available'/);
  assert.match(contract, /'manual_exact'/);
});

test('credentials remain write-only across the renderer contract and preload', () => {
  assert.doesNotMatch(
    contract,
    /getCredential\(|readCredential\(|decryptCredential\(|copyCredential\(/
  );
  assert.doesNotMatch(
    preload,
    /getCredential\(|readCredential\(|decryptCredential\(|copyCredential\(/
  );
  assert.doesNotMatch(registryProjection, /apiKey|secretKey|accessKey|tokenValue/i);
});

test('Vidu billable validation is absent from the renderer and IPC public surface', () => {
  for (const removedAction of [
    'getViduLiveValidation',
    'startViduLiveValidation',
    'confirmImageBillableAttempt',
    'confirmVideoBillableAttempt'
  ]) {
    assert.doesNotMatch(contract, new RegExp(removedAction));
    assert.doesNotMatch(preload, new RegExp(removedAction));
    assert.doesNotMatch(handlers, new RegExp(removedAction));
  }
});

test('desktop composition installs live provider management adapters in the main process', () => {
  assert.match(main, /createLiveProviderManagementAdapters/);
  assert.doesNotMatch(
    main,
    /new ProviderManagementAdapterRegistry\(providerPackages, \[\]\)/
  );
  assert.match(handlers, /management\.listTemplates\(\)/);
  assert.match(handlers, /management\.createConnection\(input\)/);
  assert.match(handlers, /management\.addConnection\(input/);
  assert.doesNotMatch(handlers, /fetch\(|net\.fetch|https?\./);
});

test('management adapter composition registers the evidence-backed probes', () => {
  for (const adapter of [
    'DeepSeekManagementAdapter',
    'NewApiManagementAdapter',
    'KlingManagementAdapter'
  ]) {
    assert.match(managementAdapters, new RegExp(`new ${adapter}\\(`));
  }
  for (const transport of [
    'ElectronDeepSeekHttpTransport',
    'ElectronNewApiHttpTransport',
    'ElectronKlingHttpTransport'
  ]) {
    assert.match(managementAdapters, new RegExp(`class ${transport}`));
  }
  assert.doesNotMatch(managementAdapters, /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
});
