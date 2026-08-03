import {
  parseProviderExecutionRouteSnapshot,
  type ProviderAdapterOperation,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderInvocationAttemptId
} from '../../domain';

export interface ProviderExecutionRouteAdapter<
  TSubmitRequest,
  TSubmitResult,
  TQueryResult,
  TCancelResult,
  TResultReference,
  TReceiveResult
> {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly operations: readonly Extract<
    ProviderAdapterOperation,
    'submit' | 'query' | 'cancel' | 'receive_result'
  >[];
  submit?(
    route: ProviderExecutionRouteSnapshotV1,
    request: TSubmitRequest,
    beforeRequestStarted?: () => Promise<void>
  ): Promise<TSubmitResult>;
  attachOperation?(input: {
    readonly routeSnapshot: ProviderExecutionRouteSnapshotV1;
    readonly providerOperationId: string;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
  }): Promise<void>;
  query?(
    route: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string
  ): Promise<TQueryResult>;
  cancel?(
    route: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string
  ): Promise<TCancelResult>;
  receiveResult?(
    route: ProviderExecutionRouteSnapshotV1,
    resultReference: TResultReference
  ): Promise<TReceiveResult>;
}

export type ProviderExecutionRouteDispatchErrorCode =
  | 'adapter_unavailable'
  | 'adapter_version_unavailable'
  | 'operation_unsupported'
  | 'adapter_contract_invalid';

export class ProviderExecutionRouteDispatchError extends Error {
  constructor(
    readonly code: ProviderExecutionRouteDispatchErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProviderExecutionRouteDispatchError';
  }
}

export class ProviderExecutionRouteDispatcher<
  TSubmitRequest,
  TSubmitResult,
  TQueryResult,
  TCancelResult,
  TResultReference,
  TReceiveResult
> {
  private readonly adapters: ReadonlyMap<string, ProviderExecutionRouteAdapter<
    TSubmitRequest,
    TSubmitResult,
    TQueryResult,
    TCancelResult,
    TResultReference,
    TReceiveResult
  >>;

  constructor(adapters: readonly ProviderExecutionRouteAdapter<
    TSubmitRequest,
    TSubmitResult,
    TQueryResult,
    TCancelResult,
    TResultReference,
    TReceiveResult
  >[]) {
    const entries = adapters.map((adapter) => {
      validateAdapter(adapter);
      return [adapterIdentity(adapter.adapterKey, adapter.adapterVersion), adapter] as const;
    });
    if (new Set(entries.map(([identity]) => identity)).size !== entries.length) {
      throw new ProviderExecutionRouteDispatchError(
        'adapter_contract_invalid',
        'Provider execution adapter identities must be unique'
      );
    }
    this.adapters = new Map(entries);
  }

  async submit(
    route: ProviderExecutionRouteSnapshotV1,
    request: TSubmitRequest,
    beforeRequestStarted?: () => Promise<void>
  ): Promise<TSubmitResult> {
    const { snapshot, adapter } = this.resolve(route, 'submit');
    if (!adapter.submit) throw invalidOperationContract('submit');
    return adapter.submit(snapshot, request, beforeRequestStarted);
  }

  async attachOperation(
    route: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string,
    invocationAttemptId: ProviderInvocationAttemptId
  ): Promise<void> {
    const { snapshot, adapter } = this.resolve(route);
    if (!adapter.attachOperation) return;
    await adapter.attachOperation({
      routeSnapshot: snapshot,
      providerOperationId: opaqueRemoteId(providerOperationId),
      invocationAttemptId
    });
  }

  async query(
    route: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string
  ): Promise<TQueryResult> {
    const { snapshot, adapter } = this.resolve(route, 'query');
    if (!adapter.query) throw invalidOperationContract('query');
    return adapter.query(snapshot, opaqueRemoteId(providerOperationId));
  }

  async cancel(
    route: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string
  ): Promise<TCancelResult> {
    const { snapshot, adapter } = this.resolve(route, 'cancel');
    if (!adapter.cancel) throw invalidOperationContract('cancel');
    return adapter.cancel(snapshot, opaqueRemoteId(providerOperationId));
  }

  async receiveResult(
    route: ProviderExecutionRouteSnapshotV1,
    resultReference: TResultReference
  ): Promise<TReceiveResult> {
    const { snapshot, adapter } = this.resolve(route, 'receive_result');
    if (!adapter.receiveResult) throw invalidOperationContract('receive_result');
    return adapter.receiveResult(snapshot, resultReference);
  }

  private resolve(
    route: ProviderExecutionRouteSnapshotV1,
    operation?: Extract<ProviderAdapterOperation, 'submit' | 'query' | 'cancel' | 'receive_result'>
  ) {
    const snapshot = parseProviderExecutionRouteSnapshot(route);
    const exact = this.adapters.get(
      adapterIdentity(snapshot.adapterKey, snapshot.adapterVersion)
    );
    if (!exact) {
      const sameKey = [...this.adapters.values()].some(
        (adapter) => adapter.adapterKey === snapshot.adapterKey
      );
      throw new ProviderExecutionRouteDispatchError(
        sameKey ? 'adapter_version_unavailable' : 'adapter_unavailable',
        sameKey
          ? 'The adapter version captured by the route snapshot is unavailable'
          : 'The adapter captured by the route snapshot is unavailable'
      );
    }
    if (operation && !exact.operations.includes(operation)) {
      throw new ProviderExecutionRouteDispatchError(
        'operation_unsupported',
        `The route adapter does not support ${operation}`
      );
    }
    return { snapshot, adapter: exact };
  }
}

function validateAdapter(adapter: ProviderExecutionRouteAdapter<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>): void {
  if (
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(adapter.adapterKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(adapter.adapterVersion) ||
    adapter.operations.length === 0 ||
    new Set(adapter.operations).size !== adapter.operations.length ||
    adapter.operations.some(
      (operation) =>
        !['submit', 'query', 'cancel', 'receive_result'].includes(operation)
    )
  ) {
    throw new ProviderExecutionRouteDispatchError(
      'adapter_contract_invalid',
      'Provider execution adapter descriptor is invalid'
    );
  }
}

function invalidOperationContract(operation: string): ProviderExecutionRouteDispatchError {
  return new ProviderExecutionRouteDispatchError(
    'adapter_contract_invalid',
    `Provider execution adapter is missing its ${operation} method`
  );
}

function adapterIdentity(adapterKey: string, adapterVersion: string): string {
  return `${adapterKey}\u0000${adapterVersion}`;
}

function opaqueRemoteId(value: string): string {
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ProviderExecutionRouteDispatchError(
      'adapter_contract_invalid',
      'Provider operation ID is invalid'
    );
  }
  return result;
}
