import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettingsValues } from '../../src/domain';
import {
  ApplicationDataService,
  DiagnosticsService,
  UpdatesService
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('phase 8 B4 diagnostics and maintenance services', () => {
  it('generates a verified local-only bundle with strict redaction', async () => {
    const root = await temporaryRoot();
    const output = path.join(root, 'selected-output');
    await mkdir(path.join(root, 'logs'), { recursive: true });
    await mkdir(output);
    await writeFile(path.join(root, 'logs', 'application.log'), [
      'Authorization: Bearer top-secret-token',
      'Cookie: session=never-collect',
      'path=C:\\Users\\Developer\\private\\source.mp4',
      'prompt: complete private prompt text'
    ].join('\n'));
    const service = new DiagnosticsService(root, () => '2026-07-27T08:00:00.000Z');
    const settings = createDefaultSettingsValues().diagnostics;

    const preview = await service.preview(settings);
    expect(preview).toMatchObject({
      included: [{ category: 'application', displayName: 'application.log' }],
      automaticUpload: false,
      pathsRedacted: true,
      containsCredentials: false,
      containsUserMedia: false,
      containsFullPrompts: false
    });

    const generated = await service.generate(settings, output);
    expect(generated).toMatchObject({
      format: 'json_gzip_v1',
      locallyVerified: true,
      automaticUpload: false,
      location: 'user_selected'
    });
    const payload = gunzipSync(await readFile(path.join(output, generated.fileName))).toString('utf8');
    expect(payload).not.toContain('top-secret-token');
    expect(payload).not.toContain('never-collect');
    expect(payload).not.toContain('Developer');
    expect(payload).not.toContain('complete private prompt text');
    expect(payload).not.toContain(root);
    expect(payload).toContain('[REDACTED]');
    expect(payload).toContain('[PATH_REDACTED]');
    expect(payload).toContain('[CONTENT_REDACTED]');
  });

  it('cleans only planned diagnostics and retains current logs', async () => {
    const root = await temporaryRoot();
    const logs = path.join(root, 'logs');
    await mkdir(logs, { recursive: true });
    const oldLog = path.join(logs, 'application.log');
    const currentLog = path.join(logs, 'tasks.log');
    await writeFile(oldLog, 'old');
    await writeFile(currentLog, 'current');
    const oldDate = new Date('2026-06-01T00:00:00.000Z');
    await import('node:fs/promises').then(({ utimes }) => utimes(oldLog, oldDate, oldDate));
    const service = new DiagnosticsService(root);
    const settings = createDefaultSettingsValues().diagnostics;
    const plan = await service.planCleanup(
      'expired_logs',
      settings,
      Date.parse('2026-07-27T00:00:00.000Z')
    );
    expect(plan.files.map((file) => path.basename(file.target))).toEqual(['application.log']);
    await service.executeCleanup(plan);
    await expect(stat(oldLog)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(currentLog, 'utf8')).resolves.toBe('current');
  });

  it('enforces category and level switches and rotates bounded log files', async () => {
    const root = await temporaryRoot();
    const service = new DiagnosticsService(root, () => '2026-07-27T00:00:00.000Z');
    const settings = {
      ...createDefaultSettingsValues().diagnostics,
      maxFileBytes: 1_048_576,
      level: 'info' as const,
      categories: {
        ...createDefaultSettingsValues().diagnostics.categories,
        application: true,
        tasks: false
      }
    };
    await expect(service.writeLog('tasks', 'error', 'not written', settings))
      .resolves.toEqual({ written: false, rotated: false });
    await expect(service.writeLog('application', 'debug', 'not written', settings))
      .resolves.toEqual({ written: false, rotated: false });
    await expect(service.writeLog('application', 'info', 'written', settings))
      .resolves.toEqual({ written: true, rotated: false });
    const oversized = 'x'.repeat(settings.maxFileBytes);
    await service.writeLog('application', 'info', oversized, settings);
    await expect(service.writeLog('application', 'info', 'rotated', settings))
      .resolves.toMatchObject({ written: true, rotated: true });
  });

  it('clears only userData allowlist files and never project or external content', async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    const projectFile = path.join(root, 'projects', 'project-a', 'entities', 'works.json');
    const externalFile = path.join(external, 'source.mp4');
    const credential = path.join(root, 'secure-credentials.json');
    const log = path.join(root, 'logs', 'application.log');
    const cache = path.join(root, 'cache', 'preview.bin');
    for (const file of [projectFile, externalFile, credential, log, cache]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'fixture');
    }
    const service = new ApplicationDataService(root);
    const plan = await service.plan(['local_credentials', 'logs', 'caches']);
    expect(plan).toMatchObject({ projectsExcluded: true, externalFilesExcluded: true });
    expect(JSON.stringify(plan)).not.toContain(projectFile);
    expect(JSON.stringify(plan)).not.toContain(externalFile);
    await service.execute(plan);
    await expect(stat(credential)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('fixture');
    await expect(readFile(externalFile, 'utf8')).resolves.toBe('fixture');
  });

  it('keeps unavailable and invalidly signed updates non-installable', async () => {
    const unavailable = new UpdatesService('0.1.0', () => '2026-07-27T00:00:00.000Z');
    const settings = createDefaultSettingsValues().updates;
    const unavailableStatus = await unavailable.getStatus(settings, true);
    expect(unavailableStatus.capability).toMatchObject({
      state: 'unavailable',
      reason: 'production_update_source_not_configured'
    });
    expect(unavailableStatus.items.every((item) =>
      item.state === 'unavailable' && item.canInstall === false && item.availableVersion === null
    )).toBe(true);
    expect(JSON.stringify(unavailableStatus)).not.toContain('up_to_date');

    const invalid = new UpdatesService(
      '0.1.0',
      () => '2026-07-27T00:00:00.000Z',
      {
        async check() {
          return [{
            kind: 'application' as const,
            currentVersion: '0.1.0',
            availableVersion: '0.2.0',
            integrity: 'verified' as const,
            signature: 'failed' as const
          }];
        }
      },
      {
        async getSnapshot() {
          return {
            activeTaskCount: 1,
            unsavedDraftCount: 2,
            activeExportCount: 1,
            repairTaskCount: 0
          };
        }
      }
    );
    const invalidStatus = await invalid.getStatus(settings, true);
    expect(invalidStatus.items[0]).toMatchObject({
      state: 'failed',
      reason: 'integrity_or_signature_failed',
      availableVersion: null,
      canInstall: false
    });
    expect(invalidStatus.blockers).toEqual(['active_tasks', 'unsaved_drafts', 'active_exports']);

    const failedCheck = new UpdatesService('0.1.0', undefined, {
      async check() {
        throw new Error('network down');
      }
    });
    const failedStatus = await failedCheck.getStatus(settings, true);
    expect(failedStatus).toMatchObject({ capability: { state: 'failed' } });
    expect(failedStatus.items.every((item) => item.availableVersion === null && item.canInstall === false))
      .toBe(true);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b4-'));
  roots.push(root);
  return root;
}
