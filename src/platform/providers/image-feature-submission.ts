import { randomUUID } from 'node:crypto';
import {
  createProviderOperationRecord,
  toExecutionId,
  toIsoTimestamp,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderOperationRecordId,
  toSubmissionIntentId,
  toTaskId,
  type ParameterSchemaV2,
  type ProviderConnection,
  type ProviderExecutionLifecycle,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderOperationRecord,
  type ProviderSubmitOutcome,
  type StructuredCredentialRecord,
  type Task
} from '../../domain';
import type { SecureCredentialVault } from './credential-vault';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_IMAGE_ADAPTER_ID,
  NEWAPI_IMAGE_PROTOCOL_ID,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NewApiImageAdapter,
  type NewApiImageConnectionResolverPort,
  type NewApiImageCredentialResolverPort,
  type NewApiImageDownloadPort,
  type NewApiImageParameterSchemaResolverPort,
  type NewApiImageUsageObservationSinkPort,
  type NewApiSharedRuntime
} from './newapi';
import {
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION
} from './newapi/unicompapi-contracts';
import { createImageProviderFeatureContracts } from './project-image-feature';
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
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
  VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
  VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_IMAGE_V1_ADAPTER_VERSION,
  VIDU_IMAGE_V1_PROTOCOL_ID,
  VIDU_IMAGE_V1_PROTOCOL_VERSION,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_PROVIDER_PACKAGE_VERSION,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
  VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
  ViduPackagedParameterSchemaResolver,
  type ViduProviderPackage,
  ViduRegistryExecutionRouteResolver,
  type ControlledImageMaterialPort,
  type ViduUsageObservationSinkPort
} from './vidu';

export interface ImageFeatureSubmissionRuntimes {
  readonly viduPackage: ViduProviderPackage;
  readonly newApiRuntime?: NewApiSharedRuntime;
  readonly newApiDownloads?: NewApiImageDownloadPort;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
  readonly materials: ControlledImageMaterialPort;
  readonly usage: NewApiImageUsageObservationSinkPort & ViduUsageObservationSinkPort;
}

export function createImageFeatureSubmissionIdFactory(): ProviderSubmissionOrchestrationIdFactory {
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

export function createImageFeatureDispatchBridge(
  options: ImageFeatureSubmissionRuntimes
): ProviderSubmissionDispatchBridge {
  const credentials = createRegistryCredentialResolver(
    options.providerRegistry,
    options.credentialVault
  );
  const connections = createRegistryConnectionResolver(options.providerRegistry);
  const parameterSchemas = createImageParameterSchemaResolver();
  const routes = new ViduRegistryExecutionRouteResolver(options.providerRegistry);
  const viduSchemas = new ViduPackagedParameterSchemaResolver();
  const viduAdapters = options.viduPackage.createRouteAdapters({
    routes,
    parameterSchemas: viduSchemas,
    materials: options.materials,
    usage: options.usage
  });

  const adapters: ProviderSubmissionAdapterPort[] = [
    wrapMediaAdapter({
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
      adapterKey: VIDU_IMAGE_V1_ADAPTER_ID,
      adapterVersion: VIDU_IMAGE_V1_ADAPTER_VERSION,
      protocolId: VIDU_IMAGE_V1_PROTOCOL_ID,
      protocolVersion: VIDU_IMAGE_V1_PROTOCOL_VERSION,
      submit: (input) => viduAdapters.imageV1.submit(input.routeSnapshot, {
        request: input.request,
        beforeRequestStarted: input.beforeRequestStarted
      })
    }),
    wrapMediaAdapter({
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
      adapterKey: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      adapterVersion: VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
      protocolId: VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
      submit: (input) => viduAdapters.geminiImageV2.submit(input.routeSnapshot, {
        request: input.request,
        beforeRequestStarted: input.beforeRequestStarted
      })
    }),
    wrapMediaAdapter({
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
      adapterKey: VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
      submit: (input) =>
        viduAdapters.referenceImageV2.submit(input.routeSnapshot, {
          request: input.request,
          beforeRequestStarted: input.beforeRequestStarted
        })
    })
  ];

  if (options.newApiRuntime && options.newApiDownloads) {
    const newApiAdapter = new NewApiImageAdapter(
      options.newApiRuntime,
      connections,
      credentials,
      parameterSchemas,
      options.usage,
      options.newApiDownloads,
      undefined,
      undefined,
      options.materials
    );
    adapters.push(
      wrapMediaAdapter({
        packageId: NEWAPI_PROVIDER_PACKAGE_ID,
        packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
        acceptedPackages: [{
          packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
          packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION
        }],
        adapterKey: NEWAPI_IMAGE_ADAPTER_ID,
        adapterVersion: NEWAPI_ADAPTER_VERSION,
        protocolId: NEWAPI_IMAGE_PROTOCOL_ID,
        protocolVersion: NEWAPI_PROTOCOL_VERSION,
        submit: (input) => newApiAdapter.submit(input)
      })
    );
  }

  return new ProviderSubmissionDispatchBridge(options.providerPackages, adapters);
}

export function buildImageProviderOperationRecord(input: {
  readonly task: Task;
  readonly executionId: string;
  readonly outcome: ProviderSubmitOutcome;
  readonly executionLifecycle: ProviderExecutionLifecycle;
  readonly now?: string;
}): ProviderOperationRecord {
  const now = toIsoTimestamp(input.now ?? new Date().toISOString());
  return createProviderOperationRecord({
    id: toProviderOperationRecordId(`provider-operation-record-${randomUUID()}`),
    taskId: input.task.id,
    executionId: toExecutionId(input.executionId),
    mediaKind: 'image',
    executionLifecycle: input.executionLifecycle,
    outcome: input.outcome,
    createdAt: now,
    updatedAt: now
  });
}

export function extractImageResultUrls(outcome: ProviderSubmitOutcome): readonly string[] {
  if (outcome.kind !== 'completed_sync') return [];
  return outcome.results
    .filter(
      (result) =>
        result.kind === 'remote_url' ||
        result.kind === 'file_uri'
    )
    .map((result) => result.value);
}

function wrapMediaAdapter(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly acceptedPackages?: ProviderSubmissionAdapterPort['acceptedPackages'];
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
    ...(input.acceptedPackages ? { acceptedPackages: input.acceptedPackages } : {}),
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
          mediaKind: 'image',
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

function createRegistryCredentialResolver(
  registry: JsonProviderRegistryStore,
  vault: SecureCredentialVault
): NewApiImageCredentialResolverPort {
  return {
    async useCredential<T>(
      input: {
        readonly connectionId: string;
        readonly credentialVersionId: string;
      },
      operation: (credential: StructuredCredentialRecord) => Promise<T>
    ): Promise<T> {
      const snapshot = await registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === input.connectionId
      );
      if (
        !connection?.credentialReference ||
        connection.credentialVersionId !== input.credentialVersionId
      ) {
        throw new Error('Provider credential is unavailable for the selected route');
      }
      return vault.useRecord(connection.credentialReference, operation);
    }
  };
}

function createRegistryConnectionResolver(
  registry: JsonProviderRegistryStore
): NewApiImageConnectionResolverPort {
  return {
    async get(connectionId: string): Promise<ProviderConnection | undefined> {
      const snapshot = await registry.load();
      return snapshot.connections.find((item) => item.id === connectionId);
    }
  };
}

function createImageParameterSchemaResolver(): NewApiImageParameterSchemaResolverPort {
  const schemas = createImageProviderFeatureContracts().map(
    (contract) => contract.parameterSchema
  );
  return {
    async get(
      schemaId: string,
      revision: number
    ): Promise<ParameterSchemaV2 | undefined> {
      return schemas.find(
        (schema) => schema.schemaId === schemaId && schema.revision === revision
      );
    }
  };
}
