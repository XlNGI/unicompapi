import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type * as ReactModule from 'react';
import type { VideoEditorDraftDto } from '../../src/shared/video-editor-ipc';

// Execute the component's actual effects and their cleanup without a browser,
// following the existing chat composer behavior harness. Hook positions are
// allocated by React call order; assertions only inspect IPC and rendered JSX.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[]
}));
vi.mock('react', async (original) => {
  type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
  function useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as EffectSlot | undefined;
    if (!previous || !deps || deps.some((value, at) => !Object.is(value, previous.deps?.[at]))) {
      const slot: EffectSlot = { deps };
      hooks.slots[index] = slot;
      hooks.effects.push(() => {
        previous?.cleanup?.();
        slot.cleanup = effect() ?? undefined;
      });
    }
  }
  return {
    ...await original<typeof ReactModule>(),
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.slots[index], (value: unknown) => {
        hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
      }];
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
      return hooks.slots[index];
    },
    useMemo(factory: () => unknown, deps?: readonly unknown[]) {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as { deps?: readonly unknown[]; value: unknown } | undefined;
      if (!previous || !deps || deps.some((value, at) => !Object.is(value, previous.deps?.[at]))) {
        hooks.slots[index] = { deps, value: factory() };
      }
      return (hooks.slots[index] as { value: unknown }).value;
    },
    useEffect,
    useLayoutEffect: useEffect
  };
});

import { VideoEditingPage } from '../../src/pages/creation/video/VideoEditingPage';

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children as ReactNode, predicate);
}

const session = { projectId: 'visibility-project', projectName: 'Visibility', projectPath: '/project' };
const draft: VideoEditorDraftDto = {
  schemaVersion: 1, kind: 'video_basic_edit', draftId: 'visibility-draft', projectId: session.projectId,
  title: 'Visible draft', revision: 1, sourceIntent: { kind: 'blank' },
  canvas: { aspectRatio: { kind: 'source' }, transformPolicy: 'fit', background: { kind: 'solid', color: '#000000' } },
  videoTrack: [], removedClips: [], textTrack: [], backgroundMusic: null, cover: null,
  outputPreference: {
    container: { kind: 'auto' }, videoCodec: { kind: 'auto' }, audioCodec: { kind: 'auto' },
    resolution: { kind: 'source' }, frameRate: { kind: 'source' }, quality: { kind: 'auto' },
    hardwareAcceleration: 'software_only', conflictPolicy: 'create_unique_name'
  },
  canUndo: false, canRedo: false, createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z'
};

describe('video editor visibility effect behavior', () => {
  let tree: ReactElement;
  const getProjectSession = vi.fn();
  const listDrafts = vi.fn();
  const listWorks = vi.fn();
  const listTasks = vi.fn();

  async function settle(active: boolean, rounds = 8) {
    for (let turn = 0; turn < rounds; turn += 1) {
      hooks.cursor = 0;
      tree = VideoEditingPage({ active });
      hooks.effects.splice(0).forEach((effect) => effect());
      await Promise.resolve();
    }
  }
  function picker() {
    return find(tree, (element) => element.props['aria-label'] === '编辑草稿')!;
  }
  function saveStatus() {
    return find(tree, (element) => element.props['aria-live'] === 'polite')!.props.children;
  }

  beforeEach(() => {
    hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
    vi.resetAllMocks();
    getProjectSession.mockResolvedValue({ ok: true, value: session });
    listDrafts.mockResolvedValue({ ok: true, value: [draft] });
    listWorks.mockResolvedValue({ ok: true, value: { items: [] } });
    listTasks.mockResolvedValue({ ok: true, value: { items: [] } });
    vi.stubGlobal('window', {
      unicomp: {
        storage: { getProjectSession, listWorks, listTasks },
        videoEditors: { list: listDrafts }
      }
    });
  });
  afterEach(() => {
    for (const slot of hooks.slots) {
      if (slot && typeof slot === 'object' && 'cleanup' in slot && typeof slot.cleanup === 'function') slot.cleanup();
    }
    vi.unstubAllGlobals();
  });

  it('does not read the workspace while hidden, then loads and retains the selected draft when activated', async () => {
    await settle(false);
    expect(tree.props.hidden).toBe(true);
    expect(getProjectSession).not.toHaveBeenCalled();
    expect(listDrafts).not.toHaveBeenCalled();
    expect(listWorks).not.toHaveBeenCalled();
    await settle(true);
    expect(getProjectSession).toHaveBeenCalledTimes(1);
    expect(listDrafts).toHaveBeenCalledTimes(1);
    expect(listWorks).toHaveBeenCalledTimes(1);
    expect(picker().props.value).toBe(draft.draftId);
    expect(picker().props.data).toEqual([{ label: draft.title, value: draft.draftId }]);
    expect(saveStatus()).toContain('已自动保存');
    await settle(false);
    expect(getProjectSession).toHaveBeenCalledTimes(1);
    expect(picker().props.value).toBe(draft.draftId);
    await settle(true);
    expect(getProjectSession).toHaveBeenCalledTimes(2);
    expect(picker().props.value).toBe(draft.draftId);
  });

  it('ignores a session result after the page becomes hidden', async () => {
    let resolveSession!: (value: unknown) => void;
    getProjectSession.mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve; }));
    await settle(true);
    await settle(false);
    resolveSession({ ok: true, value: session });
    await settle(false);
    expect(getProjectSession).toHaveBeenCalledTimes(1);
    expect(listDrafts).not.toHaveBeenCalled();
    expect(listWorks).not.toHaveBeenCalled();
    expect(saveStatus()).toContain('读取中');
  });

  it('ignores late draft and work results after hiding instead of accepting a stale draft', async () => {
    let resolveDrafts!: (value: unknown) => void;
    listDrafts.mockImplementationOnce(() => new Promise((resolve) => { resolveDrafts = resolve; }));
    await settle(true);
    expect(listDrafts).toHaveBeenCalledTimes(1);
    await settle(false);
    resolveDrafts({ ok: true, value: [draft] });
    await settle(false);
    expect(listDrafts).toHaveBeenCalledTimes(1);
    expect(picker().props.value).toBeNull();
    expect(picker().props.data).toEqual([]);
    expect(listTasks).not.toHaveBeenCalled();
    expect(saveStatus()).toContain('读取中');
  });

  it('does not let an old request failure overwrite a successfully reactivated workspace', async () => {
    let rejectSession!: (reason: Error) => void;
    getProjectSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSession = reject; }));
    await settle(true);
    await settle(false);
    await settle(true);
    rejectSession(new Error('old read failed'));
    await settle(true);
    expect(picker().props.value).toBe(draft.draftId);
    expect(saveStatus()).toContain('已自动保存');
    expect(find(tree, (element) => element.props.children === '读取基础编辑工作区失败，请重试。')).toBeUndefined();
  });
});
