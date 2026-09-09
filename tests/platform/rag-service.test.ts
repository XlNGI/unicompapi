import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../src/domain';
import {
  AttachmentImportService,
  RagRetrievalService
} from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createProjectWithAttachment() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-rag-'));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-rag-src-'));
  temporaryRoots.push(root, sourceRoot);
  const projectId = toProjectId('rag-project');
  const sourcePath = path.join(sourceRoot, '调研.txt');
  await writeFile(
    sourcePath,
    '华东市场调研：本季度营收 3000 万，同比增长 18%，主要来自新产品线。',
    'utf8'
  );
  const importer = new AttachmentImportService({
    rootDirectory: root,
    projectId,
    now: () => '2026-08-23T00:00:00.000Z'
  });
  await importer.importAttachment({ sourcePath });
  return { root, projectId };
}

describe('RAG retrieval service', () => {
  it('retrieves relevant attachment chunks for a query', async () => {
    const { root, projectId } = await createProjectWithAttachment();
    const service = new RagRetrievalService({ rootDirectory: root, projectId });
    const chunks = await service.retrieve({ query: '华东营收 增长', k: 2 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].source).toContain('调研.txt');
    expect(chunks[0].text).toContain('3000 万');
  });

  it('returns no chunks when nothing matches', async () => {
    const { root, projectId } = await createProjectWithAttachment();
    const service = new RagRetrievalService({ rootDirectory: root, projectId });
    const chunks = await service.retrieve({ query: '不存在的关键词xyz', k: 2 });
    expect(chunks).toHaveLength(0);
  });
});
