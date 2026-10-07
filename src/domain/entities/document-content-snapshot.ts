import {
  documentWorkspaceKinds, presentationPageKinds,
  type DocumentOutline, type DocumentOutlineBlock, type DocumentOutlineSection,
  type DocumentWorkspaceKind, type PresentationPageKind
} from './document-generation';
import { parsePresentationPageScene, type PresentationPageScene } from './presentation-plan';
import type { DocumentIRContent } from './document-agent';

/** Host-owned, lossless content. Positional outline paths are only current-view aliases. */
export interface DocumentContentBlock {
  readonly blockId: string;
  readonly payload: DocumentOutlineBlock;
  readonly atomIds: Readonly<Record<string, string>>;
  readonly sourceRefs: readonly string[];
  readonly preserve: readonly string[];
}

export interface DocumentContentSection {
  readonly sectionId: string;
  readonly headingId: string;
  readonly heading: string;
  readonly level: 1 | 2 | 3;
  readonly blocks: readonly DocumentContentBlock[];
  readonly pageKind?: PresentationPageKind;
  readonly takeaway?: string;
  readonly takeawayId?: string;
  readonly action?: string;
  readonly actionId?: string;
  readonly scene?: PresentationPageScene;
  readonly sceneContentIds?: Readonly<Record<string, string>>;
  readonly sourceRefs: readonly string[];
  readonly preserve: readonly string[];
}

export interface DocumentContentSnapshotV1 {
  readonly schemaVersion: 1;
  readonly identityScope: string;
  readonly revision: number;
  readonly nextIdentity: number;
  /** Includes deleted identities, so subsequent revisions cannot recycle them. */
  readonly issuedIds: readonly string[];
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly titleId: string;
  readonly sections: readonly DocumentContentSection[];
  readonly coverScene?: PresentationPageScene;
  readonly coverSceneContentIds?: Readonly<Record<string, string>>;
  readonly closingScene?: PresentationPageScene;
  readonly closingSceneContentIds?: Readonly<Record<string, string>>;
  readonly sourceRefs: readonly string[];
  readonly preserve: readonly string[];
  readonly styleConstraints: readonly string[];
  readonly pageCount?: number;
}

export interface DocumentContentResolvedRef {
  readonly id: string;
  readonly kind: 'title' | 'section' | 'heading' | 'block' | 'item' | 'cell' | 'chart_label' | 'chart_value' | 'scene_text';
  readonly sectionId?: string;
  readonly blockId?: string;
  readonly text?: string;
  readonly value?: number;
  readonly payload?: DocumentOutlineBlock;
}

const maxIdentities = 50_000;
const maxSerializedBytes = 8_000_000;

export function parseDocumentContentSnapshot(value: unknown): DocumentContentSnapshotV1 {
  const record = object(value, 'content snapshot');
  exact(record, ['schemaVersion', 'identityScope', 'revision', 'nextIdentity', 'issuedIds', 'kind', 'title', 'titleId',
    'sections', 'coverScene', 'coverSceneContentIds', 'closingScene', 'closingSceneContentIds', 'sourceRefs', 'preserve', 'styleConstraints', 'pageCount']);
  if (record.schemaVersion !== 1) throw new TypeError('unsupported content snapshot version');
  const identityScope = identity(record.identityScope);
  const kind = enumeration(record.kind, documentWorkspaceKinds);
  if (identityScope.length > 80) throw new TypeError('content identity scope is too long');
  const issuedIds = strings(record.issuedIds, maxIdentities, 128, false).map(identity);
  if (new Set(issuedIds).size !== issuedIds.length) throw new TypeError('duplicate issued identity');
  const nextIdentity = integer(record.nextIdentity, maxIdentities + 1);
  if (issuedIds.length !== nextIdentity - 1 || issuedIds.some((id, i) => id !== `${identityScope}:a${i + 1}`)) {
    throw new TypeError('issued identity history is invalid');
  }
  const active = new Set<string>();
  const issued = new Set(issuedIds);
  const claim = (raw: unknown): string => {
    const id = identity(raw);
    if (!issued.has(id) || active.has(id)) throw new TypeError('content identity is missing or duplicated');
    active.add(id);
    return id;
  };
  const sections = array(record.sections, 80, kind !== 'ppt').map((raw): DocumentContentSection => {
    const section = object(raw, 'section');
    exact(section, ['sectionId', 'headingId', 'heading', 'level', 'blocks', 'pageKind', 'takeaway', 'takeawayId',
      'action', 'actionId', 'scene', 'sceneContentIds', 'sourceRefs', 'preserve']);
    const level = integer(section.level, 3) as 1 | 2 | 3;
    const scene = optionalScene(section.scene);
    const blocks = array(section.blocks, 100).map((item): DocumentContentBlock => {
      const block = object(item, 'block');
      exact(block, ['blockId', 'payload', 'atomIds', 'sourceRefs', 'preserve']);
      const payload = parsePayload(block.payload);
      const atomIds = parseIdentityMap(block.atomIds, Object.keys(payloadAtoms(payload)), claim);
      return { blockId: claim(block.blockId), payload, atomIds,
        sourceRefs: strings(block.sourceRefs, 128, 240), preserve: strings(block.preserve, 64, 500) };
    });
    const takeaway = optionalText(section.takeaway, 2_000);
    const action = optionalText(section.action, 2_000);
    if ((takeaway === undefined) !== (section.takeawayId === undefined) || (action === undefined) !== (section.actionId === undefined)) {
      throw new TypeError('metadata text requires its content identity');
    }
    return { sectionId: claim(section.sectionId), headingId: claim(section.headingId), heading: text(section.heading, 240), level, blocks,
      ...(section.pageKind === undefined ? {} : { pageKind: enumeration(section.pageKind, presentationPageKinds) }),
      ...(takeaway === undefined ? {} : { takeaway, takeawayId: claim(section.takeawayId) }),
      ...(action === undefined ? {} : { action, actionId: claim(section.actionId) }),
      ...(scene === undefined ? rejectAbsentMap(section.sceneContentIds) : {
        scene, sceneContentIds: parseIdentityMap(section.sceneContentIds, Object.keys(sceneAtoms(scene)), claim)
      }), sourceRefs: strings(section.sourceRefs, 128, 240), preserve: strings(section.preserve, 64, 500) };
  });
  const coverScene = optionalScene(record.coverScene);
  const closingScene = optionalScene(record.closingScene);
  const snapshot: DocumentContentSnapshotV1 = {
    schemaVersion: 1, identityScope, revision: integer(record.revision, 1_000_000), nextIdentity, issuedIds,
    kind, title: text(record.title, 240), titleId: claim(record.titleId), sections,
    ...(coverScene === undefined ? rejectAbsentMap(record.coverSceneContentIds) : {
      coverScene, coverSceneContentIds: parseIdentityMap(record.coverSceneContentIds, Object.keys(sceneAtoms(coverScene)), claim)
    }),
    ...(closingScene === undefined ? rejectAbsentMap(record.closingSceneContentIds) : {
      closingScene, closingSceneContentIds: parseIdentityMap(record.closingSceneContentIds, Object.keys(sceneAtoms(closingScene)), claim)
    }), sourceRefs: strings(record.sourceRefs, 128, 240), preserve: strings(record.preserve, 64, 500),
    styleConstraints: strings(record.styleConstraints, 32, 500),
    ...(record.pageCount === undefined ? {} : { pageCount: integer(record.pageCount, 500) })
  };
  if (JSON.stringify(snapshot).length > maxSerializedBytes) throw new TypeError('content snapshot exceeds the maximum size');
  return snapshot;
}

/** Explicit identityMap entries are supplied by the Host, never trusted from a model. */
export function buildDocumentContentSnapshot(input: {
  readonly outline: DocumentOutline;
  readonly identityScope?: string;
  readonly previousSnapshot?: DocumentContentSnapshotV1;
  readonly identityMap?: Readonly<Record<string, string>>;
  readonly sourceRefs?: readonly string[];
  readonly preserve?: readonly string[];
  readonly styleConstraints?: readonly string[];
  readonly pageCount?: number;
}): DocumentContentSnapshotV1 {
  const outline = parseOutline(input.outline);
  const previous = input.previousSnapshot === undefined ? undefined : parseDocumentContentSnapshot(input.previousSnapshot);
  const identityScope = identity(input.identityScope ?? previous?.identityScope ?? 'content');
  if (previous && (previous.identityScope !== identityScope || previous.kind !== outline.kind)) {
    throw new TypeError('content identity scope cannot cross documents');
  }
  const explicit = input.identityMap ?? {};
  if (Object.keys(explicit).length > maxIdentities) throw new TypeError('identity map is too large');
  const oldRefs = previous ? contentReferences(previous) : {};
  const oldById = new Map(Object.values(oldRefs).map(ref => [ref.id, ref]));
  const used = new Set<string>();
  const issuedIds = [...(previous?.issuedIds ?? [])];
  let nextIdentity = previous?.nextIdentity ?? 1;
  const consumedExplicit = new Set<string>();
  const take = (path: string, kind: DocumentContentResolvedRef['kind'], candidate?: string): string => {
    const mapped = explicit[path];
    if (mapped !== undefined) {
      const ref = oldById.get(mapped);
      if (!ref || ref.kind !== kind) throw new TypeError('explicit content identity is absent or has the wrong kind');
      consumedExplicit.add(path);
      candidate = mapped;
    }
    if (candidate !== undefined && !used.has(candidate)) { used.add(candidate); return candidate; }
    if (candidate !== undefined && mapped !== undefined) throw new TypeError('explicit identity is reused');
    if (nextIdentity > maxIdentities) throw new TypeError('content identity budget exhausted');
    const id = `${identityScope}:a${nextIdentity++}`;
    issuedIds.push(id); used.add(id); return id;
  };
  const sourceRefs = input.sourceRefs ?? previous?.sourceRefs ?? [];
  const sameOutline = previous !== undefined && JSON.stringify(documentContentSnapshotToOutline(previous)) === JSON.stringify(outline);
  const oldSections = previous?.sections ?? [];
  const uniqueSection = (section: DocumentOutlineSection): DocumentContentSection | undefined => {
    const exactMatches = oldSections.filter(old => JSON.stringify(sectionToOutline(old)) === JSON.stringify(section));
    if (exactMatches.length === 1 && outline.sections.filter(item => JSON.stringify(item) === JSON.stringify(section)).length === 1) return exactMatches[0];
    const headings = oldSections.filter(old => old.heading === section.heading && old.level === section.level);
    return headings.length === 1 && outline.sections.filter(item => item.heading === section.heading && item.level === section.level).length === 1 ? headings[0] : undefined;
  };
  const sections = outline.sections.map((section, index): DocumentContentSection => {
    const path = `outline.sections[${index}]`;
    const mapped = explicit[path];
    const old = mapped === undefined ? (sameOutline ? oldSections[index] : uniqueSection(section)) : oldSections.find(item => item.sectionId === mapped);
    const sectionId = take(path, 'section', old?.sectionId);
    const blockMatches = new Map<string, DocumentContentBlock[]>();
    for (const block of old?.blocks ?? []) {
      const key = JSON.stringify(block.payload);
      blockMatches.set(key, [...(blockMatches.get(key) ?? []), block]);
    }
    const blocks = section.blocks.map((payload, blockIndex): DocumentContentBlock => {
      const blockPath = `${path}.blocks[${blockIndex}]`;
      const exactMatches = blockMatches.get(JSON.stringify(payload)) ?? [];
      const mappedBlock = explicit[blockPath];
      const oldBlock = mappedBlock === undefined
        ? (sameOutline ? old?.blocks[blockIndex] : exactMatches.length === 1 && section.blocks.filter(item => JSON.stringify(item) === JSON.stringify(payload)).length === 1 ? exactMatches[0] : undefined)
        : old?.blocks.find(item => item.blockId === mappedBlock);
      const blockId = take(blockPath, 'block', oldBlock?.blockId);
      const oldAtoms = oldBlock ? payloadAtoms(oldBlock.payload) : {};
      const newAtoms = payloadAtoms(payload);
      const oldAtomMatches = new Map<string, string[]>();
      const newAtomCounts = new Map<string, number>();
      for (const [key, value] of Object.entries(oldAtoms)) {
        const signature = JSON.stringify([atomKind(key), value]);
        oldAtomMatches.set(signature, [...(oldAtomMatches.get(signature) ?? []), key]);
      }
      for (const [key, value] of Object.entries(newAtoms)) {
        const signature = JSON.stringify([atomKind(key), value]);
        newAtomCounts.set(signature, (newAtomCounts.get(signature) ?? 0) + 1);
      }
      const atomIds: Record<string, string> = {};
      for (const [atomPath, atomText] of Object.entries(newAtoms)) {
        const signature = JSON.stringify([atomKind(atomPath), atomText]);
        const oldCandidates = oldAtomMatches.get(signature) ?? [];
        const candidate = sameOutline ? oldBlock?.atomIds[atomPath]
          : oldCandidates.length === 1 && newAtomCounts.get(signature) === 1
            ? oldBlock?.atomIds[oldCandidates[0]!] : undefined;
        atomIds[atomPath] = take(`${blockPath}.${atomPath}`, atomKind(atomPath), candidate);
      }
      return { blockId, payload, atomIds, sourceRefs: oldBlock?.sourceRefs ?? sourceRefs, preserve: oldBlock?.preserve ?? [] };
    });
    return { sectionId, headingId: take(`${path}.heading`, 'heading', old?.headingId), heading: section.heading, level: section.level, blocks,
      ...(section.pageKind === undefined ? {} : { pageKind: section.pageKind }),
      ...(section.takeaway === undefined ? {} : { takeaway: section.takeaway,
        takeawayId: take(`${path}.takeaway`, 'item', old?.takeaway === section.takeaway ? old.takeawayId : undefined) }),
      ...(section.action === undefined ? {} : { action: section.action,
        actionId: take(`${path}.action`, 'item', old?.action === section.action ? old.actionId : undefined) }),
      ...(section.scene === undefined ? {} : { scene: section.scene,
        sceneContentIds: buildSceneIds(section.scene, old?.scene, old?.sceneContentIds, `${path}.scene`, take) }),
      sourceRefs: old?.sourceRefs ?? sourceRefs, preserve: old?.preserve ?? [] };
  });
  const titleId = take('outline.title', 'title', previous?.titleId);
  const coverSceneContentIds = outline.coverScene === undefined ? undefined
    : buildSceneIds(outline.coverScene, previous?.coverScene, previous?.coverSceneContentIds, 'outline.coverScene', take);
  const closingSceneContentIds = outline.closingScene === undefined ? undefined
    : buildSceneIds(outline.closingScene, previous?.closingScene, previous?.closingSceneContentIds, 'outline.closingScene', take);
  const snapshot = parseDocumentContentSnapshot({ schemaVersion: 1, identityScope, revision: (previous?.revision ?? 0) + 1,
    nextIdentity, issuedIds, kind: outline.kind, title: outline.title,
    titleId, sections,
    ...(outline.coverScene === undefined ? {} : { coverScene: outline.coverScene,
      coverSceneContentIds }),
    ...(outline.closingScene === undefined ? {} : { closingScene: outline.closingScene,
      closingSceneContentIds }),
    sourceRefs, preserve: input.preserve ?? previous?.preserve ?? [], styleConstraints: input.styleConstraints ?? previous?.styleConstraints ?? [],
    ...((input.pageCount ?? previous?.pageCount) === undefined ? {} : { pageCount: input.pageCount ?? previous?.pageCount }) });
  if (Object.keys(explicit).some(path => !consumedExplicit.has(path))) throw new TypeError('identity map contains an unsupported content reference');
  return snapshot;
}

export function documentContentSnapshotToOutline(value: DocumentContentSnapshotV1): DocumentOutline {
  const snapshot = parseDocumentContentSnapshot(value);
  return { kind: snapshot.kind, title: snapshot.title, sections: snapshot.sections.map(sectionToOutline),
    ...(snapshot.coverScene === undefined ? {} : { coverScene: snapshot.coverScene }),
    ...(snapshot.closingScene === undefined ? {} : { closingScene: snapshot.closingScene }) };
}

/** Compatibility view is derived once; it must never be an independent content source. */
export function documentContentSnapshotToLegacyContent(value: DocumentContentSnapshotV1): DocumentIRContent {
  const snapshot = parseDocumentContentSnapshot(value);
  return { title: snapshot.title, sections: snapshot.sections.map(section => ({
    sectionId: section.sectionId, heading: section.heading,
    ...(section.takeaway === undefined ? {} : { purpose: section.takeaway }),
    blocks: section.blocks.map(block => ({ blockId: block.blockId,
      kind: block.payload.type === 'table' ? 'table' : block.payload.type === 'chart' ? 'chart'
        : block.payload.type === 'bullets' || block.payload.type === 'numbered' ? 'bullets' : 'text',
      content: block.payload.type === 'paragraph' || block.payload.type === 'quote' ? block.payload.text
        : block.payload.type === 'bullets' || block.payload.type === 'numbered' ? block.payload.items.join('\n') : JSON.stringify(block.payload),
      sourceRefs: block.sourceRefs })), preserve: section.preserve
  })), sourceRefs: snapshot.sourceRefs, styleConstraints: snapshot.styleConstraints,
    ...(snapshot.pageCount === undefined ? {} : { pageCount: snapshot.pageCount }) };
}

export function documentContentAliases(value: DocumentContentSnapshotV1): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(contentReferences(parseDocumentContentSnapshot(value))).map(([path, ref]) => [path, ref.id]));
}

/** Batch consumers parse and index once, then resolve each layout leaf in constant time. */
export function documentContentReferenceIndex(value: DocumentContentSnapshotV1): Readonly<Record<string, DocumentContentResolvedRef>> {
  const aliases = contentReferences(parseDocumentContentSnapshot(value));
  const result = Object.assign(Object.create(null) as Record<string, DocumentContentResolvedRef>, aliases);
  for (const ref of Object.values(aliases)) result[ref.id] = ref;
  return result;
}

export function resolveDocumentContentRef(value: DocumentContentSnapshotV1, reference: string): DocumentContentResolvedRef | undefined {
  return documentContentReferenceIndex(value)[reference];
}

function sectionToOutline(section: DocumentContentSection): DocumentOutlineSection {
  return { heading: section.heading, level: section.level, blocks: section.blocks.map(block => block.payload),
    ...(section.pageKind === undefined ? {} : { pageKind: section.pageKind }),
    ...(section.takeaway === undefined ? {} : { takeaway: section.takeaway }),
    ...(section.action === undefined ? {} : { action: section.action }),
    ...(section.scene === undefined ? {} : { scene: section.scene }) };
}

function contentReferences(snapshot: DocumentContentSnapshotV1): Record<string, DocumentContentResolvedRef> {
  const result = Object.create(null) as Record<string, DocumentContentResolvedRef>;
  const put = (path: string, ref: DocumentContentResolvedRef, colon?: string): void => {
    result[path] = ref;
    if (colon) result[colon] = ref;
  };
  put('outline.title', { id: snapshot.titleId, kind: 'title', text: snapshot.title }, 'outline:title');
  snapshot.sections.forEach((section, s) => {
    const path = `outline.sections[${s}]`; const colon = `outline:section:${s + 1}`;
    put(path, { id: section.sectionId, kind: 'section', sectionId: section.sectionId }, colon);
    put(`${path}.heading`, { id: section.headingId, kind: 'heading', sectionId: section.sectionId, text: section.heading }, `${colon}:heading`);
    if (section.takeawayId) put(`${path}.takeaway`, { id: section.takeawayId, kind: 'item', sectionId: section.sectionId, text: section.takeaway });
    if (section.actionId) put(`${path}.action`, { id: section.actionId, kind: 'item', sectionId: section.sectionId, text: section.action });
    section.blocks.forEach((block, b) => {
      const blockPath = `${path}.blocks[${b}]`; const blockColon = `${colon}:block:${b + 1}`;
      put(blockPath, { id: block.blockId, kind: 'block', sectionId: section.sectionId, blockId: block.blockId, payload: block.payload }, blockColon);
      for (const [atomPath, atomText] of Object.entries(payloadAtoms(block.payload))) {
        put(`${blockPath}.${atomPath}`, { id: block.atomIds[atomPath]!, kind: atomKind(atomPath),
          sectionId: section.sectionId, blockId: block.blockId, text: atomText,
          ...(atomKind(atomPath) === 'chart_value' ? { value: Number(atomText) } : {}) }, `${blockColon}:${atomPath}`);
      }
    });
    addSceneReferences(result, section.scene, section.sceneContentIds, `${path}.scene`, section.sectionId);
  });
  addSceneReferences(result, snapshot.coverScene, snapshot.coverSceneContentIds, 'outline.coverScene');
  addSceneReferences(result, snapshot.closingScene, snapshot.closingSceneContentIds, 'outline.closingScene');
  return result;
}

function addSceneReferences(result: Record<string, DocumentContentResolvedRef>, scene: PresentationPageScene | undefined,
  ids: Readonly<Record<string, string>> | undefined, path: string, sectionId?: string): void {
  scene?.elements.forEach((element, index) => {
    if (element.content !== undefined) result[`${path}.elements[${index}].content`] = {
      id: ids![element.elementId]!, kind: 'scene_text', text: element.content, ...(sectionId ? { sectionId } : {})
    };
  });
}

function buildSceneIds(scene: PresentationPageScene, oldScene: PresentationPageScene | undefined,
  oldIds: Readonly<Record<string, string>> | undefined, path: string,
  take: (path: string, kind: DocumentContentResolvedRef['kind'], candidate?: string) => string): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  scene.elements.forEach((element, index) => {
    if (element.content === undefined) return;
    const old = oldScene?.elements.find(item => item.elementId === element.elementId && item.content === element.content);
    result[element.elementId] = take(`${path}.elements[${index}].content`, 'scene_text', old ? oldIds?.[old.elementId] : undefined);
  });
  return result;
}

function payloadAtoms(payload: DocumentOutlineBlock): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (payload.type === 'paragraph' || payload.type === 'quote') result.text = payload.text;
  else if (payload.type === 'bullets' || payload.type === 'numbered') payload.items.forEach((item, i) => { result[`items[${i}]`] = item; });
  else if (payload.type === 'table') {
    payload.header.forEach((item, c) => { result[`header[${c}]`] = item; });
    payload.rows.forEach((row, r) => row.forEach((item, c) => { result[`rows[${r}][${c}]`] = item; }));
  } else if (payload.type === 'chart') {
    if (payload.title !== undefined) result.title = payload.title;
    payload.data.forEach((item, i) => { result[`data[${i}].label`] = item.label; result[`data[${i}].value`] = String(item.value); });
  }
  return result;
}

function atomKind(path: string): DocumentContentResolvedRef['kind'] {
  return path.startsWith('header[') || path.startsWith('rows[') ? 'cell'
    : path.endsWith('.label') ? 'chart_label' : path.endsWith('.value') ? 'chart_value' : 'item';
}

function sceneAtoms(scene: PresentationPageScene): Readonly<Record<string, string>> {
  return Object.fromEntries(scene.elements.filter(element => element.content !== undefined).map(element => [element.elementId, element.content!]));
}

function parseOutline(value: unknown): DocumentOutline {
  const record = object(value, 'outline');
  exact(record, ['kind', 'title', 'sections', 'coverScene', 'closingScene']);
  const kind = enumeration(record.kind, documentWorkspaceKinds);
  return { kind, title: text(record.title, 240),
    sections: array(record.sections, 80, kind !== 'ppt').map(raw => {
      const section = object(raw, 'outline section');
      exact(section, ['heading', 'level', 'blocks', 'pageKind', 'takeaway', 'action', 'scene']);
      return { heading: text(section.heading, 240), level: integer(section.level, 3) as 1 | 2 | 3,
        blocks: array(section.blocks, 100).map(parsePayload),
        ...(section.pageKind === undefined ? {} : { pageKind: enumeration(section.pageKind, presentationPageKinds) }),
        ...(section.takeaway === undefined ? {} : { takeaway: text(section.takeaway, 2_000) }),
        ...(section.action === undefined ? {} : { action: text(section.action, 2_000) }),
        ...(section.scene === undefined ? {} : { scene: parsePresentationPageScene(section.scene) }) };
    }), ...(record.coverScene === undefined ? {} : { coverScene: parsePresentationPageScene(record.coverScene) }),
    ...(record.closingScene === undefined ? {} : { closingScene: parsePresentationPageScene(record.closingScene) }) };
}

function parsePayload(value: unknown): DocumentOutlineBlock {
  const record = object(value, 'content payload');
  if (record.type === 'paragraph' || record.type === 'quote') {
    exact(record, ['type', 'text']); return { type: record.type, text: text(record.text, 8_000) };
  }
  if (record.type === 'bullets' || record.type === 'numbered') {
    exact(record, ['type', 'items']); return { type: record.type, items: strings(record.items, 100, 8_000, false, true) };
  }
  if (record.type === 'table') {
    exact(record, ['type', 'header', 'rows']);
    const header = strings(record.header, 50, 8_000, false, true);
    const rows = array(record.rows, 200).map(row => strings(row, 50, 8_000, true));
    if (rows.some(row => row.length !== header.length)) throw new TypeError('table row width does not match header');
    return { type: 'table', header, rows };
  }
  if (record.type === 'chart') {
    exact(record, ['type', 'chartKind', 'title', 'data']);
    return { type: 'chart', chartKind: enumeration(record.chartKind, ['bar', 'pie'] as const),
      ...(record.title === undefined ? {} : { title: text(record.title, 8_000) }),
      data: array(record.data, 50, true).map(raw => {
        const item = object(raw, 'chart data'); exact(item, ['label', 'value']);
        if (typeof item.value !== 'number' || !Number.isFinite(item.value)) throw new TypeError('chart value is not finite');
        return { label: text(item.label, 8_000), value: item.value };
      }) };
  }
  throw new TypeError('unsupported content payload');
}

function parseIdentityMap(value: unknown, expected: readonly string[], claim: (value: unknown) => string): Readonly<Record<string, string>> {
  const record = object(value, 'atom identities');
  if (Object.keys(record).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new TypeError('atom identities do not match content');
  }
  return Object.fromEntries(expected.map(key => [key, claim(record[key])]));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('unsupported content field');
}
function array(value: unknown, max: number, nonempty = false): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && value.length === 0)) throw new TypeError('invalid content array length');
  return value;
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new TypeError('invalid content text');
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/iu.test(value) || /(?:api[_-]?key|token|secret|password|credential)/iu.test(value)) throw new TypeError('protected content value');
  return value;
}
function optionalText(value: unknown, max: number): string | undefined { return value === undefined ? undefined : text(value, max); }
function strings(value: unknown, max: number, length: number, allowEmpty = false, nonempty = false): readonly string[] {
  return array(value, max, nonempty).map(item => text(item, length, allowEmpty));
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new TypeError('invalid content integer');
  return Number(value);
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) throw new TypeError('invalid content identity');
  return value;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new TypeError('invalid content type');
  return value as T;
}
function optionalScene(value: unknown): PresentationPageScene | undefined { return value === undefined ? undefined : parsePresentationPageScene(value); }
function rejectAbsentMap(value: unknown): Record<string, never> {
  if (value !== undefined) throw new TypeError('scene identities require a scene');
  return {};
}
