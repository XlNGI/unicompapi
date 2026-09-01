import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateTemporaryDocumentFile,
  publishDocumentCandidate,
  type DocumentPublishCandidate,
  type DocumentPublishPort
} from '../../src/platform/documents';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('phase 9 Windows document artifact smoke path', () => {
  it('generates and verifies real docx, xlsx and pptx temporary artifacts before publish', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-e6-'));
    temporaryRoots.push(root);
    const outlines = [
      { kind: 'word' as const, title: 'Word验收', sections: [{ heading: '摘要', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '结构校验' }] }] },
      { kind: 'excel' as const, title: 'Excel验收', sections: [{ heading: '数据', level: 1 as const, blocks: [{ type: 'table' as const, header: ['指标'], rows: [['1']] }] }] },
      { kind: 'ppt' as const, title: 'PPT验收', sections: [{ heading: '结论', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '视觉计划' }] }] }
    ];
    for (const outline of outlines) {
      const generated = await generateTemporaryDocumentFile({ kind: outline.kind, outline, outputDirectory: root, now: '20260901120000' });
      const bytes = await readFile(generated.temporaryPath);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const metadata = await stat(generated.temporaryPath);
      expect(metadata.size).toBe(generated.sizeBytes);
      const zip = await JSZip.loadAsync(bytes);
      const requiredPart = outline.kind === 'word' ? 'word/document.xml' : outline.kind === 'excel' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
      expect(zip.file(requiredPart)).toBeTruthy();
      const candidate: DocumentPublishCandidate = {
        kind: outline.kind,
        fileName: generated.fileName,
        temporaryHandle: `${outline.kind}-temporary`,
        finalHandle: `${outline.kind}-final`,
        sizeBytes: generated.sizeBytes,
        checksumSha256: checksum,
        expectedRevision: 0,
        idempotencyKey: `${outline.kind}-e6-smoke`,
        contentFingerprint: `${outline.kind}-outline`,
        diagnosticsPassed: true
      };
      let published = false;
      const port: DocumentPublishPort = {
        readCurrentRevision: async () => 0,
        findByIdempotencyKey: async () => undefined,
        verifyTemporary: async () => ({ exists: true, sizeBytes: metadata.size, checksumSha256: checksum, packageValid: true }),
        publishAtomic: async () => { published = true; await rename(generated.temporaryPath, generated.finalPath); return { revision: 1 }; },
        registerWork: async () => ({ workId: `${outline.kind}-work`, idempotencyKey: candidate.idempotencyKey, checksumSha256: checksum, revision: 1 })
      };
      const result = await publishDocumentCandidate(candidate, port);
      expect(result.status).toBe('published');
      expect(published).toBe(true);
    }
  });
});
