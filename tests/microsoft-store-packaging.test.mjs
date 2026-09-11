import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoreConfig } from '../scripts/package-microsoft-store.mjs';

const identity = { identityName: '12345.UniComp', publisher: 'CN=00000000-0000-0000-0000-000000000000', publisherDisplayName: 'Test Publisher', displayName: 'UniComp' };

test('store packaging requires explicit account identity and a Store-compatible version', () => {
  for (const key of Object.keys(identity)) assert.throws(() => createStoreConfig({ ...identity, [key]: '' }, '1.0.0'));
  for (const version of ['0.1.0', '1.0.0-beta.1', '1.0.0.1', '1.65536.0']) assert.throws(() => createStoreConfig(identity, version));
  assert.throws(() => createStoreConfig({ ...identity, publisher: 'Example Publisher' }, '1.0.0'));
});

test('store manifest values preserve XML characters and use a valid Application.Id', () => {
  const config = createStoreConfig({ ...identity, publisherDisplayName: 'A & B', displayName: 'A < B', publisher: "CN=Test'Publisher" }, '1.0.0');
  assert.equal(config.appx.publisherDisplayName, 'A &amp; B');
  assert.equal(config.appx.displayName, 'A &lt; B');
  assert.equal(config.appx.publisher, 'CN=Test&apos;Publisher');
  assert.equal(config.appx.applicationId, 'UniComp');
  assert.equal(config.appx.setBuildNumber, false);
  assert.deepEqual(config.win.target, [{ target: 'appx', arch: ['x64'] }]);
});
