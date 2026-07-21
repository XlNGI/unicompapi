import { describe, expect, it } from 'vitest';
import {
  createFileReference,
  InvariantViolationError,
  toFileReferenceId,
  transitionFile
} from '../../src/domain';
import { createLinkedExecutionFixture, t3, t4, t5 } from './fixtures';

const checksum = 'a'.repeat(64);

describe('file state machine', () => {
  it('requires real verification metadata before a file is available', () => {
    const { execution, task } = createLinkedExecutionFixture();
    const pending = createFileReference({
      id: toFileReferenceId('file-1'),
      projectId: task.projectId,
      sourceExecutionId: execution.id,
      locator: { kind: 'project', relativePath: 'works/output.png' },
      createdAt: t3
    });
    const writing = transitionFile(pending, 'writing', t4);
    const verifying = transitionFile(writing, 'verifying', t5);

    expect(() => transitionFile(verifying, 'available', t5)).toThrow(
      InvariantViolationError
    );

    const available = transitionFile(verifying, 'available', t5, {
      sizeBytes: 1024,
      checksumSha256: checksum
    });

    expect(available.state).toBe('available');
    expect(available.sizeBytes).toBe(1024);
    expect(available.checksumSha256).toBe(checksum);
  });

  it('keeps missing and disconnected as recoverable states', () => {
    const { task } = createLinkedExecutionFixture();
    const pending = createFileReference({
      id: toFileReferenceId('external-file'),
      projectId: task.projectId,
      locator: { kind: 'external', absolutePath: 'X:/media/input.png' },
      createdAt: t3
    });
    const disconnected = transitionFile(pending, 'disconnected', t4);
    const verifying = transitionFile(disconnected, 'verifying', t5);

    expect(verifying.state).toBe('verifying');
  });
});
