import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { toAssetId } from '../../../domain';
import { NodeFileStatusProbe, NodeVideoInspector, resolveFileReferencePathSafely } from '../../files';
import { JsonAssetRepository, JsonFileReferenceRepository } from '../../repositories';
import { NodeProjectStorage } from '../../storage';
import type { StorageProjectSession } from '../../ipc/storage-ipc-controller';
import type { ControlledWwwVideoPort } from './www-video-adapter';

export class ProjectWwwVideoMaterialResolver implements ControlledWwwVideoPort {
  constructor(private readonly getSession: () => StorageProjectSession | undefined) {}
  async resolve(input: { readonly projectId: string; readonly assetId: string }) {
    const session = this.getSession();
    if (!session || session.projectId !== input.projectId) throw new Error('Controlled video project unavailable');
    const storage = new NodeProjectStorage(session.rootDirectory);
    const asset = await new JsonAssetRepository(storage, session.projectId).get(toAssetId(input.assetId));
    if (!asset || asset.mediaKind !== 'video' || !asset.videoMetadata) throw new Error('Controlled video unavailable');
    const file = await new JsonFileReferenceRepository(storage, session.projectId).get(asset.fileId);
    if (!file?.checksumSha256 || !file.sizeBytes || file.sizeBytes > 100_000_000) throw new Error('Controlled video invalid');
    const observation = await new NodeFileStatusProbe(session.rootDirectory).inspect(file, { expectedChecksum: file.checksumSha256 });
    if (observation.recommendedState !== 'available' || observation.issues.includes('checksum_mismatch')) throw new Error('Controlled video changed');
    const target = await resolveFileReferencePathSafely(session.rootDirectory, file);
    const metadata = await new NodeVideoInspector().inspect(target);
    if (metadata.mimeType !== 'video/mp4' || metadata.sizeBytes !== file.sizeBytes || metadata.durationMs !== asset.videoMetadata.durationMs ||
      metadata.width !== asset.videoMetadata.width || metadata.height !== asset.videoMetadata.height) throw new Error('Controlled video changed');
    const bytes = await readFile(target);
    if (bytes.length !== file.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.checksumSha256) throw new Error('Controlled video changed');
    return { assetId: asset.id, mimeType: 'video/mp4' as const, durationMs: metadata.durationMs, sizeBytes: bytes.length, bytes };
  }
}
