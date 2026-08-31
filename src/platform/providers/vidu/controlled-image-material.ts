import { readFile } from 'node:fs/promises';
import { toIsoTimestamp, type AssetId, type ProjectId } from '../../../domain';
import {
  FileVerificationPersistenceService,
  NodeFileStatusProbe,
  NodeImageInspector,
  resolveFileReferencePathSafely
} from '../../files';
import {
  JsonAssetRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository
} from '../../repositories';
import { NodeProjectStorage } from '../../storage';
import type { StorageProjectSession } from '../../ipc/storage-ipc-controller';

export type ControlledImageMaterialErrorCode =
  | 'project_unavailable'
  | 'material_not_found'
  | 'material_changed'
  | 'material_invalid'
  | 'material_too_large';

export class ControlledImageMaterialError extends Error {
  constructor(readonly code: ControlledImageMaterialErrorCode) {
    super(messageForCode(code));
    this.name = 'ControlledImageMaterialError';
  }
}

export interface ControlledImageMaterial {
  readonly assetId: AssetId;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly base64: string;
}

export interface ControlledImageMaterialPort {
  resolve(input: {
    readonly projectId: ProjectId;
    readonly assetId: AssetId;
  }): Promise<ControlledImageMaterial>;
}

export interface ProjectImageMaterialResolverDependencies {
  readonly getSession: () => StorageProjectSession | undefined;
  readonly maximumInputBytes?: number;
}

export class ProjectImageMaterialResolver
  implements ControlledImageMaterialPort {
  private readonly maximumInputBytes: number;

  constructor(
    private readonly dependencies: ProjectImageMaterialResolverDependencies
  ) {
    this.maximumInputBytes = dependencies.maximumInputBytes ?? 15 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumInputBytes) || this.maximumInputBytes < 1) {
      throw new TypeError('maximum image input bytes must be a positive integer');
    }
  }

  async resolve(input: {
    readonly projectId: ProjectId;
    readonly assetId: AssetId;
  }): Promise<ControlledImageMaterial> {
    const session = this.dependencies.getSession();
    if (!session || session.projectId !== input.projectId) {
      throw new ControlledImageMaterialError('project_unavailable');
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    const assets = new JsonAssetRepository(storage, session.projectId);
    const files = new JsonFileReferenceRepository(storage, session.projectId);
    const index = new JsonFileIndexRepository(storage, session.projectId);
    const asset = await assets.get(input.assetId);
    if (
      !asset ||
      asset.projectId !== session.projectId ||
      asset.mediaKind !== 'image' ||
      !asset.imageMetadata
    ) {
      throw new ControlledImageMaterialError('material_not_found');
    }
    const file = await files.get(asset.fileId);
    if (!file || file.projectId !== session.projectId) {
      throw new ControlledImageMaterialError('material_not_found');
    }

    const probe = new NodeFileStatusProbe(session.rootDirectory);
    const persistence = new FileVerificationPersistenceService(
      files,
      index,
      probe,
      () => toIsoTimestamp(new Date().toISOString())
    );
    const observation = await probe.inspect(file, {
      expectedChecksum: file.checksumSha256
    });
    const verified = await persistence.persistProbeResult(file, observation);
    if (
      verified.state !== 'available' ||
      !verified.checksumSha256 ||
      verified.lastVerification?.matchesExpected === false
    ) {
      throw new ControlledImageMaterialError('material_changed');
    }
    const target = await resolveFileReferencePathSafely(
      session.rootDirectory,
      verified
    );
    let inspection: Awaited<ReturnType<NodeImageInspector['inspect']>>;
    try {
      inspection = await new NodeImageInspector().inspect(target);
    } catch {
      throw new ControlledImageMaterialError('material_invalid');
    }
    if (
      inspection.mimeType !== asset.imageMetadata.mimeType ||
      inspection.width !== asset.imageMetadata.width ||
      inspection.height !== asset.imageMetadata.height ||
      inspection.sizeBytes !== verified.sizeBytes
    ) {
      throw new ControlledImageMaterialError('material_changed');
    }
    if (inspection.sizeBytes > this.maximumInputBytes) {
      throw new ControlledImageMaterialError('material_too_large');
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      throw new ControlledImageMaterialError('material_invalid');
    }
    if (bytes.byteLength !== inspection.sizeBytes) {
      throw new ControlledImageMaterialError('material_changed');
    }
    return {
      assetId: asset.id,
      mimeType: inspection.mimeType,
      width: inspection.width,
      height: inspection.height,
      sizeBytes: inspection.sizeBytes,
      base64: bytes.toString('base64')
    };
  }
}

function messageForCode(code: ControlledImageMaterialErrorCode): string {
  const messages: Record<ControlledImageMaterialErrorCode, string> = {
    project_unavailable: 'The controlled project is unavailable',
    material_not_found: 'The selected image material is unavailable',
    material_changed: 'The selected image material changed after confirmation',
    material_invalid: 'The selected image material is invalid',
    material_too_large: 'The selected image material exceeds the allowed size'
  };
  return messages[code];
}
