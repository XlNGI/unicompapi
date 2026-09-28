import { createHash } from 'node:crypto';
import { toProjectRelativePath } from '../storage';
import type { NodeProjectStorage } from '../storage';
import type { ProjectRelativePath } from '../storage';
import type { DocumentMutationRecord } from '../../application/document-mutation-coordinator';

/** Durable bounded record used when candidate registration or head CAS is uncertain. */
export class DocumentMutationReconciliationStore {
  constructor(private readonly storage: NodeProjectStorage) {}

  async get(mutationId: string): Promise<DocumentMutationRecord | undefined> {
    const value = await this.storage.readJson<DocumentMutationRecord>(pathFor(mutationId));
    return value;
  }

  async save(record: DocumentMutationRecord): Promise<void> {
    await this.storage.writeJsonAtomically(pathFor(record.mutationId), record);
  }
}

function pathFor(mutationId: string): ProjectRelativePath {
  return toProjectRelativePath(`entities/document-mutation-reconciliation/${createHash('sha256').update(mutationId).digest('hex')}.json`);
}
