import type {
  NativeSystemSettingsTarget,
  PrivacyPermissionStatusDto,
  SettingsCapabilityState
} from '../../shared/settings-ipc';

export interface NativePermissionAdapter {
  getStatus(target: NativeSystemSettingsTarget): Promise<{
    readonly state: SettingsCapabilityState;
    readonly reason?: string;
  }>;
  openSystemSettings(target: NativeSystemSettingsTarget): Promise<void>;
}

export class PrivacyPermissionService {
  constructor(private readonly adapter: NativePermissionAdapter) {}

  async getStatus(): Promise<PrivacyPermissionStatusDto> {
    const targets = ['files_and_folders', 'notifications'] as const;
    const statuses = await Promise.all(targets.map(async (target) => ({
      id: target,
      systemSettingsTarget: target,
      ...await this.adapter.getStatus(target)
    })));
    return {
      minimumAuthorization: {
        selectedFilesOnly: true,
        authorizedDirectoriesOnly: true,
        homeDirectoryScan: false,
        backgroundClipboardRead: false,
        outboundConfirmationMandatory: true,
        unknownCostConfirmationMandatory: true
      },
      permissions: statuses
    };
  }

  async openSystemSettings(target: NativeSystemSettingsTarget): Promise<void> {
    if (!isNativeSystemSettingsTarget(target)) {
      throw new TypeError('Native system settings target is invalid');
    }
    await this.adapter.openSystemSettings(target);
  }
}

export function isNativeSystemSettingsTarget(
  value: unknown
): value is NativeSystemSettingsTarget {
  return value === 'files_and_folders' || value === 'notifications';
}
