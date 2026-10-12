import { toIsoTimestamp } from '../../domain';
import type { JsonProviderRegistryStore } from './provider-registry';
import type { ProviderPackageRegistry } from './provider-package-registry';
import {
  routeOpenAiCompatibleImageProfilesForEnabledModels,
  routeOpenAiCompatibleImageEditProfilesForEnabledModels,
  routeOpenAiCompatibleReferenceImageProfilesForEnabledModels
} from './newapi/openai-compatible-image-routing';
import { routeOpenAiCompatibleVideoProfilesForEnabledModels } from './newapi/openai-compatible-video-routing';

/** Local compatibility initialization using existing package contracts; no Provider requests. */
export async function initializeProviderFeatureProfiles(registry: JsonProviderRegistryStore, packages: ProviderPackageRegistry): Promise<void> {
  await registry.mutateIfChanged(snapshot => {
    const now = toIsoTimestamp(new Date().toISOString());
    let next = routeOpenAiCompatibleImageProfilesForEnabledModels(snapshot, packages, now);
    next = routeOpenAiCompatibleImageEditProfilesForEnabledModels(next, packages, now);
    next = routeOpenAiCompatibleReferenceImageProfilesForEnabledModels(next, packages, now);
    next = routeOpenAiCompatibleVideoProfilesForEnabledModels(next, packages, now);
    return { snapshot: next, result: undefined };
  });
}
