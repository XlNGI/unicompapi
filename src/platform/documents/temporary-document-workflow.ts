import type {
  DocumentOutline,
  DocumentWorkspaceKind,
  PresentationPlan
} from '../../domain';
import {
  applyStructuredDocumentPatch,
  readStructuredDocument,
  type DocumentPatch,
  type DocumentPatchChange,
  type DocumentStructureSnapshot
} from './structured-document-tools';
import {
  generateTemporaryDocumentFile,
  type GenerateDocumentFileInput,
  type GeneratedTemporaryDocumentFile
} from './office-document-generator';
import { buildPresentationPlanFromOutline } from './presentation-plan';
import type { PresentationTemplateId } from './presentation-template';
import { unlink } from 'node:fs/promises';

export type DocumentDiagnosticSeverity = 'error' | 'warning';

export interface DocumentQualityDiagnostic {
  readonly code:
    | 'empty_document'
    | 'empty_section'
    | 'capacity_exceeded'
    | 'table_too_wide'
    | 'render_warning'
    | 'render_failed'
    | 'font_missing'
    | 'empty_page'
    | 'invalid_image'
    | 'page_count_mismatch'
    | 'text_overflow'
    | 'overlap';
  readonly severity: DocumentDiagnosticSeverity;
  readonly scope: string;
  readonly message: string;
}

export interface DocumentRenderResult {
  readonly previewCount: number;
  readonly warnings?: readonly string[];
  readonly diagnostics?: readonly {
    readonly code: 'font_missing' | 'empty_page' | 'invalid_image' | 'page_count_mismatch' | 'text_overflow' | 'overlap';
    readonly severity: DocumentDiagnosticSeverity;
    readonly scope: string;
    readonly message: string;
  }[];
}

export type DocumentRenderAdapter = (
  temporaryPath: string,
  input: { readonly kind: DocumentWorkspaceKind; readonly signal: AbortSignal }
) => Promise<DocumentRenderResult>;

export interface TemporaryDocumentWorkflowInput {
  readonly outline: DocumentOutline;
  readonly patch?: DocumentPatch | unknown;
  readonly outputDirectory?: string;
  readonly now?: string;
  readonly theme?: GenerateDocumentFileInput['theme'];
  readonly presentationTemplate?: PresentationTemplateId;
  readonly signal?: AbortSignal;
  readonly generateTemporaryFile?: (
    input: GenerateDocumentFileInput
  ) => Promise<GeneratedTemporaryDocumentFile>;
  readonly render?: DocumentRenderAdapter;
}

export interface TemporaryDocumentWorkflowResult {
  readonly status: 'ready' | 'rejected' | 'cancelled' | 'failed';
  readonly outline: DocumentOutline;
  readonly structure: DocumentStructureSnapshot;
  readonly change?: DocumentPatchChange;
  readonly presentationPlan?: PresentationPlan;
  readonly diagnostics: readonly DocumentQualityDiagnostic[];
  readonly temporary?: {
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly rendered: boolean;
  };
}

export async function prepareTemporaryDocumentVersion(
  input: TemporaryDocumentWorkflowInput
): Promise<TemporaryDocumentWorkflowResult> {
  if (input.signal?.aborted) return cancelled(input.outline);
  let outline = input.outline;
  let change: DocumentPatchChange | undefined;
  try {
    if (input.patch !== undefined) {
      const patched = applyStructuredDocumentPatch(outline, input.patch);
      outline = patched.document;
      change = patched.change;
    }
  } catch (error) {
    return {
      status: 'rejected',
      outline,
      structure: readStructuredDocument(outline),
      diagnostics: [{
        code: 'empty_document',
        severity: 'error',
        scope: 'patch',
        message: safeError(error)
      }]
    };
  }
  const structure = readStructuredDocument(outline);
  const presentationPlan = outline.kind === 'ppt'
    ? buildPresentationPlanFromOutline(outline, {
        templateId: input.presentationTemplate
      })
    : undefined;
  const diagnostics = collectDeterministicDiagnostics(outline, presentationPlan);
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return {
      status: 'rejected',
      outline,
      structure,
      ...(change !== undefined ? { change } : {}),
      ...(presentationPlan !== undefined ? { presentationPlan } : {}),
      diagnostics
    };
  }
  if (input.signal?.aborted) return cancelled(outline, structure, change, presentationPlan, diagnostics);
  if (!input.generateTemporaryFile && !input.render) {
    return {
      status: 'ready',
      outline,
      structure,
      ...(change !== undefined ? { change } : {}),
      ...(presentationPlan !== undefined ? { presentationPlan } : {}),
      diagnostics
    };
  }
  let temporary: GeneratedTemporaryDocumentFile | undefined;
  try {
    const generator = input.generateTemporaryFile ?? generateTemporaryDocumentFile;
    temporary = await generator({
      kind: outline.kind,
      outline,
      outputDirectory: input.outputDirectory ?? 'files/documents',
      now: input.now ?? new Date().toISOString(),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
      ...(input.presentationTemplate !== undefined
        ? { presentationTemplate: input.presentationTemplate }
        : {})
    });
    if (input.signal?.aborted) {
      await discardTemporaryDocument(temporary);
      return cancelled(outline, structure, change, presentationPlan, diagnostics);
    }
    let rendered = false;
    if (input.render) {
      try {
        const renderResult = await input.render(temporary.temporaryPath, {
          kind: outline.kind,
          signal: input.signal ?? new AbortController().signal
        });
        rendered = true;
        for (const warning of renderResult.warnings ?? []) {
          diagnostics.push({
            code: 'render_warning',
            severity: 'warning',
            scope: 'render',
            message: warning.slice(0, 300)
          });
        }
        for (const diagnostic of renderResult.diagnostics ?? []) {
          diagnostics.push(diagnostic);
        }
        if ((renderResult.diagnostics ?? []).some((diagnostic) => diagnostic.severity === 'error')) {
          await discardTemporaryDocument(temporary);
          return {
            status: 'rejected',
            outline,
            structure,
            ...(change !== undefined ? { change } : {}),
            ...(presentationPlan !== undefined ? { presentationPlan } : {}),
            diagnostics
          };
        }
      } catch (error) {
        await discardTemporaryDocument(temporary);
        return {
          status: 'failed',
          outline,
          structure,
          ...(change !== undefined ? { change } : {}),
          ...(presentationPlan !== undefined ? { presentationPlan } : {}),
          diagnostics: [...diagnostics, {
            code: 'render_failed',
            severity: 'error',
            scope: 'render',
            message: safeError(error)
          }]
        };
      }
    }
    return {
      status: 'ready',
      outline,
      structure,
      ...(change !== undefined ? { change } : {}),
      ...(presentationPlan !== undefined ? { presentationPlan } : {}),
      diagnostics,
      temporary: {
        fileName: temporary.fileName,
        sizeBytes: temporary.sizeBytes,
        rendered
      }
    };
  } catch (error) {
    if (temporary) await discardTemporaryDocument(temporary);
    return {
      status: 'failed',
      outline,
      structure,
      ...(change !== undefined ? { change } : {}),
      ...(presentationPlan !== undefined ? { presentationPlan } : {}),
      diagnostics: [...diagnostics, {
        code: 'render_failed',
        severity: 'error',
        scope: 'temporary_version',
        message: safeError(error)
      }]
    };
  }
}

export async function discardTemporaryDocument(
  temporary: Pick<GeneratedTemporaryDocumentFile, 'temporaryPath'>
): Promise<void> {
  try {
    await unlink(temporary.temporaryPath);
  } catch {
    // Best effort cleanup; the temporary path is never exposed in the result DTO.
  }
}

function collectDeterministicDiagnostics(
  outline: DocumentOutline,
  presentationPlan: PresentationPlan | undefined
): DocumentQualityDiagnostic[] {
  const diagnostics: DocumentQualityDiagnostic[] = [];
  if (outline.title.trim().length === 0 || outline.sections.length === 0) {
    diagnostics.push({
      code: 'empty_document',
      severity: 'error',
      scope: 'document',
      message: 'Document must contain a title and at least one section'
    });
  }
  outline.sections.forEach((section, sectionIndex) => {
    if (section.blocks.length === 0) {
      diagnostics.push({
        code: 'empty_section',
        severity: 'warning',
        scope: `sections[${sectionIndex}]`,
        message: 'Section has no content blocks'
      });
    }
    section.blocks.forEach((block, blockIndex) => {
      if (block.type === 'table' && block.header.length > 5) {
        diagnostics.push({
          code: 'table_too_wide',
          severity: 'error',
          scope: `sections[${sectionIndex}].blocks[${blockIndex}]`,
          message: 'Table exceeds the five-column layout limit'
        });
      }
    });
  });
  for (const page of presentationPlan?.pages ?? []) {
    if (!page.capacity.withinLimit) {
      diagnostics.push({
        code: 'capacity_exceeded',
        severity: 'error',
        scope: `pages[${page.pageNumber}]`,
        message: 'Page content exceeds the selected layout capacity'
      });
    }
  }
  return diagnostics;
}

function cancelled(
  outline: DocumentOutline,
  structure = readStructuredDocument(outline),
  change?: DocumentPatchChange,
  presentationPlan?: PresentationPlan,
  diagnostics: readonly DocumentQualityDiagnostic[] = []
): TemporaryDocumentWorkflowResult {
  return {
    status: 'cancelled',
    outline,
    structure,
    ...(change !== undefined ? { change } : {}),
    ...(presentationPlan !== undefined ? { presentationPlan } : {}),
    diagnostics
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
