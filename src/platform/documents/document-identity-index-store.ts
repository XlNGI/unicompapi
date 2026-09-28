import { createHash } from 'node:crypto';
import { toProjectRelativePath } from '../storage';
import type { NodeProjectStorage } from '../storage';
import { parsePresentationIdentityManifest, type DocumentIdentityIndex, type PresentationIdentityManifest } from './presentation-identity-manifest';

export class DocumentIdentityIndexStore {
  constructor(private readonly storage: NodeProjectStorage) {}

  async get(documentLineageId: string): Promise<DocumentIdentityIndex | undefined> {
    const key = keyFor(documentLineageId);
    const value = await this.storage.readJson<unknown>(toProjectRelativePath(`entities/presentation-identity-index/${key}.json`));
    return value === undefined ? undefined : parsePresentationIdentityManifest(value);
  }

  async save(index: PresentationIdentityManifest): Promise<void> {
    parsePresentationIdentityManifest(index);
    await this.storage.writeJsonAtomically(toProjectRelativePath(`entities/presentation-identity-index/${keyFor(index.documentLineageId)}.json`), index);
  }
}

function keyFor(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
