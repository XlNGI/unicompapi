import {
  toIsoTimestamp,
  type IsoTimestamp,
  type ProviderConnection,
  type StructuredCredentialRecord
} from '../../../domain';
import type {
  ProviderConnectionValidationResultV1,
  ProviderManagementAdapterPort
} from '../provider-management-framework';
import {
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION
} from './vidu-contracts';
import { ViduRuntimeError } from './vidu-runtime-errors';
import type { ViduSharedRuntime } from './vidu-shared-runtime';

export class ViduManagementAdapter implements ProviderManagementAdapterPort {
  readonly identity = {
    packageId: VIDU_PROVIDER_PACKAGE_ID,
    adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
    adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
    protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
    protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION
  } as const;

  constructor(
    private readonly runtime: ViduSharedRuntime,
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async validateConnection(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<ProviderConnectionValidationResultV1> {
    try {
      await this.runtime.requestCreditsProbe(input);
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: this.now()
      };
    } catch (error) {
      const authenticationFailed =
        error instanceof ViduRuntimeError &&
        error.code === 'authentication_failed';
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState: authenticationFailed
          ? 'invalid'
          : 'verification_unavailable',
        observedAt: this.now(),
        safeCode:
          error instanceof ViduRuntimeError ? error.code : 'unknown'
      };
    }
  }
}
