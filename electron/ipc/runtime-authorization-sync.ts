import type { RuntimeAccessPolicy } from '../../src/domain';
import type {
  RuntimeAuthorizationLedger,
  ProviderRuntimeAuthorizationSyncPort
} from '../../src/platform';

export const connectionRuntimePolicyId = (connectionId: string): string =>
  `policy.connection.${connectionId}`;

export class LedgerRuntimeAuthorizationSync
  implements ProviderRuntimeAuthorizationSyncPort {

  constructor(private readonly ledger: RuntimeAuthorizationLedger) {}

  async syncConnectionPolicy(input: {
    readonly providerPackageId: string;
    readonly connectionId: string;
    readonly allowed: boolean;
  }): Promise<void> {
    const policyId = connectionRuntimePolicyId(input.connectionId);
    const current = (await this.ledger.load()).policies.find(
      (policy) => policy.policyId === policyId
    );
    const next: RuntimeAccessPolicy = {
      policyId,
      providerPackageId: input.providerPackageId,
      connectionId: input.connectionId,
      state: input.allowed ? 'interactive_allowed' : 'blocked',
      revision: (current?.revision ?? 0) + 1,
      allowedOperations: input.allowed
        ? ['submit', 'query', 'cancel', 'receive_result']
        : []
    };
    if (
      current &&
      current.state === next.state &&
      current.providerPackageId === next.providerPackageId
    ) {
      return;
    }
    await this.ledger.upsertPolicy(next);
  }

  async reconcileConnections(
    connections: readonly {
      readonly id: string;
      readonly packageId?: string;
      readonly state: string;
    }[]
  ): Promise<void> {
    for (const connection of connections) {
      if (!connection.packageId) continue;
      await this.syncConnectionPolicy({
        providerPackageId: connection.packageId,
        connectionId: connection.id,
        allowed: connection.state === 'available'
      }).catch(() => undefined);
    }
  }
}
