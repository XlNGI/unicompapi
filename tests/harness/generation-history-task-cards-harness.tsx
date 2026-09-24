import { createRoot } from 'react-dom/client';
import { GenerationHistory } from '../../src/components/GenerationHistory';
import type { StorageGenerationHistoryItemDto } from '../../src/shared/storage-ipc';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/pages.css';

const createdAt = '2026-09-24T00:00:00Z';
const makeWork = (id: string) => ({
  workId: id, projectId: 'fixture', name: id, mediaKind: 'image' as const,
  createdAt, verifiedAt: createdAt
});
let items: StorageGenerationHistoryItemDto[] = [
  { kind: 'task', taskId: 'single', createdAt, works: [makeWork('single-1')] },
  { kind: 'task', taskId: 'multi', createdAt: '2026-09-24T00:01:00Z', state: 'processing',
    occurredAt: '2026-09-24T00:02:00Z', works: [makeWork('multi-1'), makeWork('multi-2')] },
  { kind: 'task', taskId: 'empty', createdAt: '2026-09-24T00:02:00Z', state: 'processing',
    occurredAt: '2026-09-24T00:02:00Z', works: [] }
];
const listeners = new Set<() => void>();
let selectedWork: string | undefined;
let historyReads = 0;
let inFlight = 0;
let peak = 0;
let releaseRead: (() => void) | undefined;
let holdReads = false;
const colors = ['#285e8e', '#467b45', '#94622c'];
const media = (id: string) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="${colors[id.endsWith('2') ? 2 : id.startsWith('multi') ? 1 : 0]}"/></svg>`
);
window.unicomp = { storage: {
  listGenerationHistory: async (request: { cursor?: string; limit?: number }) => {
    historyReads++; inFlight++; peak = Math.max(peak, inFlight);
    if (holdReads) await new Promise<void>((resolve) => { releaseRead = resolve; });
    inFlight--;
    const active = (item: StorageGenerationHistoryItemDto) => item.state !== undefined && !['completed', 'failed', 'cancelled', 'expired'].includes(item.state);
    const activeItems = items.filter(active);
    const finished = items.filter(item=>!active(item)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.taskId.localeCompare(b.taskId));
    const offset = Number(request.cursor ?? 0);
    const limit = request.limit ?? 50;
    return { ok: true, value: { items: finished.slice(offset, offset + limit), activeItems,
      ...(finished.length > offset + limit ? { nextCursor: String(offset + limit) } : {}), issues: [] } };
  },
  onLocalStorageChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  createWorkMediaHandle: async (id: string) => ({ ok: true, value: { url: media(id), mediaKind: 'image' } })
} } as unknown as typeof window.unicomp;
const takeover = { current: false };
const root = createRoot(document.getElementById('root')!);
let expectedTaskId: string | undefined;
let scenario = 0;
function render(phase: 'idle' | 'waiting' = 'idle') { root.render(
  <div style={{ height: '100vh', padding: 24 }}>
    <GenerationHistory key={scenario} draftId="fixture" workspaceMode="quick_image" mediaKind="image"
      projectId={`fixture-${scenario}`} refreshKey={0} userTookOverRef={takeover} expectedTaskId={expectedTaskId}
      onWorkSelectionChange={(id) => { selectedWork = id; }} submissionProgress={{ phase }} />
  </div>
); }
render();
Object.assign(window, { historyHarness: {
  follow: () => {
    scenario++;
    takeover.current = false;
    expectedTaskId = 'accepted';
    items = [{ kind: 'task', taskId: 'accepted', createdAt, state: 'processing', occurredAt: createdAt, works: [] }];
    render('waiting');
  },
  generating: () => {
    takeover.current = false;
    expectedTaskId = undefined;
    render('waiting');
    listeners.forEach(listener => listener());
  },
  completeOldest: () => {
    items = items.map(item=>item.taskId==='stress-104' ? {...item,state:'completed',works:[makeWork('stress-result')]} : item);
    listeners.forEach(listener=>listener());
  },
  appendLatest: () => {
    items.push({kind:'task',taskId:'stress-105',createdAt:new Date(Date.UTC(2026,8,24,0,105)).toISOString(),state:'failed',works:[]});
    listeners.forEach(listener=>listener());
  },
  finish: (state: string) => {
    items = items.map(item => ({ ...item, state, works: state === 'completed' ? [makeWork('accepted-work')] : [] }));
    listeners.forEach(listener => listener());
  },
  selected: () => selectedWork,
  update: (state: string, addWork = false) => {
    items = items.map((item) => item.taskId === 'multi' ? {
      ...item, state, occurredAt: '2026-09-24T01:00:00Z',
      works: addWork ? [...item.works, makeWork('multi-3')] : item.works
    } : item);
    listeners.forEach((listener) => listener());
  },
  reset: () => {
    items = items.map((item) => item.taskId === 'multi' ? {
      ...item, state: 'processing', works: [makeWork('multi-1'), makeWork('multi-2')]
    } : item);
    listeners.forEach((listener) => listener());
  },
  many: () => {
    items = items.map((item) => item.taskId === 'multi' ? {
      ...item, works: Array.from({ length: 60 }, (_, i) => makeWork(`many-${String(i + 1).padStart(2, '0')}`))
    } : item);
    listeners.forEach((listener) => listener());
  },
  stress: () => {
    scenario++;
    items = Array.from({ length: 105 }, (_, index) => ({
      kind: 'task', taskId: `stress-${index}`, createdAt: new Date(Date.UTC(2026, 8, 24, 0, index)).toISOString(),
      state: index % 3 === 0 ? 'failed' : index > 99 ? 'processing' : 'completed', occurredAt: createdAt,
      works: index % 3 === 0 || index > 99 ? [] : [makeWork(`stress-work-${index}`)]
    }));
    historyReads = 0; peak = 0;
    render();
  },
  hold: () => { holdReads = true; historyReads = 0; peak = 0; },
  release: () => { holdReads = false; releaseRead?.(); },
  notify: () => listeners.forEach((listener) => listener()),
  reads: () => ({ historyReads, inFlight, peak })
} });
