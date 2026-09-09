import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CleanupService,
  DirectoryMigrationService,
  JsonDirectoryRegistry,
  StorageOperationError,
  describeControlledDirectory
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-settings-storage-'));
  roots.push(root);
  let id = 0;
  const registry = new JsonDirectoryRegistry(
    path.join(root, 'state', 'directories.json'),
    () => '2026-07-27T00:00:00.000Z',
    () => `0000000${++id}`
  );
  return { root, registry };
}

describe('controlled directory registry and migration', () => {
  it('persists opaque registrations while renderer DTOs exclude paths', async () => {
    const { root, registry } = await fixture();
    const selected = path.join(root, 'selected-private-path');
    await mkdir(selected);
    const entry = await registry.register('projects', selected);
    const repeated = await registry.register('projects', selected);
    expect(repeated.id).toBe(entry.id);

    const dto = await describeControlledDirectory(entry);
    expect(dto).toMatchObject({
      id: entry.id,
      purpose: 'projects',
      displayName: 'selected-private-path',
      readable: true,
      writable: true
    });
    expect(JSON.stringify(dto)).not.toContain(selected);
    expect(await registry.resolve(entry.id, 'works')).toBeUndefined();
    await expect(registry.register('works', selected)).rejects.toThrow(
      'cannot be shared'
    );
  });

  it('rejects symbolic-link directory registrations and reports revoked authorization', async () => {
    const { root, registry } = await fixture();
    const selected = path.join(root, 'selected');
    const linked = path.join(root, 'linked');
    await mkdir(selected);
    await symlink(selected, linked, 'junction');
    await expect(registry.register('projects', linked)).rejects.toMatchObject({
      code: 'symbolic_link_rejected'
    });

    const entry = await registry.register('projects', selected, {
      kind: 'macos_security_scoped_bookmark',
      bookmark: 'opaque-bookmark'
    });
    const renewed = await registry.register('projects', selected, {
      kind: 'macos_security_scoped_bookmark',
      bookmark: 'renewed-bookmark'
    });
    expect(renewed.id).toBe(entry.id);
    expect(renewed.authorization).toEqual({
      kind: 'macos_security_scoped_bookmark',
      bookmark: 'renewed-bookmark'
    });
    const dto = await describeControlledDirectory(entry, {
      ensureAccess: async () => ({
        state: 'revoked',
        reason: 'directory_authorization_revoked'
      })
    });
    expect(dto).toMatchObject({
      state: 'permission_required',
      readable: false,
      writable: false,
      reason: 'directory_authorization_revoked'
    });
    expect(JSON.stringify(dto)).not.toContain('opaque-bookmark');
  });

  it('migrates the v1 registry and recovers the last valid backup', async () => {
    const { root } = await fixture();
    const registryPath = path.join(root, 'legacy', 'directories.json');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const third = path.join(root, 'third');
    await Promise.all([mkdir(first), mkdir(second), mkdir(third), mkdir(path.dirname(registryPath))]);
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        id: 'dir-00000001',
        purpose: 'projects',
        directoryPath: first,
        displayName: 'first',
        registeredAt: '2026-07-27T00:00:00.000Z'
      }]
    }));
    const registry = new JsonDirectoryRegistry(
      registryPath,
      () => '2026-07-28T00:00:00.000Z',
      () => '00000002'
    );
    expect((await registry.list())[0].authorization).toEqual({ kind: 'native_picker' });
    await registry.register('works', second);
    await registry.register('downloads', third);
    await writeFile(registryPath, '{corrupted');

    const recovered = await new JsonDirectoryRegistry(registryPath).list();
    expect(recovered.map((entry) => entry.displayName)).toEqual(['first', 'second']);
    await expect(readFile(registryPath, 'utf8')).resolves.toBe('{corrupted');
  });

  it('copies, verifies and publishes a migration without deleting the source', async () => {
    const { root, registry } = await fixture();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    await mkdir(target);
    await writeFile(path.join(source, 'nested', 'data.bin'), 'verified-data');
    const sourceEntry = await registry.register('projects', source);
    const targetEntry = await registry.register('projects', target);
    const service = new DirectoryMigrationService(registry, {
      createPlanId: () => 'migration-test'
    });
    const plan = await service.plan({
      purpose: 'projects',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    });
    expect(plan).toMatchObject({ fileCount: 1, oldLocationRetained: true });
    await service.execute(plan);
    await expect(readFile(path.join(target, 'nested', 'data.bin'), 'utf8'))
      .resolves.toBe('verified-data');
    await expect(readFile(path.join(source, 'nested', 'data.bin'), 'utf8'))
      .resolves.toBe('verified-data');
  });

  it('preserves Unicode, spaces and deep paths during verified migration', async () => {
    const { root, registry } = await fixture();
    const source = path.join(root, 'source folder');
    const target = path.join(root, 'target folder');
    const relative = path.join(
      '素材 空间',
      ...Array.from({ length: 12 }, (_, index) => `nested-${index}`),
      'Cafe\u0301 result.bin'
    );
    await mkdir(path.join(source, path.dirname(relative)), { recursive: true });
    await mkdir(target);
    await writeFile(path.join(source, relative), 'portable-data');
    const sourceEntry = await registry.register('works', source);
    const targetEntry = await registry.register('works', target);
    const service = new DirectoryMigrationService(registry);
    const plan = await service.plan({
      purpose: 'works',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    });
    await service.execute(plan);
    await expect(readFile(path.join(target, relative), 'utf8')).resolves.toBe('portable-data');
  });

  it('blocks conflicts and insufficient space before copying', async () => {
    const { root, registry } = await fixture();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(source, 'source.bin'), 'data');
    await writeFile(path.join(target, 'conflict.bin'), 'existing');
    const sourceEntry = await registry.register('cache', source);
    const targetEntry = await registry.register('cache', target);
    const service = new DirectoryMigrationService(registry);
    await expect(service.plan({
      purpose: 'cache',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    })).rejects.toMatchObject({ code: 'target_conflict' });

    await rm(path.join(target, 'conflict.bin'));
    const noSpace = new DirectoryMigrationService(registry, {
      freeBytes: async () => 0
    });
    await expect(noSpace.plan({
      purpose: 'cache',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    })).rejects.toMatchObject({ code: 'insufficient_space' });
  });

  it('recovers from copy interruption and verification failure with source intact', async () => {
    const { root, registry } = await fixture();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(source, 'asset.bin'), 'original');
    const sourceEntry = await registry.register('works', source);
    const targetEntry = await registry.register('works', target);

    const interrupted = new DirectoryMigrationService(registry, {
      createPlanId: () => 'interrupted',
      copyFile: async () => { throw new Error('simulated disconnect'); }
    });
    const interruptedPlan = await interrupted.plan({
      purpose: 'works',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    });
    await expect(interrupted.execute(interruptedPlan)).rejects.toMatchObject({
      code: 'copy_failed'
    });
    await expect(readFile(path.join(source, 'asset.bin'), 'utf8')).resolves.toBe('original');
    expect(await access(target).then(() => true, () => false)).toBe(true);

    const corrupting = new DirectoryMigrationService(registry, {
      createPlanId: () => 'corrupting',
      copyFile: async (_source, destination) => writeFile(destination, 'corrupt!')
    });
    const corruptingPlan = await corrupting.plan({
      purpose: 'works',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    });
    await expect(corrupting.execute(corruptingPlan)).rejects.toBeInstanceOf(
      StorageOperationError
    );
    await expect(readFile(path.join(source, 'asset.bin'), 'utf8')).resolves.toBe('original');
  });

  it('rejects a stale manifest and a disconnected target at execution', async () => {
    const { root, registry } = await fixture();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(source, 'asset.bin'), 'before');
    const sourceEntry = await registry.register('downloads', source);
    const targetEntry = await registry.register('downloads', target);
    const service = new DirectoryMigrationService(registry);
    const stale = await service.plan({
      purpose: 'downloads',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    });
    await writeFile(path.join(source, 'asset.bin'), 'after');
    await expect(service.execute(stale)).rejects.toMatchObject({ code: 'source_changed' });

    await writeFile(path.join(source, 'asset.bin'), 'before');
    const disconnected = await service.plan({
      purpose: 'downloads',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    });
    await rm(target, { recursive: true });
    await expect(service.execute(disconnected)).rejects.toMatchObject({
      code: 'directory_disconnected'
    });
  });

  it('never scans a disk root or the user home directory', async () => {
    const { root, registry } = await fixture();
    const target = path.join(root, 'target');
    await mkdir(target);
    const sourceEntry = await registry.register('projects', os.homedir());
    const targetEntry = await registry.register('projects', target);
    const service = new DirectoryMigrationService(registry);
    await expect(service.plan({
      purpose: 'projects',
      sourceDirectoryId: sourceEntry.id,
      targetDirectoryId: targetEntry.id
    })).rejects.toMatchObject({ code: 'unsafe_scan_root' });
  });
});

describe('cleanup allowlist', () => {
  it('deletes only managed cache, proxy, temporary-export and eligible-log files', async () => {
    const { root, registry } = await fixture();
    const userData = path.join(root, 'user-data');
    const projects = path.join(root, 'projects');
    const project = path.join(projects, 'project-a');
    const oldLog = path.join(userData, 'logs', 'old.log');
    const newLog = path.join(userData, 'logs', 'new.log');
    const removable = [
      path.join(userData, 'cache', 'cache.bin'),
      path.join(project, 'cache', 'video-editor-preview', 'proxy.bin'),
      path.join(project, 'tmp', 'editor', 'attempt.bin')
    ];
    const protectedFiles = [
      path.join(project, 'files', 'results', 'work.mp4'),
      path.join(project, 'tmp', 'editor-sources', 'source.mp4')
    ];
    for (const file of [...removable, ...protectedFiles, oldLog, newLog]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'data');
    }
    await utimes(oldLog, new Date('2026-06-01'), new Date('2026-06-01'));
    await utimes(newLog, new Date('2026-07-26'), new Date('2026-07-26'));
    await registry.register('projects', projects);
    const cleanup = new CleanupService(userData, registry);
    const plan = await cleanup.plan(
      ['caches', 'preview_proxies', 'temporary_exports', 'eligible_logs'],
      { logRetentionDays: 14, nowMs: Date.parse('2026-07-27T00:00:00.000Z') }
    );
    expect(plan.fileCount).toBe(4);
    await cleanup.execute(plan);

    for (const file of [...removable, oldLog]) {
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const file of [...protectedFiles, newLog]) {
      await expect(readFile(file, 'utf8')).resolves.toBe('data');
    }
  });

  it('skips a cache registration that overlaps a protected directory', async () => {
    const { root, registry } = await fixture();
    const cache = path.join(root, 'shared');
    const works = path.join(cache, 'works');
    const protectedFile = path.join(works, 'formal.webm');
    await mkdir(works, { recursive: true });
    await writeFile(protectedFile, 'formal');
    await registry.register('cache', cache);
    await registry.register('works', works);
    const cleanup = new CleanupService(path.join(root, 'user-data'), registry);
    const plan = await cleanup.plan(['caches'], {
      logRetentionDays: 14,
      nowMs: Date.parse('2026-07-27T00:00:00.000Z')
    });
    expect(plan.fileCount).toBe(0);
    await cleanup.execute(plan);
    await expect(readFile(protectedFile, 'utf8')).resolves.toBe('formal');
  });

  it('protects registered formal output even when it is inside the app cache root', async () => {
    const { root, registry } = await fixture();
    const userData = path.join(root, 'user-data');
    const works = path.join(userData, 'cache', 'formal-works');
    const protectedFile = path.join(works, 'work.webm');
    await mkdir(works, { recursive: true });
    await writeFile(protectedFile, 'formal');
    await registry.register('works', works);
    const cleanup = new CleanupService(userData, registry);
    const plan = await cleanup.plan(['caches'], {
      logRetentionDays: 14,
      nowMs: Date.parse('2026-07-27T00:00:00.000Z')
    });
    expect(plan.fileCount).toBe(0);
    await expect(readFile(protectedFile, 'utf8')).resolves.toBe('formal');
  });
});
