import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId, type DocumentOutline } from '../../src/domain';
import { buildDocumentIRFromOutline } from '../../src/domain/entities/document-agent';
import { buildFallbackPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { generateTemporaryDocumentFile, type GenerateDocumentFileInput } from '../../src/platform/documents/office-document-generator';
import type { PresentationDesignCompilationSnapshot } from '../../src/platform/documents/presentation-render-plan-compiler';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const outline: DocumentOutline = { kind: 'ppt', title: 'Synthetic product brief', sections: [{
  heading: 'Measurable impact', level: 1, takeaway: 'The pilot delivers measurable improvement',
  blocks: [{ type: 'bullets', items: ['Throughput improved by 42%', 'Cost reduced by 18%'] }]
}] };

async function run(response: unknown, cancel = false) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-art-production-'));
  roots.push(rootDirectory);
  const controller = new AbortController();
  const requestArtDirection = vi.fn(async () => { if (cancel) controller.abort(); return response; });
  const writes: GenerateDocumentFileInput[] = [];
  const snapshots: PresentationDesignCompilationSnapshot[] = [];
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId: toProjectId('design-production'),
    generateTemporaryFile: async input => { writes.push(input); return generateTemporaryDocumentFile({ ...input,
      onDesignCompiled: async snapshot => { snapshots.push(snapshot); await input.onDesignCompiled?.(snapshot); } }); } });
  const result = runner.run({ kind: 'ppt', title: outline.title, outline,
    documentIR: buildDocumentIRFromOutline({ outline, operation: 'create' }),
    userRequirement: 'Emphasize the second metric, with generous whitespace',
    contentFingerprint: createHash('sha256').update(JSON.stringify(outline)).digest('hex'), draftRevision: 1, sourceDraftId: 'synthetic-outline',
    signal: controller.signal, requestArtDirection });
  return { rootDirectory, result, writes, snapshots, requestArtDirection };
}

describe('Art Direction to real PPTX production wiring', () => {
  it('passes validated Design IR through Runner into writer before Hash/Work publication', async () => {
    const ir = buildFallbackPresentationDesignIR(outline);
    const data = await run(JSON.stringify(ir));
    const result = await data.result;
    expect(data.requestArtDirection).toHaveBeenCalledTimes(1);
    expect(data.writes).toHaveLength(1);
    expect(data.writes[0].designIR).toEqual(ir);
    expect(result.execution.state).toBe('completed');
    if (result.file.locator.kind !== 'project') throw new Error('Expected project file');
    const buffer = await readFile(path.join(data.rootDirectory, result.file.locator.relativePath));
    expect(createHash('sha256').update(buffer).digest('hex')).toBe(result.file.checksumSha256);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(xml).toContain('42%');
    expect(xml).toContain('18%');
  });

  it('an invalid Design IR still creates and registers a valid legacy PPTX', async () => {
    const data = await run('{truncated');
    const result = await data.result;
    expect(data.writes).toHaveLength(1);
    expect(data.writes[0].designIR).toBeUndefined();
    expect(data.snapshots[0]).toMatchObject({ designPath: 'legacy-fallback', artDirectionStatus: 'invalid', designIrStatus: 'invalid' });
    expect(data.snapshots[0]?.diagnostics.map(item => item.code)).toContain('invalid_json');
    expect(result.execution.state).toBe('completed');
    expect(result.file.state).toBe('available');
    expect(result.work.fileId).toBe(result.file.id);
  });

  it('cancel during Art Direction prevents writer and publication', async () => {
    const data = await run(buildFallbackPresentationDesignIR(outline), true);
    await expect(data.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(data.writes).toEqual([]);
  });
});
