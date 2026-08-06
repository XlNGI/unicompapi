import { randomUUID } from 'node:crypto';
import {
  createProviderOperationRecord,
  toExecutionId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderOperationRecordId,
  toSubmissionIntentId,
  toTaskId,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderSubmitOutcome
} from '../../domain';
import type { SecureCredentialVault } from './credential-vault';
import type { JsonProviderRegistryStore } from './provider-registry';
import type { ProviderPackageRegistry } from './provider-package-registry';
import {
  ProviderSubmissionDispatchBridge,
  normalizeProviderSubmitOutcome,
  type ProviderSubmissionAdapterPort
} from './provider-submission-dispatch-bridge';
import type {
  ProviderSubmissionOrchestrationIdFactory,
  SubmissionDispatchOutcome
} from './provider-submission-orchestrator';
import {
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_PROVIDER_PACKAGE_VERSION,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
  ViduPackagedParameterSchemaResolver,
  ViduProviderPackage,
  ViduRegistryExecutionRouteResolver,
  type ControlledImageMaterialPort,
  type ViduUsageObservationSinkPort
} from './vidu';

const noopUsage: ViduUsageObservationSinkPort = {
  async append() {
    return;
  }
};

export interface VideoFeatureSubmissionRuntimes {
  readonly viduPackage: ViduProviderPackage;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
  readonly materials: ControlledImageMaterialPort;
}

export function createVideoFeatureSubmissionIdFactory(): ProviderSubmissionOrchestrationIdFactory {
  return {
    nextSubmissionIntentId: () => toSubmissionIntentId(`intent-${randomUUID()}`),
    nextRouteSnapshotId: () =>
      toProviderExecutionRouteSnapshotId(`route-${randomUUID()}`),
    nextProviderInvocationAttemptId: () =>
      toProviderInvocationAttemptId(`attempt-${randomUUID()}`),
    nextProviderInvocationEventId: () =>
      toProviderInvocationEventId(`invocation-event-${randomUUID()}`),
    nextAuthorizationClaimId: () => `claim-${randomUUID()}`,
    nextJournalEventId: () => `journal-event-${randomUUID()}`
  };
}

export function createVideoFeatureDispatchBridge(
  options: VideoFeatureSubmissionRuntimes
): ProviderSubmissionDispatchBridge {
  void options.credentialVault;
  const routes = new ViduRegistryExecutionRouteResolver(options.providerRegistry);
  const viduSchemas = new ViduPackagedParameterSchemaResolver();
  const viduAdapters = options.viduPackage.createRouteAdapters({
    routes,
    parameterSchemas: viduSchemas,
    materials: options.materials,
    usage: noopUsage
  });

  const adapters: ProviderSubmissionAdapterPort[] = [
    wrapVideoAdapter({
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
      adapterKey: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
      submit: (input) => viduAdapters.referenceVideoV2.submit(input.routeSnapshot, {
        request: input.request,
        beforeRequestStarted: input.beforeRequestStarted
      })
    })
  ];

  return new ProviderSubmissionDispatchBridge(options.providerPackages, adapters);
}

export function extractVideoResultUrls(outcome: ProviderSubmitOutcome): readonly string[] {
  if (outcome.kind !== 'completed_sync') return [];
  return outcome.results
    .filter(
      (result) =>
        result.kind === 'remote_url' ||
        result.kind === 'file_uri'
    )
    .map((result) => result.value);
}

function wrapVideoAdapter(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  submit(input: {
    readonly routeSnapshot: ProviderExecutionRouteSnapshotV1;
    readonly request: unknown;
    readonly beforeRequestStarted: () => Promise<void>;
  }): Promise<ProviderSubmitOutcome>;
}): ProviderSubmissionAdapterPort {
  return {
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    protocolId: input.protocolId,
    protocolVersion: input.protocolVersion,
    async submit(request): Promise<SubmissionDispatchOutcome> {
      try {
        const outcome = await input.submit({
          routeSnapshot: request.routeSnapshot,
          request: request.request,
          beforeRequestStarted: request.beforeRequestStarted
        });
        if (
          outcome.kind !== 'accepted_async' &&
          outcome.kind !== 'completed_sync'
        ) {
          return normalizeProviderSubmitOutcome(outcome);
        }
        const identities = mediaIdentities(request.request);
        if (!identities) {
          return normalizeProviderSubmitOutcome(outcome);
        }
        const providerOperationRecord = createProviderOperationRecord({
          id: toProviderOperationRecordId(`provider-operation-record-${randomUUID()}`),
          taskId: toTaskId(identities.taskId),
          executionId: toExecutionId(identities.executionId),
          mediaKind: 'video',
          executionLifecycle: outcome.kind === 'accepted_async'
            ? 'asynchronous_polling'
            : 'synchronous_completed',
          outcome,
          createdAt: request.routeSnapshot.createdAt,
          updatedAt: request.routeSnapshot.createdAt
        });
        return normalizeProviderSubmitOutcome(outcome, providerOperationRecord);
      } catch (error) {
        return {
          kind: 'failed_before_submission',
          safeCode: dispatchFailureSafeCode(input.adapterKey, error)
        };
      }
    }
  };
}

function mediaIdentities(request: unknown): {
  readonly taskId: string;
  readonly executionId: string;
} | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return undefined;
  }
  const item = request as Record<string, unknown>;
  if (
    typeof item.taskId !== 'string' ||
    item.taskId.trim().length === 0 ||
    typeof item.executionId !== 'string' ||
    item.executionId.trim().length === 0
  ) {
    return undefined;
  }
  return { taskId: item.taskId, executionId: item.executionId };
}

function dispatchFailureSafeCode(adapterKey: string, error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'safeCode' in error &&
    typeof (error as { safeCode: unknown }).safeCode === 'string'
  ) {
    return (error as { safeCode: string }).safeCode;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return `${adapterKey}.${(error as { code: string }).code}`;
  }
  return `${adapterKey}.failed_before_submission`;
}
