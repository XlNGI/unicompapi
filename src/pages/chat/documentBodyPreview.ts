// Display-only limits; document compilation and validation keep their own contracts.
const maximumInputCharacters = 1_000_000;
const maximumOutputCharacters = 200_000;
const maximumNodes = 20_000;
const maximumDepth = 32;

type PreviewNode =
  | { readonly kind: 'string'; readonly value: string; readonly complete: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, PreviewNode> }
  | { readonly kind: 'array'; readonly items: readonly PreviewNode[] }
  | { readonly kind: 'literal' };

/** Reads a JSON prefix without repairing it or treating it as a valid document. */
class JsonPrefixReader {
  private position = 0;
  private nodes = 0;
  private stopped = false;
  resourceLimitReached = false;
  constructor(private readonly input: string) {}

  read(depth = 0): PreviewNode | undefined {
    if (this.stopped) return undefined;
    if (depth > maximumDepth || ++this.nodes > maximumNodes) {
      this.resourceLimitReached = true;
      this.stopped = true;
      return undefined;
    }
    this.whitespace();
    const character = this.input[this.position];
    if (character === '"') return this.string();
    if (character === '{') return this.object(depth);
    if (character === '[') return this.array(depth);
    const start = this.position;
    while (this.position < this.input.length && !/[\s,}\]]/.test(this.input[this.position])) this.position += 1;
    const token = this.input.slice(start, this.position);
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      const value = Number(token);
      if (Number.isFinite(value)) return { kind: 'number', value };
    }
    if (['true', 'false', 'null'].includes(token)) return { kind: 'literal' };
    this.stopped = true;
    return undefined;
  }

  private whitespace(): void {
    while (this.position < this.input.length && /\s/.test(this.input[this.position])) this.position += 1;
  }

  private string(): Extract<PreviewNode, { kind: 'string' }> {
    this.position += 1;
    const decoded: string[] = [];
    const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    let complete = false;
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (character === '"') { complete = true; break; }
      if (character.charCodeAt(0) < 0x20) { this.stopped = true; break; }
      if (character !== '\\') { decoded.push(character); continue; }
      const escape = this.input[this.position++];
      if (escape === 'u') {
        const digits = this.input.slice(this.position, this.position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) { this.stopped = true; break; }
        decoded.push(String.fromCharCode(Number.parseInt(digits, 16)));
        this.position += 4;
      } else if (Object.prototype.hasOwnProperty.call(escapes, escape)) decoded.push(escapes[escape]);
      else { this.stopped = true; break; }
    }
    if (!complete) this.stopped = true;
    return { kind: 'string', value: completeCodePoints(decoded.join('')), complete };
  }

  private object(depth: number): PreviewNode {
    this.position += 1;
    const fields = new Map<string, PreviewNode>();
    while (!this.stopped && this.position < this.input.length) {
      this.whitespace();
      if (this.input[this.position] === '}') { this.position += 1; break; }
      if (this.input[this.position] !== '"') { this.stopped = true; break; }
      const key = this.string();
      if (!key.complete || fields.has(key.value)) { this.stopped = true; break; }
      this.whitespace();
      if (this.input[this.position++] !== ':') { this.stopped = true; break; }
      const value = this.read(depth + 1);
      if (value) fields.set(key.value, value);
      if (this.stopped) break;
      this.whitespace();
      if (this.input[this.position] === '}') { this.position += 1; break; }
      if (this.input[this.position++] !== ',') { this.stopped = true; break; }
    }
    return { kind: 'object', fields };
  }

  private array(depth: number): PreviewNode {
    this.position += 1;
    const items: PreviewNode[] = [];
    while (!this.stopped && this.position < this.input.length) {
      this.whitespace();
      if (this.input[this.position] === ']') { this.position += 1; break; }
      const value = this.read(depth + 1);
      if (value) items.push(value);
      if (this.stopped) break;
      this.whitespace();
      if (this.input[this.position] === ']') { this.position += 1; break; }
      if (this.input[this.position++] !== ',') { this.stopped = true; break; }
    }
    return { kind: 'array', items };
  }
}

function completeCodePoints(value: string): string {
  // A stream may stop between UTF-16 surrogate halves, including two \u escapes.
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
function field(node: PreviewNode | undefined, key: string): PreviewNode | undefined {
  return node?.kind === 'object' ? node.fields.get(key) : undefined;
}
function text(node: PreviewNode | undefined): string {
  return node?.kind === 'string' ? node.value : '';
}
function items(node: PreviewNode | undefined): readonly PreviewNode[] {
  return node?.kind === 'array' ? node.items : [];
}
function tableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export interface DocumentBodyProjection {
  readonly content: string;
  readonly truncated: boolean;
}

/** Projects only the document body's explicit schema paths, including unfinished text values. */
export function projectDocumentBody(content: string): DocumentBodyProjection {
  if (typeof content !== 'string' || !content) return { content: '', truncated: false };
  let truncated = content.length > maximumInputCharacters;
  let input = content.slice(0, maximumInputCharacters).trimStart();
  if (/^`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?$/i.test(input)) return { content: '', truncated };
  const fence = /^```(?:json)?[ \t]*(?:\r?\n|$)/i.exec(input);
  const jsonFence = /^```json(?:[ \t\r\n]|$)/i.test(input);
  if (fence) input = input.slice(fence[0].length).trimStart();
  if (!input.startsWith('{')) {
    if (jsonFence || (fence && input === '') || /^\[\s*[\[{]/.test(input)) return { content: '', truncated };
    return { content: completeCodePoints(content.slice(0, maximumOutputCharacters)), truncated: content.length > maximumOutputCharacters };
  }
  const reader = new JsonPrefixReader(input);
  const root = reader.read();
  truncated ||= reader.resourceLimitReached;
  // A streamed PPT response may contain an unfinished LLM-authored scene.
  // Keep its layout instructions out of the readable body preview even when
  // a malformed response has temporarily placed them in a list block.
  const sceneHint = /"(?:scene|coverScene|closingScene|elements|elementId|zIndex)"\s*:/u.test(input);
  const pieces: string[] = [];
  let length = 0;
  function append(value: string): void {
    if (!value) return;
    if (length >= maximumOutputCharacters) { truncated = true; return; }
    const separator = pieces.length > 0 ? '\n\n' : '';
    if (separator.length + value.length > maximumOutputCharacters - length) truncated = true;
    const piece = (separator + value).slice(0, maximumOutputCharacters - length);
    pieces.push(piece);
    length += piece.length;
  }
  const title = text(field(root, 'title'));
  if (title) append(`# ${title.replace(/[\r\n]+/g, ' ')}`);
  for (const section of items(field(root, 'sections'))) {
    if (length >= maximumOutputCharacters) { truncated = true; break; }
    const heading = text(field(section, 'heading'));
    const level = field(section, 'level');
    if (heading) append(`${'#'.repeat(level?.kind === 'number' && [1, 2, 3].includes(level.value) ? level.value + 1 : 2)} ${heading.replace(/[\r\n]+/g, ' ')}`);
    append(text(field(section, 'takeaway')));
    for (const block of items(field(section, 'blocks'))) {
      if (length >= maximumOutputCharacters) { truncated = true; break; }
      const type = field(block, 'type');
      if (type?.kind !== 'string' || !type.complete) continue;
      switch (type.value) {
        case 'paragraph': append(text(field(block, 'text'))); break;
        case 'quote': {
          const quote = text(field(block, 'text'));
          if (quote) append(quote.split(/\r?\n/).map((line) => `> ${line}`).join('\n'));
          break;
        }
        case 'bullets':
        case 'numbered': {
          const lines = items(field(block, 'items')).map((item, index) => {
            const value = text(item);
            return value ? `${type.value === 'bullets' ? '-' : `${index + 1}.`} ${value}` : '';
          }).filter((line) => Boolean(line) &&
            !(sceneHint && isSceneMetadataPreviewLine(line)));
          append(lines.join('\n'));
          break;
        }
        case 'table': {
          const header = items(field(block, 'header')).map((cell) => tableCell(text(cell)));
          const rows = items(field(block, 'rows')).filter((row) => row.kind === 'array')
            .map((row) => items(row).map((cell) => tableCell(text(cell))));
          if (header.length && header.some(Boolean)) append([
            `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`,
            ...rows.map((row) => `| ${row.join(' | ')} |`)
          ].join('\n'));
          else append(rows.map((row) => row.filter(Boolean).join(' · ')).filter(Boolean).join('\n'));
          break;
        }
        case 'chart': {
          append(text(field(block, 'title')));
          append(items(field(block, 'data')).map((entry) => {
            const label = text(field(entry, 'label'));
            const value = field(entry, 'value');
            return label ? `- ${label}${value?.kind === 'number' ? `：${value.value}` : ''}` : '';
          }).filter(Boolean).join('\n'));
          break;
        }
      }
    }
    append(text(field(section, 'action')));
  }
  return { content: completeCodePoints(pieces.join('')), truncated };
}

function isSceneMetadataPreviewLine(value: string): boolean {
  const normalized = value.replace(/^\s*[-\d.]+\s+/, '').trim();
  if (/^[{}\[\],:]+$/u.test(normalized)) return true;
  return /^(?:elementId|schemaVersion|geometry|elements|zIndex|parentId|readingOrder|style|font(?:Size|Family|Weight)|textColor|fill|stroke|opacity|align|verticalAlign|x|y|t|l|r|b|width|height)\s*:/u.test(normalized) ||
    /(?:elementId|schemaVersion|zIndex|parentId|readingOrder|geometry|fontSize|textColor|width|height|\bt)\s*:/u.test(normalized);
}

export function documentBodyPreview(content: string): string {
  return projectDocumentBody(content).content;
}
