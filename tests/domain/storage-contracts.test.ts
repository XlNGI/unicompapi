import { describe, expect, it } from 'vitest';
import {
  createEmptyProjectFileIndex,
  findFileIndexEntry,
  toProjectRelativePath,
  upsertFileIndexEntry
} from '../../src/platform/storage';
import {
  InvariantViolationError,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';

const projectId = toProjectId('project-storage');
const fileA = toFileReferenceId('file-a');
const fileB = toFileReferenceId('file-b');
const updatedAt = toIsoTimestamp('2026-07-21T00:00:00.000Z');

describe('project storage contracts', () => {
  it('accepts only safe project-relative paths', () => {
    expect(toProjectRelativePath('files/image.png')).toBe('files/image.png');
    expect(toProjectRelativePath('files\\image.png')).toBe('files/image.png');

    expect(() => toProjectRelativePath('../outside.json')).toThrow(
      'safe project-relative path'
    );
    expect(() => toProjectRelativePath('/absolute/path.json')).toThrow(
      'safe project-relative path'
    );
    expect(() => toProjectRelativePath('C:/absolute/path.json')).toThrow(
      'safe project-relative path'
    );
  });

  it('keeps one file ID and one owner per indexed path', () => {
    const empty = createEmptyProjectFileIndex(projectId);
    const first = upsertFileIndexEntry(empty, {
      fileId: fileA,
      relativePath: toProjectRelativePath('files/a.png'),
      state: 'available',
      sizeBytes: 100,
      checksumSha256: 'a'.repeat(64),
      updatedAt
    });
    const replaced = upsertFileIndexEntry(first, {
      fileId: fileA,
      relativePath: toProjectRelativePath('files/a.png'),
      state: 'missing',
      updatedAt
    });

    expect(replaced.entries).toHaveLength(1);
    expect(findFileIndexEntry(replaced, fileA)?.state).toBe('missing');
    expect(() =>
      upsertFileIndexEntry(replaced, {
        fileId: fileB,
        relativePath: toProjectRelativePath('files/a.png'),
        state: 'available',
        updatedAt
      })
    ).toThrow(InvariantViolationError);
  });
});
