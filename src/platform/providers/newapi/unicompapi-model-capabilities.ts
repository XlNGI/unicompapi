import { UNICOMPAPI_PROVIDER_PACKAGE_ID } from './unicompapi-contracts';

export type UniCompApiVideoFeature = 'text_to_video' | 'image_to_video';

export type UniCompApiModelFeature =
  | 'text_chat'
  | 'text_reasoning'
  | 'text_to_image'
  | 'image_edit'
  | UniCompApiVideoFeature;

const uniCompApiModelFeatureMap = new Map<string, readonly UniCompApiModelFeature[]>([
  ['deepseek-r1-0528', ['text_chat', 'text_reasoning']],
  ['deepseek-v3', ['text_chat', 'text_reasoning']],
  ['deepseek-v3.2', ['text_chat', 'text_reasoning']],
  ['deepseek-v3.2-exp', ['text_chat', 'text_reasoning']],
  ['deepseek-v4-flash', ['text_chat', 'text_reasoning']],
  ['deepseek-v4-pro', ['text_chat', 'text_reasoning']],
  ['doubao-seedance-2-0-260128', ['text_to_video', 'image_to_video']],
  ['doubao-seedance-2-0-fast-260128', ['text_to_video', 'image_to_video']],
  ['doubao-seedream-5-0-260128', ['text_to_image']],
  ['glm-4.6', ['text_chat', 'text_reasoning']],
  ['glm-4.7', ['text_chat', 'text_reasoning']],
  ['glm-5', ['text_chat', 'text_reasoning']],
  ['glm-5.1', ['text_chat', 'text_reasoning']],
  ['glm-5.2', ['text_chat', 'text_reasoning']],
  ['gpt-5.6-luna', ['text_chat']],
  ['gpt-5.6-sol', ['text_chat']],
  ['gpt-5.6-terra', ['text_chat']],
  ['happyhorse-1.0-i2v', ['image_to_video']],
  ['happyhorse-1.0-r2v', []],
  ['happyhorse-1.0-t2v', ['text_to_video']],
  ['happyhorse-1.0-video-edit', []],
  ['happyhorse-1.1-i2v', ['image_to_video']],
  ['happyhorse-1.1-r2v', []],
  ['happyhorse-1.1-t2v', ['text_to_video']],
  ['kimi-k2.6', ['text_chat']],
  ['kling-v3-turbo', ['text_to_video', 'image_to_video']],
  ['qwen-image', ['text_to_image']],
  ['qwen-image-edit-2509', ['image_edit']],
  ['qwen3-235b-a22b', ['text_chat', 'text_reasoning']],
  ['qwen3-32b', ['text_chat', 'text_reasoning']],
  ['viduq3', ['image_to_video']],
  ['viduq3-mix', ['image_to_video']],
  ['viduq3-pro', ['text_to_video']],
  ['viduq3-turbo', ['text_to_video', 'image_to_video']]
]);

export function isUniCompApiPackage(packageId: string): boolean {
  return packageId === UNICOMPAPI_PROVIDER_PACKAGE_ID;
}

export function isUniCompApiDeepSeekModel(providerModelKey: string): boolean {
  return providerModelKey.startsWith('deepseek-') &&
    (uniCompApiModelFeatureMap.get(providerModelKey)?.includes('text_reasoning') ?? false);
}

export function uniCompApiModelFeatures(
  providerModelKey: string
): readonly UniCompApiModelFeature[] | undefined {
  return uniCompApiModelFeatureMap.get(providerModelKey);
}

export function isKnownUniCompApiModel(providerModelKey: string): boolean {
  return uniCompApiModelFeatureMap.has(providerModelKey);
}

export function uniCompApiSupportsFeature(
  packageId: string,
  providerModelKey: string,
  feature: UniCompApiModelFeature
): boolean {
  if (!isUniCompApiPackage(packageId)) return true;
  const features = uniCompApiModelFeatures(providerModelKey);
  // Preserve legacy manual-registration behavior for model keys that are not
  // part of the current UniCompAPI catalog. Exact catalog keys are closed-
  // world and only receive explicitly declared features.
  return features === undefined ? true : features.includes(feature);
}

export function uniCompApiVideoFeatures(
  providerModelKey: string
): readonly UniCompApiVideoFeature[] | undefined {
  const features = uniCompApiModelFeatures(providerModelKey);
  if (features === undefined) return undefined;
  return features.filter(
    (feature): feature is UniCompApiVideoFeature =>
      feature === 'text_to_video' || feature === 'image_to_video'
  );
}

export function isUniCompApiViduModel(providerModelKey: string): boolean {
  return ['viduq3', 'viduq3-mix', 'viduq3-pro', 'viduq3-turbo']
    .includes(providerModelKey);
}

export function uniCompApiSupportsText(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(packageId, providerModelKey, 'text_chat');
}

export function uniCompApiSupportsImage(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(packageId, providerModelKey, 'text_to_image');
}

export function uniCompApiSupportsImageEdit(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(packageId, providerModelKey, 'image_edit');
}
