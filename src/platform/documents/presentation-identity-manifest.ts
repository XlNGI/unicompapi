import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { readPptxSlideOrder } from './pptx-page-reader';
import type { DocumentIRPatch } from '../../domain/entities/document-ir-patch';
import { parseDocumentIRPatch } from '../../domain/entities/document-ir-patch';

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
  readonly physicalLocator: {
    readonly slidePart: string;
    readonly shapeId: string;
  };
}

export interface PresentationIdentityManifest {
  readonly schemaVersion: 1;
  readonly documentLineageId: string;
  readonly workId: string;
  readonly revision: number;
  readonly artifactChecksumSha256: string;
  readonly pages: readonly PresentationIdentityPage[];
  readonly elements: readonly PresentationIdentityElement[];
}
export type DocumentIdentityIndex = PresentationIdentityManifest;

/**
 * External identity metadata is pinned to the exact registered artifact. It
 * is the editable source index for the narrow text overlay and never guesses
 * identity from a later file's text or coordinates.
 */
export async function buildPresentationIdentityManifest(input: {
  readonly buffer: Uint8Array;
  readonly documentLineageId: string;
  readonly workId: string;
  readonly revision: number;
}): Promise<PresentationIdentityManifest> {
  const checksum = createHash('sha256').update(input.buffer).digest('hex');
  const zip = await JSZip.loadAsync(input.buffer);
  const slideParts = await readPptxSlideOrder(zip);
  const pages: PresentationIdentityPage[] = [];
  const elements: PresentationIdentityElement[] = [];
  for (const [index, slidePart] of slideParts.entries()) {
    const xml = await zip.file(slidePart)!.async('string');
    const pageId = opaqueId('page');
    pages.push({ pageId, physicalPageNumber: index + 1, slidePart,
      fingerprint: hash(JSON.stringify([slidePart, normalize(xml)])) });
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)];
    for (const shape of shapes) {
      const shapeId = /<p:cNvPr\b[^>]*\bid="([^"']+)"/u.exec(shape[0])?.[1];
      if (!shapeId || /name="UniComp Page Number"/u.test(shape[0])) continue;
      const texts = [...shape[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1]));
      const text = texts.join('');
      if (!text.trim()) continue;
      elements.push({ elementId: opaqueId('element'), pageId, kind: 'text', text,
        sourceFingerprint: hash(JSON.stringify([pageId, shapeId, normalize(text)])),
        physicalLocator: { slidePart, shapeId } });
    }
  }
  const manifest = { schemaVersion: 1 as const, documentLineageId: safeId(input.documentLineageId), workId: safeId(input.workId),
    revision: input.revision, artifactChecksumSha256: checksum, pages, elements };
  assertManifest(manifest);
  return Object.freeze(manifest);
}

export function parsePresentationIdentityManifest(value: unknown): PresentationIdentityManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_identity_manifest');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || !Array.isArray(item.pages) || !Array.isArray(item.elements)) throw new TypeError('invalid_identity_manifest');
  assertManifest(item as unknown as PresentationIdentityManifest);
  return item as unknown as PresentationIdentityManifest;
}

export async function readIdentityElementText(buffer: Uint8Array, manifestInput: unknown, elementId: string): Promise<string> {
  const manifest = parsePresentationIdentityManifest(manifestInput);
  const element = manifest.elements.find(item => item.elementId === elementId);
  if (!element) throw new IdentityManifestError('identity_unresolved');
  assertArtifactChecksum(buffer, manifest.artifactChecksumSha256);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file(element.physicalLocator.slidePart)?.async('string');
  if (!xml) throw new IdentityManifestError('identity_unresolved');
  const shape = findShape(xml, element.physicalLocator.shapeId);
  if (!shape) throw new IdentityManifestError('identity_unresolved');
  const text = [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1])).join('');
  if (normalize(text) !== normalize(element.text)) {
    throw new IdentityManifestError('identity_ambiguous');
  }
  return text;
}

/** Carry existing opaque IDs forward only through their exact physical locators. */
export async function carryForwardPresentationIdentityManifest(input: {
  readonly previous: unknown;
  readonly buffer: Uint8Array;
  readonly revision: number;
  readonly targetElementId: string;
  readonly targetText: string;
}): Promise<PresentationIdentityManifest> {
  const previous = parsePresentationIdentityManifest(input.previous);
  const zip = await JSZip.loadAsync(input.buffer);
  const elements: PresentationIdentityElement[] = [];
  for (const element of previous.elements) {
    const xml = await zip.file(element.physicalLocator.slidePart)?.async('string');
    const shape = xml ? findShape(xml, element.physicalLocator.shapeId) : undefined;
    if (!shape) throw new IdentityManifestError('identity_unresolved');
    const text = [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1])).join('');
    const expected = element.elementId === input.targetElementId ? input.targetText : element.text;
    if (normalize(text) !== normalize(expected)) throw new IdentityManifestError('identity_ambiguous');
    elements.push({ ...element, text, sourceFingerprint: hash(JSON.stringify([element.pageId, element.physicalLocator.shapeId, normalize(text)])) });
  }
  const checksum = createHash('sha256').update(input.buffer).digest('hex');
  const next = { ...previous, revision: input.revision, artifactChecksumSha256: checksum, elements };
  assertManifest(next);
  return Object.freeze(next);
}

/** Copy-on-write candidate mutation. The source artifact remains untouched. */
export async function applyPresentationTextPatch(input: {
  readonly buffer: Uint8Array;
  readonly manifest: unknown;
  readonly patch: DocumentIRPatch;
}): Promise<Uint8Array> {
  const manifest = parsePresentationIdentityManifest(input.manifest);
  const patch = parseDocumentIRPatch(input.patch);
  const element = manifest.elements.find(item => item.elementId === patch.operations[0].target.elementId);
  if (!element) throw new IdentityManifestError('identity_unresolved');
  assertArtifactChecksum(input.buffer, manifest.artifactChecksumSha256);
  const zip = await JSZip.loadAsync(input.buffer);
  const entry = zip.file(element.physicalLocator.slidePart);
  if (!entry) throw new IdentityManifestError('identity_unresolved');
  const xml = await entry.async('string');
  const shape = findShape(xml, element.physicalLocator.shapeId);
  if (!shape) throw new IdentityManifestError('identity_unresolved');
  const current = [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1])).join('');
  if (normalize(current) !== normalize(element.text)) throw new IdentityManifestError('identity_ambiguous');
  let first = true;
  const nextShape = shape.replace(/(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/gu, (_match, open: string, _value: string, close: string) => {
    if (first) { first = false; return `${open}${escapeXml(patch.operations[0].text)}${close}`; }
    return `${open}${close}`;
  });
  zip.file(element.physicalLocator.slidePart, xml.replace(shape, nextShape));
  return zip.generateAsync({ type: 'nodebuffer' });
}

export class IdentityManifestError extends Error {
  constructor(readonly code: 'identity_unresolved' | 'identity_ambiguous' | 'identity_pin_mismatch') {
    super(code);
    this.name = 'IdentityManifestError';
  }
}

function assertManifest(manifest: PresentationIdentityManifest): void {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(manifest.documentLineageId) || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(manifest.workId) ||
      !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 || !/^[a-f0-9]{64}$/u.test(manifest.artifactChecksumSha256) ||
      new Set(manifest.pages.map(page => page.pageId)).size !== manifest.pages.length ||
      new Set(manifest.elements.map(element => element.elementId)).size !== manifest.elements.length ||
      manifest.elements.some(element => !manifest.pages.some(page => page.pageId === element.pageId) || !element.text.trim())) {
    throw new TypeError('invalid_identity_manifest');
  }
}

function assertArtifactChecksum(buffer: Uint8Array, expected: string): void {
  if (createHash('sha256').update(buffer).digest('hex') !== expected) throw new IdentityManifestError('identity_pin_mismatch');
}
function findShape(xml: string, shapeId: string): string | undefined {
  return [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map(match => match[0])
    .find(shape => new RegExp(`<p:cNvPr\\b[^>]*\\bid=["']${escapeRegExp(shapeId)}["']`, 'u').test(shape));
}
function opaqueId(prefix: string): string { return `${prefix}-${randomUUID()}`; }
function safeId(value: string): string { if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) throw new TypeError('invalid_identity_id'); return value; }
function normalize(value: string): string { return value.replace(/\s+/gu, '').trim(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function decodeXml(value: string): string { return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&'); }
function escapeXml(value: string): string { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;'); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
