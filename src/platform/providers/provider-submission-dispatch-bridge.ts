import type {
  ProviderExecutionRouteSnapshotV1,
  ProviderOperationRecord,
  ProviderSubmitOutcome
} from '../../domain';
import {
  ProviderExecutionRouteDispatcher,
  type ProviderExecutionRouteAdapter
} from './provider-execution-route-dispatcher';
import type { ProviderPackageRegistry } from './provider-package-registry';
import type {
  SubmissionDispatchOutcome,
  SubmissionDispatchPort
} from './provider-submission-orchestrator';

export interface ProviderSubmissionAdapterPort {
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
  }): Promise<SubmissionDispatchOutcome>;
}

export class ProviderSubmissionDispatchBridge implements SubmissionDispatchPort {
  private readonly dispatcher: ProviderExecutionRouteDispatcher<
    unknown,
    SubmissionDispatchOutcome,
    never,
    never,
    never,
    never
  >;

  constructor(
    packages: ProviderPackageRegistry,
    adapters: readonly ProviderSubmissionAdapterPort[]
  ) {
    for (const adapter of adapters) {
      packages.resolveAdapter(
        adapter.packageId,
        adapter.adapterKey,
        adapter.adapterVersion,
        adapter.protocolId,
        adapter.protocolVersion
      );
    }
    this.dispatcher = new ProviderExecutionRouteDispatcher(adapters.map(toRouteAdapter));
  }

  submit(input: {
    readonly routeSnapshot: ProviderExecutionRouteSnapshotV1;
    readonly request: unknown;
    readonly beforeRequestStarted: () => Promise<void>;
  }): Promise<SubmissionDispatchOutcome> {
    return this.dispatcher.submit(
      input.routeSnapshot,
      input.request,
      input.beforeRequestStarted
    );
  }
}

export function normalizeProviderSubmitOutcome(
  outcome: ProviderSubmitOutcome,
  providerOperationRecord?: ProviderOperationRecord
): SubmissionDispatchOutcome {
  if (outcome.kind === 'failed_before_submission') {
    return {
      kind: 'failed_before_submission',
      safeCode: 'adapter.failed_before_submission'
    };
  }
  if (outcome.kind === 'submission_outcome_unknown') {
    return {
      kind: 'unknown_outcome',
      ...(outcome.providerOperationId
        ? { providerOperationId: outcome.providerOperationId }
        : {}),
      safeCode: 'adapter.submission_outcome_unknown'
    };
  }
  return {
    kind: outcome.kind,
    providerOperationId: outcome.providerOperationId,
    ...(providerOperationRecord ? { providerOperationRecord } : {})
  };
}

function toRouteAdapter(
  adapter: ProviderSubmissionAdapterPort
): ProviderExecutionRouteAdapter<
  unknown,
  SubmissionDispatchOutcome,
  never,
  never,
  never,
  never
> {
  return {
    adapterKey: adapter.adapterKey,
    adapterVersion: adapter.adapterVersion,
    operations: ['submit'],
    submit(routeSnapshot, request, beforeRequestStarted) {
      if (
        routeSnapshot.packageId !== adapter.packageId ||
        routeSnapshot.packageVersion !== adapter.packageVersion
      ) {
        throw new TypeError('Provider submission package binding is stale');
      }
      if (!beforeRequestStarted) {
        throw new TypeError('Provider submission request-start hook is required');
      }
      return adapter.submit({ routeSnapshot, request, beforeRequestStarted });
    }
  };
}
