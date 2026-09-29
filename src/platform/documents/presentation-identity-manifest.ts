import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { readPptxSlideOrder } from './pptx-page-reader';
import { parseDocumentIRPatch, type DocumentIRPatch } from '../../domain/entities/document-ir-patch';

export interface PresentationIdentityPage {
  readonly pageId: string;
  readonly physicalPageNumber: number;
  readonly slidePart: string;
  readonly fingerprint: string;
}
export interface PresentationIdentityElement {
  readonly elementId: string;
  readonly pageId: string;
  readonly kind: 'text';
  readonly sourceFingerprint: string;
  readonly text: string;
  readonly physicalLocator: { readonly slidePart: string; readonly shapeId: string };
}
export interface PresentationIdentityManifest {
  readonly schemaVersion: 1;
  readonly documentLineageId: string;
  readonly workId: string;
  readonly fileId: string;
  readonly sourceExecutionId: string;
  readonly identityIndexVersion: 1;
  readonly revision: number;
  readonly artifactChecksumSha256: string;
  readonly pages: readonly PresentationIdentityPage[];
  readonly elements: readonly PresentationIdentityElement[];
  /** IDs removed in later revisions remain auditable without a live locator. */
  readonly tombstones: readonly { readonly elementId: string; readonly pageId: string; readonly revision: number }[];
}
export type DocumentIdentityIndex = PresentationIdentityManifest;
type SlideObjects = { readonly xml: string; readonly shapes: ReadonlyMap<string, string> };
type ArtifactObjects = { readonly zip: JSZip; readonly parts: readonly string[]; readonly slides: ReadonlyMap<string, SlideObjects>; readonly slideWidth: number; readonly slideHeight: number };

/** First admission only. Later revisions inherit opaque IDs through exact locators. */
export async function buildPresentationIdentityManifest(input: {
  readonly buffer: Uint8Array; readonly documentLineageId: string; readonly workId: string;
  readonly fileId: string; readonly sourceExecutionId: string; readonly revision: number;
}): Promise<PresentationIdentityManifest> {
  const artifact = await inspectArtifact(input.buffer);
  const pages: PresentationIdentityPage[] = [];
  const elements: PresentationIdentityElement[] = [];
  for (const [index, slidePart] of artifact.parts.entries()) {
    const slide = artifact.slides.get(slidePart)!;
    const pageId = opaqueId('page');
    pages.push({ pageId, physicalPageNumber: index + 1, slidePart, fingerprint: hash(slide.xml) });
    for (const [shapeId, shape] of slide.shapes) {
      if (/name=["']UniComp Page Number["']/u.test(shape)) continue;
      const text = shapeText(shape);
      if (!text.trim()) continue;
      elements.push({ elementId: opaqueId('element'), pageId, kind: 'text', text,
        sourceFingerprint: hash(shape), physicalLocator: { slidePart, shapeId } });
    }
  }
  return parsePresentationIdentityManifest({ schemaVersion: 1, documentLineageId: input.documentLineageId,
    workId: input.workId, fileId: input.fileId, sourceExecutionId: input.sourceExecutionId,
    identityIndexVersion: 1, revision: input.revision, artifactChecksumSha256: hash(input.buffer), pages, elements, tombstones: [] });
}

/** Closed, copied and deeply immutable; caller-owned objects never become trusted state. */
export function parsePresentationIdentityManifest(value: unknown): PresentationIdentityManifest {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const raw = value as Record<string, unknown>;
  const baseKeys = ['schemaVersion', 'documentLineageId', 'workId', 'fileId', 'sourceExecutionId',
    'identityIndexVersion', 'revision', 'artifactChecksumSha256', 'pages', 'elements'] as const;
  const item = record(raw, Object.prototype.hasOwnProperty.call(raw, 'tombstones') ? [...baseKeys, 'tombstones'] : baseKeys);
  if (item.schemaVersion !== 1 || item.identityIndexVersion !== 1 || !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 0 || !Array.isArray(item.pages) || !item.pages.length || item.pages.length > 500 ||
      !Array.isArray(item.elements) || item.elements.length > 20_000 ||
      (item.tombstones !== undefined && (!Array.isArray(item.tombstones) || item.tombstones.length > 20_000))) invalid();
  const pages = (item.pages as unknown[]).map(raw => {
    const page = record(raw, ['pageId', 'physicalPageNumber', 'slidePart', 'fingerprint']);
    if (!Number.isSafeInteger(page.physicalPageNumber) || Number(page.physicalPageNumber) < 1) invalid();
    return Object.freeze({ pageId: safeId(page.pageId), physicalPageNumber: Number(page.physicalPageNumber),
      slidePart: part(page.slidePart), fingerprint: checksum(page.fingerprint) });
  });
  if (new Set(pages.map(page => page.pageId)).size !== pages.length ||
      new Set(pages.map(page => page.slidePart)).size !== pages.length ||
      pages.some((page, index) => page.physicalPageNumber !== index + 1)) invalid();
  const elements = (item.elements as unknown[]).map(raw => {
    const element = record(raw, ['elementId', 'pageId', 'kind', 'sourceFingerprint', 'text', 'physicalLocator']);
    const locator = record(element.physicalLocator, ['slidePart', 'shapeId']);
    const page = pages.find(page => page.pageId === element.pageId);
    if (!page || element.kind !== 'text' || typeof element.text !== 'string' || !element.text.trim() ||
        element.text.length > 100_000 || !validXmlText(element.text) || locator.slidePart !== page.slidePart ||
        typeof locator.shapeId !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(locator.shapeId)) invalid();
    return Object.freeze({ elementId: safeId(element.elementId), pageId: safeId(element.pageId), kind: 'text' as const,
      sourceFingerprint: checksum(element.sourceFingerprint), text: element.text as string,
      physicalLocator: Object.freeze({ slidePart: part(locator.slidePart), shapeId: locator.shapeId as string }) });
  });
  if (new Set(elements.map(element => element.elementId)).size !== elements.length ||
      new Set(elements.map(element => JSON.stringify(element.physicalLocator))).size !== elements.length) invalid();
  const tombstones = (item.tombstones === undefined ? [] : item.tombstones as unknown[]).map(raw => {
    const tombstone = record(raw, ['elementId', 'pageId', 'revision']);
    if (!pages.some(page => page.pageId === tombstone.pageId) || !Number.isSafeInteger(tombstone.revision) ||
        Number(tombstone.revision) < 1 || Number(tombstone.revision) > Number(item.revision) ||
        elements.some(element => element.elementId === tombstone.elementId)) invalid();
    return Object.freeze({ elementId: safeId(tombstone.elementId), pageId: safeId(tombstone.pageId), revision: Number(tombstone.revision) });
  });
  if (new Set(tombstones.map(item => item.elementId)).size !== tombstones.length) invalid();
  return Object.freeze({ schemaVersion: 1, documentLineageId: safeId(item.documentLineageId), workId: safeId(item.workId),
    fileId: safeId(item.fileId), sourceExecutionId: safeId(item.sourceExecutionId), identityIndexVersion: 1,
    revision: Number(item.revision), artifactChecksumSha256: checksum(item.artifactChecksumSha256),
    pages: Object.freeze(pages), elements: Object.freeze(elements), tombstones: Object.freeze(tombstones) });
}

/** One unpacking verifies every concrete object; no cache or text matching is used. */
export async function verifyPresentationIdentityManifest(buffer: Uint8Array, value: unknown): Promise<PresentationIdentityManifest> {
  const manifest = parsePresentationIdentityManifest(value);
  await verifiedArtifact(buffer, manifest);
  return manifest;
}
export async function readIdentityElementTexts(
  buffer: Uint8Array, value: unknown, elementIds?: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  const manifest = parsePresentationIdentityManifest(value);
  const artifact = await verifiedArtifact(buffer, manifest);
  const selected = elementIds === undefined ? manifest.elements : elementIds.map(id => {
    const element = manifest.elements.find(item => item.elementId === id);
    if (!element) throw new IdentityManifestError('identity_unresolved');
    return element;
  });
  return new Map(selected.map(element => [element.elementId,
    shapeText(artifact.slides.get(element.physicalLocator.slidePart)!.shapes.get(element.physicalLocator.shapeId)!)]));
}
export async function readIdentityElementText(buffer: Uint8Array, manifest: unknown, elementId: string): Promise<string> {
  return (await readIdentityElementTexts(buffer, manifest, [elementId])).get(elementId)!;
}

/** Existing IDs are inherited only after exact object and unchanged-object verification. */
export async function carryForwardPresentationIdentityManifest(input: {
  readonly previous: unknown; readonly buffer: Uint8Array; readonly revision: number;
  readonly targetElementId: string; readonly targetText: string; readonly fileId?: string;
  readonly sourceExecutionId?: string;
}): Promise<PresentationIdentityManifest> {
  return carryForwardPresentationIdentityManifestForPatch({ ...input,
    patch: { schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId: input.targetElementId }, text: input.targetText }] } });
}

/** Carries identities by exact object locator after one closed patch operation. */
export async function carryForwardPresentationIdentityManifestForPatch(input: {
  readonly previous: unknown; readonly buffer: Uint8Array; readonly revision: number;
  readonly patch: DocumentIRPatch; readonly fileId?: string; readonly sourceExecutionId?: string;
}): Promise<PresentationIdentityManifest> {
  const previous = parsePresentationIdentityManifest(input.previous);
  if (input.revision !== previous.revision + 1) throw new IdentityManifestError('identity_pin_mismatch');
  const patch = parseDocumentIRPatch(input.patch);
  const operation = patch.operations[0];
  const artifact = await inspectArtifact(input.buffer);
  if (operation.op === 'add_slide') {
    return carryForwardAddSlideIdentity({ previous, artifact, buffer: input.buffer, revision: input.revision,
      patch: operation, fileId: input.fileId, sourceExecutionId: input.sourceExecutionId });
  }
  assertPageLocators(artifact, previous);
  const targetId = operation.op === 'add_text' ? undefined : operation.target.elementId;
  const target = targetId === undefined ? undefined : previous.elements.find(element => element.elementId === targetId);
  if (operation.op === 'add_text' && !previous.pages.some(page => page.pageId === operation.target.pageId)) throw new IdentityManifestError('page_not_found');
  if (operation.op !== 'add_text' && !target) throw new IdentityManifestError('element_not_found');
  const pages = previous.pages.map(page => {
    const xml = artifact.slides.get(page.slidePart)!.xml;
    const affectedPageId = operation.op === 'add_text' ? operation.target.pageId : target!.pageId;
    if (page.pageId !== affectedPageId && hash(xml) !== page.fingerprint) throw new IdentityManifestError('identity_ambiguous');
    return { ...page, fingerprint: hash(xml) };
  });
  const elements = previous.elements.filter(element => operation.op !== 'delete_element' || element.elementId !== operation.target.elementId).map(element => {
    const shape = resolveShape(artifact, element);
    const text = shapeText(shape);
    if (operation.op === 'update_text' && element.elementId === operation.target.elementId) {
      requireSimpleTextShape(shape);
      if (text !== operation.text) throw new IdentityManifestError('identity_ambiguous');
    } else if (text !== element.text || hash(shape) !== element.sourceFingerprint) {
      throw new IdentityManifestError('identity_ambiguous');
    }
    return { ...element, text, sourceFingerprint: hash(shape) };
  });
  if (operation.op === 'add_text') {
    const page = previous.pages.find(item => item.pageId === operation.target.pageId)!;
    const slide = artifact.slides.get(page.slidePart)!;
    const previousShapeIds = new Set(previous.elements.filter(item => item.pageId === page.pageId).map(item => item.physicalLocator.shapeId));
    const added = [...slide.shapes.entries()].filter(([shapeId, shape]) => !previousShapeIds.has(shapeId) &&
      new RegExp(`\\bname=["']UniComp Element ${escapeRegExp(operation.elementId)}["']`, 'u').test(shape));
    if (added.length !== 1) {
      throw new IdentityManifestError('identity_creation_failed');
    }
    const [shapeId, shape] = added[0];
    requireSimpleTextShape(shape);
    if (shapeText(shape) !== operation.text) throw new IdentityManifestError('identity_creation_failed');
    elements.push({ elementId: operation.elementId, pageId: page.pageId, kind: 'text', text: operation.text,
      sourceFingerprint: hash(shape), physicalLocator: { slidePart: page.slidePart, shapeId } });
  }
  const tombstones = [...previous.tombstones];
  if (operation.op === 'delete_element') {
    if (artifact.slides.get(target!.physicalLocator.slidePart)!.shapes.has(target!.physicalLocator.shapeId)) {
      throw new IdentityManifestError('identity_ambiguous');
    }
    tombstones.push({ elementId: operation.target.elementId, pageId: target!.pageId, revision: input.revision });
  }
  return parsePresentationIdentityManifest({ ...previous, revision: input.revision,
    fileId: input.fileId ?? previous.fileId, sourceExecutionId: input.sourceExecutionId ?? previous.sourceExecutionId,
    artifactChecksumSha256: hash(input.buffer), pages, elements, tombstones });
}

/** Copy-on-write of one simple text run. Rich text/fields are explicitly unsupported. */
export async function applyPresentationTextPatch(input: {
  readonly buffer: Uint8Array; readonly manifest: unknown; readonly patch: DocumentIRPatch;
}): Promise<Uint8Array> {
  return applyPresentationMutationPatch(input);
}

/** Applies update/add/delete against exact pinned XML objects; no text lookup is used. */
export async function applyPresentationMutationPatch(input: {
  readonly buffer: Uint8Array; readonly manifest: unknown; readonly patch: DocumentIRPatch;
}): Promise<Uint8Array> {
  const manifest = parsePresentationIdentityManifest(input.manifest);
  const patch = parseDocumentIRPatch(input.patch);
  const artifact = await verifiedArtifact(input.buffer, manifest);
  const operation = patch.operations[0];
  if (operation.op === 'add_slide') {
    await applyPresentationAddSlidePatch({ artifact, manifest, operation });
  } else if (operation.op === 'add_text') {
    if (!validXmlText(operation.text)) throw new IdentityManifestError('identity_creation_failed');
    if (manifest.elements.some(element => element.elementId === operation.elementId) ||
        manifest.tombstones.some(element => element.elementId === operation.elementId)) throw new IdentityManifestError('identity_creation_failed');
    const page = manifest.pages.find(item => item.pageId === operation.target.pageId);
    if (!page) throw new IdentityManifestError('page_not_found');
    const slide = artifact.slides.get(page.slidePart)!;
    const shapeId = nextShapeId(slide.xml);
    const shape = createTextShape(shapeId, operation.elementId, operation.text, artifact.slideWidth, artifact.slideHeight);
    const nextXml = slide.xml.replace(/<\/p:spTree>/u, `${shape}</p:spTree>`);
    if (nextXml === slide.xml) throw new IdentityManifestError('materialization_failed');
    artifact.zip.file(page.slidePart, nextXml);
  } else {
    const element = manifest.elements.find(item => item.elementId === operation.target.elementId);
    if (!element) throw new IdentityManifestError('element_not_found');
    const slide = artifact.slides.get(element.physicalLocator.slidePart)!;
    const shape = resolveShape(artifact, element);
    requireSimpleTextShape(shape);
    if (operation.op === 'update_text') {
      if (!validXmlText(operation.text)) throw new IdentityManifestError('identity_unresolved');
      const nextShape = shape.replace(/(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/u,
        (_match, open: string, close: string) => `${open}${escapeXml(operation.text)}${close}`);
      artifact.zip.file(element.physicalLocator.slidePart, slide.xml.replace(shape, nextShape));
    } else {
      artifact.zip.file(element.physicalLocator.slidePart, slide.xml.replace(shape, ''));
    }
  }
  return artifact.zip.generateAsync({ type: 'nodebuffer' });
}

export class IdentityManifestError extends Error {
  constructor(readonly code: 'identity_unresolved' | 'identity_ambiguous' | 'identity_pin_mismatch' | 'page_not_found' | 'page_order_unresolved' | 'element_not_found' | 'identity_creation_failed' | 'materialization_failed') {
    super(code); this.name = 'IdentityManifestError';
  }
}
async function verifiedArtifact(buffer: Uint8Array, manifest: PresentationIdentityManifest): Promise<ArtifactObjects> {
  if (hash(buffer) !== manifest.artifactChecksumSha256) throw new IdentityManifestError('identity_pin_mismatch');
  const artifact = await inspectArtifact(buffer);
  assertPageLocators(artifact, manifest);
  for (const page of manifest.pages) if (hash(artifact.slides.get(page.slidePart)!.xml) !== page.fingerprint) throw new IdentityManifestError('identity_ambiguous');
  for (const element of manifest.elements) {
    const shape = resolveShape(artifact, element);
    if (shapeText(shape) !== element.text || hash(shape) !== element.sourceFingerprint) throw new IdentityManifestError('identity_ambiguous');
  }
  return artifact;
}
async function inspectArtifact(buffer: Uint8Array): Promise<ArtifactObjects> {
  if (buffer.byteLength < 1 || buffer.byteLength > 20 * 1024 * 1024) throw new IdentityManifestError('identity_unresolved');
  const zip = await JSZip.loadAsync(buffer);
  const parts = await readPptxSlideOrder(zip);
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
  const size = presentationXml && /<p:sldSz\b[^>]*\bcx="([0-9]+)"[^>]*\bcy="([0-9]+)"/u.exec(presentationXml);
  const slideWidth = Number(size?.[1]);
  const slideHeight = Number(size?.[2]);
  if (!Number.isSafeInteger(slideWidth) || !Number.isSafeInteger(slideHeight) || slideWidth < 1 || slideHeight < 1) {
    throw new IdentityManifestError('identity_unresolved');
  }
  if (!parts.length || parts.length > 500 || new Set(parts).size !== parts.length) throw new IdentityManifestError('identity_ambiguous');
  const slides = new Map<string, SlideObjects>();
  for (const slidePart of parts) {
    part(slidePart);
    const xml = await zip.file(slidePart)?.async('string');
    if (!xml || xml.length > 8_000_000 || /<!DOCTYPE|<!ENTITY/u.test(xml)) throw new IdentityManifestError('identity_unresolved');
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid=["']([^"']+)["'][^>]*\/?\s*>/gu)].map(match => match[1]);
    if (new Set(ids).size !== ids.length) throw new IdentityManifestError('identity_ambiguous');
    const shapes = new Map<string, string>();
    for (const match of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)) {
      const found = [...match[0].matchAll(/<p:cNvPr\b[^>]*\bid=["']([^"']+)["']/gu)];
      if (found.length !== 1 || !/^[1-9][0-9]{0,9}$/u.test(found[0][1])) throw new IdentityManifestError('identity_unresolved');
      shapes.set(found[0][1], match[0]);
    }
    slides.set(slidePart, { xml, shapes });
  }
  return { zip, parts, slides, slideWidth, slideHeight };
}
function assertPageLocators(artifact: ArtifactObjects, manifest: PresentationIdentityManifest): void {
  if (JSON.stringify(artifact.parts) !== JSON.stringify(manifest.pages.map(page => page.slidePart))) throw new IdentityManifestError('identity_ambiguous');
}
function resolveShape(artifact: ArtifactObjects, element: PresentationIdentityElement): string {
  const shape = artifact.slides.get(element.physicalLocator.slidePart)?.shapes.get(element.physicalLocator.shapeId);
  if (!shape) throw new IdentityManifestError('identity_unresolved');
  return shape;
}
function requireSimpleTextShape(shape: string): void {
  if ([...shape.matchAll(/<a:t(?:\s[^>]*)?>/gu)].length !== 1 ||
      [...shape.matchAll(/<a:r(?:\s[^>]*)?>/gu)].length !== 1 ||
      [...shape.matchAll(/<a:p(?:\s[^>]*)?>/gu)].length !== 1 ||
      /<a:(?:fld|br|tab|hlinkClick|hlinkMouseOver)\b/u.test(shape)) throw new IdentityManifestError('identity_unresolved');
}
function shapeText(shape: string): string {
  return [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1])).join('');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(item, key))) invalid();
  return item;
}
function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)) invalid();
  return value as string;
}
function part(value: unknown): string {
  if (typeof value !== 'string' || !/^ppt\/slides\/slide[1-9][0-9]*\.xml$/u.test(value)) invalid();
  return value as string;
}
function checksum(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value as string;
}
function invalid(): never { throw new TypeError('invalid_identity_manifest'); }
function opaqueId(prefix: string): string { return `${prefix}-${randomUUID()}`; }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|quot|apos|amp);/giu, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) throw new IdentityManifestError('identity_unresolved');
      return String.fromCodePoint(code);
    }
    return ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[entity.toLowerCase()];
  });
}

function carryForwardAddSlideIdentity(input: {
  readonly previous: PresentationIdentityManifest; readonly artifact: ArtifactObjects; readonly buffer: Uint8Array;
  readonly revision: number; readonly patch: Extract<DocumentIRPatch['operations'][number], { readonly op: 'add_slide' }>;
  readonly fileId?: string; readonly sourceExecutionId?: string;
}): PresentationIdentityManifest {
  if (input.revision !== input.previous.revision + 1) throw new IdentityManifestError('identity_pin_mismatch');
  if (input.previous.pages.some(page => page.pageId === input.patch.pageId) ||
      (input.patch.titleElementId !== undefined && (input.previous.elements.some(element => element.elementId === input.patch.titleElementId) ||
        input.previous.tombstones.some(tombstone => tombstone.elementId === input.patch.titleElementId)))) {
    throw new IdentityManifestError('identity_creation_failed');
  }
  const previousParts = input.previous.pages.map(page => page.slidePart);
  const previousSet = new Set(previousParts);
  const existingParts = input.artifact.parts.filter(part => previousSet.has(part));
  const newParts = input.artifact.parts.filter(part => !previousSet.has(part));
  if (existingParts.length !== previousParts.length || existingParts.some((part, index) => part !== previousParts[index]) || newParts.length !== 1) {
    throw new IdentityManifestError('identity_ambiguous');
  }
  const newPart = newParts[0]!;
  const reference = input.patch.target.referencePageId === undefined ? undefined
    : input.previous.pages.find(page => page.pageId === input.patch.target.referencePageId);
  if (input.patch.target.mode !== 'end' && !reference) throw new IdentityManifestError('page_not_found');
  let expectedIndex: number;
  if (input.patch.target.mode === 'before') expectedIndex = input.artifact.parts.indexOf(reference!.slidePart) - 1;
  else if (input.patch.target.mode === 'after') expectedIndex = input.artifact.parts.indexOf(reference!.slidePart) + 1;
  else {
    const previousLastPart = input.previous.pages.at(-1)?.slidePart;
    expectedIndex = previousLastPart !== undefined && isClosingSlide(input.artifact.slides.get(previousLastPart)!.xml)
      ? input.artifact.parts.indexOf(previousLastPart) - 1 : input.artifact.parts.length - 1;
  }
  if (expectedIndex < 0 || input.artifact.parts.indexOf(newPart) !== expectedIndex) throw new IdentityManifestError('page_order_unresolved');
  for (const page of input.previous.pages) {
    const slide = input.artifact.slides.get(page.slidePart);
    if (!slide || hash(slide.xml) !== page.fingerprint) throw new IdentityManifestError('identity_ambiguous');
  }
  const pages = input.artifact.parts.map((slidePart, index) => {
    if (slidePart === newPart) return { pageId: input.patch.pageId, physicalPageNumber: index + 1, slidePart, fingerprint: hash(input.artifact.slides.get(slidePart)!.xml) };
    const previous = input.previous.pages.find(page => page.slidePart === slidePart)!;
    return { ...previous, physicalPageNumber: index + 1 };
  });
  const elements = input.previous.elements.map(element => {
    const shape = resolveShape(input.artifact, element);
    if (shapeText(shape) !== element.text || hash(shape) !== element.sourceFingerprint) throw new IdentityManifestError('identity_ambiguous');
    return { ...element };
  });
  if (input.patch.title !== undefined) {
    const titleElementId = input.patch.titleElementId!;
    const titlePage = pages.find(page => page.pageId === input.patch.pageId)!;
    const slide = input.artifact.slides.get(newPart)!;
    const matches = [...slide.shapes.entries()].filter(([, shape]) => new RegExp(`\\bname=["']UniComp Element ${escapeRegExp(titleElementId)}["']`, 'u').test(shape));
    if (matches.length !== 1) throw new IdentityManifestError('identity_creation_failed');
    const [shapeId, shape] = matches[0]!;
    requireSimpleTextShape(shape);
    if (shapeText(shape) !== input.patch.title) throw new IdentityManifestError('identity_creation_failed');
    elements.push({ elementId: titleElementId, pageId: titlePage.pageId, kind: 'text', text: input.patch.title,
      sourceFingerprint: hash(shape), physicalLocator: { slidePart: newPart, shapeId } });
  }
  return parsePresentationIdentityManifest({ ...input.previous, revision: input.revision,
    fileId: input.fileId ?? input.previous.fileId, sourceExecutionId: input.sourceExecutionId ?? input.previous.sourceExecutionId,
    artifactChecksumSha256: hash(input.buffer), pages, elements, tombstones: input.previous.tombstones });
}

/** Materializes one blank slide and updates the package-level slide order. */
async function applyPresentationAddSlidePatch(input: {
  readonly artifact: ArtifactObjects;
  readonly manifest: PresentationIdentityManifest;
  readonly operation: Extract<DocumentIRPatch['operations'][number], { readonly op: 'add_slide' }>;
}): Promise<void> {
  const { artifact, manifest, operation } = input;
  if (manifest.pages.some(page => page.pageId === operation.pageId) ||
      manifest.elements.some(element => element.elementId === operation.titleElementId) ||
      manifest.tombstones.some(tombstone => tombstone.elementId === operation.titleElementId)) {
    throw new IdentityManifestError('identity_creation_failed');
  }
  const reference = operation.target.referencePageId === undefined ? undefined
    : manifest.pages.find(page => page.pageId === operation.target.referencePageId);
  if (operation.target.mode !== 'end' && !reference) throw new IdentityManifestError('page_not_found');
  const insertionIndex = addSlideInsertionIndex(artifact, operation.target.mode, reference?.slidePart);
  if (insertionIndex < 0 || insertionIndex > artifact.parts.length) throw new IdentityManifestError('page_order_unresolved');

  const newPart = nextSlidePart(artifact);
  const sourcePart = reference?.slidePart ?? artifact.parts.at(-1)!;
  const sourceRels = await readSlideRelationships(artifact.zip, sourcePart);
  const slideXml = createBlankSlideXml(artifact.parts.length + 1,
    operation.title === undefined ? undefined : createTextShape('2', operation.titleElementId!, operation.title,
      artifact.slideWidth, artifact.slideHeight));
  artifact.zip.file(newPart, slideXml);
  artifact.zip.file(slideRelationshipsPath(newPart), sourceRels);
  await addSlideContentType(artifact.zip, newPart);

  const presentationXml = await readPackagePart(artifact.zip, 'ppt/presentation.xml');
  const presentationRels = await readPackagePart(artifact.zip, 'ppt/_rels/presentation.xml.rels');
  const relationId = nextRelationshipId(presentationRels);
  const slideId = nextSlideId(presentationXml);
  const nextPresentation = insertSlideId(presentationXml, insertionIndex,
    `<p:sldId id="${slideId}" r:id="${relationId}"/>`);
  const nextRelationships = appendPresentationRelationship(presentationRels, relationId, newPart);
  artifact.zip.file('ppt/presentation.xml', nextPresentation);
  artifact.zip.file('ppt/_rels/presentation.xml.rels', nextRelationships);
}

function addSlideInsertionIndex(
  artifact: ArtifactObjects,
  mode: 'before' | 'after' | 'end',
  referencePart: string | undefined
): number {
  if (mode === 'before') {
    const index = referencePart === undefined ? -1 : artifact.parts.indexOf(referencePart);
    return index;
  }
  if (mode === 'after') {
    const index = referencePart === undefined ? -1 : artifact.parts.indexOf(referencePart);
    return index < 0 ? -1 : index + 1;
  }
  const lastPart = artifact.parts.at(-1);
  return lastPart !== undefined && isClosingSlide(artifact.slides.get(lastPart)!.xml)
    ? artifact.parts.length - 1 : artifact.parts.length;
}

function nextSlidePart(artifact: ArtifactObjects): string {
  const existing = new Set(Object.keys(artifact.zip.files));
  let number = 1;
  for (const partName of artifact.parts) {
    const match = /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.exec(partName);
    if (match) number = Math.max(number, Number(match[1]) + 1);
  }
  while (existing.has(`ppt/slides/slide${number}.xml`) || existing.has(`ppt/slides/_rels/slide${number}.xml.rels`)) number++;
  if (!Number.isSafeInteger(number) || number > 500) throw new IdentityManifestError('identity_creation_failed');
  return `ppt/slides/slide${number}.xml`;
}

async function readSlideRelationships(zip: JSZip, slidePart: string): Promise<string> {
  const source = await readPackagePart(zip, slideRelationshipsPath(slidePart));
  const layout = [...source.matchAll(/<Relationship\b[^>]*\/?>(?:<\/Relationship>)?/gu)].map(match => match[0]).map(tag => ({
    type: /\bType=["']([^"']+)["']/u.exec(tag)?.[1], target: /\bTarget=["']([^"']+)["']/u.exec(tag)?.[1]
  })).find(item => item.type === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout');
  if (!layout?.target || !/^\.\.\/slideLayouts\/slideLayout[1-9][0-9]*\.xml$/u.test(layout.target)) {
    throw new IdentityManifestError('materialization_failed');
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${escapeXml(layout.target)}"/>` +
    `</Relationships>`;
}

function slideRelationshipsPath(slidePart: string): string {
  return slidePart.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
}

async function readPackagePart(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) throw new IdentityManifestError('materialization_failed');
  return file.async('string');
}

function createBlankSlideXml(slideNumber: number, titleShape?: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld name="Slide ${slideNumber}"><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    (titleShape ?? '') +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

async function addSlideContentType(zip: JSZip, slidePart: string): Promise<void> {
  const file = zip.file('[Content_Types].xml');
  if (!file) throw new IdentityManifestError('materialization_failed');
  const xml = await file.async('string');
  if (xml.includes(`PartName="/${slidePart}"`) || xml.includes(`PartName='/${slidePart}'`)) return;
  const next = xml.replace(/<\/Types>\s*$/u,
    `<Override PartName="/${slidePart}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  if (next === xml) throw new IdentityManifestError('materialization_failed');
  zip.file('[Content_Types].xml', next);
}

function nextRelationshipId(xml: string): string {
  const ids = new Set([...xml.matchAll(/\bId=["']([^"']+)["']/gu)].map(match => match[1]));
  let number = 1;
  while (ids.has(`rId${number}`)) number++;
  return `rId${number}`;
}

function nextSlideId(xml: string): string {
  const ids = [...xml.matchAll(/<p:sldId\b[^>]*\bid=["']([0-9]+)["']/gu)].map(match => Number(match[1]));
  const next = Math.max(255, ...ids) + 1;
  if (!Number.isSafeInteger(next) || next > 2_147_483_647) throw new IdentityManifestError('identity_creation_failed');
  return String(next);
}

function insertSlideId(xml: string, index: number, value: string): string {
  const lists = [...xml.matchAll(/<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>/gu)];
  if (lists.length !== 1) throw new IdentityManifestError('materialization_failed');
  const list = lists[0]!;
  const openEnd = list[0].indexOf('>') + 1;
  const closeStart = list[0].lastIndexOf('</p:sldIdLst>');
  const children = list[0].slice(openEnd, closeStart);
  const ids = [...children.matchAll(/<p:sldId\b[^>]*\/\s*>/gu)];
  if (index < 0 || index > ids.length) throw new IdentityManifestError('page_order_unresolved');
  const offset = index === ids.length ? closeStart : openEnd + ids[index]!.index!;
  const absolute = (lists[0]!.index ?? 0) + offset;
  return xml.slice(0, absolute) + value + xml.slice(absolute);
}

function appendPresentationRelationship(xml: string, id: string, slidePart: string): string {
  const match = /<\/Relationships>\s*$/u.exec(xml);
  if (!match || xml.slice(0, match.index).includes(`Id="${id}"`)) throw new IdentityManifestError('materialization_failed');
  const relation = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${escapeXml(slidePart.replace('ppt/', ''))}"/>`;
  return xml.slice(0, match.index) + relation + xml.slice(match.index);
}

function isClosingSlide(xml: string): boolean {
  return [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].some(match => {
    if (/name=["']UniComp Page Number["']/u.test(match[0])) return false;
    return /^(?:谢谢(?:观看)?|感谢观看|结束|closing|thank\s*you)$/iu.test(shapeText(match[0]).trim());
  });
}

function validXmlText(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) && !/[\ud800-\udfff]/u.test(value);
}
function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function nextShapeId(xml: string): string {
  const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid=["']([1-9][0-9]{0,9})["']/gu)].map(match => Number(match[1]));
  const next = Math.max(0, ...ids) + 1;
  if (!Number.isSafeInteger(next) || next > 9_999_999_999) throw new IdentityManifestError('identity_creation_failed');
  return String(next);
}

function createTextShape(shapeId: string, elementId: string, text: string, slideWidth: number, slideHeight: number): string {
  const x = Math.round(slideWidth * 0.12);
  const y = Math.round(slideHeight * 0.38);
  const width = Math.round(slideWidth * 0.76);
  const height = Math.round(slideHeight * 0.18);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="UniComp Element ${escapeXml(elementId)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1800"/><a:t>${escapeXml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="1800"/></a:p></p:txBody></p:sp>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
