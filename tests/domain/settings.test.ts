import { describe, expect, it } from 'vitest';
import {
  applyPortableSettings,
  createDefaultSettings,
  exportPortableSettings,
  hasHighRiskSettingsChanges,
  parsePortableSettings,
  parseSettingsDocument,
  parseSettingsValues,
  replaceSettingsValues,
  restoreSettingsCategory,
  toSettingsValues
} from '../../src/domain';

const timestamp = '2026-07-27T00:00:00.000Z';

describe('SettingsDocumentV1', () => {
  it('creates and strictly parses all ten local settings categories', () => {
    const document = createDefaultSettings(timestamp);
    expect(parseSettingsDocument(document)).toEqual(document);
    expect(Object.keys(toSettingsValues(document))).toEqual([
      'general',
      'storage',
      'performance',
      'media',
      'privacy',
      'network',
      'notifications',
      'shortcuts',
      'diagnostics',
      'updates'
    ]);

    expect(() => parseSettingsDocument({ ...document, cloudSync: true })).toThrow(
      'missing or unknown fields'
    );
    expect(() => parseSettingsValues({ ...toSettingsValues(document), account: {} })).toThrow(
      'missing or unknown fields'
    );
  });

  it('rejects unsafe privacy and media combinations', () => {
    const values = toSettingsValues(createDefaultSettings(timestamp));
    expect(() => parseSettingsValues({
      ...values,
      privacy: { ...values.privacy, scanHomeDirectory: true }
    })).toThrow('privacy.scanHomeDirectory');
    expect(() => parseSettingsValues({
      ...values,
      media: { ...values.media, automaticSoftwareFallback: false }
    })).toThrow('media.automaticSoftwareFallback');
    expect(() => parseSettingsValues({
      ...values,
      privacy: { ...values.privacy, unknownCostConfirmation: 'never' }
    })).toThrow('privacy.unknownCostConfirmation');
  });

  it('increments revisions and detects high-risk changes separately', () => {
    const document = createDefaultSettings(timestamp);
    const values = toSettingsValues(document);
    const ordinary = parseSettingsValues({
      ...values,
      general: { ...values.general, theme: 'dark' }
    });
    expect(hasHighRiskSettingsChanges(values, ordinary)).toBe(false);

    const risky = parseSettingsValues({
      ...ordinary,
      performance: { ...ordinary.performance, mode: 'high_performance' }
    });
    expect(hasHighRiskSettingsChanges(ordinary, risky)).toBe(true);

    const replaced = replaceSettingsValues(document, ordinary, '2026-07-27T00:01:00.000Z');
    expect(replaced.revision).toBe(1);
    expect(replaced.general.theme).toBe('dark');
  });

  it('exports portable values without directories, proxy or shortcuts', () => {
    const values = parseSettingsValues({
      ...toSettingsValues(createDefaultSettings(timestamp)),
      storage: {
        ...createDefaultSettings(timestamp).storage,
        directories: {
          ...createDefaultSettings(timestamp).storage.directories,
          projects: 'controlled-projects'
        }
      },
      network: {
        ...createDefaultSettings(timestamp).network,
        proxy: {
          kind: 'custom',
          protocol: 'https',
          host: 'private.proxy.test',
          port: 8443,
          authenticationConfigured: true
        }
      },
      shortcuts: {
        bindings: [{ actionId: 'save', windows: 'Ctrl+S', macos: 'Command+S' }]
      }
    });
    const portable = exportPortableSettings(values);
    const serialized = JSON.stringify(portable);
    expect(serialized).not.toContain('controlled-projects');
    expect(serialized).not.toContain('private.proxy.test');
    expect(serialized).not.toContain('Ctrl+S');
    expect(parsePortableSettings(portable)).toEqual(portable);

    const imported = applyPortableSettings(
      toSettingsValues(createDefaultSettings(timestamp)),
      portable
    );
    expect(imported.storage.directories.projects).toBeNull();
    expect(imported.network.proxy).toEqual({ kind: 'system_default' });
  });

  it('restores one category without mutating the others', () => {
    const defaults = toSettingsValues(createDefaultSettings(timestamp));
    const changed = parseSettingsValues({
      ...defaults,
      general: { ...defaults.general, theme: 'dark' },
      updates: { ...defaults.updates, automaticChecks: false }
    });
    const restored = restoreSettingsCategory(changed, 'general');
    expect(restored.general.theme).toBe('system');
    expect(restored.updates.automaticChecks).toBe(false);
  });
});
