import path from 'node:path';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_XML_BYTES = 10 * 1024 * 1024;
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

interface XmlNode {
  readonly name: string;
  readonly localName: string;
  readonly namespace: string;
  readonly namespaces: ReadonlyMap<string, string>;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: (XmlNode | string)[];
}

function invalid(reason: string): never {
  const code = reason === 'page out of range' ? 'page_out_of_range'
    : reason.includes('limit') ? 'scope_exceeded' : 'invalid_pptx';
  throw Object.assign(new Error(`PPTX page read failed: ${reason}`), { code });
}

function validXmlCharacters(text: string): boolean {
  return !/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text);
}

function decodeEntities(text: string): string {
  const decoded = text.replace(/&([^;]*);|&/g, (entity, value: string | undefined) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (value && Object.prototype.hasOwnProperty.call(named, value)) return named[value];
    if (value && /^(?:#\d+|#x[\da-fA-F]+)$/.test(value)) {
      const number = value.startsWith('#x')
        ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1));
      if (number <= 0x10ffff && number >= 0) {
        const character = String.fromCodePoint(number);
        if (validXmlCharacters(character)) return character;
      }
    }
    return invalid(entity === '&' ? 'unterminated XML entity' : 'unsupported XML entity');
  });
  if (!validXmlCharacters(decoded)) invalid('invalid XML character');
  return decoded;
}

/** Bounded XML subset: no DTDs, entities, external resources, or recovery parsing. */
function parseXml(xml: string): XmlNode {
  const source = xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!validXmlCharacters(source)) invalid('invalid XML character');
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let cursor = 0;
  let tokens = 0;
  const appendText = (text: string) => {
    if (stack.length) stack[stack.length - 1].children.push(text);
    else if (text.trim()) invalid('text outside XML root');
  };
  while (cursor < source.length) {
    if (++tokens > 200_000) invalid('XML complexity limit');
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      const end = next < 0 ? source.length : next;
      const text = source.slice(cursor, end);
      if (text.includes(']]>')) invalid('invalid XML text');
      appendText(decodeEntities(text));
      cursor = end;
      continue;
    }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0 || source.slice(cursor + 4, end).includes('--')) invalid('invalid XML comment');
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', cursor)) {
      const end = source.indexOf(']]>', cursor + 9);
      if (end < 0 || !stack.length) invalid('invalid XML CDATA');
      appendText(source.slice(cursor + 9, end));
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', cursor)) {
      const end = source.indexOf('?>', cursor + 2);
      if (cursor !== 0 || root || end < 0 ||
        !/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/i
          .test(source.slice(cursor, end + 2))) invalid('unsupported XML declaration');
      cursor = end + 2;
      continue;
    }
    const tag = /^<(\/)?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(source.slice(cursor));
    if (!tag) invalid('invalid XML tag');
    cursor += tag[0].length;
    const name = tag[2];
    if (tag[1]) {
      const closing = /^\s*>/.exec(source.slice(cursor));
      if (!closing || stack.pop()?.name !== name) invalid('unbalanced XML tags');
      cursor += closing[0].length;
      continue;
    }
    const attributes = new Map<string, string>();
    while (true) {
      const attribute = /^\s+([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*(['"])([\s\S]*?)\2/.exec(source.slice(cursor));
      if (!attribute) break;
      if (attributes.has(attribute[1]) || attribute[3].includes('<')) invalid('invalid XML attribute');
      attributes.set(attribute[1], decodeEntities(attribute[3].replace(/[\t\n]/g, ' ')));
      cursor += attribute[0].length;
    }
    const endTag = /^\s*(\/?)>/.exec(source.slice(cursor));
    if (!endTag) invalid('unterminated XML tag');
    cursor += endTag[0].length;
    const namespaces = new Map(stack.at(-1)?.namespaces ?? [['xml', 'http://www.w3.org/XML/1998/namespace']]);
    for (const [key, value] of attributes) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value);
    }
    const expandedName = (raw: string, attribute = false): string => {
      const parts = raw.split(':');
      const namespace = parts.length === 2 ? namespaces.get(parts[0]) : attribute ? '' : namespaces.get('') ?? '';
      if (namespace === undefined) invalid('unbound XML namespace');
      return `${namespace}|${parts.at(-1)}`;
    };
    const resolvedAttributes = new Map<string, string>();
    for (const [key, value] of attributes) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const expanded = expandedName(key, true);
      if (resolvedAttributes.has(expanded)) invalid('duplicate XML attribute');
      resolvedAttributes.set(expanded, value);
    }
    const [namespace, localName] = expandedName(name).split('|');
    const node: XmlNode = { name, namespace, localName, namespaces,
      attributes: resolvedAttributes, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) invalid('multiple XML roots');
    else root = node;
    if (!endTag[1]) stack.push(node);
    if (stack.length > 128) invalid('XML depth limit');
  }
  if (!root || stack.length) invalid('incomplete XML document');
  return root;
}

function hasName(node: XmlNode, namespace: string, name: string): boolean {
  return node.namespace === namespace && node.localName === name;
}

function childNodes(node: XmlNode): XmlNode[] {
  return node.children.filter((child): child is XmlNode => typeof child !== 'string');
}

/** Validate directory metadata before JSZip allocates entries or decompresses XML. */
function validateZip(buffer: Uint8Array): ReadonlySet<string> {
  if (buffer.byteLength > MAX_FILE_BYTES) invalid('package size limit');
  if (buffer.byteLength < 22) invalid('invalid package size');
  const data = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65_557); index--) {
    if (data.readUInt32LE(index) === 0x06054b50 && index + 22 + data.readUInt16LE(index + 20) === data.length) {
      end = index;
      break;
    }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) invalid('invalid ZIP directory');
  const count = data.readUInt16LE(end + 10);
  if (!count || count > MAX_ENTRIES || count !== data.readUInt16LE(end + 8)) invalid('ZIP entry limit');
  let cursor = data.readUInt32LE(end + 16);
  if (cursor + data.readUInt32LE(end + 12) !== end) invalid('invalid ZIP directory bounds');
  const names = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) invalid('invalid ZIP entry');
    const size = data.readUInt32LE(cursor + 24);
    const nameEnd = cursor + 46 + data.readUInt16LE(cursor + 28);
    const entryEnd = nameEnd + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    if (entryEnd > end || data.readUInt16LE(cursor + 8) & 1) invalid('invalid ZIP entry bounds');
    const name = decoder.decode(data.subarray(cursor + 46, nameEnd));
    const parts = name.replace(/\/$/, '').split('/');
    if (!name || /[\\:\u0000]/.test(name) || parts.some((part) => !part || part === '.' || part === '..')) {
      invalid('unsafe ZIP entry path');
    }
    if (names.has(name)) invalid('duplicate ZIP entry');
    names.add(name);
    if (/\.(?:xml|rels)$/i.test(name) && size > MAX_XML_BYTES) invalid('XML size limit');
    cursor = entryEnd;
  }
  if (cursor !== end) invalid('invalid ZIP entry count');
  return names;
}

async function readXml(zip: JSZip, name: string, budget?: { remaining: number }): Promise<XmlNode> {
  const entry = zip.file(name);
  if (!entry) invalid('missing XML part');
  const stream = entry.nodeStream() as Readable;
  const chunks: Uint8Array[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (bytes: Uint8Array) => {
      size += bytes.byteLength;
      if (budget) budget.remaining -= bytes.byteLength;
      if (size > MAX_XML_BYTES || (budget && budget.remaining < 0)) {
        stream.pause();
        stream.destroy();
        reject(Object.assign(new Error('PPTX page read failed: XML size limit'), { code: 'scope_exceeded' }));
      } else chunks.push(bytes);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return parseXml(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function slideTarget(target: string): string {
  if (!target || /[\\:%?#\u0000-\u0020]/.test(target) || target.startsWith('//')) invalid('unsafe slide target');
  const resolved = target.startsWith('/') ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join('ppt', target));
  if (!resolved.startsWith('ppt/slides/') || !resolved.endsWith('.xml') ||
    target.split('/').includes('..')) invalid('slide target outside slides directory');
  return resolved;
}

/** Physical slide numbering follows presentation order, including cover, hidden and blank slides. */
export async function readPptxPage(
  buffer: Uint8Array,
  pageNumber: number
): Promise<{ pageNumber: number; totalPages: number; text: string; hidden: boolean }> {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) invalid('invalid page number');
  const zip = await openPptx(buffer);
  const targets = await readPptxSlideOrder(zip);
  if (pageNumber > targets.length) invalid('page out of range');
  const page = await readSlide(zip, targets[pageNumber - 1]);
  return { pageNumber, totalPages: targets.length, text: page.text, hidden: page.hidden };
}

export interface PptxPhysicalPage {
  readonly pageNumber: number;
  readonly partName: string;
  readonly heading: string;
  readonly text: string;
  readonly contentText: string;
  readonly hidden: boolean;
}

export async function readPptxDocument(buffer: Uint8Array): Promise<readonly PptxPhysicalPage[]> {
  const zip = await openPptx(buffer);
  const targets = await readPptxSlideOrder(zip);
  if (targets.length > 128) invalid('page count limit');
  const budget = { remaining: 64 * 1024 * 1024 };
  const pages: PptxPhysicalPage[] = [];
  for (const [index, partName] of targets.entries()) {
    pages.push({ pageNumber: index + 1, partName, ...await readSlide(zip, partName, budget) });
  }
  return pages;
}

async function openPptx(buffer: Uint8Array): Promise<JSZip> {
  const partNames = validateZip(buffer);
  const zip = await JSZip.loadAsync(buffer);
  if (Object.keys(zip.files).length !== partNames.size || Object.values(zip.files).some((entry) =>
    !partNames.has(entry.name) || (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name))) {
    invalid('inconsistent ZIP entry names');
  }
  return zip;
}

/** Shared by reading, patching and verification; ZIP filenames are not page numbers. */
export async function readPptxSlideOrder(zip: JSZip): Promise<readonly string[]> {
  const presentation = await readXml(zip, 'ppt/presentation.xml');
  if (!hasName(presentation, PRESENTATION_NS, 'presentation')) invalid('invalid presentation root');
  const lists = childNodes(presentation).filter((node) => hasName(node, PRESENTATION_NS, 'sldIdLst'));
  if (lists.length !== 1) invalid('missing or duplicate slide list');
  const slides = childNodes(lists[0]);
  if (slides.some((node) => !hasName(node, PRESENTATION_NS, 'sldId'))) invalid('invalid slide list');
  const relationships = await readXml(zip, 'ppt/_rels/presentation.xml.rels');
  if (!hasName(relationships, PACKAGE_REL_NS, 'Relationships')) invalid('invalid relationships root');
  const relationMap = new Map<string, XmlNode>();
  for (const relation of childNodes(relationships)) {
    const id = relation.attributes.get('|Id');
    if (!hasName(relation, PACKAGE_REL_NS, 'Relationship') || !id || relationMap.has(id)) invalid('invalid relationship');
    relationMap.set(id, relation);
  }
  const seen = new Set<string>();
  const targets = slides.map((slide) => {
    const id = slide.attributes.get(`${OFFICE_REL_NS}|id`);
    if (!id || seen.has(id)) invalid('invalid slide relationship id');
    seen.add(id);
    const relation = relationMap.get(id);
    if (!relation || relation.attributes.get('|Type') !== `${OFFICE_REL_NS}/slide` ||
      !['Internal', undefined].includes(relation.attributes.get('|TargetMode'))) invalid('invalid slide relationship');
    const target = slideTarget(relation.attributes.get('|Target') ?? '');
    if (!zip.file(target)) invalid('missing slide part');
    return target;
  });
  if (new Set(targets).size !== targets.length) invalid('duplicate slide target');
  return targets;
}

async function readSlide(zip: JSZip, partName: string, budget?: { remaining: number }) {
  const slide = await readXml(zip, partName, budget);
  if (!hasName(slide, PRESENTATION_NS, 'sld')) invalid('invalid slide root');
  const paragraphs: string[] = [];
  const paragraphText = (node: XmlNode): string => node.children.map((child) => {
    if (typeof child === 'string') return '';
    if (hasName(child, DRAWING_NS, 't')) return child.children.map((part) => {
      if (typeof part !== 'string') invalid('invalid DrawingML text');
      return part;
    }).join('');
    if (hasName(child, DRAWING_NS, 'br')) return '\n';
    if (hasName(child, DRAWING_NS, 'tab')) return '\t';
    return paragraphText(child);
  }).join('');
  const contentParagraphs: string[] = [];
  const containsPageNumber = (node: XmlNode): boolean =>
    (hasName(node, PRESENTATION_NS, 'cNvPr') && node.attributes.get('|name') === 'UniComp Page Number') ||
    (hasName(node, PRESENTATION_NS, 'ph') && node.attributes.get('|type') === 'sldNum') ||
    (hasName(node, DRAWING_NS, 'off') && node.attributes.get('|x') === '11247120' && node.attributes.get('|y') === '6446520') ||
    childNodes(node).some(containsPageNumber);
  const visit = (node: XmlNode, isPageNumber = false) => {
    const footer = isPageNumber || (hasName(node, PRESENTATION_NS, 'sp') && containsPageNumber(node));
    if (hasName(node, DRAWING_NS, 'p')) {
      paragraphs.push(paragraphText(node));
      if (!footer) contentParagraphs.push(paragraphText(node));
    } else childNodes(node).forEach((child) => visit(child, footer));
  };
  visit(slide);
  const text = paragraphs.join('\n');
  const show = slide.attributes.get('|show');
  if (show !== undefined && !['true', 'false', '0', '1'].includes(show)) invalid('invalid slide visibility');
  return { heading: contentParagraphs.find((paragraph) => paragraph.trim())?.trim() ?? '', text: text.trim() ? text : '', contentText: contentParagraphs.join('\n'),
    hidden: show === '0' || show === 'false' };
}
