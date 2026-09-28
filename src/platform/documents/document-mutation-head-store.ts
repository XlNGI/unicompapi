import { createHash } from 'node:crypto';
import { type NodeProjectStorage, toProjectRelativePath } from '../storage';
import { parseDocumentVersionPin, type DocumentVersionPin } from '../../domain/entities/document-version-pin';

/** The only authoritative version switch is CAS under the serialized head lock. */
export class DocumentMutationHeadStore {
  constructor(private readonly storage: NodeProjectStorage) {}

  async get(lineage: string): Promise<DocumentVersionPin | undefined> {
    const value = await this.storage.readJson<unknown>(pathFor(lineage));
    if (value === undefined) return undefined;
    const pin = parseDocumentVersionPin(value);
    if (pin.documentLineageId !== lineage) throw new TypeError('revision_conflict');
    return pin;
  }

  /** First admission only. Never use save to overwrite an existing head. */
  async save(input: DocumentVersionPin): Promise<void> {
    const pin = parseDocumentVersionPin(input);
    const target = pathFor(pin.documentLineageId);
    await this.storage.withExclusiveAccess([target], async () => {
      const existing = await this.get(pin.documentLineageId);
      if (existing) {
        if (!samePin(existing, pin)) throw new TypeError('revision_conflict');
        return;
      }
      await this.storage.writeJsonAtomically(target, pin);
    });
  }

  async compareAndSwap(expectedInput: DocumentVersionPin, nextInput: DocumentVersionPin,
    options: { readonly revalidate?: () => Promise<boolean> } = {}): Promise<boolean> {
    const expected = parseDocumentVersionPin(expectedInput);
    const next = parseDocumentVersionPin(nextInput);
    if (next.documentLineageId !== expected.documentLineageId || next.runtimeRevision !== expected.runtimeRevision + 1 ||
        next.headWorkId === expected.headWorkId || next.fileId === expected.fileId) return false;
    const target = pathFor(expected.documentLineageId);
    return this.storage.withExclusiveAccess([target], async () => {
      const current = await this.get(expected.documentLineageId);
      if (!current || !samePin(current, expected)) return false;
      if (options.revalidate && !await options.revalidate()) return false;
      // The callback can reject revoked authorization, cancellation or changed actual bytes.
      // Re-read after it returns to reject even a reentrant attempt to switch this head.
      const checked = await this.get(expected.documentLineageId);
      if (!checked || !samePin(checked, expected)) return false;
      await this.storage.writeJsonAtomically(target, next);
      return true;
    });
  }
}

function samePin(a: DocumentVersionPin, b: DocumentVersionPin): boolean {
  return a.documentLineageId === b.documentLineageId && a.headWorkId === b.headWorkId && a.fileId === b.fileId &&
    a.sourceExecutionId === b.sourceExecutionId && a.checksumSha256 === b.checksumSha256 &&
    a.runtimeRevision === b.runtimeRevision && a.identityIndexVersion === b.identityIndexVersion;
}
function pathFor(lineage: string) {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(lineage)) throw new TypeError('invalid_identity_id');
  return toProjectRelativePath(`entities/document-mutation-head/${createHash('sha256').update(lineage).digest('hex')}.json`);
}
