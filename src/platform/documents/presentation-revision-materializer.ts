import { createHash } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { readPptxSlideOrder } from './pptx-page-reader';
import { buildPresentationIdentityManifest, parsePresentationIdentityManifest, type PresentationIdentityManifest } from './presentation-identity-manifest';

/** Preserve concrete non-target OOXML parts and their dependency closure; never fetch external assets. */
export async function preserveUntargetedPresentationParts(source: Uint8Array, candidate: Uint8Array, targetPages: readonly number[], signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const [original, output] = await Promise.all([JSZip.loadAsync(source), JSZip.loadAsync(candidate)]);
  if (Object.keys(original.files).length > 1_000 || Object.keys(output.files).length > 1_000) throw new Error('revision_scope_violation');
  const [before, after] = await Promise.all([readPptxSlideOrder(original), readPptxSlideOrder(output)]);
  if (before.length !== after.length || before.some((name, index) => name !== after[index])) throw new Error('revision_scope_violation');
  const selected = new Set(targetPages);
  const copied = new Set<string>();
  const dependencies = async (zip: JSZip, name: string) => {
    const rels = path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels');
    const entry = zip.file(rels);
    if (!entry) return { rels, xml: '', targets: [] as string[] };
    const xml = await entry.async('string');
    if (xml.length > 1_000_000) throw new Error('revision_scope_violation');
    const targets = [...xml.matchAll(/<Relationship\b[^>]*\bTarget=["']([^"']+)["'][^>]*\/?\s*>/gu)].map(match => {
      if (/TargetMode=["']External["']/u.test(match[0])) throw new Error('revision_external_relationship');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      if (target.startsWith('../') || target.startsWith('/') || target.includes('\\')) throw new Error('revision_scope_violation');
      return target;
    });
    return { rels, xml, targets };
  };
  const targetDependencies = new Set<string>();
  const visitTarget = async (name: string): Promise<void> => {
    signal?.throwIfAborted();
    if (targetDependencies.has(name)) return;
    if (targetDependencies.size >= 1_000) throw new Error('revision_scope_violation');
    targetDependencies.add(name);
    for (const dependency of (await dependencies(output, name)).targets) await visitTarget(dependency);
  };
  for (const [index, name] of after.entries()) if (selected.has(index + 1)) await visitTarget(name);
  let expandedBytes = 0;
  const copyPart = async (name: string, isSlide = false): Promise<void> => {
    signal?.throwIfAborted();
    if (copied.has(name)) return;
    const slideIndex = before.indexOf(name);
    if (slideIndex >= 0 && selected.has(slideIndex + 1)) return;
    if (copied.size >= 1_000 || name.startsWith('../') || name.startsWith('/') || name.includes('\\')) throw new Error('revision_scope_violation');
    const entry = original.file(name);
    if (!entry) throw new Error('revision_scope_violation');
    const bytes = await entry.async('uint8array');
    expandedBytes += bytes.length;
    if (bytes.length > 20 * 1024 * 1024 || expandedBytes > 64 * 1024 * 1024) throw new Error('revision_scope_violation');
    const existing = output.file(name);
    if (!isSlide && targetDependencies.has(name) && existing && hash(await existing.async('uint8array')) !== hash(bytes)) throw new Error('revision_dependency_conflict');
    output.file(name, bytes); copied.add(name);
    const relation = await dependencies(original, name);
    for (const dependency of relation.targets) await copyPart(dependency);
    if (relation.xml) output.file(relation.rels, relation.xml);
  };
  for (const [index, name] of before.entries()) if (!selected.has(index + 1)) await copyPart(name, true);
  const sourceTypes = await original.file('[Content_Types].xml')!.async('string');
  let outputTypes = await output.file('[Content_Types].xml')!.async('string');
  for (const match of sourceTypes.matchAll(/<Override\b[^>]*PartName=["']([^"']+)["'][^>]*\/>/gu)) {
    if (copied.has(match[1].replace(/^\//u, '')) && !outputTypes.includes(`PartName="${match[1]}"`)) outputTypes = outputTypes.replace('</Types>', match[0] + '</Types>');
  }
  const extensions = new Set([...copied].map(name => path.posix.extname(name).slice(1)));
  for (const match of sourceTypes.matchAll(/<Default\b[^>]*Extension=["']([^"']+)["'][^>]*\/>/gu)) {
    if (extensions.has(match[1]) && !outputTypes.includes(`Extension="${match[1]}"`)) outputTypes = outputTypes.replace('</Types>', match[0] + '</Types>');
  }
  output.file('[Content_Types].xml', outputTypes);
  signal?.throwIfAborted();
  return output.generateAsync({ type: 'uint8array' });
}

/** Unchanged pages retain exact physical identities. Redesigned page objects receive new identities and tombstones. */
export async function carryForwardPresentationDesignIdentity(input: { readonly previous: PresentationIdentityManifest;
  readonly buffer: Uint8Array; readonly targetPages: readonly number[]; readonly workId: string; readonly fileId: string; readonly sourceExecutionId: string }) {
  const previous = input.previous;
  const created = await buildPresentationIdentityManifest({ ...input, documentLineageId: previous.documentLineageId, revision: previous.revision + 1 });
  const selected = new Set(input.targetPages);
  if (created.pages.length !== previous.pages.length) throw new Error('revision_scope_violation');
  const pages = created.pages.map(page => {
    const old = previous.pages.find(item => item.physicalPageNumber === page.physicalPageNumber);
    if (!old || !selected.has(page.physicalPageNumber) && old.fingerprint !== page.fingerprint) throw new Error('revision_scope_violation');
    return { ...page, pageId: old.pageId };
  });
  const elements = created.elements.map(element => {
    const page = created.pages.find(item => item.pageId === element.pageId)!;
    const oldPage = pages.find(item => item.physicalPageNumber === page.physicalPageNumber)!;
    if (selected.has(page.physicalPageNumber)) return { ...element, pageId: oldPage.pageId };
    const old = previous.elements.find(item => item.pageId === oldPage.pageId && item.physicalLocator.shapeId === element.physicalLocator.shapeId &&
      item.physicalLocator.slidePart === element.physicalLocator.slidePart && item.sourceFingerprint === element.sourceFingerprint);
    if (!old) throw new Error('revision_scope_violation');
    return old;
  });
  const retained = new Set(elements.map(element => element.elementId));
  const tombstones = [...previous.tombstones, ...previous.elements.filter(element => !retained.has(element.elementId))
    .map(element => ({ elementId: element.elementId, pageId: element.pageId, revision: created.revision }))];
  return parsePresentationIdentityManifest({ ...created, pages, elements, tombstones });
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
