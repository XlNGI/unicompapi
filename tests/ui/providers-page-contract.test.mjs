import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/providers/ProvidersPage.tsx', 'utf8');

test('provider page is driven by registry and package templates', () => {
  assert.match(source, /providersApi\.getRegistry\(\)/);
  assert.match(source, /providersApi\.listTemplates\(\)/);
  assert.match(source, /item\.kind === kind/);
  assert.match(source, /template\.packageId/);
  assert.match(source, /template\.templateId/);
  assert.match(source, /createTemplate\?\.baseUrlMode !== 'fixed'/);
  assert.doesNotMatch(
    source,
    /OpenAI|Anthropic|Google AI|Midjourney|Stable Diffusion|DeepSeek|Vidu|Kling|Volcengine/
  );
});

test('provider page exposes the controlled framework mutations', () => {
  for (const action of [
    'createConnection',
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
    /createProvider|updateConnection|registerManualModel|validateCapability|saveRoutingPreference/
  );
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
  assert.match(source, /等待验证授权/);
  assert.match(source, /验证并连接/);
  assert.match(source, /保存并验证/);
  assert.match(source, /仅保存连接/);
  assert.match(source, /template\.validationAction !== 'available'/);
  assert.match(source, /template\.modelDiscoveryAction === 'catalog_available'/);
  assert.doesNotMatch(
    source,
    /getViduLiveValidation|startViduLiveValidation|confirmImageBillableAttempt|confirmVideoBillableAttempt/
  );
});

test('model controls use exact registration and verified profile projections', () => {
  assert.match(source, /modelDiscoveryAction === 'manual_exact'/);
  assert.match(source, /providersApi\.registerExactModel/);
  assert.match(source, /selectedModel\.profileStatus/);
  assert.match(source, /selectedModel\.productFeatures/);
  assert.doesNotMatch(source, /capability\.capability|protocolId ===|providerId === ['"]/);
});
