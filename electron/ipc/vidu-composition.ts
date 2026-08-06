import { app, net, safeStorage } from 'electron';
import path from 'node:path';
import {
  ImageOperationRouter,
  JsonProviderOperationRepository,
  JsonProviderRegistryStore,
  LocalImageResultReceiver,
  LocalVideoResultReceiver,
  NodeProjectStorage,
  ProjectImageMaterialResolver,
  SecureCredentialVault,
  ViduImmediateImageResultPort,
  ViduProviderPackage,
  ViduTransportFailure,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_TEXT_VIDEO_V2_ADAPTER_ID,
  type ImageOperationPorts,
  type ImageSubmissionControllerDependencies,
  type ProviderAsyncOperationPort,
  type StorageProjectSession,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse,
  type ViduVideoOperationContext,
  type ViduVideoOperationContextPort,
  type VideoResultPort,
  type VideoWorkspaceMutationCoordinator
} from '../../src/platform';
import type { ProxyMode } from '../../src/domain';

export interface ElectronViduCompositionOptions {
  readonly getProxyMode: () => Promise<ProxyMode>;
}

export class ElectronViduComposition {
  readonly registry: JsonProviderRegistryStore;
  readonly credentialVault: SecureCredentialVault;
  readonly providerPackage: ViduProviderPackage;

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
    void options.getProxyMode().then((proxy) => {
      activeProxy = proxy;
    }).catch(() => undefined);
  }

  createOperationPorts(options: {
    readonly getSession: () => StorageProjectSession | undefined;
    readonly imageMutations: ImageSubmissionControllerDependencies['mutations'];
    readonly videoMutations: VideoWorkspaceMutationCoordinator;
  }): {
    readonly image: ImageOperationPorts;
    readonly imageResultReceiver: NonNullable<
      ImageSubmissionControllerDependencies['resultReceiver']
    >;
    readonly videoAsync: ProviderAsyncOperationPort;
    readonly rememberVideoOperation: (
      taskId: string,
      context: ViduVideoOperationContext
    ) => void;
    readonly videoResultReceiver: {
      receive(
        executionId: string
      ): ReturnType<LocalVideoResultReceiver['receive']>;
    };
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
    const images = this.providerPackage.createImageAdapters({
      connections,
      materials
    });
    const videoOperationContext = new RegistryVideoOperationContext(this.registry);
    // Shared adapter instance for feature-path poll + local result landing only.
    // Product submit goes through createRouteAdapters / videoFeatures, not this port.
    const referenceVideo = this.providerPackage.createVideoAdapter({
      connections,
      materials,
      operationContext: videoOperationContext
    });
    const textVideo = this.providerPackage.createTextVideoAdapter({
      connections,
      operationContext: videoOperationContext
    });
    const videoPort = createCompositeViduVideoPort(
      videoOperationContext,
      referenceVideo,
      textVideo
    );
    const imageRouter = new ImageOperationRouter(this.registry, {
      vidu_image_v1: images.imageV1,
      vidu_gemini_image_v2: images.geminiImageV2
    });
    const imagePort = {
      submit: async (request: Parameters<ImageOperationRouter['submit']>[0]) => {
        const routed = await imageRouter.submit(request);
        return routed.ok
          ? routed.value
          : ({
              kind: 'failed_before_submission',
              message: routed.error.message,
              retryability: 'not_retryable'
            } as const);
      }
    };
    const videoAsync: ProviderAsyncOperationPort = {
      query: (providerOperationId) => videoPort.query(providerOperationId),
      cancel: (providerOperationId) => videoPort.cancel(providerOperationId)
    };
    const videoReceiver = new LocalVideoResultReceiver({
      getSession: options.getSession,
      mutations: options.videoMutations,
      port: videoPort
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
          }).receive(executionId);
        }
      },
      videoAsync,
      rememberVideoOperation: (taskId, context) => {
        videoOperationContext.remember(taskId, context);
      },
      videoResultReceiver: {
        receive: (executionId) => videoReceiver.receive(executionId)
      }
    };
  }

  dispose(): void {
    this.providerPackage.dispose();
  }

}

class RegistryVideoOperationContext implements ViduVideoOperationContextPort {
  private readonly remembered = new Map<string, ViduVideoOperationContext>();

  constructor(private readonly registry: JsonProviderRegistryStore) {}

  remember(taskId: string, context: ViduVideoOperationContext): void {
    this.remembered.set(taskId, context);
  }

  peek(taskId: string): ViduVideoOperationContext | undefined {
    return this.remembered.get(taskId);
  }

  async resolve(taskId: string): Promise<ViduVideoOperationContext | undefined> {
    const remembered = this.remembered.get(taskId);
    if (remembered) return remembered;
    const snapshot = await this.registry.load();
    const candidates = snapshot.protocolBindings.filter(
      (binding) =>
        binding.adapterKind === VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID ||
        binding.adapterKind === VIDU_TEXT_VIDEO_V2_ADAPTER_ID
    );
    // With both text and reference video bindings installed, guessing the first
    // binding routes pro text2video polls to the wrong adapter. Only fall back
    // when a single video binding exists (legacy installs).
    if (candidates.length !== 1) return undefined;
    const binding = candidates[0];
    return { connectionId: binding.connectionId, binding };
  }
}

function createCompositeViduVideoPort(
  context: RegistryVideoOperationContext,
  referenceVideo: ProviderAsyncOperationPort & VideoResultPort,
  textVideo: ProviderAsyncOperationPort & VideoResultPort
): ProviderAsyncOperationPort & VideoResultPort {
  const select = async (providerOperationId: string) => {
    const resolved =
      context.peek(providerOperationId) ??
      (await context.resolve(providerOperationId));
    if (resolved?.binding.adapterKind === VIDU_TEXT_VIDEO_V2_ADAPTER_ID) {
      return textVideo;
    }
    if (resolved?.binding.adapterKind === VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID) {
      return referenceVideo;
    }
    throw new Error(
      'The Vidu video operation context is unavailable for poll or result landing'
    );
  };
  return {
    query: async (providerOperationId) =>
      (await select(providerOperationId)).query(providerOperationId),
    cancel: async (providerOperationId) =>
      (await select(providerOperationId)).cancel(providerOperationId),
    getCompletion: async (remoteOperationId) =>
      (await select(remoteOperationId)).getCompletion(remoteOperationId),
    listResults: async (remoteOperationId) =>
      (await select(remoteOperationId)).listResults(remoteOperationId),
    openDownload: async (remoteOperationId, remoteResultId) =>
      (await select(remoteOperationId)).openDownload(
        remoteOperationId,
        remoteResultId
      )
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
  maxResponseBytes: number
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ViduTransportFailure('response_too_large');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  );
}
