import { normalizePortableRelativePath } from './path-security';

declare const applicationRelativePathBrand: unique symbol;

export type ApplicationRelativePath = string & {
  readonly [applicationRelativePathBrand]: 'ApplicationRelativePath';
};

export function toApplicationRelativePath(value: string): ApplicationRelativePath {
  return normalizePortableRelativePath(value) as ApplicationRelativePath;
}

export const applicationStoragePaths = {
  settings: toApplicationRelativePath('settings/settings.json'),
  projectCatalog: toApplicationRelativePath('projects/catalog.json'),
  providerRegistry: toApplicationRelativePath('providers/registry.json'),
  providerAudit: toApplicationRelativePath('providers/audit.json'),
  runtimeAuthorizationLedger: toApplicationRelativePath(
    'runtime/authorization-ledger.json'
  ),
  diagnosticsDirectory: toApplicationRelativePath('diagnostics'),
  cacheDirectory: toApplicationRelativePath('cache')
} as const;
