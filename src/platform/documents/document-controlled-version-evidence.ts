import { opendir } from 'node:fs/promises';
import type { ProjectId, Work } from '../../domain';
import { parseDocumentVersionPin } from '../../domain/entities/document-version-pin';
import { JsonDocumentTaskRuntimeRepository } from '../repositories/json-document-task-runtime-repository';
import { JsonExecutionRepository, JsonTaskRepository } from '../repositories/json-repositories';
import { assertNoSymbolicLinkTraversal, resolveInsideRoot, toProjectRelativePath, type NodeProjectStorage } from '../storage';
import { parsePresentationIdentityManifest } from './presentation-identity-manifest';

export class DocumentIdentityUnavailableError extends Error {
  readonly code = 'identity_unresolved';
  constructor() {
    super('作品版本的稳定元素标识缺失，请先核对版本记录后再修改。');
    this.name = 'DocumentIdentityUnavailableError';
  }
}

/** Read-only admission evidence. Neither backups nor historical pins authorize a new identity. */
export async function hasControlledDocumentVersionEvidence(input: {
  readonly storage: NodeProjectStorage; readonly rootDirectory: string;
  readonly projectId: ProjectId; readonly work: Work;
}): Promise<boolean> {
  try {
    const task = await new JsonTaskRepository(input.storage, input.projectId).get(input.work.sourceTaskId);
    if (task && /^mutation-[a-f0-9]{64}$/u.test(task.sourceDraftId)) {
      const execution = await new JsonExecutionRepository(input.storage).get(input.work.sourceExecutionId);
      if (!execution || execution.taskId !== task.id || execution.workId !== input.work.id ||
          execution.outputFileId !== input.work.fileId) throw new DocumentIdentityUnavailableError();
      return true;
    }
    const runtimes = await new JsonDocumentTaskRuntimeRepository(input.storage, input.projectId).list();
    if (runtimes.length > 4_096) throw new DocumentIdentityUnavailableError();
    if (runtimes.some(runtime => runtime.operation === 'edit' &&
        ((runtime.workRef?.kind === 'registered' && runtime.workRef.ref === input.work.id) ||
          runtime.observations.some(observation => observation.ok && observation.data?.registeredWorkId === input.work.id)))) return true;

    let scanned = 0;
    for (const directory of ['document-mutation-head', 'document-mutations', 'presentation-identity-index'] as const) {
      const relativeDirectory = `entities/${directory}`;
      const absoluteDirectory = resolveInsideRoot(input.rootDirectory, relativeDirectory);
      await assertNoSymbolicLinkTraversal(input.rootDirectory, absoluteDirectory);
      let entries;
      try { entries = await opendir(absoluteDirectory); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      for await (const entry of entries) {
        if (++scanned > 4_096) throw new DocumentIdentityUnavailableError();
        const pattern = directory === 'document-mutation-head' ? /^[a-f0-9]{64}\.json(?:\.bak)?$/u
          : directory === 'document-mutations' ? /^call-[a-f0-9]{64}\.json(?:\.bak)?$/u
            : /^(?:work-)?[a-f0-9]{64}\.json(?:\.bak)?$/u;
        if (!pattern.test(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new DocumentIdentityUnavailableError();
        const value = await input.storage.readJson<unknown>(toProjectRelativePath(`${relativeDirectory}/${entry.name}`));
        if (directory === 'document-mutation-head') {
          if (parseDocumentVersionPin(value).headWorkId === input.work.id) return true;
        } else if (directory === 'presentation-identity-index') {
          if (parsePresentationIdentityManifest(value).workId === input.work.id) return true;
        } else {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DocumentIdentityUnavailableError();
          const record = value as Record<string, unknown>;
          if (record.schemaVersion !== 1 || typeof record.idempotencyKey !== 'string' || typeof record.state !== 'string')
            throw new DocumentIdentityUnavailableError();
          if (parseDocumentVersionPin(record.basePin).headWorkId === input.work.id ||
              (record.candidatePin !== undefined && parseDocumentVersionPin(record.candidatePin).headWorkId === input.work.id)) return true;
        }
      }
    }
    return false;
  } catch (error) {
    if (error instanceof DocumentIdentityUnavailableError) throw error;
    throw new DocumentIdentityUnavailableError();
  }
}
