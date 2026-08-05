import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/providers/ProvidersPage.tsx', 'utf8');

test('provider page is driven by registry and package templates', () => {
  assert.match(source, /providersApi\.getRegistry\(\)/);
  assert.match(source, /providersApi\.listTemplates\(\)/);
  assert.match(source, /item\.kind === kind/);
  assert.match(source, /createTemplate\.packageId/);
  assert.match(source, /createTemplate\.templateId/);
  assert.match(source, /createTemplate\?\.baseUrlMode !== 'fixed'/);
  assert.doesNotMatch(
    source,
    /OpenAI|Anthropic|Google AI|Midjourney|Stable Diffusion|DeepSeek|Vidu|Kling|Volcengine/
  );
});

test('provider page exposes the controlled framework mutations', () => {
  for (const action of [
    'addConnection',
    'rotateCredential',
    'validateConnection',
    'syncModelCatalog',
    'registerExactModel',
    'setConnectionEnabled',
    'setModelEnabled',
    'deleteConnection'
  ]) {
    assert.match(source, new RegExp(`providersApi\\.${action}`));
  }
  assert.doesNotMatch(
    source,
    /providersApi\.createConnection|createProvider|updateConnection|registerManualModel|validateCapability|saveRoutingPreference/
  );
});

test('connection creation runs the orchestrated validate-save-discover pipeline', () => {
  assert.match(source, /providersApi\.onAddConnectionProgress/);
  assert.match(source, /allowUnavailableSave/);
  assert.match(source, /connection_validation_failed/);
  assert.match(source, /window\.confirm/);
});

test('credential fields are structured, write-only and cleared after writes', () => {
  assert.match(source, /createTemplate\?\.credentialFields\.map/);
  assert.match(source, /selectedTemplate\.credentialFields\.map/);
  assert.match(source, /type=\{field\.secret \? 'password' : 'text'\}/);
  assert.match(source, /credentials: newCredentials/);
  assert.match(source, /setNewCredentials\(\{\}\)/);
  assert.match(source, /setReplacementCredentials\(\{\}\)/);
  assert.doesNotMatch(
    source,
    /credentialReference|getCredential|readCredential|decryptCredential|copyCredential/
  );
});

test('online validation and discovery stay disabled pending explicit approval', () => {
  assert.match(source, /selectedTemplate\?\.validationAction !== 'available'/);
  assert.match(source, /selectedTemplate\?\.modelDiscoveryAction !== 'catalog_available'/);
  assert.match(source, /validationAction === 'requires_live_api_approval'/);
  assert.match(source, /modelDiscoveryAction === 'requires_live_api_approval'/);
  assert.doesNotMatch(
    source,
    /getViduLiveValidation|startViduLiveValidation|confirmImageBillableAttempt|confirmVideoBillableAttempt/
  );
});

test('model controls use exact registration and verified profile projections', () => {
  assert.match(source, /selectedConnection\.state === 'available'/);
  assert.match(source, /providersApi\.registerExactModel/);
  assert.match(source, /selectedModel\.profileStatus/);
  assert.match(source, /selectedModel\.productFeatures/);
  assert.doesNotMatch(source, /capability\.capability|protocolId ===|providerId === ['"]/);
});
