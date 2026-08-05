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
  /**
   * Optional additional package bindings that share the same adapter identity
   * (e.g. NewAPI and UniCompAPI both use `newapi.chat`).
   */
  readonly acceptedPackages?: readonly {
    readonly packageId: string;
    readonly packageVersion: string;
  }[];
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
      for (const binding of packageBindings(adapter)) {
        packages.resolveAdapter(
          binding.packageId,
          adapter.adapterKey,
          adapter.adapterVersion,
          adapter.protocolId,
          adapter.protocolVersion
        );
      }
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
      safeCode: safeCodeForFailedBeforeSubmission(outcome.message)
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

function safeCodeForFailedBeforeSubmission(message: string): string {
  if (message === 'The Vidu credential is unavailable') {
    return 'vidu.credential_unavailable';
  }
  if (message === 'Vidu credits are insufficient') {
    return 'vidu.credit_insufficient';
  }
  if (message === 'The Vidu request is invalid') {
    return 'vidu.invalid_request';
  }
  if (message === 'The Vidu protocol binding does not match the request') {
    return 'vidu.protocol_mismatch';
  }
  if (message === 'The Vidu endpoint is not allowed') {
    return 'vidu.endpoint_not_allowed';
  }
  if (message === 'Vidu authentication failed') {
    return 'vidu.authentication_failed';
  }
  if (message === 'Vidu denied this operation') {
    return 'vidu.permission_denied';
  }
  return 'adapter.failed_before_submission';
}

function packageBindings(
  adapter: ProviderSubmissionAdapterPort
): readonly { readonly packageId: string; readonly packageVersion: string }[] {
  const primary = {
    packageId: adapter.packageId,
    packageVersion: adapter.packageVersion
  };
  const extras = adapter.acceptedPackages ?? [];
  const seen = new Set<string>();
  const bindings = [];
  for (const binding of [primary, ...extras]) {
    const key = `${binding.packageId}@${binding.packageVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(binding);
  }
  return bindings;
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
  const bindings = packageBindings(adapter);
  return {
    adapterKey: adapter.adapterKey,
    adapterVersion: adapter.adapterVersion,
    operations: ['submit'],
    submit(routeSnapshot, request, beforeRequestStarted) {
      if (
        !bindings.some(
          (binding) =>
            binding.packageId === routeSnapshot.packageId &&
            binding.packageVersion === routeSnapshot.packageVersion
        )
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
