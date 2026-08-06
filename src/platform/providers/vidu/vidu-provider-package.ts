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
import {
  ViduGeminiImageV2Adapter,
  ViduImageV1Adapter,
  type ViduConnectionPort,
  type ViduImageV1AdapterOptions
} from './vidu-image-adapters';
import { ViduReferenceImageV2Adapter } from './vidu-reference-image-adapter';
import type { ControlledImageMaterialPort } from './controlled-image-material';
import {
  ViduReferenceVideoV2Adapter,
  type ViduVideoOperationContextPort
} from './vidu-video-adapter';
import {
  VIDU_PROVIDER_PACKAGE_ID,
  viduProviderPackageDescriptor
} from './vidu-contracts';
import {
  ViduImageRouteAdapter,
  ViduVideoRouteAdapter,
  type ViduExecutionRouteResolverPort,
  type ViduParameterSchemaResolverPort,
  type ViduRouteAdapterIdFactory,
  type ViduUsageObservationSinkPort
} from './vidu-route-adapters';

export { VIDU_PROVIDER_PACKAGE_ID } from './vidu-contracts';

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
  readonly descriptor = viduProviderPackageDescriptor;
  readonly runtime: ViduSharedRuntime;
  readonly connectionValidation: ViduConnectionValidationPort;

  constructor(options: ViduSharedRuntimeOptions) {
    this.runtime = new ViduSharedRuntime(options);
    this.connectionValidation = new ViduConnectionValidationPort(this.runtime);
  }

  createImageAdapters(options: {
    readonly connections: ViduConnectionPort;
    readonly materials: ControlledImageMaterialPort;
    readonly imageV1?: ViduImageV1AdapterOptions;
    readonly createProviderOperationId?: () => string;
  }) {
    const dependencies = {
      runtime: this.runtime,
      connections: options.connections,
      materials: options.materials,
      createProviderOperationId: options.createProviderOperationId
    };
    return {
      imageV1: new ViduImageV1Adapter(dependencies, options.imageV1),
      geminiImageV2: new ViduGeminiImageV2Adapter(dependencies),
      referenceImageV2: new ViduReferenceImageV2Adapter(dependencies)
    };
  }

  createVideoAdapter(options: {
    readonly connections: ViduConnectionPort;
    readonly materials: ControlledImageMaterialPort;
    readonly operationContext: ViduVideoOperationContextPort;
    readonly now?: () => number;
  }) {
    return new ViduReferenceVideoV2Adapter({
      runtime: this.runtime,
      connections: options.connections,
      materials: options.materials,
      operationContext: options.operationContext,
      now: options.now
    });
  }

  createRouteAdapters(options: {
    readonly routes: ViduExecutionRouteResolverPort;
    readonly parameterSchemas: ViduParameterSchemaResolverPort;
    readonly materials: ControlledImageMaterialPort;
    readonly usage: ViduUsageObservationSinkPort;
    readonly ids?: ViduRouteAdapterIdFactory;
    readonly now?: () => string;
  }) {
    const dependencies = {
      runtime: this.runtime,
      routes: options.routes,
      parameterSchemas: options.parameterSchemas,
      materials: options.materials,
      usage: options.usage,
      ids: options.ids,
      now: options.now
    };
    return {
      imageV1: new ViduImageRouteAdapter('image_v1', dependencies),
      geminiImageV2: new ViduImageRouteAdapter(
        'gemini_image_v2',
        dependencies
      ),
      referenceImageV2: new ViduImageRouteAdapter(
        'reference_image_v2',
        dependencies
      ),
      referenceVideoV2: new ViduVideoRouteAdapter(dependencies)
    };
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
