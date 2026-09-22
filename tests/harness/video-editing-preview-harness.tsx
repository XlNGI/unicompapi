// Real editor and theme; only project/media IPC is replaced by isolated fixtures.
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { VideoEditingPage } from '../../src/pages/creation/video/VideoEditingPage';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import { useTheme } from '../../src/theme/useTheme';
import type { VideoEditorDraftDto } from '../../src/shared/video-editor-ipc';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/rsuite-bridge.css';

const fixtures = (window as unknown as { editingFixtures: { videos: string[]; sheets: string[] } }).editingFixtures;
const ok = <T,>(value: T) => ({ ok: true as const, value });
const timestamp = '2026-09-21T00:00:00.000Z';
let timeOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + timeOffset;
let failSheets = false;
let failVideos = false;
let revision = 0;
const requests: string[] = [];
const handles: string[] = [];
const navigation: string[] = [];
let writes = 0;
const sizes = [[180, 320], [320, 180], [240, 240]];
const draft: VideoEditorDraftDto = {
  schemaVersion: 1, kind: 'video_basic_edit', draftId: 'preview-draft', projectId: 'preview-project',
  title: '隔离预览验收', revision: 1, sourceIntent: { kind: 'blank' },
  canvas: { aspectRatio: { kind: 'source' }, transformPolicy: 'fit', background: { kind: 'solid', color: '#000000' } },
  videoTrack: sizes.map(([width, height], index) => ({
    clipId: `clip-${index}`, source: { fileId: `file-${index}`, identity: { sizeBytes: 10000, durationUs: 5_000_000, container: 'mp4', width, height } },
    sourceRange: { inUs: 0, outUs: 5_000_000 }, speed: { numerator: 1, denominator: 1 },
    transform: { scalePermille: 1000, positionXPermille: 0, positionYPermille: 0, rotationMilliDegrees: 0, flipX: false, flipY: false, crop: null },
    sourceAudio: { muted: false, volumePermille: 1000 }, transitionToNext: { kind: 'none' }
  })),
  removedClips: [], textTrack: [], backgroundMusic: null, cover: null,
  outputPreference: { container: { kind: 'auto' }, videoCodec: { kind: 'auto' }, audioCodec: { kind: 'auto' }, resolution: { kind: 'source' }, frameRate: { kind: 'source' }, quality: { kind: 'auto' }, hardwareAcceleration: 'software_only', conflictPolicy: 'create_unique_name' },
  canUndo: false, canRedo: false, createdAt: timestamp, updatedAt: timestamp
};
const originalDraft = JSON.stringify(draft);
const unavailable = () => ({ ok: false as const, error: { code: 'preview_unavailable', message: 'isolated failure' } });
const indexOf = (clipId: string) => Number(clipId.split('-')[1]);
const api = {
  storage: {
    getProjectSession: async () => ok({ projectId: draft.projectId, projectName: '隔离测试项目' }),
    listWorks: async () => ok({ items: [] }),
    listTasks: async () => ok({ items: [{ taskId: 'export-task', projectId: draft.projectId, kind: 'video_editing', createdAt: timestamp }] }),
    getTaskDetails: async () => ok({ sourceDraftId: draft.draftId }),
    createWorkMediaHandle: async () => ok({ url: fixtures.videos[0], mediaKind: 'video', mimeType: 'video/mp4', expiresAt: new Date(Date.now() + 300000).toISOString() }),
    revealWorkFile: async () => { navigation.push('reveal'); return ok(undefined); }
  },
  videoEditors: {
    list: async () => ok([draft]),
    getSourceStatus: async (_draftId: string, clipId: string) => ok({ clipId, state: 'available', issues: [], relinkRequired: false, referenceKind: 'managed_project_copy' }),
    getExport: async () => ok({ taskId: 'export-task', executionId: 'execution', attempt: 1, state: 'completed', canCancel: false, canRetry: false, workId: 'work', updatedAt: timestamp }),
    createSourcePreview: async (_draftId: string, clipId: string) => failVideos ? unavailable() : ok({ url: fixtures.videos[indexOf(clipId)], expiresAt: new Date(Date.now() + 300000).toISOString(), mimeType: 'video/mp4', kind: 'original' }),
    requestPreviewArtifact: async (_draftId: string, clipId: string) => {
      requests.push(clipId);
      if (failSheets) return unavailable();
      const bytes = Uint8Array.from(atob(fixtures.sheets[indexOf(clipId)]), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      handles.push(url);
      return ok({ url, expiresAt: new Date(Date.now() + 300000).toISOString(), mimeType: 'image/jpeg', kind: 'thumbnail_strip' });
    },
    clearPreviewCache: async () => ok(undefined),
    update: async () => { writes++; throw new Error('Unexpected draft write'); }
  }
};
window.unicomp = api as unknown as NonNullable<typeof window.unicomp>;
const root = createRoot(document.getElementById('root')!);
let setTheme: ((value: 'light' | 'dark') => void) | undefined;
function ThemeControl() {
  const { setPreference } = useTheme();
  useEffect(() => { setTheme = setPreference; }, [setPreference]);
  return null;
}
function mount() {
  root.render(<ThemeProvider><ThemeControl /><RSuiteThemeBridge><main style={{ height: '100vh', padding: 16 }}>
    <VideoEditingPage key={revision} onNavigate={item => navigation.push(item)} />
  </main></RSuiteThemeBridge></ThemeProvider>);
}
const harness = {
  state: () => ({ requests: [...requests], writes, navigation: [...navigation], draftUnchanged: JSON.stringify(draft) === originalDraft }),
  expire: () => { timeOffset += 301000; handles.splice(0).forEach(url => URL.revokeObjectURL(url)); },
  reset: (sheetsFail = false, videosFail = false) => { failSheets = sheetsFail; failVideos = videosFail; revision++; mount(); },
  theme: (value: 'light' | 'dark') => setTheme?.(value),
  video: (index: number) => fixtures.videos[index]
};
(window as unknown as { editingHarness: typeof harness }).editingHarness = harness;
mount();
