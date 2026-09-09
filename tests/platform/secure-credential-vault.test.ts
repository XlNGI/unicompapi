import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CredentialVaultUnavailableError,
  CredentialProtectionError,
  SecureCredentialVault,
  type CredentialProtector
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('SecureCredentialVault', () => {
  it('persists only protected bytes and replaces values without a read API', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vault-'));
    roots.push(root);
    const vaultPath = path.join(root, 'secure-credentials.json');
    const vault = new SecureCredentialVault(vaultPath, reversibleProtector());

    await vault.save('credential-fixture', 'fixture-value-alpha');
    await vault.save('credential-fixture', 'fixture-value-beta');

    expect(await vault.status('credential-fixture')).toBe('saved');
    expect(await vault.test('credential-fixture', async (value) =>
      value === 'fixture-value-beta' ? 'valid' : 'invalid'
    )).toBe('valid');
    const serialized = await readFile(vaultPath, 'utf8');
    expect(serialized).not.toContain('fixture-value-alpha');
    expect(serialized).not.toContain('fixture-value-beta');
  });

  it('reports unavailable encryption and supports idempotent local deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vault-'));
    roots.push(root);
    const protector = reversibleProtector();
    const vault = new SecureCredentialVault(
      path.join(root, 'secure-credentials.json'),
      protector
    );

    expect(await vault.remove('credential-missing')).toBe(false);
    await vault.save('credential-fixture', 'fixture-value');
    expect(await vault.remove('credential-fixture')).toBe(true);
    expect(await vault.status('credential-fixture')).toBe('not_configured');

    protector.available = false;
    expect(await vault.status('credential-fixture')).toBe(
      'encryption_unavailable'
    );
    await expect(vault.save('credential-fixture', 'fixture-value')).rejects.toBeInstanceOf(
      CredentialVaultUnavailableError
    );
  });

  it('restores credentials after restart without exposing a plaintext read API', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vault-'));
    roots.push(root);
    const vaultPath = path.join(root, 'secure-credentials.json');
    const protector = reversibleProtector();
    await new SecureCredentialVault(vaultPath, protector).save('credential-restart', 'restart-value');

    const restarted = new SecureCredentialVault(vaultPath, protector);
    expect(await restarted.test('credential-restart', async (value) =>
      value === 'restart-value' ? 'valid' : 'invalid'
    )).toBe('valid');
  });

  it('keeps the old credential when replacement encryption cannot round-trip', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vault-'));
    roots.push(root);
    const vaultPath = path.join(root, 'secure-credentials.json');
    const original = reversibleProtector();
    const vault = new SecureCredentialVault(vaultPath, original);
    await vault.save('credential-rollback', 'old-value');
    const failing = new SecureCredentialVault(vaultPath, {
      isAvailable: () => true,
      protect: (value) => Buffer.from(value),
      unprotect: () => 'different-value'
    });
    await expect(failing.save('credential-rollback', 'new-value')).rejects.toBeInstanceOf(
      CredentialProtectionError
    );
    expect(await vault.test('credential-rollback', async (value) =>
      value === 'old-value' ? 'valid' : 'invalid'
    )).toBe('valid');
  });

  it('reads the last valid backup without overwriting corrupted primary evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vault-'));
    roots.push(root);
    const vaultPath = path.join(root, 'secure-credentials.json');
    const protector = reversibleProtector();
    const vault = new SecureCredentialVault(vaultPath, protector);
    await vault.save('credential-backup', 'first-value');
    await vault.save('credential-backup', 'second-value');
    await writeFile(vaultPath, '{corrupted');

    const recovered = new SecureCredentialVault(vaultPath, protector);
    expect(await recovered.test('credential-backup', async (value) =>
      value === 'first-value' ? 'valid' : 'invalid'
    )).toBe('valid');
    await expect(readFile(vaultPath, 'utf8')).resolves.toBe('{corrupted');
  });
});

function reversibleProtector(): CredentialProtector & { available: boolean } {
  return {
    available: true,
    isAvailable() {
      return this.available;
    },
    protect(value) {
      return Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5));
    },
    unprotect(value) {
      return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8');
    }
  };
}
