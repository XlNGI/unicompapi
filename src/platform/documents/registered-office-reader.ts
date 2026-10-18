import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildDocumentIRFromOutline, type DocumentWorkspaceKind, type ProjectId, type WorkId } from '../../domain';
import { JsonFileReferenceRepository, JsonWorkRepository } from '../repositories/json-repositories';
import { NodeProjectStorage } from '../storage';
import { resolveFileReferencePathSafely } from '../files/file-paths';
import { readOfficeOutlineFromBuffer } from './office-document-tool-executor';

/** Reads the registered bytes and format before deriving any model-visible structure. */
export async function readRegisteredOfficeDocument(input: { readonly rootDirectory: string; readonly projectId: ProjectId;
  readonly workId: WorkId; readonly kind: DocumentWorkspaceKind }) {
  const storage = new NodeProjectStorage(input.rootDirectory);
  const work = await new JsonWorkRepository(storage, input.projectId).get(input.workId);
  const file = work && await new JsonFileReferenceRepository(storage, input.projectId).get(work.fileId);
  const extension = input.kind === 'word' ? '.docx' : input.kind === 'excel' ? '.xlsx' : '.pptx';
  if (!work || !file || work.projectId !== input.projectId || file.projectId !== input.projectId || work.mediaKind !== 'document' ||
    file.sourceExecutionId !== work.sourceExecutionId || file.state !== 'available' || file.locator.kind !== 'project' ||
    !file.locator.relativePath.replace(/\\/g, '/').startsWith('files/documents/') || path.extname(file.locator.relativePath).toLowerCase() !== extension ||
    !file.checksumSha256) throw new Error('registered_office_unavailable');
  const absolute = await resolveFileReferencePathSafely(input.rootDirectory, file);
  const info = await stat(absolute);
  if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024) throw new Error('registered_office_unavailable');
  const buffer = await readFile(absolute, { signal: AbortSignal.timeout(5_000) });
  if (buffer.length !== file.sizeBytes || createHash('sha256').update(buffer).digest('hex') !== file.checksumSha256) throw new Error('registered_office_changed');
  const fileName = path.basename(file.locator.relativePath);
  const outline = await readOfficeOutlineFromBuffer({ buffer, kind: input.kind, displayName: fileName });
  const ir = buildDocumentIRFromOutline({ outline, operation: 'analyze', identityScope: `registered-${createHash('sha256').update(work.id).digest('hex')}` });
  if (JSON.stringify(ir).length > 28_000) throw new Error('registered_office_scope_exceeded');
  return { work, file, fileName, buffer, outline, ir };
}
