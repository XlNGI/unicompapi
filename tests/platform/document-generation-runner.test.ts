import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { readOfficeDocumentStructureFromBuffer } from '../../src/platform/documents/office-document-tool-executor';
import {
  DocumentGenerationRunner,
  generateDocumentFile,
  NodeProjectStorage,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
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

async function pathExists(target: string | undefined): Promise<boolean> {
  if (!target) return false;
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function documentFiles(rootDirectory: string): Promise<readonly string[]> {
  try {
    return await readdir(path.join(rootDirectory, 'files', 'documents'));
  } catch {
    return [];
  }
}

async function persistedExecutionStates(
  rootDirectory: string
): Promise<readonly string[]> {
  const storage = new NodeProjectStorage(rootDirectory);
  const persisted = await storage.readJson<{
    readonly entities: readonly { readonly state?: string }[];
  }>(projectStoragePaths.entities.executions);
  return (persisted?.entities ?? []).map((execution) => execution.state ?? '');
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

const presentationOutline = parseDocumentOutline(
  JSON.stringify({
    kind: 'ppt',
    title: '同秒模板汇报',
    sections: [
      {
        heading: '模板路径必须独立',
        level: 1,
        blocks: [{ type: 'bullets', items: ['结论：两个作品不能共享文件。'] }]
      }
    ]
  })
);

const employeeSalaryOutline = parseDocumentOutline(
  JSON.stringify({
    kind: 'excel',
    title: '部门员工工资表（模板）',
    sections: [
      {
        heading: '工资明细',
        level: 1,
        blocks: [
          {
            type: 'table',
            header: [
              '序号',
              '姓名',
              '部门',
              '岗位',
              '基本工资',
              '绩效工资',
              '津贴',
              '应发合计',
              '社保扣款',
              '公积金扣款',
              '实发工资',
              '状态'
            ],
            rows: [
              [
                '1',
                '示例员工',
                '示例部门',
                '示例岗位',
                '待填写',
                '待填写',
                '待填写',
                '待填写',
                '待填写',
                '待填写',
                '待填写',
                '待确认'
              ]
            ]
          }
        ]
      }
    ]
  })
);

describe('document generation runner', () => {
  it('publishes exactly five PPT slides for three bounded body sections', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-exact-page-count');
    const exactOutline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '五页演示',
      sections: Array.from({ length: 3 }, (_, index) => ({
        heading: `正文 ${index + 1}`,
        level: 1,
        pageKind: 'insight',
        blocks: [{ type: 'bullets', items: [`结论：正文内容 ${index + 1}`] }]
      }))
    }));
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-09-04T00:00:00.000Z'
    });

    const result = await runner.run({
      kind: 'ppt',
      title: exactOutline.title,
      contentFingerprint: '8'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'ppt-exact-page-count',
      outline: exactOutline,
      requestedTotalPages: 5,
      presentationTemplate: 'work_report'
    });

    const finalPath = result.file.locator.kind === 'project'
      ? path.join(rootDirectory, result.file.locator.relativePath)
      : '';
    const zip = await JSZip.loadAsync(await readFile(finalPath));
    expect(Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/u.test(name)
    )).toHaveLength(5);
    expect(result.work.id).toBeDefined();
  });

  it('rejects an exact PPT page-count mismatch before publishing a work', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-page-count-mismatch');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-09-04T00:00:00.000Z'
    });

    await expect(runner.run({
      kind: 'ppt',
      title: presentationOutline.title,
      contentFingerprint: '9'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'ppt-page-count-mismatch',
      outline: presentationOutline,
      requestedTotalPages: 5,
      presentationTemplate: 'work_report'
    })).rejects.toMatchObject({ code: 'page_count_mismatch' });

    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      projectId
    );
    expect(await works.list(projectId)).toEqual([]);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('publishes a real scoped parent revision and preserves non-target sections', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-scoped-revision');
    const baseOutline = parseDocumentOutline(JSON.stringify({
      kind: 'word',
      title: '局部改稿',
      sections: [
        { heading: '第一章', level: 1, blocks: [{ type: 'paragraph', text: '保持不变' }] },
        { heading: '第二章', level: 1, blocks: [{ type: 'paragraph', text: '旧内容' }] }
      ]
    }));
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-09-01T00:00:00.000Z'
    });
    const base = await runner.run({
      kind: 'word',
      title: baseOutline.title,
      contentFingerprint: 'c'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'revision-base',
      outline: baseOutline
    });
    const revisedOutline = parseDocumentOutline(JSON.stringify({
      kind: 'word',
      title: '局部改稿',
      sections: [
        { heading: '第一章', level: 1, blocks: [{ type: 'paragraph', text: '保持不变' }] },
        { heading: '第二章', level: 1, blocks: [{ type: 'paragraph', text: '新内容' }] }
      ]
    }));
    const revised = await runner.run({
      kind: 'word',
      title: revisedOutline.title,
      contentFingerprint: 'd'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'revision-child',
      outline: revisedOutline,
      parentWorkId: base.work.id,
      revisionTargetSectionHeading: '第二章',
      revisionPatch: {
        operation: 'replace_section',
        target: { sectionIndex: 1, sectionHeading: '第二章' },
        replacement: revisedOutline.sections[1]
      }
    });
    expect(revised.work.parentWorkId).toBe(base.work.id);
    expect(revised.execution.state).toBe('completed');
    const childFile = revised.file.locator.kind === 'project'
      ? path.join(rootDirectory, revised.file.locator.relativePath)
      : '';
    expect(await pathExists(childFile)).toBe(true);
    expect(await documentFiles(rootDirectory)).toHaveLength(2);
  });

  it('authorizes every continuation slide in a scoped PPT section revision', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-ppt-continuation-revision');
    const section = (marker: string) => ({
      heading: '第二章',
      level: 1 as const,
      blocks: Array.from({ length: 18 }, (_, index) => ({
        type: 'bullets' as const,
        items: [`${marker} ${index + 1}`]
      }))
    });
    const baseOutline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '局部章节修订',
      sections: [section('旧内容')]
    }));
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-09-03T00:00:00.000Z'
    });
    const base = await runner.run({
      kind: 'ppt',
      title: baseOutline.title,
      contentFingerprint: 'e'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'ppt-continuation-base',
      outline: baseOutline
    });
    const baseFile = base.file.locator.kind === 'project'
      ? path.join(rootDirectory, base.file.locator.relativePath)
      : '';
    const baseStructure = await readOfficeDocumentStructureFromBuffer({
      buffer: await readFile(baseFile),
      kind: 'ppt',
      displayName: base.work.name
    });
    expect(baseStructure.sections.length).toBeGreaterThanOrEqual(5);
    expect(
      baseStructure.sections.slice(2, 5).map((slide) => slide.heading)
    ).toEqual(['第二章', '第二章', '第二章']);

    const revisedOutline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: baseOutline.title,
      sections: [section('新内容')]
    }));
    const revised = await runner.run({
      kind: 'ppt',
      title: revisedOutline.title,
      contentFingerprint: 'f'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'ppt-continuation-revision',
      outline: revisedOutline,
      parentWorkId: base.work.id,
      revisionTargetSectionHeading: '第二章',
      revisionPatch: {
        operation: 'replace_section',
        target: { sectionIndex: 0, sectionHeading: '第二章', pageNumber: 3 },
        replacement: revisedOutline.sections[0]
      }
    });

    expect(revised.work.parentWorkId).toBe(base.work.id);
    expect(revised.execution.state).toBe('completed');
    expect(await documentFiles(rootDirectory)).toHaveLength(2);
  });

  it('fails closed instead of rebuilding when a scoped parent Work is missing', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-missing-parent');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-09-02T00:00:00.000Z'
    });
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'word',
      title: '失效父版本',
      sections: [{ heading: '第一章', level: 1, blocks: [{ type: 'paragraph', text: '新内容' }] }]
    }));

    await expect(runner.run({
      kind: 'word',
      title: outline.title,
      contentFingerprint: 'a'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'missing-parent',
      outline,
      parentWorkId: 'work-does-not-exist' as never,
      revisionTargetSectionHeading: '第一章',
      revisionPatch: {
        operation: 'replace_section',
        target: { sectionIndex: 0, sectionHeading: '第一章' },
        replacement: outline.sections[0]
      }
    })).rejects.toMatchObject({ code: 'storage_error' });
    expect(await documentFiles(rootDirectory)).toEqual([]);
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['failed']);
  });

  it('accepts a table-based Excel workbook whose title differs from its sheet heading', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-excel-title-sheet');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-28T15:36:00.000Z'
    });

    const result = await runner.run({
      kind: 'excel',
      title: employeeSalaryOutline.title,
      contentFingerprint: '4'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-employee-salary',
      outline: employeeSalaryOutline
    });

    expect(result.execution.state).toBe('completed');
    expect(result.work.name).toContain('部门员工工资表');
    expect(await documentFiles(rootDirectory)).toEqual([result.work.name]);
  });

  it('rejects an otherwise valid Excel workbook that omits a required table header', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-excel-missing-header');
    const changed = JSON.parse(JSON.stringify(employeeSalaryOutline));
    changed.sections[0].blocks[0].header[11] = '备注';
    const missingHeaderOutline = parseDocumentOutline(JSON.stringify(changed));
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-28T15:36:00.000Z',
      generateTemporaryFile: async (input) => {
        const generated = await generateDocumentFile({
          ...input,
          outline: missingHeaderOutline
        });
        const temporaryPath = `${generated.absolutePath}.tmp`;
        await rename(generated.absolutePath, temporaryPath);
        return {
          fileName: generated.fileName,
          temporaryPath,
          finalPath: generated.absolutePath,
          sizeBytes: generated.sizeBytes
        };
      }
    });

    await expect(
      runner.run({
        kind: 'excel',
        title: employeeSalaryOutline.title,
        contentFingerprint: '5'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-missing-header',
        outline: employeeSalaryOutline
      })
    ).rejects.toMatchObject({
      code: 'verification_failed',
      message: 'Generated document is missing required document content'
    });
    const storage = new NodeProjectStorage(rootDirectory);
    const persisted = await storage.readJson<{
      readonly entities: readonly {
        readonly state: string;
        readonly failure?: { readonly stage: string };
      }[];
    }>(projectStoragePaths.entities.executions);
    expect(persisted?.entities[0]).toMatchObject({
      state: 'failed',
      failure: { stage: 'verifying_file' }
    });
    expect(
      await new JsonWorkRepository(storage, projectId).list(projectId)
    ).toEqual([]);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

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

  it('closes cancellation before work registration begins', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-cancellation-boundary');
    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    let workCountAtBoundary: number | undefined;
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z'
    });

    await runner.run({
      kind: 'word',
      title: 'Cancellation boundary',
      contentFingerprint: '9'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-cancellation-boundary',
      outline,
      onCancellationClosed: async () => {
        workCountAtBoundary = (await works.list(projectId)).length;
      }
    });

    expect(workCountAtBoundary).toBe(0);
    expect(await works.list(projectId)).toHaveLength(1);
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

  it('cancels before temporary output is written without creating a work or file', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-cancel-before-write');
    const abortController = new AbortController();
    abortController.abort();
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z'
    });

    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: 'd'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-cancel-before-write',
        outline,
        signal: abortController.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' });

    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['cancelled']);
    expect(await works.list(projectId)).toHaveLength(0);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('cleans temporary output when cancelled after writing and before verification', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-cancel-after-write');
    const abortController = new AbortController();
    let temporaryPath: string | undefined;
    let finalPath: string | undefined;
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      generateTemporaryFile: async (input) => {
        const generated = await generateDocumentFile(input);
        temporaryPath = `${generated.absolutePath}.tmp`;
        finalPath = generated.absolutePath;
        await rename(generated.absolutePath, temporaryPath);
        abortController.abort();
        return {
          fileName: generated.fileName,
          temporaryPath,
          finalPath,
          sizeBytes: generated.sizeBytes
        };
      }
    });

    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: 'e'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-cancel-after-write',
        outline,
        signal: abortController.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' });

    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['cancelled']);
    expect(await works.list(projectId)).toHaveLength(0);
    expect(await pathExists(temporaryPath)).toBe(false);
    expect(await pathExists(finalPath)).toBe(false);
  });

  it('removes the registered file and final output when cancelled before work registration', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-cancel-after-file-registration');
    const abortController = new AbortController();
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      afterFileRegistered: () => abortController.abort()
    });

    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: 'a'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-cancel-after-file-registration',
        outline,
        signal: abortController.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' });

    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    const files = new JsonFileReferenceRepository(storage, projectId);
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['cancelled']);
    expect(await works.list(projectId)).toEqual([]);
    expect(await files.list(projectId)).toEqual([]);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('removes temporary and final output when atomic publication fails', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-publish-failure');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      publishFile: async () => {
        throw new Error('simulated atomic replace failure');
      }
    });

    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: 'f'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-publish-failure',
        outline
      })
    ).rejects.toThrow('simulated atomic replace failure');

    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['failed']);
    expect(await works.list(projectId)).toHaveLength(0);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('rejects a generated file that is not the expected Office package type', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-invalid-package');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      generateTemporaryFile: async (input) => {
        await mkdir(input.outputDirectory, { recursive: true });
        const fileName = '无效文档-20260822100000.docx';
        const finalPath = path.join(input.outputDirectory, fileName);
        const temporaryPath = `${finalPath}.tmp`;
        await writeFile(temporaryPath, 'not-an-office-package');
        return {
          fileName,
          temporaryPath,
          finalPath,
          sizeBytes: Buffer.byteLength('not-an-office-package')
        };
      }
    });

    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: '1'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-invalid-package',
        outline
      })
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['failed']);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('rejects a valid OOXML shell that omits the requested key content', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-empty-shell');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      generateTemporaryFile: async (input) => {
        await mkdir(input.outputDirectory, { recursive: true });
        const fileName = '空壳文档-20260822100000.docx';
        const finalPath = path.join(input.outputDirectory, fileName);
        const temporaryPath = `${finalPath}.tmp`;
        const zip = new JSZip();
        zip.file('word/document.xml', '<w:document><w:p>空白</w:p></w:document>');
        const content = await zip.generateAsync({ type: 'nodebuffer' });
        await writeFile(temporaryPath, content);
        return {
          fileName,
          temporaryPath,
          finalPath,
          sizeBytes: content.byteLength
        };
      }
    });

    await expect(
      runner.run({
        kind: 'word',
        title: outline.title,
        contentFingerprint: '3'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-empty-shell',
        outline
      })
    ).rejects.toMatchObject({ code: 'verification_failed' });
    const works = new JsonWorkRepository(
      new NodeProjectStorage(rootDirectory),
      projectId
    );
    expect(await works.list(projectId)).toEqual([]);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('rejects and removes a final file whose bytes changed during publication', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-checksum-mismatch');
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      publishFile: async (temporaryPath, finalPath) => {
        await rename(temporaryPath, finalPath);
        await writeFile(finalPath, 'tampered', { flag: 'a' });
      }
    });

    await expect(
      runner.run({
        kind: 'word',
        title: '项目周报',
        contentFingerprint: '2'.repeat(64),
        draftRevision: 1,
        sourceDraftId: 'response-draft-checksum-mismatch',
        outline
      })
    ).rejects.toMatchObject({ code: 'verification_failed' });
    const storage = new NodeProjectStorage(rootDirectory);
    const works = new JsonWorkRepository(storage, projectId);
    expect(await persistedExecutionStates(rootDirectory)).toEqual(['failed']);
    expect(await works.list(projectId)).toEqual([]);
    expect(await documentFiles(rootDirectory)).toEqual([]);
  });

  it('uses distinct final files for different PPT templates generated in the same second', async () => {
    const rootDirectory = await createProjectRoot();
    const projectId = toProjectId('doc-project-template-paths');
    let id = 0;
    const runner = new DocumentGenerationRunner({
      rootDirectory,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z',
      createId: () => `same-second-${id += 1}`
    });

    const workReport = await runner.run({
      kind: 'ppt',
      title: presentationOutline.title,
      contentFingerprint: '3'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-work-report',
      outline: presentationOutline,
      presentationTemplate: 'work_report'
    });
    const technology = await runner.run({
      kind: 'ppt',
      title: presentationOutline.title,
      contentFingerprint: '4'.repeat(64),
      draftRevision: 1,
      sourceDraftId: 'response-draft-technology',
      outline: presentationOutline,
      presentationTemplate: 'technology'
    });

    expect(workReport.file.locator).not.toEqual(technology.file.locator);
    expect(workReport.file.checksumSha256).not.toBe(
      technology.file.checksumSha256
    );
    expect(workReport.file.locator.kind).toBe('project');
    if (workReport.file.locator.kind === 'project') {
      expect(workReport.file.locator.relativePath).toMatch(
        /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pptx$/
      );
    }
    expect(await documentFiles(rootDirectory)).toHaveLength(2);
  });
});
