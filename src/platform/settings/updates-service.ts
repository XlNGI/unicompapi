import type { UpdateSettings } from '../../domain';
import type {
  SettingsMaintenanceStatusDto,
  UpdateItemKind,
  UpdateItemStatusDto
} from '../../shared/settings-ipc';

export interface UpdateActivitySnapshot {
  readonly activeTaskCount: number;
  readonly unsavedDraftCount: number;
  readonly activeExportCount: number;
  readonly repairTaskCount: number;
}

export interface UpdateCandidate {
  readonly kind: UpdateItemKind;
  readonly currentVersion: string;
  readonly availableVersion: string;
  readonly integrity: 'verified' | 'failed';
  readonly signature: 'verified' | 'failed';
}

export interface UpdateAdapter {
  check(channel: 'stable'): Promise<readonly UpdateCandidate[]>;
}

export interface UpdateActivityAdapter {
  getSnapshot(): Promise<UpdateActivitySnapshot>;
}

const updateKinds: readonly UpdateItemKind[] = [
  'application',
  'media_component',
  'built_in_adapters',
  'provider_presets',
  'help_resources'
];

export class UpdatesService {
  private lastCheckedAt: string | null = null;
  private candidates: readonly UpdateCandidate[] = [];
  private lastCheckFailed = false;

  constructor(
    private readonly applicationVersion: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly adapter?: UpdateAdapter,
    private readonly activity?: UpdateActivityAdapter
  ) {}

  async getStatus(settings: UpdateSettings, check = false): Promise<SettingsMaintenanceStatusDto['updates']> {
    if (check) {
      this.lastCheckedAt = this.now();
      this.lastCheckFailed = false;
      try {
        this.candidates = this.adapter ? await this.adapter.check(settings.channel) : [];
      } catch {
        this.candidates = [];
        this.lastCheckFailed = true;
      }
    }
    const blockers = await this.getBlockers();
    const items = updateKinds.map((kind) => this.toItem(kind));
    return {
      capability: this.lastCheckFailed
        ? { id: 'updates', state: 'failed', reason: 'update_check_failed' }
        : this.adapter
        ? { id: 'updates', state: 'available' }
        : { id: 'updates', state: 'unavailable', reason: 'production_update_source_not_configured' },
      items,
      checkedAt: this.lastCheckedAt,
      blockers,
      installRequiresExplicitConfirmation: true,
      restartRequiresExplicitConfirmation: true
    };
  }

  private async getBlockers(): Promise<readonly string[]> {
    if (!this.activity) return [];
    const current = await this.activity.getSnapshot();
    const blockers: string[] = [];
    if (current.activeTaskCount > 0) blockers.push('active_tasks');
    if (current.unsavedDraftCount > 0) blockers.push('unsaved_drafts');
    if (current.activeExportCount > 0) blockers.push('active_exports');
    if (current.repairTaskCount > 0) blockers.push('component_repair_in_progress');
    return blockers;
  }

  private toItem(kind: UpdateItemKind): UpdateItemStatusDto {
    const candidate = this.candidates.find((item) => item.kind === kind);
    if (this.lastCheckFailed) {
      return {
        kind,
        currentVersion: kind === 'application' ? this.applicationVersion : null,
        availableVersion: null,
        channel: 'stable',
        state: 'failed',
        reason: 'update_check_failed',
        integrity: 'not_checked',
        signature: 'not_checked',
        canInstall: false,
        canRepair: false,
        canRollback: false
      };
    }
    if (!this.adapter) {
      return {
        kind,
        currentVersion: kind === 'application' ? this.applicationVersion : null,
        availableVersion: null,
        channel: 'stable',
        state: 'unavailable',
        reason: 'production_update_source_not_configured',
        integrity: 'not_checked',
        signature: 'not_checked',
        canInstall: false,
        canRepair: false,
        canRollback: false
      };
    }
    if (!candidate) {
      return {
        kind,
        currentVersion: kind === 'application' ? this.applicationVersion : null,
        availableVersion: null,
        channel: 'stable',
        state: 'unavailable',
        reason: 'no_verified_update_available',
        integrity: 'not_checked',
        signature: 'not_checked',
        canInstall: false,
        canRepair: false,
        canRollback: false
      };
    }
    const valid = candidate.integrity === 'verified' && candidate.signature === 'verified';
    return {
      kind,
      currentVersion: candidate.currentVersion,
      availableVersion: valid ? candidate.availableVersion : null,
      channel: 'stable',
      state: valid ? 'update_available' : 'failed',
      reason: valid ? 'verified_update_available' : 'integrity_or_signature_failed',
      integrity: candidate.integrity,
      signature: candidate.signature,
      canInstall: false,
      canRepair: false,
      canRollback: false
    };
  }
}
