import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ImageQuickWorkspace } from '../../src/pages/creation/image/ImageQuickWorkspace';
import { VideoQuickWorkspace } from '../../src/pages/creation/video/VideoQuickWorkspace';
import { GlobalNotificationProvider } from '../../src/ui/notifications/GlobalNotificationProvider';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import type { GenerationImageDraftDto } from '../../src/pages/creation/image/ImageGenerationControls';
import type { VideoWorkspaceDraftDto } from '../../src/shared/video-workspace-ipc';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/pages.css';

const ok = <T,>(value: T) => ({ ok: true as const, value });
let mode: 'image' | 'video' = 'image';
let key = 0;
let draft: GenerationImageDraftDto | VideoWorkspaceDraftDto;
let dirty = false;
let submits = 0;
let clears = 0;
let persisted = 0;
let release: (() => void) | undefined;
const time = '2026-09-24T00:00:00Z';
function candidate() {
  return { schemaVersion: 1, candidateId: 'fixture', modelName: 'Local fixture', providerName: 'Local', connectionName: 'Local',
    available: true, unavailableReasons: [], cost: { state: 'unknown' }, usageSchema: { schemaVersion: 1, schemaId: 'usage', revision: 1 },
    parameterSchema: { schemaVersion: 2, schemaId: 'schema', revision: 1, productFeature: mode === 'image' ? 'text_to_image' : 'text_to_video', fields: [] } };
}
async function heldSubmission() { submits++; await new Promise<void>(resolve => { release = resolve; }); }
const storage = {
  createWorkMediaHandle: async () => ({ ok: false, error: { code: 'media_unavailable', message: 'fixture' } }),
  listGenerationHistory: async () => ok({ items: [], activeItems: [], issues: [] }),
  onLocalStorageChanged: () => () => {}
};
const workspaces = {
  get: async () => ok(draft),
  update: async (value: typeof draft) => ok({ ...value, state: 'saved' }),
  list: async () => ok([draft])
};
window.unicomp = { storage, imageWorkspaces: workspaces, videoWorkspaces: workspaces,
  imageFeatures: { listCandidates: async () => ok([candidate()]),
    generateQuickImage: async () => { await heldSubmission(); return ok({ draftId: 'submitted-image', draftUpdatedAt: time,
      submission: { schemaVersion: 1, submissionIntentId: 'image-intent', status: 'completed', retryAllowed: false, taskId: 'image-task', workId: 'image-work' } }); } },
  videoFeatures: { listCandidates: async () => ok([candidate()]),
    prepareSubmission: async () => ok({ schemaVersion: 1, routeSelectionToken: 'local', confirmation: { confirmationId: 'local' } }),
    submitDraft: async () => { await heldSubmission(); return ok({ schemaVersion: 1, submissionIntentId: 'video-intent',
      status: 'provider_accepted', retryAllowed: false, taskId: 'video-task', executionId: 'video-execution' }); } }
} as unknown as typeof window.unicomp;
const root = createRoot(document.getElementById('root')!);
function render() {
  const props = { dirty, onMessage: () => {}, onFlushDraft: async () => true,
    onClearUi: () => { clears++; },
    onDraftChange: (next: typeof draft) => { draft = next; dirty = true; render(); },
    onDraftPersisted: (next: typeof draft) => { draft = next; dirty = false; persisted++; render(); } };
  flushSync(() => root.render(<ThemeProvider><RSuiteThemeBridge><GlobalNotificationProvider>
    <div style={{ height: 800, padding: 20 }}>
      {mode === 'image' ? <ImageQuickWorkspace key={key} {...props} draft={draft as GenerationImageDraftDto} />
        : <VideoQuickWorkspace key={key} {...props} draft={draft as Extract<VideoWorkspaceDraftDto, { mode: 'quick_video' }>} />}
    </div>
  </GlobalNotificationProvider></RSuiteThemeBridge></ThemeProvider>));
}
function configure(next: 'image' | 'video') {
  mode = next; key++; dirty = false; submits = 0; clears = 0; persisted = 0;
  draft = { schemaVersion: 1, draftId: `draft-${key}`, projectId: 'fixture', mode: mode === 'image' ? 'quick_image' : 'quick_video',
    state: 'saved', origin: { kind: 'new' }, createdAt: time, updatedAt: time, contextReferences: [], quick: {},
    prompt: { originalInput: 'Original prompt', finalPrompt: 'Original prompt', systemSupplements: [] },
    featureSelection: { productFeature: mode === 'image' ? 'text_to_image' : 'text_to_video', candidateId: 'fixture',
      parameterSchemaId: 'schema', parameterSchemaRevision: 1, parameterValues: {} },
    generation: { enhancement: { state: 'not_created', staleReasons: [] }, preflight: { state: 'not_created', staleReasons: [] } }
  } as unknown as typeof draft;
  render();
}
Object.assign(window, { submissionHarness: { configure, release: () => release?.(),
  state: () => ({ submits, clears, persisted, prompt: draft.prompt.originalInput }),
  unmount: () => flushSync(() => root.render(null)) } });
configure('image');
