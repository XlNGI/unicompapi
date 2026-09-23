import { ImageQuickWorkspace } from '../../src/pages/creation/image/ImageQuickWorkspace';
import { ImageProfessionalWorkspace } from '../../src/pages/creation/image/ImageProfessionalWorkspace';
import { GlobalNotificationProvider } from '../../src/ui/notifications/GlobalNotificationProvider';
import '../../src/styles/pages.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ImageFeatureSubmissionPanel } from '../../src/pages/creation/image/ImageFeatureSubmissionPanel';
import type { GenerationImageDraftDto } from '../../src/pages/creation/image/ImageGenerationControls';
import type { ImageFeatureCandidateDto } from '../../src/shared/image-feature-ipc';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import { AppLayout } from '../../src/ui/layout/AppLayout';
import { ProjectStatusProvider } from '../../src/ui/status/ProjectStatusContext';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/rsuite-bridge.css';

let workspace = false;
let requests = 0;
let navigations = 0;
let flushes = 0;
let flushAllowed = true;
let mode = 'failed';
let sequence = 0;
let pending: ((value: unknown) => void) | undefined;
const candidate: ImageFeatureCandidateDto = {
  schemaVersion: 1, candidateId: 'candidate', modelName: 'Fixture image',
  providerName: 'Fixture', connectionName: 'Fixture', available: true, unavailableReasons: [],
  parameterSchema: { schemaVersion: 2, schemaId: 'fixture', revision: 1, productFeature: 'text_to_image', fields: [] },
  usageSchema: { schemaVersion: 1, schemaId: 'usage', revision: 1 }, cost: { state: 'unknown' }
};
const base = {
  schemaVersion: 1, draftId: 'draft', projectId: 'project', mode: 'quick_image', state: 'saved',
  createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z',
  prompt: { originalInput: 'A tree', finalPrompt: 'A tree', systemSupplements: [] },
  featureSelection: { productFeature: 'text_to_image', parameterValues: {} },
  generation: {}, contextReferences: []
} as unknown as GenerationImageDraftDto;
let draft = structuredClone(base);
let dirty = false;
let blockedReason: string | undefined;
let message = '';
window.unicomp = {
  imageFeatures: { listCandidates: async () => {
    requests++;
    if (mode === 'slow') return new Promise(resolve => { pending = resolve; });
    if (mode === 'throw') throw new Error('sk-secret /private/path');
    if (mode === 'failed') return { ok: false, error: { code: 'storage_error', message: 'sk-secret /private/path' } };
    return { ok: true, value: mode === 'empty' ? [] : [{
      ...candidate,
      parameterSchema: mode === 'parameters' ? { ...candidate.parameterSchema, fields: [{
        fieldId: 'count', labelId: 'count', order: 1, valueType: 'number',
        exposure: 'user', defaultPolicy: 'required', required: true, minimum: 1, maximum: 4
      }] } : candidate.parameterSchema,
      available: mode !== 'unavailable', unavailableReasons: mode === 'unavailable' ? ['connection_unavailable'] : []
    }] };
  } }, imageWorkspaces: {
    list: async () => ({ ok: true, value: [] }),
    getInput: async () => ({ ok: true, value: { assetId: 'image', fileName: 'reference.png', width: 64, height: 64 } }),
    createInputPreview: async () => ({ ok: true, value: { url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>' } })
  }
} as unknown as typeof window.unicomp;
const root = createRoot(document.getElementById('root')!);
function render() {
  const shared = {
    dirty, draft,
    onDraftChange: (next: GenerationImageDraftDto) => { draft = next; dirty = true; render(); },
    onDraftPersisted: (next: GenerationImageDraftDto) => { draft = next; dirty = false; render(); },
    onFlushDraft: async () => { flushes++; return flushAllowed; },
    onNavigateToProviders: () => { navigations++; },
    onMessage: (value: string) => { message = value; }
  };
  flushSync(() => root.render(
    <ThemeProvider><RSuiteThemeBridge><GlobalNotificationProvider><ProjectStatusProvider>
      <AppLayout activeItemId="image-creation" activeSubItemId={draft.mode === 'quick_image' ? 'quick-image' : 'professional-image'} onNavigate={() => {}} onSecondaryNavigate={() => {}}>
        {workspace ? (draft.mode === 'quick_image'
          ? <ImageQuickWorkspace {...shared} /> : <ImageProfessionalWorkspace {...shared} />) : (
        <div style={{ maxWidth: 620, margin: 24 }}>
          <h1>{draft.mode === 'quick_image' ? '快速生图' : '专业生图'}</h1>
          <ImageFeatureSubmissionPanel dirty={dirty} draft={draft} blockedReason={blockedReason}
            oneShot={draft.mode === 'quick_image'} showCandidateFacts={false}
            onDraftChange={next => { draft = next; dirty = true; render(); }}
            onFlushDraft={async () => { flushes++; return flushAllowed; }}
            {...{ onNavigateToProviders: () => { navigations++; } }}
            onMessage={value => { message = value; }} />
        </div>)}
      </AppLayout>
    </ProjectStatusProvider></GlobalNotificationProvider></RSuiteThemeBridge></ThemeProvider>
  ));
}
Object.assign(window, { imageHarness: {
  configure(input: { workspace?: boolean; professional?: boolean; response?: string; emptyPrompt?: boolean; reference?: boolean; image?: boolean; dirty?: boolean; blocked?: string; id?: string; selected?: boolean; flushAllowed?: boolean }) {
    workspace = input.workspace ?? false;
    mode = input.response ?? 'ready'; dirty = input.dirty ?? false; blockedReason = input.blocked;
    flushAllowed = input.flushAllowed ?? true;
    draft = { ...structuredClone(base), draftId: input.id ?? 'draft', mode: input.reference || input.professional ? 'professional_image' : 'quick_image',
      updatedAt: new Date(Date.parse(base.updatedAt) + ++sequence).toISOString(),
      prompt: { ...base.prompt, finalPrompt: input.emptyPrompt ? '' : 'A tree', originalInput: input.emptyPrompt ? '' : 'A tree' },
      ...(input.image ? { input: { assetId: 'image', mediaKind: 'image' } } : {}),
      featureSelection: { productFeature: input.reference ? 'reference_to_image' : 'text_to_image', parameterValues: {}, ...(input.selected ? { candidateId: 'candidate' } : {}) }
    } as GenerationImageDraftDto;
    render();
  }, response(value: string) { mode = value; }, resolve() { pending?.({ ok: true, value: [candidate] }); },
  state: () => ({ requests, navigations, flushes, message, draft })
} });
render();
