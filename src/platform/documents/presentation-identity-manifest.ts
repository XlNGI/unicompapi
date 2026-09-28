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
}
export type DocumentIdentityIndex = PresentationIdentityManifest;
type SlideObjects = { readonly xml: string; readonly shapes: ReadonlyMap<string, string> };
type ArtifactObjects = { readonly zip: JSZip; readonly parts: readonly string[]; readonly slides: ReadonlyMap<string, SlideObjects> };

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
    identityIndexVersion: 1, revision: input.revision, artifactChecksumSha256: hash(input.buffer), pages, elements });
}

/** Closed, copied and deeply immutable; caller-owned objects never become trusted state. */
export function parsePresentationIdentityManifest(value: unknown): PresentationIdentityManifest {
  const item = record(value, ['schemaVersion', 'documentLineageId', 'workId', 'fileId', 'sourceExecutionId',
    'identityIndexVersion', 'revision', 'artifactChecksumSha256', 'pages', 'elements']);
  if (item.schemaVersion !== 1 || item.identityIndexVersion !== 1 || !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 0 || !Array.isArray(item.pages) || !item.pages.length || item.pages.length > 500 ||
      !Array.isArray(item.elements) || item.elements.length > 20_000) invalid();
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
  return Object.freeze({ schemaVersion: 1, documentLineageId: safeId(item.documentLineageId), workId: safeId(item.workId),
    fileId: safeId(item.fileId), sourceExecutionId: safeId(item.sourceExecutionId), identityIndexVersion: 1,
    revision: Number(item.revision), artifactChecksumSha256: checksum(item.artifactChecksumSha256),
    pages: Object.freeze(pages), elements: Object.freeze(elements) });
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
  const previous = parsePresentationIdentityManifest(input.previous);
  if (input.revision !== previous.revision + 1) throw new IdentityManifestError('identity_pin_mismatch');
  if (!previous.elements.some(element => element.elementId === input.targetElementId)) throw new IdentityManifestError('identity_unresolved');
  const artifact = await inspectArtifact(input.buffer);
  assertPageLocators(artifact, previous);
  const target = previous.elements.find(element => element.elementId === input.targetElementId)!;
  const pages = previous.pages.map(page => {
    const xml = artifact.slides.get(page.slidePart)!.xml;
    if (page.pageId !== target.pageId && hash(xml) !== page.fingerprint) throw new IdentityManifestError('identity_ambiguous');
    return { ...page, fingerprint: hash(xml) };
  });
  const elements = previous.elements.map(element => {
    const shape = resolveShape(artifact, element);
    const text = shapeText(shape);
    if (element.elementId === input.targetElementId) {
      requireSimpleTextShape(shape);
      if (text !== input.targetText) throw new IdentityManifestError('identity_ambiguous');
    } else if (text !== element.text || hash(shape) !== element.sourceFingerprint) {
      throw new IdentityManifestError('identity_ambiguous');
    }
    return { ...element, text, sourceFingerprint: hash(shape) };
  });
  return parsePresentationIdentityManifest({ ...previous, revision: input.revision,
    fileId: input.fileId ?? previous.fileId, sourceExecutionId: input.sourceExecutionId ?? previous.sourceExecutionId,
    artifactChecksumSha256: hash(input.buffer), pages, elements });
}

/** Copy-on-write of one simple text run. Rich text/fields are explicitly unsupported. */
export async function applyPresentationTextPatch(input: {
  readonly buffer: Uint8Array; readonly manifest: unknown; readonly patch: DocumentIRPatch;
}): Promise<Uint8Array> {
  const manifest = parsePresentationIdentityManifest(input.manifest);
  const patch = parseDocumentIRPatch(input.patch);
  const element = manifest.elements.find(item => item.elementId === patch.operations[0].target.elementId);
  if (!element) throw new IdentityManifestError('identity_unresolved');
  if (!validXmlText(patch.operations[0].text)) throw new IdentityManifestError('identity_unresolved');
  const artifact = await verifiedArtifact(input.buffer, manifest);
  const slide = artifact.slides.get(element.physicalLocator.slidePart)!;
  const shape = resolveShape(artifact, element);
  requireSimpleTextShape(shape);
  const nextShape = shape.replace(/(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/u,
    (_match, open: string, close: string) => `${open}${escapeXml(patch.operations[0].text)}${close}`);
  artifact.zip.file(element.physicalLocator.slidePart, slide.xml.replace(shape, nextShape));
  return artifact.zip.generateAsync({ type: 'nodebuffer' });
}

export class IdentityManifestError extends Error {
  constructor(readonly code: 'identity_unresolved' | 'identity_ambiguous' | 'identity_pin_mismatch') {
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
  return { zip, parts, slides };
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
function validXmlText(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) && !/[\ud800-\udfff]/u.test(value);
}
function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}
