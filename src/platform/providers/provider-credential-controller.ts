import { randomUUID } from 'node:crypto';
import { toIsoTimestamp, type ProviderConnection } from '../../domain';
import type {
  CredentialActionResult,
  CredentialErrorCode,
  CredentialStatusResult
} from '../../shared/provider-ipc';
import type { JsonProviderRegistryStore } from './provider-registry';
import { CredentialVaultUnavailableError } from './credential-vault';
import type { SecureCredentialVault } from './credential-vault';

export class ProviderCredentialController {
  constructor(
    private readonly registry: JsonProviderRegistryStore,
    private readonly vault: SecureCredentialVault
  ) {}

  async saveCredential(input: unknown): Promise<CredentialActionResult> {
    try {
      const { connectionId, value } = parseSaveInput(input);
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      const createdReference = connection.credentialReference === undefined;
      const reference = connection.credentialReference ?? `credential-${randomUUID()}`;
      await this.vault.save(reference, value);
      try {
        await this.registry.save({
          ...snapshot,
          connections: replaceConnection(snapshot.connections, connection.id, {
            ...connection,
            credentialReference: reference,
            credentialState: 'saved',
            updatedAt: toIsoTimestamp(new Date().toISOString())
          })
        });
      } catch (error) {
        if (createdReference) await this.vault.remove(reference).catch(() => false);
        throw error;
      }
      return { ok: true, value: { state: 'saved' } };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async deleteLocalCredential(input: unknown): Promise<CredentialActionResult> {
    try {
      const connectionId = parseConnectionInput(input);
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      if (connection.credentialReference) {
        await this.vault.remove(connection.credentialReference);
      }
      await this.registry.save({
        ...snapshot,
        connections: replaceConnection(snapshot.connections, connection.id, {
          ...connection,
          credentialReference: undefined,
          credentialState: 'deleted',
          updatedAt: toIsoTimestamp(new Date().toISOString())
        })
      });
      return {
        ok: true,
        value: { state: 'deleted', remoteRevocation: 'not_attempted' }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async getCredentialStatus(input: unknown): Promise<CredentialStatusResult> {
    try {
      const connectionId = parseConnectionInput(input);
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      if (!connection.credentialReference) {
        return { ok: true, value: { state: connection.credentialState } };
      }
      const state = await this.vault.status(connection.credentialReference);
      return {
        ok: true,
        value: {
          state:
            state === 'saved'
              ? 'saved'
              : state === 'encryption_unavailable'
                ? 'verification_unavailable'
                : state === 'unreadable'
                  ? 'invalid'
                  : 'not_configured'
        }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async checkCredentialStorage(input: unknown): Promise<CredentialActionResult> {
    const status = await this.getCredentialStatus(input);
    if (!status.ok) return status;
    return {
      ok: true,
      value: {
        state: status.value.state,
        remoteValidation: 'not_attempted'
      }
    };
  }
}

function replaceConnection(
  connections: readonly ProviderConnection[],
  id: string,
  replacement: ProviderConnection
): readonly ProviderConnection[] {
  return connections.map((item) => (item.id === id ? replacement : item));
}

function parseSaveInput(value: unknown): {
  connectionId: string;
  value: string;
} {
  if (!isRecord(value) || typeof value.value !== 'string') {
    throw new TypeError('Credential request is invalid');
  }
  return { connectionId: requireConnectionId(value.connectionId), value: value.value };
}

function parseConnectionInput(value: unknown): string {
  if (!isRecord(value)) throw new TypeError('Credential request is invalid');
  return requireConnectionId(value.connectionId);
}

function requireConnectionId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new TypeError('Connection id is invalid');
  }
  return value;
}

function mapError(error: unknown): CredentialErrorCode {
  if (error instanceof CredentialVaultUnavailableError) {
    return 'encryption_unavailable';
  }
  if (error instanceof TypeError) return 'invalid_request';
  return 'credential_operation_failed';
}

function failure(
  code: CredentialErrorCode
): CredentialActionResult {
  const messages: Record<typeof code, string> = {
    connection_not_found: 'The provider connection was not found',
    encryption_unavailable: 'Operating-system credential encryption is unavailable',
    invalid_request: 'The credential request is invalid',
    credential_operation_failed: 'The local credential operation failed'
  };
  return { ok: false, error: { code, message: messages[code] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
