import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DocumentGenerationRunner,
  NodeProjectStorage,
  JsonExecutionRepository,
  JsonTaskRepository,
  JsonWorkRepository,
  parseDocumentOutline,
  projectStoragePaths
} from '../../src/platform';
import { toProjectId } from '../../src/domain';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createProjectRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-doc-runner-'));
  temporaryRoots.push(root);
  return root;
}

const outline = parseDocumentOutline(
  JSON.stringify({
    kind: 'word',
    title: '项目周报',
    sections: [
      {
        heading: '本周进展',
        level: 1,
        blocks: [{ type: 'bullets', items: ['完成方案评审', '接入生成管线'] }]
      }
    ]
  })
);

describe('document generation runner', () => {
  it('creates task, execution, verified file and registered work', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-1');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z'
    });
    const result = await runner.run({
      kind: 'word',
      title: '项目周报',
      contentFingerprint: 'b'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-1',
      outline
    });
    expect(result.execution.state).toBe('completed');
    expect(result.execution.outputFileId).toBe(result.file.id);
    expect(result.execution.workId).toBe(result.work.id);
    expect(result.work.mediaKind).toBe('document');
    expect(result.work.fileId).toBe(result.file.id);
    expect(result.file.state).toBe('available');
    expect(result.file.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.file.sizeBytes).toBeGreaterThan(0);

    const storage = new NodeProjectStorage(rootDirectory);
    const tasks = new JsonTaskRepository(storage, projectId);
    const executions = new JsonExecutionRepository(storage);
    const works = new JsonWorkRepository(storage, projectId);
    expect((await tasks.get(result.task.id))?.submission.kind).toBe(
      'document_generation'
    );
    expect((await executions.get(result.execution.id))?.state).toBe('completed');
    expect((await works.get(result.work.id))?.mediaKind).toBe('document');
  });

  it('fails the execution without registering a work when generation cannot write', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-2');
    await mkdir(path.join(rootDirectory, 'files'), { recursive: true });
    await writeFile(path.join(rootDirectory, 'files', 'documents'), 'not-a-dir');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z'
    });
    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: 'c'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-2',
        outline
      })
    ).rejects.toThrow();
    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    const persisted = await storage.readJson<{
      readonly entities: readonly { readonly state?: string }[];
    }>(projectStoragePaths.entities.executions);
    expect(persisted?.entities).toHaveLength(1);
    expect(persisted?.entities[0].state).toBe('failed');
    expect(await works.list(projectId)).toHaveLength(0);
  });
});
