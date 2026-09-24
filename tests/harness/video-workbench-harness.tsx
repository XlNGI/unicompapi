// Real workbench/components, isolated IPC fixtures. No provider or user-data access.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VideoWorkbenchPage } from '../../src/pages/creation/video/VideoWorkbenchPage';
import { videoCreationModes } from '../../src/pages/creation/creationModes';
import { flushRegisteredAutosaves } from '../../src/ui/autosave-flush-registry';
import { ProjectStatusProvider } from '../../src/ui/status/ProjectStatusContext';
import { AppLayout } from '../../src/ui/layout/AppLayout';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import type { VideoWorkspaceDraftDto } from '../../src/shared/video-workspace-ipc';
import type { VideoFeatureCandidateDto } from '../../src/shared/video-feature-ipc';
import { newApiDefaultTextToVideoParameterSchema } from '../../src/platform/providers/newapi/newapi-contracts';
import { uniCompApiSeedance2TextToVideoParameterSchema } from '../../src/platform/providers/newapi/unicompapi-model-capabilities';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/rsuite-bridge.css';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const timestamp = '2026-09-20T00:00:00.000Z';
const counters = { saves: 0, candidates: 0, history: 0, previews: 0, prepares: 0, closes: 0 };
let failCandidates = false;
let failSaves = false;
let preparedPrompt = '';
let revision = 0;
const drafts = new Map<string, VideoWorkspaceDraftDto>();
const textVideo = new URLSearchParams(location.search).has('parameters');
const candidates: VideoFeatureCandidateDto[] = ['H3 fixture', 'Seedance fixture'].map((modelName, i) => ({
  schemaVersion: 1, candidateId: `candidate-${i}`, providerName: 'Isolated fixture',
  connectionName: 'Local only', modelName, available: true, unavailableReasons: [],
  parameterSchema: textVideo
    ? (i === 0 ? newApiDefaultTextToVideoParameterSchema : uniCompApiSeedance2TextToVideoParameterSchema)
    : { schemaVersion: 2, schemaId: 'schema', revision: 1,
    productFeature: 'image_to_video', fields: [{ fieldId: 'duration', labelId: 'duration',
      order: 1, valueType: 'number', exposure: 'user', defaultPolicy: 'optional', required: false,
      minimum: 1, maximum: 60 }] },
  usageSchema: { schemaVersion: 1, schemaId: 'usage', revision: 1 }, cost: { state: 'unknown' }
}));

function makeDraft(id: string): VideoWorkspaceDraftDto {
  return {
    schemaVersion: 1, draftId: id, projectId: 'fixture-project', state: 'saved',
    origin: { kind: 'new' }, createdAt: timestamp, updatedAt: timestamp,
    prompt: { originalInput: textVideo ? 'Local video prompt' : '', finalPrompt: textVideo ? 'Local video prompt' : '', systemSupplements: [] },
    contextReferences: [], featureSelection: { productFeature: textVideo ? 'text_to_video' : 'image_to_video',
      candidateId: 'candidate-0', parameterSchemaId: candidates[0].parameterSchema.schemaId,
      parameterSchemaRevision: candidates[0].parameterSchema.revision,
      parameterValues: {} },
    generation: { enhancement: { state: 'not_created', staleReasons: [] },
      preflight: { state: 'not_created', staleReasons: [] } },
    ...(textVideo ? { mode: 'text_to_video' as const, textToVideo: { sourceKind: 'short_idea' as const, shots: [],
      storyboard: { state: 'not_created' as const, staleReasons: [], frameAssetIds: [] } } }
      : { mode: 'image_to_video' as const,
        imageToVideo: { source: { assetId: 'fixture-image', mediaKind: 'image' as const, role: 'source', selectedAt: timestamp },
          mustKeep: [], allowedChanges: [], prohibited: [], subjectAction: '', cameraMovement: '', pace: '', depthOfField: '' } })
  };
}

const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 180;
const context = canvas.getContext('2d')!;
context.fillStyle = '#227761';
context.fillRect(0, 0, 320, 180);
context.fillStyle = '#ffffff';
context.font = '24px sans-serif';
context.fillText('Local media fixture', 32, 100);
const imageUrl = canvas.toDataURL('image/png');
let videoUrl = '';

const api = {
  storage: {
    getProjectSession: async () => ok({ projectId: 'fixture-project', projectName: 'Workbench regression' }),
    listTasks: async () => ok({ items: [], issues: [] }),
    listGenerationHistory: async () => {
      counters.history++;
      return ok({ items: Array.from({ length: 10 }, (_, i) => ({ kind: 'task', taskId: `task-${i}`, createdAt: timestamp,
        state: 'completed', occurredAt: timestamp, works: [{ workId: `work-${i}`,
        projectId: 'fixture-project', name: `Video ${i}`, mediaKind: 'video', sourceTaskId: `task-${i}`,
        createdAt: timestamp, verifiedAt: timestamp }] })), activeItems: [], issues: [] });
    },
    onLocalStorageChanged: () => () => {},
    createWorkMediaHandle: async () => { counters.previews++; return ok({ url: videoUrl, mediaKind: 'video' }); }
  },
  settings: { getSnapshot: async () => ok({ values: { privacy: { readProjectContext: false, readSavedProjectChats: false } } }) },
  videoWorkspaces: {
    list: async () => ok([...drafts.values()]),
    get: async (id: string) => ok(drafts.get(id)),
    create: async () => {
      const draft = makeDraft(`draft-${drafts.size + 1}`);
      drafts.set(draft.draftId, draft);
      return ok(draft);
    },
    update: async (draft: VideoWorkspaceDraftDto) => {
      counters.saves++;
      if (failSaves) return { ok: false, error: { code: 'workspace_storage_error', message: 'fixture failure' } };
      const saved = { ...draft, updatedAt: new Date(Date.parse(timestamp) + ++revision).toISOString(), state: 'saved' as const };
      drafts.set(saved.draftId, saved);
      return ok(saved);
    },
    getMaterial: async () => ok({ assetId: 'fixture-image', name: 'Local image', mediaKind: 'image',
      width: 320, height: 180, mimeType: 'image/png', sizeBytes: 100, role: 'source', fileState: 'available', referenceKind: 'project' }),
    createMaterialPreview: async () => ok({ url: imageUrl, mediaKind: 'image', mimeType: 'image/png', expiresAt: timestamp })
  },
  videoFeatures: {
    listCandidates: async () => {
      counters.candidates++;
      return failCandidates ? { ok: false, error: { code: 'storage_error', message: 'fixture failure' } } : ok(structuredClone(candidates));
    },
    prepareSubmission: async (id: string) => {
      counters.prepares++;
      preparedPrompt = drafts.get(id)!.prompt.finalPrompt;
      // End at the local authorization gate. Never submit an external request.
      return { ok: false, error: { code: 'runtime_not_allowed', message: 'fixture boundary' } };
    }
  },
  autosaveDiagnostics: { record: () => {} },
  parameterInputDiagnostics: { record: () => {} },
  windowControls: { close: () => { counters.closes++; } }
};
window.unicomp = api as unknown as NonNullable<typeof window.unicomp>;
const root = createRoot(document.getElementById('root')!);
let mountKey = 0;
function mount(id = 'draft-1') {
  flushSync(() => root.render(<ThemeProvider><RSuiteThemeBridge><ProjectStatusProvider>
    <AppLayout activeItemId="video-creation" activeSubItemId={textVideo ? 'text-to-video' : 'image-to-video'} onNavigate={() => {}} onSecondaryNavigate={() => {}}>
      <VideoWorkbenchPage key={++mountKey} mode={videoCreationModes[textVideo ? 1 : 2]} preferredDraftId={id} />
    </AppLayout>
  </ProjectStatusProvider></RSuiteThemeBridge></ThemeProvider>));
}

const harness = {
  ready: false, counters, samples: [] as number[], longTasks: [] as number[],
  state: () => ({ counters, preparedPrompt, drafts: [...drafts.values()], samples: harness.samples }),
  flush: () => flushRegisteredAutosaves(1000),
  remount: mount,
  unmount: () => flushSync(() => root.render(null)),
  failCandidates: (value: boolean) => { failCandidates = value; },
  failSaves: (value: boolean) => { failSaves = value; },
  showFinal: () => {
    const current = drafts.get('draft-1')!;
    drafts.set('draft-1', { ...current, prompt: { ...current.prompt,
      systemSupplements: [{ source: 'enhancement', content: current.prompt.finalPrompt }] } });
    mount();
  }
};
Object.assign(window, { workbenchHarness: harness, workbenchRenders: 0 });
new PerformanceObserver((list) => {
  harness.longTasks.push(...list.getEntries().map((entry) => entry.duration));
}).observe({ type: 'longtask', buffered: true });
document.addEventListener('input', () => {
  const start = performance.now();
  // A rendering opportunity after React commits, not an OS display measurement.
  requestAnimationFrame(() => setTimeout(() => harness.samples.push(performance.now() - start), 0));
}, true);

async function start() {
  const stream = canvas.captureStream(10);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  videoUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  drafts.set('draft-1', makeDraft('draft-1'));
  mount();
  harness.ready = true;
}
void start();
