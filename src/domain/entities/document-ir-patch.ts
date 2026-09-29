export interface DocumentIRUpdateTextOperation {
  readonly op: 'update_text';
  readonly target: { readonly elementId: string; readonly pageId?: undefined };
  readonly text: string;
}

export interface DocumentIRAddTextOperation {
  readonly op: 'add_text';
  readonly target: { readonly pageId: string };
  /** Host-generated opaque identity. Providers never supply this field. */
  readonly elementId: string;
  readonly text: string;
  readonly placement: 'default';
}

export interface DocumentIRDeleteElementOperation {
  readonly op: 'delete_element';
  readonly target: { readonly elementId: string; readonly pageId?: undefined };
}

export type DocumentIRSlidePosition = 'before' | 'after' | 'end';
export interface DocumentIRAddSlideOperation {
  readonly op: 'add_slide';
  /** Host-generated opaque page identity; never provider-authored. */
  readonly pageId: string;
  readonly target: { readonly mode: DocumentIRSlidePosition; readonly referencePageId?: string };
  readonly title?: string;
  /** Host-generated identity for the optional title element. */
  readonly titleElementId?: string;
}

export type DocumentIRPatchOperation =
  | DocumentIRUpdateTextOperation
  | DocumentIRAddTextOperation
  | DocumentIRDeleteElementOperation
  | DocumentIRAddSlideOperation;

export interface DocumentIRPatch {
  readonly schemaVersion: 1;
  readonly operations: readonly [DocumentIRPatchOperation];
}

export function parseDocumentIRPatch(value: unknown): DocumentIRPatch {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'operations']) || value.schemaVersion !== 1 || !Array.isArray(value.operations) ||
      value.operations.length !== 1) throw new TypeError('invalid_ir_patch');
  const operation = value.operations[0];
  if (!isRecord(operation) || typeof operation.op !== 'string') throw new TypeError('invalid_ir_patch');
  if (operation.op === 'update_text') {
    if (!isRecord(operation.target) || typeof operation.target.elementId !== 'string' || !safeId(operation.target.elementId) ||
        typeof operation.text !== 'string' || !safeText(operation.text) ||
        !exactKeys(operation, ['op', 'target', 'text']) || !exactKeys(operation.target, ['elementId'])) {
      throw new TypeError('invalid_ir_patch');
    }
    return Object.freeze({ schemaVersion: 1, operations: Object.freeze([Object.freeze({
      op: 'update_text', target: Object.freeze({ elementId: operation.target.elementId }), text: operation.text
    })]) as readonly [DocumentIRPatchOperation] });
  }
  if (operation.op === 'add_text') {
    if (!isRecord(operation.target) || typeof operation.target.pageId !== 'string' || !safeId(operation.target.pageId) ||
        typeof operation.elementId !== 'string' || !safeId(operation.elementId) || typeof operation.text !== 'string' || !safeText(operation.text) ||
        operation.placement !== 'default' || !exactKeys(operation, ['op', 'target', 'elementId', 'text', 'placement']) ||
        !exactKeys(operation.target, ['pageId'])) throw new TypeError('invalid_ir_patch');
    return Object.freeze({ schemaVersion: 1, operations: Object.freeze([Object.freeze({
      op: 'add_text', target: Object.freeze({ pageId: operation.target.pageId }), elementId: operation.elementId,
      text: operation.text, placement: 'default'
    })]) as readonly [DocumentIRPatchOperation] });
  }
  if (operation.op === 'delete_element') {
    if (!isRecord(operation.target) || typeof operation.target.elementId !== 'string' || !safeId(operation.target.elementId) ||
        !exactKeys(operation, ['op', 'target']) || !exactKeys(operation.target, ['elementId'])) throw new TypeError('invalid_ir_patch');
    return Object.freeze({ schemaVersion: 1, operations: Object.freeze([Object.freeze({
      op: 'delete_element', target: Object.freeze({ elementId: operation.target.elementId })
    })]) as readonly [DocumentIRPatchOperation] });
  }
  if (operation.op === 'add_slide') {
    if (typeof operation.pageId !== 'string' || !safeId(operation.pageId) || !isRecord(operation.target) ||
        typeof operation.target.mode !== 'string' || !['before', 'after', 'end'].includes(operation.target.mode) ||
        !exactKeys(operation.target, Object.prototype.hasOwnProperty.call(operation.target, 'referencePageId')
          ? ['mode', 'referencePageId'] : ['mode'])) throw new TypeError('invalid_ir_patch');
    const mode = operation.target.mode as DocumentIRSlidePosition;
    const hasReference = Object.prototype.hasOwnProperty.call(operation.target, 'referencePageId');
    if ((mode === 'end' && hasReference) || (mode !== 'end' && (!hasReference || typeof operation.target.referencePageId !== 'string' || !safeId(operation.target.referencePageId)))) {
      throw new TypeError('invalid_ir_patch');
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(operation, 'title');
    const hasTitleElement = Object.prototype.hasOwnProperty.call(operation, 'titleElementId');
    if (hasTitle !== hasTitleElement || (hasTitle && (typeof operation.title !== 'string' || !safeText(operation.title) ||
        typeof operation.titleElementId !== 'string' || !safeId(operation.titleElementId)))) throw new TypeError('invalid_ir_patch');
    const keys = ['op', 'pageId', 'target', ...(hasTitle ? ['title', 'titleElementId'] : [])];
    if (!exactKeys(operation, keys)) throw new TypeError('invalid_ir_patch');
    return Object.freeze({ schemaVersion: 1, operations: Object.freeze([Object.freeze({
      op: 'add_slide' as const, pageId: operation.pageId,
      target: Object.freeze({ mode, ...(hasReference ? { referencePageId: operation.target.referencePageId } : {}) }),
      ...(hasTitle ? { title: operation.title, titleElementId: operation.titleElementId } : {})
    })]) as readonly [DocumentIRPatchOperation] });
  }
  throw new TypeError('invalid_ir_patch');
}

export function updateTextPatch(elementId: string, text: string): DocumentIRPatch {
  return parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId }, text }] });
}

export function addTextPatch(pageId: string, elementId: string, text: string, placement: 'default' = 'default'): DocumentIRPatch {
  return parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'add_text', target: { pageId }, elementId, text, placement }] });
}

export function deleteElementPatch(elementId: string): DocumentIRPatch {
  return parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'delete_element', target: { elementId } }] });
}

export function addSlidePatch(input: {
  readonly pageId: string; readonly mode: DocumentIRSlidePosition; readonly referencePageId?: string;
  readonly title?: string; readonly titleElementId?: string;
}): DocumentIRPatch {
  return parseDocumentIRPatch({ schemaVersion: 1, operations: [{
    op: 'add_slide', pageId: input.pageId,
    target: { mode: input.mode, ...(input.referencePageId === undefined ? {} : { referencePageId: input.referencePageId }) },
    ...(input.title === undefined ? {} : { title: input.title, titleElementId: input.titleElementId })
  }] });
}

export async function patchFingerprint(patch: DocumentIRPatch): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parseDocumentIRPatch(patch))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function safeText(value: string): boolean {
  if (value.trim().length === 0 || value.length > 8_000) return false;
  // XML 1.0 allows tab/newline/CR, but not other controls or unpaired surrogates.
  return [...value].every(char => {
    const code = char.codePointAt(0)!;
    return code === 9 || code === 10 || code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
  });
}

function safeId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.:-]{1,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
