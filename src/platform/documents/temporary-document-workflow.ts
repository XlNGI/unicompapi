import type {
  DocumentOutline,
  DocumentWorkspaceKind,
  PresentationPlan,
  PresentationDesignIR,
  PresentationLayoutIR
} from '../../domain';
import { applyPresentationLayoutToOutline, buildPresentationDesignIR, buildPresentationLayoutIR } from '../../domain';
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
import {
  resolvePresentationTemplate,
  type PresentationTemplateId
} from './presentation-template';
import { unlink } from 'node:fs/promises';
import { buildDocumentContentSnapshot, type DocumentContentSnapshotV1 } from '../../domain/entities/document-content-snapshot';
import { adaptLegacyPresentationLayout, type LegacyPresentationLayoutAdaptation } from './presentation-layout-ir-adapter';
import type { ProductionPresentationLayoutIR } from '../../domain/entities/presentation-layout-ir';

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
    | 'overlap'
    | 'element_overflow';
  readonly severity: DocumentDiagnosticSeverity;
  readonly scope: string;
  readonly message: string;
}

export interface DocumentRenderResult {
  readonly previewCount: number;
  readonly warnings?: readonly string[];
  readonly diagnostics?: readonly {
    readonly code: 'font_missing' | 'empty_page' | 'invalid_image' | 'page_count_mismatch' | 'text_overflow' | 'overlap' | 'element_overflow';
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
  readonly canonicalContent?: DocumentContentSnapshotV1;
  /** Explicit old scene-box representation, not proof of the whole rendered artifact. */
  readonly legacySceneLayoutIR?: ProductionPresentationLayoutIR;
  readonly layoutCompatibility?: LegacyPresentationLayoutAdaptation;
  readonly status: 'ready' | 'rejected' | 'cancelled' | 'failed';
  readonly outline: DocumentOutline;
  readonly structure: DocumentStructureSnapshot;
  readonly change?: DocumentPatchChange;
  readonly presentationPlan?: PresentationPlan;
  readonly designIR?: PresentationDesignIR;
  readonly layoutIR?: PresentationLayoutIR;
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
  const result = await prepareLegacyTemporaryDocumentVersion(input);
  try {
  const canonicalContent = buildDocumentContentSnapshot({ outline: result.outline });
  const layoutCompatibility = result.layoutIR && result.presentationPlan ? adaptLegacyPresentationLayout({
    layout: result.layoutIR, plan: result.presentationPlan, content: canonicalContent,
    tokens: resolvePresentationTemplate(input.presentationTemplate ?? 'work_report').tokens
  }) : undefined;
  return { ...result, canonicalContent,
    ...(layoutCompatibility ? { layoutCompatibility } : {}),
    ...(layoutCompatibility?.status === 'adapted' ? { legacySceneLayoutIR: layoutCompatibility.layout } : {}) };
  } catch {
    if (result.status !== 'ready') return result;
    return { ...result, status: 'failed', diagnostics: [...result.diagnostics, { code: 'render_failed', severity: 'error',
      scope: 'content_layout_contract', message: 'Content/layout compatibility validation failed' }] };
  }
}

async function prepareLegacyTemporaryDocumentVersion(
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
  const basePresentationPlan = outline.kind === 'ppt'
    ? buildPresentationPlanFromOutline(outline, {
        templateId: input.presentationTemplate
      })
    : undefined;
  const baseLayoutIR = basePresentationPlan === undefined ? undefined : buildPresentationLayoutIR(basePresentationPlan);
  if (basePresentationPlan !== undefined && baseLayoutIR !== undefined) {
    outline = applyPresentationLayoutToOutline(outline, basePresentationPlan, baseLayoutIR);
  }
  const structure = readStructuredDocument(outline);
  const presentationPlan = outline.kind === 'ppt'
    ? buildPresentationPlanFromOutline(outline, { templateId: input.presentationTemplate })
    : undefined;
  const designIR = presentationPlan === undefined ? undefined : buildPresentationDesignIR(presentationPlan);
  const layoutIR = presentationPlan === undefined ? undefined : buildPresentationLayoutIR(presentationPlan, { autoAdjust: false });
  const diagnostics = [
    ...collectDeterministicDiagnostics(outline, presentationPlan),
    ...(layoutIR?.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      scope: `page:${diagnostic.pageNumber}:${diagnostic.elementIds.join(',')}`,
      message: diagnostic.message
    })) ?? [])
  ];
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return {
      status: 'rejected',
      outline,
      structure,
      ...(change !== undefined ? { change } : {}),
      ...(presentationPlan !== undefined ? { presentationPlan } : {}),
      ...(designIR !== undefined ? { designIR } : {}),
      ...(layoutIR !== undefined ? { layoutIR } : {}),
      diagnostics
    };
  }
  if (input.signal?.aborted) return cancelled(outline, structure, change, presentationPlan, diagnostics, designIR, layoutIR);
  if (!input.generateTemporaryFile && !input.render) {
    return {
      status: 'ready',
      outline,
      structure,
      ...(change !== undefined ? { change } : {}),
      ...(presentationPlan !== undefined ? { presentationPlan } : {}),
      ...(designIR !== undefined ? { designIR } : {}),
      ...(layoutIR !== undefined ? { layoutIR } : {}),
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
      return cancelled(outline, structure, change, presentationPlan, diagnostics, designIR, layoutIR);
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
            ...(designIR !== undefined ? { designIR } : {}),
            ...(layoutIR !== undefined ? { layoutIR } : {}),
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
          ...(designIR !== undefined ? { designIR } : {}),
          ...(layoutIR !== undefined ? { layoutIR } : {}),
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
      ...(designIR !== undefined ? { designIR } : {}),
      ...(layoutIR !== undefined ? { layoutIR } : {}),
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
      ...(designIR !== undefined ? { designIR } : {}),
      ...(layoutIR !== undefined ? { layoutIR } : {}),
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
  const presentationTemplate = presentationPlan === undefined
    ? undefined
    : resolvePresentationTemplate(presentationPlan.templateId);
  for (const page of presentationPlan?.pages ?? []) {
    if (!page.capacity.withinLimit && !isSafeContinuationOverflow(page, presentationTemplate)) {
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

/**
 * The outline plan is intentionally one page per source section, while the
 * PPT generator may split a section into continuation pages. A group-count
 * overflow is therefore safe when the selected layout supports continuation
 * and the section still fits its character budget. Character overflow remains
 * an error because it can indicate an unusually large indivisible payload and
 * should be surfaced before writing a file.
 */
function isSafeContinuationOverflow(
  page: PresentationPlan['pages'][number],
  template: ReturnType<typeof resolvePresentationTemplate> | undefined
): boolean {
  if (template === undefined) return false;
  const layout = template.layouts[page.layout];
  return layout.supportsContinuation &&
    page.capacity.contentGroups > page.capacity.maxContentGroups &&
    page.capacity.bodyCharacters <= page.capacity.maxBodyCharacters;
}

function cancelled(
  outline: DocumentOutline,
  structure = readStructuredDocument(outline),
  change?: DocumentPatchChange,
  presentationPlan?: PresentationPlan,
  diagnostics: readonly DocumentQualityDiagnostic[] = [],
  designIR?: PresentationDesignIR,
  layoutIR?: PresentationLayoutIR
): TemporaryDocumentWorkflowResult {
  return {
    status: 'cancelled',
    outline,
    structure,
    ...(change !== undefined ? { change } : {}),
    ...(presentationPlan !== undefined ? { presentationPlan } : {}),
    ...(designIR !== undefined ? { designIR } : {}),
    ...(layoutIR !== undefined ? { layoutIR } : {}),
    diagnostics
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
