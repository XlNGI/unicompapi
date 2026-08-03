import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shared = await readFile('src/shared/image-feature-ipc.ts', 'utf8');
const preload = await readFile('electron/preload.ts', 'utf8');
const handlers = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const panel = await readFile(
  'src/pages/creation/image/ImageFeatureSubmissionPanel.tsx',
  'utf8'
);

test('image feature IPC exposes candidate, preparation and confirmed submission only', () => {
  for (const operation of ['listCandidates', 'prepareSubmission', 'submitDraft']) {
    assert.match(shared, new RegExp(`${operation}\\(`));
    assert.match(preload, new RegExp(`${operation}:`));
    assert.match(handlers, new RegExp(`imageFeatureIpcChannels\\.${operation}`));
  }
  assert.match(preload, /imageFeatures,/);
  assert.match(panel, /window\.unicomp\?\.imageFeatures/);
});

test('renderer image feature DTO omits routing, credentials, prompt and local file facts', () => {
  assert.match(shared, /providerName/);
  assert.match(shared, /connectionName/);
  assert.match(shared, /modelName/);
  assert.match(shared, /parameterSchema/);
  assert.match(shared, /routeSelectionToken/);
  assert.doesNotMatch(
    shared,
    /RouteSnapshot|Package|Adapter|Endpoint|Credential|absolutePath|rootDirectory|checksum|finalPrompt|outboundTextSnapshot/
  );
});

test('submission requires exact revision, one-time token and explicit confirmation', () => {
  assert.match(shared, /draftUpdatedAt/);
  assert.match(shared, /routeSelectionToken/);
  assert.match(shared, /confirmationId/);
  assert.match(shared, /confirmed: boolean/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\./);
});
