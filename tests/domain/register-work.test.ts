import { describe, expect, it } from 'vitest';
import {
  createFileReference,
  registerWork,
  toFileReferenceId,
  toWorkId,
  transitionExecution,
  transitionFile,
  WorkRegistrationRejectedError
} from '../../src/domain';
import {
  createLinkedExecutionFixture,
  t3,
  t4,
  t5,
  t6,
  t7
} from './fixtures';

function createAvailableFile() {
  const { execution, task } = createLinkedExecutionFixture();
  const pending = createFileReference({
    id: toFileReferenceId('file-work'),
    projectId: task.projectId,
    sourceExecutionId: execution.id,
    locator: { kind: 'project', relativePath: 'works/result.png' },
    createdAt: t3
  });
  const writing = transitionFile(pending, 'writing', t4);
  const verifying = transitionFile(writing, 'verifying', t5);
  const file = transitionFile(verifying, 'available', t6, {
    sizeBytes: 2048,
    checksumSha256: 'b'.repeat(64)
  });

  return { execution, file, task };
}

describe('work registration', () => {
  it('rejects a remote-completed execution before local completion', () => {
    const { execution, file, task } = createAvailableFile();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const processing = transitionExecution(submitting, 'processing', t4);
    const remoteCompleted = transitionExecution(
      processing,
      'remote_completed',
      t5
    );

    expect(() =>
      registerWork({
        id: toWorkId('work-1'),
        task,
        execution: remoteCompleted,
        file,
        mediaKind: 'image',
        name: 'Result',
        createdAt: t7
      })
    ).toThrow(WorkRegistrationRejectedError);
  });

  it('registers a work only after execution and file verification complete', () => {
    const { execution, file, task } = createAvailableFile();
    const submitting = transitionExecution(execution, 'submitting', t3);
    const processing = transitionExecution(submitting, 'processing', t4);
    const remoteCompleted = transitionExecution(
      processing,
      'remote_completed',
      t5
    );
    const downloading = transitionExecution(
      remoteCompleted,
      'downloading',
      t6
    );
    const writing = transitionExecution(downloading, 'writing', t7);
    const verifying = transitionExecution(writing, 'verifying', t7);
    const completed = transitionExecution(verifying, 'completed', t7);
    const work = registerWork({
      id: toWorkId('work-1'),
      task,
      execution: completed,
      file,
      mediaKind: 'image',
      name: 'Result',
      createdAt: t7
    });

    expect(work.fileId).toBe(file.id);
    expect(work.sourceExecutionId).toBe(completed.id);
    expect(work.sourceTaskId).toBe(task.id);
  });

  it('registers a locally produced work while execution is registering_work', () => {
    const { execution, file, task } = createAvailableFile();
    const queued = transitionExecution(execution, 'queued', t3);
    const validating = transitionExecution(queued, 'validating_sources', t3);
    const preparing = transitionExecution(validating, 'preparing_media', t3);
    const encoding = transitionExecution(preparing, 'encoding', t3);
    const writingFile = transitionExecution(encoding, 'writing_file', t3);
    const verifyingFile = transitionExecution(writingFile, 'verifying_file', t3);
    const registering = transitionExecution(verifyingFile, 'registering_work', t3, {
      outputFileId: file.id
    });
    const work = registerWork({
      id: toWorkId('work-local-document'),
      task,
      execution: registering,
      file,
      mediaKind: 'document',
      name: 'Report.docx',
      createdAt: t7
    });
    expect(work.mediaKind).toBe('document');
    expect(work.fileId).toBe(file.id);
  });
});
