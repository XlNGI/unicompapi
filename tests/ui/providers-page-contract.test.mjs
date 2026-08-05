import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shell = await readFile('src/pages/providers/ProvidersPage.tsx', 'utf8');
const gallery = await readFile('src/pages/providers/ProviderGalleryView.tsx', 'utf8');
const manage = await readFile('src/pages/providers/ProviderManageView.tsx', 'utf8');
const source = [shell, gallery, manage].join('\n');

test('provider page is driven by registry and package templates', () => {
  assert.match(shell, /providersApi\.getRegistry\(\)/);
  assert.match(shell, /providersApi\.listTemplates\(\)/);
  assert.match(shell, /templateKeyOf/);
  assert.match(shell, /createTemplate\.packageId/);
  assert.match(shell, /createTemplate\.templateId/);
  assert.match(shell, /createTemplate\.baseUrlMode !== 'fixed'/);
  assert.doesNotMatch(
    source,
    /OpenAI|Anthropic|Google AI|Midjourney|Stable Diffusion|DeepSeek|Vidu|Kling|Volcengine/
  );
});

test('provider page splits into gallery and manage views under one first-level page', () => {
  assert.match(shell, /ProviderGalleryView/);
  assert.match(shell, /ProviderManageView/);
  assert.match(shell, /setView\('gallery'\)/);
  assert.match(shell, /setView\('manage'\)/);
  assert.doesNotMatch(shell, /createBrowserRouter|react-router/);
});

test('gallery shows only adapted templates as cards with a request-adapter entry', () => {
  assert.match(gallery, /templates\.map/);
  assert.match(gallery, /template\.providerName/);
  assert.match(gallery, /connection\.state !== 'deleted'/);
  assert.match(gallery, /onAddConnection/);
  assert.match(gallery, /onRequestAdapter/);
  assert.match(gallery, /求适配/);
  assert.match(gallery, /已连接/);
  assert.match(gallery, /未连接/);
  assert.match(gallery, /保存时验证/);
  assert.doesNotMatch(gallery, /保存后待验证/);
  assert.match(gallery, /validationAction !== 'available'/);
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
    'deleteModel',
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
  assert.match(shell, /providersApi\.onAddConnectionProgress/);
  assert.match(shell, /allowUnavailableSave/);
  assert.match(shell, /connection_validation_failed/);
  assert.match(source, /window\.confirm/);
});

test('credential fields are structured, write-only and cleared after writes', () => {
  assert.match(shell, /createTemplate\.credentialFields\.map/);
  assert.match(manage, /selectedTemplate\.credentialFields\.map/);
  assert.match(source, /type=\{field\.secret \? 'password' : 'text'\}/);
  assert.match(shell, /credentials: newCredentials/);
  assert.match(shell, /setNewCredentials\(\{\}\)/);
  assert.match(source, /setReplacementCredentials\(\{\}\)/);
  assert.doesNotMatch(
    source,
    /credentialReference|getCredential|readCredential|decryptCredential|copyCredential/
  );
});

test('online validation and discovery stay gated on adapter availability', () => {
  assert.match(manage, /selectedTemplate\?\.validationAction !== 'available'/);
  assert.match(manage, /selectedTemplate\?\.modelDiscoveryAction !== 'catalog_available'/);
  assert.match(manage, /validationAction === 'requires_live_api_approval'/);
  assert.match(manage, /modelDiscoveryAction === 'requires_live_api_approval'/);
  assert.doesNotMatch(
    source,
    /getViduLiveValidation|startViduLiveValidation|confirmImageBillableAttempt|confirmVideoBillableAttempt/
  );
});

test('model controls use exact registration and verified profile projections', () => {
  assert.match(manage, /selectedConnection\.state === 'available'/);
  assert.match(source, /providersApi\.registerExactModel/);
  assert.match(source, /providersApi\.deleteModel/);
  assert.match(manage, /onDeleteModel/);
  assert.match(manage, /selectedModel\.profileStatus/);
  assert.match(manage, /selectedModel\.productFeatures/);
  assert.doesNotMatch(source, /capability\.capability|protocolId ===|providerId === ['"]/);
});

test('deleted connections are never listed in the manage view', () => {
  assert.doesNotMatch(manage, /显示已删除/);
  assert.doesNotMatch(manage, /showDeleted/);
  assert.match(manage, /connection\.state === 'deleted'/);
});
