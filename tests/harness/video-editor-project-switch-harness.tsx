// Real App, title bar, navigation and editor; project/media IPC uses local fixtures.
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import { ProjectStatusProvider } from '../../src/ui/status/ProjectStatusContext';
import { notifyProjectSessionChanged } from '../../src/ui/project-session-events';
import type { VideoEditorDraftDto } from '../../src/shared/video-editor-ipc';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles/tokens.css';
import '../../src/styles.css';
import '../../src/styles/rsuite-bridge.css';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const timestamp = '2026-10-15T00:00:00Z';
const projects = ['A', 'B', 'Empty', 'Failed'].map(projectId => ({
  projectId, projectName: `Project ${projectId}`, availability: 'available'
}));
let currentProject: string | undefined = 'A';
let failedOpen = false;
let delayedList = false;
let delayedPreview = false;
const pending: Array<() => void> = [];
const listReads: string[] = [];
const media = new Map<string, string>();
const session = () => projects.find(project => project.projectId === currentProject);
const failure = { ok: false as const, error: { code: 'preview_unavailable', message: 'Fixture unavailable' } };

function draft(projectId: string): VideoEditorDraftDto {
  return {
    schemaVersion: 1, kind: 'video_basic_edit', draftId: `draft-${projectId}`, projectId,
    title: `Draft ${projectId}`, revision: 1, sourceIntent: { kind: 'blank' },
    canvas: { aspectRatio: { kind: 'source' }, transformPolicy: 'fit', background: { kind: 'solid', color: '#000000' } },
    videoTrack: [{
      clipId: `clip-${projectId}`, source: { fileId: `file-${projectId}`, identity: { sizeBytes: 1000, durationUs: 2_000_000, container: 'webm', width: 320, height: 180 } },
      sourceRange: { inUs: 0, outUs: 2_000_000 }, speed: { numerator: 1, denominator: 1 },
      transform: { scalePermille: 1000, positionXPermille: 0, positionYPermille: 0, rotationMilliDegrees: 0, flipX: false, flipY: false, crop: null },
      sourceAudio: { muted: true, volumePermille: 1000 }, transitionToNext: { kind: 'none' }
    }],
    removedClips: [], textTrack: [], backgroundMusic: null, cover: null,
    outputPreference: { container: { kind: 'auto' }, videoCodec: { kind: 'auto' }, audioCodec: { kind: 'auto' }, resolution: { kind: 'source' }, frameRate: { kind: 'source' }, quality: { kind: 'auto' }, hardwareAcceleration: 'software_only', conflictPolicy: 'create_unique_name' },
    canUndo: false, canRedo: false, createdAt: timestamp, updatedAt: timestamp
  };
}

const api = {
  storage: {
    getProjectSession: async () => ok(session()),
    listProjects: async () => ok(projects),
    openRecentProject: async (id: string) => {
      if (failedOpen) return { ok: false, error: { code: 'project_open_failed', message: 'Fixture open failed' } };
      currentProject = id;
      return ok({ session: session() });
    },
    listTasks: async () => ok({ items: [], issues: [] }),
    listWorks: async () => ok({ items: currentProject ? [{ workId: `work-${currentProject}`, projectId: currentProject,
      projectName: `Project ${currentProject}`, name: `Work ${currentProject}`, mediaKind: 'video', fileId: `file-${currentProject}`,
      fileState: 'available', createdAt: timestamp }] : [], issues: [] }),
    createWorkMediaHandle: async () => ok({ url: media.get(currentProject ?? ''), mediaKind: 'video', expiresAt: new Date(Date.now() + 300000).toISOString() }),
    getLocalStorageSummary: async () => ({ ok: false, error: { code: 'storage_error' } }),
    onLocalStorageChanged: () => () => {}
  },
  videoEditors: {
    list: async () => {
      const id = currentProject!;
      listReads.push(id);
      if (delayedList) { delayedList = false; await new Promise<void>(resolve => pending.push(resolve)); }
      return id === 'Failed' ? { ok: false, error: { code: 'draft_not_found' } } : ok(id === 'Empty' ? [] : [draft(id)]);
    },
    getSourceStatus: async (_draftId: string, clipId: string) => ok({ clipId, state: 'available', issues: [], relinkRequired: false, referenceKind: 'managed_project_copy' }),
    createSourcePreview: async (draftId: string) => {
      const id = draftId.replace('draft-', '');
      if (delayedPreview) { delayedPreview = false; await new Promise<void>(resolve => pending.push(resolve)); }
      return ok({ url: media.get(id), expiresAt: new Date(Date.now() + 300000).toISOString(), mimeType: 'video/webm', kind: 'original' });
    },
    requestPreviewArtifact: async () => failure
  }
};
window.unicomp = api as unknown as NonNullable<typeof window.unicomp>;

async function makeVideo(id: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d')!;
  const stream = canvas.captureStream(12);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => chunks.push(event.data);
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
  recorder.start();
  const timer = window.setInterval(() => {
    context.fillStyle = color; context.fillRect(0, 0, 320, 180);
    context.fillStyle = 'white'; context.font = '32px sans-serif'; context.fillText(`Project ${id}`, 70, 100);
  }, 60);
  await new Promise(resolve => setTimeout(resolve, 2200));
  recorder.stop(); await stopped; clearInterval(timer);
  stream.getTracks().forEach(track => track.stop());
  media.set(id, URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
}

const root = createRoot(document.getElementById('root')!);
const harness = {
  ready: false,
  state: () => ({ currentProject, listReads: [...listReads], pending: pending.length }),
  delayList: () => { delayedList = true; },
  delayPreview: () => { delayedPreview = true; },
  release: () => pending.splice(0).forEach(resolve => resolve()),
  failOpen: (value: boolean) => { failedOpen = value; },
  closeProject: () => { currentProject = undefined; notifyProjectSessionChanged(); },
  unmount: () => root.unmount(),
  media: (id: string) => media.get(id)
};
Object.assign(window, { projectSwitchHarness: harness });
void Promise.all([makeVideo('A', '#237359'), makeVideo('B', '#a05427')]).then(() => {
  root.render(<ThemeProvider><RSuiteThemeBridge><ProjectStatusProvider><App /></ProjectStatusProvider></RSuiteThemeBridge></ThemeProvider>);
  harness.ready = true;
});
