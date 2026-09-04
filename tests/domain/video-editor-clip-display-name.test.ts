import { describe, expect, it } from 'vitest';
import {
  resolveClipDisplayName
} from '../../src/pages/creation/video/VideoEditingPage';
import type { StorageWorkSummaryDto } from '../../src/shared/storage-ipc';

function makeWork(
  workId: string,
  name: string
): StorageWorkSummaryDto {
  return {
    createdAt: '2026-09-02T00:00:00.000Z',
    fileId: `file-${workId}`,
    fileState: 'available',
    mediaKind: 'video',
    name,
    projectId: 'project-1',
    projectName: '演示项目',
    workId
  };
}

function makeSource(fileId: string, workId?: string) {
  return {
    source: {
      fileId,
      ...(workId ? { workId } : {}),
      identity: {
        container: 'mp4',
        durationUs: 1_000_000,
        height: 1080,
        sizeBytes: 1_024,
        width: 1920
      }
    }
  };
}

const works = [makeWork('work-1', '海边日落成片'), makeWork('work-2', '城市夜景素材')];

describe('resolveClipDisplayName (V2-S4 片段可读命名)', () => {
  it('branch 1: 来源为当前项目视频作品时返回作品名', () => {
    expect(resolveClipDisplayName(makeSource('abc123', 'work-1'), 0, works)).toBe(
      '海边日落成片'
    );
    expect(resolveClipDisplayName(makeSource('def456', 'work-2'), 3, works)).toBe(
      '城市夜景素材'
    );
  });

  it('branch 2: 外部引用显示 片段 N · fileId 前 6 位短码', () => {
    expect(resolveClipDisplayName(makeSource('abc123xyz'), 0, works)).toBe(
      '片段 1 · abc123'
    );
    expect(resolveClipDisplayName(makeSource('zzzz99'), 4, works)).toBe(
      '片段 5 · zzzz99'
    );
  });

  it('branch 3: 无 fileId 短码可用时兜底 片段 N', () => {
    expect(resolveClipDisplayName(makeSource(''), 1, works)).toBe('片段 2');
  });

  it('workId 不在当前项目作品列表时回落到短码命名', () => {
    expect(
      resolveClipDisplayName(makeSource('abc123', 'work-missing'), 2, works)
    ).toBe('片段 3 · abc123');
  });
});
