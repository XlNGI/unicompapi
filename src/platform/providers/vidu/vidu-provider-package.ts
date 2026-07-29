import type { ProviderConnection } from '../../../domain';
import type {
  ConnectionValidationObservation,
  ConnectionValidationPort
} from '../provider-capability-services';
import { ViduRuntimeError } from './vidu-runtime-errors';
import {
  ViduSharedRuntime,
  type ViduSharedRuntimeOptions
} from './vidu-shared-runtime';

export const VIDU_PROVIDER_PACKAGE_ID = 'provider-package-vidu-v1';

export class ViduConnectionValidationPort
  implements ConnectionValidationPort {
  constructor(
    private readonly runtime: ViduSharedRuntime,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async validate(
    connection: ProviderConnection
  ): Promise<ConnectionValidationObservation> {
    try {
      await this.runtime.request({
        connection,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token',
        maxResponseBytes: 256 * 1024
      });
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: this.now()
      };
    } catch (error) {
      const credentialState =
        error instanceof ViduRuntimeError &&
        error.code === 'authentication_failed'
          ? 'invalid'
          : 'verification_unavailable';
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState,
        observedAt: this.now()
      };
    }
  }
}

export class ViduProviderPackage {
  readonly id = VIDU_PROVIDER_PACKAGE_ID;
  readonly runtime: ViduSharedRuntime;
  readonly connectionValidation: ViduConnectionValidationPort;

  constructor(options: ViduSharedRuntimeOptions) {
    this.runtime = new ViduSharedRuntime(options);
    this.connectionValidation = new ViduConnectionValidationPort(this.runtime);
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
