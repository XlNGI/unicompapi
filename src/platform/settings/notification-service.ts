import type {
  NotificationTestResultDto,
  SettingsCapabilityDto
} from '../../shared/settings-ipc';

export interface NotificationPlatformAdapter {
  getSystemCapability(): Promise<SettingsCapabilityDto>;
  getSoundCapability(): Promise<SettingsCapabilityDto>;
  sendTest(input: {
    readonly title: string;
    readonly body: string;
  }): Promise<'accepted' | 'denied' | 'unsupported' | 'failed'>;
  playSound(): Promise<'accepted' | 'unsupported' | 'failed'>;
}

export class NotificationService {
  constructor(private readonly adapter: NotificationPlatformAdapter) {}

  async getStatus() {
    const [system, sound] = await Promise.all([
      this.adapter.getSystemCapability(),
      this.adapter.getSoundCapability()
    ]);
    return {
      inApp: { id: 'in_app_notifications', state: 'available' as const },
      system,
      sound
    };
  }

  async sendTest(
    system: boolean,
    sound: boolean
  ): Promise<NotificationTestResultDto> {
    const [systemResult, soundResult] = await Promise.all([
      system
        ? this.adapter.sendTest({ title: 'UniComp', body: 'Notification test' })
        : Promise.resolve('not_requested' as const),
      sound
        ? this.adapter.playSound()
        : Promise.resolve('not_requested' as const)
    ]);
    return {
      inApp: 'retained',
      system: systemResult,
      sound: soundResult,
      taskStateMutated: false,
      executionStateMutated: false
    };
  }
}
