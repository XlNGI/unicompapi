import { describe, expect, it, vi } from 'vitest';
import {
  createProviderExecutionRouteSnapshot,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toUsageSchemaId,
  type ProductFeature,
  type ProviderPackageDescriptor,
  type ProviderSubmitOutcome
} from '../../src/domain';
import {
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DOUBAO_VISION_ADAPTER_ID,
  KLING_PROVIDER_PACKAGE_ID,
  KLING_VIDEO_ADAPTER_ID,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_IMAGE_ADAPTER_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_VIDEO_ADAPTER_ID,
  ProviderPackageRegistry,
  ProviderSubmissionDispatchBridge,
  SEEDANCE_VIDEO_ADAPTER_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  deepSeekProviderPackageDescriptor,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  normalizeProviderSubmitOutcome,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor,
  type ProviderSubmissionAdapterPort
} from '../../src/platform';

const packages = [
  deepSeekProviderPackageDescriptor,
  volcengineProviderPackageDescriptor,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  viduProviderPackageDescriptor
] as const;

describe('provider submission dispatch bridge', () => {
  it('registers every phase-9 adapter by exact package and version with zero real transport', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const calls: string[] = [];
    const ports = packages.flatMap((providerPackage) =>
      providerPackage.adapters
        .filter((adapter) => adapter.operations.includes('submit'))
        .map((adapter) => port(providerPackage, adapter, calls))
    );
    const bridge = new ProviderSubmissionDispatchBridge(
      new ProviderPackageRegistry(packages),
      ports
    );

    for (const registered of ports) {
      let requestStarted = 0;
      const outcome = await bridge.submit({
        routeSnapshot: route(registered),
        request: { synthetic: true },
        async beforeRequestStarted() {
          requestStarted += 1;
        }
      });
      expect(outcome).toMatchObject({
        providerOperationId: `operation-${registered.adapterKey}`
      });
      expect(requestStarted).toBe(1);
    }

    expect(new Set(calls)).toEqual(new Set(ports.map((item) =>
      `${item.packageId}:${item.adapterKey}@${item.adapterVersion}`
    )));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects stale package and adapter versions before dispatch and never falls back', async () => {
    let dispatchCount = 0;
    const descriptor = deepSeekProviderPackageDescriptor.adapters[0];
    const registered = port(
      deepSeekProviderPackageDescriptor,
      descriptor,
      [],
      () => { dispatchCount += 1; }
    );
    const bridge = new ProviderSubmissionDispatchBridge(
      new ProviderPackageRegistry([deepSeekProviderPackageDescriptor]),
      [registered]
    );

    await expect(bridge.submit({
      routeSnapshot: {
        ...route(registered),
        packageId: NEWAPI_PROVIDER_PACKAGE_ID
      },
      request: {},
      async beforeRequestStarted() {}
    })).rejects.toThrow('package binding is stale');
    await expect(bridge.submit({
      routeSnapshot: {
        ...route(registered),
        adapterVersion: '2099-01-01'
      },
      request: {},
      async beforeRequestStarted() {}
    })).rejects.toMatchObject({ code: 'adapter_version_unavailable' });
    expect(dispatchCount).toBe(0);
  });

  it('maps provider outcomes to stable safe orchestration facts', () => {
    expect(normalizeProviderSubmitOutcome({
      kind: 'submission_outcome_unknown',
      message: 'sensitive upstream body with https://signed.example/result',
      providerOperationId: 'operation-safe'
    })).toEqual({
      kind: 'unknown_outcome',
      providerOperationId: 'operation-safe',
      safeCode: 'adapter.submission_outcome_unknown'
    });
    expect(normalizeProviderSubmitOutcome({
      kind: 'failed_before_submission',
      message: 'credential abc must not escape',
      retryability: 'not_retryable'
    })).toEqual({
      kind: 'failed_before_submission',
      safeCode: 'adapter.failed_before_submission'
    });
  });
});

function port(
  providerPackage: ProviderPackageDescriptor,
  adapter: ProviderPackageDescriptor['adapters'][number],
  calls: string[],
  beforeCall: () => void = () => undefined
): ProviderSubmissionAdapterPort {
  return {
    packageId: providerPackage.packageId,
    packageVersion: providerPackage.packageVersion,
    adapterKey: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    protocolId: adapter.protocolId,
    protocolVersion: adapter.protocolVersion,
    async submit(input) {
      beforeCall();
      calls.push(
        `${providerPackage.packageId}:${adapter.adapterId}@${adapter.adapterVersion}`
      );
      await input.beforeRequestStarted();
      return normalizeProviderSubmitOutcome(providerOutcome(adapter.adapterId));
    }
  };
}

function providerOutcome(adapterId: string): ProviderSubmitOutcome {
  const asyncAdapters = new Set([
    SEEDANCE_VIDEO_ADAPTER_ID,
    VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
    KLING_VIDEO_ADAPTER_ID,
    NEWAPI_VIDEO_ADAPTER_ID
  ]);
  if (asyncAdapters.has(adapterId)) {
    return {
      kind: 'accepted_async',
      providerOperationId: `operation-${adapterId}`,
      state: 'queued'
    };
  }
  return {
    kind: 'completed_sync',
    providerOperationId: `operation-${adapterId}`,
    results: []
  };
}

function route(port: ProviderSubmissionAdapterPort) {
  const feature = productFeature(port.adapterKey);
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(
      `route-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`
    ),
    projectId: toProjectId('project-dispatch-bridge'),
    packageId: port.packageId,
    packageVersion: port.packageVersion,
    adapterKey: port.adapterKey,
    adapterVersion: port.adapterVersion,
    providerId: toProviderId(`provider-${packageSuffix(port.packageId)}`),
    connectionId: toConnectionId(`connection-${packageSuffix(port.packageId)}`),
    connectionRevision: 1,
    connectionConfigVersionId: `connection-config-${packageSuffix(port.packageId)}`,
    endpointPolicyId: `endpoint-policy-${packageSuffix(port.packageId)}`,
    endpointPolicyRevision: 1,
    credentialVersionId: `credential-version-${packageSuffix(port.packageId)}`,
    modelId: toModelId(`model-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`),
    providerModelKey: `model-key-${port.adapterKey}`,
    modelRevision: 1,
    profileId: `profile-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId(
      `binding-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`
    ),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: internalPurpose(feature),
    featureMappingVersion: 1,
    parameterSchemaId: `parameters-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`,
    parameterSchemaRevision: 1,
    resultSchemaId: `results-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(
      `usage-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`
    ),
    usageSchemaRevision: 1,
    constraintSetId: `constraints-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`,
    constraintSetRevision: 1,
    runtimePolicyId: `policy-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`,
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: `claim-${port.adapterKey.replace(/[^a-z0-9]/gi, '-')}`,
    createdAt: toIsoTimestamp('2026-08-03T18:00:00.000Z')
  });
}

function productFeature(adapterId: string): ProductFeature {
  if (
    adapterId === VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID ||
    adapterId === NEWAPI_VIDEO_ADAPTER_ID
  ) return 'image_to_video';
  if (adapterId === SEEDANCE_VIDEO_ADAPTER_ID || adapterId === KLING_VIDEO_ADAPTER_ID) {
    return 'text_to_video';
  }
  if (adapterId === DOUBAO_VISION_ADAPTER_ID) return 'image_understanding';
  if (adapterId === VIDU_GEMINI_IMAGE_V2_ADAPTER_ID) return 'reference_to_image';
  if (
    adapterId === VIDU_IMAGE_V1_ADAPTER_ID ||
    adapterId === NEWAPI_IMAGE_ADAPTER_ID
  ) return 'text_to_image';
  if (adapterId === NEWAPI_CHAT_ADAPTER_ID) return 'text_chat';
  return 'text_chat';
}

function internalPurpose(feature: ProductFeature): string {
  if (feature === 'text_chat') return 'text_execution';
  if (feature === 'text_to_video') return 'video_generation';
  if (feature === 'image_to_video') return 'reference_to_video';
  if (feature === 'image_understanding') return 'image_understanding';
  if (feature === 'reference_to_image') return 'reference_to_image';
  return 'image_generation';
}

function packageSuffix(packageId: string): string {
  if (packageId === DEEPSEEK_PROVIDER_PACKAGE_ID) {
    return 'deepseek';
  }
  if (packageId === VOLCENGINE_PROVIDER_PACKAGE_ID) {
    return 'volcengine';
  }
  if (packageId === KLING_PROVIDER_PACKAGE_ID) {
    return 'kling';
  }
  if (packageId === NEWAPI_PROVIDER_PACKAGE_ID) {
    return 'newapi';
  }
  if (packageId === VIDU_PROVIDER_PACKAGE_ID) {
    return 'vidu';
  }
  return 'unknown';
}
