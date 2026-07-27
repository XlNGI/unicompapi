import { describe, expect, it } from 'vitest';
import { createDefaultSettingsValues } from '../../src/domain';
import type { MediaEngineAdapter } from '../../src/platform/videos/media-engine-adapter';
import {
  MediaSettingsStatusService,
  PerformancePolicyService
} from '../../src/platform';

describe('PerformancePolicyService', () => {
  it('derives machine-specific bounds and freezes policy for new attempts', async () => {
    let now = '2026-07-27T00:00:00.000Z';
    const service = new PerformancePolicyService(
      () => ({
        logicalCpuCount: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeMemoryBytes: 8 * 1024 ** 3,
        loadAverageOneMinute: 2
      }),
      () => now,
      async () => 3
    );
    const status = await service.getStatus();
    expect(status).toMatchObject({
      logicalCpuCount: 8,
      currentLoadPercent: 25,
      activeTaskCount: 3,
      changesApplyTo: 'new_tasks_and_attempts'
    });
    expect(status.maximums.local_video).toBeGreaterThanOrEqual(
      status.recommendations.local_video
    );

    const defaults = createDefaultSettingsValues();
    const first = service.createSnapshot(
      defaults.performance,
      defaults.media.hardwareAcceleration,
      true
    );
    now = '2026-07-27T00:01:00.000Z';
    const second = service.createSnapshot(
      {
        ...defaults.performance,
        mode: 'energy_saver',
        concurrency: { ...defaults.performance.concurrency, localVideo: 1 }
      },
      'software_only',
      true
    );
    expect(first.createdAt).toBe('2026-07-27T00:00:00.000Z');
    expect(first.hardwareAcceleration).toBe('auto');
    expect(second.createdAt).toBe('2026-07-27T00:01:00.000Z');
    expect(second.hardwareAcceleration).toBe('software_only');
    expect(second.concurrency.local_video).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.concurrency)).toBe(true);
  });
});

describe('MediaSettingsStatusService', () => {
  it('reports an absent engine honestly and keeps hardware independent', async () => {
    const status = await new MediaSettingsStatusService(() => undefined).getStatus();
    expect(status).toMatchObject({
      engine: {
        state: 'unavailable',
        distributionScope: 'not_configured',
        supportsSoftwareExport: false
      },
      hardwareAcceleration: {
        state: 'unavailable',
        reason: 'hardware_acceleration_not_approved'
      },
      automaticSoftwareFallback: true,
      softwareExportBlockedByHardwareFailure: false
    });
  });

  it('publishes only real probed development capabilities', async () => {
    const adapter = {
      descriptor: { adapterId: 'ffmpeg', adapterVersion: '8.1.2' },
      getCapabilities: async () => ({
        descriptor: { adapterId: 'ffmpeg', adapterVersion: '8.1.2' },
        version: 'ffmpeg version 8.1.2',
        videoEncoders: ['libvpx-vp9'],
        audioEncoders: ['libopus'],
        containers: ['webm'],
        filters: ['scale'],
        supportsProbe: true as const,
        supportsPreview: true as const,
        supportsExport: true as const,
        supportsCancel: true as const
      })
    } as unknown as MediaEngineAdapter;
    const status = await new MediaSettingsStatusService(() => adapter).getStatus();
    expect(status.engine).toMatchObject({
      state: 'available',
      adapterId: 'ffmpeg',
      version: 'ffmpeg version 8.1.2',
      distributionScope: 'development_test_only',
      supportsSoftwareExport: true
    });
    expect(JSON.stringify(status)).not.toMatch(/UNICOMP_FFMPEG_PATH|ffmpegPath/i);
  });

  it('does not turn a probe failure into an available component', async () => {
    const adapter = {
      descriptor: { adapterId: 'ffmpeg', adapterVersion: '8.1.2' },
      getCapabilities: async () => { throw new Error('probe failed'); }
    } as unknown as MediaEngineAdapter;
    await expect(new MediaSettingsStatusService(() => adapter).getStatus())
      .resolves.toMatchObject({
        engine: { state: 'failed', reason: 'media_engine_probe_failed' },
        softwareExportBlockedByHardwareFailure: false
      });
  });
});
