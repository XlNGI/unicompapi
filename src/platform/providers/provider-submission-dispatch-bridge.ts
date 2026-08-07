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
      safeCode: safeCodeForProviderMessage(
        outcome.message,
        'adapter.failed_before_submission'
      )
    };
  }
  if (outcome.kind === 'submission_outcome_unknown') {
    return {
      kind: 'unknown_outcome',
      ...(outcome.providerOperationId
        ? { providerOperationId: outcome.providerOperationId }
        : {}),
      safeCode: safeCodeForProviderMessage(
        outcome.message,
        'adapter.submission_outcome_unknown'
      )
    };
  }
  return {
    kind: outcome.kind,
    providerOperationId: outcome.providerOperationId,
    ...(providerOperationRecord ? { providerOperationRecord } : {})
  };
}

/** Exact allowlisted provider messages only — never echo free-form upstream text. */
export function safeCodeForProviderMessage(
  message: string,
  fallback: string
): string {
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
  if (message === 'Vidu rate limited the operation') {
    return 'vidu.rate_limited';
  }
  if (message === 'Vidu is temporarily unavailable') {
    return 'vidu.provider_unavailable';
  }
  if (message === 'The Vidu request timed out') {
    return 'vidu.timeout';
  }
  if (message === 'The Vidu request was cancelled') {
    return 'vidu.cancelled';
  }
  if (message === 'The Vidu response exceeded the allowed size') {
    return 'vidu.response_too_large';
  }
  if (message === 'The Vidu API response redirected unexpectedly') {
    return 'vidu.redirect_not_allowed';
  }
  if (message === 'The Vidu response was invalid') {
    return 'vidu.invalid_response';
  }
  if (message === 'The Vidu network request failed') {
    return 'vidu.network_error';
  }
  if (message === 'The configured proxy could not be used') {
    return 'vidu.proxy_unavailable';
  }
  if (message === 'The Vidu runtime is shutting down') {
    return 'vidu.runtime_shutting_down';
  }
  if (message === 'The synchronous Vidu submission outcome is unknown') {
    return 'adapter.submission_outcome_unknown';
  }
  if (message === 'The NewAPI request is invalid') {
    return 'newapi.invalid_request';
  }
  if (message === 'The NewAPI protocol binding does not match the request') {
    return 'newapi.protocol_mismatch';
  }
  if (message === 'The NewAPI endpoint is not allowed') {
    return 'newapi.endpoint_not_allowed';
  }
  if (message === 'The NewAPI credential is unavailable') {
    return 'newapi.credential_unavailable';
  }
  if (message === 'NewAPI authentication failed') {
    return 'newapi.authentication_failed';
  }
  if (message === 'NewAPI denied the request') {
    return 'newapi.permission_denied';
  }
  if (message === 'The NewAPI account balance is insufficient') {
    return 'newapi.insufficient_balance';
  }
  if (message === 'The NewAPI model was not found') {
    return 'newapi.model_not_found';
  }
  if (message === 'The NewAPI operation was not found') {
    return 'newapi.operation_not_found';
  }
  if (message === 'NewAPI rejected the request parameters') {
    return 'newapi.invalid_parameters';
  }
  if (message === 'NewAPI rate limited the request') {
    return 'newapi.rate_limited';
  }
  if (message === 'NewAPI is temporarily unavailable') {
    return 'newapi.provider_unavailable';
  }
  if (message === 'The NewAPI request timed out') {
    return 'newapi.timeout';
  }
  if (message === 'The NewAPI request was cancelled') {
    return 'newapi.cancelled';
  }
  if (message === 'The NewAPI request exceeded the allowed size') {
    return 'newapi.request_too_large';
  }
  if (message === 'The NewAPI response exceeded the allowed size') {
    return 'newapi.response_too_large';
  }
  if (message === 'The NewAPI response redirected unexpectedly') {
    return 'newapi.redirect_not_allowed';
  }
  if (message === 'The NewAPI response was invalid') {
    return 'newapi.invalid_response';
  }
  if (message === 'The NewAPI network request failed') {
    return 'newapi.network_error';
  }
  if (message === 'The NewAPI runtime is shutting down') {
    return 'newapi.runtime_shutting_down';
  }
  if (message === 'The NewAPI image submission outcome is unknown') {
    return 'adapter.submission_outcome_unknown';
  }
  if (message === 'The NewApi video submission outcome is unknown') {
    return 'adapter.submission_outcome_unknown';
  }
  if (message === 'The controlled project is unavailable') {
    return 'newapi.project_unavailable';
  }
  if (message === 'The selected image material is unavailable') {
    return 'newapi.material_not_found';
  }
  if (message === 'The selected image material changed after confirmation') {
    return 'newapi.material_changed';
  }
  if (message === 'The selected image material is invalid') {
    return 'newapi.material_invalid';
  }
  if (message === 'The selected image material exceeds the allowed size') {
    return 'newapi.material_too_large';
  }
  return fallback;
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
