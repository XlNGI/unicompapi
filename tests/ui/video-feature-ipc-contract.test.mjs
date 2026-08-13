import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shared = await readFile('src/shared/video-feature-ipc.ts', 'utf8');
const preload = await readFile('electron/preload.ts', 'utf8');
const handlers = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const panel = await readFile(
  'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
  'utf8'
);

test('video feature IPC is the only generation submission surface', () => {
  for (const operation of ['listCandidates', 'prepareSubmission', 'submitDraft', 'recoverResult']) {
    assert.match(shared, new RegExp(`${operation}\\(`));
    assert.match(preload, new RegExp(`${operation}:`));
    assert.match(handlers, new RegExp(`videoFeatureIpcChannels\\.${operation}`));
  }
  assert.match(preload, /videoFeatures,/);
  assert.match(panel, /window\.unicomp\?\.videoFeatures/);
  assert.doesNotMatch(preload, /videoSubmissions/);
  assert.doesNotMatch(handlers, /videoSubmissionIpcChannels|VideoSubmissionController/);
});

test('renderer video feature DTO omits protected routing and provider facts', () => {
  assert.match(shared, /providerName/);
  assert.match(shared, /parameterSchema/);
  assert.match(shared, /routeSelectionToken/);
  assert.doesNotMatch(
    shared,
    /RouteSnapshot|Package|Adapter|Endpoint|Credential|absolutePath|rootDirectory|checksum|finalPrompt|outboundTextSnapshot/
  );
});

test('video submission binds exact revision, token and confirmation', () => {
  assert.match(shared, /draftUpdatedAt/);
  assert.match(shared, /routeSelectionToken/);
  assert.match(shared, /confirmationId/);
  assert.match(shared, /confirmed: boolean/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\./);
});

test('video submission prepares and submits without a second outbound confirmation action', () => {
  assert.doesNotMatch(panel, /<fieldset className="uc-image-quick__confirmations"/);
  assert.doesNotMatch(panel, /<Checkbox|setConfirmed|确认并提交/);
  assert.match(
    panel,
    /api\.prepareSubmission\([\s\S]*await submitPrepared\(saved, result\.value\)/
  );
});

test('video submission returns local work identity for in-page preview', () => {
  assert.match(shared, /readonly workId\?: string/);
  assert.match(shared, /readonly resultVideoUrls\?: readonly string\[\]/);
  assert.match(shared, /readonly localResultError\?: string/);
});

test('video feature panel uses shared model select and dynamic parameter form', async () => {
  const form = await readFile('src/components/DynamicParameterForm.tsx', 'utf8');
  assert.match(panel, /ModelSelect/);
  assert.match(panel, /DynamicParameterForm/);
  assert.match(panel, /已锁定参数合同/);
  assert.match(form, /field\.valueType === 'object'/);
  assert.match(form, /ObjectParameterField/);
  assert.match(form, /JSON\.parse\(text\)/);
  assert.match(form, /请输入有效的 JSON 对象/);
});

test('video candidate loading is stable across parent callback renders', () => {
  assert.match(panel, /onDraftPersistedRef\.current/);
  assert.match(panel, /onMessageRef\.current/);
  assert.doesNotMatch(
    panel,
    /featureSelection\.productFeature,[\s\S]*onDraftPersisted,[\s\S]*onMessage,[\s\S]*videoWorkspaces/
  );
});
