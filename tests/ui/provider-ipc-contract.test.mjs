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
