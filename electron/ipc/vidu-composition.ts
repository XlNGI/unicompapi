import { app, net, safeStorage } from 'electron';
import path from 'node:path';
import {
  ImageOperationRouter,
  JsonProviderOperationRepository,
  JsonProviderRegistryStore,
  JsonViduLiveValidationStore,
  LocalImageResultReceiver,
  LocalVideoResultReceiver,
  NodeProjectStorage,
  ProjectImageMaterialResolver,
  SecureCredentialVault,
  ViduImmediateImageResultPort,
  ViduLiveValidationApplicationError,
  ViduLiveValidationApplicationService,
  ViduLiveValidationCoordinator,
  ViduProviderPackage,
  ViduRuntimeAuthorizationClosedError,
  denyViduRuntimeAuthorization,
  ViduTransportFailure,
  createFrozenViduRegistryRecords,
  VIDU_PROTOCOL_BINDING_IDS,
  VideoOperationRouter,
  type ImageOperationPorts,
  type ImageSubmissionControllerDependencies,
  type ProviderAsyncOperationPort,
  type StorageProjectSession,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse,
  type VideoGenerationSubmitPort,
  type VideoSubmissionControllerDependencies
} from '../../src/platform';
import type { ProviderSubmitOutcome, ProxyMode } from '../../src/domain';

export interface ElectronViduCompositionOptions {
  readonly getProxyMode: () => Promise<ProxyMode>;
}

export class ElectronViduComposition {
  readonly registry: JsonProviderRegistryStore;
  readonly credentialVault: SecureCredentialVault;
  readonly providerPackage: ViduProviderPackage;
  readonly liveValidation: ViduLiveValidationApplicationService;

  constructor(options: ElectronViduCompositionOptions) {
    const userDataPath = app.getPath('userData');
    this.registry = new JsonProviderRegistryStore(
      path.join(userDataPath, 'provider-registry.json')
    );
    this.credentialVault = new SecureCredentialVault(
      path.join(userDataPath, 'secure-credentials.json'),
      {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        protect: (value) => safeStorage.encryptString(value),
        unprotect: (value) => safeStorage.decryptString(Buffer.from(value))
      }
    );
    let activeProxy: ProxyMode = { kind: 'system_default' };
    this.providerPackage = new ViduProviderPackage({
      credentialVault: this.credentialVault,
      transport: new ElectronViduHttpTransport(),
      proxy: () => activeProxy
    });
    this.liveValidation = new ViduLiveValidationApplicationService({
      registry: this.registry,
      coordinator: new ViduLiveValidationCoordinator(
        new JsonViduLiveValidationStore(
          path.join(userDataPath, 'vidu-live-validation.json')
        )
      ),
      connectionValidation: this.providerPackage.connectionValidation
    });
    void options.getProxyMode().then((proxy) => {
      activeProxy = proxy;
    }).catch(() => undefined);
  }

  createOperationPorts(options: {
    readonly getSession: () => StorageProjectSession | undefined;
    readonly imageMutations: ImageSubmissionControllerDependencies['mutations'];
    readonly videoMutations: VideoSubmissionControllerDependencies['mutations'];
  }): {
    readonly image: ImageOperationPorts;
    readonly imageResultReceiver: NonNullable<
      ImageSubmissionControllerDependencies['resultReceiver']
    >;
    readonly video: VideoGenerationSubmitPort;
    readonly videoAsync: ProviderAsyncOperationPort;
    readonly videoResultReceiver: NonNullable<
      VideoSubmissionControllerDependencies['resultReceiver']
    >;
  } {
    const materials = new ProjectImageMaterialResolver({
      getSession: options.getSession
    });
    const connections = {
      get: async (connectionId: string) => {
        const snapshot = await this.registry.load();
        return snapshot.connections.find((item) => item.id === connectionId);
      }
    };
    const frozenBinding = createFrozenViduRegistryRecords().protocolBindings.find(
      (binding) => binding.id === VIDU_PROTOCOL_BINDING_IDS.referenceVideoV2
    );
    if (!frozenBinding) {
      throw new Error('The frozen Vidu video protocol binding is unavailable');
    }
    const images = this.providerPackage.createImageAdapters({
      connections,
      materials
    });
    const video = this.providerPackage.createVideoAdapter({
      connections,
      materials,
      binding: frozenBinding,
      connectionId: frozenBinding.connectionId
    });
    const imageRouter = new ImageOperationRouter(this.registry, {
      vidu_image_v1: images.imageV1,
      vidu_gemini_image_v2: images.geminiImageV2
    });
    const videoRouter = new VideoOperationRouter(this.registry, {
      vidu_reference_video_v2: video
    });
    const imagePort = {
      submit: async (request: Parameters<ImageOperationRouter['submit']>[0]) => {
        try {
          denyViduRuntimeAuthorization();
          await this.liveValidation.beforeSubmission(
            'image',
            request.task,
            request.execution,
            options.getSession
          );
        } catch (error) {
          return liveValidationFailure(error);
        }
        const routed = await imageRouter.submit(request);
        const outcome = routed.ok
          ? routed.value
          : ({
              kind: 'failed_before_submission',
              message: routed.error.message,
              retryability: 'not_retryable'
            } as const);
        await this.liveValidation.afterSubmission('image', outcome)
          .catch(() => undefined);
        return outcome;
      }
    };
    const videoPort: VideoGenerationSubmitPort = {
      submit: async (request) => {
        try {
          denyViduRuntimeAuthorization();
          await this.liveValidation.beforeSubmission(
            'video',
            request.task,
            request.execution,
            options.getSession
          );
        } catch (error) {
          return liveValidationFailure(error);
        }
        const routed = await videoRouter.submit(request);
        const outcome = routed.ok
          ? routed.value
          : ({
              kind: 'failed_before_submission',
              message: routed.error.message,
              retryability: 'not_retryable'
            } as const);
        await this.liveValidation.afterSubmission('video', outcome)
          .catch(() => undefined);
        return outcome;
      }
    };
    const videoAsync: ProviderAsyncOperationPort = {
      query: async (providerOperationId) => {
        denyViduRuntimeAuthorization();
        const status = await video.query(providerOperationId);
        await this.liveValidation.recordPolling(status).catch(() => undefined);
        return status;
      },
      cancel: async (providerOperationId) => {
        denyViduRuntimeAuthorization();
        const outcome = await video.cancel(providerOperationId);
        if (outcome.state === 'cancelled') {
          await this.liveValidation.recordPolling({ state: 'cancelled' })
            .catch(() => undefined);
        }
        return outcome;
      }
    };
    const videoReceiver = new LocalVideoResultReceiver({
      getSession: options.getSession,
      mutations: options.videoMutations,
      port: video
    });
    return {
      image: {
        image_generation: imagePort,
        reference_to_image: imagePort,
        image_editing: imagePort
      },
      imageResultReceiver: {
        receive: async (executionId) => {
          const session = options.getSession();
          if (!session) {
            return {
              ok: false as const,
              error: {
                code: 'project_not_open' as const,
                message: 'No project is currently open'
              }
            };
          }
          const storage = new NodeProjectStorage(session.rootDirectory);
          return new LocalImageResultReceiver({
            getSession: options.getSession,
            mutations: options.imageMutations,
            port: new ViduImmediateImageResultPort({
              operations: new JsonProviderOperationRepository(storage),
              runtime: this.providerPackage.runtime
            })
          }).receive(executionId).then(async (result) => {
            if (result.ok) {
              await this.liveValidation.recordLocalResult(
                'image',
                result.value.executionId,
                result.value.workId,
                options.getSession
              ).catch(() => undefined);
            }
            return result;
          });
        }
      },
      video: videoPort,
      videoAsync,
      videoResultReceiver: {
        receive: async (executionId) => {
          denyViduRuntimeAuthorization();
          const result = await videoReceiver.receive(executionId);
          if (result.ok && result.value.works.length === 1) {
            await this.liveValidation.recordLocalResult(
              'video',
              result.value.executionId,
              result.value.works[0].workId,
              options.getSession
            ).catch(() => undefined);
          }
          return result;
        }
      }
    };
  }

  dispose(): void {
    this.providerPackage.dispose();
  }

}

function liveValidationFailure(error: unknown): ProviderSubmitOutcome {
  const message = error instanceof ViduLiveValidationApplicationError
    ? error.message
    : error instanceof ViduRuntimeAuthorizationClosedError
      ? error.message
    : 'The approved Vidu live validation gate could not be evaluated';
  return {
    kind: 'failed_before_submission',
    message,
    retryability: 'not_retryable'
  };
}

class ElectronViduHttpTransport implements ViduHttpTransport {
  async send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse> {
    try {
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined,
        signal: request.signal,
        redirect: request.redirect
      });
      const body = await readBoundedResponse(response, request.maxResponseBytes);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new ViduTransportFailure('cancelled');
      }
      if (error instanceof ViduTransportFailure) throw error;
      throw new ViduTransportFailure('network');
    }
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new ViduTransportFailure('response_too_large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ViduTransportFailure('response_too_large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
