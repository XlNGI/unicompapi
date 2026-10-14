import { randomUUID } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { readPptxSlideOrder } from './pptx-page-reader';

/** Replaces rendered target slides and their package dependencies, preserving other parent parts. */
export async function replaceRenderedPresentationSlides(input: {
  readonly sourceBuffer: Uint8Array;
  readonly renderedBuffer: Uint8Array;
  readonly targetPageNumbers: readonly number[];
}): Promise<Buffer> {
  const source = await JSZip.loadAsync(input.sourceBuffer);
  const rendered = await JSZip.loadAsync(input.renderedBuffer);
  const [sourcePages, renderedPages] = await Promise.all([readPptxSlideOrder(source), readPptxSlideOrder(rendered)]);
  const targets = input.targetPageNumbers;
  if (!targets.length || targets.length !== renderedPages.length || new Set(targets).size !== targets.length ||
    targets.some(page => !Number.isSafeInteger(page) || page < 1 || page > sourcePages.length)) throw new TypeError('visual_slide_scope_invalid');
  const prefix = `ppt/visual-${randomUUID()}/`;
  const copies = new Map<string, string>();
  targets.forEach((page, index) => copies.set(renderedPages[index], sourcePages[page - 1]));
  const sourceTypes = await source.file('[Content_Types].xml')!.async('string');
  const newTypes = await rendered.file('[Content_Types].xml')!.async('string');
  const overrides = new Map([...newTypes.matchAll(/<Override\b[^>]*\bPartName="([^"]+)"[^>]*\bContentType="([^"]+)"[^>]*\/?\s*>/gu)]
    .map(match => [match[1].slice(1), match[2]]));
  const additions: string[] = [];
  const imported = new Set<string>();
  const relationsName = (part: string) => path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
  let importedBytes = 0;
  const copyPart = async (part: string): Promise<string> => {
    const destination = copies.get(part) ?? `${prefix}${part}`;
    copies.set(part, destination);
    if (imported.has(part)) return destination;
    if (imported.size >= 2048) throw new TypeError('visual_slide_dependency_budget');
    const entry = rendered.file(part);
    if (!entry) throw new TypeError('visual_slide_dependency_missing');
    imported.add(part);
    const bytes = await entry.async('nodebuffer');
    importedBytes += bytes.length;
    if (importedBytes > 64 * 1024 * 1024) throw new TypeError('visual_slide_dependency_budget');
    source.file(destination, bytes);
    const type = overrides.get(part);
    if (type && !sourceTypes.includes(`PartName="/${destination}"`)) additions.push(`<Override PartName="/${destination}" ContentType="${type}"/>`);
    const relations = rendered.file(relationsName(part));
    if (relations) {
      let xml = await relations.async('string');
      for (const match of [...xml.matchAll(/<Relationship\b[^>]*\/?\s*>/gu)]) {
        const tag = match[0];
        if (/\bTargetMode="External"/u.test(tag)) continue;
        const target = /\bTarget="([^"]+)"/u.exec(tag)?.[1];
        if (!target || /[\\&#]/u.test(target)) throw new TypeError('visual_slide_dependency_invalid');
        const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(part), target));
        if (resolved.startsWith('../') || resolved.startsWith('/')) throw new TypeError('visual_slide_dependency_invalid');
        const copied = await copyPart(resolved);
        const rewritten = tag.replace(`Target="${target}"`, `Target="${path.posix.relative(path.posix.dirname(destination), copied)}"`);
        xml = xml.replace(tag, rewritten);
      }
      source.file(relationsName(destination), xml);
    } else if (source.file(relationsName(destination))) {
      // Only the target slide relationship part may be removed here.
      source.remove(relationsName(destination));
    }
    return destination;
  };
  for (const slide of renderedPages) await copyPart(slide);
  for (const match of newTypes.matchAll(/<Default\b[^>]*\bExtension="([^"]+)"[^>]*\bContentType="([^"]+)"[^>]*\/?\s*>/gu)) {
    const existing = [...sourceTypes.matchAll(/<Default\b[^>]*\bExtension="([^"]+)"[^>]*\bContentType="([^"]+)"[^>]*\/?\s*>/gu)]
      .find(value => value[1] === match[1]);
    if (existing && existing[2] !== match[2]) throw new TypeError('visual_slide_content_type_conflict');
    if (!existing) additions.push(`<Default Extension="${match[1]}" ContentType="${match[2]}"/>`);
  }
  source.file('[Content_Types].xml', sourceTypes.replace('</Types>', additions.join('') + '</Types>'));
  return source.generateAsync({ type: 'nodebuffer' });
}
