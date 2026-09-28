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
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.operations) ||
      value.operations.length !== 1) throw new TypeError('invalid_ir_patch');
  const operation = value.operations[0];
  if (!isRecord(operation) || operation.op !== 'update_text' || !isRecord(operation.target) ||
      typeof operation.target.elementId !== 'string' || !safeId(operation.target.elementId) ||
      typeof operation.text !== 'string' || operation.text.trim().length === 0 || operation.text.length > 8_000 ||
      Object.keys(operation).some(key => !['op', 'target', 'text'].includes(key)) ||
      Object.keys(operation.target).some(key => key !== 'elementId')) {
    throw new TypeError('invalid_ir_patch');
  }
  return Object.freeze({ schemaVersion: 1, operations: [Object.freeze({
    op: 'update_text', target: Object.freeze({ elementId: operation.target.elementId }), text: operation.text
  })] as [DocumentIRPatchOperation] });
}

export function updateTextPatch(elementId: string, text: string): DocumentIRPatch {
  return parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId }, text }] });
}

export function patchFingerprint(patch: DocumentIRPatch): string {
  let hash = 2166136261;
  for (const char of JSON.stringify(patch)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function safeId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.:-]{1,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
