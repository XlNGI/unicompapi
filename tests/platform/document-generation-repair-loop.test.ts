import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DocumentGenerationRunner,
  generateTemporaryDocumentFile,
  JsonWorkRepository,
  NodeProjectStorage,
  parseDocumentOutline
} from '../../src/platform';
import { toProjectId } from '../../src/domain';
import type { DocumentGenerationProgressEvent } from '../../src/application/document-generation-service';

const outline = parseDocumentOutline(JSON.stringify({
  kind: 'ppt',
  title: '修正闭环',
  sections: [{
    heading: '质量检查',
    level: 1,
    blocks: [{ type: 'bullets', items: ['第一项', '第二项'] }]
  }]
}));

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ppt-repair-'));
  roots.push(root);
  return root;
}

async function files(root: string): Promise<readonly string[]> {
  try {
    return await readdir(path.join(root, 'files', 'documents'));
  } catch {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('document generation bounded PPT repair loop', () => {
  it('regenerates and rerenders before publishing exactly one Work', async () => {
    const root = await createRoot();
    const projectId = toProjectId('ppt-repair-pass');
    const events: DocumentGenerationProgressEvent[] = [];
    const generatedPaths: string[] = [];
    let renderCount = 0;
    const generate = vi.fn(async (input: Parameters<typeof generateTemporaryDocumentFile>[0]) => {
      const result = await generateTemporaryDocumentFile(input);
      generatedPaths.push(result.temporaryPath);
      return result;
    });
    const runner = new DocumentGenerationRunner({
      rootDirectory: root,
      projectId,
      generateTemporaryFile: generate,
      renderPreview: async () => {
        renderCount += 1;
        return renderCount === 1
          ? { previewCount: 1, diagnostics: [{ code: 'text_overflow' as const, severity: 'error' as const, scope: 'page:2', message: 'overflow' }] }
          : { previewCount: 1, diagnostics: [] };
      },
    });

    const planner = vi.fn(async (request: {
      readonly expectedRevision: number;
      readonly attempt: number;
      readonly diagnostics: readonly { readonly code: string }[];
      readonly outline: typeof outline;
    }) => {
      expect(request.expectedRevision).toBe(1);
      expect(request.attempt).toBe(1);
      expect(request.diagnostics[0]?.code).toBe('text_overflow');
      expect(Object.isFrozen(request.outline)).toBe(true);
      return {
        kind: 'repair',
        diagnosisCodes: ['text_overflow'],
        operations: [{ operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'comparison' }],
        preserve: [],
        reason: 'use a roomier layout',
        expectedRevision: 1
      };
    });

    const result = await runner.run({
      kind: 'ppt',
      title: outline.title,
      contentFingerprint: 'a'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'draft-ppt-repair-pass',
      outline,
      requestRepair: planner,
      onProgress: event => { events.push(event); }
    });

    expect(result.execution.state).toBe('completed');
    expect(planner).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(renderCount).toBe(2);
    expect(await files(root)).toHaveLength(1);
    expect(await new JsonWorkRepository(new NodeProjectStorage(root), projectId).list(projectId)).toHaveLength(1);
    expect(await exists(generatedPaths[0]!)).toBe(false);
    expect(events.some(event => event.operationId === 'document-file-write:repair-1' && event.status === 'started')).toBe(true);
    expect(events.some(event => event.operationId === 'document-preview-render:repair-1' && event.status === 'completed')).toBe(true);
  });

  it('stops on repeated diagnostics and never publishes a failed candidate', async () => {
    const root = await createRoot();
    const projectId = toProjectId('ppt-repair-repeat');
    let renderCount = 0;
    const runner = new DocumentGenerationRunner({
      rootDirectory: root,
      projectId,
      renderPreview: async () => {
        renderCount += 1;
        return { previewCount: 1, diagnostics: [{ code: 'text_overflow' as const, severity: 'error' as const, scope: 'page:2', message: 'still overflowing' }] };
      }
    });
    const planner = vi.fn(async () => ({
      kind: 'repair', diagnosisCodes: ['text_overflow'],
      operations: [{ operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'comparison' }],
      preserve: [], reason: 'retry', expectedRevision: 1
    }));

    await expect(runner.run({
      kind: 'ppt', title: outline.title, contentFingerprint: 'b'.repeat(64), draftRevision: 1,
      sourceDraftId: 'draft-ppt-repair-repeat', outline, requestRepair: planner
    })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(renderCount).toBe(2);
    expect(await files(root)).toEqual([]);
    expect(await new JsonWorkRepository(new NodeProjectStorage(root), projectId).list(projectId)).toEqual([]);
  });

  it('fails closed on an unsupported content mutation without a second render', async () => {
    const root = await createRoot();
    const projectId = toProjectId('ppt-repair-allowlist');
    let renderCount = 0;
    const runner = new DocumentGenerationRunner({
      rootDirectory: root,
      projectId,
      renderPreview: async () => {
        renderCount += 1;
        return { previewCount: 1, diagnostics: [{ code: 'text_overflow' as const, severity: 'error' as const, scope: 'page:2', message: 'overflow' }] };
      }
    });

    await expect(runner.run({
      kind: 'ppt', title: outline.title, contentFingerprint: 'c'.repeat(64), draftRevision: 1,
      sourceDraftId: 'draft-ppt-repair-allowlist', outline,
      requestRepair: async () => ({
        kind: 'repair', diagnosisCodes: ['text_overflow'],
        operations: [{ operation: 'replace_text', target: { sectionIndex: 0, blockIndex: 0 }, value: 'silently changed' }],
        preserve: [], reason: 'shrink text', expectedRevision: 1
      })
    })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(renderCount).toBe(1);
    expect(await files(root)).toEqual([]);
  });

  it('enforces the two-attempt cap when each repair produces a new diagnostic', async () => {
    const root = await createRoot();
    const projectId = toProjectId('ppt-repair-cap');
    let renderCount = 0;
    const planner = vi.fn(async (request: { readonly attempt: number; readonly expectedRevision: number }) => ({
      kind: 'repair', diagnosisCodes: [request.attempt === 1 ? 'text_overflow' : 'overlap'],
      operations: [{ operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: request.attempt === 1 ? 'comparison' : 'data' }],
      preserve: [], reason: `repair ${request.attempt}`, expectedRevision: request.expectedRevision
    }));
    const runner = new DocumentGenerationRunner({
      rootDirectory: root,
      projectId,
      renderPreview: async () => ({
        previewCount: 1,
        diagnostics: [{ code: renderCount++ === 0 ? 'text_overflow' as const : 'overlap' as const, severity: 'error' as const, scope: renderCount === 1 ? 'page:2' : 'page:3', message: 'blocked' }]
      })
    });

    await expect(runner.run({
      kind: 'ppt', title: outline.title, contentFingerprint: 'd'.repeat(64), draftRevision: 4,
      sourceDraftId: 'draft-ppt-repair-cap', outline, requestRepair: planner
    })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(planner).toHaveBeenCalledTimes(2);
    expect(renderCount).toBe(3);
    expect(await files(root)).toEqual([]);
  });

  it('times out a repair planner and leaves no published output', async () => {
    const root = await createRoot();
    const projectId = toProjectId('ppt-repair-timeout');
    const runner = new DocumentGenerationRunner({
      rootDirectory: root,
      projectId,
      renderPreview: async () => ({
        previewCount: 1,
        diagnostics: [{ code: 'text_overflow' as const, severity: 'error' as const, scope: 'page:2', message: 'overflow' }]
      })
    });
    await expect(runner.run({
      kind: 'ppt', title: outline.title, contentFingerprint: 'e'.repeat(64), draftRevision: 1,
      sourceDraftId: 'draft-ppt-repair-timeout', outline, repairTimeoutMs: 1,
      requestRepair: () => new Promise(() => undefined)
    })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(await files(root)).toEqual([]);
    expect(await new JsonWorkRepository(new NodeProjectStorage(root), projectId).list(projectId)).toEqual([]);
  });
});
