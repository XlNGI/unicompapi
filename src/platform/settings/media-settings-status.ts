import type { SettingsSystemStatusDto } from '../../shared/settings-ipc';
import {
  createFfmpegMediaEngineAdapterFromEnvironment,
  type MediaEngineAdapter
} from '../videos/media-engine-adapter';

export class MediaSettingsStatusService {
  constructor(
    private readonly createAdapter: () => MediaEngineAdapter | undefined = () =>
      createFfmpegMediaEngineAdapterFromEnvironment()
  ) {}

  async getStatus(): Promise<SettingsSystemStatusDto['media']> {
    const adapter = this.createAdapter();
    if (!adapter) {
      return {
        engine: {
          id: 'media_engine',
          state: 'unavailable',
          reason: 'development_media_engine_not_configured',
          distributionScope: 'not_configured',
          supportsProbe: false,
          supportsPreview: false,
          supportsSoftwareExport: false
        },
        hardwareAcceleration: {
          id: 'hardware_acceleration',
          state: 'unavailable',
          reason: 'hardware_acceleration_not_approved'
        },
        automaticSoftwareFallback: true,
        softwareExportBlockedByHardwareFailure: false
      };
    }
    try {
      const capabilities = await adapter.getCapabilities();
      return {
        engine: {
          id: 'media_engine',
          state: 'available',
          adapterId: capabilities.descriptor.adapterId,
          version: capabilities.version,
          distributionScope: 'development_test_only',
          supportsProbe: capabilities.supportsProbe,
          supportsPreview: capabilities.supportsPreview,
          supportsSoftwareExport: capabilities.supportsExport
        },
        hardwareAcceleration: {
          id: 'hardware_acceleration',
          state: 'unavailable',
          reason: 'hardware_acceleration_not_approved'
        },
        automaticSoftwareFallback: true,
        softwareExportBlockedByHardwareFailure: false
      };
    } catch {
      return {
        engine: {
          id: 'media_engine',
          state: 'failed',
          reason: 'media_engine_probe_failed',
          adapterId: adapter.descriptor.adapterId,
          distributionScope: 'development_test_only',
          supportsProbe: false,
          supportsPreview: false,
          supportsSoftwareExport: false
        },
        hardwareAcceleration: {
          id: 'hardware_acceleration',
          state: 'unavailable',
          reason: 'hardware_acceleration_not_approved'
        },
        automaticSoftwareFallback: true,
        softwareExportBlockedByHardwareFailure: false
      };
    }
  }
}
