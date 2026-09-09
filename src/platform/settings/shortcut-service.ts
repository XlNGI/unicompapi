import type { ShortcutSettings } from '../../domain';
import type {
  ShortcutActionDto,
  ShortcutPlatform,
  ShortcutUpdateBindingDto,
  ShortcutValidationIssueDto
} from '../../shared/settings-ipc';

export const shortcutRegistryVersion = 1 as const;

export const shortcutActionRegistry: readonly ShortcutActionDto[] = [
  {
    actionId: 'show_app', registryVersion: 1, scope: 'global', mutable: true,
    defaults: { windows: 'Control+Alt+U', macos: 'Command+Option+U' }
  },
  {
    actionId: 'new_project', registryVersion: 1, scope: 'application', mutable: true,
    defaults: { windows: 'Control+N', macos: 'Command+N' }
  },
  {
    actionId: 'open_settings', registryVersion: 1, scope: 'application', mutable: true,
    defaults: { windows: 'Control+,', macos: 'Command+,' }
  },
  {
    actionId: 'focus_search', registryVersion: 1, scope: 'application', mutable: true,
    defaults: { windows: 'Control+K', macos: 'Command+K' }
  },
  {
    actionId: 'cancel_current_action', registryVersion: 1, scope: 'application', mutable: false,
    defaults: { windows: 'Escape', macos: 'Escape' }
  }
] as const;

export interface ShortcutPlatformAdapter {
  register(accelerator: string, actionId: string): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutChangePlan {
  readonly platform: ShortcutPlatform;
  readonly previous: ShortcutSettings;
  readonly next: ShortcutSettings;
  readonly issues: readonly ShortcutValidationIssueDto[];
}

export class ShortcutOperationError extends Error {
  constructor(readonly code: 'registration_failed' | 'rollback_failed') {
    super(`Shortcut operation failed: ${code}`);
    this.name = 'ShortcutOperationError';
  }
}

export class ShortcutService {
  private readonly activeGlobal = new Map<string, string>();

  constructor(
    private readonly currentPlatform: ShortcutPlatform,
    private readonly adapter: ShortcutPlatformAdapter
  ) {}

  getStatus(_settings: ShortcutSettings) {
    return {
      registryVersion: shortcutRegistryVersion,
      platform: this.currentPlatform,
      actions: shortcutActionRegistry,
      activeGlobalActionIds: [...this.activeGlobal.keys()].sort()
    };
  }

  plan(
    current: ShortcutSettings,
    platform: ShortcutPlatform,
    updates: readonly ShortcutUpdateBindingDto[]
  ): ShortcutChangePlan {
    const issues = validateUpdates(platform, updates);
    const next = mergePlatformBindings(current, platform, updates);
    return {
      platform,
      previous: current,
      next,
      issues: [...issues, ...validateResolvedBindings(next, platform)]
    };
  }

  restoreDefaults(
    current: ShortcutSettings,
    platform: ShortcutPlatform
  ): ShortcutChangePlan {
    const updates = shortcutActionRegistry.map((action) => ({
      actionId: action.actionId,
      accelerator: action.defaults[platform]
    }));
    const next = mergePlatformBindings(current, platform, updates);
    return { platform, previous: current, next, issues: [] };
  }

  restoreAllDefaults(current: ShortcutSettings): ShortcutChangePlan {
    const next: ShortcutSettings = {
      bindings: shortcutActionRegistry.map((action) => ({
        actionId: action.actionId,
        windows: action.defaults.windows,
        macos: action.defaults.macos
      }))
    };
    return {
      platform: this.currentPlatform,
      previous: current,
      next,
      issues: []
    };
  }

  async activate(settings: ShortcutSettings): Promise<void> {
    await this.replaceRegistrations(settings, true);
  }

  async apply(plan: ShortcutChangePlan): Promise<() => Promise<void>> {
    if (plan.issues.length > 0) throw new TypeError('Shortcut bindings are invalid');
    if (plan.platform !== this.currentPlatform) return async () => undefined;
    await this.replaceRegistrations(plan.next, true, plan.previous);
    return () => this.replaceRegistrations(plan.previous, true, plan.next);
  }

  release(): void {
    for (const accelerator of this.activeGlobal.values()) {
      this.adapter.unregister(accelerator);
    }
    this.activeGlobal.clear();
  }

  private async replaceRegistrations(
    next: ShortcutSettings,
    rollbackOnFailure: boolean,
    previous?: ShortcutSettings
  ): Promise<void> {
    const oldRegistrations = new Map(this.activeGlobal);
    for (const accelerator of oldRegistrations.values()) {
      this.adapter.unregister(accelerator);
    }
    this.activeGlobal.clear();

    const desired = globalBindings(next, this.currentPlatform);
    for (const [actionId, accelerator] of desired) {
      if (this.adapter.register(accelerator, actionId)) {
        this.activeGlobal.set(actionId, accelerator);
        continue;
      }
      for (const registered of this.activeGlobal.values()) {
        this.adapter.unregister(registered);
      }
      this.activeGlobal.clear();
      if (rollbackOnFailure) {
        const restore = previous
          ? globalBindings(previous, this.currentPlatform)
          : oldRegistrations;
        for (const [oldActionId, oldAccelerator] of restore) {
          if (!this.adapter.register(oldAccelerator, oldActionId)) {
            throw new ShortcutOperationError('rollback_failed');
          }
          this.activeGlobal.set(oldActionId, oldAccelerator);
        }
      }
      throw new ShortcutOperationError('registration_failed');
    }
  }
}

function mergePlatformBindings(
  current: ShortcutSettings,
  platform: ShortcutPlatform,
  updates: readonly ShortcutUpdateBindingDto[]
): ShortcutSettings {
  const currentByAction = new Map(current.bindings.map((binding) => [binding.actionId, binding]));
  const updatesByAction = new Map(updates.map((binding) => [binding.actionId, binding.accelerator]));
  const actionIds = new Set([
    ...current.bindings.map((binding) => binding.actionId),
    ...updates.map((binding) => binding.actionId)
  ]);
  return {
    bindings: [...actionIds].map((actionId) => {
      const currentBinding = currentByAction.get(actionId);
      const hasUpdate = updatesByAction.has(actionId);
      const action = shortcutActionRegistry.find((item) => item.actionId === actionId);
      const currentWindows = currentBinding
        ? currentBinding.windows
        : action?.defaults.windows ?? null;
      const currentMacos = currentBinding
        ? currentBinding.macos
        : action?.defaults.macos ?? null;
      return {
        actionId,
        windows: platform === 'windows'
          ? (hasUpdate ? updatesByAction.get(actionId) ?? null : currentWindows)
          : currentWindows,
        macos: platform === 'macos'
          ? (hasUpdate ? updatesByAction.get(actionId) ?? null : currentMacos)
          : currentMacos
      };
    })
  };
}

function validateUpdates(
  platform: ShortcutPlatform,
  updates: readonly ShortcutUpdateBindingDto[]
): ShortcutValidationIssueDto[] {
  const issues: ShortcutValidationIssueDto[] = [];
  const seen = new Set<string>();
  for (const update of updates) {
    const action = shortcutActionRegistry.find((item) => item.actionId === update.actionId);
    if (!action) {
      issues.push({ actionId: update.actionId, code: 'unknown_action' });
      continue;
    }
    if (!action.mutable && update.accelerator !== action.defaults[platform]) {
      issues.push({ actionId: update.actionId, code: 'immutable_action' });
    }
    if (seen.has(update.actionId)) {
      issues.push({ actionId: update.actionId, code: 'duplicate' });
    }
    seen.add(update.actionId);
    if (update.accelerator !== null && !isAccelerator(update.accelerator)) {
      issues.push({ actionId: update.actionId, code: 'invalid' });
    }
  }
  return issues;
}

function validateResolvedBindings(
  settings: ShortcutSettings,
  platform: ShortcutPlatform
): ShortcutValidationIssueDto[] {
  const issues: ShortcutValidationIssueDto[] = [];
  const owners = new Map<string, string>();
  const stored = new Map(settings.bindings.map((binding) => [binding.actionId, binding]));
  for (const binding of settings.bindings) {
    if (!shortcutActionRegistry.some((action) => action.actionId === binding.actionId)) {
      issues.push({ actionId: binding.actionId, code: 'unknown_action' });
    }
  }
  for (const action of shortcutActionRegistry) {
    const binding = stored.get(action.actionId);
    const accelerator = binding
      ? (platform === 'windows' ? binding.windows : binding.macos)
      : action.defaults[platform];
    if (!accelerator) continue;
    const normalized = normalizeAccelerator(accelerator);
    const owner = owners.get(normalized);
    if (owner) {
      issues.push({ actionId: owner, code: 'duplicate' });
      issues.push({ actionId: action.actionId, code: 'duplicate' });
    } else {
      owners.set(normalized, action.actionId);
    }
    if (isReserved(platform, normalized)) {
      issues.push({ actionId: action.actionId, code: 'system_reserved' });
    }
  }
  return deduplicateIssues(issues);
}

function globalBindings(
  settings: ShortcutSettings,
  platform: ShortcutPlatform
): Map<string, string> {
  const stored = new Map(settings.bindings.map((binding) => [binding.actionId, binding]));
  const result = new Map<string, string>();
  for (const action of shortcutActionRegistry) {
    if (action.scope !== 'global') continue;
    const binding = stored.get(action.actionId);
    const accelerator = binding
      ? (platform === 'windows' ? binding.windows : binding.macos)
      : action.defaults[platform];
    if (accelerator) result.set(action.actionId, accelerator);
  }
  return result;
}

function isAccelerator(value: string): boolean {
  if (value.length < 1 || value.length > 64 || /\s/.test(value)) return false;
  return parseAccelerator(value) !== undefined;
}

function normalizeAccelerator(value: string): string {
  return parseAccelerator(value)?.join('+') ?? value.toLowerCase();
}

function isReserved(platform: ShortcutPlatform, value: string): boolean {
  const common = new Set(['alt+control+delete', 'alt+tab']);
  const windows = new Set(['alt+f4', 'meta+l', 'meta+d']);
  const macos = new Set(['command+q', 'command+tab', 'command+space']);
  return common.has(value) || (platform === 'windows' ? windows : macos).has(value);
}

function parseAccelerator(value: string): readonly string[] | undefined {
  const parts = value.split('+');
  if (parts.some((part) => part.length === 0)) return undefined;
  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const modifier = modifierAliases[part.toLowerCase()];
    if (modifier) modifiers.push(modifier);
    else keys.push(part.toLowerCase());
  }
  if (
    keys.length !== 1 ||
    !isAcceleratorKey(keys[0]) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return undefined;
  }
  return [...modifiers.sort(), keys[0]];
}

const modifierAliases: Readonly<Record<string, string>> = {
  command: 'command',
  cmd: 'command',
  control: 'control',
  ctrl: 'control',
  commandorcontrol: 'commandorcontrol',
  cmdorctrl: 'commandorcontrol',
  alt: 'alt',
  option: 'alt',
  altgr: 'altgr',
  shift: 'shift',
  super: 'meta',
  meta: 'meta'
};

function isAcceleratorKey(value: string): boolean {
  return value.length === 1 ||
    /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(value) ||
    [
      'backspace', 'delete', 'down', 'end', 'enter', 'escape', 'home',
      'insert', 'left', 'minus', 'pagedown', 'pageup', 'plus', 'right',
      'space', 'tab', 'up', 'volumeup', 'volumedown', 'volumemute',
      'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause'
    ].includes(value);
}

function deduplicateIssues(
  issues: readonly ShortcutValidationIssueDto[]
): ShortcutValidationIssueDto[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.actionId}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
