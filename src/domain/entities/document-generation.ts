import { toWorkId, type WorkId } from '../ids';

export const documentWorkspaceKinds = ['word', 'excel', 'ppt'] as const;
export type DocumentWorkspaceKind = (typeof documentWorkspaceKinds)[number];

export const presentationPageKinds = [
  'cover',
  'section',
  'insight',
  'comparison',
  'process',
  'data',
  'image_text',
  'closing'
] as const;
export type PresentationPageKind = (typeof presentationPageKinds)[number];

export const presentationTemplateIds = [
  'work_report',
  'natural_minimal',
  'business_minimal',
  'technology',
  'financing'
] as const;
export type PresentationTemplateId = (typeof presentationTemplateIds)[number];

export type DocumentOutlineBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'bullets'; readonly items: readonly string[] }
  | { readonly type: 'numbered'; readonly items: readonly string[] }
  | { readonly type: 'quote'; readonly text: string }
  | {
      readonly type: 'table';
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | {
      readonly type: 'chart';
      readonly chartKind: 'bar' | 'pie';
      readonly title?: string;
      readonly data: readonly {
        readonly label: string;
        readonly value: number;
      }[];
    };

export interface PresentationSectionMetadata {
  readonly pageKind?: PresentationPageKind;
  readonly takeaway?: string;
  readonly action?: string;
}

export interface DocumentOutlineSection extends PresentationSectionMetadata {
  readonly heading: string;
  readonly level: 1 | 2 | 3;
  readonly blocks: readonly DocumentOutlineBlock[];
}

export interface DocumentOutline {
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly sections: readonly DocumentOutlineSection[];
}

export const presentationDocumentPageLimits = {
  systemGeneratedPages: 2,
  minimumRequestedPages: 3,
  maximumPages: 40
} as const;

export const documentWorkspaceKindExtensions: Readonly<
  Record<DocumentWorkspaceKind, string>
> = {
  word: '.docx',
  excel: '.xlsx',
  ppt: '.pptx'
};

export interface DocumentMessageResult {
  readonly workId: WorkId;
  readonly fileName: string;
  readonly kind: DocumentWorkspaceKind;
  readonly sizeBytes: number;
}

export const documentGenerationStates = [
  'generating_content',
  'validating_outline',
  'generating_file',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type DocumentGenerationState = (typeof documentGenerationStates)[number];

export const documentGenerationFailureCodes = [
  'response_failed',
  'invalid_outline',
  'resource_limit',
  'document_layout_overflow',
  'revision_scope_violation',
  'revision_patch_failed',
  'revision_conflict',
  'unvalidated_output',
  'page_count_mismatch',
  'generation_failed',
  'storage_error'
] as const;
export type DocumentGenerationFailureCode =
  (typeof documentGenerationFailureCodes)[number];

export type DocumentGenerationStatus =
  | {
      readonly state:
        | 'generating_content'
        | 'validating_outline'
        | 'generating_file';
      readonly kind: DocumentWorkspaceKind;
    }
  | {
      readonly state: 'completed';
      readonly kind: DocumentWorkspaceKind;
    }
  | {
      readonly state: 'failed';
      readonly kind: DocumentWorkspaceKind;
      readonly errorCode: DocumentGenerationFailureCode;
    }
  | {
      readonly state: 'cancelled' | 'interrupted';
      readonly kind: DocumentWorkspaceKind;
    };

export function parseDocumentGenerationStatus(
  value: unknown
): DocumentGenerationStatus {
  if (!isRecord(value)) {
    throw new TypeError('message.documentGenerationStatus must be an object');
  }
  const state = value.state;
  if (
    typeof state !== 'string' ||
    !documentGenerationStates.includes(state as DocumentGenerationState)
  ) {
    throw new TypeError('message.documentGenerationStatus.state is invalid');
  }
  const kind = requireKind(value.kind);
  if (state === 'failed') {
    requireExactKeys(value, ['state', 'kind', 'errorCode']);
    if (
      typeof value.errorCode !== 'string' ||
      !documentGenerationFailureCodes.includes(
        value.errorCode as DocumentGenerationFailureCode
      )
    ) {
      throw new TypeError(
        'message.documentGenerationStatus.errorCode is invalid'
      );
    }
    return {
      state,
      kind,
      errorCode: value.errorCode as DocumentGenerationFailureCode
    };
  }
  requireExactKeys(value, ['state', 'kind']);
  return { state, kind } as DocumentGenerationStatus;
}

export function parseDocumentMessageResult(
  value: unknown
): DocumentMessageResult {
  if (!isRecord(value)) {
    throw new TypeError('message.documentResult must be an object');
  }
  const workId = toWorkId(
    requireNonBlankString(value.workId, 'message.documentResult.workId')
  );
  const fileName = requireNonBlankString(
    value.fileName,
    'message.documentResult.fileName'
  );
  if (fileName.length > 255) {
    throw new TypeError('message.documentResult.fileName exceeds the maximum length');
  }
  const kind = requireKind(value.kind);
  const sizeBytes = requireNonNegativeInteger(
    value.sizeBytes,
    'message.documentResult.sizeBytes'
  );
  return { workId, fileName, kind, sizeBytes };
}

export function isDocumentMessageResult(
  value: unknown
): value is DocumentMessageResult {
  try {
    parseDocumentMessageResult(value);
    return true;
  } catch {
    return false;
  }
}

function requireKind(value: unknown): DocumentWorkspaceKind {
  if (
    typeof value !== 'string' ||
    !documentWorkspaceKinds.includes(value as DocumentWorkspaceKind)
  ) {
    throw new TypeError('message.documentResult.kind is invalid');
  }
  return value as DocumentWorkspaceKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !(key in value));
  if (unsupported || missing) {
    throw new TypeError('message.documentGenerationStatus has invalid fields');
  }
}
