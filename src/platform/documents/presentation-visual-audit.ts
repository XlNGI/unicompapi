import type { PresentationRenderPlan } from '../../domain/entities/presentation-render-plan';

/** Deterministic visual signals only. A multimodal model is intentionally not implied by this audit. */
export type PresentationVisualAuditCode =
  | 'visual_low_contrast'
  | 'visual_crowded_page'
  | 'visual_excessive_whitespace'
  | 'visual_style_inconsistent'
  | 'visual_hierarchy_flat';

export interface PresentationVisualAuditDiagnostic {
  readonly code: PresentationVisualAuditCode;
  readonly severity: 'warning';
  readonly pageNumber?: number;
  readonly message: string;
}

export interface PresentationVisualAudit {
  readonly status: 'passed' | 'warning';
  readonly multimodalReview: 'not_available';
  readonly diagnostics: readonly PresentationVisualAuditDiagnostic[];
}

/**
 * Audits the validated Render Plan before the writer runs. It catches bounded,
 * repeatable signals while leaving subjective visual review to a human or an
 * explicitly configured multimodal service.
 */
export function auditPresentationRenderPlan(plan: PresentationRenderPlan): PresentationVisualAudit {
  const diagnostics: PresentationVisualAuditDiagnostic[] = [];
  const fontFamilies = new Set<string>();
  for (const page of plan.pages) {
    const occupied = page.elements.reduce((sum, element) => sum + element.geometry.width * element.geometry.height, 0);
    const ratio = occupied / (plan.canvas.width * plan.canvas.height);
    if (ratio > 0.86) diagnostics.push({ code: 'visual_crowded_page', severity: 'warning', pageNumber: page.pageNumber,
      message: 'Element occupancy leaves little safe whitespace' });
    else if (ratio < 0.12 && page.elements.length > 1) diagnostics.push({ code: 'visual_excessive_whitespace', severity: 'warning', pageNumber: page.pageNumber,
      message: 'Element occupancy is unusually sparse for a multi-element page' });
    const textElements = page.elements.filter(element => element.type === 'text');
    const fontSizes = textElements.map(element => element.style.fontSize);
    if (fontSizes.length >= 3 && Math.max(...fontSizes) - Math.min(...fontSizes) < 4) {
      diagnostics.push({ code: 'visual_hierarchy_flat', severity: 'warning', pageNumber: page.pageNumber,
        message: 'Text sizes do not establish a clear hierarchy' });
    }
    for (const element of page.elements) {
      fontFamilies.add(element.style.fontFamily);
      if (element.type === 'text' && contrastRatio(element.style.fill ?? page.backgroundColor, element.style.color) < (element.style.fontSize >= 24 ? 3 : 4.5)) {
        diagnostics.push({ code: 'visual_low_contrast', severity: 'warning', pageNumber: page.pageNumber,
          message: 'Text color has insufficient deterministic contrast against the page background' });
      }
    }
  }
  if (fontFamilies.size > 2) diagnostics.push({ code: 'visual_style_inconsistent', severity: 'warning',
    message: 'The deck uses more than two font families' });
  return { status: diagnostics.length === 0 ? 'passed' : 'warning', multimodalReview: 'not_available', diagnostics };
}

function contrastRatio(background: string, foreground: string): number {
  const backgroundLuminance = luminance(background);
  const foregroundLuminance = luminance(foreground);
  const [low, high] = [backgroundLuminance, foregroundLuminance].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

function luminance(value: string): number {
  const channels = [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
