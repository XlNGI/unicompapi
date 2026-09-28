import { createHash } from 'node:crypto';
import { toProjectRelativePath, type NodeProjectStorage } from '../storage';
import { parsePresentationIdentityManifest, type DocumentIdentityIndex, type PresentationIdentityManifest } from './presentation-identity-manifest';

/** Immutable Work-version snapshots. This store never selects the authoritative head. */
export class DocumentIdentityIndexStore {
  constructor(private readonly storage: NodeProjectStorage) {}

  /** Compatibility lookup for the initial admission only; use the head store for current state. */
  async get(documentLineageId: string): Promise<DocumentIdentityIndex | undefined> {
    const value = await this.storage.readJson<unknown>(seedPath(documentLineageId));
    if (value === undefined) return undefined;
    const parsed = parsePresentationIdentityManifest(value);
    if (parsed.documentLineageId !== documentLineageId) throw new TypeError('identity_stale');
    return parsed;
  }

  async save(index: PresentationIdentityManifest): Promise<void> {
    const parsed = parsePresentationIdentityManifest(index);
    const target = workPath(parsed.workId);
    await this.storage.withExclusiveAccess([target], async () => {
      const existing = await this.getForWork(parsed.workId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new TypeError('identity_stale');
        return;
      }
      await this.storage.writeJsonAtomically(target, parsed);
    });
  }

  async getForWork(workId: string): Promise<DocumentIdentityIndex | undefined> {
    const value = await this.storage.readJson<unknown>(workPath(workId));
    if (value === undefined) return undefined;
    const parsed = parsePresentationIdentityManifest(value);
    if (parsed.workId !== workId) throw new TypeError('identity_stale');
    return parsed;
  }

  async ensureForWork(input: { readonly workId: string; readonly build: () => Promise<PresentationIdentityManifest> }): Promise<DocumentIdentityIndex> {
    const target = workPath(input.workId);
    return this.storage.withExclusiveAccess([target], async () => {
      const existing = await this.getForWork(input.workId);
      if (existing) return existing;
      const created = parsePresentationIdentityManifest(await input.build());
      if (created.workId !== input.workId) throw new TypeError('identity_stale');
      await this.storage.writeJsonAtomically(target, created);
      // A seed is historical admission evidence, never overwritten by a candidate.
      const seed = seedPath(created.documentLineageId);
      await this.storage.withExclusiveAccess([seed], async () => {
        if (await this.storage.readJson<unknown>(seed) === undefined) await this.storage.writeJsonAtomically(seed, created);
      });
      return created;
    });
  }
}

function workPath(workId: string) { return toProjectRelativePath(`entities/presentation-identity-index/work-${keyFor(workId)}.json`); }
function seedPath(lineage: string) { return toProjectRelativePath(`entities/presentation-identity-index/${keyFor(lineage)}.json`); }
function keyFor(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)) throw new TypeError('invalid_identity_id');
  return createHash('sha256').update(value).digest('hex');
}
