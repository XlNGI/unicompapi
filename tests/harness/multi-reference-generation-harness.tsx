import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ImageProfessionalWorkspace } from '../../src/pages/creation/image/ImageProfessionalWorkspace';
import { VideoImageWorkspace } from '../../src/pages/creation/video/VideoImageWorkspace';
import { GlobalNotificationProvider } from '../../src/ui/notifications/GlobalNotificationProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import type { GenerationImageDraftDto } from '../../src/pages/creation/image/ImageGenerationControls';
import type { VideoWorkspaceDraftDto } from '../../src/shared/video-workspace-ipc';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/pages.css';
import '../../src/styles/rsuite-bridge.css';
import 'rsuite/dist/rsuite-no-reset.min.css';

const asset = (index: number) => ({
  assetId: `asset-${index}`,
  mediaKind: 'image' as const,
  name: `reference-${index}.png`,
  width: 100,
  height: 100
});
const preview = (color: string) => `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/></svg>`;
const basePrompt = { originalInput: '图1主体', finalPrompt: '图1主体', systemSupplements: [] };
const imageBase = {
  schemaVersion: 1, draftId: 'image-draft', projectId: 'project', mode: 'professional_image', state: 'saved',
  createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', prompt: basePrompt,
  featureSelection: { productFeature: 'reference_to_image', parameterValues: {} }, generation: {}, contextReferences: [],
  referenceImages: []
} as unknown as GenerationImageDraftDto;
type ImageVideoDraftDto = Extract<VideoWorkspaceDraftDto, { mode: 'image_to_video' }>;
const videoBase = {
  schemaVersion: 1, draftId: 'video-draft', projectId: 'project', mode: 'image_to_video', state: 'saved',
  createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', prompt: basePrompt,
  featureSelection: { productFeature: 'image_to_video', parameterValues: {} }, generation: {}, contextReferences: [],
  imageToVideo: { referenceImages: [], mustKeep: [], allowedChanges: [], prohibited: [], subjectAction: '', cameraMovement: '', pace: '', depthOfField: '' }
} as unknown as ImageVideoDraftDto;

let mode: 'image' | 'video' = 'image';
let imageDraft = structuredClone(imageBase);
let videoDraft = structuredClone(videoBase);
let imageSelection = 2;
let videoSelection = 2;
let message = '';
let imageCandidateCalls = 0;
let videoCandidateCalls = 0;
let videoPreviewTargets: number[] = [];
let importedVideoFile: { name: string; type: string } | undefined;
let savedRevision = 0;
const root = createRoot(document.getElementById('root')!);

const imageCandidate = { schemaVersion: 1, candidateId: 'image-candidate', modelName: 'Fixture image', providerName: 'Fixture', connectionName: 'Fixture', available: true, unavailableReasons: [], parameterSchema: { schemaVersion: 2, schemaId: 'fixture-image', revision: 1, productFeature: 'reference_to_image', fields: [] }, usageSchema: { schemaVersion: 1, schemaId: 'fixture-usage', revision: 1 }, cost: { state: 'unknown' } };
const videoCandidate = { schemaVersion: 1, candidateId: 'video-candidate', modelName: 'Fixture video', providerName: 'Fixture', connectionName: 'Fixture', available: true, unavailableReasons: [], parameterSchema: { schemaVersion: 2, schemaId: 'fixture-video', revision: 1, productFeature: 'image_to_video', fields: [] }, usageSchema: { schemaVersion: 1, schemaId: 'fixture-usage', revision: 1 }, cost: { state: 'unknown' } };
const result = <T,>(value: T) => ({ ok: true as const, value });

function render() {
  const imageWorkspaces = {
    get: async () => result(imageDraft),
    getInput: async () => result(imageDraft.referenceImages?.at(-1)),
    createInputPreview: async (_draftId: string, assetId?: string) => result({ url: preview(assetId?.includes('3') ? 'blue' : 'green') }),
    selectInput: async () => { const selected = asset(imageSelection++); return result({ cancelled: false, draft: { ...imageDraft, input: selected }, input: selected }); },
    importInput: async () => { const selected = asset(imageSelection++); return result({ cancelled: false, draft: { ...imageDraft, input: selected }, input: selected }); },
    useWorkAsInput: async () => { const selected = asset(imageSelection++); return result({ cancelled: false, draft: { ...imageDraft, input: selected }, input: selected }); },
    clearInput: async () => result(undefined),
    update: async (next: GenerationImageDraftDto) => { imageDraft = next; return result(next); },
    list: async () => result([])
  };
  const videoWorkspaces = {
    get: async () => result(videoDraft),
    getMaterial: async () => result({ name: videoDraft.imageToVideo.referenceImages?.at(-1)?.assetId ?? 'reference.png' }),
    createMaterialPreview: async (_draftId: string, target: { referenceIndex?: number }) => {
      const referenceIndex = target.referenceIndex ?? 0;
      videoPreviewTargets.push(referenceIndex);
      if (!videoDraft.imageToVideo.referenceImages?.[referenceIndex]) {
        return { ok: false as const, error: { code: 'material_not_found' as const, message: 'Reference image not found' } };
      }
      return result({ url: preview('green'), mediaKind: 'image' as const });
    },
    selectMaterial: async () => { const selected = asset(videoSelection++); return result({ cancelled: false, draft: { ...videoDraft, imageToVideo: { ...videoDraft.imageToVideo, source: selected } }, material: { name: selected.name } }); },
    importMaterial: async (_draftId: string, _target: unknown, _mediaKind: unknown, file: File) => { importedVideoFile = { name: file.name, type: file.type }; const selected = asset(videoSelection++); return result({ cancelled: false, draft: { ...videoDraft, imageToVideo: { ...videoDraft.imageToVideo, source: selected } }, material: { name: selected.name } }); },
    clearMaterial: async () => result(undefined),
    update: async (next: ImageVideoDraftDto) => { videoDraft = next; return result(next); },
    list: async () => result([])
  };
  const appWindow = window as unknown as { unicomp: unknown };
  appWindow.unicomp = {
    imageWorkspaces,
    videoWorkspaces,
    imageFeatures: { listCandidates: async () => { imageCandidateCalls += 1; return result([imageCandidate]); } },
    videoFeatures: { listCandidates: async () => { videoCandidateCalls += 1; return result([videoCandidate]); } },
    storage: { listGenerationHistory: async () => result({ items: [], activeItems: [], issues: [] }), onLocalStorageChanged: () => () => {}, getProjectSession: async () => result({ projectId: 'project', projectName: 'Fixture project' }) }
  };
  const shared = { dirty: false, onDraftChange: (next: GenerationImageDraftDto | ImageVideoDraftDto) => {
    // The production parent autosaves before candidate loading; this isolated host acknowledges that save.
    const saved = { ...next, state: 'saved' as const, updatedAt: new Date(Date.UTC(2026, 8, 28, 0, 0, ++savedRevision)).toISOString() };
    if (mode === 'image') imageDraft = saved as GenerationImageDraftDto; else videoDraft = saved as ImageVideoDraftDto;
    render();
  }, onDraftPersisted: (next: GenerationImageDraftDto | ImageVideoDraftDto) => { if (mode === 'image') imageDraft = next as GenerationImageDraftDto; else videoDraft = next as ImageVideoDraftDto; render(); }, onFlushDraft: async () => true, onMessage: (value: string) => { message = value; } };
  flushSync(() => root.render(
    <ThemeProvider><RSuiteThemeBridge><GlobalNotificationProvider>
      <div>
        {mode === 'image' ? <ImageProfessionalWorkspace {...shared} draft={imageDraft} /> : <VideoImageWorkspace {...shared} draft={videoDraft} />}
      </div>
    </GlobalNotificationProvider></RSuiteThemeBridge></ThemeProvider>
  ));
}

Object.assign(window, { multiReferenceHarness: {
  switchMode(next: 'image' | 'video') { mode = next; render(); },
  dropImage() {
    const zone = document.querySelector('.uc-video-image__workspace .uc-controlled-image-drop-zone');
    if (!zone) throw new Error('Image-to-video drop zone not found');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'drag-reference.png', { type: 'image/png' }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  },
  state: () => ({ mode, imageDraft, videoDraft, message, imageCandidateCalls, videoCandidateCalls, videoPreviewTargets, importedVideoFile })
} });
render();
