import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preload = await readFile('electron/preload.ts', 'utf8');
const contract = await readFile('src/shared/provider-ipc.ts', 'utf8');

test('provider registry IPC is read-only and credential-free', () => {
  assert.match(preload, /providers/);
  assert.match(preload, /getRegistry/);
  assert.match(contract, /endpointConfigured/);
  assert.doesNotMatch(contract, /credentialReference|apiKey|token|secret|endpoint:/i);
  assert.doesNotMatch(preload, /credentialReference|apiKey|token|secret/i);
});

test('credential IPC is write-only and distinguishes local deletion', () => {
  assert.match(contract, /saveCredential/);
  assert.match(contract, /deleteLocalCredential/);
  assert.match(contract, /checkCredentialStorage/);
  assert.match(contract, /remoteRevocation\?: 'not_attempted'/);
  assert.match(contract, /remoteValidation\?: 'not_attempted'/);
  assert.doesNotMatch(contract, /getCredential\(|readCredential\(|decryptCredential/);
  assert.doesNotMatch(preload, /getCredential\(|readCredential\(|decryptCredential/);
});

test('provider service IPC keeps validation separate and routing confirmable', () => {
  assert.match(contract, /validateConnection/);
  assert.match(contract, /validateCapability/);
  assert.match(contract, /syncModelCatalog/);
  assert.match(contract, /registerManualModel/);
  assert.match(contract, /requiresSubmissionConfirmation: true/);
  assert.match(contract, /costState: 'unknown'/);
  assert.match(contract, /privacyState: 'unknown'/);
  assert.match(contract, /regionState: 'unknown'/);
});
