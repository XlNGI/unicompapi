import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shell = await readFile('src/pages/providers/ProvidersPage.tsx', 'utf8');
const gallery = await readFile('src/pages/providers/ProviderGalleryView.tsx', 'utf8');
const manage = await readFile('src/pages/providers/ProviderManageView.tsx', 'utf8');
const brandIcon = await readFile('src/pages/providers/ProviderBrandIcon.tsx', 'utf8');
const pageStyles = await readFile('src/styles/pages.css', 'utf8');
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
  assert.match(gallery, /displayedTemplates\.map/);
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

test('gallery promotes the recommended provider without coupling to its display name', () => {
  assert.match(brandIcon, /recommended: true/);
  assert.match(brandIcon, /isRecommendedProviderPackage/);
  assert.match(gallery, /isRecommendedProviderPackage\(right\.packageId\)/);
  assert.match(gallery, /isRecommendedProviderPackage\(template\.packageId\)/);
  assert.match(gallery, /推荐使用/);
  assert.match(gallery, /LuSparkles/);
  assert.match(gallery, /uc-provider-gallery__card--recommended/);
  assert.match(pageStyles, /\.uc-provider-gallery__card--recommended \{/);
  assert.match(pageStyles, /border-color: var\(--uc-color-border-focus\)/);
  assert.doesNotMatch(gallery, /template\.providerName\s*===/);
});

test('provider cards and connections use local brand icons with a safe fallback', () => {
  assert.match(gallery, /ProviderBrandIcon/);
  assert.match(manage, /ProviderBrandIcon/);
  for (const packageId of [
    'provider-package-deepseek',
    'provider-package-volcengine',
    'provider-package-kling',
    'provider-package-kimi',
    'provider-package-newapi',
    'provider-package-unicompapi',
    'provider-package-vidu-v1'
  ]) assert.match(brandIcon, new RegExp(packageId));
  assert.match(brandIcon, /label\.slice\(0, 1\)/);
  assert.match(brandIcon, /assets\/brand\/unicomp-mark\.png/);
  assert.match(brandIcon, /vidu\.svg/);
  assert.match(pageStyles, /data-provider-brand='unicomp'[\s\S]*?filter: invert\(1\)/);
  assert.match(pageStyles, /data-theme='light'[\s\S]*?data-provider-brand='unicomp'[\s\S]*?filter: none/);
  assert.doesNotMatch(brandIcon, /https?:|fetch\(|window\.unicomp/);
});

test('provider feedback uses a closable floating status card without changing actions', () => {
  assert.match(shell, /providerMessageTone/);
  assert.match(shell, /uc-provider-page__message--\$\{messageTone\}/);
  assert.match(shell, /aria-label="关闭通知"/);
  assert.match(shell, /LuCircleCheck/);
  assert.match(shell, /LuCircleAlert/);
  assert.match(shell, /6_000/);
  assert.match(shell, /4_000/);
  assert.match(shell, /window\.clearTimeout/);
  assert.match(shell, /providerMessageDuration/);
  assert.match(shell, /uc-provider-page__message-progress/);
  assert.match(shell, /animationDuration: `\$\{messageDurationMs\}ms`/);
  assert.match(pageStyles, /@keyframes uc-provider-message-countdown/);
  assert.match(pageStyles, /transform: scaleX\(0\)/);
  assert.match(pageStyles, /prefers-reduced-motion: reduce/);
  assert.match(pageStyles, /width: min\(var\(--uc-floating-notice-width\), calc\(100vw - var\(--uc-space-6\)\)\);/);
  assert.match(pageStyles, /min-height: var\(--uc-floating-notice-min-height\);/);
  assert.match(pageStyles, /padding: var\(--uc-floating-notice-padding\);/);
  assert.doesNotMatch(shell, /useGlobalNotifications/);
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
  assert.match(shell, /<Modal/);
  assert.match(shell, /requestConfirmation/);
  assert.match(shell, /远程连接验证未通过/);
  assert.match(shell, /确认放弃活动调用/);
  assert.match(shell, /确认删除模型/);
  assert.doesNotMatch(source, /window\.confirm/);
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

test('model catalog provides local search by display name or exact model key', () => {
  assert.match(manage, /useState\(''\)/);
  assert.match(manage, /const visibleModels = useMemo/);
  assert.match(manage, /model\.displayName/);
  assert.match(manage, /model\.providerModelKey/);
  assert.match(manage, /aria-label="搜索模型"/);
  assert.match(manage, /placeholder="搜索模型名称或标识"/);
  assert.match(manage, /visibleModels\.map/);
  assert.match(manage, /没有匹配的模型/);
  assert.match(manage, /setModelSearch\(''\)/);
});

test('manual model registration stays collapsed behind an accessible add icon', () => {
  assert.match(manage, /const \[manualModelOpen, setManualModelOpen\] = useState\(false\)/);
  assert.match(manage, /aria-controls="provider-manual-model-form"/);
  assert.match(manage, /aria-expanded=\{manualModelOpen\}/);
  assert.match(manage, /aria-label=\{manualModelOpen \? '收起手动添加模型' : '手动添加模型'\}/);
  assert.match(manage, /LuCirclePlus/);
  assert.match(manage, /LuX/);
  assert.match(manage, /selectedConnection\.state === 'available' && manualModelOpen/);
  assert.match(manage, /id="provider-manual-model-form"/);
  assert.match(manage, /setManualModelOpen\(false\)/);
  assert.match(pageStyles, /\.uc-provider-page__icon-button\[aria-expanded='true'\]/);
});

test('model summary stays docked at the page bottom as a compact always-visible row', () => {
  assert.match(manage, /className="uc-provider-page__summary-features" aria-label="产品功能"/);
  assert.match(manage, /selectedModel\.productFeatures\.map/);
  assert.match(manage, /uc-provider-page__summary-feature/);
  assert.match(manage, /selectedModel\.providerModelKey\.toLocaleLowerCase\('zh-CN'\) !==/);
  assert.doesNotMatch(manage, /modelSummaryOpen|provider-model-summary-details|LuChevron/);
  assert.match(pageStyles, /\.uc-provider-page__capabilities \{[\s\S]*?position: fixed;[\s\S]*?right: 0;[\s\S]*?bottom: 0;[\s\S]*?left: 200px;/);
  assert.match(pageStyles, /border-radius: 0;/);
  assert.match(pageStyles, /padding: var\(--uc-space-2\) calc\(var\(--uc-space-4\) \+ var\(--uc-space-6\)\);/);
  assert.match(pageStyles, /\.uc-provider-page__capabilities \{[\s\S]*?background: var\(--uc-navigation-surface\);/);
  assert.match(pageStyles, /padding-bottom: calc\(56px \+ var\(--uc-space-4\)\);/);
  assert.match(pageStyles, /\.uc-provider-page__summary-features \{[\s\S]*?max-height: 42px;[\s\S]*?overflow: hidden;/);
});

test('deleted connections are never listed in the manage view', () => {
  assert.doesNotMatch(manage, /显示已删除/);
  assert.doesNotMatch(manage, /showDeleted/);
  assert.match(manage, /connection\.state === 'deleted'/);
});
