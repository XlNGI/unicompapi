import type { ProviderExecutionRouteSnapshotV1 } from '../../domain';
import type { StorageCallOfficialPricingRuleDto } from '../../shared/storage-ipc';
import { KLING_PROVIDER_PACKAGE_ID } from './kling/kling-contracts';
import { VIDU_PROVIDER_PACKAGE_ID } from './vidu/vidu-contracts';

const sourceCheckedAt = '2026-08-28';

export function resolveOfficialPricingRule(
  route: ProviderExecutionRouteSnapshotV1
): StorageCallOfficialPricingRuleDto | undefined {
  if (route.packageId === VIDU_PROVIDER_PACKAGE_ID) {
    return {
      strategy: 'credit',
      currencyCode: 'USD',
      sourceTitle: 'Vidu API pricing',
      sourceUrl: 'https://platform.vidu.com/docs/pricing',
      sourceCheckedAt,
      rates: [{
        metricId: 'credit_amount',
        amount: '0.005',
        unit: 'credit',
        label: 'credit'
      }]
    };
  }

  if (
    route.packageId === KLING_PROVIDER_PACKAGE_ID &&
    ['text_to_video', 'image_to_video'].includes(route.productFeature)
  ) {
    return {
      strategy: 'provider_billing',
      currencyCode: 'USD',
      sourceTitle: 'KlingAI Open Platform video pricing',
      sourceUrl: 'https://app.klingai.com/global/dev/document-api/pricing/base/video',
      sourceCheckedAt,
      rates: [{
        metricId: 'package_unit_amount',
        amount: '0.14',
        unit: 'provider_unit',
        label: 'video unit'
      }]
    };
  }

  return undefined;
}
