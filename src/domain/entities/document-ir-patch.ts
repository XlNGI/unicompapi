export interface DocumentIRPatchOperation {
  readonly op: 'update_text';
  readonly target: { readonly elementId: string };
  readonly text: string;
}

export interface DocumentIRPatch {
  readonly schemaVersion: 1;
  readonly operations: readonly [DocumentIRPatchOperation];
}

export function parseDocumentIRPatch(value: unknown): DocumentIRPatch {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'operations']) || value.schemaVersion !== 1 || !Array.isArray(value.operations) ||
      value.operations.length !== 1) throw new TypeError('invalid_ir_patch');
  const operation = value.operations[0];
  if (!isRecord(operation) || operation.op !== 'update_text' || !isRecord(operation.target) ||
      typeof operation.target.elementId !== 'string' || !safeId(operation.target.elementId) ||
      typeof operation.text !== 'string' || !safeText(operation.text) ||
      !exactKeys(operation, ['op', 'target', 'text']) || !exactKeys(operation.target, ['elementId'])) {
    throw new TypeError('invalid_ir_patch');
  }
  return Object.freeze({ schemaVersion: 1, operations: Object.freeze([Object.freeze({
    op: 'update_text', target: Object.freeze({ elementId: operation.target.elementId }), text: operation.text
  })]) as readonly [DocumentIRPatchOperation] });
}

export function updateTextPatch(elementId: string, text: string): DocumentIRPatch {
  return parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId }, text }] });
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
