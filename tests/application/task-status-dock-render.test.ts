import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskReadSnapshot } from '../../src/ui/task-read-store';
import type * as TaskReadStore from '../../src/ui/task-read-store';
import { TaskStatusDock } from '../../src/ui/layout/TaskStatusDock';

const store = vi.hoisted(() => ({ snapshot: {} as TaskReadSnapshot }));
vi.mock('../../src/ui/task-read-store', async (importOriginal) => ({
  ...await importOriginal<typeof TaskReadStore>(),
  useTaskReadStore: () => store.snapshot
}));

function renderDock() {
  return renderToStaticMarkup(createElement(TaskStatusDock, {
    fallbackStatus: { label: '项目状态', content: '当前场景：对话', tone: 'neutral', role: 'status' },
    onNavigate: vi.fn()
  }));
}

beforeEach(() => {
  store.snapshot = {
    currentProjectId: 'project-test', loading: false, error: false, issues: [], revision: 1,
    tasks: [{ taskId: 'task-test', projectId: 'project-test', projectName: '测试项目',
      kind: 'video_generation', createdAt: new Date().toISOString(), executionCount: 1,
      latestExecutionState: 'processing' }]
  };
});

describe('task dock initial presentation', () => {
  it('starts collapsed without hiding page feedback behind background tasks', () => {
    const html = renderDock();
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('class="uc-task-status-panel"');
    expect(html).toContain('当前场景：对话');
    expect(html).toContain('任务中心');
  });

  it('does not report an empty result when the task read failed', () => {
    store.snapshot = { ...store.snapshot, currentProjectId: undefined, error: true };
    const html = renderDock();
    expect(html).toContain('任务状态读取失败');
    expect(html).not.toContain('无近期任务');
    expect(html).toContain('当前场景：对话');
  });

  it('distinguishes loading, no project, and a successfully read empty project', () => {
    store.snapshot = { ...store.snapshot, currentProjectId: undefined, loading: true, tasks: [] };
    expect(renderDock()).toContain('正在读取任务');
    store.snapshot = { ...store.snapshot, loading: false };
    expect(renderDock()).toContain('未打开项目');
    store.snapshot = { ...store.snapshot, currentProjectId: 'project-test' };
    expect(renderDock()).toContain('无近期任务');
  });

  it('uses a success summary for completed tasks without an attention warning', () => {
    store.snapshot = { ...store.snapshot, tasks: [{ ...store.snapshot.tasks[0], latestExecutionState: 'completed' }] };
    const html = renderDock();
    expect(html).toContain('近期完成 1');
    expect(html).toContain('uc-task-status-summary--success');
    expect(html).not.toContain('uc-task-status-summary__attention');
  });

  it('reports partial read issues instead of presenting an authoritative count', () => {
    store.snapshot = { ...store.snapshot, issues: [{ projectId: 'project-test', projectName: '测试项目', reason: 'invalid_data' }] };
    expect(renderDock()).toContain('任务数据不完整');
    expect(renderDock()).not.toContain('处理中 1');
  });

  it('does not show another project read issue as the current project failure', () => {
    store.snapshot = { ...store.snapshot, issues: [{ projectId: 'other-project', projectName: '其他项目', reason: 'unavailable' }] };
    expect(renderDock()).not.toContain('任务数据不完整');
  });
});
