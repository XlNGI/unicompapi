import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createUpdateElementBinding } from '../../src/application/update-element-tool';
import { DocumentMutationCoordinator } from '../../src/application/document-mutation-coordinator';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { buildPresentationIdentityManifest } from '../../src/platform/documents/presentation-identity-manifest';
import type { DocumentMutationHead } from '../../src/application/document-mutation-coordinator';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('keeps update_element arguments business-only and returns a validated patch result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-update-element-'));
  roots.push(root);
  const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '更新工具', sections: [{ heading: '目标', level: 1,
    blocks: [{ type: 'paragraph', text: '原文' }] }] }));
  const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root, now: '2026-09-28T12:00:00.000Z' });
  const buffer = await readFile(generated.temporaryPath);
  const identity = await buildPresentationIdentityManifest({ buffer, documentLineageId: 'lineage-update', workId: 'work-update-1', revision: 1 });
  const element = identity.elements.find(item => item.text === '原文')!;
  const pin: DocumentVersionPin = { documentLineageId: identity.documentLineageId, headWorkId: identity.workId, fileId: 'file-update-1', sourceExecutionId: 'execution-update-1', checksumSha256: identity.artifactChecksumSha256, runtimeRevision: 1, identityIndexVersion: 1 };
  const head: DocumentMutationHead = { pin, buffer, identity };
  const coordinator = new DocumentMutationCoordinator({
    readHead: async () => head,
    registerCandidate: async candidate => ({ ...candidate, workId: 'work-update-2' }),
    compareAndSwapHead: async () => true,
    cleanupCandidate: async () => undefined,
    reconcile: async () => undefined,
    refreshSession: async () => undefined,
    qa: async () => undefined
  });
  const binding = createUpdateElementBinding({ coordinator });
  expect(binding.contract.input.fields).toEqual(expect.objectContaining({ elementId: expect.anything(), text: expect.anything() }));
  const result = await binding.execute({ elementId: element.elementId, text: '新文本' }, {
    callId: 'call-update-1', idempotencyKey: 'call-update-1', currentDocumentId: 'work-update-1',
    currentDocumentIR: { operation: 'edit', attachmentRefs: [] }, revision: 1, operation: 'edit', capabilities: ['update_element'],
    projectContext: { projectId: 'project-update' }, authorization: { canRead: true, canWrite: true, allowedToolIds: ['update_element'] },
    abortSignal: new AbortController().signal, taskContext: { taskId: 'task-update-1' }
  });
  expect(result).toMatchObject({ status: 'success', irPatch: { schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId: element.elementId }, text: '新文本' }] } });
});
